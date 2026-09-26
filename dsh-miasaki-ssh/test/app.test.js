// Unit tests for app.js's pure view-model helpers.
//
// app.js is a browser script; loading the whole file in node:vm with a stub
// window/document is safe (module level only defines functions and registers
// one DOMContentLoaded listener), so the pure helpers are called directly from
// the vm global — no DOM driving needed for these.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')

const context = vm.createContext({
  window: { addEventListener() {} },
  document: { addEventListener() {} },
})
vm.runInContext(source, context, { filename: 'app.js' })

test('matchesQuery covers label / user@host:port / group', () => {
  const conn = { label: 'web-01', host: 'web.example.com', port: 22, username: 'ops', group: '生产环境' }
  const matches = query => context.matchesQuery(conn, query)
  assert.equal(matches(''), true)
  assert.equal(matches('WEB-01'), true)
  assert.equal(matches('ops@web'), true)
  assert.equal(matches(':22'), true)
  assert.equal(matches('生产'), true)
  assert.equal(matches('nope'), false)
})

test('hostGroups filters, groups, and sorts favorites first / 未分组 last', () => {
  const connections = [
    { id: 'b', label: 'beta', host: 'b.example.com', port: 22, username: 'ops', group: '测试环境', favorite: false },
    { id: 'a', label: 'alpha', host: 'a.example.com', port: 22, username: 'ops', group: '生产环境', favorite: false },
    { id: 'c', label: 'gamma', host: 'c.example.com', port: 22, username: 'ops', group: '生产环境', favorite: true },
    { id: 'd', label: 'delta', host: 'd.example.com', port: 22, username: 'ops', group: '未分组', favorite: true },
    { id: 'e', label: 'hidden', host: 'h.example.com', port: 22, username: 'ops', group: '生产环境', favorite: false },
  ]
  const liveOf = () => 'idle'
  const groups = context.hostGroups(connections, '', liveOf)
  // vm realm 返回的数组须先浅拷贝再 deepEqual
  assert.deepEqual([...groups.map(g => g.name)], ['测试环境', '生产环境', '未分组'])
  assert.deepEqual([...groups[1].hosts.map(h => h.id)], ['c', 'a', 'e']) // 生产环境组内收藏 gamma 在前
  assert.deepEqual([...groups[2].hosts.map(h => h.id)], ['d'])
  // 搜索过滤：只有 beta 剩下，空组不出现
  const filtered = context.hostGroups(connections, 'beta', liveOf)
  assert.deepEqual([...filtered.map(g => g.name)], ['测试环境'])
  // 无 group 的连接落进「未分组」
  const ungrouped = context.hostGroups([{ id: 'x', label: 'x', host: 'x', port: 22, username: 'u' }], '', liveOf)
  assert.deepEqual([...ungrouped.map(g => g.name)], ['未分组'])
})

test('looksSuspiciousPaste flags multi-line / control-char payloads only', () => {
  assert.equal(context.looksSuspiciousPaste('ls -la'), false)
  assert.equal(context.looksSuspiciousPaste(''), false)
  assert.equal(context.looksSuspiciousPaste('with\ttab'), false) // Tab 放行
  assert.equal(context.looksSuspiciousPaste('rm -rf /\nyes'), true)
  assert.equal(context.looksSuspiciousPaste('a\rb'), true)
  assert.equal(context.looksSuspiciousPaste('null\x00byte'), true)
  assert.equal(context.looksSuspiciousPaste('esc\x1b[200~'), true) // ESC 也是控制字符：预览确认后才进终端
  assert.equal(context.looksSuspiciousPaste(undefined), false)
})

test('compositeOver blends translucent host colors onto a solid base', () => {
  // rgba(0,0,0,.5) over #ffffff → #808080
  assert.equal(context.compositeOver('rgba(0, 0, 0, 0.5)', '#ffffff'), '#808080')
  // 不透明色原样返回
  assert.equal(context.compositeOver('#123456', '#ffffff'), '#123456')
  // #rrggbbaa：#00000080 over #ffffff → alpha=128/255，(255−128)/255×255=127 → #7f7f7f
  assert.equal(context.compositeOver('#00000080', '#ffffff'), '#7f7f7f')
  // 解析失败原样返回（交给浏览器 CSS 处理）
  assert.equal(context.compositeOver('not-a-color', '#ffffff'), 'not-a-color')
})

