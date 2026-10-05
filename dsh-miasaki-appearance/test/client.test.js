// Contract test for the client half.
//
// 1) 回归闸门（2026-09-11 启动失败）：DSH 的客户端装载器只把 `require` 交给
//    factory（契约见 `@deepseek-ai/dsh-client-modules` 的 `ClientBundleRegistration`：
//    `factory: (require) => exports`），**不注入 `module`**。bundle 里写
//    `module.exports` 而没自己声明 `const module = { exports: {} }`，factory 一执行
//    就抛 `ReferenceError: module is not defined`，整包加载失败、设置里那栏直接不出现。
//    本文件在**没有 `module` 的 VM 上下文**里跑 factory，正是为了把这个坑钉死。
// 2) 槽位契约：外观栏必须注册在官方 `settings.section`（list 槽）上，id=appearance、
//    order=5 —— 官方「通用」是 0、「模型」是 10，5 落在两者之间即「紧跟通用」。
// 3) 风格契约（2026-09-21 M2.6）：面板对齐官方「通用设置」页 —— 复用官方 primitives
//    （前端壳 seed 模块）+ `.mia-*` 行式 CSS（0.5px 分隔线 / 16px 行距 / 官方 token）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
// M4 白名单直接从 host 半取——client bundle 不能 import（装载器只给 require），
// 两侧同源靠这些常量比对（bundle 里的选项表必须与 host sanitize 白名单一致）。
import { DENSITIES, FONTS, CURSOR_STYLES, QUOTE_CODE_LEVELS } from '../lib/config.js'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** 面板 CSS 正文：从 bundle 源里截出 PANEL_CSS 模板字面量，供风格契约断言。 */
const PANEL_CSS_SOURCE = (() => {
  const start = source.indexOf('const PANEL_CSS = `')
  assert.notEqual(start, -1, 'client.js 必须定义 PANEL_CSS 模板字面量')
  const end = source.indexOf('const PANEL_CSS_ID', start)
  assert.notEqual(end, -1)
  return source.slice(start, end)
})()

/** 动效层 CSS 正文：从 bundle 源里截出 MOTION_CSS 模板字面量（M3 合规断言用）。 */
const MOTION_CSS_SOURCE = (() => {
  const start = source.indexOf('const MOTION_CSS = `')
  assert.notEqual(start, -1, 'client.js 必须定义 MOTION_CSS 模板字面量')
  const end = source.indexOf('`\n    /** 取（按 id 去重）动效层', start)
  assert.notEqual(end, -1)
  return source.slice(start, end)
})()

/** 在 VM 里执行 client.js，捕获装载器收到的描述符。上下文刻意不提供 `module`。
 *  documentElement.getAttribute 对 data-mia-native-mica 返回 'on'——桌面壳 Win11 的
 *  真实广播形态（「无可见效果」提示的 mica 分支据此判定；其它属性仍返回 null）。 */
