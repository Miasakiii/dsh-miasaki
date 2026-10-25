import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  buildBootScript,
  buildBootStyle,
  buildRuntimeStyle,
  buildTextCss,
  buildWallpaperLayers,
  configEquals,
  evaluateContract,
  isInjectionTextSafe,
  mergeConfig,
  migrateConfig,
  sanitizeConfig,
} from '../lib/config.js'

test('sanitizeConfig：空输入回退出厂配置', () => {
  assert.deepEqual(sanitizeConfig(undefined), sanitizeConfig(DEFAULT_CONFIG))
  assert.deepEqual(sanitizeConfig(null), sanitizeConfig(DEFAULT_CONFIG))
  assert.deepEqual(sanitizeConfig('不是对象'), sanitizeConfig(DEFAULT_CONFIG))
  assert.deepEqual(sanitizeConfig([]), sanitizeConfig(DEFAULT_CONFIG))
})

test('sanitizeConfig：总开关默认关闭（零影响契约的地基）', () => {
  assert.equal(DEFAULT_CONFIG.enabled, false)
  assert.equal(sanitizeConfig({}).enabled, false)
  assert.equal(sanitizeConfig({ enabled: 'true' }).enabled, true)
  assert.equal(sanitizeConfig({ enabled: 1 }).enabled, false, '只认真正的布尔与字符串形式')
})

test('sanitizeConfig：未知字段被丢弃，已知字段被钳制', () => {
  const result = sanitizeConfig({
    version: CONFIG_VERSION,
    enabled: true,
    theme: { skin: '不存在的皮肤', scheme: 'dark', accent: '#AABBCC', fontSize: 99, 注入: 'x' },
    wallpaper: { source: 'https://example.com/a.webp', blur: 999, scrim: -5 },
    motion: { enabled: true, preset: 'elegant', scale: 9 },
    conversation: { density: 'compact', maxWidth: -100 },
    额外字段: { a: 1 },
  })
  assert.equal(result.theme.skin, 'pure', '白名单外的皮肤回退纯净')
  // 2026-09-26 去重：scheme / accent / fontSize 随「明暗与字号归官方通用页」一并移除，
  // 旧配置里的残留必须被丢弃（否则 theme 板块会留下永远无人写的第二状态源）。
  assert.deepEqual(Object.keys(result.theme), ['skin'], 'theme 板块只剩 skin')
  assert.equal(result.wallpaper.blur, 60)
  assert.equal(result.wallpaper.scrim, 0)
  assert.equal(result.motion.scale, 1.5)
  assert.equal(result.conversation.maxWidth, 0)
  assert.equal('额外字段' in result, false)
  assert.equal('注入' in result.theme, false)
})

test('sanitizeConfig：已移除的镜像字段（scheme/accent/fontSize）一律丢弃', () => {
  assert.deepEqual(
    sanitizeConfig({ theme: { accent: 'red', scheme: 'dark', fontSize: 9 } }).theme,
    { skin: 'pure' },
    '明暗/强调色/字号已归官方「通用」设置页，本线配置不再镜像',
  )
  assert.deepEqual(sanitizeConfig({ theme: { accent: '#12' } }).theme, { skin: 'pure' })
  assert.equal(sanitizeConfig({ wallpaper: { source: 'javascript:alert(1)' } }).wallpaper.source, '')
  assert.equal(sanitizeConfig({ wallpaper: { source: '//evil.example.com/x.png' } }).wallpaper.source, '')
  assert.equal(sanitizeConfig({ wallpaper: { source: 'builtin:night-01' } }).wallpaper.source, 'builtin:night-01')
  assert.equal(sanitizeConfig({ wallpaper: { source: '/appearance/wallpapers/a.webp' } }).wallpaper.source, '/appearance/wallpapers/a.webp')
})

// 2026-10-19 安全加固（扫描报告 12a7c）：壁纸图源会进首帧 `<style>` 原始文本，
// `</style>` 能提前闭合元素 ⇒ 存储型 HTML/CSS 注入。修复后：本地路径白名单 +
// http(s) URL 解析 + 标记/控制字符与 `</style` 一律整值拒绝（回落空串 = 无壁纸）。
test('sanitizeConfig：壁纸图源拒绝标记字符 / 控制字符 / </style 载荷（12a7c）', () => {
  const badSources = [
    '/x</style><script>alert(document.cookie)</script>',
    '/appearance/wallpaper/local/a b.png',
    '/appearance/wallpaper/local/a<b.png',
    '/appearance/wallpaper/local/a"b.png',
    'https://example.com/bg.jpg</style><script>x</script>',
    'https://example.com/a.jpg?x=1&y=2',
    "https://example.com/a'b.jpg",
    'https://example.com/a`b.jpg',
    'https://example.com/a.jpg\u0000',
    'https://example.com/a.jpg\nx',
  ]
  for (const bad of badSources) {
    assert.equal(
      sanitizeConfig({ wallpaper: { source: bad } }).wallpaper.source,
      '',
      `${JSON.stringify(bad)} 必须被清空`,
    )
  }
  // 三种合法形态不受影响：内置 id / 客户端 encodeURIComponent 生成的本地路径 / 普通 URL
  for (const good of ['builtin:night-01', '/appearance/wallpaper/local/a%20b.png', 'https://example.com/bg.jpg']) {
    assert.equal(sanitizeConfig({ wallpaper: { source: good } }).wallpaper.source, good)
  }
})

