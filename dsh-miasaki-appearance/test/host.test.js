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

// ---------------------------------------------------------------------------
// P2 Boot Splash（2026-09-26 实施）：注入行序、门控与六种行白名单。
// 设计：design/2026-09-22-appearance-boot-splash-design.md §3；行序依据官方
// renderIndexInjections——head/body 两组各自按 table 顺序，READY_MARKUP 在最后一个 body 行后。
test('P2 注入行序：boot script → boot style → splash style → splash html → splash script', async () => {
  const ctx = fakeCtx()
  host.apply(ctx, {})
  await writeConfig(ctx, { patch: { enabled: true, theme: { skin: 'zafkiel' } } })
  const table = []
  ctx.taps[0].callback(table)
  const kinds = table.map(row => `${row.kind}${row.placement === undefined ? '' : `:${row.placement}`}`)
  assert.deepEqual(kinds, [
    'script:body',      // 既有：门控属性
    'style',            // 既有：boot style（皮肤/壁纸/玻璃防闪色）
    'style',            // 新增：splash 样式（head，官方固定）
    'html:body',        // 新增：splash 容器 DOM
    'script:body',      // 新增：splash 退场生命周期
  ], 'splash 三行必须紧邻 boot style 之后，且都落在官方 READY_MARKUP 之前')
  const splashStyle = table[2]
  assert.match(splashStyle.text, /#mia-splash\{/, 'splash 样式行')
  assert.doesNotMatch(splashStyle.text, /<\/style/, 'style 行不得含 </style')
  const splashHtml = table[3]
  assert.match(splashHtml.html, /id="mia-splash"/, 'splash DOM 行')
  const splashScript = table[4]
  assert.match(splashScript.text, /__miaSplashExit/, '退场脚本行（client 主信号入口）')
  assert.doesNotMatch(splashScript.text, /<\/script/, 'script 行不得含 </script')
  // W4.1：三行都必须落在官方六种行白名单内（html 行是 2026-09-26 首次启用的 kind）
  const ALLOWED = new Set(['global', 'script', 'script-src', 'script-preload', 'style', 'html'])
  for (const row of table) assert.equal(ALLOWED.has(row.kind), true, `非法 kind ${row.kind}`)
})

test('P2 门控：总开关关闭 / bootSplash=off ⇒ splash 三行一行不注入', async () => {
  // 出厂配置（enabled=false）：只有 boot script 一行
  const closed = fakeCtx()
  host.apply(closed, {})
  const closedTable = []
  closed.taps[0].callback(closedTable)
  assert.equal(closedTable.filter(row => row.kind === 'html').length, 0, '关闭时不注入 splash DOM')
  assert.equal(closedTable.filter(row => row.kind === 'style').length, 0, '关闭时不注入任何 style')

  // 开启但 bootSplash=off：boot style 在、splash 三行不在
  const off = fakeCtx()
  host.apply(off, {})
  await writeConfig(off, { patch: { enabled: true, theme: { skin: 'zafkiel' }, motion: { bootSplash: 'off' } } })
  const offTable = []
  off.taps[0].callback(offTable)
  assert.equal(offTable.filter(row => row.kind === 'style').length, 1, 'boot style 仍注入（与 splash 无关）')
  assert.equal(offTable.filter(row => row.kind === 'html').length, 0, 'bootSplash=off 不注入 splash DOM')
  assert.equal(offTable.filter(row => row.kind === 'script').length, 1, '只有 boot script，没有 splash script')
})

// W4.1（2026-09-25）：官方六种行白名单。DSH 前端应用注入行时对未知 kind 是
// `throw new Error("web boot: unknown index injection row")` —— **启动期抛错**，整页起不来，
// 不是静默降级。所以产出侧必须自证"我发的每一行都是官方认识的"。
test('W4.1：注入行 kind 必须落在官方六种行白名单内', () => {
  const ctx = fakeCtx()
  host.apply(ctx, {})
  const table = []
  ctx.taps[0].callback(table)
  assert.equal(table.length >= 1, true, '必须至少注入一条 script 行')

  const ALLOWED = new Set(['global', 'script', 'script-src', 'script-preload', 'style', 'html'])
  for (const row of table) {
    assert.equal(
      ALLOWED.has(row.kind),
      true,
      `非法 kind ${JSON.stringify(row.kind)}——DSH 前端会在启动期抛错（web boot: unknown index injection row）`
    )
  }
  // 官方 renderRow 把 style 行固定为 head；产出侧不应自带 placement 与之冲突
  for (const row of table.filter(r => r.kind === 'style')) {
    assert.equal(
      row.placement === undefined || row.placement === 'head',
      true,
      'style 行的位置由官方固定为 head，产出侧不得指定其他 placement'
    )
  }
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

// ---------------------------------------------------------------------------
// M2.5：软件头像（上传落盘 → 配置启用 → 桌面壳消费）
test('头像路由注册为 prefix 且路径无尾随斜杠', () => {
  const ctx = fakeCtx()
  host.apply(ctx, {})
  const avatar = ctx.routes.find(route => route.path === '/appearance/avatar')
  assert.notEqual(avatar, undefined, '头像文件路由必须注册')
  assert.equal(avatar.kind, 'prefix')
  assert.equal(prefixMatches('/appearance/avatar', '/appearance/avatar/a.png'), true)
  assert.equal(prefixMatches('/appearance/avatar', '/appearance/avatars'), false, '相似前缀不得误吞')
})

/** 一段最小 PNG 载荷（8 字节魔数 + 尾巴）：host 只验魔数，不解码。 */
function pngPayload(tail = 8) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(tail, 3)])
}