function capture(opts = {}) {
  let descriptor = null
  // P5（2026-09-30）：导入/导出需要被真正驱动 —— 记录创建的元素（文件 input / 下载 anchor）、
  // 造出的 Blob 与 objectURL，以及可注入的 window.confirm（二次确认门）。
  const created = []
  const blobs = []
  const objectUrls = []
  const window = {
    __ModuleLoader__: { load(d) { descriptor = d } },
    confirm: opts.confirm,
  }
  // elementCalls 记录 setAttribute / removeAttribute / style 写变量（M4 行为闸门用）。
  const elementCalls = { set: [], removed: [], props: {} }
  const documentElement = {
    getAttribute: name => (name === 'data-mia-native-mica'
      ? 'on'
      : (Object.hasOwn(elementCalls.props, name) ? elementCalls.props[name] : null)),
    hasAttribute: () => false,
    setAttribute(name, value) { elementCalls.set.push([name, value]); elementCalls.props[name] = value },
    removeAttribute(name) { elementCalls.removed.push(name); delete elementCalls.props[name] },
    style: {
      setProperty(name, value) { elementCalls.set.push([`style:${name}`, value]); elementCalls.props[`style:${name}`] = value },
      removeProperty(name) { elementCalls.removed.push(`style:${name}`); delete elementCalls.props[`style:${name}`] },
    },
  }
  const document = {
    body: { append() {} },
    // dataset 供面板 CSS 注入打 data-plugin-css 标记（官方 client 插件同一注入式）。
    // P5 起同时记录每个被创建的元素（导入的文件 input / 导出的 anchor 都要能取回驱动）。
    createElement: (tag) => {
      const el = {
        tagName: String(tag ?? 'div').toUpperCase(),
        style: {}, dataset: {}, files: null, clicked: false,
        append() {}, appendChild() {}, remove() {},
        setAttribute(name, value) { el[name] = value },
        removeAttribute() {},
        click() { el.clicked = true },
      }
      created.push(el)
      return el
    },
    head: { append() {}, appendChild() {} },
    documentElement,
    // M4 锚点自检（静默失效 #10）要按选择器给出不同结果；**默认仍一律 null**（既有用例行为不变）。
    querySelector: sel => (typeof opts.querySelector === 'function' ? opts.querySelector(sel) : null),
    querySelectorAll: () => [],
  }
  // fetch stub：/state 与 /skin 由 CONV_FETCH_CONFIG / skin 夹具应答——apply 时
  // syncSkin / syncMotion / syncConversation 三个协程都会打 /state。
  // `fetches` 记录每次调用（P4 恢复默认要点验「发出去的是 host 下发的默认值」）。
  const fetches = []
  const fetchStub = (url, init) => {
    fetches.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body })
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => String(url).endsWith('/skin')
        ? { id: 'pure', tokens: null, wallpaperActive: false, surface: null, meta: { preferredScheme: 'dark' } }
        : { config: CONV_FETCH_CONFIG, defaults: opts.defaults ?? CONV_DEFAULTS, revision: 1, persistent: true },
    })
  }
  // getComputedStyle：M4 锚点自检读锚点上官方变量的计算值。默认一律空串（= 什么都读不出来），
  // 既有用例不开密度 / 宽度档位，probe 走 idle 分支 ⇒ 行为不变。
  const getComputedStyle = typeof opts.getComputedStyle === 'function'
    ? opts.getComputedStyle
    : () => ({ getPropertyValue: () => '' })
  const context = vm.createContext({
    window, document, console, fetch: fetchStub, getComputedStyle,
    // P5：导出走 Blob + objectURL（浏览器 API），VM 里给可记录的替身。
    Blob: class { constructor(parts, options) { this.parts = parts; this.type = options && options.type; blobs.push(this) } },
    URL: {
      createObjectURL(blob) { objectUrls.push(blob); return `blob:mock-${objectUrls.length}` },
      revokeObjectURL() {},
    },
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.notEqual(descriptor, null, 'client.js 必须调用 window.__ModuleLoader__.load()')
  return { descriptor, window, context, document, elementCalls, fetches, created, blobs, objectUrls }
}

/** apply 时各 sync* 协程（经 fetch stub）消费的配置夹具；行为测试可整体替换。 */
const CONV_FETCH_CONFIG = {
  enabled: true,
  theme: { skin: 'pure' },
  wallpaper: {
    source: '', light: '', dark: '', blur: 0, scrim: 0,
    fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
    surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
  },
  avatar: { source: '' },
  motion: { enabled: false, preset: 'fluid', scale: 1, bootSplash: 'off' },
  conversation: { density: 'comfortable', maxWidth: 0, font: 'system', cursor: 'off', quoteCode: 'default' },
  boot: { intro: 'brand', audio: false },
}

/**
 * P4「恢复默认」的下发夹具（host 侧 DEFAULT_CONFIG 的镜像）。
 * `theme.skin` 刻意与 CONV_FETCH_CONFIG 相同（该板块=默认 ⇒ 不显示恢复按钮），
 * 其余板块也取默认值 ⇒ **只有被行为测试改过的板块才会冒出恢复按钮**。
 */
const CONV_DEFAULTS = {
  version: 7,
  enabled: false,
  theme: { skin: 'pure' },
  wallpaper: {
    source: '', light: '', dark: '', blur: 0, scrim: 0,
    fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
    surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
  },
  avatar: { source: '' },
  motion: { enabled: false, preset: 'fluid', scale: 1, bootSplash: 'auto' },
  conversation: { density: 'comfortable', maxWidth: 0, font: 'system', cursor: 'off', quoteCode: 'default' },
  boot: { intro: 'brand', audio: false },
}

/** 等 sync* 协程落定（stub 全部同步 resolve，一个宏任务 tick 即排空 microtask 队列）。 */
function flushAsync() {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

// React stub：createElement 保留 children 便于断言；hooks 惰性化，组件可被调用一次。
// stateQueue 非空时 useState 按序弹出初值（渲染冒烟测试用它把组件驱动到"配置已加载"
// 的完整渲染路径——实机空白面板事故发生在该路径，state=null 路径走不到）。
const react = {
  stateQueue: null,
  /** P5：记录所有 setState 调用值（断言「失败必须显式显示」用）。 */
  setCalls: [],
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState(initial) {
    const record = (value) => { react.setCalls.push(value) }
    if (this.stateQueue !== null && this.stateQueue.length > 0) return [this.stateQueue.shift(), record]
    return [typeof initial === 'function' ? initial() : initial, record]
  },
  useEffect: () => {},
}
// 官方 primitives stub：前端壳 staticModules 的 seed 模块（M2.6 起面板复用）。
// 名字必须与 seed 的实际导出一致（Icon<名称>Outline<Medium|Regular>，尺寸走 props）——
// 2026-09-23 实机空白事故：client 用旧版 *Outline16/*Outline14 名字，seed 里是
// undefined，createElement(undefined) 首渲染即抛、整栏被罚下。stub 若继续用错名，
// 冒烟测试会一直绿而实机一直白屏，故此处钉死真实名字（对照 dsh-web-frontend 的
// index-*.js seed 表与 dsh-client-ui-theme 的 FontSizeRow）。
// 2026-09-26 去重：明暗立方的三枚图标（IconLight/Dark/FollowsystemOutlineMedium）
// 随控件移除，本 stub 也不再镜像——stub 与 client.js 的引用集同步收敛。
// 2026-09-26 V1：Pill 退场（单选行改官方「选择丸 + Menu」），stub 增补 Menu 与
// IconChevronDownOutlineRegular——两名字均已从**本机实装** seed 冻结表
// （dsh-web-frontend dist/assets/index-*.js 的 qb=Object.freeze(...)）逐名核实存在。
// react stub 的 createElement 只把组件当 type 记录、不会真调用，占位即可。
const primitivesStub = {
  Button: 'Button',
  Switch: 'Switch',
  Menu: 'Menu',
  IconChevronUpOutlineRegular: 'IconChevronUpOutlineRegular',
  IconChevronDownOutlineRegular: 'IconChevronDownOutlineRegular',
}
const requireStub = name => {
  if (name === 'react') return react
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected require: ${name}`)
}

function fakeCtx() {
  const registered = []
  const effects = []
  return {
    registered,
    effects,
    get: () => undefined,
    slots: {
      inject(name, callback) { registered.push({ name, ...callback() }) },
      register(meta, view) { return { meta, view } },
    },
    effect(callback, label) { effects.push({ label, dispose: callback() }) },
  }
}

test('client half 以包名注册，且装载器上下文里没有 module 全局', () => {
  const { descriptor, context } = capture()
  assert.equal(descriptor.id, '@miasaki/dsh-appearance')
  assert.equal(typeof descriptor.factory, 'function')
  assert.equal(context.module, undefined, '装载器不提供 module —— bundle 必须自己声明')
})

test('factory 返回插件导出（2026-09-11 加载失败的回归闸门）', () => {
  const { descriptor } = capture()
  // 这一行就是当初抛 `module is not defined` 的地方：factory 只拿到 require。
  const exports = descriptor.factory(requireStub)
  assert.equal(typeof exports, 'object', 'factory 必须返回 module.exports')
  assert.notEqual(exports, null)
  // 先展开：导出对象来自另一个 VM realm，数组原型与本 realm 不同。
  assert.deepEqual([...exports.inject], ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply 把「外观」注册进官方 settings.section（id=appearance、order=5）', () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)

  assert.equal(ctx.registered.length, 1)
  const section = ctx.registered[0]
  assert.equal(section.name, 'settings.section')
  assert.equal(section.meta.name, 'settings.section')
  assert.equal(section.meta.id, 'appearance')
  // 官方 order：通用 = 0、模型 = 10；5 即「紧跟通用」。
  assert.equal(section.meta.order, 5)
  assert.equal(section.meta.label, '外观')
  assert.equal(typeof section.view, 'function', '注册项必须带一个组件')
})

test('apply 幂等，且 fiber 拆除时复位守卫（允许 HMR 重挂）', () => {
  const { descriptor, window } = capture()
  const exports = descriptor.factory(requireStub)
  const ctx = fakeCtx()

  exports.apply(ctx)
  exports.apply(ctx)
  assert.equal(ctx.registered.length, 1, '重复 apply 不得叠加第二个设置栏')
  assert.equal(window.__DSH_APPEARANCE_BOOTED__, true)

  assert.equal(ctx.effects.length, 1)
  ctx.effects[0].dispose()
  assert.equal(window.__DSH_APPEARANCE_BOOTED__, false, '拆除后必须允许重新挂载')

  exports.apply(ctx)
  assert.equal(ctx.registered.length, 2, '拆除后的 apply 必须能重新注册')
})

test('与 Host 的通信走同源 JSON 路由，不用动态插件的 host.call', () => {
  // client bundle 由 __ModuleLoader__ 装载，没有 host.call builtin（那是动态插件专属），
  // 所以只能走 /appearance/api/*。这条断言防的是「照抄动态插件写法」的退化。
  // 只查装载器调用之后的代码：文件头说明注释里正当地提到了 host.call，
  // 且注释里含 `/appearance/api/*`，任何朴素的「剥注释」都会在那里踩空。
  const code = source.slice(source.indexOf('window.__ModuleLoader__.load('))
  assert.match(code, /const API = '\/appearance\/api'/)
  assert.doesNotMatch(code, /host\.call/)
})

test('面板复用官方 primitives（seed 模块 require，不新增 external 声明）', () => {
  // M2.6：交互控件全部换成官方 Button / Switch / Pill / 图标。primitives 是前端壳
  // staticModules 里的 seed 模块（见 dsh-web-frontend 的 My() seed 表），require 即得、
  // 不产生模块图边 —— 因此 package.json 不需要 dsh.client.external。这条断言钉住
  // 「require 官方 seed 模块」这一形态，防止退化成自制控件或漏改。
  const { descriptor } = capture()
  const exports = descriptor.factory(requireStub)
  assert.equal(typeof exports, 'object')
})

test('面板挂载官方「通用设置」页风格：mia-* 行式 + 官方 token + 0.5px 分隔线', () => {
  // 风格契约（对照 dsh-client-ui-theme 的 FontSizeRow 与 settings-general 的
  // SettingsRoot）：行 16px 0 内边距、0.5px border-l2 分隔线、14px/22 标题、
  // 12px/18 三级说明、步进器。防「换皮不换骨」。
  // 注：明暗立方（AppearanceRow.themeCube）2026-09-26 随去重移除——那是官方
  // 「通用」设置页自己的行，外观页不再提供第二入口。
  // V1（2026-09-26）：单选行走官方「选择丸」（LanguageRow.selector 规格）、
  // 占位走官方 models 的 dashed 卡；Pill 排整类退场。
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  const element = view()
  assert.equal(element.props.className, 'mia-panel', '面板根节点用官方栏宽制式')
  assert.match(PANEL_CSS_SOURCE, /\.mia-row\{[^}]*border-bottom:\.5px solid var\(--dsw-alias-border-l2\)/)
  assert.match(PANEL_CSS_SOURCE, /\.mia-row\{[^}]*padding:16px 0/)
  assert.match(PANEL_CSS_SOURCE, /\.mia-title\{[^}]*font-size:14px/)
  assert.match(PANEL_CSS_SOURCE, /\.mia-desc\{[^}]*var\(--dsw-alias-label-tertiary\)/)
  assert.match(PANEL_CSS_SOURCE, /\.mia-stepper\{[^}]*var\(--dsw-alias-bg-module-platform\)/)
  // 选择丸：官方 LanguageRow.selector 规格（h36 / r18 / module 底）
  assert.match(PANEL_CSS_SOURCE, /\.mia-select\{[^}]*border-radius:18px/)
  assert.match(PANEL_CSS_SOURCE, /\.mia-select\{[^}]*var\(--dsw-alias-bg-module-platform\)/)
  // M3/M4 占位（V1）：官方 models dashed 规格——M4 落地后占位整类退场（无消费者）
  assert.doesNotMatch(PANEL_CSS_SOURCE, /\.mia-dashed\{/, 'M4 面板落地后 dashed 占位样式必须删除')
  assert.doesNotMatch(PANEL_CSS_SOURCE, /\.mia-cube\{/, '明暗立方样式必须随去重移除')
  assert.doesNotMatch(PANEL_CSS_SOURCE, /\.mia-picker\{/, 'Pill 排样式必须随 V1 退场')
  assert.doesNotMatch(PANEL_CSS_SOURCE, /\.mia-knobGrid\{/, '自绘旋钮网格换成官方双列字段网格')
  // 注入去重标记与官方插件同构（data-plugin-css）。
  assert.match(source, /data-plugin-css/)
})

test('V1：单选设置行走官方选择丸 + Menu， Pill 排整类退场', () => {
  // 2026-09-26 V1 闸门：官方设置行的单选标准控件是「选择丸 + Menu」（LanguageRow /
  // PermissionRow），Pill 在官方是 view switcher/filter 用语。本闸门盯三件事：
  // ① 皮肤/壁纸图源/玻璃/我的上传 都渲染成 .mia-select 选择丸；
  // ② 菜单项来自配置白名单（防「UI 少给选项」的静默降级）；
  // ③ 面板里不再出现 .mia-picker（Pill 排复活即红）。
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'zafkiel' },
        wallpaper: {
          source: '/appearance/wallpaper/local/aurora-2026.png', light: '', dark: '', blur: 0, scrim: 20,
          fit: 'cover', focus: 'center', glass: 'frost', vignette: 0,
          surface: { sidebar: 75, conversation: 70, composer: 80, overlay: 90 },
        },
        avatar: { source: '' },
        motion: { enabled: false, preset: 'fluid', scale: 1 },
        conversation: { density: 'comfortable', maxWidth: 0 },
      },
      revision: 8,
      persistent: true,
    },
    null, null, false, { local: ['aurora-2026.png'] }, { local: [] }, null, null,
  ]
  try {
    const element = view()
    // Menu 原语本体与它的 anchor 触发器（选择丸按钮在 props.anchor 上）
    const menus = collectNodes(element, node => node.type === primitivesStub.Menu)
    // 皮肤 / 壁纸图源 / 玻璃档位 / 动效预设 + M4 会话效果四行（密度/字体/光标样式/
    // 引用与代码块）= 8 个（我的上传此时无文件不渲染）
    assert.equal(menus.length, 8, '八个单选行都必须是官方 Menu')
    const selectButtons = collectMenuAnchors(element).filter(node => node.type === 'button')
    assert.equal(selectButtons.length, 8, '八个选择丸触发器')
    for (const button of selectButtons) {
      assert.equal(button.props.className, 'mia-select', '触发器必须是官方 selector 规格的选择丸')
      assert.equal(button.props['aria-haspopup'], 'menu', '选择丸必须挂官方 Menu')
    }
    // 本地文件（长值）在选择丸上截断显示、title 给全名
    const sourceTrigger = selectButtons.find(button => button.props.title === 'aurora-2026.png')
    assert.notEqual(sourceTrigger, undefined, '本地壁纸文件名必须进 title（选择丸内截断显示）')
    // 菜单项来自配置白名单（防「UI 少给选项」的静默降级）
    // 注：client.js 跑在独立 VM context，数组原型与本 realm 不同——先展开再断言。
    const idsOf = items => [...items].map(item => item.id)
    const itemsOf = wanted => menus.find(menu => menu.props.items.some(item => item.id === wanted)).props.items
    assert.deepEqual(idsOf(itemsOf('zafkiel')), ['pure', 'zafkiel', 'kurkuriel'], '皮肤三款必须全在菜单里')
    assert.deepEqual(idsOf(itemsOf('frost')), ['off', 'light', 'frost', 'mica'], '玻璃四档必须全在菜单里')
    assert.deepEqual(
      idsOf(itemsOf('')),
      ['', 'builtin:aurora', 'builtin:dusk', 'builtin:ember', '/appearance/wallpaper/local/aurora-2026.png'],
      '图源菜单 = 无 + 三内置 + 本地文件',
    )
    assert.deepEqual(idsOf(itemsOf('elegant')), ['fluid', 'elegant', 'minimal'], '动效三套预设必须全在菜单里')
    const pickers = collectNodes(element, node => typeof node.props.className === 'string' && node.props.className.includes('mia-picker'))
    assert.equal(pickers.length, 0, 'Pill 排不得复活')
  } finally {
    react.stateQueue = null
  }
})

test('面板组件渲染冒烟：view 调用不抛错且产出元素（2026-09-12 实机空白面板的回归闸门）', () => {
  // 实机事故：reactElementWallpaperPicker（factory 作用域）引用了组件内 useState 的
  // `wallpapers` → 渲染期 ReferenceError → 整个外观面板空白。注册期契约测试抓不到
  // （slots.inject 的回调不执行），必须真正调用组件函数。
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  assert.equal(typeof view, 'function')
  const element = view()
  assert.notEqual(element, null, '组件必须产出元素（崩了就是整个面板空白）')
  assert.equal(typeof element, 'object')
})

test('面板渲染冒烟：state 就绪（含 v2 壁纸字段）时不抛错', () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  // 把 useState 按序注入"配置已加载"形态（state / contract / error / busy /
  // wallpapers / avatars / presets / openMenu）——组件会走进壁纸区块与选择丸的完整渲染路径。
  // 实机空白面板的 ReferenceError（factory 作用域引用组件内 state）只有这条路径能抓到。
  // 队列长度即面板 state 数：2026-09-26 去重移除 themeFacts（-1），V1 增 openMenu（+1），
  // 现为 8 个。
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'zafkiel' },
        wallpaper: {
          source: 'builtin:dusk', light: '', dark: '', blur: 0, scrim: 20,
          fit: 'cover', focus: 'center', glass: 'frost', vignette: 0,
          surface: { sidebar: 75, conversation: 70, composer: 80, overlay: 90 },
        },
        motion: { enabled: false, preset: 'fluid', scale: 1 },
        conversation: { density: 'comfortable', maxWidth: 0 },
      },
      revision: 3,
      persistent: true,
    },
    null, null, false, null, null, null, null,
  ]
  try {
    const element = view()
    assert.notEqual(element, null)
  } finally {
    react.stateQueue = null
  }
})

/** 深度收集渲染树里的文本节点（用于断言板块文案在位）。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, out)
  }
  return out
}

/** 深度收集满足谓词的渲染节点（断言 className / src / aria 等 props 用）。 */
function collectNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, predicate, out)
    return out
  }
  if (node.props !== undefined && node.props !== null && predicate(node) === true) out.push(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectNodes(child, predicate, out)
  }
  return out
}

