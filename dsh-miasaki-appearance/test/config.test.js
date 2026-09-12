import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  buildBootScript,
  buildBootStyle,
  configEquals,
  evaluateContract,
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
  assert.equal(result.theme.scheme, 'dark')
  assert.equal(result.theme.accent, '#aabbcc', '强调色归一化为小写')
  assert.equal(result.theme.fontSize, 17, '字号夹到官方上界')
  assert.equal(result.wallpaper.blur, 60)
  assert.equal(result.wallpaper.scrim, 0)
  assert.equal(result.motion.scale, 1.5)
  assert.equal(result.conversation.maxWidth, 0)
  assert.equal('额外字段' in result, false)
  assert.equal('注入' in result.theme, false)
})

test('sanitizeConfig：非法强调色与壁纸图源被清空', () => {
  assert.equal(sanitizeConfig({ theme: { accent: 'red' } }).theme.accent, '')
  assert.equal(sanitizeConfig({ theme: { accent: '#12' } }).theme.accent, '')
  assert.equal(sanitizeConfig({ wallpaper: { source: 'javascript:alert(1)' } }).wallpaper.source, '')
  assert.equal(sanitizeConfig({ wallpaper: { source: '//evil.example.com/x.png' } }).wallpaper.source, '')
  assert.equal(sanitizeConfig({ wallpaper: { source: 'builtin:night-01' } }).wallpaper.source, 'builtin:night-01')
  assert.equal(sanitizeConfig({ wallpaper: { source: '/appearance/wallpapers/a.webp' } }).wallpaper.source, '/appearance/wallpapers/a.webp')
})

test('migrateConfig：无版本号的旧配置被补上当前版本', () => {
  const migrated = migrateConfig({ enabled: true })
  assert.equal(migrated.version, CONFIG_VERSION)
  assert.equal(migrated.enabled, true, '迁移不得丢弃已有字段')
})

test('mergeConfig：按板块深合并，未提及的字段保持原值', () => {
  const base = sanitizeConfig({ enabled: true, theme: { scheme: 'dark', fontSize: 15 }, motion: { preset: 'elegant' } })
  const merged = mergeConfig(base, { theme: { fontSize: 16 } })
  assert.equal(merged.enabled, true)
  assert.equal(merged.theme.scheme, 'dark', '同板块其它字段不被清掉')
  assert.equal(merged.theme.fontSize, 16)
  assert.equal(merged.motion.preset, 'elegant', '其它板块不受影响')
})

test('mergeConfig：非法增量不会污染现有配置', () => {
  const base = sanitizeConfig({ enabled: true, theme: { skin: 'zafkiel' } })
  const merged = mergeConfig(base, { theme: { skin: 'oops', accent: 'not-a-color' } })
  assert.equal(merged.theme.skin, 'pure')
  assert.equal(merged.theme.accent, '')
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

test('migrateConfig：v1 → v2 抬版本（新增字段由 sanitize 补默认）', () => {
  const migrated = migrateConfig({ version: 1, enabled: true, theme: { skin: 'zafkiel' } })
  assert.equal(migrated.version, 2)
  const safe = sanitizeConfig(migrated)
  assert.equal(safe.enabled, true)
  assert.equal(safe.theme.skin, 'zafkiel')
  assert.deepEqual(safe.wallpaper.surface, { sidebar: 100, conversation: 100, composer: 100, overlay: 100 })
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

test('buildBootScript：glass 属性随配置写入、关闭时恒 off', () => {
  const on = buildBootScript({ enabled: true, wallpaper: { glass: 'frost' } })
  assert.match(on, /data-mia-glass', "frost"/)
  const closed = buildBootScript({ enabled: false, wallpaper: { glass: 'frost' } })
  assert.match(closed, /data-mia-glass', "off"/)
  assert.notEqual(on, closed)
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
