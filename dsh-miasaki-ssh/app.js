// @miasaki/dsh-ssh — browser half (served inside the /ssh/ iframe).
//
// Builds its own DOM into #ssh-root. Two screens:
//   library  — connection CRUD (list + editor form)
//   terminal — xterm interactive session for one connection
//
// Session flow: 连接 → (password-auth: ask once, current tab memory only) →
// POST /connect starts the host-side ssh2 Client → WebSocket attach at
// /ssh/ws → JSON status/control frames + binary terminal output frames
// (host replays scrollback on attach).
/* global Terminal, FitAddon */
'use strict'

const $ = s => document.querySelector(s)

const state = {
  connections: [],
  activeId: null,
  term: null,
  fit: null,
  socket: null,
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

// ------------------------------------------------------------------ dom helpers
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function showScreen(name) {
  for (const node of document.querySelectorAll('.screen')) node.classList.toggle('hidden', node.dataset.screen !== name)
  document.body.dataset.screen = name
}

// ------------------------------------------------------------------ library
async function refreshConnections() {
  const data = await api('/ssh/api/connections')
  state.connections = data.connections ?? []
  const list = $('#conn-list')
  list.replaceChildren()
  if (state.connections.length === 0) {
    list.appendChild(el('div', 'empty-hint', '还没有连接。点「新建连接」开始。'))
    return
  }
  for (const conn of state.connections) list.appendChild(connRow(conn))
}

function connRow(conn) {
  const row = el('div', 'conn-row')
  row.appendChild(el('div', 'conn-name', conn.label))
  const meta = el('div', 'conn-meta', `${conn.username}@${conn.host}:${conn.port} · ${conn.group}`)
  row.appendChild(meta)

  const badge = el('span', `pill pill-${conn.state ?? 'idle'}`, stateText(conn.state ?? 'idle'))
  row.appendChild(badge)

  const actions = el('div', 'row-actions')
  const connect = el('button', 'btn btn-primary', conn.state === 'connected' ? '已连接' : '连接')
  connect.disabled = conn.state === 'connected'
  connect.onclick = () => { void connectFlow(conn) }
  actions.appendChild(connect)

  const edit = el('button', 'btn', '编辑')
  edit.onclick = () => openEditor(conn)
  actions.appendChild(edit)

  const del = el('button', 'btn btn-danger', '删除')
  del.onclick = async () => {
    if (!window.confirm(`删除连接「${conn.label}」？`)) return
    await api(`/ssh/api/connections/${encodeURIComponent(conn.id)}`, { method: 'DELETE' })
    refreshConnections()
  }
  actions.appendChild(del)
  row.appendChild(actions)
  return row
}

// ------------------------------------------------------------------ editor
function openEditor(conn = null) {
  $('#edit-id').value = conn?.id ?? ''
  $('#edit-label').value = conn?.label ?? ''
  $('#edit-host').value = conn?.host ?? ''
  $('#edit-port').value = String(conn?.port ?? 22)
  $('#edit-username').value = conn?.username ?? 'root'
  $('#edit-method').value = conn?.auth?.method ?? 'password'
  $('#edit-keypath').value = conn?.auth?.keyPath ?? ''
  $('#edit-keypath').disabled = $('#edit-method').value !== 'key'
  $('#editor-title').textContent = conn ? '编辑连接' : '新建连接'
  showScreen('editor')
}

async function saveEditor() {
  const body = {
    label: $('#edit-label').value.trim() || $('#edit-host').value.trim() || '未命名主机',
    host: $('#edit-host').value.trim(),
    port: Number($('#edit-port').value) || 22,
    username: $('#edit-username').value.trim() || 'root',
    group: 'default',
    auth: { method: $('#edit-method').value },
  }
  if (body.auth.method === 'key') body.auth.keyPath = $('#edit-keypath').value.trim()
  const id = $('#edit-id').value
  const path = id ? `/ssh/api/connections/${encodeURIComponent(id)}` : '/ssh/api/connections'
  const verb = id ? 'PUT' : 'POST'
  const { connection } = await api(path, { method: verb, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return connection
}

// ------------------------------------------------------------------ connect flow
async function connectFlow(conn) {
  const secrets = {}
  if (conn.auth?.method === 'password') secrets.password = await askPassword(conn)
  const res = await api(`/ssh/api/connections/${encodeURIComponent(conn.id)}/connect`, json(secrets))
  state.activeId = conn.id
  showScreen('terminal')
  renderTerminal(conn)
}

function askPassword(conn) {
  return new Promise((resolve, reject) => {
    const overlay = $('#pwd-overlay')
    overlay.classList.remove('hidden')
    $('#pwd-title').textContent = `密码：${conn.username}@${conn.host}:${conn.port}`
    const input = $('#pwd-input')
    input.value = ''
    input.focus()
    $('#pwd-ok').onclick = () => {
      overlay.classList.add('hidden')
      resolve(input.value)
    }
    $('#pwd-cancel').onclick = () => {
      overlay.classList.add('hidden')
      reject(new Error('已取消连接'))
    }
    input.onkeydown = event => { if (event.key === 'Enter') $('#pwd-ok').click() }
  })
}

// ------------------------------------------------------------------ terminal
function renderTerminal(conn) {
  const holder = $('#term-holder')
  holder.replaceChildren()
  setStatus('连接中…', 'muted')
  $('#term-host').textContent = `${conn.label}（${conn.username}@${conn.host}:${conn.port}）`

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
    theme: { background: '#0b0e14', foreground: '#d4d7dc', cursor: '#ffcc66', selectionBackground: '#34435e' },
    scrollback: 5000,
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(holder)
  requestAnimationFrame(() => { try { fit.fit() } catch { /* layout */ } })

  state.term = term
  state.fit = fit

  term.onData(data => { if (state.socket?.readyState === 1) state.socket.send(JSON.stringify({ type: 'input', data })) })
  term.onResize(({ cols, rows }) => { if (state.socket?.readyState === 1) state.socket.send(JSON.stringify({ type: 'resize', cols, rows })) })
  window.addEventListener('resize', () => { try { fit.fit() } catch { /* noop */ } })

  openSocket(conn)
}

function openSocket(conn) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${proto}://${window.location.host}/ssh/ws`)
  state.socket = socket
  socket.onopen = () => {
    const { term } = state
    socket.send(JSON.stringify({ type: 'attach', connId: conn.id, cols: term?.cols, rows: term?.rows }))
  }
  socket.onmessage = event => {
    if (typeof event.data === 'string') { try { routeText(conn, JSON.parse(event.data)) } catch { /* ignore */ } return }
    state.term?.write(new Uint8Array(event.data)) // binary output frame (incl. replay)
  }
  socket.onclose = () => {
    if (state.activeId === conn.id && state.socket === socket) setStatus('连接已断开', 'muted')
  }
}

function routeText(conn, msg) {
  switch (msg.type) {
    case 'ready':
      setStatus(msg.state === 'connected' ? `已连接 ${conn.host}` : '等待连接…', msg.state === 'connected' ? 'ok' : 'muted')
      return
    case 'status':
      if (msg.state === 'waiting-fingerprint') { askFingerprint(conn, msg); return }
      if (msg.state === 'connected') return setStatus(`已连接 ${conn.host}`, 'ok')
      if (msg.state === 'closed') return setStatus('会话已关闭', 'muted')
      if (msg.state === 'error') return setStatus(msg.message || '连接失败', 'error')
      return setStatus(stateText(msg.state), 'muted')
    case 'error':
      setStatus(msg.message || '出错', 'error')
      return
  }
}

function askFingerprint(conn, msg) {
  setStatus('首次连接：请确认主机指纹', 'warn')
  const ok = window.confirm(
    `首次连接 ${conn.host}:${conn.port}\n\n主机指纹（SHA256）：\n${msg.fingerprint}\n\n确认信任此主机并继续吗？\n（将记录于 known_hosts；若拒绝则取消连接）`,
  )
  api('/ssh/api/fingerprint', json({ token: msg.token, accept: ok })).catch(err => setStatus(`指纹确认失败：${err.message}`, 'error'))
  if (!ok) setStatus('已拒绝指纹，连接取消', 'muted')
}

function setStatus(text, kind) {
  const node = $('#term-status')
  node.textContent = text
  node.className = `term-status ${kind ?? ''}`
}

// ------------------------------------------------------------------ UI skeleton
function mount() {
  const root = $('#app-root') ?? document.getElementById('ssh-root')
  if (root === null) return

  const header = el('header', 'topbar')
  header.appendChild(el('span', 'brand', 'SSH'))
  const nav = el('div', 'nav-btns')
  const navLib = el('button', 'nav-btn', '连接管理')
  navLib.onclick = () => showScreen('library')
  const navTerm = el('button', 'nav-btn', '终端')
  navTerm.onclick = () => showScreen('terminal')
  nav.append(navLib, navTerm)
  header.appendChild(nav)
  const newBtn = el('button', 'btn btn-primary', '新建连接')
  newBtn.onclick = () => openEditor()
  header.appendChild(newBtn)
  root.appendChild(header)

  // -- library screen
  const lib = el('div', 'screen', undefined); lib.dataset.screen = 'library'
  lib.id = 'library'
  lib.appendChild(el('div', 'section-title', '已保存的连接'))
  lib.appendChild(el('div', '', undefined)).id = 'conn-list'
  root.appendChild(lib)

  // -- editor screen
  const editor = el('div', 'screen', undefined); editor.dataset.screen = 'editor'
  editor.id = 'editor'
  editor.appendChild(el('h2', '', '')).id = 'editor-title'
  const form = el('form', 'editor-form'); form.id = 'editor-form'
  form.appendChild(field('名称', 'edit-label', 'text', undefined, '例如：生产服务器'))
  form.appendChild(field('主机', 'edit-host', 'text', undefined, '域名或 IP'))
  const portWrap = el('div', 'field'), portLabel = el('label', '', '端口')
  portLabel.htmlFor = 'edit-port'; portWrap.appendChild(portLabel)
  portWrap.appendChild(el('input', '', '22')).id = 'edit-port'
  form.appendChild(portWrap)
  form.appendChild(field('用户名', 'edit-username', 'text', undefined, '默认 root'))
  const methodField = el('div', 'field'), methodLabel = el('label', '', '认证方式')
  methodLabel.htmlFor = 'edit-method'
  const methodSel = el('select', '')
  methodSel.id = 'edit-method'
  for (const [value, label] of [['password', '密码'], ['key', '私钥'], ['agent', 'SSH Agent']]) {
    const opt = el('option', '', label); opt.value = value; methodSel.appendChild(opt)
  }
  methodField.append(methodLabel, methodSel)
  form.appendChild(methodField)
  const keyField = el('div', 'field'), keyLabel = el('label', '', '私钥路径')
  keyLabel.htmlFor = 'edit-keypath'
  const keyInput = el('input', ''); keyInput.id = 'edit-keypath'; keyInput.placeholder = 'C:\\Users\\you\\.ssh\\id_ed25519'
  keyField.append(keyLabel, keyInput)
  form.appendChild(keyField)
  form.appendChild(el('p', 'hint', '私钥仅记录路径，密钥内容不回传浏览器；如需口令请每次连接时输入。'))
  const buttons = el('div', 'form-actions')
  const save = el('button', 'btn btn-primary', '保存')
  save.type = 'submit'
  const cancel = el('button', 'btn', '取消')
  cancel.id = 'editor-cancel'
  buttons.append(save, cancel)
  form.appendChild(buttons)
  editor.appendChild(form)
  root.appendChild(editor)

  // -- terminal screen
  const term = el('div', 'screen', undefined); term.dataset.screen = 'terminal'
  term.id = 'terminal'
  const toolbar = el('div', 'term-toolbar')
  const back = el('button', 'btn btn-sm', '← 返回')
  back.onclick = () => { showScreen('library'); refreshConnections() }
  toolbar.appendChild(back)
  toolbar.appendChild(el('span', 'term-host', '')).id = 'term-host'
  toolbar.appendChild(el('span', 'term-status', '')).id = 'term-status'
  term.appendChild(toolbar)
  term.appendChild(el('div', 'term-holder', undefined)).id = 'term-holder'
  root.appendChild(term)

  // -- password overlay
  const overlay = el('div', 'overlay hidden', undefined); overlay.id = 'pwd-overlay'
  const card = el('div', 'dialog')
  card.appendChild(el('div', 'dialog-title', '')).id = 'pwd-title'
  const pwdInput = el('input', 'input-dark', undefined); pwdInput.id = 'pwd-input'; pwdInput.type = 'password'
  card.appendChild(pwdInput)
  const dialogActions = el('div', 'dialog-actions')
  const cancelPwd = el('button', 'btn', '取消'); cancelPwd.id = 'pwd-cancel'
  const okPwd = el('button', 'btn btn-primary', '连接'); okPwd.id = 'pwd-ok'
  dialogActions.append(cancelPwd, okPwd)
  card.appendChild(dialogActions)
  overlay.appendChild(card)
  root.appendChild(overlay)

  bindEvents()
  showScreen('library')
  refreshConnections().catch(err => window.alert(`SSH 服务不可用：${err.message}`))
}

function field(labelText, fieldId, type, unused, placeholder) {
  void unused
  const wrap = el('div', 'field')
  const label = el('label', '', labelText)
  label.htmlFor = fieldId
  const input = el('input', '')
  input.id = fieldId
  input.type = type ?? 'text'
  if (placeholder) input.placeholder = placeholder
  wrap.append(label, input)
  return wrap
}

function bindEvents() {
  $('#editor-form').addEventListener('submit', async event => {
    event.preventDefault()
    try {
      await saveEditor()
      showScreen('library')
      refreshConnections()
    } catch (error) {
      window.alert(`保存失败：${error.message}`)
    }
  })
  $('#edit-method').addEventListener('change', event => {
    $('#edit-keypath').disabled = event.target.value !== 'key'
  })
}

window.addEventListener('DOMContentLoaded', mount)