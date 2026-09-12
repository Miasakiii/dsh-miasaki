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

    // --- 内嵌终端控制器（模块级单例，命令式；React 层只渲染状态）-----------
    // 形态拍板（2026-09-12 §6）：底部面板与右栏 tab 是**同一个 pty 会话**的
    // 两个 viewer——切换容器 = detach 旧 viewer、attach 新 viewer，回放补齐，
    // 会话状态不丢（VS Code 同款「移位」体验）。
    // 每个 viewer 一条独立 WS：host 对每条连接的 attach 各回 ready+replay，
    // 输出按连接广播——共享单连接会让 replay 被写进所有 xterm（重复）。
    const terminalClient = {
      session: null, // 最近一次 ready 帧 { shell, bin, pid, cwd }
      exited: null, // { code } | null
      lastError: '',
      pendingRestart: false, // 用户换 shell / 移动工作区后，下次 attach 带 restart
      wantedShell: null, // null = host 首个可用（懒探测一次）
      shellProbed: false,
      viewers: new Set(),
      listeners: new Set(),
      assetsPromise: null,

      // useSyncExternalStore 的 getSnapshot 必须返回**缓存引用**：每次构造新
      // 对象会让 React 18 判定快照永不稳定 → 无限重渲染 → 抛错卸载整个 tab
      // 子树（2026-09-12 实机「终端空白」的根因——审查 tab 的 store 都返回
      // 稳定值所以无恙）。快照只在 emit() 时重建一次。
      _snapshot: { session: null, exited: null, lastError: '', wantedShell: null },
      get snapshot() { return terminalClient._snapshot },
      subscribe(listener) { terminalClient.listeners.add(listener); return () => terminalClient.listeners.delete(listener) },
      emit() {
        terminalClient._snapshot = {
          session: terminalClient.session,
          exited: terminalClient.exited,
          lastError: terminalClient.lastError,
          wantedShell: terminalClient.wantedShell,
        }
        for (const listener of terminalClient.listeners) listener()
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
          const ptyCapable = (data.shells ?? []).filter(shell => shell.available && shell.id !== 'wt')
          terminalClient.wantedShell = data.fallback !== null && ptyCapable.some(shell => shell.id === data.fallback)
            ? data.fallback
            : (ptyCapable[0]?.id ?? null)
          terminalClient.emit()
        } catch { /* 探测失败保持 null——attach 会被 host 拒绝并显示错误 */ }
      },

      /**
       * 一个 viewer = 一个 xterm 实例 + 一条 WS。返回 detach()；pty 在 host 侧
       * 保活（§4.3），viewer 消失只是关连接，重连凭回放补齐。
       */
      async attachViewer(el) {
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
        const viewer = { el, term, fit, ws: null, reconnectTimer: null, disposed: false }
        viewer.sendFrame = frame => {
          if (viewer.ws !== null && viewer.ws.readyState === 1) viewer.ws.send(JSON.stringify(frame))
        }
        viewer.onResize = new ResizeObserver(() => {
          try { fit.fit() } catch { /* 零尺寸（面板收起）时忽略 */ }
          viewer.sendFrame({ type: 'resize', cols: term.cols, rows: term.rows })
        })
        viewer.onResize.observe(el)
        term.onData(data => viewer.sendFrame({ type: 'input', data }))
        terminalClient.viewers.add(viewer)
        terminalClient.connectViewer(viewer)
        return () => {
          viewer.disposed = true
          viewer.onResize.disconnect()
          if (viewer.reconnectTimer !== null) clearTimeout(viewer.reconnectTimer)
          if (viewer.ws !== null) { try { viewer.ws.close() } catch { /* noop */ } }
          terminalClient.viewers.delete(viewer)
          term.dispose()
        }
      },

      async connectViewer(viewer) {
        if (viewer.disposed) return
        if (viewer.ws !== null && (viewer.ws.readyState === 0 || viewer.ws.readyState === 1)) return
        terminalClient.lastError = ''
        terminalClient.emit()
        await terminalClient.ensureShellPicked()
        let token
        try {
          const cwd = store.get().reviewCwd
          if (cwd === null || cwd === undefined) throw new Error('当前会话没有工作区')
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
          ws.send(JSON.stringify({
            type: 'attach',
            shell: terminalClient.wantedShell,
            cwd: store.get().reviewCwd ?? '',
            cols: viewer.term.cols,
            rows: viewer.term.rows,
            restart: terminalClient.pendingRestart || undefined,
          }))
          terminalClient.pendingRestart = false
        }
        ws.onmessage = event => {
          let msg
          try { msg = JSON.parse(String(event.data)) } catch { return }
          if (msg.type === 'output' || msg.type === 'replay') {
            viewer.term.write(msg.data)
          } else if (msg.type === 'ready') {
            terminalClient.session = { shell: msg.shell, bin: msg.bin, pid: msg.pid, cwd: msg.cwd }
            terminalClient.exited = null
            terminalClient.emit()
          } else if (msg.type === 'status' && msg.state === 'exited') {
            terminalClient.exited = { code: msg.code }
            terminalClient.emit()
          } else if (msg.type === 'error') {
            terminalClient.lastError = msg.message ?? '内嵌终端错误'
            terminalClient.emit()
          }
        }
        ws.onclose = () => {
          viewer.ws = null
          terminalClient.emit()
          // pty 在 host 侧保活（设计 §4.3）：断线只重连取回放，绝不因 viewer
          // 消失杀会话。固定 1.5s 退避，避免风暴。
          if (!viewer.disposed && viewer.reconnectTimer === null) {
            viewer.reconnectTimer = setTimeout(() => {
              viewer.reconnectTimer = null
              terminalClient.connectViewer(viewer)
            }, 1500)
          }
        }
        ws.onerror = () => { /* close 事件随后到，统一在那里处理 */ }
      },

      /** [重启]：kill 旧会话重 spawn。restart 帧从任一活跃 viewer 发出即可。 */
      requestRestart() {
        terminalClient.pendingRestart = true
        terminalClient.exited = null
        terminalClient.lastError = ''
        const viewer = terminalClient.viewers.values().next().value
        if (viewer !== undefined) {
          viewer.sendFrame({
            type: 'attach',
            shell: terminalClient.wantedShell,
            cwd: store.get().reviewCwd ?? '',
            cols: viewer.term.cols,
            rows: viewer.term.rows,
            restart: true,
          })
        }
        terminalClient.emit()
      },

      /** 换 shell = 重启会话（host 收到 restart attach：kill 旧 pty 后按新 shell spawn）。 */
      setShell(shellId) {
        if (terminalClient.wantedShell === shellId) return
        terminalClient.wantedShell = shellId
        terminalClient.requestRestart()
      },
    }

    // --- 底部终端面板（命令式 DOM；不依赖官方右栏框架）---------------------
    const bottomPanel = {
      el: null,
      open: false,
      height: 320,
      viewers: new Map(), // el → detach
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
        const body = bottomPanel.el.querySelector('.miasaki-bottomterm-body')
        if (body !== null && !bottomPanel.viewers.has(body)) {
          terminalClient.attachViewer(body)
            .then(detach => { bottomPanel.viewers.set(body, detach) })
            .catch(error => {
              body.textContent = error instanceof Error ? error.message : String(error)
              body.style.cssText += ';padding:12px;color:var(--dsw-alias-state-error-primary,#dc2626);font:var(--dsw-font-xxs-12,12px/18px system-ui)'
            })
        }
      },
      close() {
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
          '<div class="miasaki-bottomterm-head">',
          '<strong>终端</strong>',
          '<span class="miasaki-bottomterm-status"></span>',
          '<button type="button" class="miasaki-bottomterm-btn" data-act="restart" title="重启终端">重启</button>',
          '<button type="button" class="miasaki-bottomterm-btn" data-act="close" title="关闭（Ctrl+`）">关闭</button>',
          '</div>',
          '<div class="miasaki-bottomterm-body"></div>',
        ].join('')
        document.body.append(el)
        bottomPanel.el = el
        // 关闭按钮 / 重启
        el.addEventListener('click', event => {
          const btn = event.target instanceof Element ? event.target.closest('[data-act]') : null
          if (btn === null) return
          if (btn.getAttribute('data-act') === 'close') bottomPanel.close()
          if (btn.getAttribute('data-act') === 'restart') terminalClient.requestRestart()
        })
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
        // 状态条订阅：会话 / 连接状态一行显示。
        const status = el.querySelector('.miasaki-bottomterm-status')
        const renderStatus = () => {
          const snap = terminalClient.snapshot
          const cwd = store.get().reviewCwd ?? ''
          const parts = []
          if (snap.session !== null) parts.push(`${snap.session.bin} · pid ${snap.session.pid}`)
          if (snap.exited !== null) parts.push(`已退出（code ${snap.exited.code}）`)
          else if (snap.lastError !== '') parts.push(snap.lastError)
          if (snap.session !== null && cwd !== '' && snap.session.cwd !== cwd) parts.push(`会话工作区已变更（终端仍在 ${snap.session.cwd}）`)
          status.textContent = parts.join(' · ')
        }
        terminalClient.subscribe(renderStatus)
        store.subscribe(renderStatus)
        renderStatus()
      },
      dispose() {
        if (bottomPanel.el !== null) {
          for (const detach of bottomPanel.viewers.values()) { try { detach() } catch { /* noop */ } }
          bottomPanel.viewers.clear()
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
          { label: '右栏终端（新 tab）', act: () => bottomPanel.show(), disabled: true, note: '经官方「添加控件」打开' },
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
        // Terminal launcher tab (design §6.1): cwd readout, shell picker,
        // primary launch button, last-result panel.
        // Terminal tab scrolls inside its own pane (the pane itself is
        // overflow:hidden so the review list can own its scrolling).
        `.dsh-sidebar-term{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px}`,
        `.dsh-sidebar-term-label{font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui);color:var(--dsw-alias-label-secondary,#6b7280);text-transform:uppercase;letter-spacing:.04em}`,
        `.dsh-sidebar-term-cwdrow{display:flex;align-items:stretch;gap:8px}`,
        `.dsh-sidebar-term-cwd{flex:1;min-width:0;font:var(--dsw-font-xxxs-11,11px/14px system-ui);font-family:var(--ds-font-family-code,Consolas,monospace);padding:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.04));color:var(--dsw-alias-label-primary,#111827);word-break:break-all}`,
        `.dsh-sidebar-term-copy{flex:none;width:30px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:var(--dsw-font-xxs-12,12px/18px system-ui)}`,
        `.dsh-sidebar-term-copy:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-term-shells{display:flex;flex-direction:column;gap:4px}`,
        `.dsh-sidebar-term-shell{display:flex;align-items:center;gap:8px;padding:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font:var(--dsw-font-xxs-12,12px/18px system-ui);text-align:left}`,
        `.dsh-sidebar-term-shell:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}`,
        `.dsh-sidebar-term-shell[aria-checked="true"]{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);border-color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-term-shell[disabled]{opacity:.45;cursor:not-allowed}`,
        `.dsh-sidebar-term-shellname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
        `.dsh-sidebar-term-shellnote{flex:none;font:var(--dsw-font-xxxs-11,11px/14px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-term-go{width:100%;min-height:32px;border:0;border-radius:8px;background:var(--dsw-static-deepseek-450,#4b5563);color:#fff;cursor:pointer;font:var(--dsw-font-xs-strong-13,500 13px/20px system-ui)}`,
        `.dsh-sidebar-term-go:hover:not([disabled]){filter:brightness(1.08)}`,
        `.dsh-sidebar-term-go[disabled]{opacity:.5;cursor:not-allowed}`,
        `.dsh-sidebar-term-result{padding:8px;border-radius:8px;font:var(--dsw-font-xxxs-11,11px/14px system-ui);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));color:var(--dsw-alias-label-secondary,#6b7280)}`,
        `.dsh-sidebar-term-result.err{border-color:var(--dsw-alias-state-error-primary,#9e1b1b);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-term-retry{margin-top:6px;border:0;border-radius:6px;padding:4px 8px;background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui)}`,
        // --- 内嵌终端（右栏 tab 主体，2026-09-12 §4）-------------------------
        `.dsh-sidebar-term-embed{flex:1;min-height:180px;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}`,
        `.dsh-sidebar-term-embed-body{flex:1;min-height:0;padding:4px}`,
        `.dsh-sidebar-term-embed-body .xterm{height:100%}`,
        `.dsh-sidebar-term-statusbar{display:flex;align-items:center;gap:8px;padding:4px 8px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));font:var(--dsw-font-xxxs-11,11px/14px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af);flex:none}`,
        `.dsh-sidebar-term-statusbar strong{color:var(--dsw-alias-label-secondary,#6b7280);font-weight:500}`,
        `.dsh-sidebar-term-link{border:0;background:transparent;padding:2px 6px;border-radius:6px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui)}`,
        `.dsh-sidebar-term-link:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-shellpick{display:flex;gap:4px;flex-wrap:wrap}`,
        `.dsh-sidebar-shellchip{min-height:24px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:999px;background:transparent;padding:2px 10px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;font:var(--dsw-font-xxs-12,12px/18px system-ui)}`,
        `.dsh-sidebar-shellchip:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-shellchip[aria-checked="true"]{border-color:var(--dsw-alias-label-tertiary,#9ca3af);color:var(--dsw-alias-label-primary,#111827);font-weight:500}`,
        `.dsh-sidebar-shellchip[disabled]{opacity:.45;cursor:not-allowed}`,
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
        `#miasaki-bottomterm .miasaki-bottomterm-head{flex:none;display:flex;align-items:center;gap:8px;padding:2px 10px 4px;font:var(--dsw-font-xxs-strong-12,500 12px/18px system-ui)}`,
        `#miasaki-bottomterm .miasaki-bottomterm-status{font:var(--dsw-font-xxxs-11,11px/14px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}`,
        `#miasaki-bottomterm .miasaki-bottomterm-btn{flex:none;border:0;background:transparent;border-radius:6px;padding:2px 8px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;font:var(--dsw-font-xxs-12,12px/18px system-ui)}`,
        `#miasaki-bottomterm .miasaki-bottomterm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `#miasaki-bottomterm .miasaki-bottomterm-body{flex:1;min-height:0;padding:0 8px 6px}`,
        `#miasaki-bottomterm .miasaki-bottomterm-body .xterm{height:100%}`,
        // 推挤消费规则（能力检测命中时由 JS 注入生效，失败则保持浮层）。
        `#root>[data-slot="root"]>div{padding-bottom:var(--miasaki-terminal-height,0px)}`,
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

      // Terminal launcher tab (design §6.1): the host spawns a real system
      // terminal at the session cwd. State machine is explicit —
      // checking → idle → opening → opened | failed — so the button never
      // reports success on a failed spawn.
      // 官方右栏正文：接收框架注入（本组件目前不消费 tabInfo，但必须接受 props）。
      // 内嵌终端视图：把一个 xterm 挂到共享控制器（每 viewer 一条 WS，§4.3
      // 生命周期）。React 只负责挂载/卸载，会话状态在 terminalClient。
      function TerminalView() {
        const ref = react.useRef(null)
        const [error, setError] = react.useState('')
        react.useEffect(() => {
          const el = ref.current
          if (el === null) return undefined
          let detachFn = null
          let cancelled = false
          terminalClient.attachViewer(el)
            .then(detach => {
              if (cancelled) detach()
              else detachFn = detach
            })
            .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
          return () => {
            cancelled = true
            if (detachFn !== null) detachFn()
          }
        }, [])
        if (error !== '') {
          return react.createElement('div', { className: 'dsh-sidebar-term-embed' },
            react.createElement('div', { className: 'dsh-sidebar-diffnote' }, error))
        }
        return react.createElement('div', { className: 'dsh-sidebar-term-embed' },
          react.createElement('div', { className: 'dsh-sidebar-term-embed-body', ref }))
      }

      // 终端 tab（2026-09-12 §4 内嵌化）：主体是共享 pty 会话的 xterm 视图；
      // 原外部启动器（spawn 系统终端）保留为折叠的次要路径。
      function TerminalTab(props) {
        void props
        const cwd = react.useSyncExternalStore(store.subscribe, () => store.get().reviewCwd)
        const term = react.useSyncExternalStore(terminalClient.subscribe, () => terminalClient.snapshot)
        const [shells, setShells] = react.useState(null)
        const [picked, setPicked] = react.useState(null)
        const [phase, setPhase] = react.useState('checking')
        const [result, setResult] = react.useState(null)

        react.useEffect(() => {
          let cancelled = false
          setPhase('checking')
          fetchSidebar('/terminal/options')
            .then(data => {
              if (cancelled) return
              const list = data.shells ?? []
              setShells(list)
              // Default to the host's fallback pick (first available in the
              // documented wt → pwsh → powershell → cmd order).
              setPicked(data.fallback ?? list.find(shell => shell.available)?.id ?? null)
              setPhase('idle')
            })
            .catch(error => {
              if (cancelled) return
              setShells([])
              setPhase('idle')
              setResult({ ok: false, message: '无法探测可用终端：' + error.message })
            })
          return () => { cancelled = true }
        }, [cwd])

        if (cwd === null || cwd === undefined) {
          return react.createElement('div', { className: 'dsh-sidebar-body' },
            react.createElement('p', null, '打开一个带工作区的会话后即可启动终端。'))
        }

        const open = () => {
          if (picked === null) return
          setPhase('opening')
          setResult(null)
          fetchSidebar('/terminal/open', { method: 'POST', body: JSON.stringify({ shell: picked }) })
            .then(data => {
              setPhase('opened')
              setResult({ ok: true, message: `已启动 ${data.bin}${data.pid ? `（pid ${data.pid}）` : ''}` })
            })
            .catch(error => {
              setPhase('failed')
              setResult({ ok: false, message: error.message })
            })
        }
        const copyCwd = () => {
          try { navigator.clipboard?.writeText(cwd) } catch { /* 无剪贴板权限时静默 */ }
        }

        const busy = phase === 'checking' || phase === 'opening'
        const available = (shells ?? []).filter(shell => shell.available)
        // 内嵌 pty 的 shell 胶囊：容器型 wt 不入（PTY_SHELLS 纪律），未安装置灰。
        const ptyShells = (shells ?? []).filter(shell => shell.id !== 'wt')
        const statusParts = []
        if (term.session !== null) statusParts.push(`${term.session.bin} · pid ${term.session.pid}`)
        const cwdMoved = term.session !== null && term.session.cwd !== cwd

        return react.createElement('div', { className: 'dsh-sidebar-term' },
          react.createElement('div', null,
            react.createElement('div', { className: 'dsh-sidebar-term-label' }, '工作目录'),
            react.createElement('div', { className: 'dsh-sidebar-term-cwdrow' },
              react.createElement('div', { className: 'dsh-sidebar-term-cwd' }, cwd),
              react.createElement('button', {
                type: 'button', className: 'dsh-sidebar-term-copy', title: '复制路径',
                'aria-label': '复制路径', onClick: copyCwd,
              }, '⧉'))),
          react.createElement('div', null,
            react.createElement('div', { className: 'dsh-sidebar-term-label' }, '内嵌终端'),
            phase === 'checking'
              ? react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '探测可用终端…')
              : ptyShells.every(shell => !shell.available) && ptyShells.length > 0
                ? react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '未探测到可用于内嵌终端的 shell。')
                : react.createElement('div', { className: 'dsh-sidebar-shellpick', role: 'radiogroup', 'aria-label': '内嵌终端 shell' },
                  ptyShells.map(shell => react.createElement('button', {
                    key: shell.id,
                    type: 'button',
                    role: 'radio',
                    className: 'dsh-sidebar-shellchip',
                    'aria-checked': String(term.wantedShell === shell.id),
                    disabled: !shell.available,
                    title: shell.available ? shell.bin : '未安装',
                    onClick: () => terminalClient.setShell(shell.id),
                  }, shell.label)))),
          react.createElement(TerminalView, null),
          react.createElement('div', { className: 'dsh-sidebar-term-statusbar' },
            react.createElement('span', null,
              term.exited !== null
                ? `已退出（code ${term.exited.code}）`
                : (statusParts.join(' · ') || (term.lastError !== '' ? term.lastError : '待连接…')),
              cwdMoved === true && ' · 会话工作区已变更，终端仍在原目录'),
            term.exited !== null
              ? react.createElement('button', {
                  type: 'button', className: 'dsh-sidebar-term-link', onClick: () => terminalClient.requestRestart(),
                }, '重启')
              : null,
            cwdMoved === true
              ? react.createElement('button', {
                  type: 'button', className: 'dsh-sidebar-term-link',
                  title: '在当前会话工作区重启终端',
                  onClick: () => terminalClient.requestRestart(),
                }, '移到当前工作区')
              : null,
            react.createElement('button', {
              type: 'button',
              className: 'dsh-sidebar-term-link',
              style: { marginLeft: 'auto' },
              title: '把同一个终端移到底部面板（Ctrl+`）',
              onClick: () => bottomPanel.show(),
            }, '在底部打开 ↧')),
          react.createElement('details', null,
            react.createElement('summary', { className: 'dsh-sidebar-term-label', style: { cursor: 'pointer' } }, '外部系统终端（独立窗口）'),
            react.createElement('div', { style: { paddingTop: '8px' } },
              phase === 'checking'
                ? react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '探测可用终端…')
                : available.length === 0
                  ? react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '未探测到可用的系统终端。')
                  : react.createElement('div', { className: 'dsh-sidebar-term-shells', role: 'radiogroup', 'aria-label': '终端类型' },
                    (shells ?? []).map(shell => react.createElement('button', {
                      key: shell.id,
                      type: 'button',
                      role: 'radio',
                      className: 'dsh-sidebar-term-shell',
                      'aria-checked': String(picked === shell.id),
                      // Not installed → refuse the pick outright rather than
                      // silently falling back to a shell the user did not choose.
                      disabled: !shell.available || busy,
                      onClick: () => setPicked(shell.id),
                    },
                      react.createElement('span', { className: 'dsh-sidebar-term-shellname' }, shell.label),
                      react.createElement('span', { className: 'dsh-sidebar-term-shellnote' },
                        shell.available ? shell.bin : '未安装')))),
              react.createElement('button', {
                type: 'button',
                className: 'dsh-sidebar-term-go',
                style: { marginTop: '8px' },
                disabled: busy || picked === null,
                onClick: open,
              }, phase === 'opening' ? '正在启动…' : '打开系统终端'),
              result !== null && react.createElement('div', {
                className: 'dsh-sidebar-term-result' + (result.ok ? '' : ' err'),
                role: 'status',
              },
                result.message,
                !result.ok && react.createElement('div', null,
                  react.createElement('button', { type: 'button', className: 'dsh-sidebar-term-retry', onClick: open }, '重试'))))))
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

      // --- 内嵌终端的全局 surface（2026-09-12 §4 拍板）----------------------
      // Ctrl+` 切换底部面板（capture 阶段拦截，xterm 聚焦时同样生效）；
      // 桌面壳下标题栏注入终端按钮（web 环境无 #miasaki-titlebar，自动跳过）。
      const onTerminalHotkey = event => {
        if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.code === 'Backquote') {
          event.preventDefault()
          bottomPanel.toggle()
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
