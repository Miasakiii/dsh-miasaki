// fence.test.mjs — I5 同源围栏单测（2026-09-30）
//
// 本线是九线里**唯一没有同源围栏**的一条：exact 路由不经过内核 `/api` 准入链，
// 2026-09-29 实测非环回 Host / 跨站请求打 `/dsh-token-monitor/*` 两轴均返回 **200**，
// 其中 `POST /reset` 是**清空账本**的写操作。本文件把补上的围栏钉住：
//   ① 结构层五条边界（含 Host 缺失 fail closed 与 `Origin: null`）；
//   ② `connection` 服务两层语义（401/403 透传、undefined 放行、抛错回落结构层）；
//   ③ **逐请求读取**（晚 provide 即接管）；
//   ④ **围栏先于业务** —— 跨站 POST 得到 403 而不是 405，且业务 handler 一次都没被调用。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fenceHandler, structuralFence, trustFence } from '../lib/fence.js'

const LOOPBACK = { host: '127.0.0.1:3080' }

/** 造一个够用的假请求。 */
function req(headers, method = 'GET') {
  return { headers, method, url: '/dsh-token-monitor/reset' }
}

/** 造一个够用的假响应，记录状态码与响应体。 */
function res() {
  const r = {
    statusCode: 0,
    headers: {},
    body: null,
    ended: false,
    setHeader(k, v) { r.headers[String(k).toLowerCase()] = v },
    end(b) { r.body = b; r.ended = true },
  }
  return r
}

// ---------------------------------------------------------------------------
// 结构层
// ---------------------------------------------------------------------------

test('结构层：回环 Host 放行（带端口 / localhost / IPv6 同形）', () => {
  for (const host of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080', '127.0.0.1']) {
    assert.equal(structuralFence({ host }).ok, true, `${host} 应放行`)
  }
})

test('结构层：非环回 Host 一律 403（DNS rebinding 面）', () => {
  for (const host of ['evil.example.com', '192.168.1.5:3080', '10.0.0.1']) {
    const v = structuralFence({ host })
    assert.equal(v.ok, false, `${host} 应拒绝`)
    assert.equal(v.status, 403)
  }
})

test('结构层：Host 缺失 / 为空 → fail closed（不退回 socket 本地地址）', () => {
  for (const headers of [{}, { host: '' }, { host: '   ' }, { host: null }]) {
    const v = structuralFence(headers)
    assert.equal(v.ok, false, '缺 Host 必须拒绝')
    assert.equal(v.status, 403)
  }
})

test('结构层：sec-fetch-site: cross-site → 403（大小写不敏感）', () => {
  assert.equal(structuralFence({ ...LOOPBACK, 'sec-fetch-site': 'cross-site' }).status, 403)
  assert.equal(structuralFence({ ...LOOPBACK, 'sec-fetch-site': 'Cross-Site' }).status, 403)
  assert.equal(structuralFence({ ...LOOPBACK, 'sec-fetch-site': 'same-origin' }).ok, true)
})

test('结构层：Origin / Referer 异源或 opaque（Origin: null）→ 403', () => {
  assert.equal(structuralFence({ ...LOOPBACK, origin: 'http://evil.example.com' }).status, 403)
  assert.equal(structuralFence({ ...LOOPBACK, origin: 'null' }).status, 403, 'opaque origin 必须拒绝')
  assert.equal(structuralFence({ ...LOOPBACK, referer: 'http://evil.example.com/x' }).status, 403)
})

test('结构层：同源 Origin / Referer 放行（浏览器正常页面请求）', () => {
  assert.equal(structuralFence({ ...LOOPBACK, origin: 'http://127.0.0.1:3080' }).ok, true)
  assert.equal(structuralFence({ ...LOOPBACK, referer: 'http://127.0.0.1:3080/index.html' }).ok, true)
})

// ---------------------------------------------------------------------------
// connection 服务层
// ---------------------------------------------------------------------------

test('connection 层：401 / 403 透传，undefined 放行（与内核 /api 同级）', () => {
  assert.equal(trustFence(LOOPBACK, { requestRejection: () => 401 }).status, 401)
  assert.equal(trustFence(LOOPBACK, { requestRejection: () => 403 }).status, 403)
  assert.equal(trustFence(LOOPBACK, { requestRejection: () => undefined }).ok, true)
})

test('connection 层：服务抛错 → 回落结构层，而不是让每个请求 500', () => {
  const boom = { requestRejection: () => { throw new Error('composition 缺陷') } }
  assert.equal(trustFence(LOOPBACK, boom).ok, true, '回落后仍按结构层判：回环放行')
  assert.equal(trustFence({ host: 'evil.example.com' }, boom).status, 403, '回落后结构层照样拦')
})

test('connection 层：缺席（undefined / null / 无 requestRejection）→ 结构层', () => {
  assert.equal(trustFence(LOOPBACK, undefined).ok, true)
  assert.equal(trustFence(LOOPBACK, null).ok, true)
  assert.equal(trustFence(LOOPBACK, {}).ok, true)
  assert.equal(trustFence({ host: 'evil.example.com' }, undefined).status, 403)
})

test('connection 层：**逐请求读取** —— 晚 provide 的服务立即接管（快照即退化）', () => {
  let connection
  let entered = 0
  const fence = fenceHandler(() => { entered++ }, () => connection)

  // 第一请求：服务还没 provide ⇒ 结构层放行回环，正常进业务
  const r1 = res()
  fence(req(LOOPBACK), r1)
  assert.equal(entered, 1, 'connection 缺席时由结构层判定')

  // 服务到位后：同一包装器必须**当次**就用新服务判定（装载时快照就永远走不到这条）
  connection = { requestRejection: () => 401 }
  const r2 = res()
  fence(req(LOOPBACK), r2)
  assert.equal(r2.statusCode, 401, '晚 provide 的 connection 必须立即生效')
  assert.equal(entered, 1, '被 401 拦下后不得再进业务')
})

// ---------------------------------------------------------------------------
// 围栏先于业务
// ---------------------------------------------------------------------------

test('围栏先于业务：跨站 POST /reset 得 403（不是 405），业务 handler 一次都没被调用', () => {
  let called = 0
  const fenced = fenceHandler(() => { called++ }, () => undefined)

  const r = res()
  fenced(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, 'POST'), r)

  assert.equal(r.statusCode, 403, '围栏必须排在 method 检查之前（跨站应得 403 而非 405）')
  assert.equal(called, 0, '被围栏拦下的请求不得触碰账本')
  assert.equal(JSON.parse(r.body).ok, false)
})

test('围栏放行后业务照常执行，且响应仍由业务决定', () => {
  let called = 0
  const fenced = fenceHandler((request, response) => {
    called++
    response.statusCode = 200
    response.end('{"ok":true}')
  }, () => undefined)

  const r = res()
  fenced(req(LOOPBACK, 'POST'), r)
  assert.equal(called, 1)
  assert.equal(r.statusCode, 200)
  assert.equal(r.body, '{"ok":true}')
})

test('围栏拒绝的响应不带任何 CORS 头（不给跨站页面读响应的机会）', () => {
  const fenced = fenceHandler(() => {}, () => undefined)
  const r = res()
  fenced(req({ host: 'evil.example.com' }), r)
  assert.equal(r.statusCode, 403)
  for (const k of Object.keys(r.headers)) {
    assert.ok(!k.startsWith('access-control-'), `拒绝响应不应带 ${k}`)
  }
})
