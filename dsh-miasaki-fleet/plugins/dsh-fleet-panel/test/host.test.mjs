// host.test.mjs — @miasaki/dsh-fleet-panel host 半（2026-10-19，P0「看得见」批次）
//
// 覆盖点（都是「静默失效」形态）：
//   · panel.html 的 API 基址改写必须命中锚点，锚点漂移要**显式失败**（否则 iframe 内数据全空）；
//   · /dsh-fleet/api/* → /api/* 的路径映射（前缀不符必须拒绝，防代理越界）；
//   · 三道信任围栏（Host / sec-fetch-site / Origin）先于业务（跨站 POST 不得触碰写接口）；
//   · apply 注册的三条路由 kind/path，以及 monitor 不可用时 health 的诚实降级。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, rewritePanelHtml, buildProxyTarget, __test } from '../lib/index.js'
import { structuralFence } from '../lib/fence.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FLEET_ROOT = path.resolve(HERE, '..', '..', '..')
const PANEL_HTML = path.join(FLEET_ROOT, 'fleet-monitor', 'panel.html')

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    writeHead(status) { this.statusCode = status; return this },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.ended = true },
  }
  return res
}

function fakeReq({ method = 'GET', url = '/dsh-fleet/health', headers = {}, body = '' } = {}) {
  const listeners = new Map()
  return {
    method,
    url,
    headers,
    on(event, fn) { listeners.set(event, fn); return this },
    destroy() { this.destroyed = true },
    // health/panel 不读 body；代理分支的 body 由 stream 驱动，这里只保留最小形状。
    emitBody() { const fn = listeners.get('end'); if (fn) fn() },
    body,
  }
}

function makeCtx() {
  const routes = []
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    get: () => undefined,
    on: () => {},
  }
  return { ctx, routes }
}

test('panel.html 真实文件：API 基址被改写成同源 /dsh-fleet', () => {
  const html = fs.readFileSync(PANEL_HTML, 'utf8')
  assert.ok(html.includes("if (location.port === '39801') return location.origin;"), 'panel.html 应包含 API_BASE 锚点')
  const out = rewritePanelHtml(html)
  assert.ok(out.includes("return '/dsh-fleet';"), '改写后应指向同源前缀')
  assert.ok(!out.includes("location.port === '39801'"), '原锚点不应残留')
  // 面板内 fetch 拼接方式不变 ⇒ '/dsh-fleet' + '/api/fleet'
  assert.ok(out.includes("fetch(API_BASE + '/api/fleet')"), 'fetch 拼接必须保持相对路径形状')
})

test('panel.html 判定层四块走绝对路径 j(\'/api/…)：必须一并改写为 /dsh-fleet/api/…', () => {
  const html = fs.readFileSync(PANEL_HTML, 'utf8')
  const out = rewritePanelHtml(html)
  // 不改写时请求会打到 DSH 自身的 /api/*（返回 not found 文本）⇒ 面板 JSON.parse 报
  // SyntaxError 并显示「不可用」——2026-10-20 在实机上就是这么暴露的。
  assert.ok(!out.includes("j('/api/"), '不得残留未加前缀的判定层绝对路径')
  const prefixed = out.split("j('/dsh-fleet/api/").length - 1
  assert.ok(prefixed >= 4, `判定层四个端点都应被改写（实际 ${prefixed} 处）`)
  for (const endpoint of ['dispatchable', 'gaps', 'events', 'verifiers']) {
    assert.ok(out.includes(`j('/dsh-fleet/api/${endpoint}`), `缺少 ${endpoint} 的改写`)
  }
})

test('panel.html 锚点漂移：显式抛错，不静默返回原页面', () => {
  assert.throws(() => rewritePanelHtml('<html>无锚点</html>'), /锚点/)
  assert.throws(() => rewritePanelHtml(''), /锚点/)
})

