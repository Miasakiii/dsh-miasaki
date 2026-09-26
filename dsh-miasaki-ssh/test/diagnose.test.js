// Unit tests for the diagnostics module: pure helpers (verdict wording, banner parse,
// socket-error vocabulary, egress parsing) plus two real-socket cases — a live TCP
// listener that stays silent, and a real ssh2.Server that advertises its auth methods.
//
// The `none`-method probe is the load-bearing design decision here: diagnostics must
// not count as a failed login, so the test asserts the server sees `none` and never
// sees a password.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import {
  buildVerdict, classifySocketFailure, diagnose, listLocalAddresses, parseBanner,
  probeAuthMethods, probeTcpAndBanner, resolveEgressIp, resolveHost,
} from '../lib/diagnose.js'

const { Server: SshServer } = ssh2

test('parseBanner only accepts SSH banners and extracts the software string', () => {
  assert.deepEqual(parseBanner('SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13'), { isSsh: true, software: 'OpenSSH_9.6p1 Ubuntu-3ubuntu13' })
  assert.deepEqual(parseBanner('SSH-1.99-Cisco-1.25'), { isSsh: true, software: 'Cisco-1.25' })
  assert.deepEqual(parseBanner('HTTP/1.1 400 Bad Request'), { isSsh: false, software: null })
  assert.deepEqual(parseBanner(null), { isSsh: false, software: null })
  assert.deepEqual(parseBanner(''), { isSsh: false, software: null })
})

test('classifySocketFailure maps errno onto the report vocabulary', () => {
  assert.equal(classifySocketFailure({ code: 'ECONNREFUSED' }), 'refused')
  assert.equal(classifySocketFailure({ code: 'ECONNRESET' }), 'reset')
  assert.equal(classifySocketFailure({ code: 'EHOSTUNREACH' }), 'unreachable')
  assert.equal(classifySocketFailure({ code: 'ENETUNREACH' }), 'unreachable')
  assert.equal(classifySocketFailure({ code: 'ETIMEDOUT' }), 'timeout')
  assert.equal(classifySocketFailure(new Error('weird')), 'error')
})

test('resolveHost short-circuits IP literals and reports failures as data', async () => {
  const literal = await resolveHost('8.138.243.30')
  assert.deepEqual(literal, { ips: ['8.138.243.30'], literal: true, ms: 0 }, 'IP 字面量不做 DNS —— 这正是 ENOTFOUND 那类混淆的分界')

  const resolved = await resolveHost('example.com', { resolver: async () => [{ address: '93.184.216.34' }] })
  assert.deepEqual(resolved.ips, ['93.184.216.34'])
  assert.equal(resolved.literal, false)

  const failed = await resolveHost('nope.invalid', { resolver: async () => { throw new Error('getaddrinfo ENOTFOUND nope.invalid') } })
  assert.match(failed.error, /ENOTFOUND/)
})

test('listLocalAddresses exposes name/address/family without any network call', () => {
  const addresses = listLocalAddresses()
  assert.ok(Array.isArray(addresses))
  for (const item of addresses) {
    assert.equal(typeof item.name, 'string')
    assert.equal(typeof item.address, 'string')
    assert.equal(typeof item.family, 'string')
    assert.equal(typeof item.internal, 'boolean')
  }
})

// ---- 真 socket：TCP 通、但对端一个字节都不回（实机踩过的形态）------------------------
test('probeTcpAndBanner: 连上但零字节 → connected + banner null（不能报成 TCP 超时）', async () => {
  const server = net.createServer(socket => { /* 什么都不发：模拟"有东西但不是 sshd" */ })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const probe = await probeTcpAndBanner('127.0.0.1', port, { timeoutMs: 1500, bannerMs: 300 })
    assert.equal(probe.outcome, 'connected', 'TCP 是通的')
    assert.equal(probe.banner, null, '但没收到 banner')
    assert.match(probe.detail, /无数据/)
  } finally {
    server.close()
  }
})