/**
 * 收集官方 Menu 原语的 anchor 触发器节点（V1 起选择丸按钮挂在 Menu 的 props.anchor 上，
 * 不是 children——stub 的 createElement 不渲染子组件，必须显式走 anchor）。
 * @param {object} node - 渲染树根。
 * @returns {object[]} anchor 内的节点（含 anchor 本身）。
 */
function collectMenuAnchors(node) {
  const out = []
  for (const menu of collectNodes(node, n => n.type === primitivesStub.Menu)) {
    collectNodes(menu.props.anchor, () => true, out)
  }
  return out
}

test('与官方「通用」设置页不重复：面板不再渲染明暗偏好与正文字号（2026-09-26 去重闸门）', () => {
  // 官方「通用」设置页自己有这两行：ui-theme 的 AppearanceRow（浅色/深色/跟随系统，
  // order 10）与 FontSizeRow（正文字号 12–17px，order 11），都注册在
  // settings.general.item 槽。外观页自 M1 起给同一偏好提供**第二入口**，
  // 现按「通用设置里有的、外观设置就不再放」移除；config.theme 的 scheme /
  // accent / fontSize 镜像字段同批删除（lib/config.js 侧另有单测）。
  // 这条闸门防的是"第二入口复活"——包括换种形式复活（只读回显也算重复）。
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'zafkiel' },
        wallpaper: {
          source: '', light: '', dark: '', blur: 0, scrim: 0,
          fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
          surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
        },
        avatar: { source: '' },
        motion: { enabled: false, preset: 'fluid', scale: 1 },
        conversation: { density: 'comfortable', maxWidth: 0 },
      },
      revision: 7,
      persistent: true,
    },
    null, null, false, null, { local: [] }, { presets: [] }, null,
  ]
  try {
    const element = view()
    const texts = collectText(element)
    assert.equal(texts.includes('正文字号'), false, '正文字号是官方通用设置页的行，外观页不得重复提供')
    assert.equal(texts.includes('跟随系统'), false, '明暗三选一是官方 AppearanceRow 的控件')
    const cubes = collectNodes(element, node => typeof node.props.className === 'string' && node.props.className.includes('mia-cube'))
    assert.equal(cubes.length, 0, '明暗立方控件必须移除')
    // px 单位的精准判据（M4 起宽度行有正当 px 消费）：禁的是「字号步进器」复活，
    // 不是一切单位——aria-label 含「字号」的箭头即 FontSizeRow 第二入口的签名。
    const unitArrows = collectNodes(element, node => node.type === 'button' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].endsWith('字号'))
    assert.equal(unitArrows.length, 0, '字号步进器（官方 FontSizeRow 的第二入口）不得复活')
    // 官方通用页没有的能力必须仍在：皮肤是 overrideTokens 层，官方三立方管不了
    assert.equal(texts.includes('皮肤'), true, '皮肤是本线独有能力，必须保留')
    assert.equal(texts.includes('外观定制总开关'), true)
    // V1 起皮肤行走选择丸（控件形态随去重后的信息架构一起定型）
    const skinSelect = collectMenuAnchors(element).filter(node => node.type === 'button' && node.props.className === 'mia-select')
    assert.equal(skinSelect.length >= 1, true, '皮肤行必须是官方选择丸')
  } finally {
    react.stateQueue = null
  }
})