test('buildBootStyle：恶意壁纸图源不产出带 </style 的首帧样式（12a7c 纵深）', () => {
  const payload = '/x</style><script>alert(document.cookie)</script>'
  // sanitize 已把图源清空 ⇒ 首帧 style 为空串；即便未来 sanitize 被绕过，
  // buildBootStyle 的最终兜底也不让 `</style` 出门。
  assert.equal(buildBootStyle({ enabled: true, wallpaper: { source: payload } }, null, {}), '')
  const crafted = {
    enabled: true,
    wallpaper: { source: payload },
    theme: { skin: 'zafkiel' },
  }
  const css = buildBootStyle(crafted, { '--dsw-static-foo': { light: '#fff', dark: '#000' } }, {})
  assert.equal(/<\/style/i.test(css), false, '首帧样式文本不得含 </style')
})

test('isInjectionTextSafe：style/script 行闭合序列判据（12a7c 纵深）', () => {
  assert.equal(isInjectionTextSafe('style', 'body::before { content: none; }'), true)
  assert.equal(isInjectionTextSafe('style', 'body { background: url("/x</style><script>x</script>"); }'), false)
  assert.equal(isInjectionTextSafe('style', 'body { background: url("/x</STYLE>"); }'), false, '不区分大小写')
  assert.equal(isInjectionTextSafe('script', 'document.documentElement.dataset.x = "on"'), true)
  assert.equal(isInjectionTextSafe('script', 'x</script><script>alert(1)</script>'), false)
  assert.equal(isInjectionTextSafe('html', '<div>ok</div>'), true, 'html 行不套此判据（splash 自有约束）')
})

test('migrateConfig：无版本号的旧配置被补上当前版本', () => {
  const migrated = migrateConfig({ enabled: true })
  assert.equal(migrated.version, CONFIG_VERSION)
  assert.equal(migrated.enabled, true, '迁移不得丢弃已有字段')
})

test('mergeConfig：按板块深合并，未提及的字段保持原值', () => {
  const base = sanitizeConfig({
    enabled: true,
    theme: { skin: 'zafkiel' },
    wallpaper: { glass: 'frost', scrim: 30 },
    motion: { preset: 'elegant' },
  })
  const merged = mergeConfig(base, { wallpaper: { scrim: 50 } })
  assert.equal(merged.enabled, true)
  assert.equal(merged.theme.skin, 'zafkiel', '其它板块不被清掉')
  assert.equal(merged.wallpaper.glass, 'frost', '同板块未提及的字段保持原值')
  assert.equal(merged.wallpaper.scrim, 50)
  assert.equal(merged.motion.preset, 'elegant', '其它板块不受影响')
})

test('mergeConfig：非法增量不会污染现有配置', () => {
  const base = sanitizeConfig({ enabled: true, theme: { skin: 'zafkiel' } })
  const merged = mergeConfig(base, { theme: { skin: 'oops', accent: 'not-a-color', scheme: 'dark' } })
  assert.equal(merged.theme.skin, 'pure')
  assert.equal('accent' in merged.theme, false, '已移除字段不得借合并回到配置里')
  assert.equal(merged.enabled, true)
})

test('configEquals：忽略键序与非法输入差异', () => {
  assert.equal(configEquals({ enabled: true }, { enabled: true }), true)
  assert.equal(configEquals({ enabled: true }, { enabled: false }), false)
  assert.equal(configEquals(undefined, DEFAULT_CONFIG), true)
})

test('buildBootScript：写入门控属性且随开关翻转', () => {
  const off = buildBootScript(DEFAULT_CONFIG)
  assert.match(off, /data-mia-appearance/)
  assert.match(off, /"off"/)
  const on = buildBootScript({ enabled: true, theme: { skin: 'zafkiel' } })
  assert.match(on, /"on"/)
  assert.match(on, /"zafkiel"/)
  assert.match(on, /try \{/, '首帧脚本必须自带异常兜底')
  // 2026-09-26 去重：明暗偏好由官方 presenter 驱动（body[data-ds-dark-theme]），
  // 首帧脚本不再写 data-mia-scheme 镜像属性。
  assert.doesNotMatch(on, /data-mia-scheme/, 'scheme 镜像属性已移除')
})

test('buildBootScript：皮肤取值经 JSON 转义，无法逃逸出字符串', () => {
  const script = buildBootScript({ enabled: true, theme: { skin: '"></script><script>alert(1)</script>' } })
  assert.equal(script.includes('</script>'), false, '非法皮肤名先被白名单回退，原文不得出现')
  assert.match(script, /"pure"/)
})

test('buildBootStyle：M1 恒为空（纯净皮肤不注入样式行）', () => {
  assert.equal(buildBootStyle(DEFAULT_CONFIG), '')
  assert.equal(buildBootStyle({ enabled: true, theme: { skin: 'zafkiel' } }), '', 'M2 下沉色阶前不产出样式')
})

/** 一份「全部就绪」的探针，用于逐项打破。 */
function readyProbe() {
  return {
    services: { theme: true, slots: true },
    themeMethods: { getTheme: true, setTheme: true, setFontSize: true, overrideTokens: true },
    anchors: { main: true },
    tokens: { aliasBgBase: true, staticDeepseek500: true },
    desktopTheme: false,
  }
}

test('evaluateContract：全部就绪时无问题', () => {
  const verdict = evaluateContract(readyProbe())
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.issues, [])
})

