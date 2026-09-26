// Unit + fault-injection tests for the runtime layer (U2.1 contract).
//
// Part 1 (decision logic): error classification and the fingerprint TOFU flow
// via handleHostKey / confirmFingerprint on stand-in connections.
// Part 2 (U0/U2 fault injection): attach-ticket lifecycle (expiry/replay/
// teardown), three-layer identity, per-shell scrollback rings + runtime budget,
// write-ownership (single-writer + takeover), snapshot storage, stale-viewer
// binding — all without any real ssh2 Client or network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { classifyError, SshRuntime, RuntimeConn, ShellChannel, MAX_SHELLS_PER_RUNTIME, MAX_SNAPSHOT_BYTES, buildConnectConfig } from '../lib/runtime.js'
import { SshStore, fingerprintOf } from '../lib/store.js'

// ssh2 是 CommonJS 包：命名导入只对 lexer 认出的成员可用，Server 要走默认导入再解构。
const { Server: SshServer } = ssh2

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('classifyError maps ssh2 client errors to stable codes', () => {
  assert.equal(classifyError(new Error('All configured authentication methods failed')).code, 'AUTH_FAILED')
  assert.equal(classifyError(new Error('ECONNREFUSED 127.0.0.1:22')).code, 'CONNECTION_REFUSED')
  assert.equal(classifyError(new Error('getaddrinfo ENOTFOUND example.com')).code, 'HOST_NOT_FOUND')
  assert.equal(classifyError(new Error('handshake: ETIMEDOUT')).code, 'TIMEOUT')
  assert.equal(classifyError(new Error('Unknown something')).code, 'ERROR')
})

// 实机反馈（2026-09-26）：`getaddrinfo ENOTFOUND 8.138.243.30:25112` 是「主机栏里连端口
// 一起填」的产物。原始消息必须原样保留（排障要看它），前面补一句能照着做的指引。
test('classifyError: 解析失败带可照做的指引，且不吞掉原始消息', () => {
  const info = classifyError(new Error('getaddrinfo ENOTFOUND 8.138.243.30:25112'))
  assert.equal(info.code, 'HOST_NOT_FOUND')
  assert.match(info.message, /端口填在「端口」栏/)
  assert.match(info.message, /8\.138\.243\.30:25112/)
})

// 同一轮实机反馈的第二跳：地址修对后报 `Connection lost before handshake`（TCP 通了、
// 对端零字节 RST）—— 多半是「这个端口不是 sshd」。同样是原句保留 + 可照做的指引。
test('classifyError: 握手前断开给排查方向，ECONNRESET 单独成码', () => {
  const lost = classifyError(new Error('Connection lost before handshake'))
  assert.equal(lost.code, 'HANDSHAKE_LOST')
  assert.match(lost.message, /Connection lost before handshake/)
  assert.match(lost.message, /是不是 SSH 服务/)
  assert.equal(classifyError(new Error('read ECONNRESET')).code, 'CONNECTION_RESET')
})

// 第三跳：端口换成 2005 后报 `connect ETIMEDOUT 8.138.243.30:2005`（包被丢）。同一套
// 口径：原句保留 + 指向安全组/监听。
test('classifyError: 超时指向安全组与监听，原句保留', () => {
  const info = classifyError(new Error('connect ETIMEDOUT 8.138.243.30:2005'))
  assert.equal(info.code, 'TIMEOUT')
  assert.match(info.message, /connect ETIMEDOUT 8\.138\.243\.30:2005/)
  assert.match(info.message, /安全组/)
})

// 历史记录里主机栏带端口时，连接是唯一出口：就地拆分、回写、如实回报（不静默改数据）。
test('CONNECT: 主机栏带端口的历史记录在连接时拆分并回写，改动回报给页面', async () => {
  const { runtime, store, cleanup } = await freshRuntime()
  try {
    // 刻意绕过 normalizeConnection 直写存储 —— 模拟线上那条历史记录（拆分是本次才加的）
    store.connections.value.connections.push({
      id: 'legacy-1', label: 'NO.1', host: '127.0.0.1:1', port: 22, username: 'u',
      auth: { method: 'password' }, group: '未分组', favorite: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastConnectedAt: null,
    })
    await store.connections.save()

    const result = await runtime.connect('legacy-1', { password: 'x' })
    assert.deepEqual(result.repaired, { from: '127.0.0.1:1', host: '127.0.0.1', port: 1 })
    const stored = await store.getConnection('legacy-1')
    assert.equal(stored.host, '127.0.0.1', '磁盘上的记录必须一起修正，不能只改内存')
    assert.equal(stored.port, 1)
    assert.equal(runtime.conns.get(runtime.byProfile.get('legacy-1')).connKey, '127.0.0.1:1', '指纹键用修正后的 host:port')
    await runtime.disconnect('legacy-1')
  } finally { await cleanup() }
})

