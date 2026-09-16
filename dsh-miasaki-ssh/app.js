// @miasaki/dsh-ssh — browser half (served inside the /ssh/ iframe).
//
// U1 工作区（design/2026-09-12-ssh-workspace-plan.md §3/§4）：
//   可收起主机导航（搜索 / 分组 / 收藏 / 存活状态） + 多主机终端标签 +
//   终端工具区（查找 / 专注 / 更多菜单） + 单条状态栏；编辑器与信任/凭据
//   走右侧 sheet 抽屉。宿主是唯一主题源（client.js 桥接 → --ssh-* 令牌 +
//   xterm theme），本文件不设皮肤选择器。
//
// U0 生命周期契约保持不变：打开已连接主机只 attach；查看器实例整体可销毁；
// 关闭查看 ≠ 断开连接；秘密只在提交期间存在。
'use strict'

const $ = s => document.querySelector(s)

const state = {
  connections: [],
  live: new Map(),        // connId → runtime state string
  trustMap: new Map(),    // hostKey → { fingerprint, algo, firstSeenAt }
  selection: null,        // rail 选中的主机 id
  tabs: [],               // U2.1：结构化标签 [{ connId, shellSeq, title, live }]（有序）
  activeTab: null,        // 激活标签在 tabs 中的下标；无激活为 null
  session: null,          // 查看器实例（一次只有一个活跃查看器）
  railHidden: false,
  drawerOpen: false,
  focusMode: false,
  searchOpen: false,
  prefs: { fontSize: 13 },
  pendingError: null,     // { message } —— 无会话时的连接失败展示
  frameState: null,       // 当前会话最近一次 SSH 状态（banner 依据）
  transport: false,       // 查看器通道正在重附着
  theme: null,
  xtermTheme: null,
  hostsVersion: 0,
}

const PREFS_KEY = 'dsh-ssh:prefs'
// 工作区记忆两张据（U2 决策 4，方案 §4.3.2）：
//   偏好（字号 / rail 折叠 / 专注）→ localStorage（跨标签页共享）—— PREFS_KEY，v2；
//   工作区快照（标签集合与激活项 / 抽屉状态）→ sessionStorage（按标签页隔离，
//   刷新保留、关标签页即忘）—— WORKSPACE_KEY，v1。
// 两者都带 version + 全 try/catch：解析失败 / 版本不认 / 无痕模式一律回默认，绝不白屏。
const PREFS_VERSION = 2
const WORKSPACE_KEY = 'dsh-ssh:workspace'
const WORKSPACE_VERSION = 1

/** 统一 sessionStorage 安全读写（决策 4 的落地封装；无痕模式抛错一律吞掉）。 */
const sessionStore = {
  get(key) {
    try { return window.sessionStorage.getItem(key) } catch { return null }
  },
  set(key, value) {
    try { window.sessionStorage.setItem(key, value); return true } catch { return false }
  },
  remove(key) {
    try { window.sessionStorage.removeItem(key) } catch { /* 无痕模式等：不可用则刷新后回到空态 */ }
  },
}

/** U2.3：读工作区快照。损坏 / 版本不认 ⇒ null（调用方回默认）。 */
function readWorkspace() {
  const raw = sessionStore.get(WORKSPACE_KEY)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== WORKSPACE_VERSION) return null
    return parsed
  } catch { return null }
}

/** U2.3：写工作区快照。写失败（配额/隐私模式）静默 —— 记忆是增强，不是依赖。 */
function saveWorkspace() {
  const snap = {
    version: WORKSPACE_VERSION,
    savedAt: new Date().toISOString(),
    tabs: state.tabs.map(tab => ({
      connId: tab.connId,
      shellSeq: tab.shellSeq,
      title: tab.title ?? null,
    })),
    activeTab: Number.isInteger(state.activeTab) ? state.activeTab : null,
    drawerOpen: state.drawerOpen === true,
  }
  return sessionStore.set(WORKSPACE_KEY, JSON.stringify(snap))
}

function rememberLastTab(connId) {
  // 兼容旧调用面：语义 = 把激活标签指到该主机的（首个）标签；null 清空激活项。
  if (connId === null) {
    const ws = readWorkspace()
    if (ws !== null) {
      ws.activeTab = null
      sessionStore.set(WORKSPACE_KEY, JSON.stringify(ws))
    }
    return
  }
  const idx = state.tabs.findIndex(tab => tab.connId === connId)
  if (idx === -1) return
  const ws = readWorkspace() ?? { version: WORKSPACE_VERSION, tabs: [], activeTab: null, drawerOpen: false }
  ws.activeTab = idx
  sessionStore.set(WORKSPACE_KEY, JSON.stringify(ws))
}

function readLastTab() {
  const ws = readWorkspace()
  if (ws === null) return null
  const tab = Array.isArray(ws.tabs) ? ws.tabs[ws.activeTab] : undefined
  return tab?.connId ?? null
}

// ------------------------------------------------------------------ api
async function api(path, options = {}) {
  const res = await fetch(path, options)
  let body = null
  try { body = await res.json() } catch { /* non-json response */ }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })

const STATE_TEXT = {
  idle: '未连接', connecting: '连接中…', 'waiting-fingerprint': '等待指纹确认',
  connected: '已连接', closed: '已断开', error: '失败',
}
const stateText = s => STATE_TEXT[s] ?? s
const isLive = s => s === 'connected' || s === 'connecting' || s === 'waiting-fingerprint'

// ------------------------------------------------------------------ dom helpers
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const ICON_PATHS = {
  terminal: 'm5 6 6 6-6 6m9 0h5',
  server: 'M7 7h.01M7 17h.01m5-10h5m-5 10h5',
  serverRects: null,
  search: 'm16 16 4.5 4.5',
  plus: 'M12 5v14M5 12h14',
  panel: 'M9 4v16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  send: 'M5 12h13m-5-6 6 6-6 6',
  focus: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
  close: 'm6 6 12 12M6 18 18 6',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z',
  copy: 'M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3',
  edit: 'm14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-4-4L5 15l-1 5Z',
  disconnect: 'M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4M3 3l18 18',
  info: 'M12 11v6m0-10h.01',
  star: 'm12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.7l6.2-.9L12 3Z',
}
function icon(name, extraPath) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const rect = (x, y, w, h) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    node.setAttribute('x', String(x)); node.setAttribute('y', String(y))
    node.setAttribute('width', String(w)); node.setAttribute('height', String(h))
    node.setAttribute('rx', '2')
    return node
  }
  if (name === 'server') svg.append(rect(4, 4, 16, 6), rect(4, 14, 16, 6))
  if (name === 'panel') svg.append(rect(3, 4, 18, 16))
  if (name === 'copy') svg.append(rect(8, 8, 12, 13))
  if (name === 'search') {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    circle.setAttribute('cx', '10.5'); circle.setAttribute('cy', '10.5'); circle.setAttribute('r', '6.5')
    svg.appendChild(circle)
  }
  if (name === 'info') {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '9')
    svg.appendChild(circle)
  }
  if (name === 'more') {
    for (const [cx, cy] of [[5, 12], [12, 12], [19, 12]]) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      circle.setAttribute('cx', String(cx)); circle.setAttribute('cy', String(cy)); circle.setAttribute('r', '1')
      svg.appendChild(circle)
    }
  }
  if (name === 'shield') {
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    check.setAttribute('d', 'm8 12 3 3 5-6')
    svg.appendChild(check)
  }
  const main = ICON_PATHS[name]
  const paths = [main, extraPath].filter(d => typeof d === 'string' && d.length > 0)
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

// ------------------------------------------------------------------ theme（plan §4）
const ANSI = {
  light: ['#2b3446', '#ba343b', '#29714c', '#8b631b', '#3158cb', '#9d3fa9', '#0f6a8a', '#c9d0da',
    '#5e6879', '#d24a52', '#3d9a63', '#b3822f', '#5b7ff5', '#b56cc2', '#2f8fad', '#eef1f6'],
  dark: ['#e3e8f0', '#efa0a6', '#8bc9a4', '#e3c27b', '#8fafff', '#cf9ce0', '#8fd3e8', '#3a4250',
    '#5b6675', '#f4b6bd', '#a5dcb9', '#efd29a', '#a8c2ff', '#dcb6ee', '#a8dcec', '#eef1f6'],
}
const COLOR_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([^)]*\)|hsla?\([^)]*\))$/i

function parseColorParts(value) {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)
  if (hex !== null) {
    let h = hex[1]
    if (h.length <= 4) h = [...h].map(c => c + c).join('')
    const n = h.length >= 8 ? 2 : 0
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: n === 2 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    }
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(value)
  if (fn !== null) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean)
    const nums = parts.slice(0, 3).map(v => Number.parseFloat(v))
    const a = parts[3] !== undefined ? Number.parseFloat(parts[3]) : 1
    if (nums.every(v => Number.isFinite(v)) && Number.isFinite(a)) return { r: nums[0], g: nums[1], b: nums[2], a }
  }
  return null
}

