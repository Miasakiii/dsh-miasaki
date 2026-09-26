// Boot Splash 首帧启动画（P2，2026-09-26 实施）—— lib/splash.js 纯逻辑契约。
// 设计：design/2026-09-22-appearance-boot-splash-design.md；跨线契约见 cross/boot-loading-2026-09-22.md。
// 守四件事：门控（关掉即原生）、注入文本安全（</style / </script 不得出现）、
// 退场生命周期（幂等 + 双信号 + 2.5s 超时）、皮肤色注入与降级。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {
  SPLASH_DONE_FLAG,
  SPLASH_EXIT_NAME,
  SPLASH_FADE_MS,
  SPLASH_ROOT_ID,
  SPLASH_TIMEOUT_MS,
  buildSplashHtml,
  buildSplashScript,
  buildSplashStyle,
  splashEnabled,
} from '../lib/splash.js'
import { CONFIG_VERSION, BOOT_SPLASH_MODES, migrateConfig, sanitizeConfig } from '../lib/config.js'

/** 一份「开 + 自动」的配置候选（sanitize 前的原始形态）。 */
function on(extra = {}) {
  return { enabled: true, motion: { bootSplash: 'auto' }, ...extra }
}

test('门控：总开关关闭 / bootSplash=off ⇒ style 与 html 全空串（关掉即原生）', () => {
  assert.equal(splashEnabled(on()), true)
  assert.equal(splashEnabled({ enabled: false, motion: { bootSplash: 'auto' } }), false, '总开关关闭不注入')
  assert.equal(splashEnabled(on({ motion: { bootSplash: 'off' } })), false, 'off 不注入')
  assert.equal(splashEnabled(on({ motion: { bootSplash: 'bogus' } })), true, '非法值收窄回 auto ⇒ 注入')

  const offConfigs = [
    { enabled: false, motion: { bootSplash: 'auto' } },
    on({ motion: { bootSplash: 'off' } }),
  ]
  for (const config of offConfigs) {
    assert.equal(buildSplashStyle(config), '', '关闭时 style 行必须为空')
    assert.equal(buildSplashHtml(config), '', '关闭时 html 行必须为空')
  }
  // 退场脚本不读配置（门控在调用方 index.js：html 行不存在就不推 script 行）——
  // 这条断言防的是「以后有人给脚本加 config 参数却忘了改调用方」。
  assert.equal(buildSplashScript.length, 0, '退场脚本无入参')
})

test('配置白名单与迁移：motion.bootSplash 收窄，v4 旧配置补 auto', () => {
  assert.deepEqual([...BOOT_SPLASH_MODES], ['auto', 'off'])
  assert.equal(sanitizeConfig({ motion: { bootSplash: 'nope' } }).motion.bootSplash, 'auto')
  assert.equal(sanitizeConfig({}).motion.bootSplash, 'auto', '出厂默认 auto')
  const migrated = sanitizeConfig(migrateConfig({ version: 4, enabled: true }))
  assert.equal(migrated.version, CONFIG_VERSION)
  assert.equal(migrated.motion.bootSplash, 'auto', 'v4 → v5 纯新增字段，旧配置补默认')
})