test('CONNECT: 干净记录不产生 repaired，也不多写一次盘', async () => {
  const { runtime, store, cleanup } = await freshRuntime()
  try {
    const created = await store.createConnection({ label: 'ok', host: '127.0.0.1', port: 1, username: 'u', auth: { method: 'password' } })
    const before = (await store.getConnection(created.id)).updatedAt
    const result = await runtime.connect(created.id, { password: 'x' })
    assert.equal(result.repaired, undefined)
    assert.equal((await store.getConnection(created.id)).updatedAt, before, '没改动就不该写盘')
    await runtime.disconnect(created.id)
  } finally { await cleanup() }
})

// ---- 真实 ssh2 服务端：只提供 keyboard-interactive 的机器 ---------------------------
// 新装 Ubuntu/Debian 与部分云镜像的 sshd 是 `PasswordAuthentication no` +
// `KbdInteractiveAuthentication yes`。ssh2 客户端**只在 tryKeyboard 为真时**才尝试该方法
// （`ssh2/lib/client.js:843`），缺它就会出现「密码正确、却报 All configured authentication
// methods failed」（实机反馈 2026-09-26）。这里用真协议端点把这条链路钉住：TOFU 指纹确认 →
// keyboard-interactive 回填密码 → connected。
test('AUTH: 服务端只开 keyboard-interactive 时，同一密码经该通道登录成功（真协议）', async () => {
  const { runtime, store, cleanup } = await freshRuntime()
  const hostKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey
  const offered = []
  const serverClients = new Set()
  const server = new SshServer({ hostKeys: [hostKey] }, client => {
    serverClients.add(client)
    client.on('close', () => serverClients.delete(client))
    client.on('authentication', ctx => {
      offered.push(ctx.method)
      if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive'])
      ctx.prompt([{ prompt: 'Password: ', echo: false }], answers => {
        if (answers[0] === 'secret') ctx.accept()
        else ctx.reject()
      })
    })
    // runtime 在 ready 之后会自动开首个 shell（onReady）——端点必须应答 pty/shell，
    // 否则测到的是「认证过了但开不了 shell」，分不清两件事。
    client.on('session', accept => {
      const session = accept()
      session.on('pty', acceptPty => acceptPty?.())
      session.on('window-change', acceptChange => acceptChange?.())
      session.on('shell', acceptShell => {
        const stream = acceptShell()
        stream.on('data', () => {})
        stream.on('close', () => stream.end())
      })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  let connId = null
  try {
    const conn = await store.createConnection({ label: 'kbd', host: '127.0.0.1', port, username: 'u', auth: { method: 'password' } })
    connId = conn.id
    await runtime.connect(conn.id, { password: 'secret' })
    const rc = runtime.conns.get(runtime.byProfile.get(conn.id))

    for (let i = 0; i < 250 && rc.status !== 'waiting-fingerprint' && rc.status !== 'connected' && rc.status !== 'error'; i++) await sleep(20)
    // 首见主机键：走真实 TOFU 确认（证明这条路径也在链路里，而不是被绕过）
    if (rc.status === 'waiting-fingerprint') await runtime.confirmFingerprint(rc.fp.token, true)
    for (let i = 0; i < 250 && rc.status !== 'connected' && rc.status !== 'error'; i++) await sleep(20)

    assert.equal(rc.status, 'connected', `期望 connected，实际 ${rc.status}：${rc.lastErrorMessage ?? ''}`)
    assert.ok(offered.includes('keyboard-interactive'), '服务端应收到 keyboard-interactive 认证请求')
    assert.equal(offered.at(-1), 'keyboard-interactive', '服务端只给这一个方法 ⇒ 最终必须落到它上面（password 先试被拒是正常的）')
  } finally {
    if (connId !== null) await runtime.disconnect(connId).catch(() => {})
    for (const client of serverClients) { try { client.end() } catch { /* already gone */ } }
    server.close()
    await cleanup()
  }
})

function makeConn(connKey) {
  // Minimal stand-in for the RuntimeConn contract the decision logic touches.
  return {
    id: 'rt-standin',
    connId: 'conn-1',
    connKey,
    label: 'example',
    status: 'connecting',
    disposed: false,
    fp: null,
    sockets: new Set(),
    lastErrorCode: null,
    lastErrorMessage: null,
    broadcast() {},
    answer(code, message) { this.status = 'error'; this.lastErrorCode = code; this.lastErrorMessage = message },
    dispose() { this.disposed = true },
  }
}

let clock = 1_000_000
function freshRuntime({ scrollbackBytes = 1024, perRuntime = 4096 } = {}) {
  const dirPromise = mkdtemp(join(tmpdir(), 'ssh-runtime-'))
  // The store is async-ready; tests that need fingerprints await runtime.init().
  return dirPromise.then(async dir => {
    const store = new SshStore(`${dir}/data`)
    await store.ready
    const runtime = new SshRuntime(store, {
      scrollbackBytes,
      scrollbackBytesPerRuntime: perRuntime,
      now: () => clock,
    })
    return { runtime, store, cleanup: () => rm(dir, { recursive: true, force: true }) }
  })
}

// ---------------------------------------------------------------------------
// TOFU（U0 契约不变，但 generation 绑定迁移到 runtimeId 键控）
test('TOFU: first-seen key → waiting-fingerprint, accept → verify → recorded', async () => {
  const { runtime, store, cleanup } = await freshRuntime()
  try {
    const conn = makeConn('example.com:22')
    runtime.conns.set(conn.id, conn)
    let waiting = null
    conn.broadcast = json => { if (json.state === 'waiting-fingerprint') waiting = { token: json.token, fingerprint: json.fingerprint } }
    let verified = null
    await runtime.handleHostKey(conn, Buffer.from('host-key-A'), ok => { verified = ok })
    assert.equal(conn.status, 'waiting-fingerprint')
    assert.ok(waiting?.token)
    assert.equal(verified, null) // not resolved yet

    const result = await runtime.confirmFingerprint(waiting.token, true)
    assert.equal(result.ok, true)
    assert.equal(verified, true)
    const known = await store.getFingerprint('example.com:22')
    assert.equal(known.fingerprint, fingerprintOf(Buffer.from('host-key-A')))
  } finally {
    await cleanup()
  }
})

test('TOFU: recorded matching key is accepted automatically', async () => {
  const { runtime, store, cleanup } = await freshRuntime()
  try {
    const key = Buffer.from('host-key-A')
    await store.recordFingerprint('box:22', fingerprintOf(key))
    const conn = makeConn('box:22')
    let verified = null
    await runtime.handleHostKey(conn, key, ok => { verified = ok })
    assert.equal(verified, true)
    assert.equal(conn.status, 'connecting')
  } finally {
    await cleanup()
  }
})

test('TOFU: host key change is refused and never silently updated', async () => {
  const { runtime, store, cleanup } = await freshRuntime()
  try {
    await store.recordFingerprint('box:22', fingerprintOf(Buffer.from('old-key')))
    const conn = makeConn('box:22')
    let verified = null
    await runtime.handleHostKey(conn, Buffer.from('new-key'), ok => { verified = ok })
    assert.equal(verified, false)
    assert.equal(conn.status, 'error')
    assert.equal(conn.lastErrorCode, 'HOST_KEY_MISMATCH')
    const known = await store.getFingerprint('box:22')
    assert.equal(known.fingerprint, fingerprintOf(Buffer.from('old-key')))
  } finally {
    await cleanup()
  }
})

test('FAULT: fingerprint save failure refuses the connection instead of swallowing', async () => {
  const { runtime, store, cleanup } = await freshRuntime()
  try {
    store.recordFingerprint = async () => { throw new Error('EACCES: dead disk') }
    const conn = makeConn('box:22')
    runtime.conns.set(conn.id, conn)
    let waiting = null
    conn.broadcast = json => { if (json.state === 'waiting-fingerprint') waiting = json }
    let verified = null
    await runtime.handleHostKey(conn, Buffer.from('key-A'), ok => { verified = ok })

    const result = await runtime.confirmFingerprint(waiting.token, true)
    assert.equal(result.ok, false)
    assert.equal(verified, false) // 没落盘的信任不能当作已确认
    assert.equal(conn.status, 'error')
    assert.equal(conn.lastErrorCode, 'FINGERPRINT_SAVE_FAILED')
    assert.equal(await store.getFingerprint('box:22'), null)
    assert.equal(runtime.pending.size, 0)
  } finally {
    await cleanup()
  }
})

test('FAULT: a stale confirm cannot touch the new generation (runtimeId-keyed)', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const oldConn = makeConn('box:22')
    runtime.conns.set(oldConn.id, oldConn)
    let waiting = null
    oldConn.broadcast = json => { if (json.state === 'waiting-fingerprint') waiting = json }
    let oldVerified = null
    await runtime.handleHostKey(oldConn, Buffer.from('key-A'), ok => { oldVerified = ok })

    // the same connId is re-initiated while the user was still deciding:
    // the new instance lives under a NEW runtimeId, the old one is gone
    runtime.conns.delete(oldConn.id)
    const newConn = makeConn('box:22')
    newConn.status = 'connecting'
    runtime.conns.set(newConn.id, newConn)
    runtime.byProfile.set('conn-1', newConn.id)

    const result = await runtime.confirmFingerprint(waiting.token, true)
    assert.equal(result.ok, false)
    assert.equal(oldVerified, false, 'stale verify must be refused')
    assert.equal(newConn.status, 'connecting', 'the new generation must stay untouched')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// U2 fault injection — runtime is driven with real RuntimeConn/ShellChannel
// objects but a fake ssh2 stream, exactly like the U0 gate did.

function fakeStream() {
  return {
    writes: [],
    windows: [],
    write(data) { this.writes.push(data) },
    setWindow(rows, cols) { this.windows.push([rows, cols]) },
    on() { /* event stub */ },
    end() { /* event stub */ },
    stderr: { on() { /* event stub */ } },
  }
}

function fakeWs() {
  return {
    sentFrames: [],
    sentBinary: [],
    bufferedAmount: 0,
    closedWith: null,
    sshRc: null,
    sshStale: false,
    shellId: null,
    mode: 'read',
    send(data) {
      if (typeof data === 'string') this.sentFrames.push(JSON.parse(data))
      else this.sentBinary.push(data)
    },
    close(code, reason) { this.closedWith = { code, reason } },
  }
}

/** Real RuntimeConn + one live ShellChannel with a fake stream. */
function liveRuntime(runtime) {
  const rc = new RuntimeConn(runtime, 'conn-1', { host: 'box', label: 'example' }, { runtimeId: 'rt-1' })
  rc.status = 'connected'
  runtime.conns.set(rc.id, rc)
  runtime.byProfile.set('conn-1', rc.id)
  const shell = new ShellChannel(rc, 1, { cols: 120, rows: 32, title: 'example' })
  shell.stream = fakeStream()
  rc.shells.set(shell.id, shell)
  rc.shellSeq = 1
  return { rc, shell }
}

/** Attach a fake viewer through the real ticket path. */
function attachViewer(runtime, rc, shell, { cols, rows, shellSeq } = {}) {
  const ws = fakeWs()
  const { ticket } = runtime.issueAttachTicket(rc.connId)
  runtime.attach(ws, { ticket, shellId: shell.id, cols, rows, shellSeq })
  return ws
}

// ---- attach ticket lifecycle（方案 §3.2）----
test('TICKET: valid ticket attaches and is consumed exactly once', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const ws = attachViewer(runtime, rc, shell)
    assert.equal(ws.sshRc, rc)
    assert.equal(ws.shellId, shell.id)
    assert.equal(ws.mode, 'write', 'first viewer of a live shell becomes the write owner')
    const ready = ws.sentFrames.find(f => f.type === 'ready')
    assert.equal(ready.runtimeId, rc.id)
    assert.equal(ready.shellId, shell.id)
    assert.ok(Array.isArray(ready.shells) && ready.shells.length === 1)

    // replay the same ticket: consumed ⇒ refused
    const ws2 = fakeWs()
    runtime.attach(ws2, { ticket: ws.ticketReplay ?? 'missing', shellId: shell.id })
    assert.equal(ws2.sentFrames[0].code, 'TICKET_INVALID')
    assert.ok(ws2.closedWith !== null, 'ticket rejection closes the socket')
  } finally {
    await cleanup()
  }
})

test('TICKET: expired ticket is refused (injectable clock)', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const ws = fakeWs()
    const { ticket } = runtime.issueAttachTicket(rc.connId)
    clock += 31_000 // TTL 30s 已过
    runtime.attach(ws, { ticket, shellId: shell.id })
    assert.equal(ws.sentFrames[0].code, 'TICKET_INVALID')
  } finally {
    await cleanup()
  }
})

// 实机验收逮住的回归：TOFU 首连时 viewer 在「等待指纹」阶段就 attach（U0 契约：待指纹
// 主机的主动作是打开终端），那时没有 shell 可绑 ⇒ ready 帧 shellId=null。连接就绪后若
// 不补绑，该 viewer 之后每一帧 input/resize 都被 currentShell 判为绑定失效（STALE_SHELL），
// 而该错误会覆盖「核对指纹」横幅 ⇒ 首连彻底不可用。
test('TOFU: a viewer attached during waiting-fingerprint is bound when the first shell opens', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const rc = new RuntimeConn(runtime, 'conn-1', { host: 'box', label: 'example' }, { runtimeId: 'rt-tofu' })
    rc.status = 'waiting-fingerprint'
    runtime.conns.set(rc.id, rc)
    runtime.byProfile.set('conn-1', rc.id)

    const ws = fakeWs()
    const { ticket } = runtime.issueAttachTicket('conn-1')
    runtime.attach(ws, { ticket, cols: 100, rows: 30 })
    const firstReady = ws.sentFrames.find(f => f.type === 'ready')
    assert.equal(firstReady.shellId, null, '等待指纹时确实没有 shell 可绑')
    assert.equal(ws.shellId, null)

    // 指纹确认通过 → 连接就绪 → onReady 开主 shell
    rc.client = { shell(_options, cb) { cb(null, fakeStream()) } }
    runtime.onReady(rc)

    const ready = ws.sentFrames.filter(f => f.type === 'ready').at(-1)
    assert.equal(ready.state, 'connected')
    assert.equal(typeof ready.shellId, 'string', '就绪后必须补绑并把 shellId 告知 viewer')
    assert.equal(ws.shellId, ready.shellId)
    assert.equal(ws.mode, 'write', '补绑的 viewer 拿到写权（单写多读的空位即得）')
    assert.equal(rc.shells.size, 1)

    // 绑定已生效：此后 input/resize 不再被判绑定失效
    ws.sentFrames.length = 0
    runtime.viewerInput(ws, ws.shellId, 'ls\n')
    runtime.viewerResize(ws, ws.shellId, 120, 40)
    assert.equal(ws.sentFrames.some(f => f.code === 'STALE_SHELL'), false, '补绑后不得再报 STALE_SHELL')
    assert.deepEqual(rc.shells.get(ws.shellId).stream.writes, ['ls\n'])
  } finally {
    await cleanup()
  }
})