test('tokenColor falls back when the host token is missing or unusable', () => {
  assert.equal(context.tokenColor(undefined, '#111111', '#ffffff'), '#111111')
  assert.equal(context.tokenColor('var(--unknown)', '#111111', '#ffffff'), '#111111')
  assert.equal(context.tokenColor('#rrggbbaa-nope', '#111111', '#ffffff'), '#111111')
  assert.equal(context.tokenColor('rgba(9, 9, 9, 0.5)', '#111111', '#ffffff'), '#848484')
  assert.equal(context.tokenColor('#3964fe', '#111111', '#ffffff'), '#3964fe')
})

test('composeXtermTheme yields a full 16-color palette and solid cursor', () => {
  const light = context.composeXtermTheme(false, { accent: '#3964fe' }, '#3964fe')
  assert.equal(light.background, '#ffffff')
  assert.equal(light.cursor, '#3964fe')
  assert.equal(light.selectionBackground, '#3964fe4d') // hex accent → 带 alpha 的选区
  assert.equal(Object.keys(light).filter(k => k.startsWith('bright')).length, 8)
  const dark = context.composeXtermTheme(true, {}, '#638aff')
  assert.equal(dark.background, '#15191f')
  assert.equal(dark.cursor, '#638aff')
  // 语义红绿在两套方案里含义一致（red=r 系 / green=g 系）
  assert.match(light.red, /^#b/d)
  assert.match(light.green, /^#[0-9a-f]/i)
  assert.notEqual(dark.red, dark.green)
})

test('formatSshContext stamps the source host and honours the intro (A0)', () => {
  const conn = { label: 'web-01', host: 'web.example.com', port: 22, username: 'ops' }
  // 无引导语：首行只有来源标记
  assert.equal(
    context.formatSshContext(conn, 'systemctl status nginx'),
    '[SSH web-01 · ops@web.example.com:22]\nsystemctl status nginx',
  )
  // 有引导语：来源与引导语同一行
  assert.equal(
    context.formatSshContext(conn, 'boom', { intro: '帮我看下：' }),
    '[SSH web-01 · ops@web.example.com:22] 帮我看下：\nboom',
  )
  // 空白引导语等同于没有（不让首行多出一个悬空空格）
  assert.equal(
    context.formatSshContext(conn, 'x', { intro: '   ' }),
    '[SSH web-01 · ops@web.example.com:22]\nx',
  )
  // 尾部空白被裁掉
  assert.equal(context.formatSshContext(conn, 'line\n\n  '), '[SSH web-01 · ops@web.example.com:22]\nline')
  // 空正文 → 空串：调用方据此提示「没有可送出的内容」，绝不产出只有主机名的空消息
  assert.equal(context.formatSshContext(conn, ''), '')
  assert.equal(context.formatSshContext(conn, '   '), '')
  assert.equal(context.formatSshContext(conn, undefined), '')
  // 无主机对象时不崩溃
  assert.equal(context.formatSshContext(null, 'x'), '[SSH 未知主机]\nx')
})

test('SEND_INTENTS: every A0 intent is a stable, reviewable string', () => {
  // app.js 顶层的 `const` 是全局词法绑定，不会挂到 context 对象上（与 function 声明不同），
  // 所以在同一个 context 里求值取它。
  const intents = vm.runInContext('SEND_INTENTS', context)
  assert.equal(intents.selection, '') // 选区原样送，不替用户加话
  assert.match(intents.recent, /最近输出/)
  assert.match(intents.error, /问题/)
})

// ---- D0 探针逮到的真实缺陷回归（2026-09-14）：#status-text 被 renderStatusbar 抹掉
// → 每个状态帧 handleSessionStatus 抛 TypeError → TOFU 首连的确认 UI 不可达。
// buildSkeleton 是 DOM 构建函数，vm 里用最小 document 桩驱动它走完挂载路径。
test('buildSkeleton keeps #status-text alive across renderStatusbar calls (D0 regression)', () => {
  // 最小 DOM 桩：id 索引 + append/replaceChildren/querySelector 足够覆盖骨架路径
  const byId = new Map()
  const node = tag => {
    const n = {
      tagName: String(tag ?? 'div').toUpperCase(), children: [], hidden: false,
      className: '', id: '', textContent: '', type: '', value: '', title: '',
      attributes: new Map(), handlers: new Map(), style: {},
      setAttribute(k, v) { this.attributes.set(k, String(v)) },
      getAttribute(k) { return this.attributes.get(k) ?? null },
      appendChild(c) { this.children.push(c); return c },
      append(...cs) { for (const c of cs) { if (c) this.children.push(c) } },
      replaceChildren(...cs) { this.children = [...cs] },
      addEventListener(k, fn) { this.handlers.set(k, fn) },
      querySelector(sel) { return this.children.find(c => sel.endsWith(c.id) && c.id !== '') ?? null },
      querySelectorAll() { return [] },
    }
    return n
  }
  const doc = {
    body: node('body'),
    createElement: tag => node(tag),
    createElementNS: (_ns, tag) => node(tag),
    getElementById: id => byId.get(id) ?? null,
    querySelector: () => null,
    addEventListener() {},
  }
  // el() 会给节点赋 id —— 拦截一下：用 Proxy 太重，直接在 buildSkeleton 后扫树登记 id。
  const registerIds = n => { if (n.id) byId.set(n.id, n); for (const c of n.children) registerIds(c) }
  const ctx2 = vm.createContext({
    window: { addEventListener() {} },
    document: doc,
    __doc: doc,
  })
  const src2 = source + `
;globalThis.__buildSkeleton = buildSkeleton
;globalThis.__renderStatusbar = renderStatusbar
;globalThis.__el = el
;globalThis.__state = state`
  // 把 document 替换成可追踪的桩再执行（原始 source 已在主 context 执行过，这里重新跑一份）
  const fresh = ctx2
  vm.runInContext(src2, fresh, { filename: 'app.js' })
  vm.runInContext('buildSkeleton(__doc.body)', fresh)
  registerIds(doc.body)
  assert.equal(doc.getElementById('status-text') !== null, true, '#status-text must exist after buildSkeleton')
  // renderStatusbar 依赖 $()（document.querySelector）——桩里 querySelector 返回 null 会让它早退，
  // 所以补一个按 id 查找的实现，验证两次调用后 #status-text 仍在且状态文本被更新。
  doc.querySelector = sel => sel.startsWith('#') ? (byId.get(sel.slice(1)) ?? null) : null
  vm.runInContext('renderStatusbar()', fresh)
  vm.runInContext('renderStatusbar()', fresh)
  const st = doc.getElementById('status-text')
  assert.notEqual(st, null, '#status-text must survive renderStatusbar (bug: it was inside #status-pill and got wiped)')
  assert.equal(st.textContent, '未连接')
})

// ---- D-3 回归（2026-09-15 实机验收发现）：删掉当前选中的主机后，
// byId(state.selection) 返回 undefined，renderIdentity 读 conn.group 抛 TypeError。
// 修法：归一化 null（selection 失效 = 未选中），emptyStateNodes 同病一并修。
test('D-3 删选中主机后 renderIdentity / emptyStateNodes 不抛错且归空态', () => {
  const byId = new Map()
  const node = tag => {
    const n = {
      tagName: String(tag ?? 'div').toUpperCase(), children: [], hidden: false,
      className: '', id: '', textContent: '', type: '', value: '', title: '',
      attributes: new Map(), handlers: new Map(), style: {}, disabled: false,
      setAttribute(k, v) { this.attributes.set(k, String(v)) },
      getAttribute(k) { return this.attributes.get(k) ?? null },
      appendChild(c) { this.children.push(c); return c },
      append(...cs) { for (const c of cs) { if (c) this.children.push(c) } },
      replaceChildren(...cs) { this.children = [...cs] },
      addEventListener(k, fn) { this.handlers.set(k, fn) },
      querySelector(sel) { return this.children.find(c => sel.endsWith(c.id) && c.id !== '') ?? null },
      querySelectorAll() { return [] },
    }
    return n
  }
  const doc = {
    body: node('body'),
    createElement: tag => node(tag),
    createElementNS: (_ns, tag) => node(tag),
    getElementById: id => byId.get(id) ?? null,
    querySelector: () => null,
    addEventListener() {},
  }
  const registerIds = n => { if (n.id) byId.set(n.id, n); for (const c of n.children) registerIds(c) }
  const fresh = vm.createContext({
    window: { addEventListener() {} },
    document: doc,
    __doc: doc,
  })
  vm.runInContext(source + `
;globalThis.__renderIdentity = renderIdentity
;globalThis.__emptyStateNodes = emptyStateNodes
;globalThis.__state = state
;globalThis.__trustOf = trustOf
;globalThis.__icon = icon`, fresh, { filename: 'app.js' })
  vm.runInContext('buildSkeleton(__doc.body)', fresh)
  registerIds(doc.body)
  doc.querySelector = sel => sel.startsWith('#') ? (byId.get(sel.slice(1)) ?? null) : null
  // 造两台主机并选中其中一台，再「删掉」被选中的那台（连接库里移除，selection 仍指向旧 id）。
  // connections 必须非空：为空会走「连接你的下一台主机」分支，覆盖不到 D-3 的失效 selection 路径。
  vm.runInContext(`
    __state.connections.push({ id: 'c-1', label: 'gone', host: '127.0.0.1', port: 22, username: 'u', auth: { method: 'password' }, group: 'g', favorite: false })
    __state.connections.push({ id: 'c-2', label: 'other', host: '127.0.0.2', port: 22, username: 'u2', auth: { method: 'password' }, group: 'g', favorite: false })
    __state.selection = 'c-1'
    __state.connections = __state.connections.filter(c => c.id !== 'c-1') // 删除选中的那台
  `, fresh)
  // renderIdentity 在 selection 失效时必须归「未选中」形态，不抛 TypeError。
  vm.runInContext('__renderIdentity()', fresh)
  assert.equal(doc.getElementById('identity-name').textContent, 'SSH 工作区', '删主机后 identity 归工作区默认文案')
  assert.equal(doc.getElementById('identity-env').hidden, true)
  // emptyStateNodes 同病同修：失效 selection 回退「选择一台主机」空态。
  const nodes = vm.runInContext('__emptyStateNodes()', fresh)
  assert.ok(Array.isArray(nodes) && nodes.length > 0)
  const heading = nodes.find(n => n.tagName === 'H2')
  assert.equal(heading.textContent, '选择一台主机', '失效 selection 必须回空态而不是读 undefined')
})

// ---- D4 尾项①（§16.4-3 顺延项）：renderBanner 隐藏时必须清空横幅内容 --------------------
// 旧实现只设 hidden：上一次 bannerNode 渲染的图标 / 文案 / 按钮节点留在 DOM
//（含 onclick 闭包引用）。行为闭环：显示（有内容）→ 隐藏（容器必须空）→ 再显示（重建）。
test('D4 renderBanner 隐藏时清空横幅内容，再显示时重建（尾项①回归）', () => {
  const byId = new Map()
  const node = tag => {
    const n = {
      tagName: String(tag ?? 'div').toUpperCase(), children: [], hidden: false,
      className: '', id: '', textContent: '', type: '', value: '', title: '',
      attributes: new Map(), handlers: new Map(), style: {}, disabled: false,
      setAttribute(k, v) { this.attributes.set(k, String(v)) },
      getAttribute(k) { return this.attributes.get(k) ?? null },
      appendChild(c) { this.children.push(c); return c },
      append(...cs) { for (const c of cs) { if (c) this.children.push(c) } },
      replaceChildren(...cs) { this.children = [...cs] },
      addEventListener(k, fn) { this.handlers.set(k, fn) },
      querySelector(sel) { return this.children.find(c => sel.endsWith(c.id) && c.id !== '') ?? null },
      querySelectorAll() { return [] },
    }
    return n
  }
  const doc = {
    body: node('body'),
    createElement: tag => node(tag),
    createElementNS: (_ns, tag) => node(tag),
    getElementById: id => byId.get(id) ?? null,
    querySelector: () => null,
    addEventListener() {},
  }
  const registerIds = n => { if (n.id) byId.set(n.id, n); for (const c of n.children) registerIds(c) }
  const fresh = vm.createContext({
    window: { addEventListener() {} },
    document: doc,
    __doc: doc,
  })
  vm.runInContext(source + `
;globalThis.__renderBanner = renderBanner
;globalThis.__state = state`, fresh, { filename: 'app.js' })
  vm.runInContext('buildSkeleton(__doc.body)', fresh)
  registerIds(doc.body)
  doc.querySelector = sel => sel.startsWith('#') ? (byId.get(sel.slice(1)) ?? null) : null
  const banner = () => doc.getElementById('state-banner')

  // 1) 进入一个有横幅的状态（waiting-fingerprint）：bannerNode 重建内容。
  vm.runInContext(`
    __state.connections.push({ id: 'c-1', label: 'h', host: '127.0.0.1', port: 22, username: 'u', auth: { method: 'password' }, group: 'g', favorite: false })
    __state.tabs.push('c-1'); __state.activeTab = 'c-1'
    __state.frameState = { state: 'waiting-fingerprint', token: 't', fingerprint: 'f' }
  `, fresh)
  vm.runInContext('__renderBanner()', fresh)
  assert.equal(banner().hidden, false)
  const shownCount = banner().children.length
  assert.ok(shownCount >= 3, `显示态应有 icon+文案+按钮（实际 ${shownCount} 节点）`)

  // 2) 切回隐藏态（frameState 置空且无 pendingError）：hidden=true 且容器必须空。
  vm.runInContext('__state.frameState = null', fresh)
  vm.runInContext('__renderBanner()', fresh)
  assert.equal(banner().hidden, true)
  assert.equal(banner().children.length, 0, '隐藏态容器必须清空（旧实现残留按钮/文案节点）')

  // 3) 再切回显示态：内容正常重建（无空白、无旧内容闪烁）。
  vm.runInContext(`__state.frameState = { state: 'connecting' }`, fresh)
  vm.runInContext('__renderBanner()', fresh)
  assert.equal(banner().hidden, false)
  assert.ok(banner().children.length >= 2, '再显示时必须重建 icon+文案')
})

// ---- D2 顶栏段数（2026-09-15 实机验收发现 → 用户定向「hero 态不渲染该段」）----------
// canvas 只注册在会话头 actions 槽 ⇒ hero 态没有胶囊可委托，顶栏「会话布」必然失效。
// 宿主随 chrome 消息下发 canvasAvailable，浮层据此决定段数；默认（没收到字段）保持三段。
test('D2 顶栏段数随 canvasAvailable 变化：会话态三段 / hero 态两段', () => {
  const byId = new Map()
  const node = tag => {
    const n = {
      tagName: String(tag ?? 'div').toUpperCase(), children: [], hidden: false,
      className: '', textContent: '', type: '', title: '', dataset: {},
      attributes: new Map(), handlers: new Map(), style: { setProperty() {}, removeProperty() {} },
      setAttribute(k, v) { this.attributes.set(k, String(v)) },
      getAttribute(k) { return this.attributes.get(k) ?? null },
      addEventListener(k, fn) { this.handlers.set(k, fn) },
      appendChild(c) { this.children.push(c); c.parent = this; return c },
      prepend(c) { this.children.unshift(c); c.parent = this; return c },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this) },
      querySelector() { return null },
      querySelectorAll() { return [] },
    }
    Object.defineProperty(n, 'id', { get: () => n._id ?? '', set: v => { n._id = v; byId.set(v, n) } })
    return n
  }
  const doc = {
    body: node('body'),
    documentElement: node('html'),
    createElement: t => node(t),
    getElementById: id => byId.get(id) ?? null,
    querySelector: () => null,
    addEventListener() {},
  }
  const root = node('div')
  root.id = 'ssh-root'
  doc.body.appendChild(root)
  const fresh = vm.createContext({ window: { addEventListener() {} }, document: doc, __doc: doc, __root: root })
  vm.runInContext(source + `
;globalThis.__buildTopbar = buildTopbar
;globalThis.__applyChrome = applyChrome
;globalThis.__overlayState = overlayState`, fresh, { filename: 'app.js' })

  const segments = () => {
    const bar = root.children.find(c => c.id === 'ssh-topbar')
    const group = bar.children.find(c => c.tagName === 'DIV')
    return group.children.map(b => ({ seg: b.dataset.seg, label: b.textContent, aria: b.getAttribute('aria-current') }))
  }
  const rebuild = () => vm.runInContext('__buildTopbar(__root)', fresh)

  // 默认（未收到 chrome 消息）：三段，SSH 段仍是当前态
  rebuild()
  assert.deepEqual(segments().map(s => s.label), ['对话', '会话布', 'SSH'], '默认必须渲染三段（不擅自减入口）')
  assert.equal(segments().at(-1).aria, 'page')

  // 收到 canvasAvailable=true：仍三段（幂等重建，不叠加）
  vm.runInContext('__applyChrome({ type: "chrome", version: 1, overlayToken: "tok-1", reserve: 150, canvasAvailable: true })', fresh)
  assert.deepEqual(segments().map(s => s.label), ['对话', '会话布', 'SSH'])
  assert.equal(root.children.filter(c => c.id === 'ssh-topbar').length, 1, '重建不得留下两个顶栏')
  assert.equal(vm.runInContext('__overlayState.token', fresh), 'tok-1', 'chrome 消息必须记录 overlayToken')

  // 收到 canvasAvailable=false（hero 态）：只两段，且没有占位死按钮
  vm.runInContext('__applyChrome({ type: "chrome", version: 1, overlayToken: "tok-1", reserve: 0, canvasAvailable: false })', fresh)
  assert.deepEqual(segments().map(s => s.label), ['对话', 'SSH'], 'hero 态不得渲染「会话布」段')
  assert.equal(segments().some(s => s.seg === 'canvas'), false)
  assert.equal(segments().at(-1).aria, 'page', 'SSH 段仍须是当前态')

  // 回到会话态：段数恢复（修复必须是双向的）
  vm.runInContext('__applyChrome({ type: "chrome", version: 1, overlayToken: "tok-1", reserve: 150, canvasAvailable: true })', fresh)
  assert.deepEqual(segments().map(s => s.label), ['对话', '会话布', 'SSH'])
})