test('style 行：容器规格 + 变量继承取色 + reduced-motion 全静止', () => {
  const css = buildSplashStyle(on({ theme: { skin: 'zafkiel' } }))
  assert.match(css, new RegExp(`#${SPLASH_ROOT_ID}\\{`), '容器规则')
  assert.match(css, /z-index:2147483000/, '压过一切 shell 层')
  assert.match(css, /pointer-events:none/, '不参与交互')
  assert.match(css, /transition:opacity 300ms ease/, '淡出过渡与脚本 remove 同源')
  // 取色全部走 var() 并经 body 继承（boot style 把皮肤 token 定义在 body 上）——
  // 明暗由官方 body[data-ds-dark-theme] 切换 alias 端点，本行因此不分两段。
  assert.match(css, /background:var\(--dsw-alias-bg-base,#f5f6f7\)/, '底色取官方页面底色（含 fallback）')
  assert.match(css, /--mia-bs-fg:var\(--dsw-alias-label-primary,#1a1a1a\)/, '前景取官方主文字色')
  assert.match(css, /--mia-bs-accent:var\(--dsw-static-deepseek-450,#4d6bfe\)/, '强调色取品牌静态端')
  assert.doesNotMatch(css, /--mia-bs-bg:/, '不得再自定义底色变量（静态色阶明度中立，见踩坑记录）')
  assert.match(css, /@keyframes mia-bs-spin/, '纹章旋转关键帧')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, '降级媒体查询')
  assert.doesNotMatch(css, /<\/style/, 'style 行不得含 </style')
  // pure 与其它皮肤同规格（取色不依赖皮肤 token 表）
  const pureCss = buildSplashStyle(on({ theme: { skin: 'pure' } }))
  assert.match(pureCss, /background:var\(--dsw-alias-bg-base,#f5f6f7\)/)
  assert.match(pureCss, /animation:none/, 'pure 纹章静止')
})

test('style 行：三皮肤旋转方向（zafkiel 顺 / kurkuriel 逆 / pure 静止）', () => {
  assert.doesNotMatch(buildSplashStyle(on({ theme: { skin: 'zafkiel' } })), /animation-direction:reverse/)
  assert.match(buildSplashStyle(on({ theme: { skin: 'kurkuriel' } })), /animation-direction:reverse/)
})

test('html 行：容器 + 纹章 + wordmark + aria-hidden，且无 script 标签', () => {
  const html = buildSplashHtml(on({ theme: { skin: 'zafkiel' } }))
  assert.match(html, new RegExp(`<div id="${SPLASH_ROOT_ID}" aria-hidden="true">`))
  assert.match(html, /class="mia-bs-emblem"/, '内联 SVG 纹章（零外部资产）')
  assert.match(html, /MIASAKI/)
  assert.match(html, /专属 DSH 桌面端/)
  assert.match(html, /mia-bs-dots/)
  assert.doesNotMatch(html, /<script/i, 'html 行不得夹带脚本')
})

test('script 行：幂等守卫 + 双信号 + 2.5s 超时 + 全局退场函数', () => {
  const script = buildSplashScript()
  assert.doesNotMatch(script, /<\/script/, 'script 行不得含 </script')
  assert.match(script, new RegExp(`globalThis\\.${SPLASH_EXIT_NAME}=exit`), 'client 半的主信号入口')
  assert.match(script, new RegExp(`dataset\\.${SPLASH_DONE_FLAG}`), '幂等守卫')
  assert.match(script, /MutationObserver/, '兜底信号：观察 shell 容器出现')
  assert.match(script, new RegExp(String(SPLASH_TIMEOUT_MS)), '2.5s 超时兜底（401/错误页硬用例）')
  assert.match(script, new RegExp(String(SPLASH_FADE_MS + 100)), 'remove 迟于淡出过渡')
  assert.match(script, /try\{/, '首帧脚本自带异常兜底')
})

test('script 行：无 document 的异常环境下执行也不得抛错（注入文本的兜底）', () => {
  // body placement 的经典 script 抛错会阻断后续注入行与官方 __DSH_BOOT_READY__ 尾巴，
  // 因此「在被异常环境消费时静默失败」是硬要求——VM 里不给 document/window 即为该场景。
  const context = vm.createContext({})
  assert.doesNotThrow(() => vm.runInContext(buildSplashScript(), context))
})

test('script 行：模拟链路可跑通——退场幂等且节点被移除', () => {
  // 用 DOM stub 驱动退场函数两次：第二次必须是 no-op（幂等），节点最终移除。
  const removed = []
  const el = {
    id: SPLASH_ROOT_ID,
    classList: { add(name) { this.names = [...(this.names ?? []), name] } },
    parentNode: { removeChild(node) { removed.push(node) } },
  }
  const timeouts = []
  const context = vm.createContext({
    document: {
      documentElement: { dataset: {} },
      getElementById: id => (id === SPLASH_ROOT_ID ? el : null),
      body: { children: [] },
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback }
      observe() {}
      disconnect() {}
    },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length },
  })
  vm.runInContext(buildSplashScript(), context)
  // vm 沙箱的全局要经 runInContext 取（sandbox 对象的属性不会自动出现在其上）
  const sandboxGlobal = vm.runInContext('globalThis', context)
  const exit = sandboxGlobal[SPLASH_EXIT_NAME]
  assert.equal(typeof exit, 'function', '退场函数必须挂到 globalThis')
  exit()
  assert.equal(context.document.documentElement.dataset[SPLASH_DONE_FLAG], '1', '首次退场打幂等标记')
  assert.ok(el.classList.names.includes('mia-bs-out'), '淡出类已加')
  const removedBefore = removed.length
  exit()
  assert.equal(removed.length, removedBefore, '第二次退场不得重复移除（幂等）')
  // 淡出计时到位后节点移除
  const removeTimer = timeouts.find(t => t.ms === SPLASH_FADE_MS + 100)
  assert.notEqual(removeTimer, undefined, 'remove 定时器存在且迟于淡出')
  removeTimer.fn()
  assert.deepEqual(removed, [el], '节点被父容器移除')
})
