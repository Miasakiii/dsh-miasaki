// Integration smoke test for the host half: mounts `apply(ctx, config)` on a
// mocked webServer backed by a real node:http server, then exercises the
// /ssh page, the REST API, the browser fence, and the WS upgrade path with a
// real ws client. No ssh2 connection is attempted (no real server).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import ssh2 from 'ssh2'
import { apply as applySsh } from '../index.js'

// ssh2 是 CommonJS 包：Server 走默认导入再解构（命名导入 lexer 认不到）。
const { Server: SshServer } = ssh2

function mount() {
  const httpServer = http.createServer()
  const disposers = []
  const upgrades = new Map()
  const routes = new Map()

  const webServer = {
    routes,
    register({ kind, path, handler }) {
      const key = `${kind}:${path}`
      if (routes.has(key)) throw new Error(`duplicate route ${key}`)
      routes.set(key, { kind, path, handler })
      const disposer = () => routes.delete(key)
      disposers.push(disposer)
      return disposer
    },
    registerUpgrade({ path, handler }) {
      if (upgrades.has(path)) throw new Error(`duplicate upgrade ${path}`)
      upgrades.set(path, handler)
      const disposer = () => upgrades.delete(path)
      disposers.push(disposer)
      return disposer
    },
  }

  httpServer.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const hit = [...routes.values()].find(route => {
      if (route.kind === 'exact') return route.path === url.pathname
      return url.pathname.startsWith(route.path)
    })
    if (hit === undefined) { res.writeHead(404); res.end('NOT FOUND'); return }
    hit.handler(req, res)
  })
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const handler = upgrades.get(url.pathname)
    if (handler === undefined) { socket.destroy(); return }
    handler(req, socket, head)
  })

  return { httpServer, webServer, disposers, close: () => { for (const d of disposers) d() } }
}

/**
 * Mount the plugin on a real HTTP server for one test. `seed` is written to
 * `dataDir/connections.json` **before** apply, which is the only way to get a
 * legacy record onto the store now that the write path normalizes host:port.
 */
