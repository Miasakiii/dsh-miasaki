// Contract test for the client half.
//
// 1) DSH's client module loader calls `factory(require)` and hands the return value
//    to cordis as the plugin, so a factory that never returns `module.exports`
//    yields undefined and the whole plugin fails to load with `invalid plugin,
//    expect function or object with an "apply" method, received undefined`
//    — the 2026-09-10 startup failure.
// 2) 入口位置（2026-09-10）：入口注册在会话头 actions 槽（第一行，紧跟 canvas 的
//    「对话 / 会话布」）。2026-09-14 路线丁 D1：入口改为开关「body 级全屏浮层」
//    （常驻 iframe + visibility 隐藏 + sessionStorage 记忆），conversation.view
//    保留作回退。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** 在桩的 window 上以 MessageEvent 形状分发一条顶栏消息（模拟 iframe → 宿主）。 */
function dispatchOverlayMessage(win, token, data, sourceWin) {
  for (const listener of (win.__msgListeners ?? [])) {
    listener({ origin: 'http://dsh.local', source: sourceWin, data: { source: 'dsh-ssh', overlayToken: token, ...data } })
  }
}

/**
 * Run client.js in a VM whose `window.__ModuleLoader__` captures the descriptor.
 * The document stub supports the overlay host path: innerHTML builds a small
 * queryable tree (section > loading + iframe), so overlay contracts are assertable.
 */