test('M3 动效层 CSS 合规：只动 transform/opacity、禁 linear、reduced-motion 降级', () => {
  // M1 规划 §5.5 的禁止清单（硬约束）：无意义 opacity 0→1、线性缓动、全页统一 0.3s ease。
  assert.match(MOTION_CSS_SOURCE, /@keyframes mia-mo-rise\{from\{opacity:0;transform:translateY/, '入场必须带位移+缩放，不允许只有 opacity')
  assert.match(MOTION_CSS_SOURCE, /calc\(var\(--mia-mo-d-std\) \* var\(--mia-mo-dur-scale\)\)/, '时长走变量×强度倍率（切预设只改变量值）')
  assert.match(MOTION_CSS_SOURCE, /\[data-slot="main.conversation"\] > \*\{animation:mia-mo-rise calc\(var\(--mia-mo-d-med\)/, '会话大表面走 medium 档（规格表 420ms 级）')
  // 2026-09-27 竖条形态修正（用户反馈侧栏动效欠缺）：窄高竖条换横向滑入，贴官方侧栏
  // 折叠的横向语汇（SidebarRoot rail-in）；不缩放（实色背景板边缘露缝）。宽扁容器
  // （会话大表面 / 设置面板）保持竖向 rise；轻错峰 = 侧栏 / 会话 +60ms / 右栏 +120ms。
  assert.match(MOTION_CSS_SOURCE, /\[data-slot="sidebar"\] > \*\{--mia-mo-slide-x:-12px;animation:mia-mo-slide /, '侧栏走横向滑入（-12px）')
  assert.match(MOTION_CSS_SOURCE, /\[data-slot="rightbar"\] > \*\{--mia-mo-slide-x:12px;animation:mia-mo-slide [^}]*120ms\}/, '右栏同款横向滑入（+12px）+ 错峰 120ms')
  assert.match(MOTION_CSS_SOURCE, /@keyframes mia-mo-slide\{from\{opacity:0;transform:translateX\(var\(--mia-mo-slide-x,-12px\)\)\}to\{opacity:1;transform:none\}\}/, 'slide 保留横向位移（禁纯淡入）、不缩放')
  assert.match(MOTION_CSS_SOURCE, /\[data-slot="main.conversation"\] > \*\{animation:mia-mo-rise calc\(var\(--mia-mo-d-med\) \* var\(--mia-mo-dur-scale\)\) var\(--mia-mo-ease\) 60ms\}/, '会话大表面错峰 60ms（侧栏 / 会话 / 右栏的加载节奏）')
  // M3.2（用户反馈「设置页的动效不统一」）：设置面板的动效锚点从各线自带的面板类名
  // .mia-panel 迁到官方设置面板容器。旧锚点只被 appearance / pet-panel 消费 ⇒ 设置里
  // 外观与桌宠两页整块上浮、其余六页瞬切。新锚点是官方无障碍事实（实测 dsh 0.2.0-rc.2
  // 全量 client 包全局唯一）：设置面板 = [role="presentation"] 弹层 > [role="dialog"]
  // 且 aria-modal="true" + aria-labelledby。挂容器而非内容区 ⇒ 页签切换不重建节点、
  // 不重播，只有「打开设置」这一次入场 —— 与官方瞬切行为一致。
  assert.match(
    MOTION_CSS_SOURCE,
    /\[role="presentation"\] > \[role="dialog"\]\[aria-modal="true"\]\[aria-labelledby\]\{animation:mia-mo-rise /,
    '设置面板入场动效挂官方设置面板容器（打开时整块入场，与停在哪一页签无关）',
  )
  assert.doesNotMatch(
    MOTION_CSS_SOURCE,
    /\.mia-panel\{animation/,
    '不得再用各线自带的面板类名驱动动效 —— 那个类名只有两线用，只会让部分页签动',
  )
  assert.doesNotMatch(
    MOTION_CSS_SOURCE,
    /\[role="presentation"\] > \[role="dialog"\]\[aria-modal="true"\]\{/,
    '锚点须带 aria-labelledby 且限定在 [role="presentation"] 弹层内 —— 放开会把官方 Modal 与图片灯箱一起吃进来',
  )
  const reducedMotionBlock = MOTION_CSS_SOURCE.slice(MOTION_CSS_SOURCE.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(
    reducedMotionBlock,
    /\[role="presentation"\] > \[role="dialog"\]\[aria-modal="true"\]\[aria-labelledby\]\{animation:mia-mo-fade 100ms ease\}/,
    'reduced-motion 降级必须同样覆盖设置面板（否则降级后只剩它瞬切、仍不统一）',
  )
  assert.match(MOTION_CSS_SOURCE, /@media \(prefers-reduced-motion: reduce\)/, '降级媒体查询')
  assert.match(MOTION_CSS_SOURCE, /animation:mia-mo-fade 100ms ease/, 'reduced-motion 统一 100ms 淡入')
  assert.match(MOTION_CSS_SOURCE, /\.mia-mo-tagged\{animation-delay:calc\(var\(--mia-mo-i, 0\) \* var\(--mia-mo-stagger\)\)\}/, '错峰槽位（M3.1 贴类器消费）')
  assert.doesNotMatch(MOTION_CSS_SOURCE, /linear/, '禁 linear 缓动')
  assert.doesNotMatch(MOTION_CSS_SOURCE, /transition/, '动效层只做 animation，不抢官方 transition')
  // 门控与去重在源码层可见（行为由面板渲染测试覆盖）
  assert.match(source, /const MOTION_CSS_ID = '@miasaki\/dsh-appearance\/motion\.css'/)
  assert.match(source, /tag\.dataset\.pluginCss = MOTION_CSS_ID/, '动效层注入与 PANEL_CSS 同构（data-plugin-css 去重）')
})

test('M3 动效板块：总开关 + 预设选择丸 + 强度步进器（不再是一行占位灰字）', () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'pure' },
        wallpaper: {
          source: '', light: '', dark: '', blur: 0, scrim: 0,
          fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
          surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
        },
        avatar: { source: '' },
        motion: { enabled: true, preset: 'fluid', scale: 1, bootSplash: 'auto' },
        conversation: { density: 'comfortable', maxWidth: 0 },
      },
      revision: 9,
      persistent: true,
    },
    null, null, false, null, { local: [] }, { presets: [] }, null,
  ]
  try {
    const element = view()
    const texts = collectText(element)
    assert.equal(texts.includes('动效'), true, '板块标题必须在')
    // Switch：总开关 + 动效 + M4 流式光标 = 3 个（都是官方 Switch，各带无障碍名）
    const switches = collectNodes(element, node => node.type === primitivesStub.Switch)
    assert.equal(switches.length, 3, '总开关 + 动效 + 流式光标都是官方 Switch')
    const master = switches.find(node => node.props.label === '外观定制总开关')
    const motionSwitch = switches.find(node => node.props.label === '动效')
    assert.notEqual(master, undefined, '总开关必须有无障碍名')
    assert.notEqual(motionSwitch, undefined, '动效开关必须有无障益名（不复用总开关的 label）')
    assert.equal(motionSwitch.props.checked, true)
    // 预设走选择丸 + Menu（与其它单选项同一控件语言）
    const presetMenu = collectNodes(element, node => node.type === primitivesStub.Menu
      && Array.isArray(node.props.items)
      && node.props.items.some(item => item.id === 'elegant'))
    assert.equal(presetMenu.length, 1, '预设必须是官方选择丸')
    assert.deepEqual([...presetMenu[0].props.items].map(item => item.id), ['fluid', 'elegant', 'minimal'], '三套预设必须在菜单里')
    assert.equal(presetMenu[0].props.selectedId, 'fluid')
    // 强度步进器（官方 stepper 规格）+ × 单位（单位收进 stepper 内，M4 起宽度行走同款）；
    // 7 枚壁纸/表面旋钮 + 强度 + M4 宽度 = 8 枚（按 aria-label 定位强度那枚）
    const steppers = collectNodes(element, node => typeof node.props.className === 'string' && node.props.className === 'mia-stepper')
    assert.equal(steppers.length, 8, '6 枚壁纸/表面旋钮 + 强度倍率 + 会话最大宽度')
    const scaleStepper = steppers.find(node => collectNodes(node, n => n.props['aria-label'] === '增大强度倍率').length > 0)
    assert.notEqual(scaleStepper, undefined, '强度倍率必须是步进器（官方 stepper 规格）')
    assert.equal(texts.includes('×'), true, '倍率单位')
  } finally {
    react.stateQueue = null
  }
})

test('「无可见效果」提示：纯净皮 + 全不透明 + mica 走系统材质时出现，换皮肤即消失', () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  // 用户实机配置的形状：pure + 壁纸 + surface 全 100 + glass=mica（stub 广播 native-mica=on）
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'pure' },
        wallpaper: {
          source: 'builtin:aurora', light: '', dark: '', blur: 0, scrim: 10,
          fit: 'cover', focus: 'center', glass: 'mica', vignette: 10,
          surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
        },
        avatar: { source: '' },
        motion: { enabled: false, preset: 'fluid', scale: 1, bootSplash: 'auto' },
        conversation: { density: 'comfortable', maxWidth: 0 },
      },
      revision: 10,
      persistent: true,
    },
    null, null, false, null, { local: [] }, { presets: [] }, null,
  ]
  try {
    const texts = collectText(view())
    assert.equal(texts.some(t => t.includes('当前配置下外观没有可见变化')), true, '零变化配置必须给指引')
  } finally {
    react.stateQueue = null
  }
  // 换成皮肤 ⇒ 提示消失（有可见效果）
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'zafkiel' },
        wallpaper: {
          source: 'builtin:aurora', light: '', dark: '', blur: 0, scrim: 10,
          fit: 'cover', focus: 'center', glass: 'mica', vignette: 10,
          surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
        },
        avatar: { source: '' },
        motion: { enabled: false, preset: 'fluid', scale: 1, bootSplash: 'auto' },
        conversation: { density: 'comfortable', maxWidth: 0 },
      },
      revision: 11,
      persistent: true,
    },
    null, null, false, null, { local: [] }, { presets: [] }, null,
  ]
  try {
    const texts = collectText(view())
    assert.equal(texts.some(t => t.includes('当前配置下外观没有可见变化')), false, '换皮肤后不得再提示')
  } finally {
    react.stateQueue = null
  }
})

test('面板渲染冒烟：应用图标板块（预设 + 已设置 + 我的上传）不抛错且文案在位', () => {
  // M2.5/M2.7 回归闸门：图标板块读 state.config.avatar、avatars 清单、presets 清单三个来源，
  // 任一为 undefined 都会在渲染期炸掉整个面板（2026-09-12 空白面板事故的同型风险）。
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'pure' },
        wallpaper: {
          source: '', light: '', dark: '', blur: 0, scrim: 0,
          fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
          surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
        },
        avatar: { source: '/appearance/avatar/avatar-lz3k9q-4f2a1b.png' },
        motion: { enabled: false, preset: 'fluid', scale: 1 },
        conversation: { density: 'comfortable', maxWidth: 0 },
      },
      revision: 4,
      persistent: true,
    },
    null, null, false, null,
    { local: ['avatar-lz3k9q-4f2a1b.png', 'avatar-other-abcdef.png', 'preset-default.png'] },
    {
      presets: [
        { id: 'default', label: '默认', file: 'preset-default.png', url: '/appearance/avatar/preset-default.png' },
        { id: 'portrait', label: '头像', file: 'preset-portrait.png', url: '/appearance/avatar/preset-portrait.png' },
        { id: 'illustration', label: '立绘', file: 'preset-illustration.png', url: '/appearance/avatar/preset-illustration.png' },
        { id: 'current', label: '现行', file: 'preset-current.png', url: '/appearance/avatar/preset-current.png' },
      ],
    },
    null,
  ]
  try {
    const element = view()
    assert.notEqual(element, null)
    const texts = collectText(element)
    assert.equal(texts.includes('应用图标'), true, '板块标题必须渲染')
    assert.equal(texts.includes('上传图片…'), true, '上传按钮必须渲染')
    assert.equal(texts.includes('清除'), true)
    // 预设九宫格：名称与格子数（四款：默认 / 头像 / 立绘 / 现行）
    assert.equal(texts.includes('默认'), true, '预设名称必须渲染')
    assert.equal(texts.includes('头像'), true)
    assert.equal(texts.includes('立绘'), true)
    assert.equal(texts.includes('现行'), true)
    const cells = collectNodes(element, node => typeof node.props.className === 'string' && node.props.className.startsWith('mia-iconCell'))
    assert.equal(cells.length, 4, '四款预设 → 四个格子')
    // 「我的上传」V1 起走选择丸 + 官方 Menu：选项在 Menu 的 items prop 里（stub 不渲染子组件），
    // 因此断言 items 而非文本节点。
    const avatarMenu = collectNodes(element, node => node.type === primitivesStub.Menu
      && Array.isArray(node.props.items)
      && node.props.items.some(item => item.id === '' && item.label === '不使用'))
    assert.equal(avatarMenu.length, 1, '我的上传必须渲染成一个选择丸菜单')
    const itemIds = avatarMenu[0].props.items.map(item => item.id)
    assert.equal(itemIds.includes(''), true, '「不使用」必须在菜单里')
    assert.equal(itemIds.includes('/appearance/avatar/avatar-lz3k9q-4f2a1b.png'), true, '用户自己的文件必须在清单里')
    assert.equal(itemIds.includes('/appearance/avatar/avatar-other-abcdef.png'), true, '第二个用户文件也必须在')
    // 预设文件不得混进「我的上传」（否则用户会看到一堆系统生成的条目）
    assert.equal(itemIds.some(id => id.includes('preset-default.png')), false, '预设文件不进「我的上传」')
    // 当前选中值同步给 Menu（官方 Menu 的 selectedId 负责勾选态）
    assert.equal(avatarMenu[0].props.selectedId, '/appearance/avatar/avatar-lz3k9q-4f2a1b.png')
  } finally {
    react.stateQueue = null
  }
})

test('面板渲染冒烟：九宫格按 avatar.source 点亮选中格', () => {  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  const presetUrl = '/appearance/avatar/preset-portrait.png'
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'pure' },
        wallpaper: {
          source: '', light: '', dark: '', blur: 0, scrim: 0,
          fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
          surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
        },
        avatar: { source: presetUrl },
        motion: { enabled: false, preset: 'fluid', scale: 1 },
        conversation: { density: 'comfortable', maxWidth: 0 },
      },
      revision: 5,
      persistent: true,
    },
    null, null, false, null, { local: [] },
    {
      presets: [
        { id: 'default', label: '默认', file: 'preset-default.png', url: '/appearance/avatar/preset-default.png' },
        { id: 'portrait', label: '头像', file: 'preset-portrait.png', url: presetUrl },
      ],
    },
    null,
  ]
  try {
    const element = view()
    const active = collectNodes(element, node => typeof node.props.className === 'string' && node.props.className.includes('is-active'))
    assert.equal(active.length, 1, '有且只有一个选中格')
    assert.equal(active[0].props['aria-pressed'], true)
    const imgs = collectNodes(element, node => node.type === 'img')
    assert.equal(imgs.some(img => img.props.src === presetUrl), true, '格子用 host 的同源路由做预览')
  } finally {
    react.stateQueue = null
  }
})

