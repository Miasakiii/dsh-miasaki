// Unit tests for the pure store layer: fence, normalization, fingerprints,
// and JSON persistence. Node's built-in test runner (node --test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hostKeyOf, fingerprintOf, normalizeConnection, sanitizeConnection,
  stripPort, fenceCheck, InputError, NotFoundError, SshStore,
} from '../lib/store.js'

test('stripPort keeps hostname and strips a numeric suffix', () => {
  assert.equal(stripPort('127.0.0.1:3080'), '127.0.0.1')
  assert.equal(stripPort('localhost'), 'localhost')
  assert.equal(stripPort('[::1]:8080'), '[::1]')
})

test('hostKeyOf brackets IPv6 and defaults port 22', () => {
  assert.equal(hostKeyOf('example.com', 22), 'example.com:22')
  assert.equal(hostKeyOf('::1', 22), '[::1]:22')
  assert.equal(hostKeyOf('example.com'), 'example.com:22')
})

test('fingerprintOf returns OpenSSH SHA256 form over the buffer', () => {
  const fp = fingerprintOf(Buffer.from('host-key-bytes'))
  assert.match(fp, /^SHA256:[A-Za-z0-9+/=]+$/)
  // deterministic
  assert.equal(fingerprintOf(Buffer.from('host-key-bytes')), fp)
})

test('normalizeConnection defaults and rejects', () => {
  const record = normalizeConnection({ host: 'example.com', label: 'prod' })
  assert.equal(record.port, 22)
  assert.equal(record.username, '') // 不默认提权为 root（plan §3.3，编辑器表单必填）
  assert.equal(record.group, '未分组')
  assert.equal(record.favorite, false)
  assert.equal(record.auth.method, 'password')

  assert.throws(() => normalizeConnection({ host: '', label: 'x' }), InputError)
  assert.throws(() => normalizeConnection({ host: 'example.com', label: 'x', port: 70000 }))
  assert.throws(() => normalizeConnection({ host: 'example.com', label: 'x', auth: { method: 'key' } }), InputError)
  const keyed = normalizeConnection({ host: 'example.com', label: 'x', auth: { method: 'key', keyPath: 'C:\\Users\\me\\.ssh\\id_ed25519' } })
  assert.equal(keyed.auth.keyPath, 'C:\\Users\\me\\.ssh\\id_ed25519')

  // favorite / group round-trip and coercion
  const fav = normalizeConnection({ host: 'example.com', label: 'x', favorite: true, group: '  生产环境  ' })
  assert.equal(fav.favorite, true)
  assert.equal(fav.group, '生产环境')
  assert.equal(normalizeConnection({ host: 'e.com', label: 'x', favorite: 'yes' }).favorite, false)
})

test('normalizeConnection never stores a password in a record', () => {
  const record = normalizeConnection({ host: 'example.com', label: 'x', auth: { method: 'password', password: 'hunter2' } })
  assert.equal('password' in record.auth, false)
  assert.equal(Object.values(JSON.parse(JSON.stringify(record))).some(v => String(v).includes('hunter2')), false)
})

test('fenceCheck accepts loopback / trusted and rejects the rest', () => {
  const trusted = new Set(['localhost', '127.0.0.1', 'dsh.lan'])
  assert.equal(fenceCheck({ host: 'localhost:3080' }, trusted).ok, true)
  assert.equal(fenceCheck({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, trusted).ok, true)
  assert.equal(fenceCheck({ host: 'dsh.lan' }, trusted).ok, true)
  assert.equal(fenceCheck({ host: 'evil.example' }, trusted).ok, false)
  assert.equal(fenceCheck({ host: '127.0.0.1', 'sec-fetch-site': 'cross-site' }, trusted).ok, false)
  assert.equal(fenceCheck({ host: '127.0.0.1', origin: 'http://evil.example.com' }, trusted).ok, false)
  assert.equal(fenceCheck({ host: '127.0.0.1', origin: 'http://127.0.0.1:3080' }, trusted).ok, true)
})

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ssh-store-'))
  const store = new SshStore(join(dir, 'data'))
  try {
    await run(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('SshStore persists connections and fingerprints, then reloads', async () => {
  await withStore(async store => {
    const created = await store.createConnection({ label: 'prod', host: '10.0.0.1', port: 22, auth: { method: 'key', keyPath: 'C:\\keys\\id_rsa' } })
    assert.equal(created.label, 'prod')
    assert.equal(created.auth.keyPath, 'C:\\keys\\id_rsa')

    await store.recordFingerprint('10.0.0.1:22', 'SHA256:abc')
    const known = await store.getFingerprint('10.0.0.1:22')
    assert.equal(known.fingerprint, 'SHA256:abc')

    // list is sanitized (no secrets leak; there are none) and includes state
    const list = await store.listConnections()
    assert.equal(list.length, 1)
    assert.deepEqual(Object.keys(list[0]).sort(), ['auth', 'createdAt', 'favorite', 'group', 'host', 'id', 'label', 'lastConnectedAt', 'port', 'updatedAt', 'username'].sort())

    // update
    await store.updateConnection(created.id, { host: '10.0.0.2' })
    const retrieved = await store.getConnection(created.id)
    assert.equal(retrieved.host, '10.0.0.2')

    // unknown id -> NotFoundError
    await assert.rejects(() => store.updateConnection(created.id + 'x', { host: 'x' }), NotFoundError)

    // touchConnected sets lastConnectedAt
    await store.touchConnected(created.id)
    assert.ok((await store.getConnection(created.id)).lastConnectedAt)

    // remove
    assert.equal(await store.removeConnection(created.id), true)
    assert.equal(await store.removeConnection(created.id), false)

    // hosts listing
    await store.recordFingerprint('host-a:22', 'SHA256:1')
    const hosts = await store.listHosts()
    assert.ok(hosts.some(item => item.hostKey === 'host-a:22'))
    await store.forgetHost('host-a:22')
    assert.equal(await store.getFingerprint('host-a:22'), null)
  })
})

test('SshStore rejects an empty dataDir', () => {
  assert.throws(() => new SshStore(''), /non-empty/)
})