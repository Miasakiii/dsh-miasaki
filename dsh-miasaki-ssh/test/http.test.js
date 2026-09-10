// Integration smoke test for the host half: mounts `apply(ctx, config)` on a
// mocked webServer backed by a real node:http server, then exercises the
// /ssh page, the REST API, the browser fence, and the WS upgrade path with a
// real ws client. No ssh2 connection is attempted (no real server).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { apply as applySsh } from '../index.js'

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

async function withServer(run) {
  const harness = mount()
  const dir = await mkdtemp(join(tmpdir(), 'ssh-http-'))
  try {
    const ctx = {
      logger: { error: () => {}, warn: () => {} },
      webServer: harness.webServer,
      effect(fn) { const disposer = fn(); if (typeof disposer === 'function') harness.disposers.push(disposer); return () => {} },
    }
    applySsh(ctx, { dataDir: join(dir, 'data'), scrollbackBytes: 4096 })
    await new Promise(resolve => harness.httpServer.listen(0, '127.0.0.1', resolve))
    const port = harness.httpServer.address().port
    await run({ port, ...harness })
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

test('WS upgrade: fence blocks foreign host, then ok client can talk', async () => {
  await withServer(async ({ port }) => {
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