// Runtime layer for @miasaki/dsh-ssh — U2.1 三层身份（design/2026-09-15-ssh-u2-plan.md §3/§4.1）
//
// connId（profile，持久，store.js）
//   └─ runtimeId（一次 SSH 连接实例 = 一个 ssh2 Client，rt-<uuid>，含 generation 语义）
//        ├─ shellId #1（ShellChannel：stream + 尺寸 + 独立回放环 + viewer 集合 + 写入所有权）
//        ├─ shellId #2 …（上限 MAX_SHELLS_PER_RUNTIME）
//        └─（U2.2 预留）sftp：惰性 SFTPWrapper，连接级共享
//
// 安全前置（工作区规划 §8）：运行实例 id 不作授权证明 —— 浏览器先经
// POST /ssh/api/attach 换取一次性短期附着票据，WS attach 帧消费之。
// 票据过期 / 重放 / runtime teardown 一律拒绝（TICKET_INVALID）。
//
// U0 契约保持：输入/尺寸按 ws 绑定路由（绝不按 connId 查表）；慢 viewer 背压淘汰；
// 秘密只存在于调用链；TOFU 指纹确认与 generation 绑定不变。
import { Client } from 'ssh2'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostKeyOf, fingerprintOf, splitHostPort } from './store.js'

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

// U2 决策 1（2026-09-15 拍板）：同 runtime shell 上限 8，超出拒绝并给可读提示。
export const MAX_SHELLS_PER_RUNTIME = 8
// 附着票据 TTL：只够建立 WS，不够复用（方案 §3.2）。
export const ATTACH_TICKET_TTL_MS = 30_000
// 每连接（runtime）回放总预算（方案 §4.1.4）：shell 间先到先得 + LRU 头裁剪。
export const DEFAULT_SCROLLBACK_BYTES_PER_RUNTIME = 1024 * 1024

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
  if (text.includes('enotfound')) {
    // 实机反馈（2026-09-26）：`getaddrinfo ENOTFOUND 8.138.243.30:25112` 出现在主机栏里
    // 连端口一起填、端口栏留默认 22 的时候。原始消息原样保留（排障要看它），前面补一句
    // 能直接照做的指引；记录本身由 connect() 就地修正，这里只服务「解析真失败」的域名。
    return { code: 'HOST_NOT_FOUND', message: `无法解析主机名（${message}）—— 请检查主机地址：只填域名或 IP，端口填在「端口」栏` }
  }
  if (text.includes('etimedout') || text.includes('timed out')) {
    // 实机反馈（2026-09-26 续）：`connect ETIMEDOUT <ip>:<port>` 是「包被丢掉」——多数是
    // 云安全组/防火墙没放行该端口，或那里根本没有服务在监听。原句保留 + 排查方向。
    return { code: 'TIMEOUT', message: `${message} —— 对端没有应答：先确认云安全组 / 防火墙是否放行了这个端口（以及服务是否在监听），再考虑网络质量` }
  }
  // 实机反馈（2026-09-26 续）：TCP 通了、但对端在本端发出 SSH banner 之前就断开
  // （实测 [host]:[port] 38ms 建连、69ms RST、零字节）。最常见的原因是「这个端口不是
  // sshd」或「安全组/端口映射没指向 sshd」。原句看不懂，补一句可照做的排查方向。
  if (text.includes('connection lost before handshake')) {
    return { code: 'HANDSHAKE_LOST', message: `${message} —— 对端在 SSH 握手前就断开：先确认这个端口是不是 SSH 服务（云安全组是否对本机放行、端口映射是否指向 sshd），再考虑网络抖动` }
  }
  if (text.includes('econnreset')) return { code: 'CONNECTION_RESET', message }
  if (text.includes('host key')) return { code: 'HOST_KEY', message }
  return { code: 'ERROR', message }
}

