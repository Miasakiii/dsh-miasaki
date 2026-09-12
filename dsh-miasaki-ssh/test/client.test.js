// Contract test for the client half.
//
// 1) DSH's client module loader calls `factory(require)` and hands the return value
//    to cordis as the plugin, so a factory that never returns `module.exports`
//    yields undefined and the whole plugin fails to load with `invalid plugin,
//    expect function or object with an "apply" method, received undefined`
//    — the 2026-09-10 startup failure.
// 2) 入口位置（2026-09-10 调整）：入口必须注册在会话头 actions 槽（第一行，紧跟
//    canvas 的「对话 / 会话布」），而 `conversation.view` 只留页面本身；切换只能委托
//    官方 tab 按钮，且必须「找不到就收手」而不是抛错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Run client.js in a VM whose `window.__ModuleLoader__` captures the descriptor. */
function capture() {
  let descriptor = null
  const styles = []
  const element = () => {
    const node = {
      textContent: '', hidden: false, className: '', type: '', title: '', removed: false,
      children: [],
      style: { setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, getAttribute() { return null },
      addEventListener() {}, removeEventListener() {},
      append(child) { node.children.push(child) },
      remove() { node.removed = true },
      querySelectorAll: () => [],
      querySelector: () => null,
    }
    return node
  }
  const document = {
    createElement: () => element(),
    head: { append(node) { styles.push(node) } },
    body: { append() {} },
    querySelectorAll: () => [],
    querySelector: () => null,
    documentElement: element(),
  }
  const window = {
    __ModuleLoader__: { load(d) { descriptor = d } },
    getComputedStyle: () => ({ paddingLeft: '0px' }),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  }
  const context = vm.createContext({
    window,
    document,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.notEqual(descriptor, null, 'client.js must call window.__ModuleLoader__.load()')
  return { descriptor, window, styles }
}

// React stub: createElement keeps children so a rendered element can be asserted;
// hooks are inert so a component can be invoked once without a renderer.
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: initial => ({ current: initial }),
  useCallback: fn => fn,
  useEffect: () => {},
}
const requireStub = name => {
  if (name === 'react') return react
  throw new Error(`unexpected require: ${name}`)
}

function fakeCtx() {
  const registered = []
  const effects = []
  return {
    registered,
    effects,
    slots: {
      inject(name, callback) { registered.push({ name, ...callback() }) },
      register(meta, view) { return { meta, view } },
    },
    effect(callback, label) { effects.push({ label, dispose: callback() }) },
  }
}

test('client half registers under the package id', () => {
  const { descriptor } = capture()
  assert.equal(descriptor.id, '@miasaki/dsh-ssh')
  assert.equal(typeof descriptor.factory, 'function')
})

test('factory returns the plugin exports', () => {
  const { descriptor } = capture()
  const exports = descriptor.factory(requireStub)
  assert.equal(typeof exports, 'object', 'factory must return module.exports')
  assert.notEqual(exports, null)
  // Spread first: the exports object comes from another VM realm, so its
  // array prototype is not this realm's.
  assert.deepEqual([...exports.inject], ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers the SSH page as a conversation view', () => {
  const { descriptor, window } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)

  assert.equal(window.__DSH_SSH_BOOTED__, true)
  assert.equal(ctx.registered.length, 2, '页面 + 第一行入口，共两项注册')
  const page = ctx.registered.find(row => row.name === 'conversation.view')
  assert.notEqual(page, undefined)
  assert.equal(page.meta.id, 'ssh')
  assert.equal(page.meta.label(), 'SSH')
  assert.equal(page.meta.order, 20)

  const view = page.view()
  assert.equal(view.type, 'iframe')
  assert.equal(view.props.src, '/ssh/')
})

test('入口注册在会话头 actions 槽，order 紧随 canvas 的「对话 / 会话布」', async () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)

  const entry = ctx.registered.find(row => row.name === 'conversation.session.header.actions')
  assert.notEqual(entry, undefined, '入口必须在第一行 actions 槽，而不是第二行 tab 栏')
  assert.equal(entry.meta.id, 'ssh-view-switch')
  assert.equal(entry.meta.order, 26)

  // 与 canvas 的 25 相邻：两条线各自持有自己的 order，谁挪了都会在下一次契约测试里响。
  const canvas = await readFile(new URL('../../dsh-miasaki-canvas/client.js', import.meta.url), 'utf8')
  assert.match(canvas, /id: 'canvas-view-switch',\s*\n\s*order: 25,/, 'canvas 切换器应仍在 order 25')
})