// ---- D-1 回归护栏（2026-09-15 实机验收逮到，阻断级）------------------------------
// 「保存并连接」曾写成 `event.saveAndConnect = true`：那颗 `event` 解析到全局 window.event
// （click 事件），而 `dispatchEvent(new Event('submit'))` 让处理器拿到的是新事件对象
// ⇒ 标记永远读不到、connectFlow 从未被调用（按钮实际只保存）。行为闭环由实机验收
// P16a 覆盖（真实点击 + 远端 TCP 计数），这里钉住"不许写回事件对象"这一形态。
test('保存并连接：意图标记不得挂在事件对象上（D-1 回归）', () => {
  assert.doesNotMatch(source, /event\.saveAndConnect/, '不得把意图挂到事件对象（dispatchEvent 后读不到）')
  assert.match(source, /let saveAndConnect = false/, '意图必须走闭包变量')
  assert.match(source, /const alsoConnect = saveAndConnect/, 'submit 处理器必须读闭包标记')
  assert.match(source, /if \(alsoConnect === true\) void connectFlow\(connection\)/, '标记为真时必须真的发起连接')
})

// ---- 桌面壳 chrome 让位（两次实机反馈的回归护栏）-----------------------------------
// ① 2026-09-15：抽屉标题栏的 × 被壳窗控组（fixed 右上角）压住点不到 → 顶部让位
//    （computeChromeClearance），抽屉整体下移到窗控下沿之下。
// ② 2026-09-26：贴边抽屉右下角的确认键被壳主题球（fixed right/bottom 16px 的 46px 圆）
//    压住点不到 → 形态改为**居中悬浮窗**（贴边形态从根上不再适用），并给卡片留出右缘
//    安全线（computeFabSafeRight）；窄窗口下卡片宽度/最大高据此缩，球够不着卡片。
// 两条让位量都取**父视口**坐标实测，浮层（iframe 顶格）与会话视图（iframe 在中栏）
// 共用一套算法：chrome 不在 iframe 内时自然归零。
test('computeChromeClearance：窗控下沿 → 让位量，iframe 在窗控下方时归零', () => {
  const capsule = { width: 100, height: 26, bottom: 37 }
  assert.equal(context.computeChromeClearance(capsule, { top: 0 }), 45, '37 + 8px 呼吸 = 45')
  assert.equal(context.computeChromeClearance(capsule, { top: 44 }), 0, 'iframe 从会话头下方开始：窗控不挡，别凭空下移')
  assert.equal(context.computeChromeClearance(capsule, null), 45, '量不到 iframe 矩形时按顶格算')
  assert.equal(context.computeChromeClearance(capsule, undefined), 45)
  assert.equal(context.computeChromeClearance(null, { top: 0 }), null, '没有窗控组（浏览器）就是"量不到"')
  assert.equal(context.computeChromeClearance({ width: 0, height: 0, bottom: 0 }, { top: 0 }), null, '零尺寸=不可见，按量不到处理')
  assert.equal(context.computeChromeClearance({ width: 10, height: 26, bottom: Number.NaN }, { top: 0 }), null)
})