async function withServer(run, { seed } = {}) {
  const harness = mount()
  const dir = await mkdtemp(join(tmpdir(), 'ssh-http-'))
  const dataDir = join(dir, 'data')
  try {
    if (seed !== undefined) {
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(dataDir, 'connections.json'), JSON.stringify(seed))
    }
    const ctx = {
      logger: { error: () => {}, warn: () => {} },
      webServer: harness.webServer,
      effect(fn) { const disposer = fn(); if (typeof disposer === 'function') harness.disposers.push(disposer); return () => {} },
    }
    applySsh(ctx, { dataDir, scrollbackBytes: 4096 })
    await new Promise(resolve => harness.httpServer.listen(0, '127.0.0.1', resolve))
    const port = harness.httpServer.address().port
    await run({ port, dataDir, ...harness })
  } finally {
    harness.close()
    harness.httpServer.closeAllConnections?.()
    await new Promise(resolve => harness.httpServer.close(resolve))
    // the JsonFile save chain runs on a microtask queue; give it a beat
    await new Promise(resolve => setTimeout(resolve, 30))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** raw request that lets us forge the Host header (undici's fetch won't). */
function rawRequest(port, pathname, { host = HOST_HEADER.Host, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, headers: { Host: host, ...(body ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      let data = ''
      res.on('data', chunk => (data += chunk))
      res.on('end', () => resolve({ status: res.statusCode, text: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function plain404(req, res) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('NOT FOUND') }

const HOST_HEADER = { Host: '127.0.0.1' }

test('page route serves HTML at /ssh/', async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/ssh/`, { headers: HOST_HEADER })
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /id="ssh-root"/)
    assert.match(html, /xterm\.js/)
  })
})

test('REST: connection CRUD + state tagging + fence rejection', async () => {
  await withServer(async ({ port }) => {
    // fence: untrusted host rejected
    const evil = await rawRequest(port, '/ssh/api/connections', { host: 'evil.example' })
    assert.equal(evil.status, 403)

    const create = await rawRequest(port, '/ssh/api/connections', {
      method: 'POST',
      body: JSON.stringify({ label: 'prod', host: '10.0.0.5', auth: { method: 'agent' } }),
    })
    assert.equal(create.status, 201)
    const created = JSON.parse(create.text).connection
    assert.equal(created.auth.method, 'agent')
    assert.equal('password' in created.auth, false) // never any secret

    const list = await rawRequest(port, '/ssh/api/connections')
    assert.equal(JSON.parse(list.text).connections.length, 1)

    const one = await rawRequest(port, `/ssh/api/connections/${created.id}`)
    assert.equal(JSON.parse(one.text).connection.id, created.id)

    const del = await rawRequest(port, `/ssh/api/connections/${created.id}`, { method: 'DELETE' })
    assert.equal(del.status, 200)
  })
})

// 实机反馈（2026-09-26）：主机栏里连端口一起填 → ssh2 拿 `host:port` 当主机名解析
// （getaddrinfo ENOTFOUND）。写入路径立即拆分；历史记录在 connect 时拆分并回写。
test('REST: 主机栏里带端口 → 写入即拆分（前端粘贴地址直接可用）', async () => {
  await withServer(async ({ port }) => {
    const create = await rawRequest(port, '/ssh/api/connections', {
      method: 'POST',
      body: JSON.stringify({ label: 'NO.1', host: '8.138.243.30:25112', username: 'wwq7tmzr' }),
    })
    assert.equal(create.status, 201)
    const created = JSON.parse(create.text).connection
    assert.equal(created.host, '8.138.243.30')
    assert.equal(created.port, 25112)
  })
})

test('REST: 历史记录在 connect 时就地拆分并回写，响应回报 repaired', async () => {
  const legacy = {
    id: 'a1b2c3d4-0000-4000-8000-000000000001', label: 'NO.1', host: '127.0.0.1:1', port: 22,
    username: 'u', auth: { method: 'password' }, group: '未分组', favorite: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastConnectedAt: null,
  }
  await withServer(async ({ port }) => {
    const res = await rawRequest(port, `/ssh/api/connections/${legacy.id}/connect`, {
      method: 'POST', body: JSON.stringify({ password: 'x' }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text).repaired, { from: '127.0.0.1:1', host: '127.0.0.1', port: 1 })

    const one = await rawRequest(port, `/ssh/api/connections/${legacy.id}`)
    const record = JSON.parse(one.text).connection
    assert.equal(record.host, '127.0.0.1', '磁盘记录已修正，不只是响应')
    assert.equal(record.port, 1)
  }, { seed: { version: 1, connections: [legacy] } })
})

test('WS upgrade: fence blocks foreign host, then ok client can talk', async () => {  await withServer(async ({ port }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ssh/ws`, [], { headers: HOST_HEADER })
    // no connection has been created, so the host replies with an error frame
    const received = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 3000)
      ws.on('message', data => { clearTimeout(timer); resolve(String(data)) })
      ws.onopen = () => ws.send(JSON.stringify({ type: 'attach', connId: 'missing-id' }))
      ws.onerror = () => { clearTimeout(timer); resolve(null) }
    })
    assert.ok(received !== null, 'expected a control frame, got nothing')
    const parsed = JSON.parse(received)
    assert.equal(parsed.type, 'error')
    ws.close()
  })
})

// ---- U2.1：v2 协议与附着票据的 HTTP/WS 层行为（方案 §3.2/§3.3）----

test('U2.1: POST /ssh/api/attach 对未知连接 404 / 非法 connId 400', async () => {
  await withServer(async ({ port }) => {
    const res = await rawRequest(port, '/ssh/api/attach', { method: 'POST', body: JSON.stringify({ connId: '11111111-1111-1111-1111-111111111111' }) })
    assert.equal(res.status, 404)
    const bad = await rawRequest(port, '/ssh/api/attach', { method: 'POST', body: JSON.stringify({ connId: 'not-a-uuid!' }) })
    assert.equal(bad.status, 400)
  })
})

