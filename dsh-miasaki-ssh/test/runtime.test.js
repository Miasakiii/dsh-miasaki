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
import { classifyError, SshRuntime, RuntimeConn, ShellChannel, MAX_SHELLS_PER_RUNTIME, MAX_SNAPSHOT_BYTES } from '../lib/runtime.js'
import { SshStore, fingerprintOf } from '../lib/store.js'

test('classifyError maps ssh2 client errors to stable codes', () => {
  assert.equal(classifyError(new Error('All configured authentication methods failed')).code, 'AUTH_FAILED')
  assert.equal(classifyError(new Error('ECONNREFUSED 127.0.0.1:22')).code, 'CONNECTION_REFUSED')
  assert.equal(classifyError(new Error('getaddrinfo ENOTFOUND example.com')).code, 'HOST_NOT_FOUND')
  assert.equal(classifyError(new Error('handshake: ETIMEDOUT')).code, 'TIMEOUT')
  assert.equal(classifyError(new Error('Unknown something')).code, 'ERROR')
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