test('computeFabSafeRight：球左缘 → 卡片右缘安全线，球不在本 iframe 内时归零', () => {
  // 浮层形态：iframe 顶格铺满父视口，球（46px 圆 + right/bottom 16px）落在 iframe 右下角
  const frame = { top: 0, right: 1540, bottom: 1530 }
  const ball = { left: 1478, top: 1468, bottom: 1514, width: 46, height: 46 }
  assert.equal(context.computeFabSafeRight(ball, frame), 76, '球左缘距右缘 62 + 6px 光晕 + 8px 呼吸 = 76')

  // 窄窗口里球已经压进 iframe 内：安全线随 iframe 右缘收窄
  assert.equal(context.computeFabSafeRight(ball, { top: 0, right: 1500, bottom: 1530 }), 36)

  // 球整个在本 iframe 右侧之外（会话视图：iframe 只占中栏）
  assert.equal(context.computeFabSafeRight(ball, { top: 0, right: 800, bottom: 1530 }), 0)
  // 垂直方向与 iframe 不相交（球在 iframe 下方）
  assert.equal(context.computeFabSafeRight(ball, { top: 0, right: 1540, bottom: 1200 }), 0)

  // 量不到 / 不可见：浏览器里没有球，球被 display:none 收起时矩形为零
  assert.equal(context.computeFabSafeRight(null, frame), 0)
  assert.equal(context.computeFabSafeRight({ left: 0, top: 0, bottom: 0, width: 0, height: 0 }, frame), 0)
  // iframe 矩形不可用或缺字段：保守不让位，不凭空把卡片缩窄
  assert.equal(context.computeFabSafeRight(ball, null), 0)
  assert.equal(context.computeFabSafeRight(ball, { top: 0 }), 0)
  assert.equal(context.computeFabSafeRight({ left: Number.NaN, top: 0, bottom: 10, width: 46, height: 46 }, frame), 0)
})

