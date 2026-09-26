// fleet-monitor.test.mjs — Fleet Monitor 信任围栏单测（2026-09-26 审计 P1.5 收口）
//
// 守什么：本服务是全仓唯一「写接口零鉴权 + CORS 通配 `*`」的组合
// （POST /api/toggle/:agentId 直接落盘 agents/<id>/control.json）。
// 只绑 127.0.0.1 不是鉴权 —— 浏览器可以把任意网页发起的请求送到环回地址。
//
// 测法：不起监听、不 spawn、不碰网络。用假 req/res 驱动真实的 handleRequest，
// 因此可以在受限沙箱里复现（受限沙箱禁的是管道捕获与端口占用，不是纯函数调用）。
//
// 判据三条（与 appearance / ssh / sidebar 同一套 reason 词表）：
//   ① 跨站（Host 非环回 / sec-fetch-site: cross-site / Origin 不匹配）一律 403；
//   ② 403 响应**一个 CORS 头都不带**（页面侧连字段都读不到）；
//   ③ 只有过了围栏才可能进入业务分支（用「不可写 agentId 落到 500 而非 403」反证）。

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import fenceModule from '../fleet-monitor/fence.cjs'
import serverModule from '../fleet-monitor/server.js'

const { stripPort, fenceCheck, buildTrustedHosts, corsHeadersFor } = fenceModule
const { handleRequest, TRUSTED_HOSTS } = serverModule

const LOCAL = buildTrustedHosts([])
const LOOPBACK = { host: '127.0.0.1:39801' }

/** 最小 res 替身：记录 status 与头，便于断言「不带 CORS 头」。 */
function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    ended: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    writeHead(status, extra) {
      this.statusCode = status
      if (extra) for (const [key, value] of Object.entries(extra)) this.headers[key.toLowerCase()] = value
      return this
    },
    end(chunk) { if (chunk !== undefined) this.body = String(chunk); this.ended = true },
  }
}

/**
 * 最小 req 替身：只提供 handleRequest 真正读到的字段。
 * `on` 必须真的驱动 data/end —— readBody() 是一个等 end 事件的 Promise，
 * 空实现的 on 会让写分支永久挂起（首版踩过：用例不失败、只是不结束）。
 */
function fakeReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const handlers = { data: [], end: [] }
  return {
    method,
    url,
    headers,
    on(event, handler) {
      if (handlers[event]) handlers[event].push(handler)
      if (event === 'end') {
        queueMicrotask(() => {
          const chunk = body === '' ? null : Buffer.from(body)
          if (chunk) for (const h of handlers.data) h(chunk)
          for (const h of handlers.end) h()
        })
      }
      return this
    },
  }
}

const call = async (req) => {
  const res = fakeRes()
  await handleRequest(req, res)
  return res
}

/* ---------- ① stripPort / fenceCheck 纯判定 ---------- */

test('stripPort：去端口、小写、容忍 IPv6 字面量', () => {
  assert.equal(stripPort('127.0.0.1:39801'), '127.0.0.1')
  assert.equal(stripPort('LocalHost'), 'localhost')
  assert.equal(stripPort('[::1]:39801'), '[::1]')
  assert.equal(stripPort(''), '')
  assert.equal(stripPort(undefined), '')
})

test('fenceCheck：环回 + 同源放行', () => {
  assert.equal(fenceCheck({ ...LOOPBACK, 'sec-fetch-site': 'same-origin' }, LOCAL).ok, true)
  assert.equal(fenceCheck({ ...LOOPBACK, origin: 'http://127.0.0.1:39801' }, LOCAL).ok, true)
  assert.equal(fenceCheck({ ...LOOPBACK, origin: 'http://localhost:39801' }, LOCAL).ok, true)
})

test('fenceCheck：三道判定各自独立拒绝，reason 可区分', () => {
  assert.equal(fenceCheck({ host: 'evil.example' }, LOCAL).reason, 'untrusted-host')
  assert.equal(fenceCheck({ ...LOOPBACK, 'sec-fetch-site': 'cross-site' }, LOCAL).reason, 'cross-site')
  assert.equal(fenceCheck({ ...LOOPBACK, origin: 'http://evil.example' }, LOCAL).reason, 'untrusted-origin')
  assert.equal(fenceCheck({ ...LOOPBACK, origin: 'not a url' }, LOCAL).reason, 'bad-origin')
  // 缺头一律按不可信处理（宁拒不放）
  assert.equal(fenceCheck({}, LOCAL).reason, 'untrusted-host')
  assert.equal(fenceCheck(undefined, LOCAL).reason, 'untrusted-host')
})