test('TICKET: teardown of the runtime voids its outstanding tickets', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const ws = fakeWs()
    const { ticket } = runtime.issueAttachTicket(rc.connId)
    runtime.teardown(rc)
    runtime.attach(ws, { ticket, shellId: shell.id })
    assert.equal(ws.sentFrames[0].code, 'TICKET_INVALID')
  } finally {
    await cleanup()
  }
})

// ---- 三层身份 / 每 shell 隔离 ----
test('SHELLS: two channels keep independent rings, sizes and streams', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const shell2 = new ShellChannel(rc, 2, { cols: 80, rows: 24, title: 'example #2' })
    shell2.stream = fakeStream()
    rc.shells.set(shell2.id, shell2)
    rc.shellSeq = 2

    const a = attachViewer(runtime, rc, shell)
    const b = attachViewer(runtime, rc, shell2)
    assert.equal(a.mode, 'write')
    assert.equal(b.mode, 'write', 'each shell has its own single writer')

    runtime.pushTo(shell, Buffer.from('AAA'))
    runtime.pushTo(shell2, Buffer.from('BBB'))
    assert.equal(Buffer.from(a.sentBinary.at(-1)).toString(), 'AAA')
    assert.equal(Buffer.from(b.sentBinary.at(-1)).toString(), 'BBB')
    assert.deepEqual(shell.sbChunks.map(c => Buffer.from(c).toString()), ['AAA'])
    assert.deepEqual(shell2.sbChunks.map(c => Buffer.from(c).toString()), ['BBB'])

    // input goes to the bound shell only
    runtime.viewerInput(a, shell.id, 'ping1')
    runtime.viewerInput(b, shell2.id, 'ping2')
    assert.deepEqual(shell.stream.writes, ['ping1'])
    assert.deepEqual(shell2.stream.writes, ['ping2'])

    // cross-shell id on the frame is ignored (binding wins)
    runtime.viewerInput(a, shell2.id, 'evil')
    assert.deepEqual(shell2.stream.writes, ['ping2'])
  } finally {
    await cleanup()
  }
})