test('入口按钮与 canvas 胶囊同款视觉，且总高守住 30px 的行内高度契约', async () => {
  const { descriptor, styles } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)

  assert.equal(styles.length, 1, '入口样式随 apply 注入一次')
  const css = styles[0].textContent
  assert.match(css, /\.dsh-ssh-switch\{/, '应有自己的容器类，不与 canvas 的选择器串用')
  assert.match(css, /padding:0 3px/, '上下 padding 必须为 0，否则会把官方 titleRow 撑高')
  assert.doesNotMatch(css, /padding:3px/, '不应回退到 3px 上下 padding')
  assert.match(css, /border-radius:999px/, '与 canvas 胶囊同样的圆角')
  assert.match(css, /var\(--dsw-static-deepseek-450/, '配色走 DSH 主题令牌，跟随主题品牌色')
  assert.match(css, /\.dsh-ssh-switch\.is-compact button\{width:28px/, '窄宽度下有图标降级形态')

  const entry = ctx.registered.find(row => row.name === 'conversation.session.header.actions')
  const element = entry.view()
  assert.equal(element.type, 'div')
  assert.equal(element.props.role, 'group')
  assert.equal(element.children.length, 1)
  const button = element.children[0]
  assert.equal(button.type, 'button')
  // 图标形态下按钮没有可见文字，aria-label / title 就是唯一可访问名 —— 必须保留。
  assert.equal(button.props['aria-label'], 'SSH')
  assert.equal(button.props.title, 'SSH')
  assert.equal(typeof button.props.onClick, 'function')
})

test('合成为同一个控件：canvas 段右端打开、本段左端打开、负 margin 吃掉 gap', () => {
  // 两个「同款胶囊」并排仍有 8px 缝，读起来还是两组控件 —— 用户 2026-09-10 二次反馈。
  // 这里全靠纯 CSS 覆盖（canvas 文件一行未改）：canvas 不在场或中间插了别的插件时
  // `+` 不匹配，本段退回完整胶囊（退化方向是「又变回两个胶囊」，不是破版）。
  const { descriptor, styles } = capture()
  descriptor.factory(requireStub).apply(fakeCtx())
  const css = styles[0].textContent
  assert.match(css, /\.dsh-canvas-switch:has\(\+ \.dsh-ssh-switch\)\{border-top-right-radius:0;border-bottom-right-radius:0;border-right:0\}/)
  assert.match(css, /\.dsh-canvas-switch \+ \.dsh-ssh-switch\{margin-left:-8px;border-top-left-radius:0;border-bottom-left-radius:0\}/)
  assert.match(css, /^\.dsh-ssh-switch\{[^}]*border-radius:999px/, '默认形态仍是完整胶囊')
  // 同一个控件里不能同时亮两段：SSH 视图激活时抑制「对话」段的高亮（它此时的语义是
  // 「DSH 原生会话视图」）。:not(:hover) 让 hover 反馈照旧。
  assert.match(css, /\.dsh-canvas-switch:has\(\+ \.dsh-ssh-switch button\.active\) button\[aria-label="对话"\]\.active:not\(:hover\)/)
})

test('点 canvas 的「对话」段时，若停在 SSH 就同时切回默认视图', () => {
  // canvas 的「对话」只管关它自己的浮层，管不了 DSH 的 View：停在 SSH 时点它
  // 屏幕上什么都不会变 —— 合成一个控件之后那就是「点了没反应」，必须补上。
  assert.match(source, /const selectDefaultView = \(\) => \{[\s\S]*?if \(tab\.getAttribute\('aria-selected'\) === 'true'\) return false[\s\S]*?tab\.click\(\)/)
  assert.match(source, /if \(viewIsSsh\(\)\) selectDefaultView\(\)/)
  // 我们自己关浮层时也会点这个按钮：那一下不是用户点的，不能连锁触发「切回默认视图」，
  // 否则点「SSH」会先切 chat 再切 ssh，视图连换两次、iframe 卸两次。
  assert.match(source, /if \(dismissing\) return/)
  assert.match(source, /dismissing = true[\s\S]*?back\.click\(\)[\s\S]*?dismissing = false/)
  assert.match(source, /button\.addEventListener\('click', onDialogClick\)/)
  assert.match(source, /dialogButton\.removeEventListener\('click', onDialogClick\)/, '卸载必须解绑，不能留下悬空监听')
  assert.match(source, /unbindDialogButton\(\)/, 'fiber 拆除时也要解绑')
})

test('在「会话布」页面里也给一个 SSH 入口：走画布的外部视图槽，不加栏', () => {
  // 用户要的是「会话布页面里那组按钮旁边多一个 SSH」，不是页面顶上多一条栏
  // （2026-09-10：「只是让加一个SSH按钮，为什么会多出一整个上栏」）。
  // 那组按钮在画布 iframe 内部，宿主 DOM 碰不到 → 走页面级注册表 + 画布下发。
  assert.match(source, /window\.__DSH_CANVAS_VIEW_ITEMS__/)
  assert.match(source, /const VIEW_ITEM = \{ id: 'ssh', label: VIEW_LABEL \}/)
  assert.match(source, /window\.dispatchEvent\(new CustomEvent\('dsh-canvas:view-items'/)
  // 点击由注册方自己处理：收到画布广播的 canvas:view 就关浮层 + 切视图。
  assert.match(source, /data\.type !== 'canvas:view' \|\| data\.id !== VIEW_ITEM\.id/)
  assert.match(source, /window\.addEventListener\('message', onCanvasView\)/)
  assert.match(source, /window\.removeEventListener\('message', onCanvasView\)/, 'fiber 拆除必须解绑')
  assert.match(source, /canvasViewItems\.splice\(index, 1\)/, '卸载时把自己从注册表摘掉')

  // 上一版那整条上栏必须彻底消失：它会给页面顶盖一条栏，用户明确否掉。
  assert.doesNotMatch(source, /dsh-ssh-canvas-bar/)
  assert.doesNotMatch(source, /\.dsh-canvas-overlay\{top:/, '不应再改画布浮层的几何')
  assert.doesNotMatch(source, /--dsh-ssh-header-h|--dsh-ssh-bar-right/)
})

test('切换只能委托官方 tab 按钮，且找不到就收手（不抛错）', () => {
  // DSH 没有对外暴露 View 切换 API：selectView 只在官方 header 的 inject face 里，
  // actions 子槽的 owner props 是空对象。官方唯一路径就是 tab 按钮的 onClick。
  assert.match(source, /\[role="tablist"\] \[role="tab"\]/)
  assert.match(source, /const selectSsh = \(\) => \{[\s\S]*?if \(tab === null\) return false[\s\S]*?tab\.click\(\)/)
  assert.match(source, /getAttribute\('aria-selected'\) === 'true'/, '激活态读官方 aria-selected')
  // 「会话布」是全屏浮层：切视图前先走 canvas 自己的「对话」按钮关掉它，
  // 这样 canvas 胶囊的激活态也会同步复位（直接改 overlay.hidden 会让它状态不一致）。
  assert.match(source, /\.dsh-canvas-switch button\[aria-label="对话"\]/)
})

test('入口收起官方 tab 栏里的同一个 tab，并在卸载时复原', () => {
  assert.match(source, /tab\.style\.display = 'none'/, '收起用内联 display，React 重渲染不会覆盖')
  // 「能收才收」：找不到 tab（结构变了 / 尚未渲染）就什么都不做 ——
  // 最坏情况退回「双入口」，而不是没入口。
  assert.match(source, /if \(tab === null \|\| tab\.style\.display === 'none'\) return/)
  assert.match(source, /const restoreTabs = \(\) => \{[\s\S]*?tab\.style\.display = ''/)
  // 重建出来的 tab 要重新收起：内联样式只跟着元素走，切会话会换元素。
  assert.match(source, /observer\.observe\(header, \{ childList: true, subtree: true, attributes: true, attributeFilter: \['aria-selected'\] \}\)/)
})

test('窄宽度判定与 canvas 同款（阈值 / 滞回 / 观察 header 而非自身）', () => {
  const start = source.indexOf('const COMPACT_ENTER_PX')
  const end = source.indexOf('const terminalGlyph')
  assert.notStrictEqual(start, -1, 'client.js 里找不到 COMPACT_ENTER_PX 锚点')
  assert.notStrictEqual(end, -1, 'client.js 里找不到 terminalGlyph 锚点')
  const { compactDecision, COMPACT_ENTER_PX, COMPACT_RELEASE_PX } =
    new Function(`${source.slice(start, end)}\nreturn { compactDecision, COMPACT_ENTER_PX, COMPACT_RELEASE_PX }`)()

  assert.equal(compactDecision({ leftGap: 600, compact: false }), false)
  assert.equal(compactDecision({ leftGap: COMPACT_ENTER_PX, compact: false }), false, '恰好等于进入阈值时不切')
  assert.equal(compactDecision({ leftGap: COMPACT_ENTER_PX - 1, compact: false }), true)
  assert.ok(COMPACT_RELEASE_PX > COMPACT_ENTER_PX, '退出阈值必须高于进入阈值（滞回）')
  assert.equal(compactDecision({ leftGap: COMPACT_RELEASE_PX - 1, compact: true }), true)
  assert.equal(compactDecision({ leftGap: COMPACT_RELEASE_PX, compact: true }), false)

  // 自身是 flex:none：被挤压时自己的宽度不变，观察自身检测不到溢出。
  assert.match(source, /const header = node\.closest\('header'\)/)
  assert.match(source, /resize\.observe\(header\)/)
  assert.match(source, /return \(\) => \{[\s\S]*?resize\.disconnect\(\)/)
  assert.doesNotMatch(source, /resize\.observe\(node\)/, '不应观察自身')
})

test('apply is idempotent and the effect resets the guard and the page', () => {
  const { descriptor, window, styles } = capture()
  const exports = descriptor.factory(requireStub)
  const ctx = fakeCtx()

  exports.apply(ctx)
  exports.apply(ctx)
  assert.equal(ctx.registered.length, 2, 'a second apply must not stack a second entry')

  assert.equal(ctx.effects.length, 1)
  assert.equal(ctx.effects[0].label, 'ssh: view')
  ctx.effects[0].dispose()
  assert.equal(window.__DSH_SSH_BOOTED__, false)
  assert.equal(styles[0].removed, true, '卸载时应撤掉注入的样式')

  exports.apply(ctx)
  assert.equal(ctx.registered.length, 4, 'apply after teardown must remount')
})

test('SSH 视图激活时隐藏官方「对话列宽」拖拽手柄（用户 2026-09-12 反馈）', () => {
  const { descriptor, styles } = capture()
  descriptor.factory(requireStub).apply(fakeCtx())
  const css = styles[0].textContent
  // 规则必须：① 用稳定的 data 属性锁定手柄（CSS-modules 哈希类不可依赖）；
  // ② 以 iframe[title="SSH"] 的存在为条件（iframe 只在 SSH 视图激活时挂载，
  //    切走即卸载 ⇒ 手柄自动恢复）；③ !important 压过官方样式表。
  assert.match(css, /div\[data-phase\]:has\(iframe\[title="SSH"\]\) \[data-width-handle\]\{display:none!important\}/)
  // tb-group（用户在用的窗控）与 #miasaki-switcher（主题球）必须保持可见：2026-09-12
  // 曾误隐藏二者被用户退回——这两条「不许出现」的断言防再次犯同样的错。
  assert.doesNotMatch(css, /#miasaki-titlebar\{display/)
  assert.doesNotMatch(css, /#miasaki-switcher\{display/)
  // 参照物：官方自己隐藏同一手柄的先例（composer overlay），确认属性名没有拼错
  assert.doesNotMatch(css, /data-width-hanlde|data-widthhandles/)
})
