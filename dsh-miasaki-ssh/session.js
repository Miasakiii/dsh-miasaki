// session.js — one viewer's terminal session (browser half).
//
// A "viewer" is one iframe-side attachment to a host-side SSH connection.
// This module owns exactly one xterm instance and one WebSocket per viewer,
// so switching hosts or rebuilding the iframe disposes the whole bundle and
// can never cross-write output or leak listeners between generations
// (workspace plan §2「实例清理」/「输入归属」, §5.2 attach 契约).
//
// Plain script, no imports: served to the /ssh/ iframe before app.js, and
// executed inside node:vm by test/session.test.js with injected fakes —
// every environment hook is an option; nothing touches the DOM except
// through `holder`.
'use strict'
;(function () {
  const MAX_REATTACH = 4          // bounded auto re-attach of the VIEWER channel
  const REATTACH_BACKOFF_MS = 800 // linear backoff: 0.8s, 1.6s, 2.4s, 3.2s
  const COLS_RANGE = [2, 1000]
  const ROWS_RANGE = [2, 500]
  const STATE_TEXT = {
    idle: '未连接', connecting: '连接中…', 'waiting-fingerprint': '等待指纹确认',
    connected: '已连接', closed: '已断开', error: '失败',
  }

  function clampDim(value, [min, max], fallback) {
    const n = Number(value)
    if (!Number.isSafeInteger(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }

  function createTermSession(options) {
    const conn = options.conn
    const holder = options.holder
    const onStatus = options.onStatus ?? (() => {})
    const onFrame = options.onFrame ?? (() => {})
    const onResize = options.onResize ?? (() => {})
    const env = {
      Terminal: options.Terminal ?? globalThis.Terminal,
      FitAddon: options.FitAddon ?? globalThis.FitAddon,
      WebSocket: options.WebSocketCtor ?? globalThis.WebSocket,
      location: options.location ?? globalThis.location,
      requestFrame: options.requestFrame ?? (fn => globalThis.requestAnimationFrame(fn)),
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? (id => clearTimeout(id)),
      eventTarget: options.eventTarget ?? globalThis,
      ResizeObserver: options.ResizeObserver ?? globalThis.ResizeObserver,
    }

    let disposed = false
    let socket = null
    let retryTimer = null
    let attempts = 0     // viewer-channel re-attach attempts since last server frame
    let sshEnded = false // host reported the SSH session itself over → never re-attach
    let fitQueued = false
    const findState = { query: '', matches: [], pos: -1 }

    const term = new env.Terminal({
      cursorBlink: true,
      fontSize: options.fontSize ?? 13,
      fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
      // fixed palette until the first theme snapshot arrives (bridge keeps it fresh)
      theme: options.theme ?? { background: '#15191f', foreground: '#e3e8f0', cursor: '#9bb8ff', selectionBackground: '#263452' },
      scrollback: 5000,
    })
    const fit = new env.FitAddon.FitAddon()
    term.loadAddon(fit)
    term.open(holder)

    term.onData(data => {
      const s = socket
      if (s !== null && s.readyState === 1) s.send(JSON.stringify({ type: 'input', data }))
    })
    term.onResize(({ cols, rows }) => {
      onResize({ cols, rows })
      const s = socket
      if (s !== null && s.readyState === 1) {
        s.send(JSON.stringify({ type: 'resize', cols: clampDim(cols, COLS_RANGE, cols), rows: clampDim(rows, ROWS_RANGE, rows) }))
      }
    })

    // -- sizing: container-observed (ResizeObserver), rAF-coalesced, clamped
    function scheduleFit() {
      if (fitQueued || disposed) return
      fitQueued = true
      env.requestFrame(() => {
        fitQueued = false
        if (disposed) return
        try { fit.fit() } catch { /* zero-size container */ }
      })
    }
    let resizeObserver = null
    if (typeof env.ResizeObserver === 'function') {
      resizeObserver = new env.ResizeObserver(() => scheduleFit())
      resizeObserver.observe(holder)
    }
    const onWindowResize = () => scheduleFit()
    env.eventTarget.addEventListener?.('resize', onWindowResize)
    env.requestFrame(() => { if (!disposed) { try { fit.fit() } catch { /* layout */ } } })

    function send(json) {
      const s = socket
      if (s !== null && s.readyState === 1) s.send(JSON.stringify(json))
    }

    function handleControl(msg) {
      attempts = 0 // any server frame proves the viewer channel is alive again
      if (msg.type === 'ready') {
        // a ready frame means THIS viewer attached; shell state rides on msg.state
        onStatus(msg.state === 'connected' ? 'ok' : 'muted', msg.state === 'connected' ? `已连接 ${conn.host}` : (STATE_TEXT[msg.state] ?? '已附着'))
        return
      }
      if (msg.type === 'status') {
        if (msg.state === 'waiting-fingerprint') {
          onStatus('warn', '首次连接：请确认主机指纹')
          onFrame(msg)
          return
        }
        if (msg.state === 'connected') { onStatus('ok', `已连接 ${conn.host}`); return }
        if (msg.state === 'closed') { sshEnded = true; onStatus('muted', '会话已结束'); return }
        if (msg.state === 'error') { sshEnded = true; onStatus('error', msg.message || '连接失败'); return }
        onStatus('muted', STATE_TEXT[msg.state] ?? msg.state)
        return
      }
      if (msg.type === 'error') {
        if (msg.code === 'NO_CONNECTION') sshEnded = true
        onStatus('error', msg.message || '出错')
      }
    }

    function openSocket() {
      if (disposed) return
      const proto = env.location.protocol === 'https:' ? 'wss' : 'ws'
      const s = new env.WebSocket(`${proto}://${env.location.host}/ssh/ws`)
      s.binaryType = 'arraybuffer' // output frames are raw PTY bytes
      socket = s
      s.onopen = () => {
        s.send(JSON.stringify({ type: 'attach', connId: conn.id, cols: term.cols, rows: term.rows }))
      }
      s.onmessage = event => {
        if (disposed) return
        if (typeof event.data === 'string') {
          let msg = null
          try { msg = JSON.parse(event.data) } catch { return }
          if (msg !== null && typeof msg === 'object' && typeof msg.type === 'string') handleControl(msg)
          return
        }
        // binaryType='arraybuffer' ⇒ non-string frames are raw PTY bytes.
        // (No `instanceof ArrayBuffer`: it breaks across realms, e.g. the
        // node:vm test harness.)
        term.write(new Uint8Array(event.data))
      }
      s.onclose = () => {
        if (disposed || socket !== s) return
        socket = null
        if (sshEnded) return // the SSH session itself ended: re-attaching cannot revive it
        scheduleReattach()
      }
      s.onerror = () => { /* a close event always follows */ }
    }

    function scheduleReattach() {
      attempts += 1
      if (attempts > MAX_REATTACH) {
        onStatus('error', '终端通道多次重连失败；SSH 连接可能仍在后台保持，可返回连接管理重新打开终端')
        return
      }
      onStatus('muted', `连接中断，正在重新附着（${attempts}/${MAX_REATTACH}）…`)
      retryTimer = env.setTimer(() => {
        retryTimer = null
        if (!disposed) openSocket()
      }, REATTACH_BACKOFF_MS * attempts)
    }

    function dispose() {
      if (disposed) return
      disposed = true
      if (retryTimer !== null) { env.clearTimer(retryTimer); retryTimer = null }
      if (socket !== null) {
        const s = socket
        socket = null
        s.onclose = null
        s.onmessage = null
        s.onopen = null
        s.onerror = null
        try { s.close(1000, 'viewer-disposed') } catch { /* already closed */ }
      }
      try { resizeObserver?.disconnect() } catch { /* noop */ }
      env.eventTarget.removeEventListener?.('resize', onWindowResize)
      try { term.dispose() } catch { /* noop */ }
    }

    // ------------------------------------------------------------------ viewer-side extras (U1)

    /** Push a fresh xterm theme (bridge keeps this in sync with the host). */
    function applyTheme(theme) {
      if (disposed || theme === null || typeof theme !== 'object') return
      term.options.theme = theme
    }

    /** Terminal font size, clamped to the 12–20px band (plan §4.3). */
    function setFontSize(px) {
      if (disposed) return 13
      const next = clampDim(px, [12, 20], term.options.fontSize ?? 13)
      if (next !== term.options.fontSize) {
        term.options.fontSize = next
        scheduleFit() // re-fit → resize frame → real PTY follows
      }
      return next
    }

    function fontSize() {
      return term.options.fontSize ?? 13
    }

    /** All occurrences of `query` (case-insensitive) in the visible buffer. */
    function scanBuffer(query) {
      const buf = term.buffer.active
      const matches = []
      const q = query.toLowerCase()
      for (let y = 0; y < buf.length; y += 1) {
        const line = buf.getLine(y)
        if (line === null) continue
        // trimRight: 组合宽字符时 string index 与列号可能有偏差（U1 已知边界）
        const text = line.translateToString(true)
        const lower = text.toLowerCase()
        let idx = lower.indexOf(q)
        while (idx !== -1 && q.length > 0) {
          matches.push({ row: y, col: idx, length: query.length })
          idx = lower.indexOf(q, idx + 1)
        }
      }
      return matches
    }

    /**
     * Native buffer find (no addon dependency): scans the buffer, selects the
     * match and scrolls to it. direction: 1 next / -1 prev, wrapping.
     */
    function find(query, direction = 1) {
      if (disposed) return { total: 0, current: 0 }
      const text = String(query ?? '')
      if (text.length === 0) {
        findState.query = ''
        findState.matches = []
        findState.pos = -1
        try { term.clearSelection() } catch { /* noop */ }
        return { total: 0, current: 0 }
      }
      if (text !== findState.query) {
        findState.query = text
        findState.matches = scanBuffer(text)
        // start from the first match at/after the cursor line
        const cursorRow = term.buffer.active.cursorY
        findState.pos = findState.matches.findIndex(m => m.row >= cursorRow)
        if (findState.pos === -1) findState.pos = 0
      } else if (findState.matches.length > 0) {
        findState.pos = (findState.pos + (direction >= 0 ? 1 : -1) + findState.matches.length) % findState.matches.length
      }
      const match = findState.matches[findState.pos]
      if (match !== undefined) {
        try {
          term.select(match.col, match.row, match.length)
          term.scrollToLine(match.row)
        } catch { /* wide-char edge: selection skipped, navigation still works */ }
      }
      return { total: findState.matches.length, current: findState.matches.length === 0 ? 0 : findState.pos + 1 }
    }

    /** 清除本地显示（不向远端发送任何按键——与远端 clear 严格区分，plan §6）。 */
    function clearLocal() {
      if (disposed) return
      try { term.clear() } catch { /* noop */ }
    }

    /** Direct input write (used by the paste-confirm path, bypasses term.onData). */
    function input(data) {
      const s = socket
      if (typeof data === 'string' && s !== null && s.readyState === 1) s.send(JSON.stringify({ type: 'input', data }))
    }

    function size() {
      return { cols: term.cols, rows: term.rows }
    }

    openSocket()

    return {
      connId: conn.id, term, fit, dispose,
      applyTheme, setFontSize, fontSize, find, clearLocal, input, size,
    }
  }

  const api = { create: createTermSession, MAX_REATTACH, REATTACH_BACKOFF_MS }
  if (typeof window !== 'undefined') window.SshTermSession = api
  else globalThis.SshTermSession = api
})()