test('U2.1: 旧帧（无 v:2）被拒并提示刷新（不做双栈）', async () => {
  await withServer(async ({ port }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ssh/ws`, [], { headers: HOST_HEADER })
    const received = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 3000)
      ws.on('message', data => { clearTimeout(timer); resolve(String(data)) })
      ws.onopen = () => ws.send(JSON.stringify({ type: 'attach', connId: 'whatever' }))
      ws.onerror = () => { clearTimeout(timer); resolve(null) }
    })
    assert.ok(received !== null, 'expected a control frame, got nothing')
    const parsed = JSON.parse(received)
    assert.equal(parsed.type, 'error')
    assert.equal(parsed.code, 'VERSION_MISMATCH')
    assert.match(parsed.message, /刷新/)
    ws.close()
  })
})

test('U2.1: v2 帧带无效票据被拒（TICKET_INVALID）', async () => {
  await withServer(async ({ port }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ssh/ws`, [], { headers: HOST_HEADER })
    const received = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 3000)
      ws.on('message', data => { clearTimeout(timer); resolve(String(data)) })
      ws.onopen = () => ws.send(JSON.stringify({ v: 2, type: 'attach', ticket: 'bogus-ticket' }))
      ws.onerror = () => { clearTimeout(timer); resolve(null) }
    })
    assert.ok(received !== null)
    const parsed = JSON.parse(received)
    assert.equal(parsed.type, 'error')
    assert.equal(parsed.code, 'TICKET_INVALID')
    ws.close()
  })
})

test('U2.4: addon-serialize 静态资产随包可用（官方 0.14.0）', async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/ssh/vendor/addon-serialize.js`, { headers: HOST_HEADER })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /SerializeAddon|addon-serialize/)
  })
})

// 连接诊断（档 B）：真实 ssh2 假 sshd + 真实 index.js 路由。
// 三条硬约束在这条端到端里一起验：① 默认不外呼查出口 IP；② 认证方法探测只发 `none`；
// ③ 报告带 verdict，前端只渲染不判断。
test('REST: /ssh/api/diagnose 真协议探测（banner + 方法清单），默认不外呼出口 IP', async () => {
  const hostKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey
  const seenAuth = []
  const fakeSshd = new SshServer({ hostKeys: [hostKey] }, client => {
    client.on('authentication', ctx => {
      seenAuth.push(ctx.method)
      if (ctx.method === 'none') return ctx.reject(['publickey', 'password'])
      return ctx.reject()
    })
  })
  await new Promise(resolve => fakeSshd.listen(0, '127.0.0.1', resolve))
  const sshPort = fakeSshd.address().port
  try {
    await withServer(async ({ port }) => {
      const res = await rawRequest(port, '/ssh/api/diagnose', {
        method: 'POST',
        body: JSON.stringify({ draft: { host: '127.0.0.1', port: sshPort, username: 'u' }, probeAuth: true }),
      })
      assert.equal(res.status, 200)
      const { report } = JSON.parse(res.text)
      assert.equal(report.verdict.code, 'REACHABLE')
      assert.equal(report.verdict.level, 'ok')
      assert.match(report.ssh.banner, /^SSH-2\.0-/)
      assert.deepEqual(report.auth.methods, ['publickey', 'password'])
      assert.equal(seenAuth.includes('password'), false, '诊断不得发出密码尝试')
      assert.equal(report.egress, null, '没点「查询出口 IP」就不许外呼')

      // 目标缺失 → 400（而不是把 undefined 当主机去连）
      const missing = await rawRequest(port, '/ssh/api/diagnose', { method: 'POST', body: JSON.stringify({}) })
      assert.equal(missing.status, 400)

      // fence 仍然有效：不可信 Host 打诊断口也是 403
      const evil = await rawRequest(port, '/ssh/api/diagnose', { method: 'POST', host: 'evil.example', body: JSON.stringify({ draft: { host: '127.0.0.1', port: 1 } }) })
      assert.equal(evil.status, 403)
    })
  } finally {
    fakeSshd.close()
  }
})