function toHex({ r, g, b }) {
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** 半透明宿主色在已知实体底色上合成，保证终端不透明（plan §4.2-5）。 */
function compositeOver(color, baseHex) {
  const parts = parseColorParts(color)
  if (parts === null || parts.a >= 1) return color
  const base = parseColorParts(baseHex)
  if (base === null) return color
  return toHex({ r: parts.r * parts.a + base.r * (1 - parts.a), g: parts.g * parts.a + base.g * (1 - parts.a), b: parts.b * parts.a + base.b * (1 - parts.a) })
}

/** CSS 变量可用则用宿主值（半透明合成到实体底），不可用则回退方案默认。 */
function tokenColor(value, fallback, baseHex) {
  if (typeof value === 'string' && COLOR_RE.test(value.trim())) return compositeOver(value.trim(), baseHex)
  return fallback
}

function applyThemeSnapshot(snap) {
  if (snap === null || typeof snap !== 'object') return
  const dark = snap.dark === true
  const root = document.documentElement
  root.dataset.scheme = dark ? 'dark' : 'dark-fallback-never'
  root.dataset.scheme = dark ? 'dark' : 'light'
  const tokens = snap.tokens ?? {}
  const termBase = dark ? '#15191f' : '#ffffff'
  const set = (name, value) => { if (value !== null) root.style.setProperty(name, value) }
  set('--ssh-bg', tokenColor(tokens.bgBase, null, termBase))
  set('--ssh-surface', tokenColor(tokens.layer1, null, termBase))
  set('--ssh-raised', tokenColor(tokens.layer2, null, termBase))
  set('--ssh-border', tokenColor(tokens.border, null, termBase))
  set('--ssh-text', tokenColor(tokens.textPrimary, null, termBase))
  set('--ssh-muted', tokenColor(tokens.textSecondary, null, termBase))
  set('--ssh-hover', tokenColor(tokens.hoverBg, null, termBase))
  const accent = tokenColor(tokens.accent, null, termBase)
  set('--ssh-accent', accent)
  state.theme = snap
  state.xtermTheme = composeXtermTheme(dark, tokens, accent)
  if (state.session !== null) state.session.applyTheme(state.xtermTheme)
  const family = snap.typography?.fontFamily
  if (typeof family === 'string' && family.length > 0 && family.length < 600) document.body.style.fontFamily = family
}

function composeXtermTheme(dark, tokens, accent) {
  const termBase = dark ? '#15191f' : '#ffffff'
  const solidAccent = parseColorParts(accent) !== null && parseColorParts(accent).a >= 1 ? accent : (dark ? '#638aff' : '#3964fe')
  let selection = solidAccent
  const hexSel = /^#[0-9a-f]{6}$/i.exec(solidAccent)
  if (hexSel !== null) selection = `${solidAccent}4d`
  return {
    background: tokenColor(tokens.bgBase, termBase, termBase),
    foreground: tokenColor(tokens.textPrimary, dark ? '#e3e8f0' : '#2b3446', termBase),
    cursor: solidAccent,
    cursorAccent: solidAccent,
    selectionBackground: selection,
    ...(dark ? { dark } : {}),
    ...Object.fromEntries(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']
      .map((key, i) => [key, (dark ? ANSI.dark : ANSI.light)[i]])),
  }
}

/** 首帧同源直读（plan §4.2-9）：桥接消息到达前不闪兜底色。 */
function initialTheme() {
  try {
    const cached = window.parent?.__DSH_SSH_THEME__
    if (cached !== null && typeof cached === 'object' && cached.source === 'dsh-ssh') return cached
  } catch { /* 跨域父文档（不该发生） */ }
  let dark = false
  try { dark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true } catch { /* noop */ }
  return { dark, tokens: {}, typography: null }
}

// ---- 顶栏（D2，浮层模式专属）------------------------------------------
// 浮层（路线丁）盖住会话头 ⇒ SSH 页面必须自绘「对话｜会话布｜SSH」顶栏，否则
// 用户被困（D1 单向门教训）。仅在浮层模式下渲染：判定 = 嵌在 iframe 里（
// window.parent !== window）且能从 parent 拿到浮层标记。回退视图（conversation.
// view）里 parent 同样存在但没有浮层标记 ⇒ 不渲染（回退期里官方 tab 栏就是切换器）。
// 「对话」「会话布」两颗按钮的行为落在宿主侧（client.js 的 onOverlayMessage）：
// 消息带 overlayToken（由 chrome 消息下发，宿主校验防伪）。顶栏消费
// --ssh-chrome-reserve 给桌面壳窗控让位（D0 ③ 实测过的量法，client.js 下发）。
function setupThemeListener() {
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return
    if (event.origin !== window.location.origin) return
    const data = event.data
    if (data === null || typeof data !== 'object' || data.source !== 'dsh-ssh') return
    if (data.type === 'theme' && data.version === 1) {
      applyThemeSnapshot(data)
      return
    }
    // chrome 消息（D2）：桌面壳窗控让位量 + 顶栏消息令牌（宿主校验用）+ 会话布段可用性。
    if (data.type === 'chrome' && data.version === 1) {
      applyChrome(data)
      return
    }
  })
}

/**
 * 应用宿主 chrome 消息。`canvasAvailable` 是 D2 的语义边界收口（§16.3）：hero 态没有
 * 会话头 ⇒ canvas 没有胶囊可委托 ⇒ 顶栏那一段若照常渲染就是一颗必然无效的按钮。
 * 宿主把事实下发过来，浮层据此决定渲不渲染该段（默认渲染：没收到字段时不擅自减入口）。
 */
function applyChrome(data) {
  overlayState.token = typeof data.overlayToken === 'string' && data.overlayToken.length > 0 ? data.overlayToken : null
  const reserve = Number.isFinite(data.reserve) ? Math.max(0, Math.round(data.reserve)) : 0
  overlayState.reserve = reserve
  try { document.documentElement.style.setProperty('--ssh-chrome-reserve', reserve + 'px') } catch { /* 只读环境 */ }
  // 抽屉让位的兜底口径跟着宿主的实测值走（量不到窗控组时用水平让位顶上，见 syncChromeClearance）。
  syncChromeClearance()
  const available = data.canvasAvailable !== false
  if (available !== overlayState.canvasAvailable) {
    overlayState.canvasAvailable = available
    const root = document.getElementById('ssh-root')
    // 只在真的变化时重建；顶栏自身无状态，重建比增删节点更不容易留下半截结构。
    if (root !== null && document.getElementById('ssh-topbar') !== null) buildTopbar(root)
  }
}

const overlayState = { token: null, current: 'ssh', canvasAvailable: true, reserve: 0 }

// ---- 桌面壳窗控让位（实机反馈修复）------------------------------------------
// 桌面壳的窗控组（`#miasaki-titlebar .tb-group`：主题徽记 + 最小化/最大化/关闭）是
// **fixed 右上角的零占位浮层**，压在页面之上。SSH 页面在壳里跑在 iframe 内，右上角那
// 片像素恰好是「新建主机」等抽屉标题栏的位置 ⇒ 抽屉的 × 关闭按钮与窗控组叠在同一块
// 像素上（实机截图实测：两者中心只差 14×9px，× 被窗控压住、点不到）。
//
// 让位口径取**抽屉整体下移到窗控下沿之下**，而不是把 × 往左推：
// ① 会话头第一行的入口胶囊（窄窗口下的紧凑态 `>_`）也在这一行，往左让位会撞上它；
// ② 窄窗口里往左让位会把 × 推到抽屉中间，标题栏右侧空出一大片，读感更差；
// ③ 浏览器里量不到窗控（clearance = 0），抽屉照旧顶格，零副作用。
//
// 坐标系：窗控组与 iframe 的矩形都取**父视口**坐标，两者相减即得「本 iframe 内需要让开
// 的顶部高度」。iframe 本就在窗控下方时（会话视图里 iframe 从会话头下开始）差值为负，
// 归零 —— 不需要为两种挂载形态写分支。
const CHROME_GAP_PX = 8 // 窗控下沿再留一段呼吸，避免「贴着」的读感

/** 纯函数：父视口坐标下的窗控组矩形 + iframe 矩形 → 本 iframe 顶部让位量（px）；量不到返回 null。 */
function computeChromeClearance(capsuleRect, frameRect) {
  if (capsuleRect === null || capsuleRect === undefined) return null
  if (!(capsuleRect.width > 0) || !(capsuleRect.height > 0)) return null
  const bottom = Number(capsuleRect.bottom)
  if (!Number.isFinite(bottom)) return null
  const frameTop = frameRect !== null && frameRect !== undefined && Number.isFinite(frameRect.top)
    ? Number(frameRect.top)
    : 0
  const overlap = bottom - frameTop
  if (overlap <= 0) return 0 // 窗控整条都在 iframe 之上：不挡任何东西，别凭空下移抽屉
  return Math.ceil(overlap + CHROME_GAP_PX)
}

/** 从父文档量窗控组（同源才可读）；顶层窗口 / 无窗控组 / 跨源一律 null。 */
function measureChromeClearance() {
  try {
    if (window.parent === window) return null
    const doc = window.parent !== null && window.parent !== undefined ? window.parent.document : null
    // `.tb-capsule` 是 v3 旧类名，一并查：主题版本落后时让位不至于静默失效。
    const capsule = doc?.querySelector?.('#miasaki-titlebar .tb-group') ??
      doc?.querySelector?.('#miasaki-titlebar .tb-capsule') ?? null
    if (capsule === null || typeof capsule.getBoundingClientRect !== 'function') return null
    const frame = window.frameElement ?? null
    const frameRect = frame !== null && typeof frame.getBoundingClientRect === 'function'
      ? frame.getBoundingClientRect()
      : null
    return computeChromeClearance(capsule.getBoundingClientRect(), frameRect)
  } catch { return null } // 跨源 iframe / 宿主文档不可读
}

/**
 * 写让位变量。量到窗控 → 抽屉顶部下移（`--ssh-chrome-clearance`）；量不到窗控组但宿主
 * 下发了 reserve（浮层模式下 client.js 从同一元素实测）→ 退回水平让位
 * （`--ssh-chrome-avoid-right`）。两条路都不会让 × 压在窗控上面。
 */
function syncChromeClearance() {
  const measured = measureChromeClearance()
  const clearance = measured ?? 0
  const avoidRight = measured === null ? overlayState.reserve : 0
  try {
    const style = document.documentElement.style
    style.setProperty('--ssh-chrome-clearance', clearance + 'px')
    style.setProperty('--ssh-chrome-avoid-right', avoidRight + 'px')
  } catch { /* 只读环境 */ }
}

// 窗口尺寸变化会同时改 iframe 在父视口里的位置（会话视图下中栏宽度变了，右缘跟着动），
// 让位量必须重测；用 rAF 合并连续的 resize 事件。
let chromeClearanceFrame = 0
function scheduleChromeClearance() {
  if (chromeClearanceFrame !== 0) return
  const schedule = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : callback => setTimeout(callback, 16)
  chromeClearanceFrame = schedule(() => {
    chromeClearanceFrame = 0
    syncChromeClearance()
  })
}
function isOverlayMode() {
  try {
    if (window.parent === window) return false
    const marker = window.parent?.document?.querySelector?.('.dsh-ssh-host .dsh-ssh-overlay')
    return marker !== null && marker !== undefined
  } catch { return false }
}
function postToHost(message) {
  try {
    if (overlayState.token === null) return
    window.parent.postMessage({ source: 'dsh-ssh', overlayToken: overlayState.token, ...message }, window.location.origin)
  } catch { /* 宿主不可达：顶栏按钮静默无效（不抛错） */ }
}
function sendOverlayClose() { postToHost({ type: 'ssh:close' }) }
function sendOverlayCanvas() { postToHost({ type: 'ssh:view', view: 'canvas' }) }

/** 顶栏 DOM：三段胶囊（与宿主侧入口同视觉语言：999px 圆角、28px 高、令牌配色）。 */
function buildTopbar(root) {
  const previous = document.getElementById('ssh-topbar')
  if (previous !== null) previous.remove() // 幂等：重建（canvasAvailable 变化时）不留半截结构
  const bar = document.createElement('header')
  bar.className = 'topbar'
  bar.id = 'ssh-topbar'
  const group = document.createElement('div')
  group.className = 'topbar-switch'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', '视图切换')
  const buttons = [
    { id: 'dialog', label: '对话', title: '退出 SSH，回到会话', run: sendOverlayClose },
    // 「会话布」只在宿主确认 canvas 入口在场时才渲染（hero 态没有会话头 ⇒ 没有胶囊可委托）。
    ...(overlayState.canvasAvailable === true
      ? [{ id: 'canvas', label: '会话布', title: '切换到会话布', run: sendOverlayCanvas }]
      : []),
    { id: 'ssh', label: 'SSH', title: 'SSH（当前）', run: null },
  ]
  for (const item of buttons) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `topbar-btn${item.id === 'ssh' ? ' active' : ''}`
    btn.dataset.seg = item.id
    btn.textContent = item.label
    btn.title = item.title
    btn.setAttribute('aria-label', item.label)
    if (item.id === 'ssh') btn.setAttribute('aria-current', 'page')
    if (item.run !== null) btn.addEventListener('click', item.run)
    group.appendChild(btn)
  }
  bar.appendChild(group)
  root.prepend(bar)
  return bar
}