/** 调用图片文件路由（无 JSON 体，需读回原始字节）。 */
function callFile(ctx, pathname) {
  const route = ctx.routes.find(r => r.path === '/appearance/avatar')
  return new Promise(resolve => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) { resolve({ status: this.status, headers: this.headers, body }) },
    }
    void route.handler({ url: pathname, method: 'GET', headers: {} }, res)
  })
}

test('头像上传 → 清单 → 文件路由：合法 PNG 全链路可达', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'mia-avatar-'))

  const ctx = fakeCtx()
  host.apply(ctx, { dataDir: dir })
  const bytes = pngPayload(24)
  const up = await callApi(ctx, '/appearance/api/avatar', 'POST', {
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  })
  assert.equal(up.status, 200)
  assert.match(up.body.file, /^avatar-[0-9a-z]+-[0-9a-f]{6}\.png$/, '文件名由 host 生成，不采信客户端')
  assert.equal(up.body.url, `/appearance/avatar/${up.body.file}`)
  assert.deepEqual(up.body.local, [up.body.file], '上传响应顺带回带新清单')
  // 真的落到了 <dataDir>/avatars/，且字节一致
  assert.deepEqual(readFileSync(join(dir, 'avatars', up.body.file)), bytes)

  const list = await callApi(ctx, '/appearance/api/avatars')
  assert.deepEqual(list.body.local, [up.body.file])

  const got = await callFile(ctx, `/appearance/avatar/${up.body.file}`)
  assert.equal(got.status, 200)
  assert.equal(got.headers['content-type'], 'image/png')
  assert.deepEqual(Buffer.from(got.body), bytes)

  // 上传后经 /config 启用：配置里存的是本线头像路由下的白名单路径（跨线契约的一半）
  const enabled = await callApi(ctx, '/appearance/api/config', 'POST', { patch: { avatar: { source: up.body.url } } })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.body.config.avatar.source, up.body.url)
  const state = await callApi(ctx, '/appearance/api/state')
  assert.equal(state.body.config.avatar.source, up.body.url)
})