test('SHELLS: one shell ending does not dispose the runtime (probe A P4 contract)', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const shell2 = new ShellChannel(rc, 2, { cols: 80, rows: 24, title: 'example #2' })
    shell2.stream = fakeStream()
    rc.shells.set(shell2.id, shell2)
    rc.shellSeq = 2

    const a = attachViewer(runtime, rc, shell)
    // 模拟远端 exit：stream close 的语义（closeShellByViewer 之外的路径）
    shell.ended = true
    shell.writeOwner = null
    shell.broadcast({ type: 'shell.closed', shellId: shell.id, reason: 'exit' })
    assert.equal(rc.disposed, false)
    assert.equal(rc.status, 'connected')
    assert.equal(shell2.ended, false)
    assert.ok(a.sentFrames.some(f => f.type === 'shell.closed' && f.shellId === shell.id))
  } finally {
    await cleanup()
  }
})

test('SHELLS: per-shell ring cap and runtime budget (LRU head trim)', async () => {
  const { runtime, cleanup } = await freshRuntime({ scrollbackBytes: 100, perRuntime: 150 })
  try {
    const { rc, shell } = liveRuntime(runtime)
    const shell2 = new ShellChannel(rc, 2, { cols: 80, rows: 24, title: 'example #2' })
    shell2.stream = fakeStream()
    rc.shells.set(shell2.id, shell2)
    rc.shellSeq = 2

    const a = attachViewer(runtime, rc, shell)
    const b = attachViewer(runtime, rc, shell2)
    // 各 80B：每 shell 上限 100 都不裁；总预算 150 ⇒ 最久未查看者被裁
    runtime.pushTo(shell, Buffer.alloc(80, 65))
    clock += 10
    runtime.pushTo(shell2, Buffer.alloc(80, 66))
    // shell（10s 未查看）比 shell2 旧 ⇒ 从 shell 头部裁
    assert.ok(shell.sbLen < 80, 'older shell was trimmed to satisfy the runtime budget')
    assert.equal(shell2.sbLen, 80)
    // a 的回放仍在（被裁后剩余部分），b 完整
    assert.ok(a.sentBinary.length >= 1)
    void b
  } finally {
    await cleanup()
  }
})