/** 造一个「SSH 页面跑在 iframe 里」的 vm 环境，用于测量 / 让位变量的行为闭环。 */
function bootShell({ capsuleRect = null, ballRect = null, frameRect = null, topLevel = false, throwOnQuery = false } = {}) {
  const style = new Map()
  const iframeDoc = {
    addEventListener() {},
    documentElement: { style: { setProperty: (key, value) => style.set(key, value) } },
  }
  const element = rect => (rect === null ? null : { getBoundingClientRect: () => rect })
  const parentDoc = {
    querySelector(selector) {
      if (throwOnQuery) throw new Error('SecurityError: cross-origin frame')
      return String(selector).includes('miasaki-switcher') ? element(ballRect) : element(capsuleRect)
    },
  }
  const win = { addEventListener() {} }
  win.parent = topLevel ? win : { document: parentDoc }
  win.frameElement = frameRect === null ? null : { getBoundingClientRect: () => frameRect }
  const ctx = vm.createContext({ window: win, document: iframeDoc })
  vm.runInContext(source, ctx, { filename: 'app.js' })
  return { ctx, style }
}

test('syncChromeClearance：两条让位变量都由父视口实测写出，量不到归零', () => {
  const capsuleRect = { width: 100, height: 26, bottom: 37 }
  const frameRect = { top: 0, right: 1540, bottom: 1530 }
  const ballRect = { left: 1478, top: 1468, bottom: 1514, width: 46, height: 46 }

  // ① 桌面壳浮层形态：卡片下移 45px（窗控下沿 + 8px 呼吸）、右缘留 76px（球安全线）
  const shell = bootShell({ capsuleRect, ballRect, frameRect })
  assert.equal(vm.runInContext('measureChromeClearance()', shell.ctx), 45)
  assert.equal(vm.runInContext('measureShellFab()', shell.ctx), 76)
  vm.runInContext('syncChromeClearance()', shell.ctx)
  assert.equal(shell.style.get('--ssh-chrome-clearance'), '45px')
  assert.equal(shell.style.get('--ssh-shell-fab-safe-right'), '76px')

  // ② 会话视图（iframe 在中栏，两块壳 chrome 都在 iframe 之外）：都归零，卡片按 32px 基数居中
  const lower = bootShell({ capsuleRect, ballRect, frameRect: { top: 44, right: 800, bottom: 900 } })
  vm.runInContext('syncChromeClearance()', lower.ctx)
  assert.equal(lower.style.get('--ssh-chrome-clearance'), '0px')
  assert.equal(lower.style.get('--ssh-shell-fab-safe-right'), '0px')

  // ③ 浏览器（没有壳 chrome）：归零，且不再写已退役的 --ssh-chrome-avoid-right
  const plain = bootShell({})
  assert.equal(vm.runInContext('measureChromeClearance()', plain.ctx), null)
  assert.equal(vm.runInContext('measureShellFab()', plain.ctx), null)
  vm.runInContext('syncChromeClearance()', plain.ctx)
  assert.equal(plain.style.get('--ssh-chrome-clearance'), '0px')
  assert.equal(plain.style.get('--ssh-shell-fab-safe-right'), '0px')
  assert.equal(plain.style.has('--ssh-chrome-avoid-right'), false)

  // ④ 顶层窗口（浏览器直接打开 /ssh/）：归零
  const top = bootShell({ capsuleRect, ballRect, frameRect, topLevel: true })
  vm.runInContext('syncChromeClearance()', top.ctx)
  assert.equal(top.style.get('--ssh-chrome-clearance'), '0px')
  assert.equal(top.style.get('--ssh-shell-fab-safe-right'), '0px')

  // ⑤ 跨源读父文档抛错：静默降级为不让位，不冒泡
  const crossOrigin = bootShell({ throwOnQuery: true })
  vm.runInContext('syncChromeClearance()', crossOrigin.ctx)
  assert.equal(crossOrigin.style.get('--ssh-chrome-clearance'), '0px')
  assert.equal(crossOrigin.style.get('--ssh-shell-fab-safe-right'), '0px')
})

