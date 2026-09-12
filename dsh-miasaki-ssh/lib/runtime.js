// Runtime layer for @miasaki/dsh-ssh.
//
// Owns one ssh2 Client per managed connection, verifies host keys with
// fingerprint TOFU (first-seen => ask user, mismatch => refuse), keeps a
// bounded binary-safe scrollback ring per connection, and relays terminal
// output to every attached browser WebSocket. No HTTP knowledge here: the
// WebServer layer builds frames and hands them to these methods.
import { Client } from 'ssh2'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostKeyOf, fingerprintOf } from './store.js'

// One time budget shared by the ssh2 handshake (readyTimeout) and the
// fingerprint confirm window: while hostVerifier is pending the handshake
// clock keeps ticking, so the two windows MUST be the same or a user who
// confirms at t=30s would confirm a connection that died at t=15s (plan §5.3).
const HANDSHAKE_BUDGET_MS = 60_000
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
const MAX_COLS = 1000
const MAX_ROWS = 500
const MAX_WS_BUFFERED_BYTES = 8 * 1024 * 1024 // drop a viewer whose send buffer exceeds this
const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

function clampDim(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Classify an ssh2/client error into a stable, machine-routable code. */
export function classifyError(error) {
  const message = String(error?.message ?? error ?? '')
  const text = message.toLowerCase()
  if (text.includes('all configured authentication methods failed') || text.includes('authentication failed')) {
    return { code: 'AUTH_FAILED', message }
  }
  if (text.includes('no supported auth')) return { code: 'AUTH_UNSUPPORTED', message }
  if (text.includes('econnrefused')) return { code: 'CONNECTION_REFUSED', message }
  if (text.includes('ehostunreach')) return { code: 'HOST_UNREACHABLE', message }
  if (text.includes('enotfound')) return { code: 'HOST_NOT_FOUND', message }
  if (text.includes('etimedout') || text.includes('timed out')) return { code: 'TIMEOUT', message }
  if (text.includes('host key')) return { code: 'HOST_KEY', message }
  return { code: 'ERROR', message }
}

export class SshRuntime {
  constructor(store, { scrollbackBytes = 256 * 1024, agentSupported = true } = {}) {
    this.store = store
    this.scrollbackBytes = scrollbackBytes
    this.agentSupported = agentSupported
    this.conns = new Map() // connId -> RuntimeConn
    this.pending = new Map() // fingerprint token -> PendingFingerprint
  }

  async init() {
    await this.store.ready
  }

  listState() {
    const out = []
    for (const rc of this.conns.values()) out.push({ id: rc.id, state: rc.status, label: rc.label })
    return out
  }

  isConnected(id) {
    return this.conns.get(id)?.status === 'connected'
  }

  // ------------------------------------------------------------------ connect
  async connect(id, options = {}) {
    const record = await this.store.getConnection(id)
    if (record === null) return { error: 'NOT_FOUND' }

    const existing = this.conns.get(id)
    if (existing !== undefined) this.teardown(existing)

    const rc = new RuntimeConn(this, id, record)
    this.conns.set(id, rc)

    // password/key material flows only from the caller (one-time), never stored
    const cfg = {
      host: record.host,
      port: record.port,
      username: record.username,
      readyTimeout: HANDSHAKE_BUDGET_MS,
    }
    if (record.auth.method === 'password') {
      if (typeof options.password !== 'string' || options.password.length === 0) {
        this.bail(rc, { code: 'CREDENTIAL_MISSING', message: '需要密码：尝试在新会话中为连接输入密码' })
        return { id, error: 'CREDENTIAL_MISSING' }
      }
      cfg.password = options.password
    } else if (record.auth.method === 'key') {
      try {
        cfg.privateKey = await readFile(record.auth.keyPath)
        if (typeof options.passphrase === 'string' && options.passphrase.length > 0) cfg.passphrase = options.passphrase
      } catch (error) {
        this.bail(rc, { code: 'KEY_READ_FAILED', message: `私钥读取失败：${error.message}` })
        return { id, error: 'KEY_READ_FAILED' }
      }
    } else if (record.auth.method === 'agent') {
      const sockvar = process.platform === 'win32' ? WINDOWS_AGENT_PIPE : process.env.SSH_AUTH_SOCK
      if (!this.agentSupported || !sockvar) {
        this.bail(rc, { code: 'AGENT_UNAVAILABLE', message: '当前环境检测不到 SSH agent（SSH_AUTH_SOCK）' })
        return { id, error: 'AGENT_UNAVAILABLE' }
      }
      cfg.agent = sockvar
    } else {
      this.bail(rc, { code: 'AUTH_UNSUPPORTED', message: `不支持的认证方式: ${record.auth.method}` })
      return { id, error: 'AUTH_UNSUPPORTED' }
    }

    rc.connKey = hostKeyOf(record.host, record.port)

    // ssh2 calls hostVerifier(key, verify); we handle it fully asynchronously.
    cfg.hostVerifier = (key, verify) => {
      void this.handleHostKey(rc, key, verify).catch(error => {
        rc.answer('HOSTKEY_INTERNAL', String(error?.message ?? error))
        verify(false)
      })
    }

    const client = new Client()
    rc.client = client
    client.on('ready', () => this.onReady(rc))
    client.on('error', err => {
      if (rc.disposed) return
      this.expirePendingFor(rc) // a dead handshake must not keep a live confirm token
      const info = classifyError(err)
      rc.answer(info.code, info.message)
    })
    client.on('close', () => {
      // reached when session ends or connection drops
      this.expirePendingFor(rc)
      if (rc.stream) rc.stream = null
      if (rc.disposed) return
      if (rc.status === 'connected' || rc.status === 'connecting' || rc.status === 'waiting-fingerprint') {
        rc.status = 'closed'
        rc.broadcast({ type: 'status', state: 'closed' })
      }
    })
    try {
      client.connect(cfg)
    } catch (error) {
      this.bail(rc, classifyError(error))
    }
    return { id, state: rc.status }
  }

  async handleHostKey(rc, key, verify) {
    const fingerprint = fingerprintOf(key)
    const known = await this.store.getFingerprint(rc.connKey)
    if (known === null) {
      // first-seen host key: hold the connection and ask the user
      const token = randomUUID()
      rc.status = 'waiting-fingerprint'
      rc.fp = { token, fingerprint, host: rc.label }
      const item = {
        token,
        rc, // generation binding: a confirm may only affect THIS RuntimeConn
        connId: rc.id,
        connKey: rc.connKey,
        fingerprint,
        verify,
        timer: setTimeout(() => {
          if (this.pending.get(token) !== item) return
          this.expirePendingFor(rc)
          if (this.conns.get(rc.id) === rc && rc.status === 'waiting-fingerprint') {
            rc.status = 'error'
            rc.broadcast({ type: 'status', state: 'error', code: 'FINGERPRINT_TIMEOUT', message: '指纹确认超时，已断开' })
          }
        }, HANDSHAKE_BUDGET_MS),
      }
      this.pending.set(token, item)
      rc.broadcast({ type: 'status', state: 'waiting-fingerprint', token, fingerprint, host: rc.label })
    } else if (known.fingerprint === fingerprint) {
      rc.status = 'connecting'
      verify(true)
    } else {
      // 主机指纹变化：拒绝连接，绝对不静默更新
      rc.status = 'error'
      rc.answer('HOST_KEY_MISMATCH', `主机指纹与已记录的(sha256:${known.fingerprint})不一致，已拒绝连接；如需信任新指纹请先在连接管理中重置该主机`)
      verify(false)
    }
  }

  /** Resolve every pending fingerprint belonging to rc: timer gone, verify(false). */
  expirePendingFor(rc) {
    for (const item of [...this.pending.values()]) {
      if (item.rc !== rc) continue
      this.pending.delete(item.token)
      clearTimeout(item.timer)
      rc.fp = null
      try { item.verify(false) } catch { /* verify must not throw, but never let it break cleanup */ }
    }
  }

  async confirmFingerprint(token, accept) {
    const item = this.pending.get(token)
    if (item === undefined) return { ok: false, error: '确认请求已过期或不存在' }
    clearTimeout(item.timer)
    this.pending.delete(token)
    const rc = item.rc
    // stale generation: the connection was re-initiated (or torn down) while
    // the user was deciding — the answer must never touch the new instance
    if (rc === undefined || rc.disposed || this.conns.get(item.connId) !== rc) {
      try { item.verify(false) } catch { /* ignore */ }
      return { ok: false, error: '该连接已重新发起，本次确认已失效' }
    }
    if (accept) {
      try {
        await this.store.recordFingerprint(item.connKey, item.fingerprint)
      } catch (error) {
        // 保存失败绝不静默放行：没有落盘的信任不能当作已确认（plan §8）
        try { item.verify(false) } catch { /* ignore */ }
        rc.answer('FINGERPRINT_SAVE_FAILED', `信任记录保存失败：${error?.message ?? error}；本次连接未继续`)
        return { ok: false, error: '信任记录保存失败' }
      }
      item.verify(true)
      if (rc.status === 'waiting-fingerprint') rc.status = 'connecting'
      return { ok: true }
    }
    item.verify(false)
    if (rc.status === 'waiting-fingerprint') {
      rc.answer('FINGERPRINT_REJECTED', '已拒绝该主机指纹，连接取消')
    }
    return { ok: true }
  }

  onReady(rc) {
    if (rc.disposed) return
    rc.status = 'connected'
    void this.store.touchConnected(rc.id).catch(() => {})
    rc.broadcast({ type: 'status', state: 'connected' })
    rc.client.shell(
      { term: 'xterm-256color', cols: rc.cols, rows: rc.rows },
      (err, stream) => {
        if (rc.disposed) return
        if (err) {
          rc.status = 'error'
          rc.answer('SHELL_FAILED', `无法打开 shell: ${err.message}`)
          return
        }
        rc.stream = stream
        stream.on('data', chunk => rc.push(chunk))
        stream.stderr.on('data', chunk => rc.push(Buffer.from(`\x1b[91m${chunk.toString('utf8')}\x1b[0m`)))
        stream.on('close', () => {
          rc.stream = null
          if (!rc.disposed) {
            rc.status = 'closed'
            rc.broadcast({ type: 'status', state: 'closed' })
            rc.dispose()
          }
        })
        // any early attached sockets immediately get scrollback
        rc.broadcast({ type: 'ready', state: 'connected', cols: rc.cols, rows: rc.rows })
        rc.flush()
      },
    )
  }

  // ------------------------------------------------------------------ frames

  attach(ws, msg) {
    const rc = this.conns.get(msg.connId)
    if (rc === undefined) {
      ws.send(JSON.stringify({ type: 'error', code: 'NO_CONNECTION', message: '连接不存在或已关闭' }))
      return
    }
    // viewer binding: this socket may only drive the exact RuntimeConn it
    // attached to — a replaced generation ignores its stale input/resize
    ws.sshRc = rc
    ws.sshStale = false
    if (!rc.sockets.has(ws)) rc.sockets.add(ws)
    if (msg.cols !== undefined) rc.cols = clampDim(msg.cols, 2, MAX_COLS, rc.cols)
    if (msg.rows !== undefined) rc.rows = clampDim(msg.rows, 2, MAX_ROWS, rc.rows)
    ws.send(JSON.stringify({ type: 'ready', state: rc.status, cols: rc.cols, rows: rc.rows }))
    // re-state current status so a fresh viewer never misses a waiting/error
    if (rc.status === 'waiting-fingerprint' && rc.fp) {
      ws.send(JSON.stringify({ type: 'status', state: 'waiting-fingerprint', token: rc.fp.token, fingerprint: rc.fp.fingerprint, host: rc.fp.host }))
    } else if (rc.status === 'error') {
      ws.send(JSON.stringify({ type: 'status', state: 'error', code: rc.lastErrorCode, message: rc.lastErrorMessage }))
    }
    // a live stream takes the viewer's initial size into the real PTY;
    // a replay of buffered output follows for both live and ended sessions
    if (rc.stream && (msg.cols !== undefined || msg.rows !== undefined)) {
      try { rc.stream.setWindow(rc.rows, rc.cols, undefined, undefined) } catch { /* stream gone */ }
    }
    if (rc.stream) rc.flushTo(ws)
    else if (rc.sbChunks.length > 0) rc.flushTo(ws)
  }

  // ------------------------------------------------------------------ viewer-bound input / resize
  // Input and size changes are routed through the ws's viewer binding, never
  // by connId lookup — otherwise a zombie viewer from a replaced generation
  // would write into the new connection (plan §5.1 输入归属).

  /** The RuntimeConn this viewer may still drive, or null (after notifying a stale one). */
  currentViewer(ws) {
    const rc = ws?.sshRc
    if (rc === undefined || rc === null) return null
    if (rc.disposed || this.conns.get(rc.id) !== rc) {
      if (ws.sshStale !== true) {
        ws.sshStale = true
        try { ws.send(JSON.stringify({ type: 'error', code: 'STALE_VIEWER', message: '该连接已重新发起，请返回连接管理重新打开终端' })) } catch { /* gone */ }
        try { ws.close() } catch { /* gone */ }
      }
      return null
    }
    return rc
  }

  viewerInput(ws, data) {
    const rc = this.currentViewer(ws)
    if (rc !== null && typeof data === 'string' && rc.stream) rc.stream.write(data)
  }

  viewerResize(ws, cols, rows) {
    const rc = this.currentViewer(ws)
    if (rc === null) return
    if (cols !== undefined) rc.cols = clampDim(cols, 2, MAX_COLS, rc.cols)
    if (rows !== undefined) rc.rows = clampDim(rows, 2, MAX_ROWS, rc.rows)
    if (rc.stream) {
      try { rc.stream.setWindow(rc.rows, rc.cols, undefined, undefined) } catch { /* stream gone */ }
    }
  }

  detach(ws) {
    ws.sshRc = null
    for (const rc of this.conns.values()) rc.sockets.delete(ws)
  }

  async disconnect(id) {
    const rc = this.conns.get(id)
    if (rc === undefined) return { ok: false }
    this.teardown(rc)
    this.conns.delete(id)
    return { ok: true }
  }

  // ------------------------------------------------------------------ teardown

  teardown(rc) {
    this.expirePendingFor(rc) // a discarded connection cannot keep a confirm window open
    try { rc.client && rc.client.end() } catch { /* ignore */ }
    try { rc.stream && rc.stream.end() } catch { /* ignore */ }
    rc.status = 'closed'
    rc.broadcast({ type: 'status', state: 'closed', code: 'DISCARDED' })
    rc.dispose()
  }

  async shutdown() {
    for (const rc of [...this.conns.values()]) {
      try { rc.client && rc.client.end() } catch { /* ignore */ }
      rc.sockets.clear()
      rc.dispose()
    }
    this.conns.clear()
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      try { item.verify(false) } catch { /* ignore */ }
    }
    this.pending.clear()
  }

  // Accepts either a raw Error (classified here) or an already-classified
  // { code, message } object passed through unchanged.
  bail(rc, error) {
    const info = error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string'
      ? { code: error.code, message: error.message }
      : classifyError(error)
    rc.answer(info.code, info.message)
    rc.dispose()
  }

  currentStatus() {
    const out = []
    for (const rc of this.conns.values()) out.push({ id: rc.id, state: rc.status })
    return out
  }
}