test('evaluateContract：缺主题服务或方法时报 error', () => {
  const missingService = evaluateContract({ ...readyProbe(), services: { theme: false, slots: true } })
  assert.equal(missingService.ok, false)
  assert.equal(missingService.issues[0].code, 'theme-service-missing')
  assert.equal(missingService.issues[0].level, 'error')

  const probe = readyProbe()
  probe.themeMethods.setFontSize = false
  const missingMethod = evaluateContract(probe)
  assert.equal(missingMethod.ok, false)
  assert.ok(missingMethod.issues.some(issue => issue.code === 'theme-method-missing:setFontSize'))
})

test('evaluateContract：缺锚点与 token 是 warn（降级但不报错）', () => {
  const probe = readyProbe()
  probe.anchors.main = false
  probe.tokens.aliasBgBase = false
  const verdict = evaluateContract(probe)
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.issues.map(issue => issue.level), ['warn', 'warn'])
  assert.deepEqual(verdict.issues.map(issue => issue.code), ['anchor-main-missing', 'token-alias-missing'])
})

test('evaluateContract：桌面壳主题在位时给出让位提示', () => {
  const verdict = evaluateContract({ ...readyProbe(), desktopTheme: true })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.issues.length, 1)
  assert.equal(verdict.issues[0].code, 'desktop-theme-active')
})

test('evaluateContract：探针缺失时不抛异常（只当作全缺）', () => {
  const verdict = evaluateContract(undefined)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.issues.length > 0)
})

// ---------------------------------------------------------------------------
// M2 S4：buildBootStyle（皮肤首帧防闪色）与 skin-token-miss 契约
const bbs = buildBootStyle
const { buildSurfaceTokens } = await import('../lib/config.js')

test('buildBootStyle：pure / 关闭 / 无表 → 空串（零影响硬契约）', () => {
  const tokens = { '--dsw-static-neutral-bluish-950': { light: '#0c0b11', dark: '#0c0b11' } }
  assert.equal(bbs({ enabled: true, theme: { skin: 'pure' } }, tokens), '')
  assert.equal(bbs({ enabled: false, theme: { skin: 'zafkiel' } }, tokens), '')
  assert.equal(bbs({ enabled: true, theme: { skin: 'zafkiel' } }, null), '')
})