export class SshRuntime {
  constructor(store, {
    scrollbackBytes = 256 * 1024,
    scrollbackBytesPerRuntime = DEFAULT_SCROLLBACK_BYTES_PER_RUNTIME,
    agentSupported = true,
    now = Date.now,
  } = {}) {
    this.store = store
    this.scrollbackBytes = scrollbackBytes           // 每 shell 回放上限
    this.scrollbackBytesPerRuntime = scrollbackBytesPerRuntime // 每 runtime 总预算
    this.agentSupported = agentSupported
    this.now = now
    this.conns = new Map()      // runtimeId -> RuntimeConn
    this.byProfile = new Map()  // connId -> runtimeId（同主机仍限一运行连接）
    this.pending = new Map()    // fingerprint token -> PendingFingerprint
    this.tickets = new Map()    // attach ticket -> { connId, expiresAt, timer }
  }

  async init() {
    await this.store.ready
  }

  // ------------------------------------------------------------------ attach tickets（方案 §3.2）
  /** 签发一次性附着票据。TTL 短，消费即作废；teardown 全部作废。 */
  issueAttachTicket(connId, { ttlMs = ATTACH_TICKET_TTL_MS } = {}) {
    const ticket = randomUUID()
    const expiresAt = this.now() + ttlMs
    const timer = setTimeout(() => this.tickets.delete(ticket), ttlMs + 1000)
    this.tickets.set(ticket, { connId, expiresAt, timer })
    return { ticket, expiresAt }
  }

  /** 消费票据：一次性。过期/重放/未知 ⇒ null。 */
  consumeTicket(ticket) {
    if (typeof ticket !== 'string' || ticket.length === 0) return null
    const item = this.tickets.get(ticket)
    if (item === undefined) return null
    clearTimeout(item.timer)
    this.tickets.delete(ticket)
    if (this.now() > item.expiresAt) return null
    return item
  }

  /** runtime teardown 时作废其名下全部票据（与 expirePendingFor 同构）。 */
  expireTicketsFor(connId) {
    for (const [ticket, item] of [...this.tickets.entries()]) {
      if (item.connId !== connId) continue
      clearTimeout(item.timer)
      this.tickets.delete(ticket)
    }
  }

  // ------------------------------------------------------------------ state
  listState() {
    const out = []
    for (const rc of this.conns.values()) {
      out.push({
        id: rc.connId,           // profile id：REST 对外名字不变
        runtimeId: rc.id,
        state: rc.status,
        label: rc.label,
        shells: shellSummaries(rc),
      })
    }
    return out
  }

  isConnected(id) {
    const runtimeId = this.byProfile.get(id)
    return runtimeId !== undefined && this.conns.get(runtimeId)?.status === 'connected'
  }

