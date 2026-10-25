// /canvas/api 浏览器信任围栏（2026-10-19，扫描报告 5b1f6）。
//
// 回归目标：插件路由不经过内核 `/api` 准入链，此前只校验 Host —— 任意网页可用
// 无需预检的 text/plain 表单 POST 打 `POST /canvas/api/reset` 清空画布（CSRF）。
// 本文件同时覆盖纯函数判据与「真实 apply() 注册出来的 handler」两条路径。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, fenceRequest, splitHostPort } from '../index.js'

const LOCAL = new Set(['localhost', '127.0.0.1'])

test('splitHostPort：hostname / 端口拆分（IPv6 保留方括号）', () => {
  assert.deepEqual(splitHostPort('127.0.0.1:3080'), { hostname: '127.0.0.1', port: '3080' })
  assert.deepEqual(splitHostPort('LocalHost'), { hostname: 'localhost', port: null })
  assert.deepEqual(splitHostPort('[::1]:3080'), { hostname: '[::1]', port: '3080' })
  assert.deepEqual(splitHostPort('[::1]'), { hostname: '[::1]', port: null })
  assert.deepEqual(splitHostPort('127.0.0.1:not-a-port'), { hostname: '127.0.0.1', port: null })
  assert.deepEqual(splitHostPort(undefined), { hostname: '', port: null })
})

test('fenceRequest：Host 环回/trusted / 拒跨站 / Origin 同 hostname / 端口判据', () => {
  // 1) Host：环回与 trustedHosts 放行；外部 / 缺失一律 fail closed
  assert.equal(fenceRequest({ host: '127.0.0.1:3080' }, LOCAL).ok, true)
  assert.equal(fenceRequest({ host: 'localhost:3080' }, LOCAL).ok, true)
  assert.equal(fenceRequest({ host: 'evil.example:3080' }, LOCAL).status, 403)
  assert.equal(fenceRequest({}, LOCAL).status, 403, '缺 Host 必须拒绝（不退回 socket 地址）')
  const trusted = new Set([...LOCAL, 'dev.box'])
  assert.equal(fenceRequest({ host: 'dev.box:3080' }, trusted).ok, true)

  // 2) 跨站（浏览器标注）拒绝
  assert.equal(
    fenceRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, LOCAL).error,
    '跨站请求被拒绝',
  )

  // 3) Origin hostname 必须等于 Host（删掉「任意环回别名」豁免）
  assert.equal(
    fenceRequest({ host: '127.0.0.1:3080', origin: 'http://localhost:3080' }, LOCAL).error,
    'Origin 与 Host 不一致',
  )
  // 4) 同站跨端口 = same-site，正是 CSRF 入口 —— 显式端口必须与 Host 端口一致
  assert.equal(
    fenceRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:5173' }, LOCAL).error,
    '跨端口来源被拒绝',
  )
  assert.equal(
    fenceRequest({ host: 'dev.box:3080', origin: 'http://dev.box:5173' }, trusted).error,
    '跨端口来源被拒绝',
  )

  // 5) 同源（同主机同端口）放行；Origin 无端口（Chromium 端口剥离）退回 hostname 判定
  assert.equal(fenceRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, LOCAL).ok, true)
  assert.equal(fenceRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1' }, LOCAL).ok, true)
  assert.equal(fenceRequest({ host: 'dev.box:3080', origin: 'http://dev.box:3080' }, trusted).ok, true)

  // 6) 非法 Origin 拒绝
  assert.equal(fenceRequest({ host: '127.0.0.1:3080', origin: '不是 URL' }, LOCAL).error, 'Origin 无法解析')
})

/** 起一个真实的 apply()：fake ctx 只补插件用到的服务，路由表按 webserver 语义收集。 */
function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'mia-canvas-fence-'))
  const routes = new Map()
  const disposers = []
  const logs = []
  const ctx = {
    logger: { warn: error => logs.push(error), error: error => logs.push(error) },
    on() {},
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    webServer: {
      register(entry) {
        routes.set(entry.path, entry)
        return () => routes.delete(entry.path)
      },
    },
    sessions: { list: () => [], get: async () => undefined },
  }
  apply(ctx, { dataFile: join(dir, 'workspaces.json'), autoProjection: false })

  const call = (method, url, headers) => new Promise(resolve => {
    const route = routes.get('/canvas/api')
    assert.notEqual(route, undefined, '/canvas/api 路由必须注册')
    const res = {
      status: 0,
      writeHead(status) { this.status = status },
      end(chunk) { resolve({ status: this.status, body: chunk === undefined ? null : JSON.parse(String(chunk)) }) },
    }
    const req = {
      method,
      url,
      headers,
      async *[Symbol.asyncIterator]() { /* 这些用例都不需要请求体 */ },
    }
    void route.handler(req, res)
  })

  return {
    call,
    close() {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* 测试 teardown 不掩盖断言失败 */ }
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('/canvas/api：所有路由统一过围栏（正常同源放行 / 不可信 Host / 跨站 / 跨端口拒绝）', async () => {
  const booted = boot()
  try {
    // 正常同源 GET 放行
    const ok = await booted.call('GET', '/canvas/api/workspaces', { host: '127.0.0.1:3080' })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.workspaces, [])

    // 不可信 Host（DNS 重绑定视角）拒绝
    const badHost = await booted.call('GET', '/canvas/api/workspaces', { host: 'evil.example:3080' })
    assert.equal(badHost.status, 403)

    // 跨站表单 POST：回归 5b1f6 —— 修复前这里会 200 并清空画布
    const crossSite = await booted.call('POST', '/canvas/api/reset', {
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.example',
    })
    assert.equal(crossSite.status, 403)

    // 同站跨端口（same-site）同样拒绝
    const crossPort = await booted.call('POST', '/canvas/api/reset', {
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-site',
      origin: 'http://127.0.0.1:5173',
    })
    assert.equal(crossPort.status, 403)

    // 同源请求带 Origin（浏览器对 POST 会带）仍然放行
    const sameOrigin = await booted.call('POST', '/canvas/api/reset', {
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      origin: 'http://127.0.0.1:3080',
    })
    assert.equal(sameOrigin.status, 200)
    assert.equal(sameOrigin.body.cleared, true)
  } finally {
    booted.close()
  }
})
