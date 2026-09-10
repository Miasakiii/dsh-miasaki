// Unit tests for the runtime layer: error classification, fingerprint TOFU
// decision flow, and bounded scrollback. No real ssh2 Client or network is
// constructed — all interaction goes through the pure decision logic
// (handleHostKey / confirmFingerprint) and a scratch SshStore.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyError, SshRuntime } from '../lib/runtime.js'
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
    fp: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    broadcast() {},
    answer(code, message) { this.status = 'error'; this.lastErrorCode = code; this.lastErrorMessage = message },
    dispose() {},
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