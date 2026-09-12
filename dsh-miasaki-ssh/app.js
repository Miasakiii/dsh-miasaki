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
  tabs: [],               // 已打开查看器的主机 id（有序）
  activeTab: null,        // 当前标签的主机 id
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

function setupThemeListener() {
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return
    if (event.origin !== window.location.origin) return
    const data = event.data
    if (data === null || typeof data !== 'object' || data.source !== 'dsh-ssh' || data.type !== 'theme' || data.version !== 1) return
    applyThemeSnapshot(data)
  })
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
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ fontSize: state.prefs.fontSize, railHidden: state.railHidden, focus: state.focusMode }))
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
  const submit = event => {
    event.preventDefault()
    if (!form.reportValidity()) return
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
        if (event.saveAndConnect === true) void connectFlow(connection)
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
    { label: '保存并连接', primary: true, run: () => { event.saveAndConnect = true; form.dispatchEvent(new window.Event('submit', { cancelable: true })) } },
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

function openHost(id) {
  const conn = byId(id)
  if (conn === undefined) return
  state.selection = id
  state.pendingError = null
  state.frameState = null
  state.transport = false
  if (!state.tabs.includes(id)) state.tabs.push(id)
  state.activeTab = id
  renderAll()
  mountSession(conn)
}

function mountSession(conn) {
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
    holder,
    theme: state.xtermTheme ?? undefined,
    fontSize: state.prefs.fontSize,
    onStatus: (kind, text) => handleSessionStatus(kind, text),
    onFrame: msg => handleSessionFrame(conn, msg),
    onResize: size => { $('#size-text').textContent = `${size.cols}×${size.rows}` },
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
  }
  renderBanner()
  renderRail()
  renderTabs()
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
  for (const id of state.tabs) {
    const conn = byId(id)
    if (conn === undefined) continue
    const live = liveOf(id)
    const wrap = el('div', `terminal-tab${id === state.activeTab ? ' active' : ''}`)
    const select = el('button', 'tab-select')
    select.type = 'button'
    select.setAttribute('aria-pressed', String(id === state.activeTab))
    const dotClass = live === 'connected' ? ' connected' : live === 'error' ? ' error' : live === 'idle' || live === 'closed' ? '' : ' warning'
    select.append(el('i', `dot${dotClass}`), el('span', 'tab-label', conn.label))
    select.onclick = () => openHost(id)
    const close = el('button', 'tab-close', '×')
    close.type = 'button'
    close.title = `关闭 ${conn.label} 的查看`
    close.setAttribute('aria-label', `关闭 ${conn.label} 的查看`)
    close.onclick = () => closeTabDialog(id)
    wrap.append(select, close)
    tabs.appendChild(wrap)
  }
}