// ---- 写入所有权（决策 2）----
test('OWNERSHIP: second viewer is read-only; takeover revokes the first', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const owner = attachViewer(runtime, rc, shell)
    const reader = attachViewer(runtime, rc, shell)
    assert.equal(owner.mode, 'write')
    assert.equal(reader.mode, 'read')

    runtime.viewerInput(reader, shell.id, 'should-not-pass')
    assert.deepEqual(shell.stream.writes, [], 'read-only viewer input is dropped')

    runtime.viewerResize(reader, shell.id, 200, 50)
    assert.deepEqual(shell.stream.windows, [], 'read-only resize is refused (no last-write-wins)')

    // 显式接管
    runtime.takeoverShell(reader, shell.id)
    assert.equal(reader.mode, 'write')
    assert.equal(owner.mode, 'read')
    assert.ok(owner.sentFrames.some(f => f.type === 'write.revoked'))
    assert.ok(reader.sentFrames.some(f => f.type === 'write.granted'))

    // 原 owner 现在写不进去，新 owner 可以
    runtime.viewerInput(owner, shell.id, 'old')
    runtime.viewerInput(reader, shell.id, 'new')
    assert.deepEqual(shell.stream.writes, ['new'])
  } finally {
    await cleanup()
  }
})

test('OWNERSHIP: detach frees the write lock and notifies remaining viewers', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const owner = attachViewer(runtime, rc, shell)
    const reader = attachViewer(runtime, rc, shell)
    runtime.detach(owner)
    assert.equal(shell.writeOwner, null)
    assert.ok(reader.sentFrames.some(f => f.type === 'write.open'), 'remaining viewer learns the seat is free')
    // reader 可接管
    runtime.takeoverShell(reader, shell.id)
    assert.equal(reader.mode, 'write')
  } finally {
    await cleanup()
  }
})