  // ------------------------------------------------------------------ connect
  async connect(id, options = {}) {
    let record = await this.store.getConnection(id)
    if (record === null) return { error: 'NOT_FOUND' }

    // 主机栏里连端口一起填了（`8.138.243.30:25112`）：ssh2 会把它当主机名去解析
    // （getaddrinfo ENOTFOUND）。连接是这类历史记录唯一的出口，就地修正并回写一次，
    // 让用户点「重新连接」即可连上 —— 判定与拆分复用 store 的同一个纯函数（规则一处）。
    const typed = splitHostPort(record.host)
    let repaired = null
    if (typed.port !== null && typed.port !== record.port) {
      repaired = { from: record.host, host: typed.host, port: typed.port }
      record = await this.store.updateConnection(id, { host: typed.host, port: typed.port })
    }

    const existingRuntimeId = this.byProfile.get(id)
    if (existingRuntimeId !== undefined) {
      const existing = this.conns.get(existingRuntimeId)
      if (existing !== undefined) this.teardown(existing)
      // conns 以 runtimeId 键控：重连的替身是另一个键，旧实例必须显式移除
      this.conns.delete(existingRuntimeId)
    }

    const rc = new RuntimeConn(this, id, record)
    this.conns.set(rc.id, rc)
    this.byProfile.set(id, rc.id)

    // password/key material flows only from the caller (one-time), never stored
    const cfg = {
      host: record.host,
      port: record.port,
      username: record.username,
      readyTimeout: HANDSHAKE_BUDGET_MS,
    }
    // 只开 keyboard-interactive 的服务器（新装 Ubuntu / Debian、部分云镜像的默认
    // `PasswordAuthentication no` + `KbdInteractiveAuthentication yes`）需要客户端显式
    // 打开 tryKeyboard：ssh2 仅在 `tryKeyboard === true` 时把该方法列入 authsAllowed
    // （`ssh2/lib/client.js:843`）。不开的话，密码再对也只会收到
    // `All configured authentication methods failed`（实机反馈 2026-09-26）。
    // 回填的就是本次连接的密码（PAM 的单密码提示）；服务端若拿这个通道做二次验证，
    // 回填密码自然不通过 —— 与不说谎的失败一致，不额外猜测。
    let keyboardPassword = null
    if (record.auth.method === 'password') {
      if (typeof options.password !== 'string' || options.password.length === 0) {
        this.bail(rc, { code: 'CREDENTIAL_MISSING', message: '需要密码：尝试在新会话中为连接输入密码' })
        return { id, error: 'CREDENTIAL_MISSING' }
      }
      cfg.password = options.password
      cfg.tryKeyboard = true
      keyboardPassword = options.password
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
    if (keyboardPassword !== null) {
      // 密码提示有几个就回填几个（PAM 通常是单提示）。
      client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        finish(prompts.map(() => keyboardPassword))
      })
    }
    client.on('error', err => {
      if (rc.disposed) return
      this.expirePendingFor(rc) // a dead handshake must not keep a live confirm token
      const info = classifyError(err)
      rc.answer(info.code, info.message)
    })
    client.on('close', () => {
      // reached when session ends or connection drops
      this.expirePendingFor(rc)
      for (const sh of rc.shells.values()) sh.stream = null
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
    return { id, state: rc.status, ...(repaired === null ? {} : { repaired }) }
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
        connId: rc.connId,
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
    // the user was deciding — the answer must never touch the new instance.
    // conns 以 runtimeId 键控：重连后的新实例是新 runtimeId ⇒ 查不到旧 rc 即失效。
    if (rc === undefined || rc.disposed || this.conns.get(rc.id) !== rc) {
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
    void this.store.touchConnected(rc.connId).catch(() => {})
    // 连接就绪即开第一个 shell（默认 shell），其余由 viewer 显式 shell.open（方案 §4.1.3）
    this.openShell(rc, { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }, (err, shell) => {
      if (rc.disposed) return
      if (err) {
        rc.status = 'error'
        rc.answer('SHELL_FAILED', `无法打开 shell: ${err.message}`)
        return
      }
      // TOFU 首连的真实时序：viewer 在「等待指纹确认」阶段就已经 attach（U0 契约：
      // 待指纹主机的主动作是打开终端、只 attach），那时还没有任何 shell ⇒ 它收到的
      // ready 帧 shellId 为 null。连接就绪、主 shell 建好后必须**补绑**这些 viewer 并
      // 逐个告知，否则前端永远拿不到 shellId ⇒ 之后每一帧 input/resize 都被
      // currentShell 判为绑定失效（实机验收逮住：指纹确认后终端仍不可用）。
      const summaries = shellSummaries(rc)
      for (const ws of [...rc.sockets]) {
        const bound = typeof ws.shellId === 'string' && rc.shells.get(ws.shellId) !== undefined
        if (!bound) this.bindShell(ws, shell)
        try {
          ws.send(JSON.stringify({
            type: 'ready', state: 'connected', runtimeId: rc.id,
            shellId: ws.shellId, mode: ws.mode, shells: summaries,
          }))
        } catch { /* gone */ }
      }
    })
  }

  // ------------------------------------------------------------------ shell channels（方案 §4.1）
  /** 在 runtime 的 ssh2 Client 上新开一个 shell channel；回调 (err, ShellChannel)。 */
  openShell(rc, { cols, rows } = {}, cb) {
    if (rc.disposed || rc.status !== 'connected' || rc.client === null) {
      cb(new Error('连接未就绪'))
      return
    }
    if (rc.shells.size >= MAX_SHELLS_PER_RUNTIME) {
      const err = new Error(`每个连接最多 ${MAX_SHELLS_PER_RUNTIME} 个 shell`)
      err.code = 'SHELL_LIMIT'
      cb(err)
      return
    }
    const seq = rc.shellSeq + 1
    rc.client.shell(
      { term: 'xterm-256color', cols: clampDim(cols, 2, MAX_COLS, DEFAULT_COLS), rows: clampDim(rows, 2, MAX_ROWS, DEFAULT_ROWS) },
      (err, stream) => {
        if (rc.disposed) return
        if (err) { cb(err); return }
        const shell = new ShellChannel(rc, seq, {
          cols: clampDim(cols, 2, MAX_COLS, DEFAULT_COLS),
          rows: clampDim(rows, 2, MAX_ROWS, DEFAULT_ROWS),
          title: shellTitle(rc, seq),
        })
        rc.shellSeq = seq
        rc.shells.set(shell.id, shell)
        shell.stream = stream
        stream.on('data', chunk => this.pushTo(shell, chunk))
        stream.stderr.on('data', chunk => this.pushTo(shell, Buffer.from(`\x1b[91m${chunk.toString('utf8')}\x1b[0m`)))
        // shell 结束 ≠ 连接结束（探针 A P4 基线）：仅关闭该 channel，
        // 标签保留为「会话已结束」，用户可在同一 runtime 重开 shell（方案 §4.1.5）
        stream.on('close', () => {
          shell.stream = null
          if (shell.ended) return
          shell.ended = true
          shell.writeOwner = null
          shell.broadcast({ type: 'shell.closed', shellId: shell.id, reason: 'exit' })
        })
        cb(null, shell)
      },
    )
  }

  /** viewer 请求新 shell：建好即把请求者切过去（写权归请求者）。 */
  openShellForViewer(ws, { cols, rows } = {}) {
    const rc = this.currentViewer(ws)
    if (rc === null) return
    if (rc.status !== 'connected') {
      ws.send(JSON.stringify({ type: 'error', code: 'NOT_CONNECTED', message: '连接未就绪，不能新建 shell' }))
      return
    }
    this.openShell(rc, { cols, rows }, (err, shell) => {
      if (err) {
        ws.send(JSON.stringify({ type: 'error', code: err.code ?? 'SHELL_FAILED', message: err.message }))
        return
      }
      // 请求者从旧 shell 解绑（写权释放），绑到新 shell
      this.unbindShell(ws)
      this.bindShell(ws, shell)
      ws.send(JSON.stringify({ type: 'shell.opened', shellId: shell.id, title: shell.title, mode: ws.mode }))
      this.replayTo(ws, shell)
    })
  }

  /** 关闭一个 shell channel（viewer 请求，owner-only；远端 exit 走 stream close 分支）。 */
  closeShellByViewer(ws, shellId) {
    const shell = this.currentShell(ws)
    if (shell === null) return
    if (shellId !== ws.shellId) {
      ws.send(JSON.stringify({ type: 'error', code: 'STALE_SHELL', message: '该 shell 不属于当前查看器' }))
      return
    }
    if (shell.writeOwner !== ws) {
      ws.send(JSON.stringify({ type: 'error', code: 'NOT_WRITE_OWNER', message: '只有写入方可关闭该 shell' }))
      return
    }
    shell.ended = true
    shell.writeOwner = null
    try { shell.stream?.end() } catch { /* gone */ }
    shell.broadcast({ type: 'shell.closed', shellId: shell.id, reason: 'closed-by-viewer' })
  }

  // ------------------------------------------------------------------ scrollback（每 shell 独立环 + runtime 总预算，方案 §4.1.4）
  pushTo(shell, chunk) {
    const u8 = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk))
    shell.sbChunks.push(u8)
    shell.sbLen += u8.length
    while (shell.sbLen > this.scrollbackBytes && shell.sbChunks.length > 1) {
      const dropped = shell.sbChunks.shift()
      shell.sbLen -= dropped.length
    }
    this.trimRuntimeBudget(shell)
    if (shell.viewers.size > 0) {
      for (const ws of [...shell.viewers]) {
        try {
          // backpressure: a viewer that stopped draining gets cut loose
          // instead of buffering the PTY forever（plan §8 洪泛有界）——按 shell 判定
          if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
            this.unbindShell(ws)
            try { ws.close(1011, 'viewer-too-slow') } catch { /* gone */ }
            continue
          }
          ws.send(u8)
        } catch { this.unbindShell(ws) }
      }
    }
  }

  /** runtime 总预算超限时，从最久未查看的 shell 环头部裁剪（不拒绝新 shell）。 */
  trimRuntimeBudget(exclude) {
    let total = 0
    for (const sh of exclude.rc.shells.values()) total += sh.sbLen
    if (total <= this.scrollbackBytesPerRuntime) return
    // LRU：lastViewedAt 最小者先裁（可裁到零；回放变短但实时输出不丢），
    // 全部裁光仍超限时才裁 exclude 自己。
    for (const sh of [...exclude.rc.shells.values()].sort((a, b) => a.lastViewedAt - b.lastViewedAt)) {
      while (total > this.scrollbackBytesPerRuntime && sh.sbChunks.length > 0) {
        const dropped = sh.sbChunks.shift()
        sh.sbLen -= dropped.length
        total -= dropped.length
      }
      if (total <= this.scrollbackBytesPerRuntime) break
    }
  }

  // ------------------------------------------------------------------ viewer binding（v2：ws ↔ (runtime, shell) 双绑定）
  bindShell(ws, shell) {
    ws.shellId = shell.id
    ws.mode = 'read'
    shell.viewers.add(ws)
    shell.lastViewedAt = this.now()
    // 写入所有权（决策 2：单写多读 + 显式接管）：空位即得写权
    if (shell.writeOwner === null && !shell.ended) {
      shell.writeOwner = ws
      ws.mode = 'write'
    }
  }

  unbindShell(ws) {
    const rc = ws.sshRc
    if (rc !== undefined && rc !== null) {
      const shell = rc.shells.get(ws.shellId)
      if (shell !== undefined) {
        shell.viewers.delete(ws)
        if (shell.writeOwner === ws) {
          shell.writeOwner = null
          // 写权空出：告知同 shell 其余只读 viewer（可接管）
          shell.broadcast({ type: 'write.open', shellId: shell.id })
        }
      }
    }
    ws.shellId = null
    ws.mode = 'read'
  }

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

  /**
   * 绑定校验集中口（方案 §8 风险表）：viewer 必须仍附着、且其 shellId 绑定仍在。
   * 僵尸 viewer / 错 shellId 一律在此被拒 —— 输入/尺寸/关闭/接管四条路径都过它。
   */
  currentShell(ws) {
    const rc = this.currentViewer(ws)
    if (rc === null) return null
    const shell = rc.shells.get(ws.shellId)
    if (shell === undefined || shell.viewers.has(ws) !== true) {
      if (ws.sshStale !== true) {
        ws.sshStale = true
        try { ws.send(JSON.stringify({ type: 'error', code: 'STALE_SHELL', message: 'shell 已关闭或绑定失效，请重新打开该标签' })) } catch { /* gone */ }
      }
      return null
    }
    shell.lastViewedAt = this.now()
    return shell
  }

  attach(ws, msg) {
    const ticketItem = this.consumeTicket(msg.ticket)
    // shellSeq 由 index.js 从帧里透传（Number 或 undefined）
    if (ticketItem === null) {
      ws.send(JSON.stringify({ type: 'error', code: 'TICKET_INVALID', message: '附着票据无效、过期或已被使用；请刷新页面重试' }))
      try { ws.close() } catch { /* gone */ }
      return
    }
    const runtimeId = this.byProfile.get(ticketItem.connId)
    const rc = runtimeId !== undefined ? this.conns.get(runtimeId) : undefined
    if (rc === undefined) {
      ws.send(JSON.stringify({ type: 'error', code: 'NO_CONNECTION', message: '连接不存在或已关闭' }))
      try { ws.close() } catch { /* gone */ }
      return
    }
    // viewer binding: this socket may only drive the exact (runtime, shell) it attached to
    ws.sshRc = rc
    ws.sshStale = false
    if (!rc.sockets.has(ws)) rc.sockets.add(ws)

    let shell = null
    if (typeof msg.shellId === 'string' && msg.shellId.length > 0) shell = rc.shells.get(msg.shellId) ?? null
    // 刷新恢复路径：前端只有 shellSeq（workspace 快照），按 seq 解析
    if (shell === null && Number.isInteger(msg.shellSeq)) {
      for (const sh of rc.shells.values()) if (sh.seq === msg.shellSeq) { shell = sh; break }
    }
    if (shell === null) shell = rc.primaryShell()
    if (shell !== null) this.bindShell(ws, shell)

    ws.send(JSON.stringify({
      type: 'ready',
      runtimeId: rc.id,
      shellId: shell?.id ?? null,
      mode: ws.mode,
      state: rc.status,
      shells: shellSummaries(rc),
    }))
    // re-state current status so a fresh viewer never misses a waiting/error
    if (rc.status === 'waiting-fingerprint' && rc.fp) {
      ws.send(JSON.stringify({ type: 'status', state: 'waiting-fingerprint', token: rc.fp.token, fingerprint: rc.fp.fingerprint, host: rc.fp.host }))
    } else if (rc.status === 'error') {
      ws.send(JSON.stringify({ type: 'status', state: 'error', code: rc.lastErrorCode, message: rc.lastErrorMessage }))
    }
    // a live stream takes the viewer's initial size into the real PTY;
    // a replay of buffered output follows for both live and ended sessions
    if (shell !== null) {
      // 初始尺寸只在成为写入 owner 时才进 PTY：否则第二个 viewer 一 attach
      // 就会覆盖 owner 的尺寸（「最后一个 resize 获胜」的回潮，决策 2 禁止）。
      if (ws.mode === 'write' && shell.stream && (msg.cols !== undefined || msg.rows !== undefined)) {
        shell.cols = clampDim(msg.cols, 2, MAX_COLS, shell.cols)
        shell.rows = clampDim(msg.rows, 2, MAX_ROWS, shell.rows)
        try { shell.stream.setWindow(shell.rows, shell.cols, undefined, undefined) } catch { /* stream gone */ }
      }
      this.replayTo(ws, shell)
      // U2.4：附着即补发最近一次屏幕快照（精确恢复的 host 侧半边）
      if (shell.snapshotData !== null) {
        try { ws.send(JSON.stringify({ type: 'snapshot', shellId: shell.id, data: shell.snapshotData })) } catch { /* gone */ }
      }
    }
  }

  replayTo(ws, shell) {
    if (shell.sbChunks.length === 0) return
    try { ws.send(Buffer.concat(shell.sbChunks)) } catch { /* client gone */ }
  }

  // ------------------------------------------------------------------ viewer-bound input / resize / ownership
  // Input and size changes are routed through the ws's (runtime, shell) binding, never
  // by connId lookup — otherwise a zombie viewer from a replaced generation
  // would write into the new connection（plan §5.1 输入归属 / §8 多 shell 串写风险）。

  viewerInput(ws, shellId, data) {
    const shell = this.currentShell(ws)
    if (shell === null || typeof data !== 'string') return
    if (shellId !== ws.shellId) return // 绑定不符：忽略（currentShell 已对僵尸发过 STALE_SHELL）
    if (shell.writeOwner !== ws) {
      // 只读 viewer 的按键不进 PTY；一次性提示由 write.state 帧与 UI 常驻表达
      return
    }
    if (shell.stream) shell.stream.write(data)
  }

  viewerResize(ws, shellId, cols, rows) {
    const shell = this.currentShell(ws)
    if (shell === null) return
    if (shellId !== ws.shellId) return
    // 非 owner 的 resize 被拒绝 —— 不再「最后一个 resize 获胜」（决策 2 / 方案 §5.3）
    if (shell.writeOwner !== ws) return
    if (cols !== undefined) shell.cols = clampDim(cols, 2, MAX_COLS, shell.cols)
    if (rows !== undefined) shell.rows = clampDim(rows, 2, MAX_ROWS, shell.rows)
    if (shell.stream) {
      try { shell.stream.setWindow(shell.rows, shell.cols, undefined, undefined) } catch { /* stream gone */ }
    }
  }

  /** 显式接管写入权（决策 2）：原 owner 立即转只读并收到 write.revoked。 */
  takeoverShell(ws, shellId) {
    const shell = this.currentShell(ws)
    if (shell === null) return
    if (shellId !== ws.shellId) return
    if (shell.ended) {
      ws.send(JSON.stringify({ type: 'error', code: 'SHELL_ENDED', message: '该 shell 已结束，无法接管' }))
      return
    }
    const prev = shell.writeOwner
    if (prev === ws) return
    if (prev !== null) {
      prev.mode = 'read'
      try { prev.send(JSON.stringify({ type: 'write.revoked', shellId: shell.id })) } catch { /* gone */ }
    }
    shell.writeOwner = ws
    ws.mode = 'write'
    ws.send(JSON.stringify({ type: 'write.granted', shellId: shell.id }))
  }

  /** U2.4：viewer 上报屏幕快照（字符串，封顶 MAX_SNAPSHOT_BYTES，host 内存态不落盘）。 */
  storeSnapshot(ws, shellId, data) {
    const shell = this.currentShell(ws)
    if (shell === null || shellId !== ws.shellId) return
    if (typeof data !== 'string' || data.length === 0) return
    if (data.length > MAX_SNAPSHOT_BYTES) return
    shell.snapshotData = data
  }

  detach(ws) {
    const rc = ws.sshRc
    if (rc !== undefined && rc !== null) rc.sockets.delete(ws)
    this.unbindShell(ws)
    ws.sshRc = null
  }

  async disconnect(id) {
    const runtimeId = this.byProfile.get(id)
    const rc = runtimeId !== undefined ? this.conns.get(runtimeId) : undefined
    if (rc === undefined) return { ok: false }
    this.teardown(rc)
    this.conns.delete(rc.id)
    if (this.byProfile.get(id) === rc.id) this.byProfile.delete(id)
    return { ok: true }
  }

  // ------------------------------------------------------------------ teardown

  teardown(rc) {
    this.expirePendingFor(rc) // a discarded connection cannot keep a confirm window open
    this.expireTicketsFor(rc.connId)
    try { rc.client && rc.client.end() } catch { /* ignore */ }
    for (const sh of rc.shells.values()) {
      try { sh.stream && sh.stream.end() } catch { /* ignore */ }
    }
    rc.status = 'closed'
    rc.broadcast({ type: 'status', state: 'closed', code: 'DISCARDED' })
    rc.dispose()
    if (this.byProfile.get(rc.connId) === rc.id) this.byProfile.delete(rc.connId)
  }

  async shutdown() {
    for (const rc of [...this.conns.values()]) {
      try { rc.client && rc.client.end() } catch { /* ignore */ }
      rc.sockets.clear()
      rc.dispose()
    }
    this.conns.clear()
    this.byProfile.clear()
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      try { item.verify(false) } catch { /* ignore */ }
    }
    this.pending.clear()
    for (const item of this.tickets.values()) clearTimeout(item.timer)
    this.tickets.clear()
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
}