test('probeTcpAndBanner: 读得到 SSH banner', async () => {
  const server = net.createServer(socket => socket.write('SSH-2.0-OpenSSH_9.6p1\r\n'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const probe = await probeTcpAndBanner('127.0.0.1', server.address().port, { timeoutMs: 1500, bannerMs: 800 })
    assert.equal(probe.outcome, 'connected')
    assert.equal(probe.banner, 'SSH-2.0-OpenSSH_9.6p1')
  } finally {
    server.close()
  }
})

test('probeTcpAndBanner: 无人监听 → refused；黑洞地址 → timeout', async () => {
  const closed = await probeTcpAndBanner('127.0.0.1', 1, { timeoutMs: 1200 })
  assert.equal(closed.outcome, 'refused')
  // 192.0.2.0/24 是 RFC 5737 的 TEST-NET，路由上必然黑洞 ⇒ 用短超时验证 timeout 分支
  const blackhole = await probeTcpAndBanner('192.0.2.1', 22, { timeoutMs: 600 })
  assert.equal(blackhole.outcome, 'timeout')
  assert.equal(blackhole.detail, null, '超时的 detail 留空：outcome 已经说明「无响应」，报告里不该出现两遍')
})

// ---- 认证方法探测：只问 `none`，不发密码 -------------------------------------------
test('probeAuthMethods: 用 `none` 方法读方法清单，服务端看不到任何密码尝试（真协议）', async () => {
  const hostKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey
  const seen = []
  const server = new SshServer({ hostKeys: [hostKey] }, client => {
    client.on('authentication', ctx => {
      seen.push({ method: ctx.method, username: ctx.username, hasPassword: ctx.method === 'password' && typeof ctx.password === 'string' })
      if (ctx.method === 'none') return ctx.reject(['publickey', 'password'])
      return ctx.reject()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await probeAuthMethods('127.0.0.1', server.address().port, 'someone', { timeoutMs: 6000 })
    assert.deepEqual(result.methods, ['publickey', 'password'])
    assert.equal(seen.length, 1, '只应有一次认证交互')
    assert.equal(seen[0].method, 'none', '必须是协议自带的 none —— 不计入失败密码尝试')
    assert.equal(seen.some(item => item.hasPassword), false, '绝不发送密码')
  } finally {
    server.close()
  }
})

test('resolveEgressIp: 逐个尝试服务、跳过非 IP 应答，全败时把原因带回来', async () => {
  const ok = await resolveEgressIp({
    endpoints: [{ url: 'https://a.test', source: 'a.test' }, { url: 'https://b.test', source: 'b.test' }],
    fetcher: async url => ({ text: async () => (url.includes('a.test') ? 'not-an-ip\n' : '203.0.113.7\n') }),
  })
  assert.deepEqual({ ip: ok.ip, source: ok.source }, { ip: '203.0.113.7', source: 'b.test' })

  const failed = await resolveEgressIp({
    endpoints: [{ url: 'https://a.test', source: 'a.test' }],
    fetcher: async () => { throw new Error('getaddrinfo ENOTFOUND a.test') },
  })
  assert.match(failed.error, /a\.test/)
})

test('buildVerdict: 每种失败形态给出对应的结论与提示', () => {
  const base = { target: { host: 'h', port: 22 }, dns: {}, ssh: {} }

  const timeout = buildVerdict({ ...base, tcp: { outcome: 'timeout', ms: 3500 }, ssh: { banner: null } })
  assert.equal(timeout.code, 'TCP_TIMEOUT')
  assert.match(timeout.title, /无响应/)
  assert.ok(timeout.hints.some(h => /fail2ban/.test(h)), '要提到「整机所有端口一起超时」这个真实形态')

  assert.equal(buildVerdict({ ...base, tcp: { outcome: 'refused' }, ssh: { banner: null } }).code, 'TCP_REFUSED')
  assert.equal(buildVerdict({ ...base, tcp: { outcome: 'reset' }, ssh: { banner: null } }).code, 'TCP_RESET')
  assert.equal(buildVerdict({ ...base, tcp: { outcome: 'unreachable' }, ssh: { banner: null } }).code, 'TCP_UNREACHABLE')

  const silent = buildVerdict({ ...base, tcp: { outcome: 'connected', ms: 20 }, ssh: { banner: null, isSsh: false } })
  assert.equal(silent.code, 'NOT_SSH')
  assert.match(silent.title, /一个字节都没有回/)

  const httpish = buildVerdict({ ...base, tcp: { outcome: 'connected' }, ssh: { banner: 'HTTP/1.1 400 Bad Request', isSsh: false } })
  assert.equal(httpish.code, 'NOT_SSH')
  assert.match(httpish.title, /HTTP\/1\.1 400/)

  const keyOnly = buildVerdict({ ...base, tcp: { outcome: 'connected' }, ssh: { banner: 'SSH-2.0-x', isSsh: true }, auth: { methods: ['publickey'] } })
  assert.equal(keyOnly.code, 'PASSWORD_DISABLED')
  assert.match(keyOnly.title, /不允许密码登录/)

  const reachable = buildVerdict({ ...base, tcp: { outcome: 'connected' }, ssh: { banner: 'SSH-2.0-OpenSSH_9.6', isSsh: true }, auth: { methods: ['publickey', 'password'] } })
  assert.equal(reachable.code, 'REACHABLE')
  assert.equal(reachable.level, 'ok')
  assert.ok(reachable.hints.some(h => /账号 \/ 密码/.test(h)))

  const dnsFailed = buildVerdict({ ...base, dns: { error: 'getaddrinfo ENOTFOUND nope' }, tcp: null, ssh: null })
  assert.equal(dnsFailed.code, 'DNS_FAILED')
})

// ---- 全流程（注入 fetcher/resolver，不打外网）--------------------------------------
test('diagnose: 组装报告并落 verdict（含可选出口 IP 探测）', async () => {
  const server = net.createServer(socket => socket.write('SSH-2.0-OpenSSH_9.6p1\r\n'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const report = await diagnose(
      { host: '127.0.0.1', port, username: 'u', label: 'local', resolveEgress: true },
      { fetcher: async () => ({ text: async () => '198.51.100.9\n' }) },
    )
    assert.equal(report.verdict.code, 'REACHABLE')
    assert.equal(report.ssh.banner, 'SSH-2.0-OpenSSH_9.6p1')
    assert.equal(report.egress.ip, '198.51.100.9')
    assert.equal(report.auth, null, '默认不探测认证方法')
    assert.ok(report.local.addresses.length >= 1)
  } finally {
    server.close()
  }

  const bad = await diagnose({ host: '', port: 0 })
  assert.equal(bad.verdict.code, 'BAD_INPUT')

  // 默认不外呼：没传 resolveEgress 时 egress 保持 null（隐私默认值）
  const silent = await diagnose({ host: '127.0.0.1', port: 1 }, { fetcher: async () => { throw new Error('不该被调用') } })
  assert.equal(silent.egress, null)
})
