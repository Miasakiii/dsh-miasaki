window.__ModuleLoader__.load({
  id: '@miasaki/dsh-sidebar',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')

    // 自研右栏壳已于 2026-09-10 退役、2026-09-11 完成**第二阶段清理**：推挤 /
    // 抽屉手势 / 自研 tab 栏 / 空态选择页 / 桌面壳让位全部删除，只保留内容层
    // （审查 UI、终端启动器、popover）与官方右栏 tab 类型注册。
    // 见 design/2026-09-10-migrate-to-official-rightbar.md §3。

    // Popover 层级：低于 canvas 的全屏浮层（z-index 100）—— 画布盖住右栏是预期行为。
    const PANEL_Z = 60
    // 审查视图的持久化键。官方右栏不持久化 tab 状态，且 `tabActions` 只有
    // openResource / openTab / close —— **没有**「更新当前 tab 参数」的通道，
    // `navigation.params` 只在打开时写入。故视图选择由本插件自管，
    // 语义降级为「上次查看的视图」（全局单值，跨 tab 与刷新保留）。
    const REVIEW_VIEW_KEY = 'miasaki-sidebar:review-view'

    // --- 审查视图（原 tab 模型仅剩这一项） --------------------------------
    const REVIEW_VIEWS = ['unstaged', 'staged', 'all', 'last']
    const REVIEW_VIEW_LABELS = { unstaged: '未暂存', staged: '已暂存', all: '全部分支更改', last: '上一轮更改' }
    const REVIEW_DEFAULT_VIEW = 'unstaged'

    // 审查视图的共享存储：模块级 + useSyncExternalStore（DSH React 18.3.1，与 canvas
    // 的切换器 store 同构）。所有审查 tab 实例看到同一个值，切走再回来与刷新页面都保留。
    // 退役前它是「每个 tab 实例各记一个视图」；官方右栏下 tab id 由框架生成且刷新即变，
    // 按 id 记录没有意义，故降级为全局单值。
    const readStoredReviewView = () => {
      try {
        const raw = localStorage.getItem(REVIEW_VIEW_KEY)
        return REVIEW_VIEWS.includes(raw) ? raw : REVIEW_DEFAULT_VIEW
      } catch { return REVIEW_DEFAULT_VIEW }
    }
    const reviewView = {
      value: readStoredReviewView(),
      listeners: new Set(),
      get: () => reviewView.value,
      subscribe(listener) {
        reviewView.listeners.add(listener)
        return () => reviewView.listeners.delete(listener)
      },
      set(view) {
        if (!REVIEW_VIEWS.includes(view) || view === reviewView.value) return
        reviewView.value = view
        try { localStorage.setItem(REVIEW_VIEW_KEY, view) } catch { /* 私有模式：仅内存生效 */ }
        for (const listener of reviewView.listeners) listener()
      },
    }

    // Module-level store for the content layer. The shell's fields (open / width /
    // tabs / active / dragging / drawerOffset / chromeReserve / titlebarVisible /
    // viewport / sessionId) retired with the shell on 2026-09-11.
    const store = {
      state: {
        reviewCwd: null,
        // Page-visibility gate: a hidden document must not keep polling the host.
        // The official `tab.visible` covers the tab's own visibility; this covers
        // the window's, and ReviewTab ANDs the two.
        pageVisible: typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
      },
      listeners: new Set(),
      get: () => store.state,
      set(patch) {
        store.state = { ...store.state, ...patch }
        for (const listener of store.listeners) listener()
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
    }

    // --- 内嵌终端控制器（2026-09-19 多标签：会话集合 + 每容器活动标签）------
    // host 的 TerminalHub.sessions 是唯一事实源；这里是它的前端镜像。
    // 每个「viewer」= 一个 xterm 实例 + 一条 WS，**绑定一个 sessionId**：输出 /
    // 输入 / 尺寸都按 sessionId 隔离（host 定向广播），多标签不串台。
    // 两个容器（底部面板 / 右栏 tab）共享会话集合，各自记住自己的活动标签——
    // 同一 sessionId 在两个容器同时显示，即 2026-09-12 §6 的「同一个终端移位」。
    const TERMINAL_LIMIT = 8
    // 官方右栏服务句柄：ctx 只有 apply(ctx) 才拿得到，而下面的 terminalTabs 定义在
    // apply 之前，故用模块级占位、apply 时赋值（软依赖：宿主没这个服务就是 null）。
    let sidebarRightService = null
    // 每容器记住自己的活动标签（sessionStorage：刷新保留、关标签页即忘，
    // 与 ssh 线 U2.3 工作区快照同档）。
    const TERMINAL_ACTIVE_KEY = 'miasaki-sidebar:terminal-active'
    // 标签标题是**前端记忆**（host 不管标题）：按 sessionId 存，避免同名
    // shell 多开时无法区分。
    const TERMINAL_TITLES_KEY = 'miasaki-sidebar:terminal-titles'

    const readStoredActive = () => {
      try {
        const raw = sessionStorage.getItem(TERMINAL_ACTIVE_KEY)
        const parsed = raw === null ? {} : JSON.parse(raw)
        const pick = value => (typeof value === 'string' && value !== '' ? value : null)
        return { bottom: pick(parsed.bottom), right: pick(parsed.right) }
      } catch { return { bottom: null, right: null } }
    }
    const readStoredTitles = () => {
      try {
        const raw = sessionStorage.getItem(TERMINAL_TITLES_KEY)
        const parsed = raw === null ? {} : JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch { return {} }
    }
    const writeStoredTitle = (sid, title) => {
      try {
        const titles = readStoredTitles()
        titles[sid] = title
        sessionStorage.setItem(TERMINAL_TITLES_KEY, JSON.stringify(titles))
      } catch { /* 隐私模式：仅内存生效 */ }
    }

    // 重命名进行中时不重建标签栏——否则输入框会被 emit 触发的重渲染抹掉。
    let renamingSid = null

    const terminalClient = {
      sessions: new Map(), // sid → { id, shell, bin, pid, cwd, title, live, exited, exitCode, error, pending? }
      order: [], // sid，标签顺序（新建追加）
      active: readStoredActive(), // { bottom, right } 每容器独立
      lastError: '', // 全局错误（token 签发失败 / 协议不匹配）
      wantedShell: null, // **新建标签的默认 shell**（懒探测一次）
      shellProbed: false,
      shells: null, // options 探测结果（label 映射用）
      limit: TERMINAL_LIMIT,
      restartRequest: new Map(), // sid → shell：激活该标签时 attach 带 restart
      listeners: new Set(),
      assetsPromise: null,
      viewers: new Map(), // sid → Set<viewer>

      // useSyncExternalStore 的 getSnapshot 必须返回**缓存引用**：每次构造新
      // 对象会让 React 18 判定快照永不稳定 → 无限重渲染 → 抛错卸载整个 tab
      // 子树（2026-09-12 实机「终端空白」的根因——审查 tab 的 store 都返回
      // 稳定值所以无恙）。快照只在 emit() 时重建一次。
      _snapshot: { tabs: [], active: { bottom: null, right: null }, limit: TERMINAL_LIMIT, lastError: '' },
      get snapshot() { return terminalClient._snapshot },
      subscribe(listener) { terminalClient.listeners.add(listener); return () => terminalClient.listeners.delete(listener) },
      emit() {
        terminalClient._snapshot = {
          tabs: terminalClient.order
            .map(sid => terminalClient.sessions.get(sid))
            .filter(session => session !== undefined)
            .map(session => ({ ...session })),
          active: { ...terminalClient.active },
          limit: terminalClient.limit,
          lastError: terminalClient.lastError,
        }
        for (const listener of terminalClient.listeners) listener()
        // 命令式标签栏不经过 React：在这里统一重绘（重命名进行中除外）。
        renderAllTabs()
      },

      get(sid) { return terminalClient.sessions.get(sid) ?? null },

      /** shell id → 可读名（options 探测结果优先，未知时回退 id 本身）。 */
      shellLabel(shellId) {
        const shell = (terminalClient.shells ?? []).find(entry => entry.id === shellId)
        return shell?.label ?? (shellId ?? '终端')
      },

      /** 同名标签追加序号（PowerShell 7 → PowerShell 7 (2)）。 */
      uniqueTitle(base, excludeSid = null) {
        const taken = new Set()
        for (const sid of terminalClient.order) {
          if (sid === excludeSid) continue
          const session = terminalClient.sessions.get(sid)
          if (session !== undefined) taken.add(session.title)
        }
        let title = base
        let n = 2
        while (taken.has(title)) { title = `${base} (${n})`; n++ }
        return title
      },

      /** xterm UMD 三件套经 host 路由懒加载（设计 §4.5 T4：首次展开才拉取）。 */
      ensureAssets() {
        if (terminalClient.assetsPromise !== null) return terminalClient.assetsPromise
        terminalClient.assetsPromise = new Promise((resolvePromise, reject) => {
          if (typeof window.Terminal !== 'undefined' && typeof window.FitAddon !== 'undefined') { resolvePromise(); return }
          const fail = () => { terminalClient.assetsPromise = null; reject(new Error('内嵌终端组件加载失败（host 资产不可达或缺失）')) }
          const css = document.createElement('link')
          css.rel = 'stylesheet'; css.href = '/sidebar/asset/terminal/xterm.css'
          document.head.append(css)
          const loadFit = () => {
            const fit = document.createElement('script')
            fit.src = '/sidebar/asset/terminal/addon-fit.js'
            fit.onload = () => resolvePromise()
            fit.onerror = fail
            document.head.append(fit)
          }
          const main = document.createElement('script')
          main.src = '/sidebar/asset/terminal/xterm.js'
          main.onload = loadFit
          main.onerror = fail
          document.head.append(main)
        })
        return terminalClient.assetsPromise
      },

      /** xterm 配色从 --dsw-* 令牌实时读取（T5：三主题正确，不自带第二套色）。 */
      theme() {
        const computed = getComputedStyle(document.body)
        const v = name => {
          const value = computed.getPropertyValue(name).trim()
          return value === '' ? undefined : value
        }
        return {
          background: v('--dsw-alias-bg-layer-1') ?? '#ffffff',
          foreground: v('--dsw-alias-label-primary') ?? '#111827',
          cursor: v('--dsw-static-deepseek-450') ?? '#9bb8ff',
          cursorAccent: v('--dsw-alias-bg-layer-1') ?? '#ffffff',
          selectionBackground: v('--dsw-static-deepseek-450') ?? '#9bb8ff',
        }
      },

      /** 首次需要时向 host 探测一次 PTY shell 的可用性（复用启动器 options，过滤掉容器型 wt）。 */
      async ensureShellPicked() {
        if (terminalClient.shellProbed) return
        terminalClient.shellProbed = true
        try {
          const res = await fetch('/sidebar/api/terminal/options')
          if (!res.ok) return
          const data = await res.json()
          const list = data.shells ?? []
          const ptyCapable = list.filter(shell => shell.available && shell.id !== 'wt')
          terminalClient.shells = list
          terminalClient.wantedShell = data.fallback !== null && ptyCapable.some(shell => shell.id === data.fallback)
            ? data.fallback
            : (ptyCapable[0]?.id ?? null)
          terminalClient.emit()
        } catch { /* 探测失败保持 null——attach 会被 host 拒绝并显示错误 */ }
      },

      persistActive() {
        try { sessionStorage.setItem(TERMINAL_ACTIVE_KEY, JSON.stringify(terminalClient.active)) } catch { /* 隐私模式：仅内存 */ }
      },

      /**
       * 从 host 拉会话清单（刷新恢复 / 孤儿收口）。host 侧 pty 只要进程还在就
       * 仍然活着，客户端刷新后靠这份清单把标签栏补回来——否则那些 pty 永远
       * 没有入口可关。
       */
      async refreshFromHost() {
        let data = null
        try {
          const res = await fetch('/sidebar/api/terminal/session')
          if (!res.ok) return
          data = await res.json()
        } catch { return } // host 不可达：保持空态，不报错刷屏
        if (typeof data.limit === 'number') terminalClient.limit = data.limit
        const items = Array.isArray(data.sessions) ? data.sessions : []
        const titles = readStoredTitles()
        for (const item of items) {
          if (terminalClient.sessions.has(item.id)) continue
          terminalClient.sessions.set(item.id, {
            id: item.id,
            shell: item.shell,
            bin: item.bin,
            pid: item.pid,
            cwd: item.cwd,
            title: terminalClient.uniqueTitle(titles[item.id] ?? terminalClient.shellLabel(item.shell)),
            live: item.state === 'running',
            exited: item.state === 'exited',
            exitCode: item.exitCode ?? null,
            error: '',
          })
          terminalClient.order.push(item.id)
        }
        terminalClient.emit()
      },

      /**
       * 一个 viewer = 一个 xterm 实例 + 一条 WS，**绑定一个 sessionId**。
       * `sessionId: null` = 让 host 新建会话（ready 帧带回真 id）。
       * 返回 detach()；pty 在 host 侧保活（§4.3），viewer 消失只是关连接，
       * 重连凭回放补齐。
       */
      async attachViewer(el, options = {}) {
        await terminalClient.ensureAssets()
        const computed = getComputedStyle(document.body)
        const term = new window.Terminal({
          // canvas 量宽不能用 CSS 变量，读令牌的 computed 值（--ds-font-family-code 挂在 body）。
          fontFamily: computed.getPropertyValue('--ds-font-family-code').trim() || 'Consolas, monospace',
          fontSize: 12,
          cursorBlink: true,
          scrollback: 5000,
          theme: terminalClient.theme(),
        })
        const fit = new window.FitAddon.FitAddon()
        term.loadAddon(fit)
        term.open(el)
        try { fit.fit() } catch { /* 容器尚未布局时忽略，ResizeObserver 会再触发 */ }
        const viewer = {
          el, term, fit,
          sid: options.sessionId ?? null, // null = host 新建
          pendingId: options.pendingId ?? null, // 新建标签的临时 id
          container: options.container ?? null,
          ws: null,
          reconnectTimer: null,
          disposed: false,
          dropped: false, // 会话已关 / 插件卸载：不再重连
          awaitingRestart: false, // 已发出 restart attach：ready 时清屏
        }
        // pane 需要持有 viewer（激活时 fit + 发 resize 帧）。
        if (typeof options.onViewer === 'function') {
          try { options.onViewer(viewer) } catch { /* noop */ }
        }
        viewer.sendFrame = frame => {
          if (viewer.ws !== null && viewer.ws.readyState === 1) viewer.ws.send(JSON.stringify({ v: 2, ...frame }))
        }
        // 隐藏 pane（display:none）会把尺寸报成 0：那既不是真实尺寸，也不能发给
        // pty（否则一隐藏就把 pty 压成 0 列）。零尺寸直接跳过，激活时再 fit。
        viewer.onResize = new ResizeObserver(() => {
          if (viewer.disposed) return
          if (el.clientWidth === 0 || el.clientHeight === 0) return
          try { fit.fit() } catch { /* 容器尚未布局时忽略 */ }
          viewer.sendFrame({ type: 'resize', sessionId: viewer.sid, cols: term.cols, rows: term.rows })
        })
        viewer.onResize.observe(el)
        term.onData(data => viewer.sendFrame({ type: 'input', sessionId: viewer.sid, data }))
        terminalClient.trackViewer(viewer)
        terminalClient.connectViewer(viewer)
        return () => terminalClient.detachViewer(viewer)
      },

      trackViewer(viewer) {
        const key = viewer.sid ?? viewer.pendingId
        if (key === null || key === undefined) return
        let set = terminalClient.viewers.get(key)
        if (set === undefined) { set = new Set(); terminalClient.viewers.set(key, set) }
        set.add(viewer)
      },

      untrackViewer(viewer) {
        for (const set of terminalClient.viewers.values()) set.delete(viewer)
      },

      detachViewer(viewer) {
        if (viewer.disposed) return
        viewer.disposed = true
        viewer.onResize.disconnect()
        if (viewer.reconnectTimer !== null) clearTimeout(viewer.reconnectTimer)
        viewer.reconnectTimer = null
        if (viewer.ws !== null) { try { viewer.ws.close() } catch { /* noop */ } }
        terminalClient.untrackViewer(viewer)
        try { viewer.term.dispose() } catch { /* noop */ }
      },

      /** 任一绑定该会话且可写的 viewer（发 input/close/restart 帧用）。 */
      findViewer(sid) {
        const set = terminalClient.viewers.get(sid)
        if (set === undefined) return null
        for (const viewer of set) {
          if (!viewer.disposed && viewer.ws !== null && viewer.ws.readyState === 1) return viewer
        }
        return null
      },

      /** ready 时的真 id 落位：临时 id → 真 sessionId，同步标签顺序与 pane 键。 */
      adoptPending(tmpId, sessionId, msg) {
        if (tmpId === null || sessionId === null) return
        const index = terminalClient.order.indexOf(tmpId)
        if (index >= 0) terminalClient.order.splice(index, 1, sessionId)
        terminalClient.sessions.delete(tmpId)
        const set = terminalClient.viewers.get(tmpId)
        if (set !== undefined) {
          terminalClient.viewers.delete(tmpId)
          terminalClient.viewers.set(sessionId, set)
        }
        for (const key of ['bottom', 'right']) {
          if (terminalClient.active[key] === tmpId) terminalClient.active[key] = sessionId
        }
        for (const inst of terminalTabs.instances.values()) {
          const pane = inst.panes.get(tmpId)
          if (pane !== undefined) {
            inst.panes.delete(tmpId)
            pane.sid = sessionId
            pane.el.dataset.sid = sessionId
            inst.panes.set(sessionId, pane)
          }
        }
        terminalClient.sessions.set(sessionId, {
          id: sessionId,
          shell: msg.shell,
          bin: msg.bin,
          pid: msg.pid,
          cwd: msg.cwd,
          title: terminalClient.uniqueTitle(terminalClient.shellLabel(msg.shell)),
          live: true,
          exited: false,
          exitCode: null,
          error: '',
        })
        terminalClient.persistActive()
        terminalClient.emit()
      },

      /** ready 帧落地（重连 / 恢复时会话可能本地还没有）。 */
      upsertSession(sessionId, msg) {
        if (sessionId === null) return
        const existing = terminalClient.sessions.get(sessionId)
        if (existing === undefined) {
          terminalClient.sessions.set(sessionId, {
            id: sessionId,
            shell: msg.shell,
            bin: msg.bin,
            pid: msg.pid,
            cwd: msg.cwd,
            title: terminalClient.uniqueTitle(terminalClient.shellLabel(msg.shell)),
            live: true,
            exited: false,
            exitCode: null,
            error: '',
          })
          terminalClient.order.push(sessionId)
          return
        }
        existing.shell = msg.shell
        existing.bin = msg.bin
        existing.pid = msg.pid
        existing.cwd = msg.cwd
        if (existing.pending === true) delete existing.pending
        existing.live = true
        existing.exited = false
        existing.exitCode = null
        existing.error = ''
      },

      /** host 说这个会话没了（我们关的 / 被关的）：摘标签、拆 pane、修活动项。 */
      removeTab(sessionId) {
        if (sessionId === null || sessionId === undefined) return
        for (const inst of terminalTabs.instances.values()) dropPane(inst, sessionId)
        const viewers = terminalClient.viewers.get(sessionId)
        if (viewers !== undefined) {
          for (const viewer of [...viewers]) { viewer.dropped = true; terminalClient.detachViewer(viewer) }
          terminalClient.viewers.delete(sessionId)
        }
        terminalClient.sessions.delete(sessionId)
        terminalClient.order = terminalClient.order.filter(sid => sid !== sessionId)
        for (const key of ['bottom', 'right']) {
          if (terminalClient.active[key] !== sessionId) continue
          terminalClient.active[key] = terminalClient.order[0] ?? null
        }
        terminalClient.persistActive()
        terminalClient.emit()
        for (const inst of terminalTabs.instances.values()) renderPanes(inst)
      },

      /** 关闭标签 = 结束这个 shell（本地终端没有「保留会话」的入口，§7.1）。 */
      closeTab(sessionId) {
        const session = terminalClient.get(sessionId)
        if (session === null) return
        const viewer = terminalClient.findViewer(sessionId)
        if (viewer !== null) {
          viewer.sendFrame({ type: 'close', sessionId })
          return
        }
        // 没有 viewer（该标签尚未激活）：HTTP 兜底，成功后本地同步摘掉。
        fetch('/sidebar/api/terminal/close', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
          .then(res => res.json())
          .then(data => { if (data.closed === true) terminalClient.removeTab(sessionId) })
          .catch(() => {})
      },

      /** [重启] / 换 shell：kill 后按（可能新的）shell 重 spawn，标签不变。 */
      restartTab(sessionId, shellId) {
        const session = terminalClient.get(sessionId)
        if (session === null || session.pending === true) return
        const shell = shellId ?? session.shell
        const viewer = terminalClient.findViewer(sessionId)
        if (viewer !== null) {
          viewer.awaitingRestart = true
          viewer.sendFrame({
            type: 'attach',
            sessionId,
            shell,
            cwd: store.get().reviewCwd ?? session.cwd,
            cols: viewer.term.cols,
            rows: viewer.term.rows,
            restart: true,
          })
          return
        }
        // 会话还没有 viewer（标签未激活）：记下请求，激活后 attach 帧带上 restart。
        terminalClient.restartRequest.set(sessionId, shell)
        const inst = terminalTabs.instanceOf(sessionId)
        if (inst !== null) activate(inst, sessionId)
      },

      /** 重命名：空串回退默认名，仅前端记忆。 */
      renameTab(sessionId, title) {
        const session = terminalClient.get(sessionId)
        if (session === null || session.pending === true) return
        const trimmed = title.trim().slice(0, 40)
        session.title = trimmed === '' ? terminalClient.shellLabel(session.shell) : trimmed
        writeStoredTitle(sessionId, session.title)
        terminalClient.emit()
      },

      /** 新建标签：先落一个临时项（标签栏立刻可见），ready 时换成真 id。 */
      createTab(shellId = null) {
        if (terminalClient.order.length >= terminalClient.limit) return null
        const shell = shellId ?? terminalClient.wantedShell
        const tmpId = `tmp-${Date.now().toString(36)}-${terminalClient.order.length}`
        terminalClient.sessions.set(tmpId, {
          id: tmpId, pending: true, shell, bin: null, pid: null, cwd: store.get().reviewCwd ?? '',
          title: '新终端…', live: false, exited: false, exitCode: null, error: '',
        })
        terminalClient.order.push(tmpId)
        return tmpId
      },

      async connectViewer(viewer) {
        if (viewer.disposed) return
        if (viewer.ws !== null && (viewer.ws.readyState === 0 || viewer.ws.readyState === 1)) return
        terminalClient.lastError = ''
        terminalClient.emit()
        await terminalClient.ensureShellPicked()
        const stored = terminalClient.get(viewer.sid)
        const cwd = store.get().reviewCwd ?? stored?.cwd ?? ''
        if (cwd === '') {
          terminalClient.lastError = '当前会话没有工作区——打开一个带工作区的会话后再新建终端'
          terminalClient.emit()
          return
        }
        let token
        try {
          const res = await fetch('/sidebar/api/terminal/token', { method: 'POST' })
          if (!res.ok) throw new Error('token 签发失败 ' + res.status)
          token = (await res.json()).token
        } catch (error) {
          terminalClient.lastError = error instanceof TypeError
            ? '无法连接 DSH host——请确认 dsh web 正在运行。'
            : (error instanceof Error ? error.message : String(error))
          terminalClient.emit()
          return
        }
        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        const ws = new WebSocket(`${proto}://${location.host}/sidebar/ws/terminal?token=${encodeURIComponent(token)}`)
        viewer.ws = ws
        ws.onopen = () => {
          if (viewer.disposed) return
          // 新建标签时以**待建会话自己的 shell** 为准（`＋` 右键选过的 shell 就在
          // 那个临时项上）；没有临时项才回落到全局默认。漏掉这一步会让「新建：
          // Windows PowerShell」静默变成默认 shell。
          const pending = viewer.pendingId === null ? null : terminalClient.get(viewer.pendingId)
          // 激活该标签时顺带请求重启（该会话此前没有 viewer 可发帧）。
          const requested = viewer.sid !== null ? terminalClient.restartRequest.get(viewer.sid) : undefined
          if (requested !== undefined) terminalClient.restartRequest.delete(viewer.sid)
          viewer.sendFrame({
            type: 'attach',
            sessionId: viewer.sid, // null = 让 host 新建
            shell: requested ?? pending?.shell ?? terminalClient.wantedShell,
            cwd: store.get().reviewCwd ?? stored?.cwd ?? '',
            cols: viewer.term.cols,
            rows: viewer.term.rows,
            restart: viewer.pendingRestart || requested !== undefined || undefined,
          })
          viewer.pendingRestart = false
        }
        ws.onmessage = event => {
          let msg
          try { msg = JSON.parse(String(event.data)) } catch { return }
          if (msg.v !== 2) return // 本 bundle 只讲 v2
          // 输出按 sessionId 隔离：绝不把别的内容写进本 xterm。
          if (viewer.sid !== null && msg.sessionId !== viewer.sid) return
          if (msg.type === 'output' || msg.type === 'replay') {
            viewer.term.write(msg.data)
          } else if (msg.type === 'ready') {
            if (viewer.awaitingRestart === true) {
              viewer.awaitingRestart = false
              viewer.term.reset() // restart 的旧输出不该留在屏上
            }
            if (viewer.pendingId !== null) {
              terminalClient.adoptPending(viewer.pendingId, msg.sessionId, msg)
              viewer.pendingId = null
            } else {
              terminalClient.upsertSession(msg.sessionId, msg)
            }
            viewer.sid = msg.sessionId
            terminalClient.trackViewer(viewer)
            terminalClient.emit()
          } else if (msg.type === 'status' && msg.state === 'exited') {
            const session = terminalClient.get(msg.sessionId)
            if (session !== null) {
              session.live = false
              session.exited = true
              session.exitCode = msg.code
            }
            terminalClient.emit()
          } else if (msg.type === 'closed') {
            terminalClient.removeTab(msg.sessionId)
          } else if (msg.type === 'error') {
            if (msg.code === 'VERSION_MISMATCH') {
              terminalClient.lastError = msg.message ?? '终端协议不匹配，请刷新页面'
              terminalClient.emit()
              return
            }
            const session = msg.sessionId === null || msg.sessionId === undefined ? null : terminalClient.get(msg.sessionId)
            if (session !== null) session.error = msg.message ?? '内嵌终端错误'
            else terminalClient.lastError = msg.message ?? '内嵌终端错误'
            terminalClient.emit()
          }
        }
        ws.onclose = () => {
          viewer.ws = null
          terminalClient.emit()
          // pty 在 host 侧保活（设计 §4.3）：断线只重连取回放，绝不因 viewer
          // 消失杀会话；会话被显式关闭时 dropped 已置位，不再重连。
          // 固定 1.5s 退避，避免风暴。
          if (!viewer.disposed && !viewer.dropped && viewer.reconnectTimer === null) {
            viewer.reconnectTimer = setTimeout(() => {
              viewer.reconnectTimer = null
              terminalClient.connectViewer(viewer)
            }, 1500)
          }
        }
        ws.onerror = () => { /* close 事件随后到，统一在那里处理 */ }
      },

      /** 关掉所有终端（菜单「关闭全部」）：每个会话各自走 closeTab。 */
      closeAllTabs() {
        for (const sid of [...terminalClient.order]) terminalClient.closeTab(sid)
      },
    }

    // --- 标签栏 + pane 栈（底部面板与右栏 tab 共用的命令式 DOM）----------
    // 一个容器 = 一个实例：tabHost 挂标签栏、paneHost 挂 xterm pane 栈。
    // 会话集合共享（terminalClient.sessions），活动标签各记各的（§4.2）：
    // 同一 sessionId 被两个容器同时打开，就是「同一个终端的两个 viewer」。
    const terminalTabs = {
      instances: new Map(), // id → inst。id 唯一：同一 kind 可挂多个实例（如右栏分栏/浮窗）
      seq: 0,

      /**
       * 挂载一个容器；返回卸载函数。**实例 id 唯一**（`kind#N`），不再按 kind 键控 ——
       * 否则右栏里开出第二个终端标签页时，第二次 mount 会把第一个实例顶掉
       * （`unmount` 清空它的标签栏并销毁它的 xterm/WS，那个标签页直接白掉）。
       * 活动标签仍按 kind 记（`active.bottom` / `active.right`），同类实例共享同一活动项。
       */
      mount(kind, tabHost, paneHost, options = {}) {
        const id = `${kind}#${++terminalTabs.seq}`
        const inst = {
          id, key: kind, tabHost, paneHost, panes: new Map(), emptyEl: null, fittedSid: null,
          // 右栏形态的「关闭整个 tab」由官方 tabActions 完成（原型 §2 的 ×）。
          onCloseContainer: options.onCloseContainer ?? null,
        }
        terminalTabs.instances.set(id, inst)
        const key = kind
        // 恢复 sessionStorage 记忆的活动标签；host 已关掉的落到第一个。
        if (terminalClient.active[key] !== null && terminalClient.get(terminalClient.active[key]) === null) {
          terminalClient.active[key] = null
        }
        if (terminalClient.active[key] === null && terminalClient.order.length > 0) {
          terminalClient.active[key] = terminalClient.order[0]
          terminalClient.persistActive()
        }
        renderTabs(inst)
        renderPanes(inst)
        // 刷新恢复：host 侧存活的 pty 在这里变成可见标签（否则它们没有入口可关）。
        terminalClient.refreshFromHost().then(() => {
          if (terminalTabs.instances.get(id) !== inst) return
          if (terminalClient.active[key] === null && terminalClient.order.length > 0) {
            terminalClient.active[key] = terminalClient.order[0]
            terminalClient.persistActive()
          }
          renderTabs(inst)
          renderPanes(inst)
          // 「点开终端就默认有一个终端」（2026-09-19 二次调整）：一个标签都没有、
          // 当前有工作区且未达上限时直接开一个，不停在空态。shell 探测是 spawn 的
          // 前提（null 会被 host 拒绝），故先 ensureShellPicked。
          if (options.autoOpen === false || terminalClient.order.length > 0) return
          const cwd = store.get().reviewCwd
          if (cwd === null || cwd === undefined) return
          terminalClient.ensureShellPicked().then(() => {
            if (terminalTabs.instances.get(id) !== inst) return
            if (terminalClient.order.length > 0 || terminalClient.wantedShell === null) return
            addTab(inst)
          })
        })
        return () => terminalTabs.unmount(id)
      },

      /** 卸载一个实例（按 id，不按 kind：同类实例各拆各的）。 */
      unmount(id) {
        const inst = terminalTabs.instances.get(id)
        if (inst === undefined) return
        for (const sid of [...inst.panes.keys()]) dropPane(inst, sid)
        removeEmpty(inst)
        inst.tabHost.textContent = ''
        inst.paneHost.textContent = ''
        terminalTabs.instances.delete(id)
      },

      /** 某个 kind 的主实例（底部面板 / 右栏第一个 tab；分栏出来的实例走自己的 DOM）。 */
      primaryOf(kind) {
        for (const inst of terminalTabs.instances.values()) if (inst.key === kind) return inst
        return null
      },

      hasKind(kind) { return terminalTabs.primaryOf(kind) !== null },

      /** 哪个容器正显示这个会话（restart 找不到 viewer 时用来激活它）。 */
      instanceOf(sessionId) {
        for (const inst of terminalTabs.instances.values()) {
          if (terminalClient.active[inst.key] === sessionId) return inst
        }
        return null
      },
    }

    function renderAllTabs() {
      if (renamingSid !== null) return // 重命名输入中：别把输入框抹掉
      for (const inst of terminalTabs.instances.values()) renderTabs(inst)
    }

    function iconButton(glyph, title, onClick) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'miasaki-term-btn'
      btn.textContent = glyph
      btn.title = title
      btn.setAttribute('aria-label', title)
      btn.addEventListener('click', onClick)
      return btn
    }

    function renderTabs(inst) {
      const host = inst.tabHost
      host.textContent = ''
      const bar = document.createElement('div')
      bar.className = 'miasaki-term-tabs'

      // 左标题：参考图的「终端 PowerShell」（终端 + 活动标签的 shell 名）。
      const activeSid = terminalClient.active[inst.key]
      const activeSession = activeSid === null ? null : terminalClient.get(activeSid)
      const title = document.createElement('span')
      title.className = 'miasaki-term-tabs-title'
      title.textContent = activeSession === null ? '终端' : `终端 · ${terminalClient.shellLabel(activeSession.shell)}`
      title.title = activeSession === null ? '' : `${activeSession.bin ?? ''} · ${activeSession.cwd}`
      bar.append(title)

      const strip = document.createElement('div')
      strip.className = 'miasaki-term-tabs-strip'
      strip.setAttribute('role', 'tablist')
      strip.setAttribute('aria-label', '终端标签')
      for (const sid of terminalClient.order) {
        const session = terminalClient.get(sid)
        if (session === undefined) continue
        strip.append(tabElement(inst, sid, session))
      }
      bar.append(strip)

      const addBtn = iconButton('＋', '新建终端标签（Ctrl+Shift+`）；右键选 shell / 开系统终端', () => addTab(inst))
      addBtn.addEventListener('contextmenu', event => { event.preventDefault(); openNewTabMenu(event.currentTarget, inst) })
      bar.append(addBtn)
      bar.append(iconButton('▾', '全部标签', event => { event.stopPropagation(); openTabListMenu(event.currentTarget, inst) }))
      // 右栏形态：整个 tab 归官方右栏管，× 经 tabActions 关掉它（原型 §2 最右那个 ×）；
      // 底部形态：× = 收起面板。
      if (inst.onCloseContainer !== null) {
        bar.append(iconButton('×', '关闭右栏终端 tab', inst.onCloseContainer))
      } else if (inst.key === 'bottom') {
        bar.append(iconButton('×', '收起底部终端面板（Ctrl+`）', () => bottomPanel.close()))
      }
      host.append(bar)
    }

    function tabElement(inst, sid, session) {
      const active = terminalClient.active[inst.key] === sid
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'miasaki-term-tab' + (active ? ' is-active' : '')
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(active))
      tab.setAttribute('aria-label', session.title)
      tab.tabIndex = active ? 0 : -1
      tab.dataset.sid = sid
      const tips = [session.title, `${terminalClient.shellLabel(session.shell)} · ${session.cwd}`]
      if (session.exited === true) tips.push('（进程已退出）')
      if (session.error !== '' && session.error !== undefined) tips.push(session.error)
      tab.title = tips.join('\n')

      if (session.exited === true) {
        const dot = document.createElement('span')
        dot.className = 'miasaki-term-tab-dot'
        tab.append(dot)
      }
      const label = document.createElement('span')
      label.className = 'miasaki-term-tab-label'
      label.textContent = session.pending === true ? '新终端…' : session.title
      tab.append(label)
      const close = document.createElement('span')
      close.className = 'miasaki-term-tab-close'
      close.textContent = '×'
      close.setAttribute('role', 'button')
      close.setAttribute('aria-label', '关闭 ' + session.title)
      close.title = '关闭此终端'
      close.addEventListener('click', event => { event.stopPropagation(); terminalClient.closeTab(sid) })
      tab.append(close)

      tab.addEventListener('click', () => { activate(inst, sid); focusActivePane(inst) })
      tab.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); terminalClient.closeTab(sid) } })
      tab.addEventListener('dblclick', event => { event.preventDefault(); startRename(inst, sid, tab) })
      tab.addEventListener('contextmenu', event => { event.preventDefault(); openTabMenu(event, inst, sid) })
      tab.addEventListener('keydown', event => onTabKeydown(event, inst, sid))
      return tab
    }

    function onTabKeydown(event, inst, sid) {
      if (event.key === 'Delete') { event.preventDefault(); terminalClient.closeTab(sid); return }
      if (event.key === 'F2') { event.preventDefault(); startRename(inst, sid, event.currentTarget); return }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        const list = terminalClient.order.filter(id => terminalClient.get(id) !== undefined)
        const index = list.indexOf(sid)
        const next = list[(index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length]
        if (next !== undefined) activate(inst, next)
        return
      }
      if (event.key === 'Home' && terminalClient.order.length > 0) { event.preventDefault(); activate(inst, terminalClient.order[0]) }
      if (event.key === 'End' && terminalClient.order.length > 0) {
        event.preventDefault()
        activate(inst, terminalClient.order[terminalClient.order.length - 1])
      }
    }

    function activate(inst, sid) {
      if (terminalClient.get(sid) === undefined) return
      if (terminalClient.active[inst.key] === sid) { focusActivePane(inst); return }
      terminalClient.active[inst.key] = sid
      terminalClient.persistActive()
      renderTabs(inst)
      renderPanes(inst)
    }

    function focusActivePane(inst) {
      const sid = terminalClient.active[inst.key]
      const pane = sid === null ? undefined : inst.panes.get(sid)
      if (pane === undefined) return
      try { pane.el.querySelector('textarea')?.focus() } catch { /* xterm 尚未就绪 */ }
    }

    function renderPanes(inst) {
      const activeSid = terminalClient.active[inst.key]
      for (const sid of [...inst.panes.keys()]) {
        if (terminalClient.order.includes(sid) === false) dropPane(inst, sid)
      }
      for (const sid of terminalClient.order) {
        const pane = inst.panes.get(sid)
        if (pane === undefined) continue
        pane.el.style.display = sid === activeSid ? 'block' : 'none'
      }
      if (activeSid === null || terminalClient.order.includes(activeSid) === false) { ensureEmpty(inst); return }
      removeEmpty(inst)
      if (inst.panes.has(activeSid) === false) ensurePane(inst, activeSid)
      // 只有「新激活」才 fit：隐藏过的 pane 需要一次真实尺寸，
      // 之后的尺寸变化交给 ResizeObserver。
      if (inst.fittedSid !== activeSid) {
        inst.fittedSid = activeSid
        const pane = inst.panes.get(activeSid)
        if (pane !== undefined) fitPane(pane)
      }
    }

    /** 懒挂载：第一次成为活动标签才建 xterm（8 个标签也不必一次建 8 个实例）。 */
    function ensurePane(inst, sid) {
      const session = terminalClient.get(sid)
      if (session === undefined || inst.panes.has(sid)) return
      const el = document.createElement('div')
      el.className = 'miasaki-term-pane'
      el.dataset.sid = sid
      el.style.display = 'block'
      inst.paneHost.append(el)
      const pane = { sid, el, viewer: null, detach: null }
      inst.panes.set(sid, pane)
      const creating = session.pending === true
      terminalClient.attachViewer(el, creating
        ? { sessionId: null, pendingId: sid, container: inst.key, onViewer: viewer => { pane.viewer = viewer } }
        : { sessionId: sid, container: inst.key, onViewer: viewer => { pane.viewer = viewer } })
        .then(detach => {
          if (inst.panes.get(sid) !== pane) { try { detach() } catch { /* noop */ } return }
          pane.detach = detach
          fitPane(pane)
        })
        .catch(error => {
          if (inst.panes.get(sid) !== pane) return
          el.textContent = error instanceof Error ? error.message : String(error)
          el.style.cssText += ';padding:12px;color:var(--dsw-alias-state-error-primary,#dc2626);font:var(--dsw-font-xxs-12,12px/18px system-ui)'
        })
    }

    function fitPane(pane) {
      // viewer 是异步挂上的（ensureAssets 之后才建 xterm）：null/undefined 都要放过。
      const viewer = pane.viewer
      if (viewer === null || viewer === undefined || viewer.disposed) return
      try { viewer.fit.fit() } catch { /* 布局未定：ResizeObserver 会再触发 */ }
      viewer.sendFrame({ type: 'resize', sessionId: viewer.sid, cols: viewer.term.cols, rows: viewer.term.rows })
    }

    function dropPane(inst, sid) {
      const pane = inst.panes.get(sid)
      if (pane === undefined) return
      inst.panes.delete(sid)
      if (inst.fittedSid === sid) inst.fittedSid = null
      if (pane.detach !== null) { try { pane.detach() } catch { /* noop */ } }
      pane.el.remove()
    }

    function ensureEmpty(inst) {
      if (inst.emptyEl !== null && inst.paneHost.contains(inst.emptyEl)) return
      const cwd = store.get().reviewCwd
      const el = document.createElement('div')
      el.className = 'miasaki-term-empty'
      const text = document.createElement('div')
      text.textContent = cwd === null || cwd === undefined
        ? '打开一个带工作区的会话后即可启动终端'
        : `当前没有终端标签 — 工作目录 ${cwd}`
      el.append(text)
      if (cwd !== null && cwd !== undefined) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = '＋ 新建终端（Ctrl+Shift+`）'
        btn.addEventListener('click', () => addTab(inst))
        el.append(btn)
      }
      inst.paneHost.append(el)
      inst.emptyEl = el
    }

    function removeEmpty(inst) {
      if (inst.emptyEl !== null) { inst.emptyEl.remove(); inst.emptyEl = null }
    }

    function addTab(inst, shellId = null) {
      if (inst === undefined) return
      const cwd = store.get().reviewCwd
      if (cwd === null || cwd === undefined) { terminalToast('打开一个带工作区的会话后即可新建终端'); return }
      if (terminalClient.order.length >= terminalClient.limit) {
        terminalToast(`终端标签已达上限 ${terminalClient.limit} 个，请先关闭一个再新建`)
        return
      }
      const tmpId = terminalClient.createTab(shellId)
      if (tmpId === null) return
      terminalClient.active[inst.key] = tmpId
      terminalClient.persistActive()
      renderTabs(inst)
      renderPanes(inst)
      focusActivePane(inst)
    }

    function startRename(inst, sid, tab) {
      const session = terminalClient.get(sid)
      if (session === undefined || session.pending === true) return
      const label = tab.querySelector('.miasaki-term-tab-label')
      if (label === null) return
      renamingSid = sid
      const input = document.createElement('input')
      input.className = 'miasaki-term-tab-input'
      input.value = session.title
      input.setAttribute('aria-label', '重命名终端标签')
      label.replaceWith(input)
      input.focus()
      input.select()
      let done = false
      const finish = commit => {
        if (done) return
        done = true
        renamingSid = null
        if (commit) terminalClient.renameTab(sid, input.value)
        renderAllTabs()
      }
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); finish(true) }
        else if (event.key === 'Escape') { event.preventDefault(); finish(false) }
      })
      input.addEventListener('blur', () => finish(true))
    }

    /** 轻量菜单：复用右栏 popover 样式，pointerdown 到外部即收。 */
    function termMenu(anchor, items) {
      document.querySelectorAll('.miasaki-term-menu').forEach(node => node.remove())
      const menu = document.createElement('div')
      menu.className = 'dsh-sidebar-popover miasaki-term-menu'
      for (const item of items) {
        if (item.sep === true) {
          const hr = document.createElement('div')
          hr.style.cssText = 'height:1px;margin:3px 4px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.08))'
          menu.append(hr)
          continue
        }
        if (item.note !== undefined) {
          const note = document.createElement('div')
          note.className = 'miasaki-term-menunote'
          note.textContent = item.note
          menu.append(note)
          continue
        }
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dsh-sidebar-menuitem'
        button.textContent = item.label
        if (item.disabled === true) button.disabled = true
        button.addEventListener('click', () => { menu.remove(); item.act() })
        menu.append(button)
      }
      document.body.append(menu)
      const rect = anchor.getBoundingClientRect()
      menu.style.top = `${Math.round(Math.max(6, Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4)))}px`
      menu.style.left = `${Math.round(Math.max(6, Math.min(window.innerWidth - menu.offsetWidth - 8, rect.left)))}px`
      setTimeout(() => {
        const dismiss = event => {
          if (event.target instanceof Node && (menu.contains(event.target) || anchor.contains(event.target))) return
          menu.remove()
          document.removeEventListener('pointerdown', dismiss, true)
        }
        document.addEventListener('pointerdown', dismiss, true)
      }, 0)
    }

    function closeOthers(inst, keep) {
      const others = terminalClient.order.filter(sid => sid !== keep)
      if (others.length === 0) return
      if (others.length > 1 && confirm(`关闭其他 ${others.length} 个终端标签？正在运行的进程会被结束。`) === false) return
      for (const sid of others) terminalClient.closeTab(sid)
      activate(inst, keep)
    }

    const confirmCloseAll = () => terminalClient.order.length <= 1
      || confirm(`关闭全部 ${terminalClient.order.length} 个终端标签？正在运行的进程会被结束。`)

    function openTabMenu(event, inst, sid) {
      const session = terminalClient.get(sid)
      if (session === undefined) return
      termMenu(event.currentTarget, [
        { label: '新建标签', act: () => addTab(inst) },
        { sep: true },
        { label: '重启（kill 后重新 spawn）', act: () => terminalClient.restartTab(sid) },
        { label: '重命名', act: () => startRename(inst, sid, event.currentTarget) },
        { label: '复制工作目录', act: () => { try { navigator.clipboard?.writeText(session.cwd) } catch { /* 无剪贴板权限时静默 */ } } },
        { sep: true },
        { label: '关闭此标签', act: () => terminalClient.closeTab(sid) },
        { label: '关闭其他标签', act: () => closeOthers(inst, sid) },
        { label: '关闭全部标签', act: () => { if (confirmCloseAll()) terminalClient.closeAllTabs() } },
        { sep: true },
        // 跨容器移位：会话集合共享，换容器只是换一个 viewer（原型 §7.1）。
        inst.key === 'right'
          ? { label: '在底部面板显示此终端', act: () => showInBottom(sid) }
          : { label: '在右栏显示此终端', act: () => showInRight(sid) },
      ])
    }

    /** 同一个 pty 交给底部面板显示（第二个 viewer）。 */
    function showInBottom(sid) {
      bottomPanel.show()
      const inst = terminalTabs.primaryOf('bottom')
      if (inst !== null) activate(inst, sid)
    }

    /** 同一个 pty 交给右栏 tab 显示：经官方 sidebarRight.openTab 打开 / 聚焦。 */
    function showInRight(sid) {
      const service = sidebarRightService
      if (service === null || typeof service.openTab !== 'function') {
        terminalToast('当前宿主版本不支持从底部面板打开右栏终端，请用官方「添加控件」')
        return
      }
      // 先记住活动项：右栏 tab 首次打开时 mount() 会读它，天然落在该会话上。
      terminalClient.active.right = sid
      terminalClient.persistActive()
      try { service.openTab('terminal') } catch {
        terminalToast('打开右栏终端失败：请用官方「添加控件」')
        return
      }
      // 已经开着就直接切活动项；首次打开则等 React effect 挂载后由 mount 承接。
      const inst = terminalTabs.primaryOf('right')
      if (inst !== null) activate(inst, sid)
    }

    /**
     * `＋` 的右键菜单：原「下半部分配置区」的两项能力收在这里 ——
     * ① 指定 shell 新建标签（对应参考图 `+` 旁的下拉）；② 在新窗口开系统终端。
     */
    function openNewTabMenu(anchor, inst) {
      const items = []
      const allShells = terminalClient.shells ?? []
      const ptyShells = allShells.filter(shell => shell.id !== 'wt')
      if (ptyShells.length === 0) {
        items.push({ note: '正在探测可用 shell…' })
      } else {
        for (const shell of ptyShells) {
          items.push({
            label: `新建：${shell.label}`,
            disabled: shell.available !== true,
            act: () => addTab(inst, shell.id),
          })
        }
      }
      items.push({ sep: true })
      // 外部系统终端：用 host 探测过的完整表（含容器型 wt 的可用性），不要本地硬编码。
      if (allShells.length === 0) items.push({ note: '正在探测系统终端…' })
      for (const shell of allShells) {
        items.push({
          label: `在新窗口打开：${shell.label}`,
          disabled: shell.available !== true,
          act: () => openExternalTerminal(shell.id),
        })
      }
      termMenu(anchor, items)
    }

    /** 原「外部系统终端（独立窗口）」：host 在会话 cwd spawn 一个真实终端窗口。 */
    function openExternalTerminal(shellId) {
      const cwd = store.get().reviewCwd
      if (cwd === null || cwd === undefined) { terminalToast('打开一个带工作区的会话后再启动系统终端'); return }
      fetch('/sidebar/api/terminal/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shell: shellId, cwd }),
      })
        .then(res => res.json())
        .then(data => { if (data?.bin !== undefined) terminalToast(`已启动 ${data.bin}`) })
        .catch(() => terminalToast('启动系统终端失败'))
    }

    function openTabListMenu(anchor, inst) {
      const items = []
      if (terminalClient.order.length === 0) items.push({ note: '暂无标签' })
      terminalClient.order.forEach((sid, index) => {
        const session = terminalClient.get(sid)
        if (session === undefined) return
        items.push({
          label: `${index + 1}. ${session.title}${session.exited === true ? '（已退出）' : ''} · ${terminalClient.shellLabel(session.shell)}`,
          act: () => activate(inst, sid),
        })
      })
      items.push({ sep: true })
      items.push({ label: '＋ 新建标签', act: () => addTab(inst) })
      if (terminalClient.order.length > 0) {
        items.push({ label: '关闭全部标签', act: () => { if (confirmCloseAll()) terminalClient.closeAllTabs() } })
      }
      termMenu(anchor, items)
    }

    /**
     * 活动标签的状态行：底部面板命令式渲染与右栏 React 渲染共用同一取数。
     * `visible` 只在**有话说**时为真（报错 / 已退出 / 工作区变更）——正常情况下
     * 终端是「标签栏 + 内容」的一整块，不额外分出一条状态栏（用户 2026-09-19 反馈）。
     * 常规信息（shell / pid / 会话数）进 tooltip 与标签栏标题，不占常驻行。
     */
    function terminalStatus(key) {
      const sid = terminalClient.active[key]
      const session = sid === null ? null : terminalClient.get(sid)
      if (session === null) {
        // 没有活动标签：空态本身已在 pane 里说明，只有硬错误才占一行。
        const text = terminalClient.lastError
        return { text, actions: [], visible: text !== '' }
      }
      const cwd = store.get().reviewCwd ?? ''
      const problems = []
      if (session.exited === true) problems.push(`已退出（code ${session.exitCode}）`)
      if (session.error !== '' && session.error !== undefined) problems.push(session.error)
      if (cwd !== '' && session.cwd !== cwd) problems.push(`会话工作区已变更（终端仍在 ${session.cwd}）`)
      if (terminalClient.lastError !== '') problems.push(terminalClient.lastError)
      const actions = []
      if (session.exited === true) actions.push({ label: '重启', act: () => terminalClient.restartTab(sid) })
      if (cwd !== '' && session.cwd !== cwd) actions.push({ label: '移到当前工作区', act: () => terminalClient.restartTab(sid) })
      const info = `${terminalClient.order.length}/${terminalClient.limit} 个会话 · ${terminalClient.shellLabel(session.shell)}`
      return {
        text: problems.length === 0 ? '' : [info, ...problems].join(' · '),
        actions,
        visible: problems.length > 0,
      }
    }

    let termToastTimer = null
    function terminalToast(message) {
      let box = document.getElementById('miasaki-term-toast')
      if (box === null) {
        box = document.createElement('div')
        box.id = 'miasaki-term-toast'
        box.className = 'miasaki-term-toast'
        document.body.append(box)
      }
      box.textContent = message
      box.style.display = 'block'
      if (termToastTimer !== null) clearTimeout(termToastTimer)
      termToastTimer = setTimeout(() => { box.style.display = 'none' }, 2600)
    }

    const bottomPanel = {
      el: null,
      open: false,
      height: 320,
      mounted: false, // 标签栏是否已挂载（首次展开才挂：不展开就不建 xterm）
      unmountTabs: null, // mount 返回的卸载函数（实例按 id 拆，不按 kind）
      tabHost: null,
      paneHost: null,
      statusEl: null, // 状态条容器（只在有话说时显示）
      statusText: null,
      statusActs: null,
      listeners: new Set(),
      pushInjected: false,
      subscribe(listener) { bottomPanel.listeners.add(listener); return () => bottomPanel.listeners.delete(listener) },
      emit() { for (const listener of bottomPanel.listeners) listener() },

      toggle() { bottomPanel.open ? bottomPanel.close() : bottomPanel.show() },
      show() {
        bottomPanel.ensureDom()
        bottomPanel.open = true
        bottomPanel.applyLayout()
        bottomPanel.emit()
        if (bottomPanel.mounted === false) {
          bottomPanel.mounted = true
          bottomPanel.unmountTabs = terminalTabs.mount('bottom', bottomPanel.tabHost, bottomPanel.paneHost)
        }
      },
      close() {
        // 只收起面板：pane / xterm / WS 全部保留（§4.3 保活），回来即见原样。
        bottomPanel.open = false
        bottomPanel.applyLayout()
        bottomPanel.emit()
      },
      /** 推挤能力检测（拍板记录 §6）：主内容容器命中才让位，否则纯浮层。 */
      applyLayout() {
        const el = bottomPanel.el
        if (el === null) return
        el.style.display = bottomPanel.open ? 'flex' : 'none'
        document.documentElement.style.setProperty('--miasaki-terminal-height', bottomPanel.open ? `${bottomPanel.height}px` : '0px')
      },
      ensureDom() {
        if (bottomPanel.el !== null && document.contains(bottomPanel.el)) return
        const el = document.createElement('div')
        el.id = 'miasaki-bottomterm'
        el.style.display = 'none'
        el.innerHTML = [
          '<div class="miasaki-bottomterm-grip" title="拖拽调整高度"></div>',
          '<div class="miasaki-bottomterm-tabbar"></div>',
          '<div class="miasaki-bottomterm-panes miasaki-term-panes"></div>',
          '<div class="miasaki-bottomterm-status"><span class="miasaki-bottomterm-statustext"></span><span class="miasaki-bottomterm-statusacts"></span></div>',
        ].join('')
        document.body.append(el)
        bottomPanel.el = el
        bottomPanel.tabHost = el.querySelector('.miasaki-bottomterm-tabbar')
        bottomPanel.paneHost = el.querySelector('.miasaki-bottomterm-panes')
        bottomPanel.statusEl = el.querySelector('.miasaki-bottomterm-status')
        bottomPanel.statusText = el.querySelector('.miasaki-bottomterm-statustext')
        bottomPanel.statusActs = el.querySelector('.miasaki-bottomterm-statusacts')
        // 高度拖拽：向上拖增高，180–80vh。
        const grip = el.querySelector('.miasaki-bottomterm-grip')
        grip.addEventListener('pointerdown', event => {
          event.preventDefault()
          grip.setPointerCapture(event.pointerId)
          const startY = event.clientY
          const startHeight = bottomPanel.height
          const onMove = moveEvent => {
            bottomPanel.height = Math.round(Math.min(window.innerHeight * 0.8, Math.max(180, startHeight + (startY - moveEvent.clientY))))
            bottomPanel.applyLayout()
          }
          const onUp = () => {
            grip.removeEventListener('pointermove', onMove)
            grip.removeEventListener('pointerup', onUp)
          }
          grip.addEventListener('pointermove', onMove)
          grip.addEventListener('pointerup', onUp)
        })
        // 状态条：只在「有话说」时占一行（报错 / 已退出 / 工作区变更），否则终端
        // 保持「标签栏 + 内容」的一整块（2026-09-19 三次调整）。
        const renderStatus = () => {
          const status = terminalStatus('bottom')
          const strip = bottomPanel.statusEl
          if (strip === null) return
          strip.style.display = status.visible ? 'flex' : 'none'
          if (!status.visible) return
          if (bottomPanel.statusText !== null) bottomPanel.statusText.textContent = status.text
          const acts = bottomPanel.statusActs
          if (acts === null) return
          acts.textContent = ''
          for (const action of status.actions) {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'miasaki-bottomterm-btn'
            btn.textContent = action.label
            btn.addEventListener('click', action.act)
            acts.append(btn)
          }
        }
        terminalClient.subscribe(renderStatus)
        store.subscribe(renderStatus)
        renderStatus()
      },
      dispose() {
        if (bottomPanel.unmountTabs !== null) {
          try { bottomPanel.unmountTabs() } catch { /* noop */ }
          bottomPanel.unmountTabs = null
        }
        bottomPanel.mounted = false
        bottomPanel.tabHost = null
        bottomPanel.paneHost = null
        bottomPanel.statusEl = null
        bottomPanel.statusText = null
        bottomPanel.statusActs = null
        if (bottomPanel.el !== null) {
          bottomPanel.el.remove()
          bottomPanel.el = null
        }
        document.documentElement.style.setProperty('--miasaki-terminal-height', '0px')
        bottomPanel.open = false
      },
    }

    // --- 标题栏终端按钮（桌面壳：#miasaki-titlebar 由 themes 注入）---------
    const titlebarButton = {
      observer: null,
      /**
       * 注入 / 维持标题栏终端按钮。拍板顺序（2026-09-12 第二次交换要求）：
       * [终端][其他注入按钮…][brand][窗控]——终端按钮置于 tb-group **最前**。
       * （第一次拍板是「紧贴 brand」，实测右栏开关同样插在 brand 紧前、落在
       * 终端右侧；用户要求终端放最左，故改为 group 首位。其它注入方都往
       * brand 紧前插，天然落在终端之后，互不争抢。）顺序已对时不动 DOM
       * （防 observer 自激循环）。
       */
      ensure() {
        const group = document.querySelector('#miasaki-titlebar .tb-group')
        if (group === null) return false
        let btn = document.getElementById('miasaki-tb-terminal')
        let freshlyCreated = false
        if (btn === null) {
          btn = document.createElement('div')
          btn.id = 'miasaki-tb-terminal'
          btn.className = 'tb-btn'
          btn.setAttribute('data-act', 'miasaki-terminal')
          btn.title = '切换终端 Ctrl+`'
          // 与截图一致的「终端 + 下拉」双热点：主区切换底部面板，箭头开菜单。
          btn.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true" style="width:11px;height:11px;display:block;fill:none;stroke:currentColor;stroke-width:1.1;stroke-linecap:round;stroke-linejoin:round"><path d="M1.5 2.5 L4 5 L1.5 7.5"/><line x1="5.5" y1="7.5" x2="8.5" y2="7.5"/></svg>'
          const caret = document.createElement('span')
          caret.textContent = '▾'
          caret.style.cssText = 'font-size:8px;line-height:1;margin-left:1px;opacity:.7'
          caret.addEventListener('click', event => {
            event.stopPropagation()
            titlebarButton.openMenu(caret)
          })
          btn.append(caret)
          btn.addEventListener('click', () => bottomPanel.toggle())
          freshlyCreated = true
        }
        const first = group.firstElementChild
        if (btn !== first) {
          if (first === null) group.append(btn)
          else group.insertBefore(btn, first)
        }
        // 多占一格按钮位：让位量同步放宽（03-switcher 的变量兜底 128 → +28）。
        if (freshlyCreated) document.documentElement.style.setProperty('--ms-titlebar-reserve', '156px')
        return true
      },
      stop() {
        if (titlebarButton.observer !== null) { titlebarButton.observer.disconnect(); titlebarButton.observer = null }
      },
      watch() {
        titlebarButton.ensure()
        // 常驻观察：其他注入方的按钮插到终端之前时把它重排回 group 首位
        //（ensure 内「顺序已对不动 DOM」的守卫保证不会自激）。
        if (titlebarButton.observer === null) {
          titlebarButton.observer = new MutationObserver(() => { titlebarButton.ensure() })
          titlebarButton.observer.observe(document.body, { childList: true, subtree: true })
        }
      },
      /** 轻量菜单（原生版 Popover）：shell 子项走外部启动器（wt/pwsh/…），内嵌入口两条。 */
      openMenu(anchor) {
        const existing = document.getElementById('miasaki-tb-term-menu')
        if (existing !== null) { existing.remove(); return }
        const cwd = store.get().reviewCwd
        const menu = document.createElement('div')
        menu.id = 'miasaki-tb-term-menu'
        menu.className = 'dsh-sidebar-popover'
        const rect = anchor.getBoundingClientRect()
        menu.style.cssText = `top:${Math.round(rect.bottom + 4)}px;right:${Math.round(Math.max(4, window.innerWidth - rect.right))}px;left:auto;`
        const items = [
          { label: '底部终端面板', act: () => bottomPanel.show() },
          { label: '新建终端标签（Ctrl+Shift+`）', act: () => { bottomPanel.show(); const inst = terminalTabs.primaryOf('bottom'); if (inst !== null) addTab(inst) } },
          { label: '右栏终端（新 tab）', disabled: true, note: '经官方「添加控件」打开' },
        ]
        if (cwd !== null && cwd !== undefined) {
          items.push({ sep: true })
          for (const shell of [
            { id: 'wt', label: '在新窗口：Windows Terminal' },
            { id: 'pwsh', label: '在新窗口：PowerShell 7' },
            { id: 'powershell', label: '在新窗口：Windows PowerShell' },
            { id: 'cmd', label: '在新窗口：命令提示符' },
          ]) {
            items.push({
              label: shell.label,
              disabled: cwd === null,
              act: () => {
                fetch('/sidebar/api/terminal/open', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ shell: shell.id, cwd }),
                }).catch(() => {})
              },
            })
          }
        }
        for (const item of items) {
          if (item.sep === true) {
            const hr = document.createElement('div')
            hr.style.cssText = 'height:1px;margin:3px 4px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.08))'
            menu.append(hr)
            continue
          }
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'dsh-sidebar-menuitem'
          button.textContent = item.label
          if (item.disabled === true) button.disabled = true
          button.addEventListener('click', () => { menu.remove(); item.act() })
          menu.append(button)
        }
        document.body.append(menu)
        setTimeout(() => {
          const dismiss = event => {
            if (event.target instanceof Node && (menu.contains(event.target) || anchor.contains(event.target))) return
            menu.remove()
            document.removeEventListener('pointerdown', dismiss, true)
          }
          document.addEventListener('pointerdown', dismiss, true)
        }, 0)
      },
      dispose() {
        titlebarButton.stop()
        document.getElementById('miasaki-tb-terminal')?.remove()
        document.getElementById('miasaki-tb-term-menu')?.remove()
        document.documentElement.style.removeProperty('--ms-titlebar-reserve')
      },
    }


    // 官方右栏引导页（「开始」标签页）按**函数**读取入口胶囊的文本字段：
    // GuideBody/EntryBox 里的调用是 `entry.title()` 与 `entry.description?.()`
    // （见 @deepseek-ai/dsh-client-ui-sidebar-right 的 lib/client.js）。
    // 传字符串会在渲染引导页时抛 TypeError，React 随即放弃整棵子树 ——
    // 右栏表现为**一片空白**（2026-09-10 实机现象，本线迁移后的默认打开页）。
    // 集中在此构造，test/rightbar-guide.test.js 抽取本函数求值，锁死这条契约。
    // 注：条目的 `kind` 由官方 refresh() 从 definition.kind 注入（`{...entry, kind}`），
    // 不在此重复；`order` 只用于排序，必须是数字。
    const rightBarGuideEntry = (title, description, order) => ({
      title: () => title,
      description: () => description,
      order,
    })

    module.exports.inject = ['slots', 'sessions', 'sidebarRightTabs']
    module.exports.apply = ctx => {
      // Idempotence guard: DSH HMR/page remount can re-run apply while the old
      // instance's DOM/listeners are still alive (canvas lesson).
      if (window.__DSH_SIDEBAR_BOOTED__) return
      window.__DSH_SIDEBAR_BOOTED__ = true

      // 官方右栏服务（软依赖，不进 inject）：只给「在右栏显示此终端」用，宿主没有
      // 这个服务时保持 null，由 showInRight 降级为提示（不阻塞其余功能）。
      sidebarRightService = typeof ctx.get === 'function' ? ctx.get('sidebarRight') ?? null : null

      const closeNativeDetails = () => {
        // One-way concession: opening the sidebar folds the native details
        // column so the two right-side consumers never squeeze the center
        // together (design §3.1.1 constraint 3). Opening details while the
        // sidebar is open stays allowed — user's call, no interference.
        try { ctx.layout.closeDetails() } catch { /* root entry 未挂载时 layout 未接线，忽略 */ }
      }

      const style = document.createElement('style')
      // Colors come from DSH alias tokens so the panel follows the three themes
      // (web dark/light + desktop brand themes) without any bridge. Type and
      // geometry now follow DSH's OWN design language, measured from the
      // 0.1.2-rc.1 client-ui packages (2026-09-09, 37 packages / ~2.7M chars):
      //   · Type — DSH ships shorthand tokens (--dsw-font-xxxs-11 … -l-20) whose
      //     family is var(--dsw-font-family) and whose strong weight is 500.
      //     Hardcoded "Inter, system-ui" + 600 read as a foreign component and
      //     ignored the user's font-size setting; monospace must use
      //     var(--ds-font-family-code) (Inter is NOT monospace).
      //   · Geometry — radius ladder 4/6/8/10/12/999/50%; control heights
      //     24/28/32; list rows are 32px tall with an 8px radius and 6px 8px
      //     padding (jobs/session packages); the official details column draws
      //     its edge as `.5px solid var(--dsw-alias-border-l3)` — matched here.
      style.textContent = [
        // Popovers: fixed, because their anchors live inside overflow:auto
        // containers (tab strip / review list head). Radius 8px = DSH's most
        // common overlay radius (was 10px, an off-ladder value).
        `.dsh-sidebar-popover{position:fixed;z-index:${PANEL_Z + 1};min-width:150px;max-width:280px;max-height:60vh;overflow:auto;padding:4px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:1px}`,
        `.dsh-sidebar-menuitem{display:flex;align-items:center;gap:8px;width:100%;min-height:28px;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;text-align:left;font:var(--dsw-font-xxs-12,12px/18px system-ui)}`,
        `.dsh-sidebar-menuitem:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}`,
        `.dsh-sidebar-menuitem[disabled]{opacity:.45;cursor:not-allowed}`,
        `.dsh-sidebar-menuitem[aria-checked="true"]{font-weight:600}`,
        `.dsh-sidebar-menutick{flex:none;width:12px;font:var(--dsw-font-xxxs-11,11px/14px system-ui)}`,
        `.dsh-sidebar-menuicon{flex:none;display:flex;color:var(--dsw-alias-label-secondary,#6b7280)}`,
        `.dsh-sidebar-menuicon svg{width:14px;height:14px}`,
        // 正文容器：不自带 padding（官方右栏的 pane 已有自己的内边距），
        // 只管滚动与字阶。
        `.dsh-sidebar-body{flex:1;min-height:0;overflow:auto;font:var(--dsw-font-xs-13,13px/20px system-ui);color:var(--dsw-alias-label-secondary,#6b7280);scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.3)) transparent}`,
        `.dsh-sidebar-body strong{color:var(--dsw-alias-label-primary,#111827)}`,
        // Review tab (v0.5.0): view dropdown + directory groups + per-file
        // type icon and +N/-M stats. Naming (点名) stays: an unnamed file row
        // carries a red inset edge, exactly like the pre-v0.5 border.
        `.dsh-sidebar-review{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px}`,
        `.dsh-sidebar-review-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none}`,
        `.dsh-sidebar-viewbtn{display:flex;align-items:center;gap:4px;height:28px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;background:transparent;padding:0 8px;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font:var(--dsw-font-xxs-strong-12,500 12px/18px system-ui)}`,
        `.dsh-sidebar-viewbtn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}`,
        `.dsh-sidebar-caret{font:var(--dsw-font-xxxs-11,11px/14px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-badge{font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui);border-radius:999px;padding:2px 8px;line-height:1.4}`,
        `.dsh-sidebar-badge-warn{background:var(--dsw-static-deepseek-450,#9e1b1b);color:#fff}`,
        `.dsh-sidebar-badge-ok{background:var(--dsw-alias-interactive-bg-hover,#e5e7eb);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-refresh{margin-left:auto;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:var(--dsw-font-s-14,14px/22px system-ui);line-height:1}`,
        `.dsh-sidebar-refresh:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-filelist{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.3)) transparent}`,
        `.dsh-sidebar-group{border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.06));flex:none}`,
        `.dsh-sidebar-group:last-child{border-bottom:0}`,
        `.dsh-sidebar-group-head{display:flex;align-items:center;gap:6px;width:100%;min-height:28px;padding:3px 4px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;text-align:left;font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui)}`,
        `.dsh-sidebar-group-head:hover{color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-grouptoggle{flex:none;width:11px;font:var(--dsw-font-xxxs-11,11px/14px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-groupdir{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,Consolas,monospace)}`,
        `.dsh-sidebar-file-entry{display:flex;flex-direction:column}`,
        `.dsh-sidebar-file-rowwrap{display:flex;align-items:center;gap:2px}`,
        // List row = DSH's own row spec (jobs/session): 32px tall, 8px radius,
        // 6px 8px padding, xs-13 type. 2026-09-12: the row's main click now
        // expands the diff (design §3.3); naming moved to its own leading
        // button, so the old 17px indent is carried by that button instead.
        `.dsh-sidebar-file-row{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:6px 8px 6px 2px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;text-align:left;font:var(--dsw-font-xs-13,13px/20px system-ui)}`,
        `.dsh-sidebar-file-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}`,
        `.dsh-sidebar-mention{flex:none;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:var(--dsw-font-xxs-12,12px/18px system-ui);line-height:1;padding:0}`,
        `.dsh-sidebar-mention:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        // 未点名红描边从行整体移到点名钮上（2026-09-12 §3.3）——提示位更聚焦。
        `.dsh-sidebar-mention.unnamed{box-shadow:inset 0 0 0 1.5px var(--dsw-static-deepseek-450,#9e1b1b)}`,
        `.dsh-sidebar-mention.named{color:var(--dsw-alias-state-success-primary,#16a34a)}`,
        `.dsh-sidebar-revsum{flex:none;display:flex;gap:5px;font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui);font-family:var(--ds-font-family-code,Consolas,monospace);color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-fileicon{flex:none;width:14px;height:14px;display:block}`,
        `.dsh-sidebar-fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
        `.dsh-sidebar-syncdot{flex:none;color:var(--dsw-static-deepseek-450,#9e1b1b);font:var(--dsw-font-xxxs-11,11px/14px system-ui)}`,
        `.dsh-sidebar-stat{flex:none;display:flex;gap:5px;font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui);font-family:var(--ds-font-family-code,Consolas,monospace)}`,
        `.dsh-sidebar-stat-add{color:var(--dsw-alias-state-success-primary,#16a34a)}`,
        `.dsh-sidebar-stat-del{color:var(--dsw-alias-state-error-primary,#dc2626)}`,
        `.dsh-sidebar-stat-binary{color:var(--dsw-alias-label-tertiary,#9ca3af);font-weight:400}`,
        // --- Diff reader (2026-09-12 §3.2): sticky file head with the diff's
        // baseline spelled out, hunk headers with git's enclosing-function
        // hint, dual line-number gutters, soft-wrap first (the #1 readability
        // fix for a ~400px panel), prev/next hunk jumps, chunked rendering.
        `.dsh-sidebar-diffhead{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--dsw-alias-bg-layer-1,#fff);border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}`,
        `.dsh-sidebar-diffname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,Consolas,monospace);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-diffbase{flex:none;font:var(--dsw-font-xxxs-11,11px/14px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-difftool{flex:none;min-width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:var(--dsw-font-xxs-12,12px/18px system-ui);line-height:1;padding:0 4px}`,
        `.dsh-sidebar-difftool:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-difftool[aria-pressed="true"]{color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-hunkhead{padding:2px 8px;font:var(--dsw-font-xxxs-11,11px/14px system-ui);font-family:var(--ds-font-family-code,Consolas,monospace);color:var(--dsw-alias-label-tertiary,#9ca3af);background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.04));user-select:none;white-space:pre;overflow:hidden;text-overflow:ellipsis}`,
        `.dsh-sidebar-hunkhead.current{color:var(--dsw-alias-label-secondary,#6b7280);box-shadow:inset 2px 0 0 var(--dsw-static-deepseek-450,#9e1b1b)}`,
        `.dsh-sidebar-dline{display:grid;grid-template-columns:34px 34px 12px minmax(0,1fr);align-items:baseline;font:var(--dsw-font-xxxs-11,11px/14px system-ui);font-family:var(--ds-font-family-code,Consolas,monospace);color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}`,
        `.dsh-sidebar-lnum{text-align:right;padding-right:6px;color:var(--dsw-alias-label-tertiary,#9ca3af);user-select:none}`,
        `.dsh-sidebar-dsign{text-align:center;user-select:none}`,
        `.dsh-sidebar-dtext{white-space:pre;min-width:0;padding-right:8px}`,
        // 换行默认开（窄栏第一可读性）；宽面板可关，回到横向滚动。
        `.dsh-sidebar-dline.wrap .dsh-sidebar-dtext{white-space:pre-wrap;word-break:break-all}`,
        `.dsh-sidebar-dline-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 16%,transparent)}`,
        `.dsh-sidebar-dline-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 14%,transparent)}`,
        `.dsh-sidebar-dline-add .dsh-sidebar-dtext,.dsh-sidebar-dline-del .dsh-sidebar-dtext{color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-dmore{width:100%;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui);padding:6px 8px;text-align:left}`,
        `.dsh-sidebar-dmore:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-diffnote{padding:8px;font:var(--dsw-font-xxxs-11,11px/14px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-emptyhint{padding:20px;text-align:center;color:var(--dsw-alias-label-tertiary,#9ca3af);font:var(--dsw-font-xxs-12,12px/18px system-ui)}`,
        // --- 终端 tab（2026-09-19 多标签；三次调整：**整块化**）
        // 用户反馈「侧边栏终端应该是一整块，不需要分下半部分」：外壳承担唯一的一圈边框
        // 与圆角，标签栏 / xterm / 状态条不再各自成盒（gap:0、无各自边框与圆角）。
        // 状态条只在「有话说」（报错 / 已退出 / 工作区变更）时出现，正常情况下终端就是
        // 标签栏 + 内容的一整块（对齐 Windows Terminal 的观感）。
        `.dsh-sidebar-term{flex:1;min-height:0;display:flex;flex-direction:column;gap:0;overflow:hidden;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff)}`,
        `.dsh-sidebar-term-tabbar{flex:none;min-width:0}`,
        `.dsh-sidebar-term-panes{flex:1;min-height:200px;position:relative;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}`,
        `.dsh-sidebar-term-statusbar{display:flex;align-items:center;gap:8px;padding:4px 8px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-2,#f4f5f7);font:var(--dsw-font-xxxs-11,11px/14px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af);flex:none}`,
        `.dsh-sidebar-term-link{border:0;background:transparent;padding:2px 6px;border-radius:6px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui)}`,
        `.dsh-sidebar-term-link:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
      ].join('')
      document.head.append(style)

      // 底部终端面板 + 标题栏按钮的样式独立成块（这两个 surface 不依赖官方
      // 右栏框架，随 client bundle 注入；仍走 --dsw-* 令牌随三主题）。
      const termStyle = document.createElement('style')
      termStyle.textContent = [
        // 底部面板：默认推挤（命中主内容容器时），布局失败自动浮层——面板
        // 本体永远 fixed 贴底，推挤只决定「内容让不让位」。
        `#miasaki-bottomterm{position:fixed;left:0;right:0;bottom:0;z-index:${PANEL_Z};display:flex;flex-direction:column;height:var(--miasaki-terminal-height,320px);background:var(--dsw-alias-bg-layer-1,#fff);border-top:1px solid var(--dsw-alias-border-l2,#d1d5db);box-shadow:0 -8px 24px rgba(0,0,0,.14);font:var(--dsw-font-xs-13,13px/20px system-ui);color:var(--dsw-alias-label-primary,#111827)}`,
        `#miasaki-bottomterm .miasaki-bottomterm-grip{flex:none;height:6px;cursor:ns-resize;background:transparent}`,
        // 标签栏宿主本身只是挂载点：真正的 .miasaki-term-tabs 由 renderTabs 建在里面。
        `#miasaki-bottomterm .miasaki-bottomterm-tabbar{flex:none;min-width:0}`,
        `#miasaki-bottomterm .miasaki-bottomterm-status{flex:none;display:flex;align-items:center;gap:6px;padding:2px 10px 4px;font:var(--dsw-font-xxxs-11,11px/14px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `#miasaki-bottomterm .miasaki-bottomterm-statustext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
        `#miasaki-bottomterm .miasaki-bottomterm-statusacts{flex:none;display:flex;gap:2px}`,
        `#miasaki-bottomterm .miasaki-bottomterm-btn{flex:none;border:0;background:transparent;border-radius:6px;padding:2px 8px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui)}`,
        `#miasaki-bottomterm .miasaki-bottomterm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        // 推挤消费规则（能力检测命中时由 JS 注入生效，失败则保持浮层）。
        `#root>[data-slot="root"]>div{padding-bottom:var(--miasaki-terminal-height,0px)}`,
        // --- 标签栏 + pane 栈（底部面板与右栏 tab 共用同一套类名）---
        // 视觉对齐参考图：左标题 + 活动标签胶囊（含 ×）+ 右侧 ＋/×，
        // 全部走 --dsw-* 令牌（三主题无硬编码第二套色）。
        `.miasaki-term-tabs{display:flex;align-items:center;gap:6px;height:32px;padding:0 6px 0 10px;background:var(--dsw-alias-bg-layer-2,#f4f5f7);border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));flex:none;min-width:0}`,
        `.miasaki-term-tabs-title{color:var(--dsw-alias-label-tertiary,#9ca3af);font:var(--dsw-font-xxs-12,12px/18px system-ui);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%;flex:0 1 auto}`,
        `.miasaki-term-tabs-strip{display:flex;align-items:center;gap:2px;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}`,
        `.miasaki-term-tabs-strip::-webkit-scrollbar{display:none}`,
        `.miasaki-term-tab{position:relative;display:flex;align-items:center;gap:4px;height:24px;padding:0 6px 0 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font:var(--dsw-font-xxs-12,12px/18px system-ui);min-width:96px;max-width:200px;flex:0 0 auto;cursor:pointer;text-align:left}`,
        `.miasaki-term-tab:hover{background:var(--dsw-alias-bg-layer-3,#e9eaee);color:var(--dsw-alias-label-primary,#111827)}`,
        `.miasaki-term-tab.is-active{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,#d1d5db)}`,
        `.miasaki-term-tab.is-active::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-static-deepseek-450,#4d6bfe)}`,
        `.miasaki-term-tab:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#4d6bfe);outline-offset:-1px}`,
        `.miasaki-term-tab-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
        `.miasaki-term-tab-input{flex:1;min-width:60px;border:0;padding:0 2px;border-radius:3px;background:transparent;color:inherit;font:var(--dsw-font-xxs-12,12px/18px system-ui);outline:1px solid var(--dsw-static-deepseek-450,#4d6bfe)}`,
        `.miasaki-term-tab-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#dc2626)}`,
        `.miasaki-term-tab-close{flex:none;display:grid;place-items:center;width:16px;height:16px;border-radius:3px;font-size:11px;line-height:1;opacity:0}`,
        `.miasaki-term-tab:hover .miasaki-term-tab-close,.miasaki-term-tab.is-active .miasaki-term-tab-close{opacity:.75}`,
        `.miasaki-term-tab-close:hover{background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;opacity:1}`,
        `.miasaki-term-btn{flex:none;display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:14px;line-height:1;cursor:pointer}`,
        `.miasaki-term-btn:hover{background:var(--dsw-alias-bg-layer-3,#e9eaee);color:var(--dsw-alias-label-primary,#111827)}`,
        `.miasaki-term-panes{position:relative;flex:1;min-height:0}`,
        `.miasaki-term-pane{position:absolute;inset:0;padding:0 8px 6px;overflow:hidden}`,
        `.miasaki-term-pane .xterm{height:100%}`,
        // 隐藏 pane 只藏不拆：xterm 实例与 WS 都留着，切回来即时可用（§6.2）。
        `.miasaki-term-pane[style*="display: none"] .xterm{visibility:hidden}`,
        `.miasaki-term-empty{position:absolute;inset:0;display:grid;place-items:center;align-content:center;gap:4px;padding:12px;text-align:center;color:var(--dsw-alias-label-tertiary,#9ca3af);font:var(--dsw-font-xxs-12,12px/18px system-ui)}`,
        `.miasaki-term-empty button{margin-top:8px;padding:7px 14px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);font:var(--dsw-font-xxs-12,12px/18px system-ui);cursor:pointer}`,
        `.miasaki-term-empty button:hover{background:var(--dsw-alias-bg-layer-3,#e9eaee)}`,
        `.miasaki-term-menunote{padding:6px 8px;color:var(--dsw-alias-label-tertiary,#9ca3af);font:var(--dsw-font-xxs-12,12px/18px system-ui)}`,
        `.miasaki-term-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:${PANEL_Z + 2};max-width:80vw;padding:8px 14px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);font:var(--dsw-font-xxs-12,12px/18px system-ui);box-shadow:0 8px 24px rgba(0,0,0,.28);display:none}`,
      ].join('')
      document.head.append(termStyle)

      // --- Host API access (review §4.1 + terminal §6.1) ------------------
      const API_PREFIX = '/sidebar/api'
      // cwd lives in the store, refreshed from the DSH sessions service; the
      // routes take it as a query param (status/checklist) or in the POST body
      // (diff/terminal open) — always send both from the caller's payload.
      const fetchSidebar = (path, opts = {}) => {
        const cwd = store.get().reviewCwd
        if (cwd === null || cwd === undefined) return Promise.reject(new Error('当前会话没有工作区'))
        const url = new URL(API_PREFIX + path, location.origin)
        url.searchParams.set('cwd', cwd)
        // The diff route reads cwd from the POST body (not the query param),
        // so inject it into any JSON body automatically.
        let body = opts.body
        if (typeof body === 'string') {
          try {
            const parsed = JSON.parse(body)
            parsed.cwd = cwd
            body = JSON.stringify(parsed)
          } catch { /* 非 JSON body 原样透传 */ }
        }
        return fetch(url.toString(), { headers: { 'content-type': 'application/json' }, ...opts, ...(body !== undefined ? { body } : {}) })
          .then(r => r.ok ? r.json() : r.text().then(t => {
            // 4xx/5xx 的 host 回包是 { error }：把可读文案提出来，替代把整段
            // JSON 塞进 Error（列表/详情的错误可见化都靠这一步，2026-09-12 §3.1）。
            let message = t
            try { message = JSON.parse(t)?.error ?? t } catch { /* 非 JSON 正文原样 */ }
            return Promise.reject(new Error(message))
          }))
      }

      function useReviewCwd() {
        return react.useSyncExternalStore(store.subscribe, () => store.get().reviewCwd)
      }

      /** 审查视图（全局单值）。官方右栏下 tab id 由框架生成且刷新即变，
       *  没有 per-tab 的存储位，故语义为「上次查看的视图」。 */
      function useReviewView() {
        return react.useSyncExternalStore(reviewView.subscribe, reviewView.get)
      }

      /** 窗口可见性。与官方 `tab.visible`（tab 自身是否可见）相与使用：隐藏的文档
       *  不应继续轮询 host。 */
      function usePageVisible() {
        return react.useSyncExternalStore(store.subscribe, () => store.get().pageVisible)
      }
      /** Current DSH session cwd (best-effort; null when no session is open). */
      const currentSessionCwd = () => {
        try {
          const snapshot = ctx.sessions.list.getSnapshot()
          const id = snapshot.current
          if (id === undefined) return null
          const session = snapshot.byId[id]
          return typeof session?.cwd === 'string' && session.cwd !== '' ? session.cwd : null
        } catch { return null }
      }

      // --- Popover (shared by view menu / tab list / new tab) ---------------
      // Anchored to a button that may sit inside an overflow:auto container
      // (tab strip, review head), so the panel is position:fixed and re-measures
      // on resize/scroll. A pointerdown outside or Escape closes it; a
      // pointerdown on the anchor is ignored so the button's own toggle wins.
      function Popover({ anchorRef, onClose, children, align = 'left' }) {
        const [rect, setRect] = react.useState(null)
        react.useEffect(() => {
          const update = () => {
            const node = anchorRef.current
            if (node instanceof HTMLElement) setRect(node.getBoundingClientRect())
          }
          update()
          window.addEventListener('resize', update)
          window.addEventListener('scroll', update, true)
          return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
          }
        }, [anchorRef])
        react.useEffect(() => {
          const onPointerDown = event => {
            const target = event.target
            if (target instanceof Node && anchorRef.current?.contains(target)) return
            if (target instanceof Element && target.closest('.dsh-sidebar-popover') !== null) return
            onClose()
          }
          const onKeyDown = event => { if (event.key === 'Escape') onClose() }
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [anchorRef, onClose])
        if (rect === null) return null
        return react.createElement('div', {
          className: 'dsh-sidebar-popover',
          role: 'menu',
          style: {
            top: `${Math.round(rect.bottom + 4)}px`,
            ...(align === 'right'
              ? { right: `${Math.round(Math.max(4, window.innerWidth - rect.right))}px` }
              : { left: `${Math.round(Math.max(4, rect.left))}px` }),
            minWidth: `${Math.round(Math.max(rect.width, 150))}px`,
          },
        }, children)
      }

      /** A button that owns a popover; `renderMenu(close)` builds the items. */
      function MenuButton({ className, label, title, text, align, renderMenu }) {
        const [open, setOpen] = react.useState(false)
        const anchorRef = react.useRef(null)
        const close = react.useCallback(() => setOpen(false), [])
        return react.createElement(react.Fragment, null,
          react.createElement('button', {
            ref: anchorRef,
            type: 'button',
            className,
            'aria-label': label,
            title: title ?? label,
            'aria-haspopup': 'menu',
            'aria-expanded': String(open),
            onClick: () => setOpen(value => !value),
          }, text),
          open && react.createElement(Popover, { anchorRef, align, onClose: close }, renderMenu(close)))
      }

      // Per-extension icon color. Values are design-owned (not theme tokens):
      // they carry the file-type identity, while every surface around them
      // stays on --dsw-alias-* tokens.
      const FILE_COLORS = {
        ts: '#3178c6', tsx: '#3178c6', mts: '#3178c6', cts: '#3178c6',
        js: '#c9a227', jsx: '#c9a227', mjs: '#c9a227', cjs: '#c9a227',
        json: '#b58900', jsonc: '#b58900', md: '#519aba', markdown: '#519aba',
        css: '#563d7c', scss: '#c9418f', less: '#563d7c', sass: '#c9418f',
        html: '#e34c26', htm: '#e34c26', vue: '#41b883', svelte: '#ff3e00',
        py: '#3572a5', rs: '#dea584', go: '#00add8', java: '#b07219',
        rb: '#701516', php: '#4f5d95', sh: '#89e051', ps1: '#3b78c3',
        yml: '#8b8b8b', yaml: '#8b8b8b', toml: '#9c4221', ini: '#8b8b8b',
        sql: '#e38c00', png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4',
        gif: '#a074c4', webp: '#a074c4', svg: '#ffb13b', ico: '#a074c4',
        lock: '#8b8b8b', txt: '#8b8b8b', log: '#8b8b8b',
      }
      const fileColor = path => {
        const name = path.slice(path.lastIndexOf('/') + 1)
        const dot = name.lastIndexOf('.')
        const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
        return FILE_COLORS[ext] ?? '#8b8b8b'
      }

      /** File-type icon: a document glyph tinted by extension. */
      function FileIcon({ path }) {
        return react.createElement('svg', {
          className: 'dsh-sidebar-fileicon',
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          style: { color: fileColor(path) },
        },
          react.createElement('path', {
            d: 'M9.4 1.5H4.7a1.2 1.2 0 0 0-1.2 1.2v10.6a1.2 1.2 0 0 0 1.2 1.2h6.6a1.2 1.2 0 0 0 1.2-1.2V5.2L9.4 1.5Z',
            fill: 'currentColor',
            opacity: '.25',
          }),
          react.createElement('path', {
            d: 'M9.4 1.5v3.1a.6.6 0 0 0 .6.6h3.1',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: '1.2',
            strokeLinejoin: 'round',
          }))
      }

      /** `+N -M` (green/red); binary files and stat-less entries show a dash. */
      function StatCell({ add, del, binary }) {
        if (binary === true) return react.createElement('span', { className: 'dsh-sidebar-stat-binary' }, 'bin')
        return react.createElement('span', { className: 'dsh-sidebar-stat' },
          react.createElement('span', { className: 'dsh-sidebar-stat-add' }, typeof add === 'number' ? `+${add}` : '-'),
          react.createElement('span', { className: 'dsh-sidebar-stat-del' }, typeof del === 'number' ? `-${del}` : '-'))
      }

      /** Group entries by directory; a group's stats are the sum of its files. */
      const groupEntries = entries => {
        const groups = new Map()
        for (const entry of entries) {
          const normalized = entry.path.replace(/\\/g, '/')
          const slash = normalized.lastIndexOf('/')
          const dir = slash === -1 ? '' : normalized.slice(0, slash)
          const name = slash === -1 ? normalized : normalized.slice(slash + 1)
          if (!groups.has(dir)) groups.set(dir, { dir, label: dir === '' ? './' : `${dir}/`, entries: [], add: 0, del: 0, counted: 0 })
          const group = groups.get(dir)
          group.entries.push({ ...entry, name })
          if (typeof entry.add === 'number') { group.add += entry.add; group.counted += 1 }
          if (typeof entry.del === 'number') group.del += entry.del
        }
        return [...groups.values()].sort((a, b) => a.dir.localeCompare(b.dir))
      }

      // Review tab: view dropdown (未暂存 / 已暂存 / 全部分支更改 / 上一轮更改)
      // over directory groups. Naming, diff expansion, the 60s TTL and the
      // visible gate are unchanged from v0.4 — only presentation moved.
      // 官方右栏正文：框架经 slot 的 inject face 注入 useTabInfo（无需 import）。
      // 见 design/2026-09-10-migrate-to-official-rightbar.md。
      function ReviewTab(props) {
        const tabInfo = props.useTabInfo()
        const windowVisible = usePageVisible()
        const visible = tabInfo.tab.visible && windowVisible
        const cwd = useReviewCwd()
        const view = useReviewView()
        const [entries, setEntries] = react.useState([])
        const [statusMeta, setStatusMeta] = react.useState(null)
        const [loading, setLoading] = react.useState(true)
        // 列表错误可见化（2026-09-12 §3.1）：不再静默吞掉——此前 .catch 只把
        // loading 置 false，用户在「host 不可达」时看到的是假的「无改动」。
        const [listError, setListError] = react.useState(null)
        const [docSync, setDocSync] = react.useState({ pending: [] })
        const [notes, setNotes] = react.useState({})
        const [refreshTick, setRefreshTick] = react.useState(0)
        // 手风琴（2026-09-12 §3.3）：同时只展开一个文件的 diff。
        const [expandedPath, setExpandedPath] = react.useState(null)
        // Directory groups start COLLAPSED (user decision 2026-09-08): the set
        // holds the EXPANDED dirs, so an empty set is the default state.
        const [openGroups, setOpenGroups] = react.useState(new Set())

        react.useEffect(() => {
          if (cwd === null) { setLoading(false); return }
          let cancelled = false
          let timer = null
          const fetchAll = () => {
            if (cancelled) return
            setLoading(true)
            // `view` is a dependency: switching the dropdown refetches at once
            // (user decision — switch implies pull, no manual refresh needed).
            fetchSidebar('/review/status?view=' + encodeURIComponent(view))
              .then(d => {
                if (cancelled) return
                if (d.status) {
                  setEntries(d.status.entries ?? [])
                  setStatusMeta(d.status)
                  setDocSync(d.docSync ?? { pending: [] })
                }
                setListError(null)
                setLoading(false)
              })
              .catch(error => {
                if (cancelled) return
                // fetch 的网络层失败是 TypeError（host 不在跑）；4xx/5xx 已被
                // fetchSidebar 解析成 host 的可读 error 文案。
                setListError(error instanceof TypeError ? { kind: 'unreachable' } : { kind: 'error', message: error.message })
                setLoading(false)
              })
          }
          fetchAll()
          // 60s TTL while the tab is actually visible; a hidden page skips the
          // tick (the effect re-runs and refreshes at once when it returns).
          timer = window.setInterval(() => { if (visible) fetchAll() }, 60_000)
          return () => { cancelled = true; window.clearInterval(timer) }
        }, [cwd, view, refreshTick, visible])

        react.useEffect(() => {
          if (cwd === null) return
          let cancelled = false
          fetchSidebar('/review/checklist')
            .then(d => { if (!cancelled && d.checklist) setNotes(d.checklist.notes ?? {}) })
            .catch(() => {})
          return () => { cancelled = true }
        }, [cwd, refreshTick])

        if (cwd === null) {
          return react.createElement('div', { className: 'dsh-sidebar-body' },
            react.createElement('p', null, '打开一个会话后即可查看审查数据。'))
        }

        const groups = groupEntries(entries)
        const unnamedCount = entries.filter(entry => !(notes[entry.path] || '').trim()).length
        const syncMissing = (docSync.pending ?? []).flatMap(p => p.missing)
        const allNamed = entries.length > 0 && unnamedCount === 0
        // 头部汇总（2026-09-12 §3.4 的轻量部分）：`N 文件 +A −D`；任一文件
        // 统计缺失（binary / 超限未计数）就只显示占位号，不给出错误的合计。
        const addTotal = entries.length > 0 && entries.every(e => typeof e.add === 'number')
          ? entries.reduce((n, e) => n + e.add, 0) : null
        const delTotal = entries.length > 0 && entries.every(e => typeof e.del === 'number')
          ? entries.reduce((n, e) => n + e.del, 0) : null
        const emptyHint = statusMeta?.noCommits === true && view === 'last'
          ? '仓库还没有提交，尚无「上一轮更改」'
          : view === 'last' ? '最近一次提交没有改动' : '这个视图下没有改动'
        const toggleGroup = dir => setOpenGroups(prev => {
          const next = new Set(prev)
          if (next.has(dir)) next.delete(dir)
          else next.add(dir)
          return next
        })
        // 手风琴：点开一个文件时收起上一个；再点同一个即收起。
        const toggleExpand = path => setExpandedPath(prev => (prev === path ? null : path))
        const toggleNote = path => {
          const current = (notes[path] || '').trim()
          const next = { ...notes, [path]: current !== '' ? '' : '已点名' }
          setNotes(next)
          fetchSidebar('/review/checklist', {
            method: 'POST',
            body: JSON.stringify({ patch: { notes: { [path]: current !== '' ? '' : '已点名' } } }),
          }).catch(() => {})
        }
        const refresh = () => setRefreshTick(t => t + 1)

        return react.createElement('div', { className: 'dsh-sidebar-review' },
          react.createElement('div', { className: 'dsh-sidebar-review-head' },
            react.createElement(MenuButton, {
              className: 'dsh-sidebar-viewbtn',
              label: '审查视图',
              title: '切换审查视图',
              text: [REVIEW_VIEW_LABELS[view], react.createElement('span', { key: 'caret', className: 'dsh-sidebar-caret' }, '▾')],
              renderMenu: close => REVIEW_VIEWS.map(item => react.createElement('button', {
                key: item,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': String(item === view),
                className: 'dsh-sidebar-menuitem',
                onClick: () => { reviewView.set(item); close() },
              }, react.createElement('span', { className: 'dsh-sidebar-menutick' }, item === view ? '✓' : ''), REVIEW_VIEW_LABELS[item])),
            }),
            entries.length > 0 && react.createElement('span', {
              className: 'dsh-sidebar-revsum',
              title: [statusMeta?.branch, statusMeta?.head].filter(Boolean).join(' @ ') || undefined,
            },
              `${entries.length} 文件`,
              react.createElement('span', { className: 'dsh-sidebar-stat-add' }, addTotal === null ? '+' : `+${addTotal}`),
              react.createElement('span', { className: 'dsh-sidebar-stat-del' }, delTotal === null ? '−' : `−${delTotal}`)),
            react.createElement('span', { className: 'dsh-sidebar-badge ' + (allNamed ? 'dsh-sidebar-badge-ok' : 'dsh-sidebar-badge-warn') },
              entries.length === 0 ? '无改动' : (allNamed ? '全部点名' : `${unnamedCount} 条未点名`)),
            react.createElement('button', {
              type: 'button',
              className: 'dsh-sidebar-refresh',
              title: '刷新',
              onClick: refresh,
            }, '↻')),
          react.createElement('div', { className: 'dsh-sidebar-filelist' },
            loading && entries.length === 0
              ? react.createElement('div', { className: 'dsh-sidebar-emptyhint' }, '载入中…')
              : listError !== null
                ? react.createElement('div', { className: 'dsh-sidebar-emptyhint' },
                    listError.kind === 'unreachable'
                      ? '无法连接 DSH host——请确认 dsh web 正在运行（host 半改动需重启 dsh web 才生效）。'
                      : '审查数据加载失败：' + listError.message)
                : entries.length === 0
                  ? react.createElement('div', { className: 'dsh-sidebar-emptyhint' }, emptyHint)
                  : groups.map(group => {
                    const isGroupOpen = openGroups.has(group.dir)
                    return react.createElement('div', { key: group.dir, className: 'dsh-sidebar-group' },
                      react.createElement('button', {
                        type: 'button',
                        className: 'dsh-sidebar-group-head',
                        'aria-expanded': String(isGroupOpen),
                        title: isGroupOpen ? '收起目录' : '展开目录',
                        onClick: () => toggleGroup(group.dir),
                      },
                        react.createElement('span', { className: 'dsh-sidebar-grouptoggle' }, isGroupOpen ? '▾' : '▸'),
                        react.createElement('span', { className: 'dsh-sidebar-groupdir' }, group.label),
                        react.createElement(StatCell, {
                          add: group.counted > 0 ? group.add : null,
                          del: group.counted > 0 ? group.del : null,
                        })),
                      isGroupOpen && group.entries.map(entry => {
                        const note = (notes[entry.path] || '').trim()
                        const isDiffOpen = expandedPath === entry.path
                        return react.createElement('div', { key: entry.path, className: 'dsh-sidebar-file-entry' },
                          react.createElement('div', { className: 'dsh-sidebar-file-rowwrap' },
                            // 点名钮（2026-09-12 §3.3）：从「行主点击」降位为行首
                            // 独立标记，红描边提示随钮走；主点击让位给「看变更」。
                            react.createElement('button', {
                              type: 'button',
                              className: 'dsh-sidebar-mention' + (note !== '' ? ' named' : ' unnamed'),
                              title: note !== '' ? `已点名：${note}（点击取消）` : '未点名——点击标记为已点名',
                              'aria-pressed': String(note !== ''),
                              'aria-label': (note !== '' ? '取消点名 ' : '点名 ') + entry.path,
                              onClick: () => toggleNote(entry.path),
                            }, note !== '' ? '✓' : '◦'),
                            // 主点击 = 展开 / 收起 diff（审查的第一职责是看懂改了什么）。
                            react.createElement('button', {
                              type: 'button',
                              className: 'dsh-sidebar-file-row',
                              title: isDiffOpen ? '收起变更' : '查看变更',
                              'aria-expanded': String(isDiffOpen),
                              onClick: () => toggleExpand(entry.path),
                            },
                              react.createElement(FileIcon, { path: entry.path }),
                              react.createElement('span', { className: 'dsh-sidebar-fname' }, entry.name),
                              syncMissing.length > 0 && react.createElement('span', { className: 'dsh-sidebar-syncdot' }, '⚠'),
                              react.createElement(StatCell, { add: entry.add, del: entry.del, binary: entry.binary }))),
                          isDiffOpen && react.createElement(DiffViewer, { entry, view, refreshTick }))
                      }))
                  })))
      }

      // --- Line-level diff reader（2026-09-12 §3.2 重做）----------------------
      // 每行双行号槽 + 符号列 + 内容列（grid）；hunk 头带 git 的函数上下文尾串；
      // 换行默认开（窄栏第一可读性）、宽面板可关；上下文档位以 context=N 整档
      // 重取（不在本地补行——本地补的行与基线可能漂移）；变更跳转在 hunk 间
      // 滚动；单文件超 2000 行分段渲染（「显示更多」按档放量）。
      // diff 行点击 = 复制 `path:line`（§3.3 行级动作，可直接喂给对话）。
      const DIFF_CONTEXT_OPTIONS = [3, 10, 25, 64]
      const DIFF_RENDER_STEP = 2000
      const BASELINE_LABELS = { index: '索引', HEAD: 'HEAD', 'HEAD^': 'HEAD^' }

      function DiffViewer({ entry, view, refreshTick }) {
        const cwd = useReviewCwd()
        const [diff, setDiff] = react.useState(null)
        const [baseline, setBaseline] = react.useState(null)
        const [state, setState] = react.useState('loading') // loading | done | error | unreachable
        const [errorMessage, setErrorMessage] = react.useState('')
        const [context, setContext] = react.useState(3)
        const [wrap, setWrap] = react.useState(true)
        const [renderLimit, setRenderLimit] = react.useState(DIFF_RENDER_STEP)
        const [currentHunk, setCurrentHunk] = react.useState(-1)
        const [copied, setCopied] = react.useState('')
        const hunkRefs = react.useRef([])
        const copiedTimer = react.useRef(null)
        const path = entry.path

        react.useEffect(() => {
          let cancelled = false
          setState('loading')
          setErrorMessage('')
          fetchSidebar('/review/diff', {
            method: 'POST',
            body: JSON.stringify({ path, view, from: entry.from ?? null, revision: entry.revision ?? null, context }),
          })
            .then(d => {
              if (cancelled) return
              setDiff(d.diff ?? null)
              setBaseline(d.baseline ?? null)
              setRenderLimit(DIFF_RENDER_STEP)
              setCurrentHunk(-1)
              setState('done')
            })
            .catch(error => {
              if (cancelled) return
              // fetch 的网络层失败是 TypeError；4xx/5xx 已带 host 的可读文案。
              if (error instanceof TypeError) setState('unreachable')
              else { setErrorMessage(error.message); setState('error') }
            })
          return () => { cancelled = true }
          // view / from / revision / refreshTick / cwd 全部进依赖（§3.1 的三
          // 个同源缺陷都在这里收口：切视图不重取、刷新不重取、会话切换后
          // 同名文件仍显示旧工作区的内容）。last 视图的 revision 是 HEAD——
          // 列表与详情之间 HEAD 前进也会强制重取。
        }, [path, view, entry.from, entry.revision, refreshTick, context, cwd])

        react.useEffect(() => () => { if (copiedTimer.current !== null) clearTimeout(copiedTimer.current) }, [])

        if (state === 'loading') return react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '加载 diff…')
        if (state === 'unreachable') return react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '无法连接 DSH host——请确认 dsh web 正在运行。')
        if (state === 'error') return react.createElement('div', { className: 'dsh-sidebar-diffnote' }, 'diff 加载失败：' + errorMessage)
        if (!diff || diff.binary) return react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '二进制文件，无行级 diff')
        if (!diff.hunks || diff.hunks.length === 0) return react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '无行级变更')

        // 分段渲染：行预算用完的 hunk 整体延后（不截半行）。
        let budget = renderLimit
        let renderedLines = 0
        const visible = []
        for (const hunk of diff.hunks) {
          if (budget <= 0) break
          const take = hunk.lines.slice(0, budget)
          renderedLines += take.length
          budget -= take.length
          visible.push(take.length === hunk.lines.length ? hunk : { ...hunk, lines: take })
        }
        const totalLines = diff.hunks.reduce((n, h) => n + h.lines.length, 0)

        const copyLine = lineNo => {
          const target = `${path}:${lineNo}`
          try { navigator.clipboard?.writeText(target) } catch { return }
          setCopied(target)
          if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(() => setCopied(''), 1600)
        }
        // 跳转以「已渲染」的 hunk 为界——未渲染的分段先点「显示更多」。
        const jumpHunk = dir => {
          const total = visible.length
          if (total === 0) return
          const next = ((currentHunk + dir) % total + total) % total
          setCurrentHunk(next)
          hunkRefs.current[next]?.scrollIntoView({ block: 'nearest' })
        }

        return react.createElement('div', null,
          react.createElement('div', { className: 'dsh-sidebar-diffhead' },
            react.createElement('span', { className: 'dsh-sidebar-diffname', title: path }, path),
            react.createElement(StatCell, { add: entry.add, del: entry.del, binary: entry.binary }),
            baseline !== null && react.createElement('span', {
              className: 'dsh-sidebar-diffbase',
              title: '此 diff 的对比基线（随视图而定）',
            }, '对比 ' + (BASELINE_LABELS[baseline] ?? baseline)),
            react.createElement(MenuButton, {
              className: 'dsh-sidebar-difftool',
              label: '上下文行数',
              title: '上下文行数（重取 diff）',
              text: '±' + context,
              align: 'right',
              renderMenu: close => DIFF_CONTEXT_OPTIONS.map(n => react.createElement('button', {
                key: n,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': String(n === context),
                className: 'dsh-sidebar-menuitem',
                onClick: () => { setContext(n); close() },
              }, react.createElement('span', { className: 'dsh-sidebar-menutick' }, n === context ? '✓' : ''), n === 64 ? '64（接近全部）' : `±${n} 行`)),
            }),
            react.createElement('button', {
              type: 'button',
              className: 'dsh-sidebar-difftool',
              'aria-pressed': String(wrap),
              title: wrap ? '换行：开（点击改为横向滚动）' : '换行：关（点击恢复自动换行）',
              onClick: () => setWrap(w => !w),
            }, '⏎'),
            react.createElement('button', {
              type: 'button', className: 'dsh-sidebar-difftool', title: '上一处变更',
              'aria-label': '上一处变更', onClick: () => jumpHunk(-1),
            }, '↑'),
            react.createElement('button', {
              type: 'button', className: 'dsh-sidebar-difftool', title: '下一处变更',
              'aria-label': '下一处变更', onClick: () => jumpHunk(1),
            }, '↓')),
          copied !== '' && react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '已复制 ' + copied),
          diff.truncated && react.createElement('div', { className: 'dsh-sidebar-diffnote' }, 'diff 过长，仅显示前 20000 行'),
          visible.map((hunk, hi) => react.createElement('div', { key: hi },
            react.createElement('div', {
              ref: node => { hunkRefs.current[hi] = node },
              className: 'dsh-sidebar-hunkhead' + (hi === currentHunk ? ' current' : ''),
            }, hunk.header ?? `@@ -${hunk.oldStart} +${hunk.newStart} @@`),
            hunk.lines.map((line, li) => react.createElement('div', {
              key: li,
              className: 'dsh-sidebar-dline dsh-sidebar-dline-' + line.t + (wrap ? ' wrap' : ''),
              title: '点击复制 ' + path + ':' + (line.b ?? line.a ?? ''),
              onClick: () => {
                const lineNo = line.b ?? line.a
                if (lineNo !== null && lineNo !== undefined) copyLine(lineNo)
              },
            },
              react.createElement('span', { className: 'dsh-sidebar-lnum' }, line.a ?? ''),
              react.createElement('span', { className: 'dsh-sidebar-lnum' }, line.b ?? ''),
              react.createElement('span', { className: 'dsh-sidebar-dsign' }, line.t === 'add' ? '+' : line.t === 'del' ? '-' : ' '),
              react.createElement('span', { className: 'dsh-sidebar-dtext' }, line.s || ''))))),
          renderedLines < totalLines && react.createElement('button', {
            type: 'button',
            className: 'dsh-sidebar-dmore',
            onClick: () => setRenderLimit(n => n + DIFF_RENDER_STEP),
          }, `还有 ${(totalLines - renderedLines).toLocaleString()} 行——显示更多`))
      }

      // 官方右栏正文（2026-09-19 多标签；同日二次调整：**去掉下半部分配置区**）：
      // 标签栏与 pane 栈都是**命令式 DOM**，与底部面板共用 terminalTabs 的同一套实现。
      // 视图只剩三块：标签栏 / xterm pane 栈 / 细状态条 —— 工作目录、默认 shell、
      // 外部系统终端入口收进 `＋` 的右键菜单（用户反馈下半部分用不上）。
      function TerminalTab(props) {
        void props
        // cwd 变化要重渲染（状态条的「会话工作区已变更」提示）；值本身由 terminalStatus 读。
        react.useSyncExternalStore(store.subscribe, () => store.get().reviewCwd)
        const snap = react.useSyncExternalStore(terminalClient.subscribe, () => terminalClient.snapshot)
        const tabsRef = react.useRef(null)
        const panesRef = react.useRef(null)
        // 官方右栏经 slot 的 inject face 注入 useTabInfo（与 ReviewTab 同款）：
        // 标签栏最右的 × 靠 tab.actions.close() 关掉整个右栏 tab。
        const tabInfoRef = react.useRef(null)
        tabInfoRef.current = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null

        react.useEffect(() => {
          const tabs = tabsRef.current
          const panes = panesRef.current
          if (tabs === null || panes === null) return undefined
          return terminalTabs.mount('right', tabs, panes, {
            onCloseContainer: () => {
              const info = tabInfoRef.current
              if (info === null || typeof info.actions?.close !== 'function') {
                terminalToast('请用官方右栏标签栏关闭此 tab')
                return
              }
              try { info.actions.close() } catch { terminalToast('关闭右栏 tab 失败') }
            },
          })
        }, [])

        const status = terminalStatus('right')

        return react.createElement('div', { className: 'dsh-sidebar-term' },
          react.createElement('div', { className: 'dsh-sidebar-term-tabbar', ref: tabsRef }),
          react.createElement('div', { className: 'dsh-sidebar-term-panes', ref: panesRef }),
          // 状态条只在「有话说」时出现（报错 / 已退出 / 工作区变更）：正常时终端
          // 就是标签栏 + 内容的一整块（2026-09-19 三次调整）。
          status.visible
            ? react.createElement('div', { className: 'dsh-sidebar-term-statusbar' },
              react.createElement('span', null, status.text),
              status.actions.map((action, index) => react.createElement('button', {
                key: `${action.label}-${index}`,
                type: 'button',
                className: 'dsh-sidebar-term-link',
                onClick: action.act,
              }, action.label)),
              react.createElement('button', {
                type: 'button',
                className: 'dsh-sidebar-term-link',
                style: { marginLeft: 'auto' },
                title: '在底部面板显示同一个终端（会话共用，Ctrl+`）',
                onClick: () => {
                  const sid = snap.active.right
                  bottomPanel.show()
                  const inst = terminalTabs.primaryOf('bottom')
                  if (inst !== null && sid !== null) activate(inst, sid)
                },
              }, '在底部打开 ↧'))
            : null)
      }

      // --- 官方右栏 tab 类型注册（自研壳 2026-09-10 退役）-------------------
      // 审查与终端改为官方右栏的 tab 类型；辅助对话待 M2 实现后再注册类型。
      // 打开入口：官方 tab 条的「添加控件」→ 引导页 → 本插件注册的入口胶囊。
      const RIGHT_BAR_TABS = [
        {
          id: '@miasaki/dsh-sidebar/review',
          kind: 'review',
          title: '审查',
          description: '收尾自检清单 + 本轮改动 diff',
          order: 10,
          Body: ReviewTab,
        },
        {
          id: '@miasaki/dsh-sidebar/terminal',
          kind: 'terminal',
          title: '终端',
          description: '把系统终端打开到当前会话的工作目录',
          order: 20,
          Body: TerminalTab,
        },
      ]
      ctx.effect(() => {
        const disposers = []
        for (const tab of RIGHT_BAR_TABS) {
          // ① 类型声明：id 全局唯一，title 在 tab 打开时被捕获。
          // guide 条目的 title / description 必须是**函数**（见 rightBarGuideEntry）。
          disposers.push(ctx.sidebarRightTabs.register({
            id: tab.id,
            kind: tab.kind,
            title: () => tab.title,
            guide: [rightBarGuideEntry(tab.title, tab.description, tab.order)],
          }))
          // ② 正文：key 是**类型 id**（不是 kind）。
          disposers.push(ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tab.id }, tab.Body))
        }
        return () => { for (const dispose of disposers.reverse()) dispose() }
      }, 'sidebar: official right-bar tab types')

      // --- Session 跟随：审查 tab 需要当前会话的 cwd -----------------------
      // 原壳的推挤 / watchdog / chrome reserve 随壳退役，这里只留内容层需要的同步。
      store.set({ reviewCwd: currentSessionCwd() })
      const unsubscribeSessions = ctx.sessions.list.subscribe(() => {
        const cwd = currentSessionCwd()
        if (cwd !== store.get().reviewCwd) store.set({ reviewCwd: cwd })
      })
      // 窗口可见性：隐藏时审查 tab 跳过 60s TTL 轮询（与官方 tab.visible 相与）。
      const onVisibilityChange = () => store.set({ pageVisible: document.visibilityState !== 'hidden' })
      document.addEventListener('visibilitychange', onVisibilityChange)

      // --- 内嵌终端的全局 surface（2026-09-19 多标签）----------------------
      // Ctrl+` 切换底部面板；Ctrl+Shift+` 新建标签；Ctrl+PageUp/PageDown 切上/
      // 下一个标签；Alt+1..8 跳到第 N 个。全部在 capture 阶段拦截，xterm 聚焦时
      // 同样生效（stopPropagation 让 xterm 的 textarea 收不到这些组合键）。
      // 注：Windows Terminal 默认的 Ctrl+Shift+T/W 是**浏览器保留键**，页面拿不到，
      // 故不采用（设计 §7.3 的可拦截性矩阵）。
      const terminalPaneKey = () => {
        if (terminalTabs.hasKind('bottom')) return 'bottom'
        if (terminalTabs.hasKind('right')) return 'right'
        return null
      }
      const stepTab = (key, delta) => {
        const inst = terminalTabs.primaryOf(key)
        if (inst === null || terminalClient.order.length === 0) return
        const list = terminalClient.order
        const current = terminalClient.active[key]
        const index = current === null ? -1 : list.indexOf(current)
        const next = ((index < 0 ? 0 : index + delta) + list.length) % list.length
        activate(inst, list[next])
      }
      const onTerminalHotkey = event => {
        if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.code === 'Backquote') {
          event.preventDefault()
          event.stopPropagation()
          bottomPanel.toggle()
          return
        }
        const key = terminalPaneKey()
        if (key === null) return
        if (event.ctrlKey && !event.altKey && !event.metaKey && event.shiftKey && event.code === 'Backquote') {
          event.preventDefault()
          event.stopPropagation()
          addTab(terminalTabs.primaryOf(key))
          return
        }
        if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && (event.code === 'PageDown' || event.code === 'PageUp')) {
          event.preventDefault()
          event.stopPropagation()
          stepTab(key, event.code === 'PageDown' ? 1 : -1)
          return
        }
        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && /^Digit[1-8]$/.test(event.code)) {
          const index = Number(event.code.slice(5)) - 1
          if (index < terminalClient.order.length) {
            event.preventDefault()
            event.stopPropagation()
            activate(terminalTabs.primaryOf(key), terminalClient.order[index])
          }
        }
      }
      document.addEventListener('keydown', onTerminalHotkey, true)
      titlebarButton.watch()

      ctx.effect(() => () => {
        window.__DSH_SIDEBAR_BOOTED__ = false
        unsubscribeSessions()
        document.removeEventListener('visibilitychange', onVisibilityChange)
        document.removeEventListener('keydown', onTerminalHotkey, true)
        bottomPanel.dispose()
        titlebarButton.dispose()
        store.listeners.clear()
        reviewView.listeners.clear()
        terminalClient.listeners.clear()
        style.remove()
        termStyle.remove()
      }, 'sidebar: content lifecycle')
    }

    return module.exports
  },
})