// U2.4 快照上限：单 shell 屏幕快照（serialize 串）的 host 侧内存封顶。
export const MAX_SNAPSHOT_BYTES = 128 * 1024

function shellTitle(rc, seq) {
  return seq === 1 ? rc.label : `${rc.label} #${seq}`
}

function shellSummaries(rc) {
  return [...rc.shells.values()].map(sh => ({
    shellId: sh.id,
    title: sh.title,
    state: sh.ended ? 'ended' : 'live',
    cols: sh.cols,
    rows: sh.rows,
  }))
}

// Exported for fault-injection tests (test/runtime.test.js): constructing a
// real RuntimeConn without going through ssh2 lets tests drive attach / push /
// viewer binding directly.
export class RuntimeConn {
  constructor(runtime, connId, record, { runtimeId = `rt-${randomUUID()}` } = {}) {
    this.runtime = runtime
    this.id = runtimeId       // runtimeId：内部实例标识（含 generation 语义）
    this.connId = connId      // profile id：对外名字（REST/路由不变）
    this.client = null
    this.status = 'connecting'
    this.sockets = new Set()  // 附着到本 runtime 的全部 viewer（含未绑 shell 的状态观察者）
    this.disposed = false
    this.connKey = null
    this.lastErrorCode = null
    this.lastErrorMessage = null

    // 三层身份：一个连接多个 shell，各自独立的 stream / 尺寸 / 回放环 / 写入权
    this.shells = new Map()   // shellId -> ShellChannel
    this.shellSeq = 0

    this.label = record.label
  }