test('面板渲染冒烟：host 未下发 avatar 字段时给重启提示而非崩溃', () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  // 旧 host：config 里没有 avatar（client 先更新、host 未重启的真实形态）
  react.stateQueue = [
    {
      config: {
        enabled: false,
        theme: { skin: 'pure' },
        wallpaper: {
          source: '', light: '', dark: '', blur: 0, scrim: 0,
          fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
          surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
        },
        motion: { enabled: false, preset: 'fluid', scale: 1 },
        conversation: { density: 'comfortable', maxWidth: 0 },
      },
      revision: 1,
      persistent: true,
    },
    { ok: false, issues: [{ level: 'warn', code: 'avatar-host-stale', message: '请重启 dsh web' }] },
    null, false, null, null, null, null,
  ]
  try {
    const element = view()
    assert.notEqual(element, null)
    const texts = collectText(element)
    assert.equal(texts.some(t => t.includes('重启 dsh web')), true, '必须给出重启提示')
    assert.equal(texts.includes('上传图片…'), false, 'host 未更新时不渲染会写不进去的上传按钮')
  } finally {
    react.stateQueue = null
  }
})

// ── 2026-09-23 实机空白事故的回归闸门 ────────────────────────────────────────
// 事故：client.js 用旧版 primitives 图标名（`IconLightOutline16` 等带尺寸后缀），
// 而前端壳 seed 的导出是 `Icon<名称>Outline<Medium|Regular>`（尺寸走 props）——
// 引用拿到 undefined，`React.createElement(undefined, …)` 在面板首渲染即抛，
// 槽位错误边界把整个外观栏罚下（abdicate），设置页留下一个空 stub。
// 注册期契约测试抓不到（slots.inject 回调不执行），stub 冒烟也抓不到
// （stub 用同错名顶替）。下面两条把这两个盲区都堵死。

test('primitives 引用闭环：client.js 用到的每个名字都在 stub 白名单里', () => {
  // stub 白名单即「seed 导出名」的本仓镜像；新增/改名 primitives 引用必须同步这里。
  const used = [...new Set([...source.matchAll(/primitives\.(\w+)/g)].map(m => m[1]))]
  assert.ok(used.length > 0, 'client.js 必须经 primitives 官方原语构造控件')
  const missing = used.filter(name => !Object.hasOwn(primitivesStub, name))
  assert.deepEqual(missing, [], `这些 primitives 引用不在白名单里（seed 未导出即为 undefined，首渲染即崩）：${missing.join(', ')}`)
})

test('primitives 图标命名合规：无尺寸后缀（seed 只有 Medium/Regular 两档）', () => {
  for (const name of Object.keys(primitivesStub)) {
    if (!name.startsWith('Icon')) continue
    assert.match(name, /^Icon\w+Outline(?:Medium|Regular)$/,
      `图标名 ${name} 不符合 seed 命名约定 Icon<名称>Outline<Medium|Regular>（尺寸后缀名在 seed 里不存在）`)
  }
})

/** 会话效果层 CSS 正文：从 bundle 源里截出 CONV_CSS 模板字面量（M4 合规断言用）。 */
const CONV_CSS_SOURCE = (() => {
  const start = source.indexOf('const CONV_CSS = `')
  assert.notEqual(start, -1, 'client.js 必须定义 CONV_CSS 模板字面量')
  const end = source.indexOf('`\n    /** 会话密度选项', start)
  assert.notEqual(end, -1)
  return source.slice(start, end)
})()

test('M4 会话效果层 CSS 合规：只写官方变量与属性锚点、原生档不注入、reduced-motion 降级', () => {
  // M4 锚点纪律（vendor 取证结论，逐条可复核）：
  //   [data-chat-flow]  = ChatView 消息列自身属性锚点（覆盖 --dsh-chat-content-width
  //                        赢 ConversationRoot.body 的官方定义——比它更深）
  //   --dsh-chat-flow-gap    = 官方消息流间距变量（ChatView.column，fallback 16px）
  //   --dsw-font-family      = 官方正文字体族变量（ui-theme base.css；slot 限定只影响会话）
  //   [data-streaming]       = ui-chat AssistantMarkdown 流式事实属性
  //   blockquote / pre       = markdown 渲染器输出的原生语义标签（ui-primitives）
  assert.match(CONV_CSS_SOURCE, /html\[data-mia-cv-density="compact"\] \[data-chat-flow\]\{--dsh-chat-flow-gap:8px\}/, '密度走官方间距变量（compact = 8px）')
  assert.match(CONV_CSS_SOURCE, /html\[data-mia-cv-width="on"\] \[data-chat-flow\]\{--dsh-chat-content-width:var\(--mia-cv-width,920px\)\}/, '宽度走官方内容宽度变量（连续值）')
  assert.match(CONV_CSS_SOURCE, /html\[data-mia-cv-font="serif"\] \[data-slot="main.conversation"\]\{--dsw-font-family:/, '衬线档只覆盖会话子树内的正文字体族')
  assert.match(CONV_CSS_SOURCE, /html\[data-mia-cv-font="mono"\] \[data-slot="main.conversation"\]\{--dsw-font-family:/, '等宽档同款')
  assert.doesNotMatch(CONV_CSS_SOURCE, /--dsh-content-font-size/, '官方字号变量一行不碰（那是「通用」设置页的 FontSizeRow）')
  // 流式光标：挂官方流式属性 + 品牌静态端取色 + 禁止清单
  assert.match(CONV_CSS_SOURCE, /\[data-mia-cv-cursor\] \[data-slot="main.conversation"\] \[data-streaming\] > \*:last-child > \*:last-child::after\{/, '光标挂流式正文末块（两层 last-child）')
  assert.match(CONV_CSS_SOURCE, /background:var\(--dsw-static-deepseek-500\)/, '光标色与官方流式状态行 shimmer 同源')
  assert.match(CONV_CSS_SOURCE, /@keyframes mia-cv-blink\{50%\{opacity:0\}\}/)
  assert.match(CONV_CSS_SOURCE, /@media \(prefers-reduced-motion: reduce\)\{[\s\S]*animation:none/, 'reduced-motion 禁闪烁')
  // 引用与代码块：default 档不注入；plain / strong 两套规则
  assert.match(CONV_CSS_SOURCE, /html\[data-mia-cv-qc="plain"\] \[data-slot="main.conversation"\] blockquote\{border-left:none;padding-left:16px\}/)
  assert.match(CONV_CSS_SOURCE, /html\[data-mia-cv-qc="strong"\] \[data-slot="main.conversation"\] blockquote\{border-left:3px solid var\(--dsw-static-deepseek-500\);background:var\(--dsw-alias-markdown-inline-code\);padding:8px 14px\}/)
  assert.match(CONV_CSS_SOURCE, /html\[data-mia-cv-qc="plain"\] \[data-slot="main.conversation"\] pre\{padding:12px\}/)
  assert.match(CONV_CSS_SOURCE, /html\[data-mia-cv-qc="strong"\] \[data-slot="main.conversation"\] pre\{padding:20px\}/)
  // 禁止清单与 M3 同款：不抢官方 transition、不写哈希类名
  assert.doesNotMatch(CONV_CSS_SOURCE, /transition/, '只做声明式规则，不碰官方 transition')
  assert.doesNotMatch(CONV_CSS_SOURCE, /linear/, '禁 linear 缓动（闪烁走 steps）')
  // 注入与去重在源码层可见（data-plugin-css 同构）
  assert.match(source, /const CONV_CSS_ID = '@miasaki\/dsh-appearance\/conversation\.css'/)
  assert.match(source, /tag\.dataset\.pluginCss = CONV_CSS_ID/, '会话效果层注入与动效层同构（按 id 去重）')
})

test('M4 会话效果板块：密度 / 宽度 / 字体 / 流式光标 / 光标样式 / 引用与代码块', () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'pure' },
        wallpaper: {
          source: '', light: '', dark: '', blur: 0, scrim: 0,
          fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
          surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
        },
        avatar: { source: '' },
        motion: { enabled: false, preset: 'fluid', scale: 1, bootSplash: 'auto' },
        conversation: { density: 'compact', maxWidth: 1080, font: 'serif', cursor: 'block', quoteCode: 'strong' },
      },
      revision: 12,
      persistent: true,
    },
    null, null, false, null, { local: [] }, { presets: [] }, null,
  ]
  try {
    const element = view()
    const texts = collectText(element)
    for (const title of ['会话效果', '消息密度', '会话最大宽度', '正文字体', '流式光标', '光标样式', '引用与代码块']) {
      assert.equal(texts.includes(title), true, `「${title}」行必须在`)
    }
    assert.equal(texts.includes('会话效果（M4，未实现）'), false, '占位文案必须消失')
    // 流式光标开关（官方 Switch，各带无障碍名）
    const cursorSwitch = collectNodes(element, node => node.type === primitivesStub.Switch && node.props.label === '流式光标')
    assert.equal(cursorSwitch.length, 1, '流式光标必须是官方 Switch')
    assert.equal(cursorSwitch[0].props.checked, true, 'cursor=block 时开关为开')
    // 四个单选行走选择丸 + Menu，菜单项 = host 白名单（防「UI 少给选项」静默降级）
    const menus = collectNodes(element, node => node.type === primitivesStub.Menu)
    const idsOf = wanted => [...menus.find(menu => menu.props.items.some(item => item.id === wanted)).props.items].map(item => item.id)
    assert.deepEqual(idsOf('compact'), [...DENSITIES], '密度菜单 = 白名单')
    assert.deepEqual(idsOf('serif'), [...FONTS], '字体菜单 = 白名单')
    assert.deepEqual(idsOf('block'), [...CURSOR_STYLES].filter(id => id !== 'off'), '光标样式菜单 = 白名单（不含 off）')
    assert.deepEqual(idsOf('strong'), [...QUOTE_CODE_LEVELS], '引用与代码块菜单 = 白名单')
    // 当前值同步给 Menu（selectedId）
    for (const wanted of ['compact', 'serif', 'block', 'strong']) {
      assert.equal(menus.find(menu => menu.props.selectedId === wanted).props.selectedId, wanted, `${wanted} 必须是当前选中值`)
    }
    // 宽度步进器（官方 stepper 规格）+ px 单位（单位收在控件内）
    const widthStepper = collectNodes(element, node => typeof node.props.className === 'string' && node.props.className === 'mia-stepper'
      && collectNodes(node, n => n.props['aria-label'] === '增大会话最大宽度').length > 0)
    assert.equal(widthStepper.length, 1, '会话最大宽度必须是步进器')
    assert.equal(collectNodes(widthStepper[0], n => n.type === 'span' && n.props.className === 'mia-unit').length, 1, '宽度带 px 单位')
  } finally {
    react.stateQueue = null
  }
  // 总开关关闭 ⇒ 整组禁用（与动效组同一「关掉即原生」门控）
  react.stateQueue = [
    {
      config: {
        enabled: false,
        theme: { skin: 'pure' },
        wallpaper: {
          source: '', light: '', dark: '', blur: 0, scrim: 0,
          fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
          surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
        },
        avatar: { source: '' },
        motion: { enabled: false, preset: 'fluid', scale: 1, bootSplash: 'auto' },
        conversation: { density: 'compact', maxWidth: 1080, font: 'serif', cursor: 'block', quoteCode: 'strong' },
      },
      revision: 13,
      persistent: true,
    },
    null, null, false, null, { local: [] }, { presets: [] }, null,
  ]
  try {
    const element = view()
    // 只断 M4 组的四个单选（皮肤/壁纸组按既有设计不随总开关禁用——那条路径由
    // 「关掉即原生」的 CSS 门控保证，不禁用是刻意留给总开关关闭时仍可预览配置的）。
    const menus = collectNodes(element, node => node.type === primitivesStub.Menu)
    const convMenus = menus.filter(menu => ['compact', 'serif', 'block', 'strong'].includes(menu.props.selectedId))
    assert.equal(convMenus.length, 4, 'M4 四个选择丸（密度/字体/光标样式/引用与代码块）')
    for (const menu of convMenus) {
      assert.equal(menu.props.anchor.props.disabled, true, '总开关关闭时 M4 选择丸禁用')
    }
    const arrows = collectNodes(element, node => node.type === 'button' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('增大会话最大宽度'))
    assert.equal(arrows[0].props.disabled, true, '总开关关闭时宽度步进器禁用')
  } finally {
    react.stateQueue = null
  }
})