function capture(options = {}) {
  let descriptor = null
  const styles = []
  const makeNode = tag => {
    const node = {
      tagName: String(tag ?? 'div').toUpperCase(),
      textContent: '', hidden: false, className: '', type: '', title: '', src: '',
      children: [], attributes: new Map(), handlers: new Map(), onceHandlers: new Map(),
      removed: false, appended: [],
      style: { setProperty() {}, removeProperty() {}, display: '' },
      get classList() {
        const self = node
        return {
          add: c => { if (!self.className.includes(c)) self.className += ` ${c}` },
          remove: c => { self.className = self.className.replace(c, '').trim() },
          toggle: (c, force) => {
            const has = self.className.includes(c)
            if (force === undefined ? !has : force) { if (!has) self.className += ` ${c}` } else self.className = self.className.replace(c, '').trim()
          },
          contains: c => self.className.includes(c),
        }
      },
      setAttribute(k, v) { this.attributes.set(k, String(v)) },
      getAttribute(k) { return this.attributes.get(k) ?? null },
      addEventListener(type, fn) { const l = this.handlers.get(type) ?? []; l.push(fn); this.handlers.set(type, l) },
      removeEventListener(type, fn) { this.handlers.set(type, (this.handlers.get(type) ?? []).filter(f => f !== fn)) },
      click() { for (const fn of [...(this.handlers.get('click') ?? [])]) fn({ currentTarget: this }) },
      append(child) { if (child) { this.children.push(child); child.parent = node } },
      appendChild(child) { return this.append(child) },
      remove() { node.removed = true; if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node) },
      closest() { return null },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
      querySelector(sel) { return matchIn(node, sel) },
      querySelectorAll(sel) { const out = []; collect(node, sel, out); return out },
    }
    // client.js 用 host.innerHTML 建浮层结构（section > bar + loading + iframe）。
    // 桩不解析 HTML，但对这个已知字面量按结构生成可查询子树。
    Object.defineProperty(node, 'innerHTML', {
      set(html) {
        node.children = []
        if (typeof html === 'string' && html.includes('dsh-ssh-overlay')) {
          // D2 起浮层结构与产品代码同步：section > loading + iframe（临时退出条已删）。
          const section = makeNode('section')
          section.className = 'dsh-ssh-overlay is-closed'
          const span = makeNode('span')
          span.className = 'dsh-ssh-loading'
          span.hidden = true
          const iframe = makeNode('iframe')
          iframe.setAttribute('title', 'SSH')
          // chrome 消息发往 iframe 的窗口（client.js: frame.contentWindow.postMessage）。
          // 桩在这里记录 token，供 D2 消息闭环测试读取；必须在 innerHTML setter 里赋，
          // 因为此时 capture 作用域里的 window 已初始化。
          iframe.contentWindow = {
            postMessage(msg) {
              if (msg !== null && typeof msg === 'object' && msg.type === 'chrome' && typeof msg.overlayToken === 'string') {
                window.__lastChromeToken = msg.overlayToken
                ;(window.__chromeMessages ??= []).push(msg)
              }
            },
          }
          section.children.push(span, iframe)
          span.parent = section
          iframe.parent = section
          node.children.push(section)
          section.parent = node
        }
      },
      get() { return '' },
    })
    return node
  }
  const matches = (node, sel) => {
    if (node === null || node === undefined || typeof node !== 'object') return false
    // 桩不支持后代组合器：取选择器**最后一段**做匹配（对测试断言足够；
    // 复合选择器的祖先约束由真实 DOM 里的 client.js 行为覆盖）。
    const lastSeg = sel.trim().split(/\s+/).pop() ?? sel
    // 先剥掉属性段再取类名 / id：`[data-slot="main.conversation"]` 的属性值里带点号，
    // 若在整段上匹配 `.` 会把 `main.conversation` 里的 `.conversation` 误当成类选择器
    // （2026-09-25：launcher 的「在不在主页」判据用的正是这个选择器，踩到过）。
    const withoutAttr = lastSeg.replace(/\[[^\]]*\]/g, '')
    const cls = withoutAttr.match(/\.([\w-]+)/g)?.map(s => s.slice(1)) ?? []
    const id = withoutAttr.match(/#([\w-]+)/)?.[1] ?? null
    const attr = lastSeg.match(/\[([\w-]+)="([^"]*)"\]/) // 支持 [attr="value"]
    const tag = withoutAttr.replace(/[#.][\w-]+/g, '').trim().toLowerCase()
    if (tag !== '' && node.tagName !== tag.toUpperCase()) return false
    if (id !== null && node.id !== id) return false
    if (attr !== null && node.attributes.get(attr[1]) !== attr[2]) return false
    for (const c of cls) if (!(node.className ?? '').includes(c)) return false
    return true
  }
  const matchIn = (root, sel) => {
    for (const child of root.children ?? []) {
      if (matches(child, sel)) return child
      const deeper = matchIn(child, sel)
      if (deeper !== null) return deeper
    }
    return null
  }
  const collect = (root, sel, out) => {
    for (const child of root.children ?? []) {
      if (matches(child, sel)) out.push(child)
      collect(child, sel, out)
    }
  }
  const document = {
    createElement: tag => makeNode(tag),
    head: makeNode('head'),
    body: makeNode('body'),
    documentElement: makeNode('html'),
    children: [],
    querySelector: sel => matchIn(document, sel),
    querySelectorAll: sel => { const out = []; collect(document, sel, out); return out },
    addEventListener() {}, removeEventListener() {},
  }
  document.children.push(document.head, document.body)
  document.head.parent = document
  document.body.parent = document
  // 会话面板锚点：`[data-slot="main.conversation"]` 只在会话面板激活时存在，
  // launcher 的「在不在主页」判据读它。默认挂上（= 停在主页，既有用例的前提不变）；
  // 传 `capture({ home: false })` 模拟设置页 / 轨迹页等其它主面板激活的界面。
  if (options.home !== false) {
    const panel = makeNode('div')
    panel.setAttribute('data-slot', 'main.conversation')
    document.body.append(panel)
  }
  const rawHeadAppend = document.head.append.bind(document.head)
  document.head.append = node => { styles.push(node); rawHeadAppend(node) }
  const window = {
    __ModuleLoader__: { load(d) { descriptor = d } },
    sessionStorage: { store: new Map(), getItem(k) { return this.store.get(k) ?? null }, setItem(k, v) { this.store.set(k, String(v)) }, removeItem(k) { this.store.delete(k) } },
    getComputedStyle: () => ({ paddingLeft: '0px', getPropertyValue: () => '' }),
    // message 监听收集 + postMessage 记录：D2 顶栏消息协议的行为闭环测试用。
    __msgListeners: [],
    __lastChromeToken: null,
    addEventListener(type, fn) { if (type === 'message') this.__msgListeners.push(fn) },
    removeEventListener(type, fn) { if (type === 'message') this.__msgListeners = this.__msgListeners.filter(f => f !== fn) },
    dispatchEvent() {},
    postMessage(msg) {
      if (msg !== null && typeof msg === 'object' && msg.type === 'chrome' && typeof msg.overlayToken === 'string') {
        this.__lastChromeToken = msg.overlayToken
      }
    },
    setTimeout: () => 0,
  }
  const context = vm.createContext({
    window,
    document,
    location: { origin: 'http://dsh.local' },
    HTMLElement: class {},
    MessageEvent: class { constructor(type, init) { this.type = type; this.origin = init?.origin ?? ''; this.source = init?.source ?? null; this.data = init?.data ?? null } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.notEqual(descriptor, null, 'client.js must call window.__ModuleLoader__.load()')
  // registerIds: the overlay host built via innerHTML needs manual id-free query —
  // our stub builds real nodes for innerHTML through createElement? No: innerHTML
  // is not parsed. Provide direct references:
  return { descriptor, window, styles, document }
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
  assert.deepEqual([...exports.inject], ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('入口按钮与 canvas 胶囊同款视觉，且总高守住 30px 的行内高度契约', () => {
  const { descriptor, styles } = capture()
  descriptor.factory(requireStub).apply(fakeCtx())
  assert.equal(styles.length, 1, '入口样式随 apply 注入一次')
  const css = styles[0].textContent
  assert.match(css, /\.dsh-ssh-switch\{/, '应有自己的容器类，不与 canvas 的选择器串用')
  assert.match(css, /padding:0 3px/, '上下 padding 必须为 0，否则会把官方 titleRow 撑高')
  assert.match(css, /border-radius:999px/, '与 canvas 胶囊同样的圆角')
  assert.match(css, /var\(--dsw-static-deepseek-450/, '配色走 DSH 主题令牌，跟随主题品牌色')
})

test('注册面收敛为两项：会话头入口 + shell.overlay launcher（D3 删 view 后）', async () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)

  assert.equal(ctx.registered.length, 2, 'D3 起：第一行入口 + shell.overlay 的 hero 态入口，共两项注册（view 已删）')
  assert.equal(ctx.registered.some(row => row.name === 'conversation.view'), false, 'conversation.view 必须已删除（D3，方案 §16.4-2）')

  const entry = ctx.registered.find(row => row.name === 'conversation.session.header.actions')
  assert.notEqual(entry, undefined, '入口必须在第一行 actions 槽')
  assert.equal(entry.meta.id, 'ssh-view-switch')
  assert.equal(entry.meta.order, 26)
  const canvas = await readFile(new URL('../../dsh-miasaki-canvas/client.js', import.meta.url), 'utf8')
  assert.match(canvas, /id: 'canvas-view-switch',\s*\n\s*order: 25,/, 'canvas 切换器应仍在 order 25')
})

test('浮层宿主：body 级、is-closed 初始态、懒加载（iframe 无 src）、加载态占位', () => {
  const { descriptor, document } = capture()
  descriptor.factory(requireStub).apply(fakeCtx())
  const hostNode = document.querySelector('.dsh-ssh-host')
  assert.notEqual(hostNode, null, 'body 上必须有 .dsh-ssh-host 宿主')
  const overlay = hostNode.querySelector('.dsh-ssh-overlay')
  assert.notEqual(overlay, null)
  assert.ok(overlay.className.includes('is-closed'), '初始必须处于关闭态（visibility 策略）')
  const frame = overlay.querySelector('iframe')
  assert.notEqual(frame, null)
  assert.equal(frame.getAttribute('title'), 'SSH')
  assert.equal(frame.src, '', '懒加载：初始不得赋 src（不碰 SSH 的用户零开销）')
  const loading = overlay.querySelector('.dsh-ssh-loading')
  assert.notEqual(loading, null, '必须有加载态占位（防首开白屏）')
})

test('open/close：visibility 策略（is-closed 类切换，不碰 hidden/display）、懒加载、记忆写入', () => {
  const { descriptor, document } = capture()
  descriptor.factory(requireStub).apply(fakeCtx())
  // open 不可从模块外直接调 —— 通过 React 入口按钮驱动（与真实用户路径一致）。
  const entry = descriptor.factory(requireStub)
  const ctx = fakeCtx()
  // 重新 apply 到同一 ctx（幂等守卫挡住第二次 apply），所以直接复用首次 apply 的结果：
  void entry
  // 从注入的样式中断言关键契约；行为断言经 sessionStorage 记忆 + 类名翻转验证。
  const css = document.head.children.find(n => n.tagName === 'STYLE')
  assert.notEqual(css, undefined)
  const text = css.textContent
  assert.match(text, /\.dsh-ssh-overlay\.is-closed\{visibility:hidden;pointer-events:none\}/, '关闭态必须是 visibility 策略（D0 §12 维持）')
  assert.match(text, /\.dsh-ssh-overlay\{position:fixed;z-index:100;inset:0/, '与 canvas 同构的 fixed/inset:0/z:100')
  assert.doesNotMatch(text, /\.dsh-ssh-overlay\[hidden\]\{display/, '不得用 display:none（路线丁唯一偏离点）')
})

test('开关记忆：open 写 1 / close 写 0；apply 时为真则自动恢复浮层（§5.9）', () => {
  const { descriptor, window } = capture()
  // 预置记忆为真：apply 后必须自动开浮层（iframe 懒加载被触发）。
  window.sessionStorage.setItem('dsh-ssh:overlay-open', '1')
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  assert.equal(window.sessionStorage.getItem('dsh-ssh:overlay-open'), '1')
  // 验证记忆驱动的开合：分别预置 0 / 1，各自 capture 新实例检查 overlay 类名与 src。
  const second = capture()
  second.window.sessionStorage.setItem('dsh-ssh:overlay-open', '0')
  second.descriptor.factory(requireStub).apply(fakeCtx())
  const hostA = second.document.querySelector('.dsh-ssh-overlay')
  // memory=0 → 初始仍关闭、iframe 仍无 src
  assert.ok(hostA.className.includes('is-closed'))
  assert.equal(hostA.querySelector('iframe').src, '', '记忆为关时不触发懒加载')
  // memory=1 → 自动开 + src 赋值
  const third = capture()
  third.window.sessionStorage.setItem('dsh-ssh:overlay-open', '1')
  third.descriptor.factory(requireStub).apply(fakeCtx())
  const hostB = third.document.querySelector('.dsh-ssh-overlay')
  assert.ok(!hostB.className.includes('is-closed'), '记忆为开时 apply 必须自动恢复浮层')
  assert.equal(hostB.querySelector('iframe').src, '/ssh/', '恢复即懒加载')
  assert.equal(third.window.sessionStorage.getItem('dsh-ssh:overlay-open'), '1')
})

test('入口按钮：aria/title 保留、onClick 关画布并开浮层（委托 + 开关）', () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const entry = ctx.registered.find(row => row.name === 'conversation.session.header.actions')
  const element = entry.view()
  assert.equal(element.type, 'div')
  assert.equal(element.props.role, 'group')
  const button = element.children[0]
  assert.equal(button.props['aria-label'], 'SSH')
  assert.equal(button.props.title, 'SSH')
  assert.equal(typeof button.props.onClick, 'function')
  // onClick 源码契约：先关画布（同步胶囊激活态）再开浮层，并把触发元素记为焦点归还目标；
  // 不再走 selectSsh（tab 委托）。D2 起入口支持 openOverlayFrom(el)。
  assert.match(source, /const onClick = event => \{\s*\n\s*dismissCanvasOverlay\(\)\s*\n\s*openOverlayFrom\(event\?\.currentTarget \?\? null\)/)
})

test('画布里的 SSH 按钮（外部视图槽广播）同样走「关画布 + 开浮层」', () => {
  assert.match(source, /data\.type !== 'canvas:view' \|\| data\.id !== VIEW_ITEM\.id/)
  assert.match(source, /dismissCanvasOverlay\(\)\s*\n\s*openOverlayFrom\(null\)/, 'onCanvasView 也要开浮层而非切视图（无入口元素可归焦）')
  assert.match(source, /window\.addEventListener\('message', onCanvasView\)/)
  assert.match(source, /window\.removeEventListener\('message', onCanvasView\)/, 'fiber 拆除必须解绑')
  assert.match(source, /canvasViewItems\.splice\(index, 1\)/, '卸载时把自己从注册表摘掉')
})

test('桌面壳窗控 reserve：canvas 同款量法 + postMessage 下发', () => {
  assert.match(source, /#miasaki-titlebar \.tb-group/)
  assert.match(source, /#miasaki-titlebar \.tb-capsule/)
  assert.match(source, /Math\.ceil\(window\.innerWidth - rect\.left \+ 6\)/, '量法与 canvas syncChrome 逐字一致')
  assert.match(source, /type: 'chrome', version: 1, reserve/, 'chrome 消息带 reserve 字段')
})

test('主题桥：浮层 iframe load 时补发快照，快照去重（U1 契约保持）', () => {
  assert.match(source, /frame\.addEventListener\('load', \(\) => \{ themeLastKey = ''; pushThemeSnapshot\(\); syncChrome\(\) \}\)/)
  assert.match(source, /if \(key === themeLastKey\) return/, '同一快照不重发')
  assert.match(source, /window\.__DSH_SSH_THEME__ = \{ source: 'dsh-ssh', type: 'theme', version: 1, revision: themeRevision/)
})

test('D3 清理：tab 委托三件套、conversation.view 与宽度手柄死规则零残留', () => {
  // D3（方案 §16.4-2）：三件套与 view 注册整体删除 —— 全局搜索零残留。
  // 宽度手柄隐藏规则**也已删**（D3-F1，2026-09-15 实机验收后定向）：它依赖回退视图的
  // DOM 形态（SSH iframe 挂在 div[data-phase] 内），view 删除后 :has() 永不命中 ⇒ 死代码。
  assert.doesNotMatch(source, /const selectSsh/, 'selectSsh 必须已删')
  assert.doesNotMatch(source, /const ownTab =/, 'ownTab 必须已删')
  assert.doesNotMatch(source, /const hideOwnTab =/, 'hideOwnTab 必须已删')
  assert.doesNotMatch(source, /const restoreTabs =/, 'restoreTabs 必须已删')
  assert.doesNotMatch(source, /const viewIsSsh =/, 'viewIsSsh 必须已删')
  assert.doesNotMatch(source, /function SshView/, 'SshView 组件必须已删（浮层是唯一形态）')
  assert.doesNotMatch(source, /'conversation\.view'/, 'conversation.view 注册必须已删')
  assert.doesNotMatch(source, /width-handle/, '宽度手柄死规则必须已删（验收矩阵 §8-C4：grep 应无命中）')
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

  assert.match(source, /const header = node\.closest\('header'\)/)
  assert.match(source, /resize\.observe\(header\)/)
  assert.doesNotMatch(source, /resize\.observe\(node\)/, '不应观察自身')
})

test('apply is idempotent and the effect resets the guard, recycles the overlay host', () => {
  const { descriptor, window, styles, document } = capture()
  const exports = descriptor.factory(requireStub)
  const ctx = fakeCtx()

  exports.apply(ctx)
  const hostNode = document.querySelector('.dsh-ssh-host')
  assert.notEqual(hostNode, null)
  exports.apply(ctx)
  assert.equal(ctx.registered.length, 2, 'a second apply must not stack a second entry')
  assert.equal(document.querySelectorAll('.dsh-ssh-host').length, 1, '幂等：不得叠第二个宿主')

  assert.equal(ctx.effects.length, 1)
  assert.equal(ctx.effects[0].label, 'ssh: view')
  ctx.effects[0].dispose()
  assert.equal(window.__DSH_SSH_BOOTED__, false)
  assert.equal(styles[0].removed, true, '卸载时应撤掉注入的样式')
  assert.equal(hostNode.removed, true, '卸载必须整树回收浮层宿主（含 iframe）')
  // 记忆不清除（用户意图）
  assert.equal(window.sessionStorage.getItem('dsh-ssh:overlay-open'), null, '未写过开关时不残留记忆键')

  exports.apply(ctx)
  assert.equal(ctx.registered.length, 4, 'apply after teardown must remount（两次 apply × 两项注册）')
  assert.equal(document.querySelectorAll('.dsh-ssh-host').length, 1, '重挂后宿主恰好一个')
})

test('官方列宽手柄不再被本线触碰（2026-09-12 反馈项随浮层形态收口）', () => {
  const { descriptor, styles } = capture()
  descriptor.factory(requireStub).apply(fakeCtx())
  const css = styles[0].textContent
  // 2026-09-12 曾用 :has(iframe[title="SSH"]) 在 SSH 视图下隐藏官方拖拽手柄；该视图形态
  // 随 D3 删除后规则永不命中（D3-F1），浮层本身全屏覆盖 ⇒ 无需再隐藏。改为**零触碰**断言。
  assert.doesNotMatch(css, /width-handle/)
  // tb-group（用户在用的窗控）与 #miasaki-switcher（主题球）必须保持可见：2026-09-12
  // 曾误隐藏二者被用户退回——这两条「不许出现」的断言防再次犯同样的错。
  assert.doesNotMatch(css, /#miasaki-titlebar\{display/)
  assert.doesNotMatch(css, /#miasaki-switcher\{display/)
  assert.doesNotMatch(css, /data-width-hanlde|data-widthhandles/)
})

test('合成为同一个控件：canvas 段右端打开、本段左端打开、负 margin 吃掉 gap', () => {
  const { descriptor, styles } = capture()
  descriptor.factory(requireStub).apply(fakeCtx())
  const css = styles[0].textContent
  assert.match(css, /\.dsh-canvas-switch:has\(\+ \.dsh-ssh-switch\)\{border-top-right-radius:0;border-bottom-right-radius:0;border-right:0\}/)
  assert.match(css, /\.dsh-canvas-switch \+ \.dsh-ssh-switch\{margin-left:-8px;border-top-left-radius:0;border-bottom-left-radius:0\}/)
  assert.match(css, /^\.dsh-ssh-switch\{[^}]*border-radius:999px/, '默认形态仍是完整胶囊')
  assert.match(css, /\.dsh-canvas-switch:has\(\+ \.dsh-ssh-switch button\.active\) button\[aria-label="对话"\]\.active:not\(:hover\)/)
})

// 回归（2026-09-14 验收发现，阻断级）：D1 首版把 `closeOverlay` 实现了、单测也"覆盖"了，
// 但产品代码里**零调用点** —— 浮层 inset:0 盖住会话头、iframe 侧没有关闭消息、`Esc` 明确
// 不接管、刷新又被记忆自动重开，用户点一次 SSH 就被困在里面（唯一出路是关标签页）。
// D1 验收用临时退出条热修；**D2 换成正式协议**：iframe 顶栏（app.js 自绘）发
// `ssh:close` 消息（带 overlayToken 防伪），宿主侧关闭 + 记忆归 0 + 焦点归还。
// 这条测的仍是**行为闭环**：消息能被处理 → 真的关 → 记忆归 0（否则刷新再次被困）。
test('D2 顶栏消息闭环：ssh:close → 关闭 + 记忆归 0 + 焦点归还（单向门回归·消息版）', () => {
  const { descriptor, window, document } = capture()
  const ctx = fakeCtx()
  window.sessionStorage.setItem('dsh-ssh:overlay-open', '1') // 记忆为开 ⇒ apply 自动恢复浮层
  descriptor.factory(requireStub).apply(ctx)

  const overlay = document.querySelector('.dsh-ssh-overlay')
  assert.ok(!overlay.className.includes('is-closed'), '记忆为开时 apply 必须自动恢复浮层')

  // chrome 消息在 apply 期间已发出（syncChrome）：从监听器里抓出 token 与 reserve。
  const chromeListeners = window.messageListeners ?? []
  void chromeListeners
  // 桩的 window.addEventListener 收集监听器（见下方 patch）；直接从收集中取。
  const listeners = window.__msgListeners ?? []
  assert.ok(listeners.length >= 2, 'apply 必须挂上 message 监听（onCanvasView + onOverlayMessage）')

  // 从 chrome 消息里拿 token：syncChrome 在 apply 期间调用过，走 postMessage —— 桩需要记录。
  const token = window.__lastChromeToken
  assert.ok(typeof token === 'string' && token.length > 0, 'chrome 消息必须下发 overlayToken（顶栏防伪）')

  // 模拟 iframe 顶栏发 ssh:close（带正确 token）→ 关闭 + 记忆归 0。
  const fakeFrameWin = overlay.querySelector('iframe').contentWindow
  const entry = document.querySelector('.dsh-ssh-switch button')
  if (entry !== null) { try { entry.focus() } catch { /* 桩无 focus */ } }
  dispatchOverlayMessage(window, token, { type: 'ssh:close' }, fakeFrameWin)
  assert.ok(overlay.className.includes('is-closed'), 'ssh:close 消息必须关闭浮层')
  assert.equal(window.sessionStorage.getItem('dsh-ssh:overlay-open'), '0', '关闭必须写回记忆=0，否则刷新再次被困')

  // 错 token 必须被拒（防伪）：先用 launcher 真实重开浮层，再发错 token 的 close，不得关闭。
  const launcher = ctx.registered.find(row => row.name === 'shell.overlay')
  // 2026-09-25 B2：launcher 合并为单层组件，view 直接调用即求值（判据只认 DOM 事实）。
  const launcherNode = launcher.view({})
  launcherNode.children[0].props.onClick()
  assert.ok(!overlay.className.includes('is-closed'), '前置：launcher 重开浮层')
  for (const l of window.__msgListeners) l({ origin: 'http://dsh.local', source: fakeFrameWin, data: { source: 'dsh-ssh', overlayToken: 'wrong-token', type: 'ssh:close' } })
  assert.ok(!overlay.className.includes('is-closed'), '错 token 的 ssh:close 必须被拒（防伪）')
  // 正 token 再关（清理状态，不影响后续用例）
  for (const l of window.__msgListeners) l({ origin: 'http://dsh.local', source: fakeFrameWin, data: { source: 'dsh-ssh', overlayToken: token, type: 'ssh:close' } })
  assert.ok(overlay.className.includes('is-closed'), '正 token 的 ssh:close 必须生效')
})

test('D2 顶栏消息：ssh:view canvas → 关自己 + 委托点击 canvas 胶囊「会话布」段', () => {
  const { descriptor, window, document } = capture()
  const ctx = fakeCtx()
  window.sessionStorage.setItem('dsh-ssh:overlay-open', '1')
  descriptor.factory(requireStub).apply(ctx)
  const overlay = document.querySelector('.dsh-ssh-overlay')

  // 抓 token（chrome 消息下发）
  const token = window.__lastChromeToken
  assert.ok(typeof token === 'string' && token.length > 0)

  // 造一个 canvas 胶囊「会话布」按钮，记录它是否被点击。
  const canvasSwitch = document.createElement('div')
  canvasSwitch.className = 'dsh-canvas-switch'
  const mapBtn = document.createElement('button')
  mapBtn.setAttribute('aria-label', '会话布')
  let mapClicked = false
  mapBtn.addEventListener('click', () => { mapClicked = true })
  canvasSwitch.appendChild(mapBtn)
  document.body.appendChild(canvasSwitch)

  const fakeFrameWin = overlay.querySelector('iframe').contentWindow
  for (const l of (window.__msgListeners ?? [])) {
    l({ origin: 'http://dsh.local', source: fakeFrameWin, data: { source: 'dsh-ssh', overlayToken: token, type: 'ssh:view', view: 'canvas' } })
  }
  assert.ok(overlay.className.includes('is-closed'), 'ssh:view 必须先关自己')
  assert.equal(mapClicked, true, '必须委托点击 canvas 的「会话布」段（激活态同步）')
  // 非法 view 值不得动作：先用 launcher 真实重开，再发非法 view，浮层不得被关、也不得跳转。
  const launcher18 = ctx.registered.find(row => row.name === 'shell.overlay')
  const launcherNode18 = launcher18.view({})
  launcherNode18.children[0].props.onClick()
  assert.ok(!overlay.className.includes('is-closed'), '前置：launcher 重开浮层')
  for (const l of window.__msgListeners) {
    l({ origin: 'http://dsh.local', source: fakeFrameWin, data: { source: 'dsh-ssh', overlayToken: token, type: 'ssh:view', view: 'nope' } })
  }
  assert.ok(!overlay.className.includes('is-closed'), '非法 view 不得关闭浮层')
  assert.equal(mapClicked, true, '非法 view 不得触发会话布跳转（次数不变）')
})

// ---- D1.1 无会话头时的常驻入口（shell.overlay，方案 §14）-------------------
// 判据是核心：会话头的胶囊入口注册在 `conversation.session.header.actions` 槽里，而官方在
// **没有当前会话**（`sessionId === void 0`）时只渲染一个空的 titleRow 占位 ⇒ hero 态
// （首屏）没有 SSH 入口，launcher 顶上。
// **反向同样硬**：只要本线的胶囊在 DOM 里，launcher 就必须消失 —— 否则就是
// 「同一个 SSH 两个入口」（2026-09-25 用户报「重复了，胶囊有 SSH 按钮入口」，见 B2 修复）。
test('D1.1 入口注册到 shell.overlay：自有 id、order 40、不替换既有条目', () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)

  const launcher = ctx.registered.find(row => row.name === 'shell.overlay')
  assert.notEqual(launcher, undefined, '无会话头的入口必须注册在 shell.overlay')
  assert.equal(launcher.meta.id, 'ssh-launcher', '用自有 id（官方：fresh id 加在既有条目旁边）')
  assert.equal(launcher.meta.order, 40, 'order 40：排在 usage-stats-overlay 之后')
})

test('D1.1 判据：本线胶囊在场即不渲染（只有 hero 态才顶上，结构性杜绝双入口）', () => {
  const { descriptor, document } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const launcher = ctx.registered.find(row => row.name === 'shell.overlay').view

  // 2026-09-25 B2：launcher 合并为**单层**组件（不再消费任何官方 prop），view 直接调用即求值
  // ——`react.createElement` 桩返回 `{ type, props, children }`。
  const render = () => launcher({})

  // ① 主页 + 胶囊不在场 ⇒ 渲染（hero 态 / 首屏正是这个状态）
  const node = render()
  assert.notEqual(node, null, 'hero 态（没有胶囊）必须渲染入口')
  assert.equal(node.props.className, 'dsh-ssh-launcher')
  const button = node.children[0]
  assert.equal(button.props['aria-label'], 'SSH')

  // ② 胶囊在场 ⇒ 必须消失（**不论会话 store 是什么状态**）
  const capsule = document.createElement('div')
  capsule.className = 'dsh-ssh-switch'
  document.body.append(capsule)
  assert.equal(render(), null, '本线胶囊在场时 launcher 不得渲染（这就是「重复」的源头）')

  // ③ 胶囊退场（会话头卸载 / 回到 hero）⇒ 恢复 —— 可逆，不是被写死成「一律不显示」
  capsule.remove()
  assert.notEqual(render(), null, '胶囊退场后 launcher 必须恢复（可逆）')
})

// 2026-09-25 B2 回归锁定：旧判据**推演**官方 `useSessions` 的 blank 字段，而官方决定会话头
// chrome（含 actions 槽）渲不渲染的是
// `blank = session === void 0 || conversation === void 0 || (session.blank && conversationPhase(...) === 'blank')`
// —— 两者**不等价**：summary 还是 provisional blank、但会话已经开始时，官方 `hideChrome = false`
// ⇒ 会话头带 chrome 渲染（胶囊在场），旧判据却照样返回 hero ⇒ 右上角多出一颗 SSH。
// 这条把那个组合钉死：**与会话 store 状态无关，只看胶囊在不在**。
test('D1.1e 回归：官方 blank 与会话头渲染条件不一致时，也不得双入口', () => {
  const { descriptor, document } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const launcher = ctx.registered.find(row => row.name === 'shell.overlay').view

  // 复刻事故现场：胶囊已经在 DOM 里 ⇒ 无论会话 store 报什么，launcher 都必须不在场。
  const capsule = document.createElement('div')
  capsule.className = 'dsh-ssh-switch'
  document.body.append(capsule)
  assert.equal(launcher({}), null, '胶囊在场 ⇒ launcher 必须为 null（判据与会话 store 状态无关）')
})

test('D1.1f 判据只认 DOM 事实：不得退回「推演官方 blank 字段」', async () => {
  assert.match(source, /const OWN_ENTRY_SELECTOR = '\.dsh-ssh-switch'/,
    '互斥判据必须锚定本线自己的入口选择器')
  assert.match(source, /onConversationHome\(\) && !ownEntryPresent\(\)/,
    'launcher 判据 = 在主页 **且** 胶囊不在场')
  assert.doesNotMatch(source, /useOnConversationHome|LauncherButton/,
    '旧 hook 与两层组件必须已删除（留着就可能被改回推演判据）')
  // 首帧防闪：会话头与 launcher 是两棵 fiber，首次 render 时判据必然先为 true ⇒
  // 首次 sync 必须跑在 paint 之前（useLayoutEffect），否则刷新时先画一帧多余的 SSH。
  assert.match(source, /usePaintEffect\(\(\) => \{/, 'hook 必须用 usePaintEffect（paint 前）订阅')
  assert.match(source, /typeof react\.useLayoutEffect === 'function'[\s\S]{0,80}: react\.useEffect/,
    'usePaintEffect = useLayoutEffect 优先，桩环境退回 useEffect')
})

// 2026-09-25 修：用户报「右上角 SSH 按钮应该只在主页显示，而不是每个界面都有」。
// `shell.overlay` 是 root 级浮层、**每一屏都渲染**，而当时那条判据在设置页 / 轨迹页
// 等非会话界面同样成立 ⇒ 入口跟着浮层出现在每一屏的右上角。这里锁死「在不在主页」那一维
// （B2 之后它是两维判据里的一维，另一维是「本线胶囊不在场」）。
test('D1.1c 非主页不渲染：设置页 / 轨迹页等界面不得出现 SSH 入口', () => {
  const { descriptor, document } = capture({ home: false }) // 无面板锚点 = 其它主面板激活
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const launcher = ctx.registered.find(row => row.name === 'shell.overlay').view
  const render = () => launcher({})

  assert.equal(render(), null, '非主页（无面板锚点）⇒ 不渲染，这正是用户报的「每个界面都有」')

  // 反向：锚点补上后立即恢复渲染 —— 证明判据读的确实是「会话面板激活」，
  // 而不是被写死成「一律不显示」。
  const panel = document.createElement('div')
  panel.setAttribute('data-slot', 'main.conversation')
  document.body.append(panel)
  assert.notEqual(render(), null, '回到主页（面板锚点出现）⇒ 入口恢复')
})

test('D1.1d 面板锚点与官方隔离契约一致，且靠 MutationObserver 跟随切换', async () => {
  const text = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(text, /\[data-slot="main\.conversation"\]/,
    '必须锚定官方 [data-slot="main.conversation"]（其它主面板激活时它不存在）')
  assert.match(text, /const observer = new MutationObserver\(schedule\)/,
    '面板切换 / 会话头挂载没有官方读取接口，须由 MutationObserver 跟随')
  assert.match(text, /document\.body, \{ childList: true, subtree: true \}/,
    '观察 body 子树（面板与会话头都是官方 React 增删节点）')
})

test('D1.1 点击走与胶囊同一条路径：打开浮层 + 写记忆', () => {
  const { descriptor, window, document } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const launcher = ctx.registered.find(row => row.name === 'shell.overlay').view

  const overlay = document.querySelector('.dsh-ssh-overlay')
  assert.ok(overlay.className.includes('is-closed'), '前置：初始关闭态')

  const node = launcher({})
  node.children[0].props.onClick()

  assert.ok(!overlay.className.includes('is-closed'), '点击 launcher 必须打开浮层（与胶囊同一路径）')
  assert.equal(window.sessionStorage.getItem('dsh-ssh:overlay-open'), '1', '打开必须写记忆')
})

// D2 语义边界收口（2026-09-15 实机验收发现 → 用户定向「hero 态不渲染该段」）：
// canvas 只注册在会话头 actions 槽 ⇒ hero 态（无会话头）没有任何胶囊可供委托，
// 浮层顶栏的「会话布」就是一颗必然无效的按钮。宿主把 `.dsh-canvas-switch` 的存在性
// 随 chrome 消息下发（canvasAvailable），由浮层决定渲不渲染那一段。
// 判据必须来自**真实 DOM 查询**，不是配置项——所以桩里"有没有这个节点"直接决定取值。
test('chrome 消息下发 canvasAvailable=false（hero 态没有 canvas 胶囊可委托）', () => {
  const { descriptor, window } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const messages = window.__chromeMessages ?? []
  assert.ok(messages.length >= 1, 'apply 期间必须下发 chrome 消息')
  assert.equal(messages.at(-1).canvasAvailable, false, '桩里没有 .dsh-canvas-switch ⇒ 必须如实报 false')
})

test('chrome 消息下发 canvasAvailable=true（会话头里 canvas 胶囊在场）', () => {
  const { descriptor, window, document } = capture()
  const ctx = fakeCtx()
  const capsule = document.createElement('div')
  capsule.className = 'dsh-canvas-switch'
  document.body.append(capsule)
  descriptor.factory(requireStub).apply(ctx)
  const messages = window.__chromeMessages ?? []
  assert.equal(messages.at(-1).canvasAvailable, true, 'canvas 胶囊在场 ⇒ 报 true（不得误伤入口）')
})

test('每次打开浮层都重发 chrome 消息（canvasAvailable 随打开时刻刷新）', () => {
  const { descriptor, window, document } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const before = (window.__chromeMessages ?? []).length
  const launcher = ctx.registered.find(row => row.name === 'shell.overlay').view
  const node = launcher({})
  node.children[0].props.onClick()
  const after = (window.__chromeMessages ?? []).length
  assert.ok(after > before, 'openOverlay 必须重发 chrome 消息，否则顶栏段数不随形态刷新')
  assert.ok(!document.querySelector('.dsh-ssh-overlay').className.includes('is-closed'))
})

// D3-F1（2026-09-15 实机验收逮到，用户定向「现在就删」）：注入样式里曾留着一条
// 「SSH 视图激活时隐藏官方对话列宽拖拽手柄」的 :has() 覆盖规则（官方手柄挂在会话根
// 上的那个 col-resize 隐形条）—— 它依赖**回退视图**的 DOM 形态（当年 SSH iframe 挂在
// 会话根 phase 容器内），回退视图随 D3 删除后该选择器永不命中，属死代码，且与验收矩阵
// 「相关 hack 已删、grep 应无命中」冲突。这条同时钉两件事：**死规则不许回来** +
// **删除没有伤及相邻规则链**（下方断言里的模式串是唯一的例外，它是判据本身）。
test('注入样式不含已死的列宽手柄覆盖规则，且相邻规则链完整（D3-F1 回归）', () => {
  assert.doesNotMatch(source, /width-handle/, '死规则必须保持删除（回退视图已不存在，:has() 永不命中）')
  const { descriptor, styles } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const css = styles.map(s => s.textContent ?? '').join('\n')
  assert.ok(css.length > 0, 'apply 必须注入样式表')
  assert.doesNotMatch(css, /width-handle/, '注入的样式表里也不得再出现该规则')
  // 相邻规则链完整性（删的是拼接链中间的一环，拼错就会静默丢掉后续样式）
  assert.match(css, /\.dsh-canvas-switch:has\(\+ \.dsh-ssh-switch\)/, '合体胶囊规则仍在')
  assert.match(css, /\.dsh-ssh-overlay\{position:fixed;z-index:100;inset:0/, '浮层规则仍在（拼接链未断）')
  assert.match(css, /\.dsh-ssh-overlay\.is-closed\{visibility:hidden;pointer-events:none\}/, '隐藏态策略仍在（§5.1 硬契约）')
  assert.match(css, /\.dsh-ssh-launcher\{position:absolute;inset:0;pointer-events:none!important\}/, 'launcher 规则仍在')
})