test('fenceCheck：trustedHosts 可显式放行（逃生门）', () => {
  const trusted = buildTrustedHosts([' Dev.Box ', ''])
  assert.equal(fenceCheck({ host: 'dev.box:39801' }, trusted).ok, true)
  assert.equal(fenceCheck({ host: 'other.box' }, trusted).reason, 'untrusted-host')
  // 默认集合恒含本机两台
  assert.equal(TRUSTED_HOSTS.has('localhost'), true)
  assert.equal(TRUSTED_HOSTS.has('127.0.0.1'), true)
})

/* ---------- ② CORS 头不再是通配 ---------- */

test('corsHeadersFor：绝不出现 `*`，且只回显来源', () => {
  const anonymous = corsHeadersFor({})
  assert.equal('Access-Control-Allow-Origin' in anonymous, false)
  assert.equal(anonymous.Vary, 'Origin')

  const sameOrigin = corsHeadersFor({ origin: 'http://127.0.0.1:39801' })
  assert.equal(sameOrigin['Access-Control-Allow-Origin'], 'http://127.0.0.1:39801')
  assert.equal(sameOrigin.Vary, 'Origin')

  for (const value of Object.values(sameOrigin)) assert.notEqual(value, '*')
})

/* ---------- ③ 路由级：围栏排在所有路由之前 ---------- */

test('handler：跨站 Origin 的写请求 403，且响应不带任何 CORS 头', async () => {
  const res = await call(fakeReq({
    method: 'POST',
    url: '/api/toggle/claude',
    headers: { ...LOOPBACK, origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
  }))
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).reason, 'cross-site')
  assert.equal('access-control-allow-origin' in res.headers, false)
  assert.equal('access-control-allow-methods' in res.headers, false)
})

test('handler：Host 非环回一律 403（含静态面板与只读接口）', async () => {
  for (const url of ['/', '/api/fleet', '/api/report?days=7']) {
    const res = await call(fakeReq({ url, headers: { host: 'evil.example' } }))
    assert.equal(res.statusCode, 403, `${url} 必须被拒`)
    assert.equal(JSON.parse(res.body).error, 'forbidden')
  }
})

test('handler：sec-fetch-site: cross-site 一律 403', async () => {
  const res = await call(fakeReq({ url: '/api/fleet', headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' } }))
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).reason, 'cross-site')
})

test('handler：环回同源请求正常放行，并回显 Origin', async () => {
  const origin = 'http://127.0.0.1:39801'
  const res = await call(fakeReq({ url: '/api/fleet', headers: { ...LOOPBACK, origin, 'sec-fetch-site': 'same-origin' } }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['access-control-allow-origin'], origin)
  assert.doesNotThrow(() => JSON.parse(res.body), '面板要拿到的必须是合法 JSON')
})

test('handler：preflight 也走围栏（跨站 OPTIONS 不得 204）', async () => {
  const blocked = await call(fakeReq({ method: 'OPTIONS', url: '/api/toggle/claude', headers: { host: 'evil.example' } }))
  assert.equal(blocked.statusCode, 403)

  const allowed = await call(fakeReq({ method: 'OPTIONS', url: '/api/toggle/claude', headers: { ...LOOPBACK, origin: 'http://127.0.0.1:39801' } }))
  assert.equal(allowed.statusCode, 204)
})

test('handler：过围栏才进业务分支 —— 不可写 agentId 落到 500 而非 403（不创建任何文件）', async () => {
  // 唯一能区分「围栏挡住」与「路由压根没接上」的判据：给一个必然写不进去的 id
  // （父目录不存在），过围栏后应在落盘处 ENOENT → 500。writeFileSync 不建父目录，
  // 因此这个用例不会往 agents/ 里留任何东西。
  const res = await call(fakeReq({
    method: 'POST',
    url: '/api/toggle/__fence_probe_never_exists__',
    headers: { ...LOOPBACK, origin: 'http://127.0.0.1:39801' },
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal(res.statusCode, 500, '过围栏后应到达写盘分支并以 ENOENT 收场')
  assert.equal(JSON.parse(res.body).ok, undefined)
  const probeDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', '__fence_probe_never_exists__')
  assert.equal(existsSync(probeDir), false, '这条用例不得往 agents/ 留下任何目录或文件')
})