test('M4 会话效果层行为：档位属性与宽度变量随配置写入，原生档不写，关闭即全清', async () => {
  // apply() 里 syncConversation() 经 fetch stub 拉配置后调 applyConversation。
  // 三个场景各自独立 capture（新 VM + 新 documentElement 记录）互不污染。
  // ① 全定制档 ⇒ 五个 html 属性 + 宽度变量
  {
    const { descriptor, elementCalls } = capture()
    const ctx = fakeCtx()
    CONV_FETCH_CONFIG.conversation = { density: 'compact', maxWidth: 1080, font: 'serif', cursor: 'block', quoteCode: 'strong' }
    descriptor.factory(requireStub).apply(ctx)
    await flushAsync()
    assert.equal(elementCalls.props['data-mia-cv-density'], 'compact')
    assert.equal(elementCalls.props['data-mia-cv-font'], 'serif')
    assert.equal(elementCalls.props['data-mia-cv-cursor'], 'block')
    assert.equal(elementCalls.props['data-mia-cv-qc'], 'strong')
    assert.equal(elementCalls.props['data-mia-cv-width'], 'on')
    assert.equal(elementCalls.props['style:--mia-cv-width'], '1080px')
  }
  // ② 全原生档（comfortable/system/off/default/0）⇒ 一个属性都不写（官方观感）
  {
    const { descriptor, elementCalls } = capture()
    const ctx = fakeCtx()
    CONV_FETCH_CONFIG.conversation = { density: 'comfortable', maxWidth: 0, font: 'system', cursor: 'off', quoteCode: 'default' }
    descriptor.factory(requireStub).apply(ctx)
    await flushAsync()
    for (const name of ['data-mia-cv-density', 'data-mia-cv-font', 'data-mia-cv-cursor', 'data-mia-cv-qc', 'data-mia-cv-width']) {
      assert.equal(Object.hasOwn(elementCalls.props, name), false, `${name} 在原生档下不得写入`)
    }
    assert.equal(Object.hasOwn(elementCalls.props, 'style:--mia-cv-width'), false, '宽度 0 = 官方默认，不写变量')
  }
  // ③ 总开关关闭（含旧 host 无 conversation 板块）⇒ 三层全清
  for (const withoutBoard of [false, true]) {
    const { descriptor, elementCalls } = capture()
    const ctx = fakeCtx()
    CONV_FETCH_CONFIG.conversation = { density: 'compact', maxWidth: 1080, font: 'serif', cursor: 'block', quoteCode: 'strong' }
    CONV_FETCH_CONFIG.enabled = false
    if (withoutBoard) delete CONV_FETCH_CONFIG.conversation
    descriptor.factory(requireStub).apply(ctx)
    await flushAsync()
    for (const name of ['data-mia-cv-density', 'data-mia-cv-font', 'data-mia-cv-cursor', 'data-mia-cv-qc', 'data-mia-cv-width']) {
      assert.equal(Object.hasOwn(elementCalls.props, name), false, '关闭时必须移除档位属性')
    }
    assert.equal(elementCalls.removed.includes('style:--mia-cv-width'), true, '关闭时必须清掉宽度变量')
  }
  // 还原夹具（其它用例的 CONV_FETCH_CONFIG 默认态）
  CONV_FETCH_CONFIG.enabled = true
  CONV_FETCH_CONFIG.conversation = { density: 'comfortable', maxWidth: 0, font: 'system', cursor: 'off', quoteCode: 'default' }
})

test('渲染树无 undefined/null 元素类型（空白色事故的直接签名）', () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  // 驱动到「配置已加载 + 图标板块就绪」的完整渲染路径（步进器/九宫格全经过）。
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'pure' },
        wallpaper: {
          source: 'builtin:dusk', light: '', dark: '', blur: 0, scrim: 20,
          fit: 'cover', focus: 'center', glass: 'frost', vignette: 0,
          surface: { sidebar: 75, conversation: 70, composer: 80, overlay: 90 },
        },
        avatar: { source: '/appearance/avatar/preset-default.png' },
        motion: { enabled: false, preset: 'fluid', scale: 1 },
        conversation: { density: 'comfortable', maxWidth: 0 },
      },
      revision: 6,
      persistent: true,
    },
    null, null, false, null, { local: [] },
    { presets: [{ id: 'default', label: '默认', file: 'preset-default.png', url: '/appearance/avatar/preset-default.png' }] },
    null,
  ]
  try {
    const element = view()
    assert.notEqual(element, null)
    const bad = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return
      if (Array.isArray(node)) { for (const child of node) walk(child); return }
      if (typeof node !== 'object') return
      const type = node.type
      if (type === undefined || type === null) bad.push(JSON.stringify(node.props?.className ?? node.props?.['aria-label'] ?? '(anonymous)'))
      if (Array.isArray(node.children)) for (const child of node.children) walk(child)
    }
    walk(element)
    assert.deepEqual(bad, [], `渲染树里出现 undefined/null 元素类型（React 会整棵抛错）：${bad.join(' | ')}`)
  } finally {
    react.stateQueue = null
  }
})

// ---------------------------------------------------------------------------
// 静默失效 #10（2026-09-30）：M4 锚点失配必须**说出来**
//
// M4 的密度 / 最大宽度落在官方内部 DOM（`[data-chat-flow]`）与官方 CSS 变量上。官方升级改了
// 锚点名时，设置项会**静默失效**：面板可点、保存成功、界面零变化 —— 用户只能说「开了没用」。
// 本组钉住三态：只在**能确定**失配时提示，其余一律不打扰。
// ---------------------------------------------------------------------------

const ANCHOR_OK_SELECTOR = sel =>
  ((sel === '[data-slot="main.conversation"]' || sel === '[data-chat-flow]') ? {} : null)

/** 驱动到「配置已加载 + 指定锚点探测形态」的面板渲染，返回渲染树全文。 */
function renderWithAnchorProbe(opts) {
  const cap = capture(opts)
  const ctx = fakeCtx()
  cap.descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  if (opts.widthOn !== false) cap.document.documentElement.setAttribute('data-mia-cv-width', 'on')
  if (opts.compactOn === true) cap.document.documentElement.setAttribute('data-mia-cv-density', 'compact')
  react.stateQueue = [
    {
      config: {
        enabled: true,
        theme: { skin: 'pure' },
        wallpaper: {
          source: '', light: '', dark: '', blur: 0, scrim: 0,
          fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
          surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
        },
        avatar: { source: '' },
        motion: { enabled: false, preset: 'fluid', scale: 1 },
        conversation: {
          density: opts.compactOn === true ? 'compact' : 'comfortable',
          maxWidth: opts.maxWidth ?? 920,
          font: 'system', cursor: 'off', quoteCode: 'default',
        },
      },
      revision: 1,
      persistent: true,
    },
    null, null, false, null, null, null, null,
  ]
  try {
    return collectText(view()).join('\n')
  } finally {
    react.stateQueue = null
  }
}

test('#10：锚点失配（读不到我们写的覆盖值）⇒ 面板显式提示，不再静默失效', () => {
  const text = renderWithAnchorProbe({
    querySelector: ANCHOR_OK_SELECTOR,
    getComputedStyle: () => ({
      getPropertyValue: name => (name === '--mia-cv-width' ? '920px'
        : name === '--dsh-chat-content-width' ? '760px' // 官方锚点没吃到我们的值
          : name === '--dsh-chat-flow-gap' ? '16px'
            : ''),
    }),
  })
  assert.match(text, /的设置未生效/, '失配必须说出来（这正是「开了没用」的根因形态）')
  assert.match(text, /会话最大宽度/, '要点名是哪一项')
  assert.match(text, /data-chat-flow/, '要给出锚点名，便于对照官方升级说明')
})

test('#10：锚点正常（读到的就是我们的值）⇒ 不提示', () => {
  const text = renderWithAnchorProbe({
    querySelector: ANCHOR_OK_SELECTOR,
    getComputedStyle: () => ({
      getPropertyValue: name => (name === '--mia-cv-width' ? '920px'
        : name === '--dsh-chat-content-width' ? '920px'
          : name === '--dsh-chat-flow-gap' ? '8px'
            : ''),
    }),
  })
  assert.doesNotMatch(text, /的设置未生效/, '正常路径不得产生噪声')
})

test('#10：无法判定（消息列还没渲染）⇒ 不提示（避免误报）', () => {
  const text = renderWithAnchorProbe({
    // 只有会话槽位、没有 [data-chat-flow]：会话可能还没有消息，不能据此断言失配
    querySelector: sel => (sel === '[data-slot="main.conversation"]' ? {} : null),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  })
  assert.doesNotMatch(text, /的设置未生效/)
})