test('OWNERSHIP: initial attach resize only applies to the write owner', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const owner = attachViewer(runtime, rc, shell, { cols: 111, rows: 22 })
    assert.deepEqual(shell.stream.windows, [[22, 111]], 'owner resize applies')
    const reader = attachViewer(runtime, rc, shell, { cols: 999, rows: 499 })
    assert.equal(shell.stream.windows.length, 1, 'reader attach must NOT resize the PTY')
    assert.equal(shell.cols, 111)
    void reader
  } finally {
    await cleanup()
  }
})

// ---- 僵尸 viewer / 绑定失效 ----
test('STALE: a viewer bound to a replaced generation is refused and closed', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const ws = attachViewer(runtime, rc, shell)
    // 重连：同 connId 新 runtimeId
    runtime.conns.delete(rc.id)
    const rc2 = new RuntimeConn(runtime, 'conn-1', { host: 'box', label: 'example' }, { runtimeId: 'rt-2' })
    rc2.status = 'connected'
    runtime.conns.set(rc2.id, rc2)
    runtime.byProfile.set('conn-1', rc2.id)

    runtime.viewerInput(ws, shell.id, 'ghost')
    assert.equal(ws.sshStale, true)
    assert.ok(ws.sentFrames.some(f => f.code === 'STALE_VIEWER'))
    assert.ok(ws.closedWith !== null)
    assert.deepEqual(rc2.shells.size, 0, 'the new generation was never touched')
  } finally {
    await cleanup()
  }
})