function renderIdentity() {
  const conn = state.selection !== null ? byId(state.selection) : null
  $('#identity-name').textContent = conn?.label ?? 'SSH 工作区'
  $('#identity-env').textContent = conn?.group ?? ''
  $('#identity-env').hidden = conn === null || !conn.group || conn.group === '未分组'
  $('#identity-sub').textContent = conn === null
    ? '选择主机，开始连接'
    : `${conn.username}@${conn.host}:${conn.port} · ${{ password: '密码认证', key: '私钥认证', agent: 'SSH agent' }[conn.auth?.method] ?? conn.auth?.method}`
  const live = conn !== null && isLive(liveOf(conn.id))
  $('#btn-search').disabled = !live
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
  banner.hidden = true
  const frame = state.frameState
  if (frame === null || frame.state === undefined) {
    if (state.pendingError !== null) {
      bannerNode('error', `连接失败：${state.pendingError.message}`, [
        { label: '编辑主机', run: () => { const conn = byId(state.selection); if (conn !== null) openEditor(conn) } },
      ])
    }
    return
  }
  const conn = state.activeTab !== null ? byId(state.activeTab) : null
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
  const conn = state.activeTab !== null ? byId(state.activeTab) : (state.selection !== null ? byId(state.selection) : null)
  const live = conn !== null ? liveOf(conn.id) : 'idle'
  const pill = $('#status-pill')
  pill.replaceChildren(
    el('i', `dot${live === 'connected' ? ' connected' : live === 'error' ? ' error' : isLive(live) ? ' warning' : ''}`),
    el('span', '', stateText(live)),
  )
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
  const conn = state.activeTab !== null ? byId(state.activeTab) : null
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
  if (state.selection === null) {
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
  const conn = byId(state.selection)
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
function closeTabDialog(id) {
  const conn = byId(id)
  if (conn === undefined) return
  const remove = disconnect => {
    closeSheet()
    state.tabs = state.tabs.filter(tab => tab !== id)
    if (state.activeTab === id) {
      state.activeTab = state.tabs.at(-1) ?? null
      destroySession()
      state.frameState = null
      if (state.activeTab !== null) {
        openHost(state.activeTab)
        return
      }
      state.selection = state.tabs.length > 0 ? state.selection : state.selection
    }
    if (disconnect === true) void disconnectHost(id)
    renderAll()
  }
  const nodes = [
    el('p', '', `${conn.label} · ${conn.username}@${conn.host}:${conn.port}`),
    el('p', 'notice', '默认仅关闭当前查看。连接继续保留，可从主机列表再次打开；如需结束远程 shell，请选择断开并关闭。'),
  ]
  openSheet('关闭终端查看', nodes, [
    { label: '取消', run: () => closeSheet() },
    { label: '断开并关闭', danger: true, run: () => remove(true) },
    { label: '仅关闭查看', primary: true, run: () => remove(false) },
  ])
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
        state.tabs = state.tabs.filter(tab => tab !== conn.id)
        if (state.activeTab === conn.id) { state.activeTab = state.tabs.at(-1) ?? null; destroySession() }
        if (state.selection === conn.id) state.selection = state.activeTab
        await refreshConnections()
        await refreshTrust()
        renderAll()
      } catch (err) { window.alert(`删除失败：${err.message}`) }
    })()
  } })
  return items
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
  openHosts.title = '打开主机导航'
  openHosts.setAttribute('aria-label', '打开主机导航')
  openHosts.appendChild(icon('plus'))
  openHosts.onclick = () => toggleRail()
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
    const conn = state.selection !== null ? byId(state.selection) : null
    if (conn === null) return
    const rect = moreBtn.getBoundingClientRect()
    openMenuAt(rect, hostMenuItems(conn))
    moreBtn.setAttribute('aria-expanded', 'true')
  }
  tools.append(searchBtn, focusBtn, divider, moreBtn)
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

  const holder = el('div', 'term-holder')
  holder.id = 'term-holder'
  holder.setAttribute('role', 'region')
  holder.setAttribute('aria-label', 'SSH 终端')

  const emptySpace = el('div', 'empty-space')
  emptySpace.id = 'empty-space'

  const statusbar = el('footer', 'statusbar')
  const pill = el('span', 'status-pill')
  pill.id = 'status-pill'
  const statusText = el('span', '', '')
  statusText.id = 'status-text'
  pill.appendChild(statusText)
  const trustStatus = el('button', 'trust-btn', '')
  trustStatus.type = 'button'
  trustStatus.id = 'trust-status'
  const sizeText = el('span', 'status-end', '')
  sizeText.id = 'size-text'
  statusbar.append(pill, trustStatus, sizeText)

  const moreMenu = el('div', 'more-menu')
  moreMenu.id = 'more-menu'
  moreMenu.hidden = true
  moreMenu.setAttribute('role', 'group')
  moreMenu.setAttribute('aria-label', '主机与终端操作')

  main.append(tabstrip, toolbar, searchLine, banner, holder, emptySpace, statusbar, moreMenu)
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
  bindGlobalKeys()
  if (state.focusMode || state.railHidden) syncRailMode()

  try {
    await refreshConnections()
  } catch (err) {
    state.pendingError = { message: `SSH 服务不可用：${err.message}` }
  }
  await refreshTrust()
  renderAll()
}

window.addEventListener('DOMContentLoaded', () => { void mount() })