test('#10：没开依赖该锚点的项 ⇒ 不提示', () => {
  const text = renderWithAnchorProbe({
    widthOn: false,
    compactOn: false,
    maxWidth: 0,
    querySelector: ANCHOR_OK_SELECTOR,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  })
  assert.doesNotMatch(text, /的设置未生效/)
})

// ---------------------------------------------------------------------------
// 静默失效 #8（2026-09-30 补全）：「无可见效果」提示的**全量判定**
//
// 首版只覆盖一种形状（pure + 壁纸 + 表面全不透明 ⇒ 三层互相抵消），漏了更常见的一种：
// **总开关开着、所有项都停在原生档** —— 页面同样是零变化，却没有提示，用户只能以为功能坏了。
// 本组把判据扩成「本线会不会产生任何可见变化」，并按成因给不同指引。
// ---------------------------------------------------------------------------

/** 以给定配置渲染面板，返回渲染树文本（state 队列长度 = 8）。 */
function renderPanelReturningText(config) {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  react.stateQueue = [{ config, revision: 1, persistent: true }, null, null, false, null, null, null, null]
  try {
    return collectText(view()).join('\n')
  } finally {
    react.stateQueue = null
  }
}

/** 原生档基线：总开关开着，但每一项都停在官方默认。 */
function nativeConfig(over) {
  return {
    // host 下发的配置**一定**带 version（sanitizeConfig 补的）；夹具照抄，否则导出名/迁移判据失真
    version: 7,
    enabled: true,
    theme: { skin: 'pure' },
    wallpaper: {
      source: '', light: '', dark: '', blur: 0, scrim: 0,
      fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
      surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
    },
    avatar: { source: '' },
    // bootSplash 必须与 CONV_DEFAULTS 的出厂值一致（'auto'）—— 否则「全原生档」会被
    // P4 的恢复按钮判定当成「非默认」，两个夹具就此不自洽（首版即踩：写成了 'off'）。
    motion: { enabled: false, preset: 'fluid', scale: 1, bootSplash: 'auto' },
    conversation: { density: 'comfortable', maxWidth: 0, font: 'system', cursor: 'off', quoteCode: 'default' },
    // 启动片头（v7）同理：必须等于出厂档，否则 P4 会在启动板块凭空长出一枚恢复按钮，
    // 而「全原生档」用例（#8）断言的正是「一个恢复按钮都不出现」。
    boot: { intro: 'brand', audio: false },
    ...over,
  }
}

test('#8：总开关开着但全原生档 ⇒ 提示出现，且说清「不是 bug，是没配」', () => {
  const text = renderPanelReturningText(nativeConfig())
  assert.match(text, /当前配置下外观没有可见变化/, '零变化必须给指引')
  assert.match(text, /所有项都停在原生档/, '要说明成因（而非只说「三层抵消」）')
  assert.match(text, /皮肤换「刻刻帝/, '要给可操作的第一步')
})

test('#8：壁纸被 100% 不透明表面完全挡住 ⇒ 提示改用「三层抵消」文案', () => {
  const text = renderPanelReturningText(nativeConfig({
    wallpaper: {
      source: 'builtin:aurora', light: '', dark: '', blur: 0, scrim: 10,
      fit: 'cover', focus: 'center', glass: 'mica', vignette: 10,
      surface: { sidebar: 100, conversation: 100, composer: 100, overlay: 100 },
    },
  }))
  assert.match(text, /当前配置下外观没有可见变化/)
  assert.match(text, /壁纸被 100% 不透明的表面挡住/, '配了壁纸却看不见 ⇒ 另一种成因')
  assert.doesNotMatch(text, /所有项都停在原生档/, '成因不能张冠李戴')
})

test('#8：任一项有可见效果 ⇒ 不提示（皮肤 / 壁纸可见 / 动效 / 会话效果）', () => {
  const wallVisible = {
    source: 'builtin:aurora', light: '', dark: '', blur: 0, scrim: 10,
    fit: 'cover', focus: 'center', glass: 'off', vignette: 10,
    surface: { sidebar: 80, conversation: 100, composer: 100, overlay: 100 },
  }
  const conv = (over) => ({ density: 'comfortable', maxWidth: 0, font: 'system', cursor: 'off', quoteCode: 'default', ...over })
  const cases = {
    '皮肤非纯净': nativeConfig({ theme: { skin: 'zafkiel' } }),
    '壁纸可见（表面降到 80）': nativeConfig({ wallpaper: wallVisible }),
    '动效开着': nativeConfig({ motion: { enabled: true, preset: 'fluid', scale: 1, bootSplash: 'off' } }),
    '密度紧凑': nativeConfig({ conversation: conv({ density: 'compact' }) }),
    '宽度非 0': nativeConfig({ conversation: conv({ maxWidth: 800 }) }),
    '字体非默认': nativeConfig({ conversation: conv({ font: 'serif' }) }),
    '光标开启': nativeConfig({ conversation: conv({ cursor: 'bar' }) }),
    '引用样式非默认': nativeConfig({ conversation: conv({ quoteCode: 'plain' }) }),
  }
  for (const [name, config] of Object.entries(cases)) {
    assert.doesNotMatch(renderPanelReturningText(config), /没有可见变化/, `${name} 是可见变化，不该提示`)
  }
})

test('#8：总开关关闭 ⇒ 不提示（「关掉即原生」，此刻本就没有外观层）', () => {
  assert.doesNotMatch(renderPanelReturningText(nativeConfig({ enabled: false })), /没有可见变化/)
})

test('#8：旧 host 缺 conversation 板块（v5 前配置）⇒ 不崩，且其余判据照常', () => {
  const withSkin = nativeConfig({ theme: { skin: 'kurkuriel' } })
  delete withSkin.conversation
  assert.doesNotMatch(renderPanelReturningText(withSkin), /没有可见变化/, '皮肤非纯净 ⇒ 有可见变化')

  const pureSkin = nativeConfig()
  delete pureSkin.conversation
  assert.match(renderPanelReturningText(pureSkin), /所有项都停在原生档/, '缺板块不得抛错，其余判据照常工作')
})

// ---------------------------------------------------------------------------
// P4 每板块「恢复默认」（2026-09-30，路线见 2026-09-26-visual-unification-and-roadmap 的 P4）
//
// 三条要钉住的事：
//   ① 默认值**只能来自 host 下发的 `state.defaults`** —— 客户端另行硬编码一份必然漂移，
//      而漂移的后果是「恢复默认」把配置恢复成**旧版**默认值（比没有恢复更糟）；
//   ② 板块与默认相同 ⇒ **不渲染**按钮（省噪声）；不同 ⇒ 渲染，且点击走既有 save 路径；
//   ③ 旧 host 不下发 defaults ⇒ 给提示而不是静默失效（本线既有处理方式）。
// ---------------------------------------------------------------------------

/** 渲染面板并返回 { text, nodes, cap }（state 队列长度 = 8；cap 含 fetch 调用记录）。 */
function renderPanel(config, defaults) {
  const cap = capture(defaults === undefined ? {} : { defaults })
  const ctx = fakeCtx()
  cap.descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  react.stateQueue = [{
    config,
    // host 的 /state 会把 DEFAULT_CONFIG 一并下发；这里同步注入（传 null = 模拟旧 host 不下发）
    defaults: defaults === undefined ? CONV_DEFAULTS : defaults,
    revision: 1,
    persistent: true,
  }, null, null, false, null, null, null, null]
  try {
    const tree = view()
    return { text: collectText(tree).join('\n'), nodes: collectNodes(tree, () => true), cap }
  } finally {
    react.stateQueue = null
  }
}

test('P4：板块非默认 ⇒ 出现「恢复默认」按钮，点击后把**host 下发的**出厂值发出去', async () => {
  const { text, nodes, cap } = renderPanel(nativeConfig({ theme: { skin: 'zafkiel' } }))
  assert.match(text, /恢复「主题」的默认设置/, '非默认板块必须给出恢复入口')
  assert.doesNotMatch(text, /恢复「壁纸」的默认设置/, '与默认相同的板块不该有按钮')

  const button = nodes.find(n => Array.isArray(n.children)
    && n.children.some(c => c === '恢复「主题」的默认设置'))
  assert.notEqual(button, undefined, '按钮必须在渲染树上')
  button.props.onClick()
  await flushAsync()

  // 恢复默认走的是**既有保存路径**（POST /config，带 expectedRevision 的乐观并发），
  // 且带的是 host 下发的默认值 —— 这正是「客户端不另存一份默认值」的可观测证据。
  const posts = cap.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/config'))
  assert.equal(posts.length, 1, '点击应触发一次保存')
  const body = JSON.parse(posts[0].body)
  assert.deepEqual(body.patch.theme, CONV_DEFAULTS.theme, '必须恢复成 host 下发的出厂皮肤')
  assert.deepEqual(body.patch.theme, { skin: 'pure' })
})

test('P4：全部板块都等于默认 ⇒ 一个恢复按钮都不出现', () => {
  const { text } = renderPanel(nativeConfig())
  assert.doesNotMatch(text, /恢复「.*」的默认设置/)
})

test('P4：旧 host 不下发 defaults ⇒ 给「重启宿主」提示，而不是静默失效', () => {
  const { text } = renderPanel(nativeConfig({ theme: { skin: 'zafkiel' } }), null)
  assert.match(text, /宿主未提供出厂默认值（旧版宿主的形态），重启宿主后即可用/)
  assert.doesNotMatch(text, /恢复「主题」的默认设置/, '没有默认值就不该给按钮（点了也不知恢复成什么）')
})

test('P4：默认值不得在客户端硬编码（防「恢复成旧版默认」这种漂移）', () => {
  assert.doesNotMatch(source, /skin: 'pure'[\s\S]{0,120}version: CONFIG_VERSION/, '客户端不得自造一份 DEFAULT_CONFIG')
  // 默认值的唯一来源：host 的 /state 下发的 state.defaults
  assert.match(source, /state\.defaults/, '恢复默认必须读 host 下发的默认值')
  assert.match(source, /SECTION_LABELS/, '按钮措辞与组标题一致（集中一份字典，不散落）')
})

// ---------------------------------------------------------------------------
// 启动片头（v7）：跨线字段的面板半（design/2026-10-04-boot-intro-video.md §5-D10）
//
// 本组钉住四件事：① 板块在位，且值域与 lib/config.js 的 INTRO_CLIPS 逐字一致（跨线契约的
// 面板半——壳侧 boot_intro.rs 按同一值域校验）；② 旧 host（v6 配置没有 boot 板块）⇒ 给重启
// 提示而不是整面板空白（2026-09-12 / 09-30 两次空白事故同族的防线）；③ 两枚控件各自只发
// 自己那一格的增量 patch（不能连板块兄弟字段一起冲刷）；④ 总开关关闭 ⇒ 控件禁用 —— 与
// splash 同源门控，壳侧读配置时同样据此不播（「关掉即原生」）。
// ---------------------------------------------------------------------------

