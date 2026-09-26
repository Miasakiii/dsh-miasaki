// U2.2 文件面板（DSH web SSH 插件线，design/2026-09-26-ssh-zcode-benchmark-plan.md §4-P0-2 前端）。
// 自包含 IIFE：不依赖 app.js 的状态机，只在其上挂一个右抽屉。
//   - 票据：打开时签发（10 分钟可续期），每次操作前按需 renew（超 4 分钟才续）
//   - 传输：上传队列并发 2（limits 同款口径），XHR 走浏览器侧进度；abort 支持
//   - 通道：下载/列表/变更走 REST；上传由 host 侧编排（SFTP 主路，失败自动降级 exec pipe）
(function () {
  const RENEW_AFTER_MS = 4 * 60 * 1000
  const CONCURRENCY = 2

  const state = {
    connId: null,
    label: '',
    ticket: null,
    ticketAt: 0,
    path: '/',
    home: '/',
    entries: [],
    busy: false,
    queue: [],
    running: 0,
    drawer: null,
    listNode: null,
    crumbNode: null,
    errNode: null,
    queueNode: null,
  }

  const $ = sel => document.querySelector(sel)

  async function callApi(path, options = {}) {
    const res = await fetch(path, options)
    let body = null
    try { body = await res.json() } catch { /* non-json */ }
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
    return body
  }

  const encodePath = p => encodeURIComponent(p)

  async function ensureTicket() {
    if (state.ticket !== null && Date.now() - state.ticketAt < RENEW_AFTER_MS) return state.ticket
    if (state.ticket !== null) {
      const renewed = await callApi('/ssh/api/sftp/renew', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: state.ticket }),
      }).catch(() => null)
      if (renewed !== null) { state.ticketAt = Date.now(); return state.ticket }
    }
    const issued = await callApi('/ssh/api/sftp/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connId: state.connId }),
    })
    state.ticket = issued.ticket
    state.ticketAt = Date.now()
    return state.ticket
  }

  function joinPath(dir, name) {
    return dir === '/' ? `/${name}` : `${dir}/${name}`
  }

  function formatSize(size) {
    if (size === null || size === undefined) return '—'
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / 1024 / 1024).toFixed(1)} MB`
  }

  function formatTime(ms) {
    if (ms === null || ms === undefined) return ''
    const d = new Date(ms)
    const pad = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  // ------------------------------------------------------------------ DOM

  function buildDrawer() {
    const drawer = document.createElement('aside')
    drawer.className = 'files-drawer'
    drawer.id = 'files-drawer'
    drawer.hidden = true
    drawer.setAttribute('role', 'dialog')
    drawer.setAttribute('aria-modal', 'false')
    drawer.setAttribute('aria-label', '远程文件面板')

    const head = document.createElement('header')
    head.className = 'files-head'
    const title = document.createElement('strong')
    title.id = 'files-title'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'icon-btn'
    close.id = 'files-close'
    close.title = '关闭文件面板'
    close.setAttribute('aria-label', '关闭文件面板')
    close.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>'
    close.onclick = () => window.SshFiles.close()
    head.append(title, close)

    const tools = document.createElement('div')
    tools.className = 'files-tools'
    const upBtn = (id, label, run) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'text-btn'
      btn.id = id
      btn.textContent = label
      btn.onclick = run
      return btn
    }
    tools.append(
      upBtn('files-up', '上级目录', () => { if (state.path !== '/') void load(parentPath(state.path)) }),
      upBtn('files-refresh', '刷新', () => void load(state.path)),
      upBtn('files-upload', '上传…', () => $('#files-input').click()),
      upBtn('files-mkdir', '新建目录', () => void mkdirFlow()),
    )
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'files-input'
    input.multiple = true
    input.hidden = true
    input.onchange = () => { enqueueUploads([...input.files]); input.value = '' }
    tools.append(input)

    const crumb = document.createElement('div')
    crumb.className = 'files-crumb'
    crumb.id = 'files-crumb'

    const err = document.createElement('p')
    err.className = 'files-error'
    err.id = 'files-error'
    err.hidden = true

    const list = document.createElement('div')
    list.className = 'files-list'
    list.id = 'files-list'
    list.setAttribute('role', 'list')

    const queue = document.createElement('div')
    queue.className = 'files-queue'
    queue.id = 'files-queue'
    queue.hidden = true

    drawer.append(head, tools, crumb, err, list, queue)
    return drawer
  }

  function parentPath(path) {
    if (path === '/') return '/'
    const index = path.lastIndexOf('/')
    return index <= 0 ? '/' : path.slice(0, index)
  }

  function crumbName(path) {
    if (path === '/') return '/'
    return path.slice(path.lastIndexOf('/') + 1)
  }

  function renderCrumb() {
    const node = state.crumbNode
    node.replaceChildren()
    const segments = state.path.split('/').filter(Boolean)
    const root = document.createElement('button')
    root.type = 'button'
    root.className = 'files-crumb-seg'
    root.textContent = '/'
    root.onclick = () => void load('/')
    node.append(root)
    let acc = ''
    for (const seg of segments) {
      acc += `/${seg}`
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'files-crumb-seg'
      btn.textContent = seg
      const target = acc
      btn.onclick = () => void load(target)
      node.append(el('span', 'files-crumb-sep', '/'), btn)
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function typeGlyph(type) {
    if (type === 'dir') return '📁'
    if (type === 'link') return '🔗'
    if (type === 'file') return '📄'
    return '❔'
  }

  function renderList() {
    const node = state.listNode
    node.replaceChildren()
    if (state.entries.length === 0) {
      node.append(el('p', 'files-empty', '这个目录是空的。'))
      return
    }
    const sorted = [...state.entries].sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1
      if (b.type === 'dir' && a.type !== 'dir') return 1
      return a.name < b.name ? -1 : 1
    })
    for (const entry of sorted) {
      const row = document.createElement('div')
      row.className = 'files-row'
      row.setAttribute('role', 'listitem')
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'files-open'
      open.title = entry.name
      open.append(el('span', 'files-glyph', typeGlyph(entry.type)), el('span', 'files-name', entry.name))
      open.onclick = () => {
        if (entry.type === 'dir') { void load(joinPath(state.path, entry.name)); return }
        if (entry.type === 'file') { void download(joinPath(state.path, entry.name)); return }
        setError(`「${entry.name}」是符号链接，暂不支持直接进入。`)
      }
      const meta = el('span', 'files-meta', `${entry.type === 'dir' ? '目录' : formatSize(entry.size)}${entry.mtime ? ` · ${formatTime(entry.mtime)}` : ''}`)
      const ops = document.createElement('span')
      ops.className = 'files-ops'
      const renameBtn = document.createElement('button')
      renameBtn.type = 'button'
      renameBtn.className = 'text-btn'
      renameBtn.textContent = '重命名'
      renameBtn.onclick = () => void renameFlow(entry)
      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'text-btn danger'
      delBtn.textContent = '删除'
      delBtn.onclick = () => void deleteFlow(entry)
      ops.append(renameBtn, delBtn)
      row.append(open, meta, ops)
      node.append(row)
    }
  }

  function setError(message) {
    const node = state.errNode
    if (message === null || message === undefined || message === '') { node.hidden = true; node.textContent = ''; return }
    node.textContent = message
    node.hidden = false
  }

  // ------------------------------------------------------------------ data

  async function load(path) {
    if (state.busy) return
    state.busy = true
    setError(null)
    try {
      const ticket = await ensureTicket()
      const body = await callApi(`/ssh/api/sftp/list?ticket=${encodeURIComponent(ticket)}&path=${encodePath(path)}`)
      state.path = body.path
      state.home = body.home
      state.entries = body.entries
      renderCrumb()
      renderList()
    } catch (error) {
      setError(`打开目录失败：${error.message}`)
    } finally {
      state.busy = false
    }
  }

  async function download(path) {
    try {
      const ticket = await ensureTicket()
      const anchor = document.createElement('a')
      anchor.href = `/ssh/api/sftp/download?ticket=${encodeURIComponent(ticket)}&path=${encodePath(path)}`
      anchor.download = path.slice(path.lastIndexOf('/') + 1)
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    } catch (error) {
      setError(`下载失败：${error.message}`)
    }
  }

  function validName(name) {
    return typeof name === 'string' && name.length > 0 && !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..'
  }

  async function mkdirFlow() {
    const name = window.prompt('新建目录名称：')
    if (!validName(name)) { if (name !== null) setError('目录名不能为空、不能包含 /'); return }
    try {
      await opCall('mkdir', joinPath(state.path, name))
      setStatus(`已创建目录 ${name}`)
      await load(state.path)
    } catch (error) { setError(`新建目录失败：${error.message}`) }
  }

  async function renameFlow(entry) {
    const name = window.prompt('新名称：', entry.name)
    if (!validName(name)) { if (name !== null) setError('名称不能为空、不能包含 /'); return }
    try {
      await opCall('rename', joinPath(state.path, entry.name), joinPath(state.path, name))
      setStatus(`已重命名为 ${name}`)
      await load(state.path)
    } catch (error) { setError(`重命名失败：${error.message}`) }
  }

  async function deleteFlow(entry) {
    const isDir = entry.type === 'dir'
    if (!window.confirm(`删除${isDir ? '目录' : '文件'}「${entry.name}」？此操作不可恢复。`)) return
    try {
      await opCall(isDir ? 'rmdir' : 'unlink', joinPath(state.path, entry.name))
      setStatus(`已删除 ${entry.name}`)
      await load(state.path)
    } catch (error) { setError(`删除失败：${error.message}`) }
  }

  async function opCall(op, path, to) {
    const ticket = await ensureTicket()
    return callApi('/ssh/api/sftp/op', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, op, path, ...(to === undefined ? {} : { to }) }),
    })
  }

  function setStatus(text) {
    const note = $('#status-text')
    if (note !== null) note.textContent = text
  }

  // ------------------------------------------------------------------ 上传队列（并发 2）

  function enqueueUploads(files) {
    if (files.length === 0) return
    for (const file of files) {
      state.queue.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        size: file.size,
        file,
        status: 'queued',
        percent: 0,
        note: '',
        xhr: null,
      })
    }
    renderQueue()
    void pumpQueue()
  }

  async function pumpQueue() {
    while (state.running < CONCURRENCY) {
      const next = state.queue.find(item => item.status === 'queued')
      if (next === undefined) return
      state.running += 1
      next.status = 'uploading'
      renderQueue()
      try {
        await uploadOne(next)
        next.status = 'done'
      } catch (error) {
        next.status = error.name === 'AbortError' ? 'canceled' : 'failed'
        next.note = error.message
      } finally {
        state.running -= 1
        renderQueue()
        void pumpQueue()
      }
    }
  }

  function uploadOne(item) {
    return new Promise((resolve, reject) => {
      ensureTicket().then(ticket => {
        const xhr = new XMLHttpRequest()
        item.xhr = xhr
        const path = joinPath(state.path, item.name)
        xhr.open('POST', `/ssh/api/sftp/upload?ticket=${encodeURIComponent(ticket)}&path=${encodePath(path)}&overwrite=0&size=${item.size}`)
        xhr.upload.onprogress = event => {
          if (event.lengthComputable === true) {
            item.percent = Math.round((event.loaded / event.total) * 100)
            renderQueue()
          }
        }
        xhr.onload = () => {
          let body = null
          try { body = JSON.parse(xhr.responseText) } catch { /* non-json */ }
          if (xhr.status >= 200 && xhr.status < 300) {
            item.note = body?.transport === 'exec' ? '经命令通道上传（SFTP 不可用）' : 'SFTP 上传完成'
            resolve(body)
          } else {
            reject(new Error(body?.error ?? `HTTP ${xhr.status}`))
          }
        }
        xhr.onerror = () => reject(new Error('网络错误'))
        xhr.onabort = () => reject(Object.assign(new Error('已取消'), { name: 'AbortError' }))
        xhr.send(item.file)
      }).catch(reject)
    })
  }

  function renderQueue() {
    const node = state.queueNode
    const active = state.queue.filter(item => item.status !== 'done' || Date.now() - (item.doneAt ?? 0) < 8000)
    node.hidden = state.queue.length === 0
    node.replaceChildren()
    const title = el('strong', 'files-queue-title', `传输队列（${state.running}/${CONCURRENCY} 进行中）`)
    node.append(title)
    for (const item of [...state.queue].reverse()) {
      const row = el('div', `files-queue-row ${item.status}`)
      row.append(
        el('span', 'files-queue-name', item.name),
        el('span', 'files-queue-size', formatSize(item.size)),
      )
      if (item.status === 'uploading') {
        const bar = el('div', 'files-bar')
        const fill = el('i')
        fill.style.width = `${item.percent}%`
        bar.append(fill)
        row.append(bar, el('span', 'files-queue-pct', `${item.percent}%`))
      } else if (item.status === 'queued') {
        row.append(el('span', 'files-queue-pct', '等待中'))
      } else {
        if (item.status === 'done') item.doneAt = Date.now()
        row.append(el('span', 'files-queue-note', item.status === 'done' ? item.note : item.status === 'canceled' ? '已取消' : `失败：${item.note}`))
        if (item.status === 'uploading' || item.status === 'queued') {
          const cancel = document.createElement('button')
          cancel.type = 'button'
          cancel.className = 'text-btn danger'
          cancel.textContent = '取消'
          cancel.onclick = () => { try { item.xhr?.abort() } catch { /* gone */ } }
          row.append(cancel)
        }
      }
      node.append(row)
    }
    void active
  }

  // ------------------------------------------------------------------ 开关

  async function open(connId, label) {
    if (state.drawer === null) {
      state.drawer = buildDrawer()
      const workbench = $('#workbench')
      workbench.append(state.drawer)
      state.crumbNode = $('#files-crumb')
      state.errNode = $('#files-error')
      state.listNode = $('#files-list')
      state.queueNode = $('#files-queue')
    }
    const sameConn = state.connId === connId && state.drawer.hidden === false
    state.connId = connId
    state.label = label ?? connId
    $('#files-title').textContent = `文件 · ${state.label}`
    state.drawer.hidden = false
    if (!sameConn) {
      state.ticket = null
      state.path = '/'
      state.entries = []
      await load('/')
    }
  }

  function close() {
    if (state.drawer !== null) state.drawer.hidden = true
    state.connId = null
    state.ticket = null
  }

  function isOpenFor(connId) {
    return state.drawer !== null && state.drawer.hidden === false && state.connId === connId
  }

  // `_pure` 是测试缝（与 host 半的 deps 注入同一惯例）：把可单测的纯函数暴露出来，
  // 产品代码不读它。
  window.SshFiles = { open, close, isOpenFor, _pure: { formatSize, formatTime, parentPath, joinPath, validName, crumbName } }
})()