test('buildBootStyle：非 pure 产出双段属性选择器 CSS，值来自 token 表', () => {
  const tokens = {
    '--dsw-static-neutral-bluish-950': { light: '#0c0b11', dark: '#0c0b11' },
    '--dsw-alias-bg-base': { light: 'rgba(12, 11, 17, .8)', dark: 'rgba(12, 11, 17, .8)' },
  }
  const css = bbs({ enabled: true, theme: { skin: 'zafkiel' } }, tokens)
  assert.match(css, /html\[data-mia-skin="zafkiel"\] body \{\n {2}--dsw-alias-bg-base: rgba\(12, 11, 17, \.8\);\n {2}--dsw-static-neutral-bluish-950: #0c0b11;\n\}/)
  assert.match(css, /html\[data-mia-skin="zafkiel"\] body\[data-ds-dark-theme\] \{[\s\S]+#0c0b11/)
  // 键按字典序稳定输出（可复算纪律）
  assert.ok(css.indexOf('--dsw-alias-bg-base') < css.indexOf('--dsw-static-neutral-bluish-950'))
})

test('evaluateContract：skinSpot 全符 → 不告警；任一不符 → skin-token-miss 黄条', () => {
  const ok = evaluateContract({
    services: { theme: true, slots: true },
    themeMethods: { getTheme: true, setTheme: true, setFontSize: true, overrideTokens: true },
    anchors: { main: true },
    tokens: { aliasBgBase: true, staticDeepseek500: true },
    skinSpot: [{ name: '--dsw-static-neutral-bluish-950', expected: '#0c0b11', actual: '#0c0b11' }],
  })
  assert.equal(ok.ok, true)
  const miss = evaluateContract({
    services: { theme: true, slots: true },
    themeMethods: { getTheme: true, setTheme: true, setFontSize: true, overrideTokens: true },
    anchors: { main: true },
    tokens: { aliasBgBase: true, staticDeepseek500: true },
    skinSpot: [{ name: '--dsw-alias-bg-base', expected: 'rgba(12, 11, 17, .8)', actual: '#151517' }],
  })
  assert.equal(miss.ok, false)
  assert.equal(miss.issues.some(i => i.code === 'skin-token-miss'), true)
})

// ---------------------------------------------------------------------------
// M2 S5：壁纸层与玻璃档位
test('sanitizeConfig：v2 壁纸字段收窄（非法回退默认，surface 逐旋钮钳制）', () => {
  const safe = sanitizeConfig({
    version: 2,
    wallpaper: {
      source: 'builtin:dusk', fit: 'stretch', focus: 'nowhere', glass: 'plasma',
      scrim: 500, vignette: -3,
      surface: { sidebar: 250, conversation: -5, composer: 'x', overlay: 50 },
    },
  })
  assert.equal(safe.wallpaper.source, 'builtin:dusk')
  assert.equal(safe.wallpaper.fit, 'cover')
  assert.equal(safe.wallpaper.focus, 'center')
  assert.equal(safe.wallpaper.glass, 'off')
  assert.equal(safe.wallpaper.scrim, 100)
  assert.equal(safe.wallpaper.vignette, 0)
  assert.deepEqual(safe.wallpaper.surface, { sidebar: 100, conversation: 0, composer: 100, overlay: 50 })
})

test('migrateConfig：旧版本抬到当前版本（新增字段由 sanitize 补默认）', () => {
  const migrated = migrateConfig({ version: 1, enabled: true, theme: { skin: 'zafkiel' } })
  assert.equal(migrated.version, CONFIG_VERSION)
  const safe = sanitizeConfig(migrated)
  assert.equal(safe.enabled, true)
  assert.equal(safe.theme.skin, 'zafkiel')
  assert.deepEqual(safe.wallpaper.surface, { sidebar: 100, conversation: 100, composer: 100, overlay: 100 })
  // M2.5：v2 配置升到 v3 后 avatar 补成「未设置」，桌面壳继续用出厂图标。
  assert.deepEqual(safe.avatar, { source: '' })
  // P2：旧配置升到 v5 后 bootSplash 补默认 'auto'（首帧启动画，纯新增字段）。
  assert.equal(safe.motion.bootSplash, 'auto')
})

test('migrateConfig：v3 配置升到 v4 时丢弃 scheme/accent/fontSize 死字段', () => {
  // 2026-09-26 去重：这三个字段是「外观页给官方偏好做第二入口」时代的镜像，
  // 迁移不需要搬运——sanitize 直接丢弃，下次写入即落盘清净。
  const safe = sanitizeConfig({ version: 3, theme: { skin: 'zafkiel', scheme: 'dark', accent: '#fff', fontSize: 16 } })
  assert.equal(safe.version, CONFIG_VERSION)
  assert.deepEqual(safe.theme, { skin: 'zafkiel' }, '死字段不得在迁移后存活')
})

test('buildSurfaceTokens：全部 100 → null；降了的部分映射正确端点（dark 用深端、light 用浅端）', () => {
  assert.equal(buildSurfaceTokens({ enabled: true, wallpaper: { source: 'builtin:aurora' } }), null)
  const tokens = buildSurfaceTokens({
    enabled: true,
    wallpaper: { source: 'builtin:aurora', surface: { sidebar: 80, conversation: 60, composer: 100, overlay: 100 } },
  })
  assert.equal(Object.keys(tokens).length, 4)
  assert.equal(tokens['--dsw-specific-sidebar-fill'].dark, 'color-mix(in srgb, var(--dsw-static-neutral-bluish-950) 80%, transparent)')
  assert.equal(tokens['--dsw-specific-sidebar-fill'].light, 'color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 80%, transparent)')
  assert.equal(tokens['--dsw-alias-bg-layer-2'].light, 'color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 60%, transparent)')
  assert.equal('composer' in {}, false)
  assert.equal(tokens['--dsw-alias-bg-module-platform'], undefined, 'composer=100 不输出')
})

test('buildBootStyle：壁纸伪元素多重背景（scrim → vignette → 图）与铺排', () => {
  const css = buildBootStyle(
    { enabled: true, wallpaper: { source: 'builtin:ember', scrim: 30, vignette: 40, fit: 'contain', focus: 'top' } },
    null,
    { ember: 'linear-gradient(145deg, #14100e, #d9b36a)' },
  )
  assert.match(css, /body::before \{/)
  assert.match(css, /z-index: -1/)
  assert.match(css, /linear-gradient\(rgba\(0, 0, 0, 0\.30\)[\s\S]+radial-gradient[\s\S]+linear-gradient\(145deg, #14100e, #d9b36a\)/)
  assert.match(css, /background-size: contain; background-position: top; background-repeat: no-repeat/)
  // tile 铺排
  const tile = buildBootStyle({ enabled: true, wallpaper: { source: 'builtin:ember', fit: 'tile' } }, null, { ember: 'x' })
  assert.match(tile, /background-size: auto; background-position: center; background-repeat: repeat/)
  // 关总开关 → 全空
  assert.equal(buildBootStyle({ wallpaper: { source: 'builtin:ember' } }, null, { ember: 'x' }), '')
})

test('buildBootStyle：玻璃档位产出三条 slot 实盒子规则；off 不产出', () => {
  const css = buildBootStyle({ enabled: true, wallpaper: { glass: 'frost' } }, null, {})
  assert.match(css, /html\[data-mia-glass="frost"\] \[data-slot="sidebar"\] > \*/)
  assert.match(css, /html\[data-mia-glass="frost"\] \[data-slot="main\.conversation"\] > \*/)
  assert.match(css, /backdrop-filter: blur\(20px\) saturate\(1\.4\)/)
  assert.equal(buildBootStyle({ enabled: true, wallpaper: { glass: 'off' } }, null, {}), '')
})

// 2026-10-18：运行期样式（client 半自维护的样式标签）。boot style 只在**页面加载时**
// 注入一次，用户随后在面板里改图源 / 玻璃 / 遮罩 / 晕影不会重算 ⇒ 「设置了没反应」。
// 本函数产出同一套规则的当前值，由 client 在加载后与每次保存后重写。
test('buildRuntimeStyle：壁纸启用时给壁纸段，停用时给中和规则', () => {
  // ① 壁纸启用 ⇒ 与 boot style 的壁纸段逐字同源（多重背景 + 铺排）
  const live = buildRuntimeStyle(
    { enabled: true, wallpaper: { source: 'builtin:ember', scrim: 30, vignette: 40, fit: 'contain', focus: 'top' } },
    { ember: 'linear-gradient(145deg, #14100e, #d9b36a)' },
  )
  assert.match(live, /body::before \{/)
  assert.match(live, /background-image: linear-gradient\(rgba\(0, 0, 0, 0\.30\)[\s\S]+radial-gradient[\s\S]+linear-gradient\(145deg, #14100e, #d9b36a\)/)
  assert.match(live, /background-size: contain; background-position: top; background-repeat: no-repeat/)
  // ② 壁纸停用但总开关开着 ⇒ **必须**给中和规则：boot style 是加载时那份，
  //    本次会话里关掉壁纸后，首帧那条 body::before 还在 head 里，不中和就是「关了还在」。
  const neutral = buildRuntimeStyle({ enabled: true, wallpaper: { source: '' } }, {})
  assert.equal(neutral, 'body::before { content: none; }')
  // ③ 总开关关闭 ⇒ 空串（client 移除整层；boot style 同样不注入）
  assert.equal(buildRuntimeStyle({ enabled: false, wallpaper: { source: 'builtin:ember' } }, { ember: 'x' }), '')
  // ④ 玻璃段随档位产出（与 boot style 同一生成逻辑）
  const glass = buildRuntimeStyle({ enabled: true, wallpaper: { glass: 'frost' } }, {})
  assert.match(glass, /html\[data-mia-glass="frost"\] \[data-slot="rightbar"\] > \*/)
  // ⑤ 玻璃 off ⇒ 只有壁纸段/中和规则，不掺玻璃规则
  assert.doesNotMatch(buildRuntimeStyle({ enabled: true, wallpaper: { glass: 'off' } }, {}), /data-mia-glass/)
})

test('buildWallpaperLayers：与 body::before 的 background-image 同源同序（预览即真相）', () => {
  const layers = buildWallpaperLayers(
    { enabled: true, wallpaper: { source: 'builtin:ember', scrim: 20, vignette: 10 } },
    { ember: 'linear-gradient(145deg, #14100e, #d9b36a)' },
  )
  assert.equal(
    layers,
    'linear-gradient(rgba(0, 0, 0, 0.20), rgba(0, 0, 0, 0.20)), '
    + 'radial-gradient(ellipse at center, rgba(0, 0, 0, 0) 55%, rgba(0, 0, 0, 0.10) 100%), '
    + 'linear-gradient(145deg, #14100e, #d9b36a)',
  )
  // 无任何层（无壁纸、无遮罩、无晕影）⇒ 空串（面板预览卡走空态）
  assert.equal(buildWallpaperLayers({ enabled: true, wallpaper: { source: '', scrim: 0, vignette: 0 } }, {}), '')
  // 本地图源走 url()；2026-10-19（12a7c）起本地路径只收 URL 安全字符 ——
  // 面板/客户端本来就用 encodeURIComponent 生成（空格 ⇒ %20），故合法路径不受影响。
  assert.match(
    buildWallpaperLayers({ enabled: true, wallpaper: { source: '/appearance/wallpaper/local/a%20b.png' } }, {}),
    /url\("\/appearance\/wallpaper\/local\/a%20b\.png"\)/,
  )
  // 未编码的空格 / 标记字符不再放行（sanitize 清空 ⇒ 无壁纸层）
  assert.equal(buildWallpaperLayers({ enabled: true, wallpaper: { source: '/appearance/wallpaper/local/a b.png' } }, {}), '')
  assert.equal(buildWallpaperLayers({ enabled: true, wallpaper: { source: '/appearance/wallpaper/local/a"b.png' } }, {}), '')
})

test('buildBootScript：glass 属性随配置写入、关闭时恒 off', () => {
  const on = buildBootScript({ enabled: true, wallpaper: { glass: 'frost' } })
  assert.match(on, /data-mia-glass', "frost"/)
  const closed = buildBootScript({ enabled: false, wallpaper: { glass: 'frost' } })
  assert.match(closed, /data-mia-glass', "off"/)
  assert.notEqual(on, closed)
})

// W4.2（2026-09-25）材质分层：`mica` 档 = 「用系统云母」，原生生效时必须撤掉页面侧模糊，
// 否则 Chromium 的 backdrop-filter 与 DWM 材质叠成两层；`light`/`frost` 是页面自己玻璃的
// 独立档位，与原生叠加属用户选择，**不得**被这条规则波及。
test('W4.2：mica 档挂在「原生未生效」条件上，light/frost 不受影响', () => {
  const mica = buildBootStyle({ enabled: true, wallpaper: { glass: 'mica' } }, null, {})
  assert.match(
    mica,
    /html\[data-mia-glass="mica"\]:not\(\[data-mia-native-mica="on"\]\) \[data-slot="sidebar"\] > \*/,
    'mica 档必须带 :not([data-mia-native-mica="on"]) 条件'
  )
  assert.match(mica, /backdrop-filter: blur\(40px\) saturate\(1\.6\)/)

  const frost = buildBootStyle({ enabled: true, wallpaper: { glass: 'frost' } }, null, {})
  assert.doesNotMatch(
    frost,
    /data-mia-native-mica/,
    'light/frost 是页面侧档位，不得掺入原生材质条件'
  )
  const light = buildBootStyle({ enabled: true, wallpaper: { glass: 'light' } }, null, {})
  assert.doesNotMatch(light, /data-mia-native-mica/)
})

test('evaluateContract：glass 非 off 且锚点全未命中 → glass-anchor-miss', () => {
  const base = {
    services: { theme: true, slots: true },
    themeMethods: { getTheme: true, setTheme: true, setFontSize: true, overrideTokens: true },
    anchors: { main: true },
    tokens: { aliasBgBase: true, staticDeepseek500: true },
    glass: 'frost',
    glassAnchors: { sidebar: false, mainConversation: false, rightbar: false },
  }
  const miss = evaluateContract(base)
  assert.equal(miss.issues.some(i => i.code === 'glass-anchor-miss'), true)
  const hit = evaluateContract({ ...base, glassAnchors: { sidebar: true, mainConversation: true, rightbar: false } })
  assert.equal(hit.issues.some(i => i.code === 'glass-anchor-miss'), false)
})

// ---------------------------------------------------------------------------
// M2.5：软件头像（外观设置 → 桌面壳图标）
test('sanitizeConfig：avatar.source 只接受本线头像路由下的白名单文件', () => {
  const keep = '/appearance/avatar/avatar-lz3k9q-4f2a1b.png'
  assert.equal(sanitizeConfig({ avatar: { source: keep } }).avatar.source, keep)
  // 桌面壳只读本地目录：外链、其它路由、非 PNG、穿越路径一律清空
  for (const bad of [
    'https://example.com/a.png',
    '/appearance/wallpaper/local/a.png',
    '/appearance/avatar/a.jpg',
    '/appearance/avatar/../config.json',
    '/appearance/avatar/%2e%2e%2fconfig.json',
    '/appearance/avatar/sub/a.png',
    'javascript:alert(1)',
  ]) {
    assert.equal(sanitizeConfig({ avatar: { source: bad } }).avatar.source, '', `${bad} 必须被清空`)
  }
  // 缺失／类型错误同样回退出厂值
  assert.deepEqual(sanitizeConfig({}).avatar, { source: '' })
  assert.deepEqual(sanitizeConfig({ avatar: 'not-an-object' }).avatar, { source: '' })
})

test('mergeConfig：头像单字段可独立更新，不被同板块或其它板块影响', () => {
  const base = sanitizeConfig({ enabled: true, avatar: { source: '/appearance/avatar/a-1.png' } })
  assert.equal(mergeConfig(base, { avatar: { source: '/appearance/avatar/b-2.png' } }).avatar.source, '/appearance/avatar/b-2.png')
  assert.equal(mergeConfig(base, { wallpaper: { scrim: 50 } }).avatar.source, '/appearance/avatar/a-1.png', '改别的板块不动头像')
  assert.equal(mergeConfig(base, { avatar: { source: '' } }).avatar.source, '', '清空是合法操作')
  assert.equal(mergeConfig(base, { avatar: { source: 'https://evil/x.png' } }).avatar.source, '', '非法值不得写进配置')
})

test('configEquals：头像变化被识别为实质变更（面板据此写盘）', () => {
  const a = sanitizeConfig({ avatar: { source: '/appearance/avatar/a-1.png' } })
  const b = sanitizeConfig({ avatar: { source: '/appearance/avatar/b-2.png' } })
  assert.equal(configEquals(a, b), false)
  assert.equal(configEquals(a, sanitizeConfig(a)), true)
})

test('evaluateContract：host 半不认识 avatar 字段时给重启提示（旧 client 不误报）', () => {
  const base = {
    services: { theme: true, slots: true },
    themeMethods: { getTheme: true, setTheme: true, setFontSize: true, overrideTokens: true },
    anchors: { main: true },
    tokens: { aliasBgBase: true, staticDeepseek500: true },
  }
  const stale = evaluateContract({ ...base, avatarField: false })
  assert.equal(stale.issues.some(i => i.code === 'avatar-host-stale'), true)
  assert.equal(stale.issues.find(i => i.code === 'avatar-host-stale').level, 'warn')
  // 探针明确报 true（host 已更新）或干脆没报（旧 client）都不判定 —— 只有确知 false 才提示
  assert.equal(evaluateContract({ ...base, avatarField: true }).issues.some(i => i.code === 'avatar-host-stale'), false)
  assert.equal(evaluateContract(base).issues.some(i => i.code === 'avatar-host-stale'), false)
})

test('sanitizeConfig：M4 会话效果三字段白名单收窄（v6；首档 = 不注入规则）', () => {
  // M4：conversation 新增 font / cursor / quoteCode。首档 system/off/default 是
  // 「原生档」——client 半据此不写任何 html 属性与变量；非法值一律回退首档。
  const safe = sanitizeConfig({
    conversation: { density: 'compact', maxWidth: 1080, font: 'serif', cursor: 'block', quoteCode: 'strong' },
  })
  assert.deepEqual(safe.conversation, {
    density: 'compact', maxWidth: 1080, font: 'serif', cursor: 'block', quoteCode: 'strong',
  })
  const narrowed = sanitizeConfig({
    conversation: { density: 'x', maxWidth: 99999, font: 'comic-sans', cursor: 'spinner', quoteCode: 'rainbow', 注入: 1 },
  })
  assert.deepEqual(narrowed.conversation, {
    // maxWidth 上钳 1600（MAX_WIDTH_MAX），其余回退首档
    density: 'comfortable', maxWidth: 1600, font: 'system', cursor: 'off', quoteCode: 'default',
  })
  assert.equal('注入' in narrowed.conversation, false)
  // 非数字 maxWidth（面板未加载时的 undefined / 字符串）回退 0 = 官方默认
  assert.equal(sanitizeConfig({ conversation: { maxWidth: undefined } }).conversation.maxWidth, 0)
  assert.equal(sanitizeConfig({ conversation: { maxWidth: '920' } }).conversation.maxWidth, 920)
  assert.equal(sanitizeConfig({ conversation: { maxWidth: -5 } }).conversation.maxWidth, 0)
  // 出厂配置 = 全首档（「未配置的外观线对页面零影响」）
  assert.deepEqual(sanitizeConfig(DEFAULT_CONFIG).conversation, {
    density: 'comfortable', maxWidth: 0, font: 'system', cursor: 'off', quoteCode: 'default',
  })
})

test('migrateConfig：v5 配置升到当前版本时 M4/M4+ 新字段补默认（纯新增、无搬运）', () => {
  // v5 的 conversation 只有 density/maxWidth（M3 前的预留字段）；v5→v6 加
  // font/cursor/quoteCode——sanitize 对缺失字段回退首档即可，无迁移代码。
  const safe = sanitizeConfig({
    version: 5,
    conversation: { density: 'compact', maxWidth: 720 },
  })
  assert.equal(safe.version, CONFIG_VERSION)
  assert.deepEqual(safe.conversation, {
    density: 'compact', maxWidth: 720, font: 'system', cursor: 'off', quoteCode: 'default',
  }, '旧配置保留 density/maxWidth，新字段补首档')
  assert.equal(migrateConfig({ version: 5 }).version, CONFIG_VERSION)
  // 迁移必须**逐级抬到当前版本**（不能停在中间版本，否则后续 sanitize 的补齐判据会错位）
  assert.equal(migrateConfig({ version: 6 }).version, CONFIG_VERSION, 'v6 也必须升到当前版本')
  // 当前版本与更高版本原样返回（幂等 / 未来版本不降级）
  assert.equal(migrateConfig({ version: CONFIG_VERSION }).version, CONFIG_VERSION)
  assert.equal(migrateConfig({ version: 99 }).version, 99)
})

test('v6 → v7：新增 boot 板块（启动片头），旧配置补出厂档 brand + 静音', () => {
  const safe = sanitizeConfig({ version: 6, enabled: true, theme: { skin: 'zafkiel' } })
  assert.equal(safe.version, CONFIG_VERSION)
  assert.deepEqual(safe.boot, { intro: 'brand', audio: false }, 'v6 旧配置补 boot 出厂档')
  // boot 板块自守：非法枚举收窄回出厂档、非布尔音轨收窄为关
  assert.equal(sanitizeConfig({ boot: { intro: 'nope' } }).boot.intro, 'brand')
  assert.equal(sanitizeConfig({ boot: { intro: 'off' } }).boot.intro, 'off', '「关闭」是合法枚举')
  assert.equal(sanitizeConfig({ boot: { audio: 'yes' } }).boot.audio, false, '非布尔音轨 ⇒ 静音')
  assert.deepEqual(sanitizeConfig({}).boot, { intro: 'brand', audio: false }, '出厂默认')
  // 单字段更新不冲刷同板块另一字段（面板每次只发改动那一格）
  const merged = mergeConfig(sanitizeConfig({ boot: { intro: 'cyberpunk', audio: true } }), { boot: { audio: false } })
  assert.deepEqual(merged.boot, { intro: 'cyberpunk', audio: false })
})

test('mergeConfig：会话效果单字段可独立更新，不被同板块或其它板块影响', () => {
  // 面板每次只发改动的那一格（选择丸/步进器），深合并必须保住同板块其它字段。
  const current = sanitizeConfig({
    conversation: { density: 'compact', maxWidth: 1080, font: 'serif', cursor: 'block', quoteCode: 'strong' },
  })
  const next = mergeConfig(current, { conversation: { cursor: 'underline' } })
  assert.deepEqual(next.conversation, {
    density: 'compact', maxWidth: 1080, font: 'serif', cursor: 'underline', quoteCode: 'strong',
  })
  // 只碰别的板块时 conversation 原样保留
  assert.deepEqual(mergeConfig(current, { motion: { enabled: true } }).conversation, current.conversation)
})

// --------------------------------------------------------------- M5 文字板块（v8）
test('sanitizeConfig：M5 文字板块白名单收窄（v8；字重只认整百、metric 钳制且留小数）', () => {
  const text = sanitizeConfig({
    text: {
      uiWeight: '450', headingWeight: 'abc',
      letterSpacing: 999, lineHeight: -5, paragraphSpacing: 'abc', firstLineIndent: 99,
    },
  }).text
  assert.equal(text.uiWeight, '', '非整百字重回退不覆盖')
  assert.equal(text.headingWeight, '', '非数字串回退不覆盖')
  assert.equal(text.letterSpacing, 3, '字距钳制到上限')
  assert.equal(text.lineHeight, 0, '负值钳到 0（= 不覆盖）')
  assert.equal(text.paragraphSpacing, 0, '非有限数回退 0')
  assert.equal(text.firstLineIndent, 4, '缩进钳制到上限')
  // 步进器 step 产生的小数必须原样保留（clampNumber，不是 clampInt）
  const fine = sanitizeConfig({ text: { letterSpacing: 0.1, firstLineIndent: 1.5 } }).text
  assert.equal(fine.letterSpacing, 0.1)
  assert.equal(fine.firstLineIndent, 1.5)
  // 合法档位原样通过
  const ok = sanitizeConfig({ text: { uiWeight: '500', headingWeight: '700' } }).text
  assert.equal(ok.uiWeight, '500')
  assert.equal(ok.headingWeight, '700')
  // 缺板块（旧配置）⇒ 全原生档
  assert.deepEqual(sanitizeConfig({ version: 7 }).text, DEFAULT_CONFIG.text)
})

test('migrateConfig：v7 配置升到 v8 时 text 板块补原生档（纯新增、零行为变化）', () => {
  const legacy = migrateConfig({ version: 7, enabled: true, theme: { skin: 'zafkiel' } })
  assert.equal(legacy.version, CONFIG_VERSION)
  const safe = sanitizeConfig(legacy)
  assert.deepEqual(safe.text, DEFAULT_CONFIG.text, '旧配置补齐的必须是全原生档（不覆盖任何规则）')
  assert.equal(buildTextCss(safe), '', '升级后文字层零规则')
})

test('buildTextCss：总开关关闭或全原生档 ⇒ 空串（关掉即原生）', () => {
  assert.equal(buildTextCss(sanitizeConfig({ enabled: false, text: { uiWeight: '700' } })), '')
  assert.equal(buildTextCss(sanitizeConfig({ enabled: true })), '')
  assert.equal(buildTextCss(sanitizeConfig({ enabled: true, text: { uiWeight: '', headingWeight: '', letterSpacing: 0, lineHeight: 0, paragraphSpacing: 0, firstLineIndent: 0 } })), '')
})

test('buildTextCss：各单项规则与层叠语义（字重两条 + 标题回退 + 四 metric 的 calc 叠加）', () => {
  const cssOf = text => buildTextCss(sanitizeConfig({ enabled: true, text }))
  // 界面字重：body 低特异性（只影响继承文本）+ Markdown 段落 !important（font 简写连带字重）
  const ui = cssOf({ uiWeight: '500' })
  assert.match(ui, /body \{ font-weight: 500; \}/, '界面字重挂 body（低特异性）')
  assert.match(ui, /\[class\*="_markdown"\] p, \[class\*="_markdown"\] li, \[class\*="_markdown"\] blockquote, \[class\*="_markdown"\] td \{ font-weight: 500 !important; \}/)
  // 标题留空 = 跟随界面字重（h1–h6 规则用同一个值）
  assert.match(ui, /h1, \[class\*="_markdown"\] h2.*font-weight: 500 !important/, '标题留空跟随界面字重')
  // 只设标题字重（界面留空）⇒ 不出 body 规则，只出标题规则
  const headingOnly = cssOf({ headingWeight: '700' })
  assert.doesNotMatch(headingOnly, /body \{ font-weight/, '界面字重留空 = 不覆盖')
  assert.match(headingOnly, /h6 \{ font-weight: 700 !important; \}/)
  const both = cssOf({ uiWeight: '400', headingWeight: '800' })
  assert.match(both, /body \{ font-weight: 400; \}/)
  assert.match(both, /h1, \[class\*="_markdown"\] h2, \[class\*="_markdown"\] h3, \[class\*="_markdown"\] h4, \[class\*="_markdown"\] h5, \[class\*="_markdown"\] h6 \{ font-weight: 800 !important; \}/)
  assert.doesNotMatch(both, /h6 \{ font-weight: 400/, '标题不得被界面字重压平')
  // 排版四项：0 值不进规则（段距 0 会压掉官方 margin-block）
  assert.doesNotMatch(cssOf({ paragraphSpacing: 0 }), /margin-block/)
  assert.match(cssOf({ letterSpacing: 1.5 }), /\[class\*="_markdown"\] \{ letter-spacing: 1\.5px; \}/)
  assert.match(cssOf({ paragraphSpacing: 8 }), /\[class\*="_markdown"\] p \{ margin-block: 8px !important; \}/)
  assert.match(cssOf({ firstLineIndent: 2 }), /\[class\*="_markdown"\] p \{ text-indent: 2em; \}/)
  // 行距必须是**叠加**公式（官方基准 24px + 字号增量），写死会与官方字号调节脱钩
  assert.match(cssOf({ lineHeight: 4 }), /line-height: calc\(24px \+ var\(--dsh-content-font-delta, 0px\) \+ 4px\) !important; \}/)
  // 组合：六项全开时每条规则都在（互不遮挡）
  const all = cssOf({ uiWeight: '600', headingWeight: '700', letterSpacing: 0.2, lineHeight: 2, paragraphSpacing: 6, firstLineIndent: 1.5 })
  for (const fragment of ['font-weight: 600', 'font-weight: 700', 'letter-spacing: 0.2px', 'calc(24px', 'margin-block: 6px', 'text-indent: 1.5em']) {
    assert.ok(all.includes(fragment), `组合配置必须包含 ${fragment}`)
  }
})

test('mergeConfig：文字板块单字段可独立更新（草稿确认制只发改动的那几项）', () => {
  const current = sanitizeConfig({ text: { uiWeight: '500', letterSpacing: 1 } })
  const next = mergeConfig(current, { text: { letterSpacing: 2 } })
  assert.deepEqual(next.text, { uiWeight: '500', headingWeight: '', letterSpacing: 2, lineHeight: 0, paragraphSpacing: 0, firstLineIndent: 0 })
  // configEquals 对 text 生效（无实质变化的写入不落盘）
  assert.equal(configEquals(current, sanitizeConfig({ text: { uiWeight: '500', letterSpacing: 1 } })), true)
  assert.equal(configEquals(current, next), false)
})