test('buildProxyTarget：只放行 /dsh-fleet/api/*，并将其映射到 /api/*', () => {
  assert.equal(buildProxyTarget('/dsh-fleet/api/fleet'), '/api/fleet')
  assert.equal(buildProxyTarget('/dsh-fleet/api/toggle/pi'), '/api/toggle/pi')
  assert.equal(buildProxyTarget('/dsh-fleet/api/report?days=7'), '/api/report?days=7')
  assert.equal(buildProxyTarget('/dsh-fleet/api'), '/api')
  // 前缀越界/其它路由一律拒绝（防代理被当成任意上游转发器）
  assert.equal(buildProxyTarget('/dsh-fleet/panel'), null)
  assert.equal(buildProxyTarget('/dsh-fleet/health'), null)
  assert.equal(buildProxyTarget('/api/fleet'), null)
  assert.equal(buildProxyTarget('/dsh-fleet/apiX/fleet'), null)
  assert.equal(buildProxyTarget(undefined), null)
})

test('信任围栏：环回 Host 放行；非环回 / 跨站 / 跨源 Host 拒绝', () => {
  assert.equal(structuralFence({ host: '127.0.0.1:3080' }).ok, true)
  assert.equal(structuralFence({ host: 'localhost:3080' }).ok, true)
  assert.equal(structuralFence({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }).ok, true)
  assert.equal(structuralFence({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }).ok, true)
  assert.equal(structuralFence({ host: 'evil.example:3080' }).ok, false)
  assert.equal(structuralFence({}).ok, false, 'Host 缺失必须 fail closed')
  assert.equal(structuralFence({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }).ok, false)
  assert.equal(structuralFence({ host: '127.0.0.1:3080', origin: 'http://evil.example' }).ok, false)
  assert.equal(structuralFence({ host: '127.0.0.1:3080', origin: 'null' }).ok, false)
})

test('apply：注册 prefix 代理 + exact 面板 + exact health 三条路由', () => {
  const { ctx, routes } = makeCtx()
  apply(ctx, { autoStart: false, noSpawn: true, port: 65431 })
  assert.equal(routes.length, 3)
  const byPath = new Map(routes.map((r) => [r.path, r]))
  assert.equal(byPath.get('/dsh-fleet/api').kind, 'prefix')
  assert.equal(byPath.get('/dsh-fleet/panel').kind, 'exact')
  assert.equal(byPath.get('/dsh-fleet/health').kind, 'exact')
  for (const route of routes) assert.equal(typeof route.handler, 'function')
})

test('health：monitor 不可达且禁止拉起时如实降级（不假装在线）', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx, { autoStart: false, noSpawn: true, port: 65431 })
  const health = routes.find((r) => r.path === '/dsh-fleet/health').handler
  const req = fakeReq({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } })
  const res = fakeRes()
  await health(req, res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.equal(body.running, false)
  assert.ok(String(body.error || '').length > 0, '失败必须带可读原因')
  assert.equal(body.port, 65431)
})

test('围栏先于业务：跨站请求打 health 得到 403，且不进入业务', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx, { autoStart: false, noSpawn: true, port: 65431 })
  const health = routes.find((r) => r.path === '/dsh-fleet/health').handler
  const res = fakeRes()
  await health(fakeReq({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), res)
  assert.equal(res.statusCode, 403)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.equal(body.port, undefined)
})

test('panel：跨站请求同样先被围栏拒绝', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx, { autoStart: false, noSpawn: true, port: 65431 })
  const panel = routes.find((r) => r.path === '/dsh-fleet/panel').handler
  const res = fakeRes()
  await panel(fakeReq({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }), res)
  assert.equal(res.statusCode, 403)
})

test('monitor 路径按插件位置推导到 fleet 根（嵌套一层 plugins/ 也正确）', () => {
  assert.equal(path.basename(__test.fleetRoot()), 'dsh-miasaki-fleet')
  assert.equal(__test.monitorScript(), path.join(FLEET_ROOT, 'fleet-monitor', 'server.js'))
  assert.equal(__test.panelHtmlPath(), path.join(FLEET_ROOT, 'fleet-monitor', 'panel.html'))
})