/** 面板上的启动片头选择丸（Menu 原语的 items 里含 brand 的那一枚）。 */
const bootIntroMenu = nodes => nodes.filter(n => n.type === primitivesStub.Menu
  && Array.isArray(n.props.items) && n.props.items.some(item => item.id === 'brand'))

test('启动板块：片头选择丸 + 声音开关在位，值域与 INTRO_CLIPS 逐字一致', () => {
  const { text, nodes } = renderPanel(nativeConfig())
  assert.match(text, /启动片头/, '行标题必须在位')
  assert.match(text, /片头声音/)
  assert.match(text, /下次启动应用/, '必须写明生效时机（片头不做热重载）')

  const menus = bootIntroMenu(nodes)
  assert.equal(menus.length, 1, '片库必须是官方选择丸（唯一一枚）')
  assert.deepEqual([...menus[0].props.items].map(item => item.id),
    ['off', 'brand', 'cyberpunk', 'awakening', 'startup'],
    '选项 id 必须与 lib/config.js 的 INTRO_CLIPS 一致（跨线值域，壳侧白名单同源）')
  assert.equal(menus[0].props.selectedId, 'brand', '当前值来自配置')

  const sw = nodes.find(n => n.type === primitivesStub.Switch && n.props.label === '片头声音')
  assert.notEqual(sw, undefined, '声音开关必须有无障碍名')
  assert.equal(sw.props.checked, false, '出厂静音')
})

test('启动板块：旧 host（v6 形态，无 boot 板块）⇒ 给重启提示而不是崩面板', () => {
  const config = nativeConfig()
  delete config.boot
  const { text } = renderPanel(config)
  assert.match(text, /本板块需要 v7 配置/, '缺板块必须给人话提示')
  assert.doesNotMatch(text, /启动片头/, '不给控件（免得用户以为设置生效了）')
})

test('启动板块：改片头 / 开声音 ⇒ 各自只发 boot 板块的增量 patch', async () => {
  const { nodes, cap } = renderPanel(nativeConfig())
  const menu = bootIntroMenu(nodes)[0]
  menu.props.onSelect('cyberpunk')
  await flushAsync()
  const sw = nodes.find(n => n.type === primitivesStub.Switch && n.props.label === '片头声音')
  sw.props.onChange(true)
  await flushAsync()

  const posts = cap.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/config'))
  assert.equal(posts.length, 2, '两次操作各发一次保存')
  assert.deepEqual(JSON.parse(posts[0].body).patch, { boot: { intro: 'cyberpunk' } },
    '只发片头那一格，不带 audio')
  assert.deepEqual(JSON.parse(posts[1].body).patch, { boot: { audio: true } },
    '只发声音那一格，不带 intro')
})

test('启动板块：总开关关闭 ⇒ 控件禁用（与 splash 同源门控）', () => {
  const { nodes } = renderPanel(nativeConfig({ enabled: false }))
  const sw = nodes.find(n => n.type === primitivesStub.Switch && n.props.label === '片头声音')
  assert.notEqual(sw, undefined)
  assert.equal(sw.props.disabled, true, '总开关关 ⇒ 声音开关禁用')
  const menu = bootIntroMenu(nodes)[0]
  assert.notEqual(menu, undefined, '选择丸仍在（可提前配置），但锚点按钮禁用')
  // 锚点按钮由 selectControl 以 `anchor` prop 交给官方 Menu（不是 children），故直取
  assert.equal(menu.props.anchor.props.disabled, true, '总开关关 ⇒ 选择丸锚点禁用')
})

// ---------------------------------------------------------------------------
// P5 配置导入 / 导出（2026-09-30）
//
// 路线要求：一段 JSON 下载/上传，**sanitize 全量收窄后整体替换**，**导入前二次确认**。
// 本组钉住四件事：① 导出的是当前配置且带自描述标记；② 导入必须走 replace:true（不是 merge）；
// ③ 二次确认说「取消」/ 无法确认 ⇒ **一个字节都不写**；④ 坏文件给**人话错误**而不是静默失败。
// ---------------------------------------------------------------------------

/** 渲染面板 → 点某个按钮 → 返回夹具（供继续驱动 created 里的元素）。 */
function clickPanelButton(label, opts = {}) {
  const cap = capture(opts)
  const ctx = fakeCtx()
  cap.descriptor.factory(requireStub).apply(ctx)
  const view = ctx.registered[0].view
  react.stateQueue = [{
    config: nativeConfig({ theme: { skin: 'zafkiel' } }),
    defaults: CONV_DEFAULTS,
    revision: 7,
    persistent: true,
  }, null, null, false, null, null, null, null]
  react.setCalls = []
  try {
    const tree = view()
    const button = collectNodes(tree, n => Array.isArray(n.children) && n.children.some(c => c === label))[0]
    assert.notEqual(button, undefined, `面板上应能找到「${label}」`)
    button.props.onClick()
    return cap
  } finally {
    react.stateQueue = null
  }
}

test('P5：导出 —— 下发的 JSON 带自描述标记、版本与当前配置', async () => {
  const cap = clickPanelButton('导出配置…')
  assert.equal(cap.blobs.length, 1, '导出应造出一份 Blob')
  const payload = JSON.parse(cap.blobs[0].parts[0])
  assert.equal(payload.kind, 'miasaki-appearance-config', '自描述标记：导入侧据此识别本线配置')
  // 版本随 CONFIG_VERSION（v7 起含启动片头板块）；夹具 nativeConfig 同步抬版本，
  // 此处硬编码是**有意**的：版本漂移时必须有人来改这一行，而不是让断言跟着实现自动漂。
  assert.equal(payload.version, 7, '带配置版本，便于将来迁移')
  assert.equal(payload.config.theme.skin, 'zafkiel', '导出的是**当前**配置')
  assert.deepEqual(Object.keys(payload.config).sort(), Object.keys(CONV_DEFAULTS).sort(), '导出的是归一化后的完整配置')

  const anchor = cap.created.find(el => el.tagName === 'A')
  assert.notEqual(anchor, undefined, '导出应创建下载锚点')
  assert.match(anchor.download, /^miasaki-appearance-config-v7\.json$/, '文件名带版本，便于区分备份')
  assert.equal(anchor.clicked, true, '必须真的触发下载')
  assert.equal(cap.objectUrls.length, 1, 'objectURL 应被回收（不泄漏）')
})

test('P5：导入 —— 走整体替换（replace:true），不是合并', async () => {
  const cap = clickPanelButton('导入配置…', { confirm: () => true })
  const input = cap.created.find(el => el.type === 'file')
  assert.notEqual(input, undefined, '导入应创建文件选择框')
  assert.match(input.accept, /json/, '文件类型应限定 JSON')
  assert.equal(input.clicked, true, '必须真的弹出选择框')

  const imported = { theme: { skin: 'kurkuriel' } }
  input.files = [{ text: async () => JSON.stringify({ kind: 'miasaki-appearance-config', version: 6, config: imported }) }]
  input.onchange()
  await flushAsync()

  const posts = cap.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/config'))
  assert.equal(posts.length, 1, '确认后应发出一次保存')
  const body = JSON.parse(posts[0].body)
  assert.equal(body.replace, true, '导入必须是整体替换语义（缺的板块回出厂默认）')
  assert.deepEqual(body.patch, imported, '发出的是文件里的配置对象')
  assert.equal(body.expectedRevision, 7, '沿用乐观并发')
})

test('P5：导入的二次确认说「取消」⇒ 一个字节都不写', async () => {
  const cap = clickPanelButton('导入配置…', { confirm: () => false })
  const input = cap.created.find(el => el.type === 'file')
  input.files = [{ text: async () => JSON.stringify({ config: { theme: { skin: 'kurkuriel' } } }) }]
  input.onchange()
  await flushAsync()
  assert.equal(cap.fetches.filter(f => f.method === 'POST').length, 0, '取消导入不得写配置')
})

test('P5：导入坏文件 ⇒ 人话错误且不写；无法弹确认框时同样取消', async () => {
  // ① 不是 JSON
  const bad1 = clickPanelButton('导入配置…', { confirm: () => true })
  const in1 = bad1.created.find(el => el.type === 'file')
  in1.files = [{ text: async () => '{ 这不是 JSON' }]
  in1.onchange()
  await flushAsync()
  assert.equal(bad1.fetches.filter(f => f.method === 'POST').length, 0)
  assert.ok(react.setCalls.some(v => typeof v === 'string' && /不是有效的 JSON/.test(v)), '要给可读错误')

  // ② 顶层不是对象
  const bad2 = clickPanelButton('导入配置…', { confirm: () => true })
  const in2 = bad2.created.find(el => el.type === 'file')
  in2.files = [{ text: async () => '[1,2,3]' }]
  in2.onchange()
  await flushAsync()
  assert.equal(bad2.fetches.filter(f => f.method === 'POST').length, 0)
  assert.ok(react.setCalls.some(v => typeof v === 'string' && /顶层应该是一个对象/.test(v)))

  // ③ 环境无法弹确认框（window.confirm 缺席）⇒ **取消**，而不是静默继续
  const noConfirm = clickPanelButton('导入配置…', { confirm: undefined })
  const in3 = noConfirm.created.find(el => el.type === 'file')
  in3.files = [{ text: async () => JSON.stringify({ theme: { skin: 'kurkuriel' } }) }]
  in3.onchange()
  await flushAsync()
  assert.equal(noConfirm.fetches.filter(f => f.method === 'POST').length, 0, '无法确认时不得继续替换')
  assert.ok(react.setCalls.some(v => typeof v === 'string' && /无法弹出确认框/.test(v)))
})

test('P5：导入兼容裸配置对象（自己手写的 JSON 也能用）', async () => {
  const cap = clickPanelButton('导入配置…', { confirm: () => true })
  const input = cap.created.find(el => el.type === 'file')
  const bare = { wallpaper: { source: 'builtin:aurora', surface: { sidebar: 80 } } }
  input.files = [{ text: async () => JSON.stringify(bare) }]
  input.onchange()
  await flushAsync()
  const posts = cap.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/config'))
  assert.equal(posts.length, 1)
  assert.equal(JSON.parse(posts[0].body).replace, true)
  assert.deepEqual(JSON.parse(posts[0].body).patch, bare)
})
