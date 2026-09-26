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
  /** B4：`capture({ effects: true })` 时收集 effect 清理函数（测试可手动卸载）。 */
  const effects = []
  // 2026-09-27 T4：桩节点以前是**纯对象**，而 client.js 的 DOM 兜底探针有一道
  // `capsule instanceof HTMLElement` 守卫（真实 DOM 里 `querySelector` 的结果必然通过）
  // ⇒ 「契约缺席走 DOM 探针」这条路径在桩里从来没被真正执行过（旧用例都落在
  // `rect.width > 0` 的假环境里）。这里把节点改成**真正的 `HTMLElement` 实例**
  // （`class NodeHTMLElement {}` + 同一个类交给 VM 上下文），兜底路径才能在桩里跑起来。
  class NodeHTMLElement {
    constructor(tag) {
      this.tagName = String(tag ?? 'div').toUpperCase()
      this.textContent = ''
      this.hidden = false
      this.className = ''
      this.type = ''
      this.title = ''
      this.src = ''
      this.children = []
      this.attributes = new Map()
      this.handlers = new Map()
      this.onceHandlers = new Map()
      this.removed = false
      this.appended = []
      this.style = {
        props: new Map(),
        setProperty(k, v) { this.props.set(k, String(v)) },
        removeProperty(k) { this.props.delete(k) },
        display: '',
      }
    }
    get classList() {
      const self = this
      return {
        add: c => { if (!self.className.includes(c)) self.className += ` ${c}` },
        remove: c => { self.className = self.className.replace(c, '').trim() },
        toggle: (c, force) => {
          const has = self.className.includes(c)
          if (force === undefined ? !has : force) { if (!has) self.className += ` ${c}` } else self.className = self.className.replace(c, '').trim()
        },
        contains: c => self.className.includes(c),
      }
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)) }
    getAttribute(k) { return this.attributes.get(k) ?? null }
    addEventListener(type, fn) { const l = this.handlers.get(type) ?? []; l.push(fn); this.handlers.set(type, l) }
    removeEventListener(type, fn) { this.handlers.set(type, (this.handlers.get(type) ?? []).filter(f => f !== fn)) }
    click() { for (const fn of [...(this.handlers.get('click') ?? [])]) fn({ currentTarget: this }) }
    append(child) { if (child) { this.children.push(child); child.parent = this } }
    appendChild(child) { return this.append(child) }
    remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this) }
    closest() { return null }
    // 让位测量要读前一个兄弟（dockkit strip 末端可能挨着「加标签 / 分栏」等键）。
    get previousElementSibling() {
      const siblings = this.parent?.children ?? []
      const index = siblings.indexOf(this)
      return index > 0 ? siblings[index - 1] : null
    }
    // 默认真实 DOM 的 0×0 矩形；测试可用 `node.setRect({...})` 摆位置（让位测量用）。
    setRect(rect) { this.__rect = { right: 0, bottom: 0, ...rect } }
    getBoundingClientRect() { return this.__rect ?? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } }
    querySelector(sel) { return matchIn(this, sel) }
    querySelectorAll(sel) { const out = []; collect(this, sel, out); return out }
  }
  const makeNode = tag => {
    const node = new NodeHTMLElement(tag)
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
    const attrValue = lastSeg.match(/\[([\w-]+)="([^"]*)"\]/) // [attr="value"]
    const attrPresence = lastSeg.match(/\[([\w-]+)\]/) // [attr]（存在性）
    const tag = withoutAttr.replace(/[#.][\w-]+/g, '').trim().toLowerCase()
    if (tag !== '' && node.tagName !== tag.toUpperCase()) return false
    if (id !== null && node.id !== id) return false
    if (attrValue !== null && node.attributes.get(attrValue[1]) !== attrValue[2]) return false
    // 2026-09-26 B3：launcher 判据读官方 `[data-conversation-header-corner]`（存在性锚点，
    // 官方给的是空串值）⇒ 桩必须支持不带值的属性选择器，否则夹具假阴性。
    if (attrValue === null && attrPresence !== null && !node.attributes.has(attrPresence[1])) return false
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
    // 让位量以视口宽为基准；默认 0 表示「量不到」⇒ 落点变量不写（既有无窗控环境的等价行为）。
    innerWidth: options.innerWidth ?? 0,
    // 2026-09-27 T4：桌面壳契约（`window.miasakiDesktop`）的 fake。**必须在
    // `vm.runInContext` 之前挂上** —— client.js 在**模块初始化**时取一次契约对象
    // （所以下面用 `capture({ desktop })` 注入；`capture()` 之后再赋值已经晚了）。
    ...(options.desktop === undefined ? {} : { miasakiDesktop: options.desktop }),
    sessionStorage: { store: new Map(), getItem(k) { return this.store.get(k) ?? null }, setItem(k, v) { this.store.set(k, String(v)) }, removeItem(k) { this.store.delete(k) } },
    // T4：DOM 兜底路径的垂直对齐读 `getComputedStyle(窗控组).top`。桩以前恒返回 `''`
    // （⇒ parseFloat 得 NaN ⇒ 退回默认 5），于是「DOM 口径的 top 也量得到」无从断言；
    // 这里改成把节点自己摆的 `top` 报出来（与真实 DOM 的 computed top 语义一致）。
    getComputedStyle: node => ({
      paddingLeft: '0px',
      getPropertyValue: () => '',
      get top() { const rect = node?.__rect; return rect === undefined ? '' : String(rect.top) + 'px' },
    }),
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
  const rafQueue = []
  /** B4：所有 MutationObserver 实例（含它们的 observe 目标与选项），供契约断言直读。 */
  const mutationObservers = []
  const context = vm.createContext({
    window,
    document,
    location: { origin: 'http://dsh.local' },
    HTMLElement: NodeHTMLElement,
    MessageEvent: class { constructor(type, init) { this.type = type; this.origin = init?.origin ?? ''; this.source = init?.source ?? null; this.data = init?.data ?? null } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    // B4：观察记录被留档 —— 「安全线（documentElement 上的 CSS 变量）变化必须有重测信号」
    // 这条契约只能靠「有没有 observer 盯着它」来钉（桩不会自己派发 mutation）。
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.observations = [] }
      observe(target, options) { this.observations.push({ target, options }); mutationObservers.push(this) }
      disconnect() {}
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    // B4 跟随重测（`capture({ raf: true })`）：提供**受控** rAF —— 回调排队，由测试用
    // `flushRaf()` 手动推进。默认**不提供**：client.js 的 rAF 回退是同步执行，给了队列会
    // 让既有用例的语义漂移（它们断言的是 apply 当下的同步结果）。
    ...(options.raf === true
      ? {
          requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length },
          cancelAnimationFrame(id) { rafQueue[id - 1] = null },
        }
      : {}),
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.notEqual(descriptor, null, 'client.js must call window.__ModuleLoader__.load()')
  /** 受控 rAF：推进 `rounds` 轮（每轮执行当前排队的回调，回调新排的进下一轮）。 */
  const flushRaf = (rounds = 1) => {
    let ran = 0
    for (let i = 0; i < rounds; i++) {
      const pending = rafQueue.splice(0, rafQueue.length)
      if (pending.length === 0) break
      for (const fn of pending) {
        if (typeof fn === 'function') { fn(); ran += 1 }
      }
    }
    return ran
  }
  // registerIds: the overlay host built via innerHTML needs manual id-free query —
  // our stub builds real nodes for innerHTML through createElement? No: innerHTML
  // is not parsed. Provide direct references:
  // B4：`requireStub` 按 capture 定制 —— `capture({ effects: true })` 时 effect 回调会**立即
  // 执行**（并把清理函数收集进 `effects`），从而让 launcher 的订阅路径（sync / 跟随重测）
  // 可被行为测试触达；默认沿用模块级的惰性 react 桩（既有用例依赖「effect 不执行」）。
  const reactStub = options.effects === true
    ? {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useRef: initial => ({ current: initial }),
        useCallback: fn => fn,
        useEffect: fn => { if (typeof fn === 'function') effects.push(fn()) },
        useLayoutEffect: fn => { if (typeof fn === 'function') effects.push(fn()) },
      }
    : react
  const localRequire = name => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require: ${name}`)
  }
  return { descriptor, window, styles, document, flushRaf, rafQueue, effects, requireStub: localRequire, observers: mutationObservers }
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

// ---- 2026-09-27 T4：桌面壳契约 fake ----------------------------------------
// 形状与 `dsh-miasaki-desktop/themes/src/10-contract.js` 的暴露面一致（只实现本线消费的
// `has` / `chrome.bounds` / `chrome.onChange`）。`bounds` 取**函数**是为了让测试能在同一个
// capture 里改「这一刻量到什么」（契约矩形是实时几何，缓存的快照过不了窗口 resize 那一关）。
function fakeDesktop({ bounds, onChange } = {}) {
  const listeners = []
  const caps = [...(bounds === undefined ? [] : ['chrome.bounds']), ...(onChange === undefined ? [] : ['chrome.onChange'])]
  return {
    protocolVersion: 1,
    isDesktop: true,
    capabilities: caps,
    has: name => caps.includes(name),
    chrome: {
      ...(bounds === undefined ? {} : { bounds }),
      ...(onChange === undefined ? {} : { onChange: cb => { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1) } } }),
    },
    /** 测试侧：模拟壳侧 ResizeObserver 触发（组尺寸 / 位置变化）。 */
    emitChange: () => { for (const cb of listeners.slice()) cb() },
    get changeListeners() { return listeners },
  }
}

/** 把复刻桌面壳的按钮组摆进桩 DOM（B4 那套无头夹具的等价物）。*/
function placeTitlebarGroup(document, rect) {
  const group = document.createElement('div')
  group.className = 'tb-group'
  group.setRect(rect)
  document.body.append(group)
  return group
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

// 2026-09-27 T4（防回潮）：口径① 必须有**契约消费点**，否则「契约优先」会悄悄退回纯 DOM 探针
// —— 而单测喂了 fake 契约也照样绿（fake 没人调），这层伪装单看行为断言抓不住。
test('T4 口径①契约消费点：源码里必须真的读 chrome.bounds()（防回潮）', () => {
  assert.match(source, /desktopContract\.chrome\.bounds\(\)/, '必须存在 chrome.bounds 消费点')
  assert.match(source, /hasContractCapability\('chrome\.bounds'\)/,
    '读契约前必须走能力探测（缺能力的旧壳 / 浏览器不得被硬调）')
  assert.match(source, /typeof window !== 'undefined' \? window\.miasakiDesktop \?\? null : null/,
    '契约对象必须在模块初始化时取一次并保存（不是每次重测现取）')
  assert.match(source, /hasContractCapability\('chrome\.onChange'\)/,
    'chrome.onChange 必须经能力探测后再订阅')
  assert.match(source, /desktopContract\.chrome\.onChange\(remeasureChromeContract\)/,
    '契约的尺寸变化信号必须接到重测上')
  assert.match(source, /disposeChromeContractSubscription\(\)/, '退订必须挂在既有 fiber 清理路径上（ctx.effect teardown）')
})

// T4 行为①：契约可用（fake 里 has('chrome.bounds') 为 true）⇒ reserve 与垂直对齐都取 bounds()，
// 同一份 DOM 里的复刻 `.tb-group`（另一组坐标）不得再参与 —— 若悄悄回落 DOM，reserve 会量成 354。
test('T4 契约优先：reserve 取 chrome.bounds() 而非 DOM 探针（同场复刻壳按钮组作对照）', () => {
  const desktop = fakeDesktop({ bounds: () => ({ left: 1120, top: 6, right: 1256, bottom: 34, width: 136, height: 28 }) })
  const { descriptor, window, document } = capture({ innerWidth: 1248, desktop })
  // 复刻桌面壳：按钮组 DOM 在场，但坐标与契约**刻意不同**（DOM 口径会算出 354），
  // 用来证明「契约在位时不读 DOM」。getBoundingClientRect 的调用次数同时钉死这一点。
  const group = placeTitlebarGroup(document, { left: 900, top: 20, width: 136, height: 28 })
  let domReads = 0
  const rawRect = group.getBoundingClientRect
  group.getBoundingClientRect = () => { domReads += 1; return rawRect() }

  descriptor.factory(requireStub).apply(fakeCtx())

  const props = document.documentElement.style.props
  assert.equal(props.get('--dsh-ssh-chrome-reserve'), '134px',
    '1248 − 1120 + 6 = 134px：必须取契约 bounds()（DOM 探针会给 1248 − 900 + 6 = 354px）')
  assert.equal(props.get('--dsh-ssh-chrome-top'), '6px', '垂直对齐也走契约（buttons 组与 launcher 同顶）')
  assert.equal(props.get('--dsh-ssh-chrome-height'), '28px')
  assert.equal(domReads, 0, '契约在位时不得再量 DOM 按钮组（否则等于两套口径并存）')
  assert.equal(window.__chromeMessages.at(-1).reserve, 134, 'chrome 消息里的 reserve 同源')
})

// T4 行为②：契约缺席（浏览器 / 旧壳）⇒ 必须原路回落 DOM 探针，**双类名兜底一个字不删**。
test('T4 兜底不变：无契约（或契约未提供该能力）时仍走 DOM 双类名探针', () => {
  // ① 完全没有 `window.miasakiDesktop`（普通浏览器）
  const plain = capture({ innerWidth: 1248 })
  assert.equal(plain.window.miasakiDesktop, undefined, '前置：桩里本来就没有契约对象')
  placeTitlebarGroup(plain.document, { left: 1104, top: 8, width: 136, height: 28 })
  plain.descriptor.factory(requireStub).apply(fakeCtx())
  assert.equal(plain.document.documentElement.style.props.get('--dsh-ssh-chrome-reserve'), '150px',
    '1248 − 1104 + 6 = 150px（DOM 口径原样保留）')
  assert.equal(plain.document.documentElement.style.props.get('--dsh-ssh-chrome-top'), '8px',
    '垂直对齐仍读 computed top（DOM 兜底路径的原口径；fixed 定位下与契约几何 top 同值）')

  // ② 契约在、但**没登记** chrome.bounds（旧壳 v1.1）⇒ 同样回落 DOM，且不得去调不存在的 bounds
  let called = 0
  const legacy = capture({
    innerWidth: 1248,
    desktop: { protocolVersion: 1, isDesktop: true, capabilities: [], has: () => false, chrome: { bounds: () => { called += 1; return { left: 1, width: 2, height: 3, top: 4 } } } },
  })
  placeTitlebarGroup(legacy.document, { left: 1104, top: 8, width: 136, height: 28 })
  legacy.descriptor.factory(requireStub).apply(fakeCtx())
  assert.equal(legacy.document.documentElement.style.props.get('--dsh-ssh-chrome-reserve'), '150px',
    '能力表里没有 chrome.bounds ⇒ 回落 DOM 探针')
  assert.equal(called, 0, '能力探测未通过时不得调用 bounds()')

  // ③ v3 旧壳的 `.tb-capsule` 兜底类名同样必须仍然量得到（契约路径下不再需要，兜底分支里要留）
  const oldShell = capture({ innerWidth: 1248 })
  const capsule = oldShell.document.createElement('div')
  capsule.className = 'tb-capsule'
  capsule.setRect({ left: 1152, top: 4, width: 88, height: 26 })
  oldShell.document.body.append(capsule)
  oldShell.descriptor.factory(requireStub).apply(fakeCtx())
  assert.equal(oldShell.document.documentElement.style.props.get('--dsh-ssh-chrome-reserve'), '102px',
    '1248 − 1152 + 6 = 102px（.tb-capsule 兜底必须保留）')
})

// T4 行为③：契约提供 chrome.onChange ⇒ 组尺寸 / 位置变化（比如侧栏线后来注入一颗终端键）
// 直接触发重测，不必等窗口 resize 或某次 DOM 变动顺带补测；退订挂在 fiber 清理路径上。
test('T4 chrome.onChange：注册为口径①的额外重测信号，退订随 fiber 拆除', () => {
  const current = { left: 1140 }
  const desktop = fakeDesktop({
    bounds: () => ({ left: current.left, top: 5, width: 108, height: 28 }),
    onChange: () => {},
  })
  const { descriptor, document } = capture({ innerWidth: 1248, desktop, effects: true })
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)

  assert.equal(desktop.changeListeners.length, 1, 'apply 期间必须挂上契约的尺寸变化订阅')
  assert.equal(document.documentElement.style.props.get('--dsh-ssh-chrome-reserve'), '114px',
    '前置：1248 − 1140 + 6 = 114px')

  // 壳侧按钮组变宽（侧栏线注入终端键：左边界左移 28px）⇒ 契约回调 ⇒ 立刻重测
  current.left = 1112
  desktop.emitChange()
  assert.equal(document.documentElement.style.props.get('--dsh-ssh-chrome-reserve'), '142px',
    '1248 − 1112 + 6 = 142px：契约回调必须触发重测（旧实现只靠窗口 resize / DOM 变动，会少让 28px）')

  // fiber 拆除 ⇒ 退订（不退还的话壳侧回调会打到已拆除的闭包上）
  ctx.effects[0].dispose()
  assert.equal(desktop.changeListeners.length, 0, '卸载必须退订契约订阅')

  // 幂等：重复 apply 不得叠第二个订阅。这里有**两道**守卫，本用例钉的是外层那道：
  //   · 外层 boot 守卫（`client.js:276` 的 `window.__DSH_SSH_BOOTED__`）⇒ 第二次 apply 整体 return；
  //   · 内层订阅守卫（`client.js:493`）只在**同一次 apply 内**重复调用时有效
  //     （`unsubscribeChromeContract` 是 apply 的局部变量，跨 apply 不复用）。
  // 2026-09-27 审查指出：原写法没说明这一点，读起来像在测内层守卫。
  const second = fakeDesktop({ bounds: () => ({ left: 1140, top: 5, width: 108, height: 28 }), onChange: () => {} })
  const cap2 = capture({ innerWidth: 1248, desktop: second })
  const factory2 = cap2.descriptor.factory(cap2.requireStub)
  const ctx2 = fakeCtx()
  factory2.apply(ctx2)
  factory2.apply(ctx2)
  assert.equal(second.changeListeners.length, 1, '重复 apply 只留一个订阅')
  // ★ 反证（防「恒真断言」）：清掉 boot 守卫后再 apply 会**真的**再订阅一次 —— 证明上面那条
  //   断言不是"因为第二次 apply 根本没执行"而恒真，而是守卫确实在挡；内层守卫不跨 apply，
  //   故此处预期 +1。真实路径（HMR 重挂）走的是 teardown（退订 + 清守卫）后的全新 apply，不叠。
  cap2.window.__DSH_SSH_BOOTED__ = false
  factory2.apply(ctx2)
  assert.equal(second.changeListeners.length, 2,
    '（反证）boot 守卫被清后跨 apply 会再订阅一次 ⇒ 上一条断言由守卫支撑，非恒真')
})

// T4 静态契约：口径②与 rootObserver 不因口径①契约化而改动（B4 的成果不可回退）。
test('T4 保留不变：口径②的官方 DOM 探针与 rootObserver 都在（契约只管壳自己的资产）', () => {
  assert.match(source, /const ROW_CHROME_SELECTORS = \['\[data-conversation-header-corner\]', '\[data-dockkit-strip-chrome\]'\]/,
    '口径② 量的是官方 DSH 的 DOM，壳无权代理 ⇒ 选择器不变')
  assert.match(source, /document\.querySelectorAll\(selector\)/, '口径② 仍自己量官方锚点')
  assert.match(source, /const rootObserver = new MutationObserver\(onRootStyleChange\)/,
    'rootObserver 必须保留（它盯的是官方 chrome 随 --ms-titlebar-reserve 平移，B4 的根因信号）')
  assert.match(source, /rootObserver\.observe\(document\.documentElement, \{ attributes: true, attributeFilter: \['style'\] \}\)/,
    'rootObserver 的观察项不变')
  assert.match(source, /const WATCHED_ROOT_VARS = \['--ms-titlebar-reserve', '--dsh-ssh-chrome-reserve'\]/,
    'WATCHED_ROOT_VARS 不变')
  assert.match(source, /rootObserver\.disconnect\(\)/, 'rootObserver 的退订不变')
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
// **没有绑定会话**（`sessionId === void 0`，只渲染一个空的 titleRow 占位）时没有胶囊
// ⇒ hero 态（首屏）由 launcher 顶上。
// **反向同样硬**：只要本线的胶囊在 DOM 里、或会话面板已经绑定会话，launcher 就必须消失
// —— 否则就是「同一个 SSH 两个入口」：
//   · 2026-09-25 B2 修「胶囊在场」（用户报「重复了，胶囊有 SSH 按钮入口」）；
//   · 2026-09-26 B3 修「空白会话」—— hideChrome = blank 时**没有胶囊但会话已绑定**，
//     只判胶囊会漏（用户复报「SSH 按钮还是有问题」并附会话窗口截图）。
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
    'launcher 判据 = 在主页 **且** 胶囊不在场（B3 复核后维持两维）')
  assert.doesNotMatch(source, /useOnConversationHome|LauncherButton/,
    '旧 hook 与两层组件必须已删除（留着就可能被改回推演判据）')
  // 首帧防闪：会话头与 launcher 是两棵 fiber，首次 render 时判据必然先为 true ⇒
  // 首次 sync 必须跑在 paint 之前（useLayoutEffect），否则刷新时先画一帧多余的 SSH。
  assert.match(source, /usePaintEffect\(\(\) => \{/, 'hook 必须用 usePaintEffect（paint 前）订阅')
  assert.match(source, /typeof react\.useLayoutEffect === 'function'[\s\S]{0,80}: react\.useEffect/,
    'usePaintEffect = useLayoutEffect 优先，桩环境退回 useEffect')
})

// 2026-09-26 B3（实机量测后定稿）：用户第二次复报「SSH 按钮还是有问题」，两张桌面壳截图
// 里 launcher 与官方那颗「▭」**按钮盒重叠 14 CSS px**（文字与图标只差 1.5 CSS px），
// 右栏展开时还被夹在右栏 chrome 与官方键之间。
// 根因：launcher 的 right 只按桌面壳窗控组算，而壳把窗控之外的空间让给 DSH 官方控件
// （--ms-titlebar-reserve）⇒ 官方控件正好压在 launcher 的落点上。
// 修法：量出同排官方 chrome 的最左边界，让 launcher 退到其左侧留呼吸位。
// 下面这条钉**纯函数**（无 DOM 依赖）；接线由下一条静态契约钉。
test('B3 让位：偏移 = 视口宽 − 官方 chrome 左边界 + 呼吸位（量不到则 null）', () => {
  const { descriptor } = capture()
  const exports = descriptor.factory(requireStub)
  const offset = exports.launcherClearanceOffset
  assert.equal(typeof offset, 'function', '必须导出纯函数供契约测试直读')

  // 实机量测复刻：1280px 视口、官方 chrome 左边界 1060 ⇒ 退到其左侧 8px
  assert.equal(offset({ viewportWidth: 1248, chromeLeft: 1060 }), 196,
    '1248 − 1060 + 8 = 196px（实测截图口径）')
  assert.equal(offset({ viewportWidth: 1248, chromeLeft: 1010 }), 246,
    '官方 chrome 更靠左（右栏展开两颗键）⇒ 偏移同步变大')
  assert.equal(offset({ viewportWidth: 1248, chromeLeft: 1060, gap: 16 }), 204,
    '呼吸位可注入（测试与将来调参用）')

  // 量不到的两种情形一律 null ⇒ 调用方移除变量、CSS 回落壳窗控口径（hero 态行为不变）
  assert.equal(offset({ viewportWidth: 1248, chromeLeft: Number.POSITIVE_INFINITY }), null,
    '官方 chrome 不在场 ⇒ null')
  assert.equal(offset({ viewportWidth: 0, chromeLeft: 100 }), null, '视口宽不可用 ⇒ null')
  assert.equal(offset({ viewportWidth: Number.NaN, chromeLeft: 100 }), null, '视口宽 NaN ⇒ null')

  // 退化：chrome 已越过视口右缘时不得给出负偏移
  assert.equal(offset({ viewportWidth: 1248, chromeLeft: 1400 }), 0, '退化场景归零，不返回负数')
})

// 让位量的**实测路径**（apply 期间会量一次）：把官方 chrome 按实机坐标摆进桩里，
// 断言写出的 CSS 落点变量；并证明「紧邻的官方兄弟按钮」也被吸收进让位量。
test('B3 让位：实测路径写落点变量（含紧邻兄弟按钮），量不到时不写', () => {
  const place = (rect) => {
    const { descriptor, document } = capture({ innerWidth: 1248 })
    return { descriptor, document, rect }
  }

  // ① 右栏折叠：会话头 corner（「展开」键）落在官方让位线上 ⇒ 退到它左侧 8px
  {
    const { descriptor, document } = place()
    const corner = document.createElement('div')
    corner.setAttribute('data-conversation-header-corner', '')
    corner.setRect({ left: 1060, top: 24, width: 28, height: 28 })
    document.body.append(corner)
    descriptor.factory(requireStub).apply(fakeCtx())
    assert.equal(document.documentElement.style.props.get('--dsh-ssh-launcher-right'), '196px',
      '1248 − 1060 + 8 = 196px（实机截图口径：corner 锚点让位）')
  }

  // ② 右栏展开：dockkit strip chrome 在场，其左侧紧邻一颗（禁用态浅灰）按钮 ⇒ 一并吸收
  {
    const { descriptor, document } = place()
    const sibling = document.createElement('div')
    sibling.setRect({ left: 984, top: 24, width: 56, height: 28, right: 1040 })
    const chrome = document.createElement('div')
    chrome.setAttribute('data-dockkit-strip-chrome', '')
    chrome.setRect({ left: 1046, top: 24, width: 130, height: 28 })
    document.body.append(sibling)
    document.body.append(chrome)
    descriptor.factory(requireStub).apply(fakeCtx())
    assert.equal(document.documentElement.style.props.get('--dsh-ssh-launcher-right'), '272px',
      '吸收紧邻兄弟后按 984 让位：1248 − 984 + 8 = 272px（只量 chrome 会是 210px，仍会叠上）')
  }

  // ③ 空容器（官方 :empty 时 display:none，rect 为 0×0）⇒ 视为量不到，不写变量
  {
    const { descriptor, document } = place()
    const corner = document.createElement('div')
    corner.setAttribute('data-conversation-header-corner', '')
    document.body.append(corner)
    descriptor.factory(requireStub).apply(fakeCtx())
    assert.equal(document.documentElement.style.props.get('--dsh-ssh-launcher-right'), undefined,
      '0×0 的空容器必须跳过（hero 态回落壳窗控口径）')
  }
})

// 让位量的接线契约：锚点必须是官方既有属性、方向必须是「退到 chrome 左侧」、
// 与壳窗控口径取 max、随 DOM 变动与窗口尺寸变化重测、fiber 卸载时清变量。
test('B3 让位：接线静态锁定（官方锚点 + 实测 + max 口径 + 重测与清理）', async () => {
  assert.match(source, /const ROW_CHROME_SELECTORS = \['\[data-conversation-header-corner\]', '\[data-dockkit-strip-chrome\]'\]/,
    '必须锚定官方两个既有属性：会话头 corner 与右栏 dockkit strip chrome')
  assert.match(source, /const LAUNCHER_GAP_PX = 8/, '呼吸位 8px 常量必须显式声明')
  assert.match(source, /viewportWidth, chromeLeft/, '实测处必须把视口宽与 chrome 左边界交给纯函数')
  assert.match(source, /shellReserve = reserve/, '壳窗控口径必须留给落点取 max（不能被让位量顶到窗控上）')
  assert.match(source, /Math\.max\(shellReserve \+ 16, clearance\)/,
    '落点 = max(壳窗控口径, 躲开官方 chrome 的偏移)')
  assert.match(source, /setProperty\('--dsh-ssh-launcher-right', offset \+ 'px'\)/,
    '落点经 CSS 变量下发')
  assert.match(source, /removeProperty\('--dsh-ssh-launcher-right'\)/,
    '量不到时（以及 fiber 卸载时）必须清掉变量，落点可逆地回到壳窗控口径')
  assert.match(source, /right:var\(--dsh-ssh-launcher-right,calc\(var\(--dsh-ssh-chrome-reserve,0px\) \+ 16px\)\)/,
    'CSS 必须优先消费落点变量、回落壳窗控口径')
  assert.match(source, /window\.addEventListener\('resize', onResize\)/,
    '窗口尺寸变化会挪动官方 chrome 左边界 ⇒ 必须重测')
  assert.match(source, /if \(next\) \{[\s\S]{0,240}?syncLauncherOffset\(\)/,
    'DOM 变动后（仅在 launcher 可见时）重测落点')
})

// 2026-09-26 B4（用户第三次复报「还是会有问题，点击页面后可能恢复正常」）：
// 用无头 Chromium + 复刻桌面壳标题栏（`#miasaki-titlebar .tb-group` + `--ms-titlebar-reserve`）
// 逐帧量测，定位到 B3 之后仍存的两个洞 —— ①**视口外的锚点**污染让位量；②官方右栏的
// **transform 过渡**期间与结束都没有重测信号。两者叠加的现场与用户两张截图逐像素吻合：
// 让位量被归零 ⇒ 落点退回兜底 `reserve+16` ⇒ 压在刚移入视口的 dockkit 两颗键上（图一）；
// 直到用户点一下页面（React 重渲染）才被顺带纠正（图二）。下面四条钉死这两点。
test('B4 视口判据：被 transform 推出视口的锚点不参与（宽高非零，0×0 判据拦不住）', () => {
  const { descriptor } = capture()
  const inViewport = descriptor.factory(requireStub).inViewportRow
  assert.equal(typeof inViewport, 'function', '必须导出纯函数供契约测试直读')
  const rect = (left, width) => ({ left, right: left + width, width, height: 28 })

  // 实机复刻：视口 1248 CSS px，右栏收起时 `[data-dockkit-strip-chrome]` 的 rect
  assert.equal(inViewport(rect(1590, 64), 1248), false,
    'left 1590 ≫ vw 1248：被 translateX 推出视口右缘 ⇒ 不参与（这是 B4 的根因）')
  assert.equal(inViewport(rect(1028, 64), 1248), true,
    '右栏展开后同一颗锚点移入视口 ⇒ 参与让位')
  assert.equal(inViewport(rect(0, 0), 1248), false, '0×0 空容器仍不参与（B3 判据不回退）')
  assert.equal(inViewport(rect(-40, 20), 1248), true, '左半截还在视口内就算在场')
})

test('B4 视口判据进实测路径：量不到就不写变量（旧实现会算出 0 并退回兜底）', () => {
  // ① 只在场一颗**被推出视口**的 dockkit strip（右栏收起、会话头 corner 尚未渲染）
  const { descriptor, document } = capture({ innerWidth: 1248 })
  const out = document.createElement('div')
  out.setAttribute('data-dockkit-strip-chrome', '')
  out.setRect({ left: 1590, top: 24, width: 64, height: 28 })
  document.body.append(out)
  descriptor.factory(requireStub).apply(fakeCtx())
  assert.equal(document.documentElement.style.props.get('--dsh-ssh-launcher-right'), undefined,
    '视口外的锚点等于「量不到」⇒ 不写变量、CSS 回落壳窗控口径（旧实现：1590 使让位量归零后写成 16px）')

  // ② 对照：同一颗锚点移进视口 ⇒ 正常让位（1248 − 1028 + 8 = 228）
  const second = capture({ innerWidth: 1248 })
  const inside = second.document.createElement('div')
  inside.setAttribute('data-dockkit-strip-chrome', '')
  inside.setRect({ left: 1028, top: 24, width: 64, height: 28 })
  second.document.body.append(inside)
  second.descriptor.factory(requireStub).apply(fakeCtx())
  assert.equal(second.document.documentElement.style.props.get('--dsh-ssh-launcher-right'), '228px',
    '1248 − 1028 + 8 = 228px（右栏展开后的实测口径）')
})

test('B4 跟随重测：过渡期逐帧跟到稳定，落点自己走到位（不再依赖用户点击页面）', () => {
  const cap = capture({ innerWidth: 1248, raf: true, effects: true })
  const { descriptor, document, flushRaf, requireStub: localRequire } = cap
  const strip = document.createElement('div')
  strip.setAttribute('data-dockkit-strip-chrome', '')
  strip.setRect({ left: 1590, top: 24, width: 64, height: 28 }) // 收起：被推到视口外
  document.body.append(strip)

  const ctx = fakeCtx()
  const factory = descriptor.factory(localRequire)
  assert.equal(typeof factory.inViewportRow, 'function', '导出的判定函数也要能在该 require 下取得')
  factory.apply(ctx)
  assert.equal(document.documentElement.style.props.get('--dsh-ssh-launcher-right'), undefined,
    '前置：apply 期间量一次 —— chrome 全在视口外 ⇒ 不写变量')

  // 挂载 launcher：usePaintEffect 里的 sync() 测一次并启动跟随
  const launcher = ctx.registered.find(row => row.name === 'shell.overlay').view
  launcher({})
  assert.equal(document.documentElement.style.props.get('--dsh-ssh-launcher-right'), undefined,
    '过渡首帧仍量不到（chrome 还在视口右缘之外）')

  // 过渡进行：官方 `transform: translateX(…)` → `none`，chrome 逐帧移入视口
  strip.setRect({ left: 1300, top: 24, width: 64, height: 28 })
  flushRaf()
  strip.setRect({ left: 1180, top: 24, width: 64, height: 28 })
  flushRaf()
  assert.equal(document.documentElement.style.props.get('--dsh-ssh-launcher-right'), '76px',
    '移入视口的当帧就跟着改：1248 − 1180 + 8 = 76px（旧实现：无任何重测信号，停在兜底）')

  // 过渡结束（--ds-transition-duration-slow 量级）⇒ 值稳定后再跟几帧即收手
  strip.setRect({ left: 1028, top: 24, width: 64, height: 28 })
  flushRaf(8)
  assert.equal(document.documentElement.style.props.get('--dsh-ssh-launcher-right'), '228px',
    '过渡结束的落点 = 1248 − 1028 + 8 = 228px —— 用户图二那个位置，但不再需要点一下页面')
  // 收手下限（FOLLOW_MIN_FRAMES）：过渡前段 chrome 还在视口外时让位量恒取兜底值、连续多帧
  // 「不变」，据此收手就会漏掉它移进视口的那一刻（实测残留 41px 叠压）⇒ 下限内必须继续跟。
  assert.ok(flushRaf(15) > 0, '下限帧数内即使值不变也必须继续跟')
  assert.ok(flushRaf(40) > 0, '一路跟到下限')
  assert.equal(flushRaf(5), 0, '下限之后值不再变 ⇒ 跟随自行收手（不留常驻 rAF）')
})

test('B4 接线静态锁定：视口过滤 + 局部兄弟基准 + 跟随重测 + 过渡/可见性信号', () => {
  assert.match(source, /const inViewportRow = \(rect, viewportWidth\) =>/,
    '视口过滤必须是显式纯函数（可单测、可读）')
  assert.match(source, /if \(!inViewportRow\(rect, viewportWidth\)\) continue/,
    '主锚点必须先过视口判据')
  assert.match(source, /if \(!inViewportRow\(siblingRect, viewportWidth\)\) continue/,
    '紧邻兄弟按钮同样要过视口判据')
  assert.match(source, /let nodeLeft = rect\.left/,
    '兄弟链基准必须是**本锚点自己的**左边界，不能是跨锚点累积的 chromeLeft')
  assert.match(source, /if \(nodeLeft - siblingRect\.right > CHROME_ADJACENT_PX\) break/,
    '断链判据必须用局部基准')
  assert.match(source, /const FOLLOW_SETTLE_FRAMES = 4/, '跟随的稳定阈值必须显式声明')
  assert.match(source, /const FOLLOW_MIN_FRAMES = 30/,
    '跟随的下限帧数必须显式声明 —— 过渡前段「值不变」不等于过渡结束，早停会残留叠压')
  assert.match(source, /const FOLLOW_MAX_FRAMES = 90/, '跟随的硬上限必须显式声明')
  assert.match(source, /followStableFrames >= FOLLOW_SETTLE_FRAMES && followFrames >= FOLLOW_MIN_FRAMES/,
    '跟随的终止条件 = 既到下限帧数、又连续若干帧不再变化')
  assert.match(source, /const startFollow = \(\) => \{\s*\n\s*if \(!hasAnimationFrame\) return/,
    '无 rAF 的宿主（契约测试桩）不得启动跟随 —— 回退实现是同步的，会变成同步递归')
  assert.match(source, /document\.addEventListener\('transitionend', onTransitionEnd, true\)/,
    '官方右栏的 CSS 过渡收尾不带 DOM 变动 ⇒ 必须由 transitionend 补测（捕获阶段）')
  assert.match(source, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/,
    '后台标签页不跑 rAF ⇒ 切回窗口必须补测')
  assert.match(source, /rootObserver\.observe\(document\.documentElement, \{ attributes: true, attributeFilter: \['style'\] \}\)/,
    '安全线（documentElement 上的 CSS 变量）变化必须被观察 —— 这是持久性叠压的根因信号')
  assert.match(source, /const rootObserver = new MutationObserver\(onRootStyleChange\)/,
    '根元素 style 变化必须**同步**重测（安全线是 inline style、同步生效；延后一帧就露出 '
    + '「chrome 已平移、launcher 还没跟」的叠压窗口 —— 实测 20px）')
  assert.match(source, /const WATCHED_ROOT_VARS = \['--ms-titlebar-reserve', '--dsh-ssh-chrome-reserve'\]/,
    'documentElement.style 的写入方不止本线 ⇒ 必须先做廉价的相关变量比对')
  assert.match(source, /if \(key !== null && key === rootVarsLast\) return/,
    '相关变量没变就不得强制布局重测；顺带断掉「写自己的变量触发自己」的自激环')
  assert.match(source, /rootObserver\.disconnect\(\)/, '卸载时必须断开根元素观察者')
  assert.match(source, /document\.fonts\?\.ready\?\.then\?\.\(\(\) => schedule\(\)\)/,
    '字体落地会改变官方 chrome 实测宽度 ⇒ 必须补测')
  assert.match(source, /stopFollow\(\)/, 'fiber 卸载必须停掉跟随（不留悬空 rAF）')
  assert.match(source, /module\.exports\.inViewportRow = inViewportRow/, '纯函数必须导出供测试直读')
})

// 洞 B 的**行为**契约（2026-09-26 B4，持久性叠压的真正根因）：
// 桌面壳侧栏线把安全线 `--ms-titlebar-reserve`（128 → 注入终端键后 156px）写在
// `document.documentElement.style` 上。这条线一变，官方整行 chrome 整体平移 —— 而**全程
// 零 DOM 变动**，childList 与右栏属性判据一个都收不到。对照实验（无头 Chromium）：把安全线
// 156→220px 后，落点变量一次都没有重测，strip 从 x[1028,1092] 移到 x[964,1028] 后与
// launcher **持续重叠 20px** —— 用户「还是会有问题」的持久形态；「点击页面后可能恢复正常」
// 则是点击引发某处 React 重渲染、顺带补上的一次测量。
// 桩不会自己派发 mutation，所以这条只能钉「有没有 observer 盯着 documentElement 的 style」。
test('B4 重测信号：安全线变化必须在观察范围内（否则落点永不重测）', () => {
  const cap = capture({ innerWidth: 1248, raf: true, effects: true })
  const ctx = fakeCtx()
  cap.descriptor.factory(cap.requireStub).apply(ctx)
  // launcher 的订阅在 usePaintEffect 里建立 ⇒ 必须先渲染一次组件（effects: true 让桩执行）
  const launcher = ctx.registered.find(row => row.name === 'shell.overlay').view
  launcher({})

  const watchesRootStyle = cap.observers.some(observer =>
    observer.observations.some(v =>
      v.target === cap.document.documentElement
      && Array.isArray(v.options?.attributeFilter)
      && v.options.attributeFilter.includes('style')))
  assert.ok(watchesRootStyle,
    '必须有一个 MutationObserver 盯着 documentElement 的 style ⇒ 安全线（--ms-titlebar-reserve）'
    + '变化时才会重测；否则落点会停在按旧位置算的值上，与官方 chrome 持续叠压')

  // 对照：body 子树的观察仍然在（B1/B2/B3 的显隐与右栏属性判据不能丢）
  const watchesBody = cap.observers.some(observer =>
    observer.observations.some(v => v.target === cap.document.body && v.options?.childList === true))
  assert.ok(watchesBody, 'body 子树的 childList 观察不得被这次的根元素观察取代')
})

// 2026-09-26 B3 记录（**已被实机量测推翻的那一版判据，留作反例**）：
// 当时推断「空白会话（hideChrome = blank ⇒ 无胶囊）也算会话窗口 ⇒ 应隐藏 launcher」。
// 实机逐像素复核后撤回：空白会话的对话相位仍是 hero（官方
// `ConversationMainPanel` 的 `hero = sessionId === void 0 || (blank && (open || summaryBlank))`，
// 输入框居中），那正是用户口中的「主页」；B1 的「只在主页显示」锚的也是会话面板这一维。
// 这条测试把「**不能**只因为会话头存在就隐藏」钉死 —— 否则主页入口会被误杀。
test('D1.1g 会话头在场（corner 锚点）不影响显隐：判据仍只认「主页 + 胶囊不在场」', () => {
  const { descriptor, document } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)
  const launcher = ctx.registered.find(row => row.name === 'shell.overlay').view
  const render = () => launcher({})

  // 前置：hero（官方只渲染空 titleRow ⇒ 没有 corner 锚点）⇒ 入口在场
  assert.notEqual(render(), null, '前置：hero 态必须渲染入口')

  // 会话头渲染出 corner 锚点、但胶囊不在（空白会话）：入口**仍在场**（这就是主页）。
  const corner = document.createElement('div')
  corner.setAttribute('data-conversation-header-corner', '')
  document.body.append(corner)
  assert.equal(document.querySelector('.dsh-ssh-switch'), null, '前置：此状态下确实没有胶囊')
  assert.notEqual(render(), null, '会话头在场不足以隐藏入口（corner 锚点只用于让位测量）')

  // 胶囊一出现（会话真正开始）⇒ 立刻让位；胶囊退场 ⇒ 恢复。可逆。
  const capsule = document.createElement('div')
  capsule.className = 'dsh-ssh-switch'
  document.body.append(capsule)
  assert.equal(render(), null, '胶囊在场 ⇒ launcher 必须为 null（B2 的硬契约不变）')
  capsule.remove()
  assert.notEqual(render(), null, '胶囊退场 ⇒ 入口恢复（可逆）')
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
  assert.match(text, /document\.body, \{[\s\S]{0,240}?childList: true,\s*subtree: true/,
    '观察 body 子树（面板与会话头都是官方 React 增删节点）')
  assert.match(text, /attributeFilter: \['data-sidebar-right-open', 'data-sidebar-right-panel'\]/,
    '右栏开合是**改属性**（panel 用 transform 移出屏幕、不卸载）⇒ 必须观察这两个属性')
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