// Exported for fault-injection tests (test/runtime.test.js): constructing a
// real RuntimeConn without going through ssh2 lets tests drive attach / push /
// viewer binding directly.
export class RuntimeConn {
  constructor(runtime, id, record) {
    this.runtime = runtime
    this.id = id
    this.client = null
    this.stream = null
    this.cols = DEFAULT_COLS
    this.rows = DEFAULT_ROWS
    this.status = 'connecting'
    this.sockets = new Set()
    this.disposed = false
    this.connKey = null
    this.fpToken = null
    this.fpHash = null
    this.lastErrorCode = null
    this.lastErrorMessage = null

    // scrollback ring (binary-safe)
    this.sbChunks = []
    this.sbLen = 0

    this.host = record.host
    this.label = record.label
  }

  push(chunk) {
    const u8 = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk))
    // ring with a head slot that is only trimmed when at least two chunks exist
    this.sbChunks.push(u8)
    this.sbLen += u8.length
    while (this.sbLen > this.runtime.scrollbackBytes && this.sbChunks.length > 1) {
      const dropped = this.sbChunks.shift()
      this.sbLen -= dropped.length
    }
    if (this.sockets.size > 0) {
      const payload = u8
      for (const ws of [...this.sockets]) {
        try {
          // backpressure: a viewer that stopped draining gets cut loose
          // instead of buffering the PTY forever (plan §8 洪泛有界)
          if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
            this.sockets.delete(ws)
            try { ws.close(1011, 'viewer-too-slow') } catch { /* gone */ }
            continue
          }
          ws.send(payload)
        } catch { this.sockets.delete(ws) }
      }
    }
  }

  broadcast(json) {
    if (this.sockets.size === 0) return
    const payload = JSON.stringify(json)
    for (const ws of this.sockets) {
      try { ws.send(payload) } catch { this.sockets.delete(ws) }
    }
  }

  flush() {
    if (this.sockets.size === 0) return
    const payload = Buffer.concat(this.sbChunks)
    for (const ws of this.sockets) {
      try { ws.send(payload) } catch { this.sockets.delete(ws) }
    }
  }

  flushTo(ws) {
    if (this.sbChunks.length === 0) return
    try { ws.send(Buffer.concat(this.sbChunks)) } catch { /* client gone */ }
  }

  answer(code, message) {
    this.status = 'error'
    this.lastErrorCode = code
    this.lastErrorMessage = message
    this.broadcast({ type: 'status', state: 'error', code, message })
  }

  dispose() { this.disposed = true }
}