test('STALE: wrong shellId on the frame is ignored (binding wins)', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const shell2 = new ShellChannel(rc, 2, { cols: 80, rows: 24, title: 'example #2' })
    shell2.stream = fakeStream()
    rc.shells.set(shell2.id, shell2)
    rc.shellSeq = 2
    const owner = attachViewer(runtime, rc, shell)
    runtime.viewerInput(owner, shell2.id, 'evil')
    assert.deepEqual(shell2.stream.writes, [])
    assert.deepEqual(shell.stream.writes, [])
  } finally {
    await cleanup()
  }
})

// ---- U2.4 快照 ----
test('SNAPSHOT: viewer-reported snapshots are stored per shell, capped, never persisted', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const ws = attachViewer(runtime, rc, shell)
    runtime.storeSnapshot(ws, shell.id, 'SNAP-1')
    assert.equal(shell.snapshotData, 'SNAP-1')
    runtime.storeSnapshot(ws, shell.id, 'SNAP-2')
    assert.equal(shell.snapshotData, 'SNAP-2')

    // 超限拒收
    runtime.storeSnapshot(ws, shell.id, 'x'.repeat(MAX_SNAPSHOT_BYTES + 1))
    assert.equal(shell.snapshotData, 'SNAP-2')

    // 新 viewer attach 时收到快照帧（精确恢复的 host 侧半边）
    const late = attachViewer(runtime, rc, shell)
    const snapFrame = late.sentFrames.find(f => f.type === 'snapshot')
    assert.equal(snapFrame?.data, 'SNAP-2')
  } finally {
    await cleanup()
  }
})

// ---- shell.open / shell.close viewer 路径 ----
test('SHELL OPEN/CLOSE: open requires a connected runtime; close is owner-only', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const owner = attachViewer(runtime, rc, shell)
    const reader = attachViewer(runtime, rc, shell)

    // openShellForViewer 用真实 client.shell —— 未接 ssh2 ⇒ client 为 null，回调收到错误帧
    runtime.openShellForViewer(owner, { cols: 80, rows: 24 })
    assert.ok(owner.sentFrames.some(f => f.type === 'error'), 'no real client: the viewer gets an error frame, not a crash')

    // close：非 owner 被拒
    runtime.closeShellByViewer(reader, shell.id)
    assert.equal(shell.ended, false)
    assert.ok(reader.sentFrames.some(f => f.code === 'NOT_WRITE_OWNER'))

    // close：owner 成功
    runtime.closeShellByViewer(owner, shell.id)
    assert.equal(shell.ended, true)
    assert.ok(reader.sentFrames.some(f => f.type === 'shell.closed' && f.reason === 'closed-by-viewer'))
  } finally {
    await cleanup()
  }
})

// ---- shell 上限（决策 1）----
test('SHELL LIMIT: the 9th channel is refused with a coded error', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc } = liveRuntime(runtime)
    for (let i = 2; i <= MAX_SHELLS_PER_RUNTIME; i += 1) {
      const sh = new ShellChannel(rc, i, { cols: 80, rows: 24, title: `example #${i}` })
      sh.stream = fakeStream()
      rc.shells.set(sh.id, sh)
      rc.shellSeq = i
    }
    assert.equal(rc.shells.size, MAX_SHELLS_PER_RUNTIME)
    rc.client = {} // 走到上限分支前只判可用性；若实现错误地调了 client.shell 会在此抛错
    let captured = null
    runtime.openShell(rc, { cols: 80, rows: 24 }, err => { captured = err })
    assert.ok(captured instanceof Error)
    assert.equal(captured.code, 'SHELL_LIMIT')
  } finally {
    await cleanup()
  }
})

// ---- 状态清单对外仍是 connId ----
test('listState keeps the connId surface and exposes shells', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const { rc, shell } = liveRuntime(runtime)
    const rows = runtime.listState()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'conn-1')
    assert.equal(rows[0].runtimeId, rc.id)
    assert.equal(rows[0].shells.length, 1)
    assert.equal(rows[0].shells[0].shellId, shell.id)
    assert.equal(runtime.isConnected('conn-1'), true)
  } finally {
    await cleanup()
  }
})

// ---- 背压（U0 契约在 shell 维度继续成立）----
test('BACKPRESSURE: a viewer that stops draining is dropped instead of buffering forever', async () => {
  const { runtime, cleanup } = await freshRuntime({ scrollbackBytes: 1024, perRuntime: 8192 })
  try {
    const { rc, shell } = liveRuntime(runtime)
    const slow = attachViewer(runtime, rc, shell)
    slow.bufferedAmount = 8 * 1024 * 1024 + 1
    const healthy = attachViewer(runtime, rc, shell)
    runtime.pushTo(shell, Buffer.from('tick'))
    assert.ok(slow.closedWith !== null, 'slow viewer was closed with 1011 semantics')
    assert.equal(shell.viewers.has(slow), false)
    assert.equal(Buffer.from(healthy.sentBinary.at(-1)).toString(), 'tick', 'other viewers unaffected')
  } finally {
    await cleanup()
  }
})