// ------------------------------------------------------------------ view model（纯函数，vm 测试覆盖）
function matchesQuery(conn, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (q.length === 0) return true
  const haystack = `${conn.label} ${conn.username}@${conn.host}:${conn.port} ${conn.group}`.toLowerCase()
  return haystack.includes(q)
}

/** 主机导航数据：搜索过滤 → 分组 → 组内收藏优先 → 组名排序（未分组垫底）。 */
function hostGroups(connections, query, liveOf) {
  const filtered = connections.filter(conn => matchesQuery(conn, query))
  const groups = new Map()
  for (const conn of filtered) {
    const group = conn.group || '未分组'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(conn)
  }
  const names = [...groups.keys()].sort((a, b) => {
    if (a === '未分组') return 1
    if (b === '未分组') return -1
    return a < b ? -1 : a > b ? 1 : 0
  })
  return names.map(name => ({
    name,
    hosts: groups.get(name).sort((a, b) => Number(b.favorite === true) - Number(a.favorite === true)),
  })).filter(group => group.hosts.length > 0)
}

/** 终端粘贴守卫：多行或含控制字符的内容先确认（plan §6）。 */
function looksSuspiciousPaste(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  if (/[\r\n]/.test(text)) return true
  // 控制字符（Tab 之外，含 ESC）都先预览确认——与 plan §6「含控制字符粘贴先预览」一致
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
}

/**
 * 「送往对话」的消息格式（A0）：首行标注来源主机，其后是正文。
 * 纯函数（vm 测试覆盖）——A0 走剪贴板通道，这个字符串就是它唯一的产物：
 * 用户把它粘进对话，Agent 由此知道内容来自哪台机器（plan §8.2「主机上下文」）。
 */
function formatSshContext(conn, body, options = {}) {
  const text = String(body ?? '').replace(/\s+$/, '')
  if (text.length === 0) return ''
  const address = conn === null || conn === undefined
    ? '未知主机'
    : `${conn.label} · ${conn.username}@${conn.host}:${conn.port}`
  const head = `[SSH ${address}]`
  const intro = typeof options.intro === 'string' ? options.intro.trim() : ''
  return intro.length > 0 ? `${head} ${intro}\n${text}` : `${head}\n${text}`
}

/** 三种送出意图（plan §8.2）：正文之外要不要再给 Agent 一句引导语。 */
const SEND_INTENTS = {
  selection: '',
  recent: '这是终端的最近输出：',
  error: '帮我看下这段终端输出有什么问题：',
}

// ------------------------------------------------------------------ live state
const byId = id => state.connections.find(conn => conn.id === id)
const liveOf = id => state.live.get(id) ?? 'idle'

async function refreshConnections() {
  const data = await api('/ssh/api/connections')
  state.connections = data.connections ?? []
  for (const conn of state.connections) {
    if (typeof conn.state === 'string') state.live.set(conn.id, conn.state)
  }
}

async function refreshTrust() {
  try {
    const hosts = (await api('/ssh/api/hosts')).hosts ?? []
    state.trustMap = new Map(hosts.map(entry => [entry.hostKey, entry]))
  } catch { /* 信任记录不可用时状态栏不显示信任项 */ }
}

const trustOf = conn => state.trustMap.get(`${conn.host}:${conn.port}`) ?? null

// ------------------------------------------------------------------ prefs
function loadPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        if (Number.isFinite(parsed.fontSize)) state.prefs.fontSize = Math.min(20, Math.max(12, Math.round(parsed.fontSize)))
        state.railHidden = parsed.railHidden === true
        state.focusMode = parsed.focus === true
      }
    }
  } catch { /* 无痕模式等：偏好不可用则用默认 */ }
}

function savePrefs() {
  try {
    // prefs v2（方案 §4.3.2）：与 v1 的差别只有 version 字段，读取端两者兼容
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({
      version: PREFS_VERSION,
      fontSize: state.prefs.fontSize,
      railHidden: state.railHidden,
      focus: state.focusMode,
    }))
  } catch { /* noop */ }
}

// ------------------------------------------------------------------ sheet（右侧抽屉）
let sheetReturnFocus = null

function openSheet(title, bodyNodes, actions, { wide = false } = {}) {
  closeMenu()
  sheetReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  $('#sheet-title').textContent = title
  $('#sheet').classList.toggle('wide', wide === true)
  const body = $('#sheet-body')
  body.replaceChildren(...bodyNodes)
  const foot = $('#sheet-actions')
  foot.replaceChildren()
  for (const action of actions) {
    const btn = el('button', `text-btn${action.primary ? ' primary-btn' : ''}${action.danger ? ' danger-text' : ''}`, action.label)
    btn.type = 'button'
    btn.onclick = action.run
    foot.appendChild(btn)
  }
  $('#sheet-overlay').classList.remove('hidden')
  $('#host-rail').inert = true
  $('#workspace-main').inert = true
  window.requestAnimationFrame(() => {
    const focus = body.querySelector('input, select, button:not([disabled])')
    ;(focus ?? $('#sheet-close')).focus()
  })
}

function closeSheet() {
  const overlay = $('#sheet-overlay')
  if (overlay.classList.contains('hidden')) return
  for (const input of overlay.querySelectorAll('input[type="password"]')) input.value = '' // 秘密清理
  overlay.classList.add('hidden')
  $('#host-rail').inert = false
  $('#workspace-main').inert = false
  $('#sheet-body').replaceChildren()
  $('#sheet-actions').replaceChildren()
  const back = sheetReturnFocus
  sheetReturnFocus = null
  const target = back !== null && back.isConnected && back !== document.body && !back.closest('[hidden]') ? back : $('#toggle-rail')
  target?.focus()
}

function fieldNode(labelText, inputNode) {
  const wrap = el('label', 'field')
  const label = el('span', '', labelText)
  wrap.append(label, inputNode)
  return wrap
}

function inputNode(id, value, { type = 'text', placeholder = '', required = false, maxlength } = {}) {
  const input = el('input')
  input.id = id
  input.type = type
  if (value !== undefined && value !== null) input.value = String(value)
  if (placeholder !== '') input.placeholder = placeholder
  if (required) input.required = true
  if (maxlength !== undefined) input.maxLength = maxlength
  if (type === 'password') input.autocomplete = 'off'
  return input
}

// ------------------------------------------------------------------ 编辑器（plan §3.3）
function openEditor(conn = null) {
  const editing = conn !== null
  const name = inputNode('edit-label', conn?.label, { required: true, maxlength: 80, placeholder: '例如 web-01' })
  const host = inputNode('edit-host', conn?.host, { required: true, maxlength: 253, placeholder: '主机域名或 IP' })
  const port = inputNode('edit-port', conn?.port ?? 22, { type: 'number', required: true })
  port.min = '1'; port.max = '65535'
  const username = inputNode('edit-username', conn?.username, { required: true, maxlength: 255, placeholder: '输入用户名，不默认 root' })
  const method = el('select')
  method.id = 'edit-method'
  for (const [value, label] of [['password', '密码'], ['key', '私钥'], ['agent', 'SSH Agent']]) {
    const opt = el('option', '', label)
    opt.value = value
    method.appendChild(opt)
  }
  method.value = conn?.auth?.method ?? 'password'
  const keyPath = inputNode('edit-keypath', conn?.auth?.keyPath, { placeholder: '运行 dsh web 的机器上的绝对路径' })
  const group = inputNode('edit-group', conn?.group ?? '未分组', { maxlength: 40 })
  const keyField = fieldNode('私钥路径', keyPath)
  const syncKeyField = () => { keyField.hidden = method.value !== 'key' }
  method.addEventListener('change', syncKeyField)
  syncKeyField()

  const error = el('p', 'form-error', '')
  error.hidden = true
  const form = el('form')
  const grid = el('div', 'field-grid')
  grid.append(fieldNode('主机', host), fieldNode('端口', port))
  const notice = el('p', 'notice', '只保存连接资料。密码与私钥口令在连接时临时输入，不会落盘。')
  if (editing && isLive(liveOf(conn.id))) {
    notice.textContent = '该主机当前有活跃连接。编辑只影响下一次连接，正在运行的终端保持原身份、原标题。'
  }
  form.append(
    fieldNode('名称', name), grid, fieldNode('用户名', username),
    fieldNode('认证方式', method), keyField, fieldNode('分组', group),
    notice, error,
  )
  // 「保存并连接」的意图必须走**闭包变量**：早期版本把标记挂在按钮 run 的那个 `event`
  // 对象上，而它解析到全局 `window.event`（click 事件），下面
  // `dispatchEvent(new Event('submit'))` 又让 submit 处理器拿到**新的事件对象**
  // ⇒ 标记永远读不到，connectFlow 从未被调用（"保存并连接"实际只保存）。D-1。
  let saveAndConnect = false
  const submit = event => {
    event.preventDefault()
    if (!form.reportValidity()) return
    const alsoConnect = saveAndConnect
    saveAndConnect = false
    const body = {
      label: name.value.trim() || host.value.trim() || '未命名主机',
      host: host.value.trim(),
      port: Number(port.value) || 22,
      username: username.value.trim(),
      group: group.value.trim() || '未分组',
      favorite: conn?.favorite === true,
      auth: { method: method.value },
    }
    if (body.auth.method === 'key') body.auth.keyPath = keyPath.value.trim()
    const run = async () => {
      try {
        const path = editing ? `/ssh/api/connections/${encodeURIComponent(conn.id)}` : '/ssh/api/connections'
        const verb = editing ? 'PUT' : 'POST'
        const { connection } = await api(path, { method: verb, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        closeSheet()
        await refreshConnections()
        state.selection = connection.id
        renderAll()
        if (alsoConnect === true) void connectFlow(connection)
      } catch (err) {
        error.textContent = err.message
        error.hidden = false
      }
    }
    void run()
  }
  form.addEventListener('submit', submit)
  const actions = [
    { label: '取消', run: () => closeSheet() },
    { label: '保存并连接', primary: true, run: () => { saveAndConnect = true; form.dispatchEvent(new window.Event('submit', { cancelable: true })) } },
  ]
  openSheet(editing ? '编辑主机' : '新建主机', [form], actions)
  if (editing) { /* 表单值已填 */ }
}

// ------------------------------------------------------------------ 凭据 / 指纹 / 信任
function askSecret({ title, hint, required }) {
  return new Promise((resolve, reject) => {
    const input = inputNode('cred-input', '', { type: 'password', required })
    const error = el('p', 'form-error', '')
    error.hidden = true
    const confirm = () => {
      if (required && input.value.length === 0) {
        error.textContent = '需要输入内容才能继续。'
        error.hidden = false
        return
      }
      const value = input.value
      closeSheet()
      resolve(value)
    }
    const node = el('div')
    node.append(
      el('p', '', hint ?? '它只用于本次连接，不会被保存。'),
      fieldNode(title.startsWith('私钥') ? '私钥口令' : '密码', input),
      error,
    )
    openSheet(title, [node], [
      { label: '取消', run: () => { closeSheet(); reject(new Error('已取消')) } },
      { label: '确认', primary: true, run: confirm },
    ])
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); confirm() } })
  })
}