test('悬浮窗形态的样式契约：遮罩居中 + 顶部让位 + 卡片按球安全线留边', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.overlay \{[^}]*display: flex; align-items: center; justify-content: center;/,
    '悬浮窗必须居中，不得退回贴右缘的抽屉')
  assert.match(css, /\.overlay \{[^}]*padding: var\(--ssh-chrome-clearance, 0px\) 0 0;/,
    '顶部让位要落在遮罩层的内边距上，卡片（含右上角 ×）才会整体落到壳窗控之下')
  assert.match(css, /--ssh-modal-edge: max\(32px, var\(--ssh-shell-fab-safe-right, 0px\)\)/,
    '卡片边距 = 32px 基数与球安全线取大值')
  assert.match(css, /\.sheet \{[^}]*width: min\(var\(--ssh-modal-w\), calc\(100% - 2 \* var\(--ssh-modal-edge\)\)\)/)
  assert.match(css, /\.sheet \{[^}]*max-height: calc\(100% - 64px\)/,
    '高度只留固定呼吸位：球在右下角，与卡片上下边界无关')
  assert.doesNotMatch(css, /--ssh-chrome-avoid-right/, '水平让位兜底随贴边抽屉形态一起退役')
})

// 实机反馈（2026-09-26）：主机栏里连端口一起填 ⇒ getaddrinfo ENOTFOUND。host 半在
// connect 时就地拆分并回写（见 runtime.test.js / http.test.js），页面这半边必须把
// 「改了什么」说出来 + 刷新列表，否则用户会以为端口凭空变了。
test('连接回报 repaired 时必须提示用户并刷新连接列表', () => {
  assert.match(source, /result\?\.repaired === 'object'/, '要判 repaired 存在')
  assert.match(source, /setStatusNote\(`主机地址里带着端口/, '要如实说明端口被移到「端口」栏')
  assert.match(source, /await refreshConnections\(\)/, '要刷新列表，标题栏地址随之更新')
})

// 连接诊断（档 B）：两个入口 + 两条默认值（出口 IP 与认证方式探测都默认关，点了才发）。
test('连接诊断：两个入口、复制报告、两条「点了才发」的默认值', () => {
  assert.match(source, /label: '连接诊断'/, '工具区「⋯」菜单要有入口')
  assert.match(source, /label: '测试连接'/, '编辑主机弹窗要有测试连接（草稿也能测）')
  assert.match(source, /body\.draft = draft/, '草稿走 draft 目标')
  assert.match(source, /resolveEgress: options\.resolveEgress === true/, '出口 IP 逐次显式请求')
  assert.match(source, /probeAuth: options\.probeAuth === true/, '认证方式探测逐次显式请求')
  assert.match(source, /label: '查询公网出口 IP'/, '要有一个按钮，而不是自动跑')
  assert.match(source, /label: '探测认证方式'/, '认证方式默认不探测')
  assert.match(source, /label: '复制报告'/, '报告要能一键复制')
  assert.match(source, /才会外呼第三方服务/, '界面要写明出口 IP 会外呼')
})

test('连接诊断面板的样式契约：结论条按 level 上色 + 事实格', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.diag-verdict\.ok \{ border-left-color: var\(--ssh-ok\)/)
  assert.match(css, /\.diag-verdict\.warn \{[^}]*var\(--ssh-warn\)/)
  assert.match(css, /\.diag-verdict\.error \{[^}]*var\(--ssh-err\)/)
  assert.match(css, /\.diag-grid \{ display: grid;/)
})

// 实机反馈（2026-09-26）：「只读：另一个窗口正在此终端输入」在**未连接**时也常驻。
// 根因是旧判据 `bar.hidden = isWriteOwner()` —— 没有会话时 isWriteOwner()=false 也会把
// 横幅翻开。现在只在「会话活着 + 服务端明确说只读」时才显示。
test('只读条判据：无会话 / 写权未决时必须收起', () => {
  assert.match(source, /const live = session !== null && isLive\(liveOf\(session\.connId\)\)/)
  assert.match(source, /const readOnly = live && session\.isReadOnly\(\) === true/)
  assert.match(source, /bar\.hidden = !readOnly/)
  assert.doesNotMatch(source, /bar\.hidden = writable/, '旧写法把「无会话」也算成只读 ⇒ 横幅常驻')
  assert.match(source, /isReadOnly\(\) === true.*接管写入|写入权已空出.*isReadOnly/s, '写权空出提示也要用「明确只读」，未决态不提示')
})
