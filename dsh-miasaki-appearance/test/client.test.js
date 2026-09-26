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

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** 面板 CSS 正文：从 bundle 源里截出 PANEL_CSS 模板字面量，供风格契约断言。 */
const PANEL_CSS_SOURCE = (() => {
  const start = source.indexOf('const PANEL_CSS = `')
  assert.notEqual(start, -1, 'client.js 必须定义 PANEL_CSS 模板字面量')
  const end = source.indexOf('const PANEL_CSS_ID', start)
  assert.notEqual(end, -1)
  return source.slice(start, end)
})()

/** 在 VM 里执行 client.js，捕获装载器收到的描述符。上下文刻意不提供 `module`。 */
function capture() {
  let descriptor = null
  const window = { __ModuleLoader__: { load(d) { descriptor = d } } }
  const document = {
    body: { append() {} },
    // dataset 供面板 CSS 注入打 data-plugin-css 标记（官方 client 插件同一注入式）。
    createElement: () => ({ style: {}, dataset: {}, append() {}, remove() {}, setAttribute() {} }),
    head: { append() {}, appendChild() {} },
    documentElement: { getAttribute: () => null, hasAttribute: () => false, setAttribute() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const context = vm.createContext({ window, document, console })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.notEqual(descriptor, null, 'client.js 必须调用 window.__ModuleLoader__.load()')
  return { descriptor, window, context }
}

// React stub：createElement 保留 children 便于断言；hooks 惰性化，组件可被调用一次。
// stateQueue 非空时 useState 按序弹出初值（渲染冒烟测试用它把组件驱动到"配置已加载"
// 的完整渲染路径——实机空白面板事故发生在该路径，state=null 路径走不到）。
const react = {
  stateQueue: null,
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState(initial) {
    if (this.stateQueue !== null && this.stateQueue.length > 0) return [this.stateQueue.shift(), () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
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
  // M3/M4 占位：官方 models dashed 规格
  assert.match(PANEL_CSS_SOURCE, /\.mia-dashed\{[^}]*border:1px dashed var\(--dsw-alias-border-l3\)/)
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
    // 皮肤 / 壁纸图源 / 玻璃档位 = 3 个（我的上传此时无文件不渲染）
    assert.equal(menus.length, 3, '皮肤/图源/玻璃三个单选行都必须是官方 Menu')
    const selectButtons = collectMenuAnchors(element).filter(node => node.type === 'button')
    assert.equal(selectButtons.length, 3, '三个选择丸触发器')
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
    const units = collectNodes(element, node => node.type === 'span' && node.props.className === 'mia-unit')
    assert.equal(units.length, 0, '字号单位（px）只服务于字号行')
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