test('头像上传：非 PNG、伪装 PNG、非法 dataUrl 一律 400 且不落盘', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'mia-avatar-bad-'))

  const ctx = fakeCtx()
  host.apply(ctx, { dataDir: dir })
  const cases = [
    { dataUrl: `data:image/jpeg;base64,${pngPayload().toString('base64')}`, why: 'MIME 不是 PNG' },
    { dataUrl: `data:image/png;base64,${Buffer.from('GIF89a-not-png').toString('base64')}`, why: '伪装成 PNG 的其它内容' },
    { dataUrl: 'data:image/png;base64,!!!!', why: '非法 base64' },
    { dataUrl: '', why: '空数据' },
    { why: '缺字段' },
  ]
  for (const c of cases) {
    const res = await callApi(ctx, '/appearance/api/avatar', 'POST', c.dataUrl === undefined ? {} : { dataUrl: c.dataUrl })
    assert.equal(res.status, 400, `${c.why} 必须 400`)
    assert.equal(typeof res.body.error, 'string')
  }
  assert.equal(existsSync(join(dir, 'avatars')), false, '被拒的上传不得留下目录或文件')
})

test('头像上传：无 dataDir 时 503（不静默假装成功）', async () => {
  const ctx = fakeCtx()
  host.apply(ctx, {})
  const res = await callApi(ctx, '/appearance/api/avatar', 'POST', {
    dataUrl: `data:image/png;base64,${pngPayload().toString('base64')}`,
  })
  assert.equal(res.status, 503)
  assert.match(res.body.error, /dataDir/)
})

test('头像文件路由：穿越、非 PNG 名、缺失文件一律 404', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'mia-avatar-route-'))
  mkdirSync(join(dir, 'avatars'))
  writeFileSync(join(dir, 'avatars', 'ok.png'), pngPayload(4))
  writeFileSync(join(dir, 'config.json'), '{"secret":true}')

  const ctx = fakeCtx()
  host.apply(ctx, { dataDir: dir })
  assert.equal((await callFile(ctx, '/appearance/avatar/ok.png')).status, 200)
  assert.equal((await callFile(ctx, '/appearance/avatar/%2e%2e%2fconfig.json')).status, 404, '编码穿越必须 404')
  assert.equal((await callFile(ctx, '/appearance/avatar/..%2Fconfig.json')).status, 404)
  assert.equal((await callFile(ctx, '/appearance/avatar/config.json')).status, 404, '非 .png 名必须 404')
  assert.equal((await callFile(ctx, '/appearance/avatar/missing.png')).status, 404)
})

// ---------------------------------------------------------------------------
// M2.7：应用图标预设（清单 → 幂等落盘 → 与用户上传同源）
test('预设路由：GET /presets 幂等落盘到 avatars/，且能经头像文件路由取回', async () => {
  const { mkdtempSync, existsSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'mia-presets-'))

  const ctx = fakeCtx()
  host.apply(ctx, { dataDir: dir })
  const res = await callApi(ctx, '/appearance/api/presets')
  assert.equal(res.status, 200)
  assert.equal(res.body.persistent, true)
  assert.equal(res.body.presets.length, 4, '预设共四款：默认 + 三款鲸鱼娘位图')
  assert.deepEqual(res.body.presets.map(p => p.id), ['default', 'portrait', 'illustration', 'current'], '默认款在首位，位图 preset 随后')
  // 每款文件名都必须命中跨线契约的白名单（桌面壳据此在 avatars 目录里找）
  for (const preset of res.body.presets) {
    assert.match(preset.file, /^[\w][\w.-]{0,80}\.png$/, `${preset.file} 必须过白名单`)
    assert.equal(preset.url, `/appearance/avatar/${preset.file}`)
    assert.equal(existsSync(join(dir, 'avatars', preset.file)), true, `${preset.file} 必须真的落盘`)
  }
  // 落盘内容与面板预览同源：文件路由取回的字节 == 磁盘字节
  const defaultFile = join(dir, 'avatars', 'preset-default.png')
  const got = await callFile(ctx, '/appearance/avatar/preset-default.png')
  assert.equal(got.status, 200)
  assert.equal(got.headers['content-type'], 'image/png')
  assert.deepEqual(Buffer.from(got.body), readFileSync(defaultFile))
  // 幂等：重复请求不改写磁盘（渲染是确定性的 + 落地前先比字节）
  const before = readFileSync(defaultFile)
  const again = await callApi(ctx, '/appearance/api/presets')
  assert.equal(again.status, 200)
  assert.deepEqual(readFileSync(defaultFile), before)
  assert.deepEqual(again.body.local, res.body.local, '清单稳定')
  // 位图预设来自插件资源：三款鲸鱼娘（头像 / 立绘 / 现行）都必须落盘
  for (const id of ['portrait', 'illustration', 'current']) {
    const preset = res.body.presets.find(p => p.id === id)
    assert.equal(existsSync(join(dir, 'avatars', preset.file)), true, `${id} 必须落盘`)
  }
})