function fingerprintSheet(conn, info, { mismatch = false } = {}) {
  const nodes = [
    el('p', '', `${conn.username}@${conn.host}:${conn.port}`),
    el('p', 'notice warning', mismatch
      ? '主机指纹与已信任记录不一致，连接已被阻止。不存在「仍然继续」——请先通过可靠渠道核对服务器身份。'
      : '首次信任不等于已验证安全。建议通过服务器管理渠道核对下面的指纹。'),
  ]
  const list = el('dl', 'detail-list')
  list.append(el('dt', '', '算法'), el('dd', '', info.algo ?? 'SHA256'))
  list.append(el('dt', '', '主机'), el('dd', '', `${conn.host}:${conn.port}`))
  nodes.push(list)
  nodes.push(el('p', '', mismatch ? '已记录的指纹' : 'SHA256 主机指纹'))
  const code = el('code', '', mismatch ? info.fingerprint : info.fingerprint)
  nodes.push(code)
  if (mismatch === true) {
    nodes.push(el('p', '', '忘记旧记录并不会自动接受新身份：下次连接将重新进行首次指纹确认。'))
  }
  const actions = [{ label: '关闭', run: () => closeSheet() }]
  if (mismatch === true) {
    actions.push({
      label: '忘记旧记录', danger: true,
      run: () => { void forgetHostKey(`${conn.host}:${conn.port}`) },
    })
  } else {
    actions.push({ label: '取消连接', run: () => { answerFingerprint(info.token, false) } })
    actions.push({ label: '信任并继续', primary: true, run: () => { answerFingerprint(info.token, true) } })
  }
  openSheet(mismatch ? '主机身份发生变化' : '核对主机指纹', nodes, actions)
}

function answerFingerprint(token, accept) {
  void api('/ssh/api/fingerprint', json({ token, accept }))
    .then(res => {
      if (res?.ok === false) setBannerFromMessage(`指纹确认失败：${res.error ?? '未知原因'}`, 'error')
      else if (accept) setBannerFromMessage('已接受指纹，正在完成连接…', 'info')
      void refreshTrust().then(renderAll)
    })
    .catch(err => setBannerFromMessage(`指纹确认失败：${err.message}`, 'error'))
}

async function forgetHostKey(hostKey) {
  try {
    await api(`/ssh/api/hosts/${encodeURIComponent(hostKey)}/forget`, { method: 'POST' })
    await refreshTrust()
    closeSheet()
    renderAll()
    setStatusNote(`已忘记 ${hostKey} 的信任记录；下次连接将重新确认指纹。`)
  } catch (err) {
    window.alert(`忘记指纹失败：${err.message}`)
  }
}

