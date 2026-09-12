// Host half 路由注册契约测试。
//
// 回归闸门（2026-09-12 实机 404）：webserver 的 prefix 匹配是
// `pathname === prefix || pathname.startsWith(prefix + '/')`
// （vendor 源码 packages/host/webserver/src/index.ts）。注册
// `path: '/appearance/api/'`（带尾随斜杠）后，/appearance/api/state 会被拿去和
// '/appearance/api//' 比对而永远失配 —— 服务活着、面板在，API 却全是 404。
// sidebar 线注册 '/sidebar/api'（无尾斜杠）因此正常。本测试把「无尾随斜杠 +
// 在 webserver 匹配语义下可达」钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { join } from 'node:path'
const host = await import('../index.js')

/** webserver 的 prefix 匹配语义（照抄 vendor 源码，勿改）。 */
function prefixMatches(prefix, pathname) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function fakeCtx() {
  const routes = []
  const taps = []
  return {
    routes,
    taps,
    logger: undefined,
    on(event, callback) { taps.push({ event, callback }) },
    effect(callback) { callback() },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
}

test('API 路由注册为 prefix 且路径无尾随斜杠', () => {
  const ctx = fakeCtx()
  host.apply(ctx, {})

  const api = ctx.routes.filter(route => route.kind === 'prefix' && route.path === '/appearance/api')
  assert.equal(api.length, 1, '必须恰好注册一个 API prefix 路由')
  const wallpaper = ctx.routes.find(route => route.path === '/appearance/wallpaper')
  assert.notEqual(wallpaper, undefined, '壁纸文件路由必须注册')
  assert.equal(wallpaper.path.endsWith('/'), false, '壁纸路由前缀同样不得带尾随斜杠')
  assert.equal(api[0].path, '/appearance/api', '前缀不得带尾随斜杠（见文件头说明）')
})

test('注册路径在 webserver 匹配语义下覆盖全部三个端点', () => {
  const ctx = fakeCtx()
  host.apply(ctx, {})
  const prefix = ctx.routes.find(route => route.kind === 'prefix').path

  for (const endpoint of ['/appearance/api/state', '/appearance/api/config', '/appearance/api/contract']) {
    assert.equal(prefixMatches(prefix, endpoint), true, `${endpoint} 必须命中前缀 ${prefix}`)
  }
  assert.equal(prefixMatches(prefix, '/appearance/api/other'), true, '前缀语义下未知端点也应进 handler（由 handler 自己 404）')
  assert.equal(prefixMatches(prefix, '/appearance/apis'), false, '相似前缀不得误吞')
})

test('首帧注入订阅 webserver/index-inject，注入脚本行来自配置', () => {
  const ctx = fakeCtx()
  host.apply(ctx, {})
  assert.equal(ctx.taps.length, 1)
  assert.equal(ctx.taps[0].event, 'webserver/index-inject')

  const table = []
  ctx.taps[0].callback(table)
  assert.equal(table.length >= 1, true, '必须至少注入一条 script 行')
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'body')
})

test('inject 声明 webServer 为硬依赖', () => {
  assert.deepEqual([...host.inject], ['webServer'])
  assert.equal(host.name, 'appearance')
})

/** 调用注册的 API handler 并捕获 JSON 响应（带环回 Host 头以过围栏第一道）。 */
function callApi(ctx, path, method = 'GET', body = null) {
  const route = ctx.routes.find(r => r.kind === 'prefix')
  return new Promise(resolve => {
    const res = {
      writeHead(status) { this.status = status },
      end(payload) { resolve({ status: this.status, body: payload ? JSON.parse(payload) : null }) },
    }
    // readJson 用 for-await 消费请求体；无 body 时给空块（readJson 对空文本回退 {}）。
    const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      url: path,
      method,
      headers: { host: '127.0.0.1:3080' },
      async *[Symbol.asyncIterator]() { yield* chunks },
    }
    void route.handler(req, res)
  })
}