// ---- P0-1：连接健壮性三件套（对标 zcode 2026-09-26-ssh-zcode-benchmark-plan.md §4-P0-1）----
const baseRecord = (auth) => ({
  id: 'c1', label: 'box', host: 'example.com', port: 22, username: 'u', auth,
})

test('P0-1 buildConnectConfig：keepalive 与握手超时恒定在位', () => {
  const built = buildConnectConfig(baseRecord({ method: 'password' }), { password: 'pw' })
  assert.equal(built.error, undefined)
  assert.equal(built.cfg.readyTimeout, 60_000, '握手预算与指纹确认窗口同一口径')
  assert.equal(built.cfg.keepaliveInterval, 15_000, 'NAT/防火墙静默断开时不能挂在 connected')
  assert.equal(built.cfg.keepaliveCountMax, 3)
})

test('P0-1 buildConnectConfig：agent 只认显式选择，绝不隐式带 SSH_AUTH_SOCK', () => {
  // 密码场景：即使环境里有 agentSock 也不带上 —— 否则公钥阶段先耗尽 MaxAuthTries，
  // 密码永远进不了认证（zcode sshAuth.ts 同款口径）。
  const withSock = buildConnectConfig(baseRecord({ method: 'password' }), { password: 'pw' }, { agentSock: '/tmp/ssh-agent.sock' })
  assert.equal(withSock.cfg.agent, undefined)
  assert.equal(withSock.cfg.tryKeyboard, true)
  assert.equal(withSock.keyboardPassword, 'pw')
  // 隐式 agent 也不该出现在私钥场景
  const keyed = buildConnectConfig(baseRecord({ method: 'key', keyPath: '/k' }), { privateKey: Buffer.from('KEY') }, { agentSock: '/tmp/ssh-agent.sock' })
  assert.equal(keyed.cfg.agent, undefined)
  // 显式选择 agent：可用则透传，不可用即错
  const explicit = buildConnectConfig(baseRecord({ method: 'agent' }), {}, { agentSupported: true, agentSock: '/tmp/a.sock' })
  assert.equal(explicit.cfg.agent, '/tmp/a.sock')
  const missing = buildConnectConfig(baseRecord({ method: 'agent' }), {}, { agentSupported: true, agentSock: undefined })
  assert.equal(missing.error.code, 'AGENT_UNAVAILABLE')
  const unsupported = buildConnectConfig(baseRecord({ method: 'agent' }), {}, { agentSupported: false, agentSock: '/tmp/a.sock' })
  assert.equal(unsupported.error.code, 'AGENT_UNAVAILABLE')
})

test('P0-1 buildConnectConfig：缺密码 / 私钥内容缺失 / 未知认证方式各自成错', () => {
  assert.equal(buildConnectConfig(baseRecord({ method: 'password' }), {}).error.code, 'CREDENTIAL_MISSING')
  assert.equal(buildConnectConfig(baseRecord({ method: 'key', keyPath: '/k' }), {}).error.code, 'KEY_READ_FAILED')
  assert.equal(buildConnectConfig(baseRecord({ method: 'carrier-pigeon' }), {}).error.code, 'AUTH_UNSUPPORTED')
})

test('P0-1 classifyError：ssh2 level 分级优先于文案', () => {
  // level 是协议层事实：不同服务端/格式下同一语义的文案并不稳定。
  const auth = classifyError(Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }))
  assert.equal(auth.code, 'AUTH_FAILED')
  assert.match(auth.message, /请检查用户名、密码或私钥/)
  const timeout = classifyError(Object.assign(new Error('Handshake timeout'), { level: 'client-timeout' }))
  assert.equal(timeout.code, 'TIMEOUT')
  assert.match(timeout.message, /60 秒/)
})

test('P0-1 classifyError：加密私钥的口令问题与认证失败分开成码', () => {
  const missing = classifyError(new Error('Encrypted private key detected, but no passphrase given'))
  assert.equal(missing.code, 'KEY_PASSPHRASE_MISSING')
  assert.match(missing.message, /提供私钥口令/)
  for (const text of ['bad passphrase', 'key integrity check failed', 'unable to authenticate data']) {
    assert.equal(classifyError(new Error(text)).code, 'KEY_PASSPHRASE_INVALID', text)
  }
})