function trustListSheet() {
  const nodes = [el('p', '', '首次连接一台主机并确认指纹后会记录在这里。忘记后，下次连接会重新进入首次确认（TOFU）。')]
  const entries = [...state.trustMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  if (entries.length === 0) {
    nodes.push(el('p', 'notice', '暂无信任记录。'))
  }
  for (const [hostKey, entry] of entries) {
    const row = el('div', 'trust-row')
    const info = el('div', 'trust-info')
    info.append(el('div', 'trust-key', hostKey))
    const fp = el('div', 'trust-fp', entry.fingerprint)
    if (entry.firstSeenAt) fp.title = `首次信任于 ${entry.firstSeenAt}`
    info.append(fp)
    const forget = el('button', 'text-btn danger-text', '忘记')
    forget.type = 'button'
    forget.onclick = () => {
      if (!window.confirm(`忘记主机「${hostKey}」的指纹？\n下次连接将重新进行首次指纹确认。`)) return
      void forgetHostKey(hostKey)
    }
    row.append(info, forget)
    nodes.push(row)
  }
  openSheet('信任记录', nodes, [{ label: '关闭', run: () => closeSheet() }])
}

// ------------------------------------------------------------------ 连接生命周期
async function connectFlow(conn) {
  state.pendingError = null
  const secrets = {}
  if (conn.auth?.method === 'password') {
    try {
      secrets.password = await askSecret({ title: `连接密码 · ${conn.label}`, hint: `${conn.username}@${conn.host}:${conn.port} —— 密码只用于本次连接。`, required: true })
    } catch { return }
  } else if (conn.auth?.method === 'key') {
    try {
      const passphrase = await askSecret({ title: `私钥口令 · ${conn.label}`, hint: '私钥未加密则直接确认；口令只用于本次连接。', required: false })
      if (passphrase.length > 0) secrets.passphrase = passphrase
    } catch { return }
  }
  try {
    await api(`/ssh/api/connections/${encodeURIComponent(conn.id)}/connect`, json(secrets))
  } catch (err) {
    state.selection = conn.id
    state.pendingError = { message: err.message }
    renderAll()
    return
  }
  openHost(conn.id)
}

function openHost(id, { shellSeq = null } = {}) {
  const conn = byId(id)
  if (conn === undefined) return
  state.selection = id
  state.pendingError = null
  state.frameState = null
  state.transport = false
  // U2.1 标签结构化（方案 §4.1.3）：tab = { connId, shellSeq, title, live }。
  // shellSeq 为 null 表示「用默认（首个）shell」，数字表示恢复/打开指定 shell。
  let tab = state.tabs.find(item => item.connId === id)
  if (tab === undefined) {
    tab = { connId: id, shellSeq: shellSeq ?? 1, title: null, live: true }
    state.tabs.push(tab)
  } else if (shellSeq !== null) {
    tab.shellSeq = shellSeq
  }
  state.activeTab = state.tabs.indexOf(tab)
  saveWorkspace()
  renderAll()
  mountSession(conn, tab)
}

/** 激活第 index 个标签（同主机多 shell 的每个标签都能回到自己的 shell）。 */
function openHostAt(index) {
  const tab = state.tabs[index]
  if (tab === undefined) return
  openHost(tab.connId, { shellSeq: tab.shellSeq })
}

function mountSession(conn, tab) {
  destroySession()
  if (window.SshTermSession === undefined) {
    state.pendingError = { message: '终端模块加载失败，请刷新页面重试。' }
    renderAll()
    return
  }
  const holder = $('#term-holder')
  holder.replaceChildren()
  state.session = window.SshTermSession.create({
    conn,
    shellSeq: tab?.shellSeq ?? null,
    holder,
    theme: state.xtermTheme ?? undefined,
    fontSize: state.prefs.fontSize,
    onStatus: (kind, text) => handleSessionStatus(kind, text),
    onFrame: msg => handleSessionFrame(conn, msg),
    onResize: size => { $('#size-text').textContent = `${size.cols}×${size.rows}` },
    onModeChange: mode => handleModeChange(mode),
  })
  setupTerminalExtras(conn)
}

function destroySession() {
  if (state.session !== null) {
    try { state.session.dispose() } catch { /* already gone */ }
    state.session = null
  }
}

function handleSessionStatus(kind, text) {
  state.transport = /重新附着/.test(text)
  if (state.transport) state.frameState = { state: 'transport' }
  else if (kind === 'error') state.frameState = state.frameState?.state === 'mismatch' ? state.frameState : { state: 'error', message: text }
  $('#status-text').textContent = text
  $('#status-pill').className = `status-pill ${kind === 'ok' ? 'ok' : kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : ''}`
  renderBanner()
}

function handleSessionFrame(conn, msg) {
  if (msg.type === 'status') {
    if (msg.state === 'waiting-fingerprint') {
      state.frameState = { state: 'waiting-fingerprint', token: msg.token, fingerprint: msg.fingerprint }
      void refreshTrust().then(renderAll)
    } else if (msg.state === 'connected') {
      state.live.set(conn.id, 'connected')
      state.frameState = { state: 'connected' }
      void refreshConnections().then(renderAll)
    } else if (msg.state === 'closed') {
      state.live.set(conn.id, 'closed')
      state.frameState = { state: 'closed' }
      const tab = activeTabObj()
      if (tab !== null) { tab.live = false; saveWorkspace() }
      void refreshConnections().then(renderAll)
    } else if (msg.state === 'error') {
      state.live.set(conn.id, 'error')
      state.frameState = msg.code === 'HOST_KEY_MISMATCH'
        ? { state: 'mismatch', message: msg.message }
        : { state: 'error', code: msg.code, message: msg.message }
      void refreshConnections().then(renderAll)
    } else {
      state.frameState = { state: msg.state }
    }
  } else if (msg.type === 'error') {
    state.frameState = msg.code === 'NO_CONNECTION'
      ? { state: 'closed', message: msg.message }
      : { state: 'error', code: msg.code, message: msg.message }
  } else if (msg.type === 'shell.opened') {
    // 新 shell：标签集合追加一项并激活（方案 §4.1.3）
    const m = /#(\d+)$/.exec(String(msg.title ?? ''))
    const shellSeq = m !== null ? Number(m[1]) : 1
    let tab = state.tabs.find(item => item.connId === conn.id && item.shellSeq === shellSeq)
    if (tab === undefined) {
      tab = { connId: conn.id, shellSeq, title: msg.title ?? null, live: true }
      state.tabs.push(tab)
    } else {
      tab.title = msg.title ?? tab.title
      tab.live = true
    }
    state.activeTab = state.tabs.indexOf(tab)
    saveWorkspace()
  } else if (msg.type === 'shell.closed') {
    // shell 结束 ≠ 连接结束：标签保留为「会话已结束」，不自动重连（方案 §4.1.5）
    const tab = activeTabObj()
    if (tab !== null) { tab.live = false; saveWorkspace() }
    state.frameState = { state: 'closed', message: '该 shell 已结束；其他标签不受影响，可新建 shell 或关闭标签。' }
  } else if (msg.type === 'write.open') {
    // 写权空出：当前 viewer 若处于只读态，提示可接管（不自动接管）
    if (state.session !== null && state.session.isWriteOwner() !== true) {
      setStatusNote('写入权已空出，可从只读条点「接管写入」。')
    }
  }
  renderBanner()
  renderRail()
  renderTabs()
  renderWriteBar()
}

/** 当前激活标签对象（结构化 tabs 的下标寻址）。 */
function activeTabObj() {
  return Number.isInteger(state.activeTab) ? state.tabs[state.activeTab] ?? null : null
}

/** U2.1 写入所有权 UI：只读条 + 接管按钮（决策 2）。 */
function handleModeChange(mode) {
  renderWriteBar()
  if (mode === 'read') setStatusNote('只读模式：输入已停用，点「接管写入」获得控制权。')
}

function renderWriteBar() {
  const bar = $('#write-bar')
  if (bar === null) return
  const writable = state.session !== null && state.session.isWriteOwner() === true
  bar.hidden = writable
  if (writable) return
  const take = bar.querySelector('#write-take')
  if (take !== null) {
    take.onclick = () => {
      if (state.session !== null) {
        state.session.takeover()
        setStatusNote('已请求接管写入。')
      }
    }
  }
}

function setBannerFromMessage(message, kind) {
  state.frameState = { state: 'custom', message, kind }
  renderBanner()
}

// ------------------------------------------------------------------ 渲染
function renderAll() {
  renderRail()
  renderTabs()
  renderIdentity()
  renderBanner()
  renderStatusbar()
  renderBody()
  renderWriteBar()
  syncRailMode()
}

function renderRail() {
  const list = $('#host-list')
  list.replaceChildren()
  const query = $('#host-search').value
  const groups = hostGroups(state.connections, query, liveOf)
  $('#rail-count').textContent = String(state.connections.length)
  if (state.connections.length === 0) {
    list.appendChild(el('div', 'rail-empty', '还没有保存的主机。\n点右上角 + 新建一台，开始工作。'))
  } else if (groups.length === 0) {
    list.appendChild(el('div', 'rail-empty', '没有匹配的主机。\n试试名称或连接地址。'))
  }
  for (const group of groups) {
    const title = el('div', 'group-title')
    title.append(el('span', '', group.name), el('span', '', String(group.hosts.length)))
    list.appendChild(title)
    for (const conn of group.hosts) {
      const live = liveOf(conn.id)
      const row = el('button', `host-row${conn.id === state.selection ? ' selected' : ''}`)
      row.type = 'button'
      row.dataset.hostId = conn.id
      const dotClass = live === 'connected' ? ' connected' : live === 'waiting-fingerprint' || live === 'connecting' ? ' warning' : live === 'error' ? ' error' : ''
      row.title = `${conn.username}@${conn.host}:${conn.port} · ${stateText(live)}`
      const iconWrap = el('span', 'host-icon')
      iconWrap.appendChild(icon('server'))
      const info = el('span', 'host-info')
      const nameLine = el('span', 'host-name')
      nameLine.append(el('span', 'name-text', conn.label))
      if (conn.favorite === true) {
        const star = icon('star')
        star.classList.add('fav-mark')
        nameLine.append(star)
      }
      info.append(nameLine, el('span', 'host-address', `${conn.username}@${conn.host}:${conn.port}`))
      const dot = el('i', `dot${dotClass}`)
      const sr = el('span', 'sr-only', stateText(live))
      row.append(iconWrap, info, dot, sr)
      row.onclick = () => selectHost(conn.id)
      row.oncontextmenu = event => {
        event.preventDefault()
        openHostMenu(conn.id, event.clientX, event.clientY)
      }
      list.appendChild(row)
    }
  }
  const liveCount = state.connections.filter(conn => isLive(liveOf(conn.id))).length
  const summary = $('#rail-summary')
  summary.replaceChildren(el('i', `dot${liveCount > 0 ? ' connected' : ''}`), el('span', '', `${liveCount} 个连接保留中`))
}

function selectHost(id) {
  const conn = byId(id)
  if (conn === undefined) return
  state.selection = id
  state.pendingError = null
  if (isLive(liveOf(id))) {
    openHost(id) // 已连接：直接打开终端（只 attach）
    return
  }
  state.frameState = null
  closeRailDrawer()
  renderAll()
}

function renderTabs() {
  const tabs = $('#tabs')
  tabs.replaceChildren()
  state.tabs.forEach((tab, index) => {
    const conn = byId(tab.connId)
    if (conn === undefined) return
    const live = liveOf(tab.connId)
    const multi = state.tabs.filter(item => item.connId === tab.connId).length > 1
    const label = tab.title ?? (multi && tab.shellSeq !== null && tab.shellSeq > 1 ? `${conn.label} #${tab.shellSeq}` : conn.label)
    const wrap = el('div', `terminal-tab${index === state.activeTab ? ' active' : ''}`)
    const select = el('button', 'tab-select')
    select.type = 'button'
    select.setAttribute('aria-pressed', String(index === state.activeTab))
    const dotClass = !tab.live ? '' : live === 'connected' ? ' connected' : live === 'error' ? ' error' : live === 'idle' || live === 'closed' ? '' : ' warning'
    select.append(el('i', `dot${dotClass}`), el('span', 'tab-label', label))
    select.title = tab.live ? `${conn.username}@${conn.host}:${conn.port} · ${stateText(live)}` : '会话已结束'
    select.onclick = () => openHostAt(index)
    const close = el('button', 'tab-close', '×')
    close.type = 'button'
    close.title = `关闭 ${label} 的查看`
    close.setAttribute('aria-label', `关闭 ${label} 的查看`)
    close.onclick = () => closeTabDialog(index)
    wrap.append(select, close)
    tabs.appendChild(wrap)
  })
}

function renderIdentity() {
  // D-3（方案 §16.4-1）：删除选中的主机后 state.selection 仍指向已不存在的 id，
  // byId 返回 undefined —— `conn === null` 判空失效，912 行读 conn.group 抛 TypeError。
  // 归一化为 null：selection 失效等同「未选中」。
  const conn = state.selection !== null ? (byId(state.selection) ?? null) : null
  $('#identity-name').textContent = conn?.label ?? 'SSH 工作区'
  $('#identity-env').textContent = conn?.group ?? ''
  $('#identity-env').hidden = conn === null || !conn.group || conn.group === '未分组'
  $('#identity-sub').textContent = conn === null
    ? '选择主机，开始连接'
    : `${conn.username}@${conn.host}:${conn.port} · ${{ password: '密码认证', key: '私钥认证', agent: 'SSH agent' }[conn.auth?.method] ?? conn.auth?.method}`
  const live = conn !== null && isLive(liveOf(conn.id))
  $('#btn-search').disabled = !live
  $('#btn-send').disabled = !live
  $('#btn-focus').disabled = false
  $('#btn-more').disabled = conn === null
}

function bannerNode(kind, message, actions) {
  const banner = $('#state-banner')
  banner.className = `state-banner ${kind ?? ''}`
  banner.replaceChildren(icon('info'), el('span', '', message))
  for (const action of actions) {
    const btn = el('button', 'text-btn', action.label)
    btn.type = 'button'
    btn.onclick = action.run
    banner.appendChild(btn)
  }
  banner.hidden = false
}

function renderBanner() {
  const banner = $('#state-banner')
  // D4 尾项①（§16.4-3 顺延项）：隐藏时清空内容 —— 旧实现只设 hidden，上一次的
  // 图标 / 文案 / 按钮节点会留在 DOM（含 onclick 闭包引用）。先清再定，隐藏态 =
  // 空容器；显示态由 bannerNode() 完整重建，二者互不干扰。
  banner.hidden = true
  banner.replaceChildren()
  const frame = state.frameState
  if (frame === null || frame.state === undefined) {
    if (state.pendingError !== null) {
      bannerNode('error', `连接失败：${state.pendingError.message}`, [
        { label: '编辑主机', run: () => { const conn = byId(state.selection) ?? null; if (conn !== null) openEditor(conn) } },
      ])
    }
    return
  }
  const activeTabItem = activeTabObj()
  const conn = activeTabItem !== null ? (byId(activeTabItem.connId) ?? null) : null
  switch (frame.state) {
    case 'connecting':
      bannerNode('warning', '正在建立 SSH 连接，终端就绪前不接受输入。', [
        { label: '取消连接', run: () => { if (conn !== null) void disconnectHost(conn.id) } },
      ])
      return
    case 'waiting-fingerprint':
      bannerNode('warning', '首次连接，需要核对主机指纹后继续。', [
        { label: '核对指纹', run: () => { fingerprintSheet(conn, { token: frame.token, fingerprint: frame.fingerprint, algo: 'SHA256' }) } },
      ])
      return
    case 'transport':
      bannerNode('warning', '浏览器与本地服务暂时失联，正在自动重新附着；SSH 连接仍在 host 侧保留。', [])
      return
    case 'closed':
      bannerNode('', `SSH 会话已结束。重新连接会创建新的 shell，不会重放任何命令。${frame.message ?? ''}`, [
        { label: '重新连接', run: () => { if (conn !== null) void connectFlow(conn) } },
      ])
      return
    case 'mismatch':
      bannerNode('error', `主机指纹与已信任记录不一致，连接已被阻止。${frame.message ?? ''}`, [
        { label: '查看信任记录', run: () => trustListSheet() },
      ])
      return
    case 'error':
      bannerNode('error', frame.message ?? '连接失败。', [
        { label: '编辑主机', run: () => { if (conn !== null) openEditor(conn) } },
        { label: '重新连接', run: () => { if (conn !== null) void connectFlow(conn) } },
      ])
      return
    default:
      return // connected / custom 等由状态栏表达
  }
}

function renderStatusbar() {
  // D-3 同病：activeTab/selection 指向已删主机时 byId 返回 undefined，归一化 null。
  const activeTabItem0 = activeTabObj()
  const activeConn = activeTabItem0 !== null ? (byId(activeTabItem0.connId) ?? null) : null
  const conn = activeConn !== null ? activeConn : (state.selection !== null ? (byId(state.selection) ?? null) : null)
  const live = conn !== null ? liveOf(conn.id) : 'idle'
  const pill = $('#status-pill')
  // 只换 dot 类名与文本，不重建节点 —— #status-text 是 buildSkeleton 的静态节点
  const dot = pill.querySelector('.dot')
  if (dot !== null) dot.className = `dot${live === 'connected' ? ' connected' : live === 'error' ? ' error' : isLive(live) ? ' warning' : ''}`
  const text = $('#status-text')
  if (text !== null) text.textContent = stateText(live)
  const trust = $('#trust-status')
  if (conn === null) {
    trust.hidden = true
  } else {
    trust.hidden = false
    trust.textContent = trustOf(conn) !== null ? '指纹已信任' : '指纹待确认'
    trust.onclick = () => trustListSheet()
  }
  if (state.session !== null) {
    const size = state.session.size()
    $('#size-text').textContent = `${size.cols}×${size.rows} · ${state.session.fontSize()}px`
  } else {
    $('#size-text').textContent = ''
  }
}

function renderBody() {
  const activeTabItem = activeTabObj()
  const conn = activeTabItem !== null ? (byId(activeTabItem.connId) ?? null) : null
  const showTerm = conn !== null && state.session !== null
  $('#term-holder').hidden = !showTerm
  const empty = $('#empty-space')
  empty.hidden = showTerm
  if (showTerm) { empty.replaceChildren(); return }
  empty.replaceChildren(...emptyStateNodes())
}

function emptyStateNodes() {
  const nodes = []
  if (state.connections.length === 0) {
    const iconWrap = el('div', 'empty-icon')
    iconWrap.appendChild(icon('terminal'))
    nodes.push(iconWrap, el('h2', '', '连接你的下一台主机'))
    nodes.push(el('p', '', '主机资料保存在本机 dsh 服务中。创建连接后，终端、信任状态与恢复入口会出现在这里。'))
    const actions = el('div', 'empty-actions')
    const primary = el('button', 'text-btn primary-btn', '新建主机')
    primary.type = 'button'
    primary.onclick = () => openEditor()
    actions.appendChild(primary)
    nodes.push(actions)
    return nodes
  }
  // D-3 同病：selection 指向已删除的主机时 byId 返回 undefined，回退到「选择一台主机」空态
  const selectedConn = state.selection !== null ? (byId(state.selection) ?? null) : null
  if (selectedConn === null) {
    const iconWrap = el('div', 'empty-icon')
    iconWrap.appendChild(icon('terminal'))
    nodes.push(iconWrap, el('h2', '', '选择一台主机'))
    nodes.push(el('p', '', '从左侧主机导航选择一台已连接的主机直接进入终端，或选择未连接的主机查看详情。'))
    const recent = el('div', 'recent-line')
    const sorted = [...state.connections].sort((a, b) => (b.lastConnectedAt ?? b.updatedAt) < (a.lastConnectedAt ?? a.updatedAt) ? -1 : 1)
    for (const conn of sorted.slice(0, 3)) {
      const chip = el('button', 'text-btn', conn.label)
      chip.type = 'button'
      chip.onclick = () => selectHost(conn.id)
      recent.appendChild(chip)
    }
    const actions = el('div', 'empty-actions')
    const primary = el('button', 'text-btn primary-btn', '新建主机')
    primary.type = 'button'
    primary.onclick = () => openEditor()
    actions.appendChild(primary)
    nodes.push(recent, actions)
    return nodes
  }
  const conn = selectedConn
  const iconWrap = el('div', 'empty-icon')
  iconWrap.appendChild(icon('server'))
  nodes.push(iconWrap, el('h2', '', conn.label))
  const trusted = trustOf(conn) !== null
  nodes.push(el('p', '', `${conn.username}@${conn.host}:${conn.port}\n${{ password: '密码认证', key: '私钥认证', agent: 'SSH agent' }[conn.auth?.method] ?? ''} · ${trusted ? '已有信任记录' : '首次连接需确认指纹'}`))
  const actions = el('div', 'empty-actions')
  const connect = el('button', 'text-btn primary-btn', '连接主机')
  connect.type = 'button'
  connect.onclick = () => { void connectFlow(conn) }
  const edit = el('button', 'text-btn', '编辑配置')
  edit.type = 'button'
  edit.onclick = () => openEditor(conn)
  actions.append(connect, edit)
  nodes.push(actions)
  return nodes
}

// ------------------------------------------------------------------ 标签 / 断开
function closeTabDialog(index) {
  const tab = state.tabs[index]
  if (tab === undefined) return
  const conn = byId(tab.connId)
  if (conn === undefined) {
    state.tabs.splice(index, 1)
    if (state.activeTab === index) { state.activeTab = null; destroySession() }
    else if (state.activeTab !== null && state.activeTab > index) state.activeTab -= 1
    saveWorkspace()
    renderAll()
    return
  }
  const remove = disconnect => {
    closeSheet()
    const wasActive = state.activeTab === index
    state.tabs.splice(index, 1)
    if (wasActive) {
      state.activeTab = null
      destroySession()
      state.frameState = null
      const next = state.tabs[Math.min(index, state.tabs.length - 1)]
      if (next !== undefined) {
        openHost(next.connId, { shellSeq: next.shellSeq })
        return
      }
    } else if (state.activeTab !== null && state.activeTab > index) {
      state.activeTab -= 1
    }
    saveWorkspace()
    if (disconnect === true) void disconnectHost(tab.connId)
    renderAll()
  }
  const sameHostLeft = state.tabs.some((item, i) => i !== index && item.connId === tab.connId)
  const nodes = [
    el('p', '', `${conn.label} · ${conn.username}@${conn.host}:${conn.port}`),
    el('p', 'notice', sameHostLeft
      ? '该主机还有其他 shell 标签。「断开整个连接」会结束全部 shell；只想结束这个 shell 请选「关闭此 shell」（连接保留）。'
      : '默认仅关闭当前查看。连接继续保留，可从主机列表再次打开；如需结束远程 shell，请选择断开并关闭。'),
  ]
  const actions = [
    { label: '取消', run: () => closeSheet() },
    { label: '断开整个连接', danger: true, run: () => remove(true) },
    { label: '仅关闭查看', primary: true, run: () => remove(false) },
  ]
  // 关此 shell：仅当该标签就是当前挂载会话且本查看器是写入 owner（服务端同口径校验）
  if (state.activeTab === index && state.session !== null && state.session.connId === tab.connId && state.session.isWriteOwner() === true && tab.live !== false) {
    actions.splice(2, 0, {
      label: '关闭此 shell（连接保留）',
      run: () => {
        try { state.session.closeShell() } catch { /* gone */ }
        remove(false)
      },
    })
  }
  openSheet('关闭终端查看', nodes, actions)
}

async function disconnectHost(id) {
  try {
    await api(`/ssh/api/connections/${encodeURIComponent(id)}/disconnect`, { method: 'POST' })
  } catch { /* 断开失败也不阻塞 UI，状态帧会跟上 */ }
  state.live.set(id, 'closed')
  await refreshConnections()
  renderAll()
}

// ------------------------------------------------------------------ 主机菜单（工具区「更多」与右键同源）
function hostMenuItems(conn) {
  const live = isLive(liveOf(conn.id))
  const items = []
  if (live) {
    items.push({ icon: 'terminal', label: '打开终端', run: () => openHost(conn.id) })
  } else {
    items.push({ icon: 'terminal', label: '连接主机', run: () => { void connectFlow(conn) } })
  }
  if (live) {
    items.push({ icon: 'plus', label: '新建 shell 标签', run: () => openNewShellTab(conn.id) })
  }
  items.push({ icon: 'edit', label: '编辑主机', run: () => openEditor(conn) })
  items.push({
    icon: 'star', label: conn.favorite === true ? '取消收藏' : '收藏主机',
    run: async () => {
      try {
        await api(`/ssh/api/connections/${encodeURIComponent(conn.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorite: !(conn.favorite === true) }) })
        await refreshConnections()
        renderAll()
      } catch (err) { window.alert(`收藏失败：${err.message}`) }
    },
  })
  items.push({ icon: 'copy', label: '复制连接地址', run: async () => {
    const address = `${conn.username}@${conn.host}:${conn.port}`
    try { await navigator.clipboard.writeText(address); setStatusNote('已复制连接地址。') } catch { window.prompt('连接地址：', address) }
  } })
  items.push({ icon: 'shield', label: '查看信任记录', run: () => trustListSheet() })
  // 字号行（plan §6 首版必需）：菜单内联 −/值/+
  items.push({
    custom: (() => {
      const row = el('div', 'font-controls')
      row.append(el('span', '', '终端字号'))
      const minus = el('button', 'icon-btn', '−')
      minus.type = 'button'
      minus.setAttribute('aria-label', '减小终端字号')
      minus.onclick = () => setFont(-1)
      const value = el('span', '', String(state.prefs.fontSize))
      value.id = 'font-value'
      const plus = el('button', 'icon-btn', '+')
      plus.type = 'button'
      plus.setAttribute('aria-label', '增大终端字号')
      plus.onclick = () => setFont(1)
      row.append(minus, value, plus)
      return row
    })(),
  })
  items.push({ divider: true })
  items.push({ icon: 'disconnect', label: '断开连接…', danger: live, run: () => {
    if (!live) { setStatusNote('该主机当前没有活跃连接。'); return }
    const nodes = [
      el('p', '', `你正在断开 ${conn.label}（${conn.username}@${conn.host}:${conn.port}）。`),
      el('p', 'notice warning', '这会结束对应的 SSH 连接与 shell。关闭查看与断开是两个不同操作；远程任务是否存活取决于远程程序自身。'),
    ]
    openSheet('断开 SSH 连接？', nodes, [
      { label: '取消', run: () => closeSheet() },
      { label: '断开', danger: true, run: () => { closeSheet(); void disconnectHost(conn.id) } },
    ])
  } })
  items.push({ icon: 'close', label: '删除主机…', danger: true, run: () => {
    const liveCount = isLive(liveOf(conn.id)) ? 1 : 0
    const warn = liveCount > 0 ? `\n（该主机当前有 ${liveCount} 个活跃连接，删除将同时断开）` : ''
    if (!window.confirm(`删除主机「${conn.label}」？${warn}`)) return
    void (async () => {
      try {
        await api(`/ssh/api/connections/${encodeURIComponent(conn.id)}`, { method: 'DELETE' })
        const removedAt = state.tabs.map((tab, i) => (tab.connId === conn.id ? i : -1)).filter(i => i >= 0)
        state.tabs = state.tabs.filter(tab => tab.connId !== conn.id)
        if (state.activeTab !== null && removedAt.includes(state.activeTab)) {
          state.activeTab = state.tabs.length > 0 ? Math.min(state.activeTab, state.tabs.length - 1) : null
          destroySession()
        } else if (state.activeTab !== null) {
          state.activeTab -= removedAt.filter(i => i < state.activeTab).length
        }
        if (state.selection === conn.id) {
          state.selection = state.activeTab !== null ? state.tabs[state.activeTab]?.connId ?? null : null
        }
        saveWorkspace()
        await refreshConnections()
        await refreshTrust()
        renderAll()
      } catch (err) { window.alert(`删除失败：${err.message}`) }
    })()
  } })
  return items
}

/** U2.1：在同一 SSH 连接上新开一个 shell channel，并把当前查看器切过去（方案 §4.1.3）。 */
function openNewShellTab(connId) {
  const session = state.session
  const conn = byId(connId)
  if (conn === undefined) return
  if (session === null || session.connId !== connId) {
    openHost(connId)
    setStatusNote('已打开该主机；再从菜单选「新建 shell 标签」即可在同连接开第二个 shell。')
    return
  }
  if (isLive(liveOf(connId)) !== true) {
    setStatusNote('该主机当前没有活跃连接。')
    return
  }
  session.openShell()
  setStatusNote('正在新建 shell…')
}

let menuCleanup = null
function openMenuAt(anchorRect, items) {
  closeMenu()
  const menu = $('#more-menu')
  menu.replaceChildren()
  for (const item of items) {
    if (item.divider === true) {
      menu.appendChild(el('hr'))
      continue
    }
    if (item.custom !== undefined) {
      menu.appendChild(item.custom)
      continue
    }
    const btn = el('button', item.danger === true ? 'danger-text' : '')
    btn.type = 'button'
    btn.append(icon(item.icon), el('span', '', item.label))
    btn.onclick = () => { closeMenu(); item.run() }
    menu.appendChild(btn)
  }
  menu.hidden = false
  const margin = 8
  const width = menu.offsetWidth || 216
  const x = Math.max(margin, Math.min(anchorRect.right, window.innerWidth - width - margin))
  menu.style.left = `${x - width}px`
  menu.style.top = `${Math.min(anchorRect.bottom + margin, window.innerHeight - (menu.offsetHeight || 200) - margin)}px`
  menu.style.right = 'auto'
  const onOutside = event => {
    if (menu.contains(event.target)) return
    closeMenu()
  }
  document.addEventListener('pointerdown', onOutside, true)
  menuCleanup = () => document.removeEventListener('pointerdown', onOutside, true)
  const first = menu.querySelector('button')
  first?.focus()
}

function closeMenu() {
  const menu = $('#more-menu')
  if (menu === null || menu.hidden) return
  menu.hidden = true
  if (menuCleanup !== null) { menuCleanup(); menuCleanup = null }
}

function openHostMenu(connId, x, y) {
  const conn = byId(connId)
  if (conn === null) return
  openMenuAt({ right: x, bottom: y, left: x, top: y }, hostMenuItems(conn))
}

// ------------------------------------------------------------------ 工具区
function toggleSearchLine() {
  closeMenu()
  state.searchOpen = !state.searchOpen
  const line = $('#search-line')
  line.hidden = !state.searchOpen
  if (state.searchOpen) {
    $('#term-query').focus()
  } else {
    state.session?.find('')
    $('#btn-search').focus()
  }
}

function runFind(direction) {
  const query = $('#term-query').value
  const result = state.session?.find(query, direction) ?? { total: 0, current: 0 }
  $('#find-result').textContent = query.trim().length === 0 ? '输入关键词' : result.total === 0 ? '无匹配' : `${result.current}/${result.total} 处`
}

function toggleFocusMode() {
  closeMenu()
  state.focusMode = !state.focusMode
  if (state.focusMode) state.railHidden = true
  $('#btn-focus').classList.toggle('is-active', state.focusMode)
  $('#btn-focus').setAttribute('aria-pressed', String(state.focusMode))
  $('#btn-focus').title = state.focusMode ? '退出专注模式' : '专注模式'
  savePrefs()
  syncRailMode()
}

function setFont(delta) {
  const next = state.session?.setFontSize(state.prefs.fontSize + delta) ?? Math.min(20, Math.max(12, state.prefs.fontSize + delta))
  state.prefs.fontSize = next
  const value = $('#font-value') // 只在主机菜单打开时存在于 DOM
  if (value !== null) value.textContent = String(next)
  savePrefs()
  renderStatusbar()
}

function setupTerminalExtras(conn) {
  const holder = $('#term-holder')
  // 捕获阶段拦截 Ctrl+Shift+C/V 与可疑粘贴：父节点捕获先于 xterm 在 textarea 上的监听。
  const onKey = event => {
    if (event.ctrlKey && event.shiftKey && !event.altKey) {
      const code = event.code
      if (code === 'KeyC') {
        const selection = state.session?.term.getSelection() ?? ''
        if (selection.length > 0) {
          event.preventDefault(); event.stopImmediatePropagation()
          void navigator.clipboard.writeText(selection).catch(() => {})
        }
        return
      }
      if (code === 'KeyV') {
        event.preventDefault(); event.stopImmediatePropagation()
        void navigator.clipboard.readText().then(text => {
          if (typeof text === 'string' && text.length > 0) pasteWithGuard(conn, text)
        }).catch(() => setStatusNote('剪贴板不可用：请在终端里用右键粘贴或检查浏览器权限。'))
      }
    }
  }
  holder.addEventListener('keydown', onKey, true)
  const onPaste = event => {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (typeof text !== 'string' || text.length === 0) return
    if (!looksSuspiciousPaste(text)) return // 普通单行粘贴放行给 xterm
    event.preventDefault()
    event.stopImmediatePropagation()
    pasteWithGuard(conn, text)
  }
  holder.addEventListener('paste', onPaste, true)
  const termTextarea = state.session?.term.textarea
  if (termTextarea !== null && termTextarea !== undefined) {
    termTextarea.addEventListener('paste', onPaste, false)
  }
  // 右键：终端现场的「送往对话」入口（A0）。无终端时交还浏览器默认菜单。
  const onContextMenu = event => {
    const conn = state.selection !== null ? (byId(state.selection) ?? null) : null
    if (conn === null || state.session === null || state.session === undefined) return
    event.preventDefault()
    openMenuAt({ right: event.clientX, bottom: event.clientY, left: event.clientX, top: event.clientY }, sendMenuItems(conn))
  }
  holder.addEventListener('contextmenu', onContextMenu)
}

function pasteWithGuard(conn, text) {
  if (!looksSuspiciousPaste(text)) {
    state.session?.input(text)
    return
  }
  const preview = text.length > 400 ? `${text.slice(0, 400)}…（共 ${text.length} 字符）` : text
  const nodes = [
    el('p', '', `要粘贴到 ${conn.label} 的内容包含换行或控制字符，可能直接执行。`),
    el('code', '', preview),
    el('p', 'notice', '粘贴不会自动追加回车；bracketed paste 语义由远端 shell 决定。'),
  ]
  openSheet('确认粘贴', nodes, [
    { label: '取消', run: () => closeSheet() },
    { label: '粘贴', primary: true, run: () => { closeSheet(); state.session?.input(text) } },
  ])
}

// ------------------------------------------------------------------ 送往对话（A0）

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

/**
 * 把终端现场整理成消息并放进剪贴板（A0 走剪贴板通道，plan §8.2 路径 1）。
 * intent: 'selection' 取选区 | 'recent' 取最近 40 行 | 'error' 取最近 60 行 + 引导语。
 * 只读终端，不向远端发送任何字节。
 */
async function sendToChat(conn, intent) {
  const session = state.session
  if (conn === null || conn === undefined || session === null || session === undefined) {
    setStatusNote('先打开一个终端，再送往对话。')
    return
  }
  const body = intent === 'selection'
    ? (session.term.getSelection() ?? '')
    : session.snapshot(intent === 'error' ? 60 : 40)
  const text = formatSshContext(conn, body, { intro: SEND_INTENTS[intent] ?? '' })
  if (text.length === 0) {
    setStatusNote(intent === 'selection' ? '先在终端里选中要送出的内容。' : '终端还没有可送出的输出。')
    return
  }
  if (!(await copyText(text))) { setStatusNote('剪贴板不可用：请检查浏览器权限后重试。'); return }
  setStatusNote(`已复制 ${text.length} 字符——点左上「对话」退出后粘贴（Ctrl+V）即可，首行已标注来源主机。`)
}

/** 工具区按钮与终端右键共用同一份菜单（沿用 hostMenuItems 的「同源」约定）。 */
function sendMenuItems(conn) {
  return [
    { icon: 'copy', label: '送出选中内容', run: () => { void sendToChat(conn, 'selection') } },
    { icon: 'send', label: '送出最近 40 行', run: () => { void sendToChat(conn, 'recent') } },
    { icon: 'info', label: '让 Agent 看这个错误', run: () => { void sendToChat(conn, 'error') } },
  ]
}

function setStatusNote(text) {
  $('#status-text').textContent = text
  $('#status-pill').className = 'status-pill'
}

// ------------------------------------------------------------------ rail 模式（收起 / 抽屉 / 专注）
function railVisibleWidth() {
  return $('#workbench').getBoundingClientRect().width
}

function syncRailMode() {
  const workbench = $('#workbench')
  const narrow = railVisibleWidth() < 720
  workbench.classList.toggle('rail-hidden', narrow === false && (state.railHidden || state.focusMode))
  workbench.classList.toggle('drawer-open', narrow === true && state.drawerOpen)
  const rail = $('#host-rail')
  if (narrow && state.drawerOpen) {
    rail.setAttribute('role', 'dialog')
    rail.setAttribute('aria-modal', 'true')
    $('#workspace-main').inert = true
  } else {
    rail.removeAttribute('role')
    rail.removeAttribute('aria-modal')
    if (!(narrow && state.drawerOpen)) $('#workspace-main').inert = $('#sheet-overlay')?.classList.contains('hidden') === false
  }
  const toggle = $('#toggle-rail')
  toggle.setAttribute('aria-expanded', String(narrow ? state.drawerOpen : !workbench.classList.contains('rail-hidden')))
}

function toggleRail() {
  const narrow = railVisibleWidth() < 720
  if (narrow) {
    state.drawerOpen = !state.drawerOpen
    if (state.drawerOpen) closeMenu()
    syncRailMode()
    if (state.drawerOpen) $('#host-search').focus()
    else $('#toggle-rail').focus()
    return
  }
  state.railHidden = !state.railHidden
  if (!state.railHidden) state.focusMode = false
  $('#btn-focus').classList.toggle('is-active', state.focusMode)
  savePrefs()
  syncRailMode()
  if (!state.railHidden) $('#host-search').focus()
}

function closeRailDrawer() {
  state.drawerOpen = false
  syncRailMode()
}

// ------------------------------------------------------------------ 骨架
function buildSkeleton(root) {
  root.replaceChildren()
  const workbench = el('div', 'workbench')
  workbench.id = 'workbench'

  // -- host rail
  const rail = el('aside', 'host-rail')
  rail.id = 'host-rail'
  rail.setAttribute('aria-label', '主机导航')
  const railHead = el('div', 'rail-head')
  const railTitle = el('h2', '', '主机')
  railTitle.appendChild(el('span', 'rail-count', '0')).id = 'rail-count'
  const railBtns = el('div', 'rail-head-btns')
  const newBtn = el('button', 'icon-btn')
  newBtn.type = 'button'
  newBtn.title = '新建主机'
  newBtn.setAttribute('aria-label', '新建主机')
  newBtn.appendChild(icon('plus'))
  newBtn.onclick = () => openEditor()
  const railClose = el('button', 'icon-btn rail-close')
  railClose.type = 'button'
  railClose.id = 'rail-close'
  railClose.title = '关闭主机导航'
  railClose.setAttribute('aria-label', '关闭主机导航')
  railClose.appendChild(icon('close'))
  railClose.onclick = () => toggleRail()
  railBtns.append(newBtn, railClose)
  railHead.append(railTitle, railBtns)
  const searchWrap = el('label', 'search-wrap')
  searchWrap.append(el('span', 'sr-only', '搜索主机名称或地址'), icon('search'))
  const search = inputNode('host-search', '', { placeholder: '搜索名称、地址…' })
  search.type = 'search'
  search.addEventListener('input', () => renderRail())
  searchWrap.appendChild(search)
  const railScroll = el('div', 'rail-scroll')
  railScroll.id = 'host-list'
  const railFoot = el('footer', 'rail-foot')
  const summary = el('span', 'summary')
  summary.id = 'rail-summary'
  const trustBtn = el('button', 'icon-btn')
  trustBtn.type = 'button'
  trustBtn.title = '查看信任记录'
  trustBtn.setAttribute('aria-label', '查看信任记录')
  trustBtn.appendChild(icon('shield'))
  trustBtn.onclick = () => trustListSheet()
  railFoot.append(summary, trustBtn)
  rail.append(railHead, searchWrap, railScroll, railFoot)

  // -- workspace main
  const main = el('section', 'workspace-main')
  main.id = 'workspace-main'
  main.setAttribute('aria-label', '终端工作区')
  const tabstrip = el('div', 'tabstrip')
  const tabs = el('div', 'tabs')
  tabs.id = 'tabs'
  tabs.setAttribute('role', 'group')
  tabs.setAttribute('aria-label', '已打开的终端')
  const openHosts = el('button', 'icon-btn')
  openHosts.type = 'button'
  openHosts.title = '已连接主机：新建 shell 标签；否则打开主机导航'
  openHosts.setAttribute('aria-label', openHosts.title)
  openHosts.appendChild(icon('plus'))
  openHosts.onclick = () => {
    const conn = state.selection !== null ? (byId(state.selection) ?? null) : null
    if (conn !== null && isLive(liveOf(conn.id)) && state.session !== null && state.session.connId === conn.id) {
      openNewShellTab(conn.id)
      return
    }
    toggleRail()
  }
  tabstrip.append(tabs, openHosts)

  const toolbar = el('div', 'toolbar')
  const toggleRailBtn = el('button', 'icon-btn')
  toggleRailBtn.type = 'button'
  toggleRailBtn.id = 'toggle-rail'
  toggleRailBtn.title = '收起或展开主机导航'
  toggleRailBtn.setAttribute('aria-label', '收起或展开主机导航')
  toggleRailBtn.setAttribute('aria-expanded', 'true')
  toggleRailBtn.appendChild(icon('panel'))
  toggleRailBtn.onclick = () => toggleRail()
  const identity = el('div', 'identity')
  const identityTop = el('div', 'identity-top')
  const name = el('strong', '', 'SSH 工作区')
  name.id = 'identity-name'
  const env = el('span', 'env-chip', '')
  env.id = 'identity-env'
  env.hidden = true
  identityTop.append(name, env)
  const sub = el('div', 'identity-sub', '')
  sub.id = 'identity-sub'
  identity.append(identityTop, sub)
  const tools = el('div', 'tools')
  const searchBtn = el('button', 'icon-btn optional')
  searchBtn.type = 'button'
  searchBtn.id = 'btn-search'
  searchBtn.title = '查找终端内容'
  searchBtn.disabled = true
  searchBtn.appendChild(icon('search'))
  searchBtn.onclick = () => toggleSearchLine()
  const focusBtn = el('button', 'icon-btn optional')
  focusBtn.type = 'button'
  focusBtn.id = 'btn-focus'
  focusBtn.title = '专注模式'
  focusBtn.setAttribute('aria-pressed', 'false')
  focusBtn.appendChild(icon('focus'))
  focusBtn.onclick = () => toggleFocusMode()
  const divider = el('span', 'tool-divider optional')
  const moreBtn = el('button', 'icon-btn')
  moreBtn.type = 'button'
  moreBtn.id = 'btn-more'
  moreBtn.title = '更多终端操作'
  moreBtn.setAttribute('aria-expanded', 'false')
  moreBtn.disabled = true
  moreBtn.appendChild(icon('more'))
  moreBtn.onclick = () => {
    const conn = state.selection !== null ? (byId(state.selection) ?? null) : null
    if (conn === null) return
    const rect = moreBtn.getBoundingClientRect()
    openMenuAt(rect, hostMenuItems(conn))
    moreBtn.setAttribute('aria-expanded', 'true')
  }
  const sendBtn = el('button', 'icon-btn optional')
  sendBtn.type = 'button'
  sendBtn.id = 'btn-send'
  sendBtn.title = '把终端内容送往对话'
  sendBtn.setAttribute('aria-haspopup', 'true')
  sendBtn.setAttribute('aria-expanded', 'false')
  sendBtn.disabled = true
  sendBtn.appendChild(icon('send'))
  sendBtn.onclick = () => {
    const conn = state.selection !== null ? (byId(state.selection) ?? null) : null
    if (conn === null) return
    openMenuAt(sendBtn.getBoundingClientRect(), sendMenuItems(conn))
    sendBtn.setAttribute('aria-expanded', 'true')
  }
  tools.append(searchBtn, sendBtn, focusBtn, divider, moreBtn)
  toolbar.append(toggleRailBtn, identity, tools)

  const searchLine = el('div', 'search-line')
  searchLine.id = 'search-line'
  searchLine.hidden = true
  const query = inputNode('term-query', '', { placeholder: '查找终端内容' })
  query.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); runFind(event.shiftKey === true ? -1 : 1) }
  })
  query.addEventListener('input', () => { state.session?.find(''); runFind(0) })
  const findResult = el('span', 'result', '输入关键词')
  findResult.id = 'find-result'
  findResult.setAttribute('aria-live', 'polite')
  const closeFind = el('button', 'icon-btn')
  closeFind.type = 'button'
  closeFind.title = '关闭查找'
  closeFind.appendChild(icon('close'))
  closeFind.onclick = () => toggleSearchLine()
  searchLine.append(query, findResult, closeFind)

  const banner = el('div', 'state-banner')
  banner.id = 'state-banner'
  banner.hidden = true
  banner.setAttribute('aria-live', 'polite')

  // U2.1 写入所有权：只读条（决策 2）。可写时隐藏；接管按钮经 session.takeover()。
  const writeBar = el('div', 'write-bar')
  writeBar.id = 'write-bar'
  writeBar.hidden = true
  const writeText = el('span', 'write-text', '只读：另一个窗口正在此终端输入。')
  const writeTake = el('button', 'text-btn', '接管写入')
  writeTake.type = 'button'
  writeTake.id = 'write-take'
  writeBar.append(writeText, writeTake)

  const holder = el('div', 'term-holder')
  holder.id = 'term-holder'
  holder.setAttribute('role', 'region')
  holder.setAttribute('aria-label', 'SSH 终端')

  const emptySpace = el('div', 'empty-space')
  emptySpace.id = 'empty-space'

  const statusbar = el('footer', 'statusbar')
  const pill = el('span', 'status-pill')
  pill.id = 'status-pill'
  pill.appendChild(el('i', 'dot', ''))
  const statusText = el('span', 'status-text', '')
  statusText.id = 'status-text'
  // ⚠ #status-text 必须是 statusbar 的直接子节点、且 renderStatusbar 只改内容不重建节点：
  // 它曾被嵌进 pill 内部，renderStatusbar 的 replaceChildren 每次把它从 DOM 抹掉，
  // handleSessionStatus 在 $('#status-text').textContent 上抛 TypeError —— waiting-
  // fingerprint 的 onFrame 永不执行，TOFU 首连的确认 UI 不可达（D0 探针实测逮住）。
  const trustStatus = el('button', 'trust-btn', '')
  trustStatus.type = 'button'
  trustStatus.id = 'trust-status'
  const sizeText = el('span', 'status-end', '')
  sizeText.id = 'size-text'
  statusbar.append(pill, statusText, trustStatus, sizeText)

  const moreMenu = el('div', 'more-menu')
  moreMenu.id = 'more-menu'
  moreMenu.hidden = true
  moreMenu.setAttribute('role', 'group')
  moreMenu.setAttribute('aria-label', '主机与终端操作')

  main.append(tabstrip, toolbar, searchLine, banner, writeBar, holder, emptySpace, statusbar, moreMenu)
  const scrim = el('button', 'drawer-scrim')
  scrim.type = 'button'
  scrim.id = 'drawer-scrim'
  scrim.setAttribute('aria-label', '关闭主机抽屉')
  scrim.onclick = () => { closeRailDrawer(); $('#toggle-rail').focus() }
  workbench.append(scrim, rail, main)

  // -- sheet overlay
  const overlay = el('div', 'overlay hidden')
  overlay.id = 'sheet-overlay'
  const sheet = el('section', 'sheet')
  sheet.id = 'sheet'
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')
  sheet.setAttribute('aria-labelledby', 'sheet-title')
  const sheetHead = el('header', 'sheet-head')
  const sheetTitle = el('h2', '', '')
  sheetTitle.id = 'sheet-title'
  const sheetClose = el('button', 'icon-btn')
  sheetClose.type = 'button'
  sheetClose.id = 'sheet-close'
  sheetClose.setAttribute('aria-label', '关闭面板')
  sheetClose.appendChild(icon('close'))
  sheetClose.onclick = () => closeSheet()
  sheetHead.append(sheetTitle, sheetClose)
  const sheetBody = el('div', 'sheet-body')
  sheetBody.id = 'sheet-body'
  const sheetActions = el('footer', 'sheet-actions')
  sheetActions.id = 'sheet-actions'
  sheet.append(sheetHead, sheetBody, sheetActions)
  overlay.appendChild(sheet)

  root.append(workbench, overlay)
}

// ------------------------------------------------------------------ 全局键盘
function bindGlobalKeys() {
  document.addEventListener('keydown', event => {
    const sheetOpen = !$('#sheet-overlay').classList.contains('hidden')
    if (event.key === 'Escape') {
      if (sheetOpen) { event.preventDefault(); closeSheet(); return }
      if (!$('#more-menu').hidden) {
        event.preventDefault(); closeMenu(); $('#btn-more').focus(); return
      }
      if (state.searchOpen) { event.preventDefault(); toggleSearchLine(); return }
      const narrow = railVisibleWidth() < 720
      if (narrow && state.drawerOpen) { event.preventDefault(); closeRailDrawer(); $('#toggle-rail').focus(); return }
      return // 终端聚焦时 Esc 交给远端程序（plan §7.1）
    }
    if (event.key === 'Tab' && sheetOpen) {
      const sheet = $('#sheet')
      const focusable = [...sheet.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')]
        .filter(node => node.getClientRects().length > 0)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
  })
}

// ------------------------------------------------------------------ mount
async function mount() {
  const root = $('#app-root') ?? document.getElementById('ssh-root')
  if (root === null) return
  loadPrefs()
  applyThemeSnapshot(initialTheme())
  setupThemeListener()
  buildSkeleton(root)
  // 桌面壳窗控让位：抽屉标题栏的 × 不能与窗控组叠在一起（见 syncChromeClearance 注释）。
  // 先量一次（顶层窗口量不到就是 0），窗口尺寸变化时重测 —— 会话视图下 iframe 的右缘会动。
  syncChromeClearance()
  window.addEventListener('resize', scheduleChromeClearance)
  // 浮层模式（路线丁）专属：自绘顶栏（对话｜会话布｜SSH）。回退视图里不渲染 ——
  // 回退期的切换器是官方 tab 栏 + 会话头胶囊（D1 契约），双顶栏只会让人迷惑。
  if (isOverlayMode()) buildTopbar(root)
  bindGlobalKeys()
  if (state.focusMode || state.railHidden) syncRailMode()

  try {
    await refreshConnections()
  } catch (err) {
    state.pendingError = { message: `SSH 服务不可用：${err.message}` }
  }
  await refreshTrust()
  renderAll()

  // 刷新恢复（U2.3 决策 4 / 方案 §4.3.3）：恢复标签**形状**与激活项，绝不自动建立
  // SSH 连接 —— 用户点标签才走既有 attach 路径（host 侧连接保活则无损回到终端）。
  // 恢复失败（connId 已被删除）⇒ 该标签静默丢弃 + 一条提示；快照损坏 ⇒ 回空态。
  const ws = readWorkspace()
  if (ws !== null && Array.isArray(ws.tabs) && ws.tabs.length > 0) {
    const known = new Set(state.connections.map(item => item.id))
    const restored = []
    let lost = 0
    for (const item of ws.tabs) {
      if (item !== null && typeof item.connId === 'string' && known.has(item.connId)) {
        restored.push({ connId: item.connId, shellSeq: Number.isInteger(item.shellSeq) ? item.shellSeq : 1, title: item.title ?? null, live: true })
      } else {
        lost += 1
      }
    }
    state.tabs = restored
    const wantActive = Number.isInteger(ws.activeTab) ? ws.activeTab : null
    state.activeTab = wantActive !== null && wantActive >= 0 && wantActive < restored.length ? wantActive : null
    if (lost > 0) setStatusNote(`有 ${lost} 个标签无法恢复（主机已删除）。`)
  } else {
    // 兼容：无工作区快照时退回旧的「只记一个标签」路径
    const lastTab = readLastTab()
    if (lastTab !== null && state.connections.some(item => item.id === lastTab)) openHost(lastTab)
  }
  const activeItem = state.activeTab !== null ? state.tabs[state.activeTab] : null
  if (activeItem !== undefined && activeItem !== null && isLive(liveOf(activeItem.connId))) {
    try { openHost(activeItem.connId, { shellSeq: activeItem.shellSeq }) } catch { /* 恢复失败不阻塞 mount */ }
  } else {
    renderAll()
  }
}

window.addEventListener('DOMContentLoaded', () => { void mount() })