test('预设路由：无 dataDir 时清单为空但请求不失败（面板给提示而非崩）', async () => {
  const ctx = fakeCtx()
  host.apply(ctx, {})
  const res = await callApi(ctx, '/appearance/api/presets')
  assert.equal(res.status, 200)
  assert.equal(res.body.persistent, false)
  assert.deepEqual(res.body.presets, [], '落不了盘就不谎报可用')
})

// 2026-09-26 回归闸门：写盘失败曾被吞掉却回报 200 + changed:true（用户改动静默回滚、无提示）。
// 这两条钉死修复契约：①失败必须 500 + changed:false + 内存配置/修订号不动；②失败后 writeChain
// 不得变成永久 rejected（否则后续任何写入都卡死 —— 表现为请求永不返回）。
test('POST /config：落盘失败必须如实失败（500 + changed:false，内存配置与修订号不动）', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'mia-config-blocked-'))
  // dataDir 指向一个**普通文件**：store.save 的 mkdir(<该文件>) 以 EEXIST 失败，
  // 这正是「dataDir 在位但写不进去」（权限 / 磁盘 / 路径被占）的最小复现。
  const blocker = join(dir, 'blocked')
  writeFileSync(blocker, 'not-a-directory')

  const ctx = fakeCtx()
  host.apply(ctx, { dataDir: blocker })

  // apply 内的 store.load() 是异步的，且完成时也会把 revision +1（那是「加载」不是「写入」）。
  // 先等它落定，否则 before 取到的修订号还停在加载前的值，比较会假失败。
  await new Promise(resolve => setTimeout(resolve, 25))

  const before = await callApi(ctx, '/appearance/api/state')
  assert.equal(before.status, 200)
  assert.equal(before.body.persistent, true, 'dataDir 非空 ⇒ store 自认可落盘')

  const failed = await writeConfig(ctx, { patch: { enabled: true } })
  assert.equal(failed.status, 500, '写盘失败必须 500，不得谎报成功')
  assert.equal(failed.body.error, 'persist-failed')
  assert.equal(failed.body.changed, false, '不得回报 changed:true')
  assert.match(failed.body.message, /^配置写入失败：/, '必须带回人类可读原因供面板显示')

  const after = await callApi(ctx, '/appearance/api/state')
  assert.deepEqual(after.body.config, before.body.config, '失败的写入不得改动内存配置')
  assert.equal(after.body.revision, before.body.revision, '失败的写入不得推进修订号')

  // 链必须保持可继续：第二次仍然如实失败（而不是永不 resolve / 或转成 200 假成功）。
  const again = await writeConfig(ctx, { patch: { theme: { skin: 'zafkiel' } } })
  assert.equal(again.status, 500, '一次失败不得让后续写入卡死或假成功')
  assert.equal(again.body.changed, false)
})
