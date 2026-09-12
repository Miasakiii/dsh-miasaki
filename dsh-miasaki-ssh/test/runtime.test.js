// Unit + fault-injection tests for the runtime layer.
//
// Part 1 (decision logic): error classification and the fingerprint TOFU flow
// via handleHostKey / confirmFingerprint on stand-in connections.
// Part 2 (U0 fault injection, plan §9 gate): generation binding of pending
// fingerprints, save-failure handling, attach/viewer binding, resize bounds,
// backpressure and the ready-frame contract — all without any real ssh2
// Client or network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyError, SshRuntime, RuntimeConn } from '../lib/runtime.js'
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
    id: 'conn-1',
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

async function freshRuntime() {
  const dir = await mkdtemp(join(tmpdir(), 'ssh-runtime-'))
  const store = new SshStore(`${dir}/data`)
  await store.ready
  const runtime = new SshRuntime(store, { scrollbackBytes: 1024 })
  return { runtime, store, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

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

test('TOFU: reject does not record the host', async () => {
  const { runtime, store, cleanup } = await freshRuntime()
  try {
    const conn = makeConn('box:22')
    runtime.conns.set(conn.id, conn)
    let waiting = null
    conn.broadcast = json => { if (json.state === 'waiting-fingerprint') waiting = json }
    let verified = null
    await runtime.handleHostKey(conn, Buffer.from('key-X'), ok => { verified = ok })
    const result = await runtime.confirmFingerprint(waiting.token, false)
    assert.equal(result.ok, true)
    assert.equal(verified, false)
    assert.equal(await store.getFingerprint('box:22'), null)
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// U0 fault injection

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
    send(data) {
      if (typeof data === 'string') this.sentFrames.push(JSON.parse(data))
      else this.sentBinary.push(data)
    },
    close(code, reason) { this.closedWith = { code, reason } },
  }
}

function liveConn(runtime, id = 'conn-1') {
  const rc = new RuntimeConn(runtime, id, { host: 'box', label: 'example' })
  rc.status = 'connected'
  rc.stream = fakeStream()
  runtime.conns.set(id, rc)
  return rc
}

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

test('FAULT: a stale confirm cannot touch the new generation', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const oldConn = makeConn('box:22')
    runtime.conns.set(oldConn.id, oldConn)
    let waiting = null
    oldConn.broadcast = json => { if (json.state === 'waiting-fingerprint') waiting = json }
    let oldVerified = null
    await runtime.handleHostKey(oldConn, Buffer.from('key-A'), ok => { oldVerified = ok })

    // the same connId is re-initiated while the user was still deciding
    const newConn = makeConn('box:22')
    newConn.status = 'connecting'
    runtime.conns.set(newConn.id, newConn)

    const result = await runtime.confirmFingerprint(waiting.token, true)
    assert.equal(result.ok, false)
    assert.match(result.error, /已重新发起/)
    assert.equal(oldVerified, false)
    assert.equal(newConn.status, 'connecting') // untouched
    assert.equal(newConn.lastErrorCode, null)
  } finally {
    await cleanup()
  }
})

test('FAULT: teardown resolves pending fingerprints and clears the token', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const conn = makeConn('box:22')
    runtime.conns.set(conn.id, conn)
    let waiting = null
    conn.broadcast = json => { if (json.state === 'waiting-fingerprint') waiting = json }
    let verified = null
    await runtime.handleHostKey(conn, Buffer.from('key-A'), ok => { verified = ok })
    assert.ok(runtime.pending.has(waiting.token))

    runtime.teardown(conn)
    assert.equal(runtime.pending.size, 0)
    assert.equal(verified, false)
    assert.equal(conn.status, 'closed')
  } finally {
    await cleanup()
  }
})

test('FAULT: shutdown resolves every pending fingerprint', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const conn = makeConn('box:22')
    runtime.conns.set(conn.id, conn)
    let waiting = null
    conn.broadcast = json => { if (json.state === 'waiting-fingerprint') waiting = json }
    let verified = null
    await runtime.handleHostKey(conn, Buffer.from('key-A'), ok => { verified = ok })

    await runtime.shutdown()
    assert.equal(runtime.pending.size, 0)
    assert.equal(verified, false)
  } finally {
    await cleanup()
  }
})

test('attach binds the viewer and pushes the initial size into the live PTY', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const rc = liveConn(runtime)
    const ws = fakeWs()
    runtime.attach(ws, { connId: 'conn-1', cols: 120, rows: 40 })
    assert.equal(ws.sshRc, rc)
    assert.deepEqual(rc.stream.windows, [[40, 120]])
    const ready = ws.sentFrames.find(f => f.type === 'ready')
    assert.equal(ready.state, 'connected')
    assert.equal(ready.cols, 120)
    assert.equal(ready.rows, 40)
  } finally {
    await cleanup()
  }
})

test('FAULT: viewer resize is clamped to sane bounds', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const rc = liveConn(runtime)
    const ws = fakeWs()
    runtime.attach(ws, { connId: 'conn-1' })
    runtime.viewerResize(ws, -5, 99999)
    assert.deepEqual(rc.stream.windows.at(-1), [500, 2]) // [rows, cols]
  } finally {
    await cleanup()
  }
})

test('FAULT: a stale viewer cannot write into the replaced generation', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const staleRc = liveConn(runtime)
    const staleWs = fakeWs()
    runtime.attach(staleWs, { connId: 'conn-1', cols: 100, rows: 30 })

    // same connId, new generation (what a re-connect produces)
    const newRc = liveConn(runtime)
    runtime.attach(fakeWs(), { connId: 'conn-1' })

    runtime.viewerInput(staleWs, 'rm -rf /')
    assert.equal(newRc.stream.writes.length, 0)
    assert.equal(staleWs.sentFrames.some(f => f.code === 'STALE_VIEWER'), true)
    assert.equal(staleRc.stream.writes.length, 0)

    // the current viewer still writes through its own binding
    const liveWs = fakeWs()
    runtime.attach(liveWs, { connId: 'conn-1' })
    runtime.viewerInput(liveWs, 'ls\n')
    assert.deepEqual(newRc.stream.writes, ['ls\n'])
  } finally {
    await cleanup()
  }
})

test('FAULT: a viewer that stops draining is dropped instead of buffering forever', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const rc = liveConn(runtime)
    const slow = fakeWs()
    slow.bufferedAmount = 9 * 1024 * 1024
    const fast = fakeWs()
    rc.sockets.add(slow)
    rc.sockets.add(fast)

    rc.push(Buffer.from('terminal output'))
    assert.equal(Buffer.from(fast.sentBinary.at(-1)).toString(), 'terminal output')
    assert.equal(slow.sentBinary.length, 0)
    assert.deepEqual(slow.closedWith, { code: 1011, reason: 'viewer-too-slow' })
    assert.equal(rc.sockets.has(slow), false)
  } finally {
    await cleanup()
  }
})

test('onReady announces state:"connected" in the ready frame (viewer contract)', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const rc = new RuntimeConn(runtime, 'conn-1', { host: 'box', label: 'example' })
    runtime.conns.set(rc.id, rc)
    const ws = fakeWs()
    rc.sockets.add(ws)
    let shellOpts = null
    rc.client = { shell: (opts, cb) => { shellOpts = opts; cb(null, fakeStream()) } }

    runtime.onReady(rc)
    assert.equal(rc.status, 'connected')
    assert.deepEqual(shellOpts, { term: 'xterm-256color', cols: 120, rows: 32 })
    const ready = ws.sentFrames.find(f => f.type === 'ready')
    assert.equal(ready.state, 'connected')
  } finally {
    await cleanup()
  }
})