/** 经真实 API 把配置写入 current（无 dataDir 时内存生效），返回写入响应。 */
async function writeConfig(ctx, patch) {
  return callApi(ctx, '/appearance/api/config', 'POST', patch)
}

test('GET /appearance/api/skin：pure 返回空表，zafkiel 返回 105 token 表与 meta', async () => {
  const pure = fakeCtx()
  host.apply(pure, {})
  const pureRes = await callApi(pure, '/appearance/api/skin')
  assert.equal(pureRes.status, 200)
  assert.equal(pureRes.body.id, 'pure')
  assert.equal(pureRes.body.tokens, null)

  const z = fakeCtx()
  host.apply(z, {})
  await writeConfig(z, { patch: { theme: { skin: 'zafkiel' } } })
  const zRes = await callApi(z, '/appearance/api/skin')
  assert.equal(zRes.status, 200)
  assert.equal(zRes.body.id, 'zafkiel')
  assert.equal(zRes.body.meta.preferredScheme, 'dark')
  assert.equal(Object.keys(zRes.body.tokens).length, 105)
})

test('注入行：总开关开 + 非 pure 皮肤时追加 head style 行（双段属性选择器）', async () => {
  const ctx = fakeCtx()
  host.apply(ctx, {})
  // 真实时序：服务挂载时 current 是出厂配置，配置经 API/store 加载后才变化——
  // 这里走真实 POST /config 让 current 更新，再触发注入。
  const written = await writeConfig(ctx, { patch: { enabled: true, theme: { skin: 'zafkiel' } } })
  assert.equal(written.status, 200)
  const table = []
  ctx.taps[0].callback(table)
  const style = table.find(row => row.kind === 'style')
  assert.notEqual(style, undefined, '非 pure 皮肤必须注入 style 行')
  assert.match(style.text, /html\[data-mia-skin="zafkiel"\] body \{/)
  assert.match(style.text, /html\[data-mia-skin="zafkiel"\] body\[data-ds-dark-theme\] \{/)
  assert.match(style.text, /--dsw-static-neutral-bluish-950: #0c0b11;/)
  // 总开关关：style 行不注入（零影响硬契约）
  const off = fakeCtx()
  host.apply(off, {})
  const offTable = []
  off.taps[0].callback(offTable)
  assert.equal(offTable.find(row => row.kind === 'style'), undefined, '总开关关闭时不得注入任何 style')
})


test('本地壁纸路由：白名单文件 200，穿越与非法扩展 404', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'mia-wallpaper-'))
  mkdirSync(join(dir, 'wallpapers'))
  writeFileSync(join(dir, 'wallpapers', 'good.png'), 'png-bytes')

  const ctx = fakeCtx()
  host.apply(ctx, { dataDir: dir })
  const route = ctx.routes.find(r => r.path === '/appearance/wallpaper')

  const call = (pathname) => new Promise(resolve => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) { resolve({ status: this.status, headers: this.headers, body }) },
    }
    void route.handler({ url: pathname, method: 'GET', headers: {} }, res)
  })

  const ok = await call('/appearance/wallpaper/local/good.png')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['content-type'], 'image/png')
  assert.equal(String(ok.body), 'png-bytes')

  assert.equal((await call('/appearance/wallpaper/local/%2e%2e%2fconfig.json')).status, 404, '编码穿越必须 404')
  assert.equal((await call('/appearance/wallpaper/local/good.png%2f%2e%2e%2fsecret')).status, 404)
  assert.equal((await call('/appearance/wallpaper/local/evil.html')).status, 404, '非图片扩展必须 404')
  assert.equal((await call('/appearance/wallpaper/local/missing.png')).status, 404)
  // 清单路由包含本地文件
  const listRes = await callApi(ctx, '/appearance/api/wallpapers')
  assert.deepEqual(listRes.body.local, ['good.png'])
  assert.ok(listRes.body.builtin.includes('aurora'))
})
