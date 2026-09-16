// session.js — one viewer's terminal session (browser half).
//
// A "viewer" is one iframe-side attachment to a host-side SSH connection.
// This module owns exactly one xterm instance and one WebSocket per viewer,
// so switching hosts or rebuilding the iframe disposes the whole bundle and
// can never cross-write output or leak listeners between generations
// (workspace plan §2「实例清理」/「输入归属」, §5.2 attach 契约).
//
// U2.1（design/2026-09-15-ssh-u2-plan.md §3/§4.1）：
//   * attach 先换一次性附着票据（POST /ssh/api/attach），WS 帧全部 v:2；
//   * 每个查看器绑定一个 shell channel（ws.shellId），input/resize 帧带 shellId；
//   * 写入所有权：ready/write.granted/write.revoked 帧驱动「可写 / 只读」状态，
//     显式接管走 shell.takeover（决策 2：单写多读）。
// U2.4 精确恢复（方案 §4.4 路线 A）：官方 @xterm/addon-serialize 在输出空闲时
//   采集屏幕快照并上报 host（内存态，封顶 128KiB）；附着恢复时 host 下发快照，
//   前端 reset 后重放 —— vim/top 刷新后屏幕与光标原样。addon 缺失则静默降级
//   为回放恢复（方案已记录的降级路径）。
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
  const PROTOCOL_VERSION = 2
  const SNAPSHOT_IDLE_MS = 1500   // output idle before a snapshot is taken (U2.4)
  const MAX_SNAPSHOT_BYTES = 128 * 1024 // must stay in sync with lib/runtime.js MAX_SNAPSHOT_BYTES
  const SNAPSHOT_SCROLLBACK = 500 // serialize scrollback cap（方案 §4.4：体积随滚动线性增长 ⇒ 设上限）
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
    const onModeChange = options.onModeChange ?? (() => {})
    const env = {
      Terminal: options.Terminal ?? globalThis.Terminal,
      FitAddon: options.FitAddon ?? globalThis.FitAddon,
      SerializeAddon: options.SerializeAddon ?? globalThis.SerializeAddon,
      WebSocket: options.WebSocketCtor ?? globalThis.WebSocket,
      fetcher: options.fetcher ?? globalThis.fetch,
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
    let ticketTimer = null
    let attempts = 0     // viewer-channel re-attach attempts since last server frame
    let sshEnded = false // the bound shell or host connection reported ended → never re-attach
    let fitQueued = false
    let shellId = typeof options.shellId === 'string' && options.shellId.length > 0 ? options.shellId : null
    let shellSeq = Number.isInteger(options.shellSeq) ? options.shellSeq : null // 刷新恢复：workspace 快照里的 seq
    let mode = 'read'
    let bufferLive = false   // this viewer already holds output (fresh load vs re-attach)
    let pendingSnapshot = null // snapshot frame arrived before binary replay (fresh load)
    let awaitingReplay = false // next binary on THIS socket is the attach replay (or a snapshot)
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

    // -- U2.4: official serialize addon (probe B: 0.14.0 works with xterm 6.0.0)
    let serializer = null
    const SerializeCtor = env.SerializeAddon && (env.SerializeAddon.SerializeAddon ?? env.SerializeAddon)
    if (typeof SerializeCtor === 'function') {
      try {
        serializer = new SerializeCtor()
        term.loadAddon(serializer)
      } catch { serializer = null } // 加载失败 ⇒ 降级为回放恢复，绝不阻塞终端
    }

    term.onData(data => {
      const s = socket
      if (s !== null && s.readyState === 1) s.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'input', shellId, data }))
    })
    term.onResize(({ cols, rows }) => {
      onResize({ cols, rows })
      const s = socket
      if (s !== null && s.readyState === 1) {
        s.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'resize', shellId, cols: clampDim(cols, COLS_RANGE, cols), rows: clampDim(rows, ROWS_RANGE, rows) }))
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
      if (s !== null && s.readyState === 1) s.send(JSON.stringify({ v: PROTOCOL_VERSION, ...json }))
    }

    // ------------------------------------------------------------------ U2.4 snapshot capture
    let snapshotTimer = null
    function scheduleSnapshot() {
      if (serializer === null || disposed || sshEnded) return
      if (snapshotTimer !== null) env.clearTimer(snapshotTimer)
      snapshotTimer = env.setTimer(() => {
        snapshotTimer = null
        captureSnapshot()
      }, SNAPSHOT_IDLE_MS)
    }

    function captureSnapshot() {
      if (serializer === null || disposed || shellId === null) return
      let data = null
      try { data = serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK }) } catch { return }
      if (typeof data !== 'string' || data.length === 0) return
      if (data.length > MAX_SNAPSHOT_BYTES) return // 体积超限 ⇒ 该 shell 不做精确恢复（回放兜底）
      send({ type: 'snapshot', shellId, data })
    }

    /**
     * 二进制入口：每个新 socket 的**第一段**二进制是附着回放（或快照），此后全是实时输出。
     * 快照帧先于回放到达时优先用快照（方案 §4.4.3）；重附着且本地缓冲仍在 ⇒ 丢弃整段回放避免翻倍。
     */
    function applyIncomingBinary(payloadBytes) {
      if (awaitingReplay) {
        awaitingReplay = false
        if (pendingSnapshot !== null) {
          const snap = pendingSnapshot
          pendingSnapshot = null
          try { term.reset() } catch { /* noop */ }
          term.write(snap) // 序列化串（含 ANSI），xterm.write 直接吃
          bufferLive = true
          return
        }
        if (!bufferLive) { // 刷新后的全新 iframe：回放兜底
          term.write(payloadBytes)
          bufferLive = true
        }
        return // 重附着且本地缓冲仍在：丢弃整段回放，避免内容翻倍
      }
      term.write(payloadBytes) // 实时输出：始终写入
      bufferLive = true
    }

    function handleControl(msg) {
      attempts = 0 // any server frame proves the viewer channel is alive again
      // 带 state 的帧（ready / status）必须**同时**喂给 app 侧状态模型（D-2 教训：
      // 状态栏文案与 live/frameState 是两个消费者，只写一个会留下裂缝）。
      if (typeof msg.state === 'string') {
        onFrame({ type: 'status', state: msg.state, token: msg.token, fingerprint: msg.fingerprint, code: msg.code, message: msg.message })
      }
      if (msg.type === 'ready') {
        if (typeof msg.shellId === 'string' && msg.shellId.length > 0) shellId = msg.shellId
        if (typeof msg.shellSeq === 'number') shellSeq = msg.shellSeq
        if (msg.mode === 'write' || msg.mode === 'read') setMode(msg.mode)
        onStatus(msg.state === 'connected' ? 'ok' : 'muted', msg.state === 'connected' ? `已连接 ${conn.host}` : (STATE_TEXT[msg.state] ?? '已附着'))
        return
      }
      if (msg.type === 'snapshot') {
        // 快照只在「本地还没有内容」时消费：刷新后的全新 iframe。
        if (typeof msg.data === 'string' && msg.data.length > 0 && msg.data.length <= MAX_SNAPSHOT_BYTES && !bufferLive) {
          pendingSnapshot = msg.data
        }
        return
      }
      if (msg.type === 'shell.opened') {
        if (typeof msg.shellId === 'string') shellId = msg.shellId
        const seqMatch = /#(\d+)$/.exec(String(msg.title ?? ''))
        if (seqMatch !== null) shellSeq = Number(seqMatch[1])
        sshEnded = false
        setMode(msg.mode === 'write' ? 'write' : 'read')
        onFrame({ type: 'shell.opened', shellId: msg.shellId, title: msg.title })
        return
      }
      if (msg.type === 'shell.closed') {
        // 本 shell 结束 ≠ 连接结束（探针 A P4）：标签保留为「会话已结束」，不自动重连
        sshEnded = true
        setMode('read')
        onStatus('muted', '会话已结束')
        onFrame({ type: 'shell.closed', shellId: msg.shellId, reason: msg.reason })
        return
      }
      if (msg.type === 'write.granted') { setMode('write'); onStatus('ok', '已接管写入'); return }
      if (msg.type === 'write.revoked') { setMode('read'); onStatus('muted', '写入权已被其他查看器接管，你已转为只读'); return }
      if (msg.type === 'write.open') { onFrame({ type: 'write.open', shellId: msg.shellId }); return }
      if (msg.type === 'status') {
        if (msg.state === 'waiting-fingerprint') { onStatus('warn', '首次连接：请确认主机指纹'); return }
        if (msg.state === 'connected') { onStatus('ok', `已连接 ${conn.host}`); return }
        if (msg.state === 'closed') { sshEnded = true; setMode('read'); onStatus('muted', '会话已结束'); return }
        if (msg.state === 'error') { sshEnded = true; setMode('read'); onStatus('error', msg.message || '连接失败'); return }
        onStatus('muted', STATE_TEXT[msg.state] ?? msg.state)
        return
      }
      if (msg.type === 'error') {
        if (msg.code === 'NO_CONNECTION' || msg.code === 'TICKET_INVALID' || msg.code === 'VERSION_MISMATCH') sshEnded = true
        if (msg.code === 'VERSION_MISMATCH') { onStatus('error', msg.message || '插件已升级，请刷新页面'); return }
        onStatus('error', msg.message || '出错')
      }
    }

    function setMode(next) {
      if (mode === next) return
      mode = next
      try { onModeChange(mode) } catch { /* UI callback must not break the session */ }
    }

    // -- attach ticket (方案 §3.2): one-time, TTL 30s; every (re)attach mints a fresh one
    function getTicket() {
      const fetcher = env.fetcher
      if (typeof fetcher !== 'function') return Promise.reject(new Error('fetch 不可用'))
      return fetcher('/ssh/api/attach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connId: conn.id }),
      }).then(async res => {
        let body = null
        try { body = await res.json() } catch { /* non-json */ }
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
        if (typeof body?.ticket !== 'string' || body.ticket.length === 0) throw new Error('附着票据签发失败')
        return body
      })
    }

    function openSocket() {
      if (disposed) return
      getTicket().then(info => {
        if (disposed) return
        // 票据可能带着 host 侧 shell 清单：默认 shell（或记忆的 shellId）在 ready 帧确认。
        if (Array.isArray(info.shells) && shellId === null) {
          const live = info.shells.find(sh => sh.state === 'live')
          if (live !== undefined) shellId = live.shellId
        }
        openSocketWithTicket(info.ticket)
      }).catch(err => {
        if (disposed) return
        // 票据签发失败 = 连接已不在（host 重启/连接被删）或传输中断：走同一预算重试
        attempts += 1
        if (attempts > MAX_REATTACH) {
          sshEnded = true
          onStatus('error', err?.message ?? '附着失败；SSH 连接可能已结束，可返回连接管理重新打开')
          return
        }
        onStatus('muted', `连接中断，正在重新附着（${attempts}/${MAX_REATTACH}）…`)
        retryTimer = env.setTimer(() => { retryTimer = null; if (!disposed) openSocket() }, REATTACH_BACKOFF_MS * attempts)
      })
    }

    function openSocketWithTicket(ticket) {
      const proto = env.location.protocol === 'https:' ? 'wss' : 'ws'
      const s = new env.WebSocket(`${proto}://${env.location.host}/ssh/ws`)
      s.binaryType = 'arraybuffer' // output frames are raw PTY bytes
      socket = s
      s.onopen = () => {
        s.send(JSON.stringify({
          v: PROTOCOL_VERSION, type: 'attach',
          ticket, shellId: shellId ?? undefined, shellSeq: shellSeq ?? undefined,
          cols: term.cols, rows: term.rows,
        }))
        awaitingReplay = true
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
        applyIncomingBinary(new Uint8Array(event.data))
        scheduleSnapshot()
      }
      s.onclose = () => {
        if (disposed || socket !== s) return
        socket = null
        pendingSnapshot = null
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
      // 重附着需要新票据：先清一次性的旧票据计时器（若有）
      retryTimer = env.setTimer(() => {
        retryTimer = null
        if (!disposed) openSocket()
      }, REATTACH_BACKOFF_MS * attempts)
    }

    function dispose() {
      if (disposed) return
      // U2.4：销毁前尽力补发一张最新快照（刷新恢复的最后一拍），失败不阻塞销毁
      if (socket !== null && socket.readyState === 1) {
        try { captureSnapshot() } catch { /* noop */ }
      }
      disposed = true
      if (retryTimer !== null) { env.clearTimer(retryTimer); retryTimer = null }
      if (ticketTimer !== null) { env.clearTimer(ticketTimer); ticketTimer = null }
      if (snapshotTimer !== null) { env.clearTimer(snapshotTimer); snapshotTimer = null }
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

    // ------------------------------------------------------------------ viewer-side extras (U1/U2)

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

    /**
     * 缓冲区快照（文本）：**末尾连续空行先跳过**，再从最后一个非空行往前取至多
     * `lines` 行。只读——「送往对话」（A0）靠它把终端现场交给 Agent。
     */
    function snapshot(lines = 40) {
      if (disposed) return ''
      const buf = term.buffer.active
      const count = clampDim(lines, [1, 500], 40)
      const textAt = y => {
        const line = buf.getLine(y)
        return line === null ? '' : line.translateToString(true)
      }
      let end = buf.length - 1
      while (end >= 0 && textAt(end).trim().length === 0) end -= 1
      const out = []
      for (let y = Math.max(0, end - count + 1); y <= end; y += 1) out.push(textAt(y))
      return out.join('\n')
    }

    /** Direct input write (used by the paste-confirm path, bypasses term.onData). */
    function input(data) {
      const s = socket
      if (typeof data === 'string' && s !== null && s.readyState === 1) s.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'input', shellId, data }))
    }

    /** U2.1：请求新 shell channel（服务端把本查看器切过去并授予写权）。 */
    function openShell(colsRows = {}) {
      send({ type: 'shell.open', cols: colsRows.cols, rows: colsRows.rows })
    }

    /** U2.1：显式接管写入权（决策 2）。 */
    function takeover() {
      if (shellId !== null) send({ type: 'shell.takeover', shellId })
    }

    /** U2.1：关闭当前 shell channel（连接保留；仅写入 owner 的请求会被服务端接受）。 */
    function closeShell() {
      if (shellId !== null) send({ type: 'shell.close', shellId })
    }

    function isWriteOwner() { return mode === 'write' }
    function currentShellId() { return shellId }

    function size() {
      return { cols: term.cols, rows: term.rows }
    }

    openSocket()

    return {
      connId: conn.id, term, fit, dispose,
      applyTheme, setFontSize, fontSize, find, clearLocal, input, size, snapshot,
      openShell, takeover, closeShell, isWriteOwner, currentShellId,
    }
  }

  const api = { create: createTermSession, MAX_REATTACH, REATTACH_BACKOFF_MS }
  if (typeof window !== 'undefined') window.SshTermSession = api
  else globalThis.SshTermSession = api
})()