  /** 第一个未结束的 shell；全部结束则回最后一个（供回放）。 */
  primaryShell() {
    for (const sh of this.shells.values()) if (!sh.ended) return sh
    return [...this.shells.values()].at(-1) ?? null
  }

  broadcast(json) {
    if (this.sockets.size === 0) return
    const payload = JSON.stringify(json)
    for (const ws of this.sockets) {
      try { ws.send(payload) } catch { this.sockets.delete(ws) }
    }
  }

  answer(code, message) {
    this.status = 'error'
    this.lastErrorCode = code
    this.lastErrorMessage = message
    this.broadcast({ type: 'status', state: 'error', code, message })
  }

  dispose() { this.disposed = true }
}

/** 一个 shell channel：独立 stream / 尺寸 / 回放环 / viewer 集合 / 写入所有权（方案 §4.1.1）。 */
export class ShellChannel {
  constructor(rc, seq, { cols, rows, title }) {
    this.rc = rc
    this.id = `sh-${seq}`     // runtime 内唯一（seq 单调递增）；跨 runtime 不冲突（绑定按 rc 归属）
    this.seq = seq
    this.stream = null
    this.cols = cols
    this.rows = rows
    this.title = title
    this.ended = false
    this.createdAt = Date.now()
    this.lastViewedAt = this.createdAt
    this.viewers = new Set()  // 附着到本 shell 的 viewer（ws）
    this.writeOwner = null    // 写入所有权：同一时刻至多一个 ws
    this.sbChunks = []
    this.sbLen = 0
    this.snapshotData = null  // U2.4：最近一次屏幕快照（serialize 串，内存态）
  }

  broadcast(json) {
    if (this.viewers.size === 0) return
    const payload = JSON.stringify(json)
    for (const ws of this.viewers) {
      try { ws.send(payload) } catch { this.viewers.delete(ws) }
    }
  }
}
