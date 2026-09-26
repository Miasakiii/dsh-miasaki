window.__ModuleLoader__.load({
  id: '@miasaki/dsh-canvas',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')
    const currentSession = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const id = snapshot.current
      if (id === undefined) return null
      const session = snapshot.byId[id]
      return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null }
    }
    const sessionSnapshot = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      return snapshot.ids.map(id => {
        const session = snapshot.byId[id]
        return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null, parentId: session.parentId ?? null, blank: session.blank }
      }).filter(Boolean)
    }
    const workspaceSnapshot = ctx => {
      const sessions = ctx.sessions.list.getSnapshot()
      const snapshot = ctx.workspaces.list.getSnapshot()
      const accounted = new Set(snapshot.items.flatMap(workspace => workspace.sessionIds))
      return [
        ...snapshot.items.map(workspace => ({ id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds })),
        { id: 'dsh-ungrouped', title: '未分组', path: null, sessionIds: sessions.ids.filter(id => !accounted.has(id)) },
      ]
    }

    // ---- 桌面壳契约对象（2026-09-27）-----------------------------------------
    // `window.miasakiDesktop` 是桌面壳注入层（desktop 线 `themes/src/10-contract.js`）
    // 暴露的能力面：有版本号、可探测（`has(name)`）、缺失即降级。**只在模块初始化时取一次
    // 并保存**：契约对象是壳在文档早期写入的稳定单例，每次取数重取只会让「契约在不在」
    // 的判断散落到多个调用点，且同一拍里前后判定可能不一致。浏览器直开时为 `undefined`，
    // 所有消费点都必须按「能力缺失 → 走既有的 DOM 兜底」处理。
    var d = typeof window !== 'undefined' ? window.miasakiDesktop : undefined

    // ---- 会话头部窄宽度自适应（2026-09-10）----------------------------------
    // 官方会话头把一行分成 titleCluster（flex:1 + min-width:0，可被压到 0）与
    // headerUtilities / headerCorner（都是 flex:none，不收缩）；而 titleCluster 内部
    // 的 headerActions 又同样是 flex:none —— 中栏被右侧边栏推窄到放不下时，actions
    // 无处安放、溢出并压在 utilities 上，标题也被裁没。
    // 本切换器是 actions 里最宽的一项（≈116px），空间不足时降级为图标形态（≈64px）。
    //
    // 判据：自身左边界到 header 内容区左边的距离 = 留给标题的余量。
    // 标题都快没了，就说明这一行已经挤不下完整形态。进入 / 退出用两个阈值形成滞回，
    // 否则形态切换本身改变占宽，会把判定推来推去（抖动）。
    const COMPACT_ENTER_PX = 120
    const COMPACT_RELEASE_PX = 200
    const compactDecision = ({ leftGap, compact, enter = COMPACT_ENTER_PX, release = COMPACT_RELEASE_PX }) =>
      compact ? leftGap < release : leftGap < enter

    /** 紧凑形态的「对话」图标（内联 SVG，跟随 currentColor 与主题令牌）。 */
    const dialogGlyph = () => react.createElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      react.createElement('path', { fill: 'currentColor', d: 'M2.5 3.75h11v6.5H7.4L4.25 13V10.25H2.5Z' }))
    /** 紧凑形态的「会话布」图标：三节点连线，与画布品牌标记同构。 */
    const mapGlyph = () => react.createElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      react.createElement('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, d: 'M4.6 5.2 10.7 6M4.9 6.4 6.7 10.4M11.3 7.6 8.5 10.8' }),
      react.createElement('circle', { cx: 4, cy: 4.5, r: 1.7, fill: 'currentColor' }),
      react.createElement('circle', { cx: 12, cy: 6, r: 1.7, fill: 'currentColor' }),
      react.createElement('circle', { cx: 7, cy: 12, r: 1.7, fill: 'currentColor' }))

    // DSH 0.1.7 起会话导航从 ctx.sessions.open 移到 ctx.uiWorkspace.openSession
    // （ISessions 契约删除了 open），要调用它必须显式注入 uiWorkspace。
    module.exports.inject = ['sessions', 'workspaces', 'uiWorkspace', 'slots']
    module.exports.apply = ctx => {
      // 幂等守卫：DSH HMR/页面重挂可能重复 apply，旧实例的 DOM/监听还没被回收
      // 时会叠加出两个「对话/会话布」按钮——同一页面只允许一份画布桥。
      if (window.__DSH_CANVAS_BOOTED__) return
      window.__DSH_CANVAS_BOOTED__ = true
      // 失败必须留痕：2026-09-27 之前 canvas:open-session / canvas:activate-session
      // 两处是空 catch，把 TypeError（ctx.sessions.open 在 0.1.7 已删除）一律显示成
      // 「关联的 DSH 会话已不可用」——会话其实活着，真实原因被吞。与 syncSessions
      // 的 report 同一纪律：日志带真实原因，toast 文案只做用户侧摘要。
      const reasonOf = error => error instanceof Error ? error.message : String(error)
      const reportBridgeFailure = (action, error) => {
        console.warn(`dsh-canvas: ${action} 失败（关联的 DSH 会话可能已删除或未加载）— ${reasonOf(error)}`)
      }
      const prompt = async (sessionId, text) => {
        // 先打开再借 scope：0.1.7 的 ctx.sessions.scope() 只对已 retain 的世代有效
        // （uiWorkspace.openSession 同步 materializeScope），未在前台打开过的会话直接
        // 取 scope 恒为 undefined，发消息必失败。openSession 自身的失败原因必须带走。
        try {
          ctx.uiWorkspace.openSession(sessionId)
        } catch (error) {
          reportBridgeFailure('canvas:send-message', error)
          throw new Error(`关联的 DSH 会话已不可用（${reasonOf(error)}）`)
        }
        const scope = ctx.sessions.scope(sessionId)
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
        if (session === undefined) throw new Error('关联的 DSH 会话已不可用')
        const result = await session.prompt([{ type: 'text', text }], 'queue')
        if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受这条消息')
      }
      const style = document.createElement('style')
      // 切换按钮走 DSH 会话头 actions 插槽（官方槽渲染、与「后台任务」同一 flex 行，
      // 结构上不可能叠压），配色全部用 DSH 主题令牌（激活胶囊随主题品牌色：
      // 原版蓝 / 刻刻帝绯红 / 狂狂帝血绯）。
      style.textContent = '.dsh-canvas-switch{display:flex;align-items:center;gap:2px;margin-left:2px;padding:0 3px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:999px;background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.92));backdrop-filter:blur(10px)}.dsh-canvas-switch button{height:28px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:var(--dsw-alias-label-secondary,#6b7280);font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}.dsh-canvas-switch button:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}.dsh-canvas-switch button.active{background:var(--dsw-static-deepseek-450,#111827);color:var(--dsw-static-neutral-bluish-00,#fff)}.dsh-canvas-switch button:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#111827);outline-offset:2px}.dsh-canvas-switch.is-compact button{width:28px;padding:0;justify-content:center;display:inline-flex;align-items:center}.dsh-canvas-switch.is-compact button svg{width:16px;height:16px;display:block}.dsh-canvas-overlay{position:fixed;z-index:100;inset:0;background:#f5f7fa}.dsh-canvas-overlay.is-opening{visibility:hidden}.dsh-canvas-overlay[hidden]{display:none}.dsh-canvas-overlay iframe{display:block;width:100%;height:100%;border:0}body[data-ds-dark-theme] .dsh-canvas-overlay{background:#0f1115}' +
        // 会话头基线补偿:官方 titleRow(padding-top 10px + min-height 30px,28px 控件居中)
        // 的中心是 25px,而右栏 dockkit chrome(10px + 28px)与桌面壳窗控(top:11px + 26px)
        // 都是 24px —— 两者并排时差 1px(2026-09-10 像素实测:左 24.0 vs 右 23.0)。
        // 这条把会话头三个容器整体上移 1px。只位移不改布局,不参与 flex 计算。
        // ⚠ 与 desktop 线 themes/src/03-switcher.js 的同源规则**值必须一致**:那边走桌面壳
        // 主题注入(include_str! 编译期内嵌,改了要重建壳才生效),这里是页面级注入、
        // 支持 client-hmr 热更,刷新即生效 —— 两条通道写同一个值,改一处请同步另一处。
        '#root [class*="_headerActions"],#root [class*="_headerUtilities"],#root [class*="_headerCorner"]{position:relative;top:-1px}' +
        // 右栏以**推挤**方式展开时撤回桌面壳的让位:官方 panel 用 transform:translate(100%)
        // 移出屏幕而非卸载,所以 `data-sidebar-right-open` 才是可靠的开合判据 —— 展开时中栏
        // 右边界退到分栏线内,窗控压的是右栏头部,会话头再留 128px 安全区就是白空
        // (2026-09-10 实测:展开态 `⋯` 右边界距分栏线 144px = 128 让位 + 官方 28 padding)。
        // ⚠ 必须**覆写**,而不是给 desktop 那条让位规则加 :not() 门控 —— 已发布的壳二进制里
        // 嵌着无条件的 128px 规则,源文件改了页面上的旧规则不会消失;门控版在展开态"不匹配",
        // 等于没人覆盖它(上一版就是这么失效的)。这里靠特异性取胜:(1,3,1) > 原规则 (1,1,1)。
        // 28px 即官方 header 的 padding-right,与 desktop 线 themes/src/03-switcher.js 的
        // 同源规则**逐字一致**;此处是热更通道,刷新即生效。
        '#root:has([data-sidebar-right-panel="push"][data-sidebar-right-open]) header:has([data-conversation-header-corner]){padding-right:28px}'
      document.head.append(style)
      const host = document.createElement('div')
      host.className = 'dsh-canvas-host'
      host.innerHTML = '<section class="dsh-canvas-overlay" hidden><iframe title="会话布" src="/canvas/"></iframe></section>'
      document.body.append(host)
      // 视图切换按钮：注册到官方会话头 actions 插槽（React 组件，DSH 渲染）
      const switchViewStore = { view: 'dialog', onChange: null }
      const setSwitchView = view => {
        switchViewStore.view = view
        if (switchViewStore.onChange) switchViewStore.onChange(view)
      }
      function ViewSwitch() {
        const [view, setView] = react.useState(switchViewStore.view)
        const [compact, setCompact] = react.useState(false)
        const rootRef = react.useRef(null)
        const compactRef = react.useRef(false)
        react.useEffect(() => {
          switchViewStore.onChange = setView
          return () => { if (switchViewStore.onChange === setView) switchViewStore.onChange = null }
        }, [])
        // 测量并（必要时）切换形态。幂等：判定不变就不 setState，因此可以在每次渲染后
        // 与 ResizeObserver 回调里安全调用。必须在切换后重测 —— 形态本身改变占宽。
        const measure = react.useCallback(() => {
          const node = rootRef.current
          if (node === null) return
          const header = node.closest('header')
          if (header === null) return
          const paddingLeft = Number.parseFloat(window.getComputedStyle(header).paddingLeft) || 0
          const leftGap = node.getBoundingClientRect().left - header.getBoundingClientRect().left - paddingLeft
          const next = compactDecision({ leftGap, compact: compactRef.current })
          if (next !== compactRef.current) {
            compactRef.current = next
            setCompact(next)
          }
        }, [])
        react.useEffect(() => {
          measure()
          const node = rootRef.current
          const header = node === null ? null : node.closest('header')
          // 观察 header 而非自身：自身是 flex:none，被挤压时宽度不变，观察不到溢出。
          if (header === null || typeof ResizeObserver !== 'function') return undefined
          const observer = new ResizeObserver(() => measure())
          observer.observe(header)
          return () => observer.disconnect()
        }, [measure])
        // 每次渲染后校正一次（覆盖 header 宽度未变但同排其他控件变宽的情况）；
        // 滞回阈值保证形态不会来回抖动，measure 幂等故不构成渲染循环。
        react.useEffect(() => { measure() })
        const showingMap = view === 'map'
        const switchTo = next => () => {
          setSwitchView(next)
          if (next === 'map') open()
          else close()
        }
        return react.createElement('div', {
          ref: rootRef,
          className: compact ? 'dsh-canvas-switch is-compact' : 'dsh-canvas-switch',
          role: 'group',
          'aria-label': '视图切换',
        },
          react.createElement('button', { type: 'button', className: showingMap ? '' : 'active', 'aria-pressed': String(!showingMap), title: '对话', 'aria-label': '对话', onClick: switchTo('dialog') }, compact ? dialogGlyph() : '对话'),
          react.createElement('button', { type: 'button', className: showingMap ? 'active' : '', 'aria-pressed': String(showingMap), title: '会话布', 'aria-label': '会话布', onClick: switchTo('map') }, compact ? mapGlyph() : '会话布'))
      }
      // 注册到官方会话头 actions 插槽（与「后台任务」同 slot 并排渲染，DSH 布局驱动，
      // 主题令牌自动适配；退出插件生命周期时由 slots 机制统一回收）
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'canvas-view-switch',
        order: 25,
      }, ViewSwitch))
      const overlay = host.querySelector('.dsh-canvas-overlay')
      const frame = host.querySelector('iframe')

      // close/open 收敛到 switchViewStore：React 按钮状态与面板行为单向同步
      const close = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = false
        overlay.classList.remove('is-opening')
        overlay.hidden = true
        setSwitchView('dialog')
      }
      const send = (type, payload) => { frame.contentWindow?.postMessage({ source: 'dsh-canvas', type, ...payload }, location.origin) }
      // 外部视图槽（2026-09-10）：本包不认识任何具体视图，只把**页面级注册表**
      // `window.__DSH_CANVAS_VIEW_ITEMS__`（第三方插件写进去的 `{ id, label }`）转给画布页面，
      // 由画布在它自己的 `.view-switch`（「对话 / 会话布」）旁边多渲染一个按钮；
      // 点击后画布广播 `canvas:view`，由**注册方自己**监听并处理 —— 本包不解释 id 的语义，
      // 也不回调任何人（所以 canvas 与 ssh 之间没有代码耦合，只有一份页面级约定）。
      const externalViews = () => {
        const items = window.__DSH_CANVAS_VIEW_ITEMS__
        if (!Array.isArray(items)) return []
        return items
          .filter(item => item !== null && typeof item === 'object' && typeof item.id === 'string' && typeof item.label === 'string')
          .map(item => ({ id: item.id, label: item.label }))
      }
      const publishExternalViews = () => send('canvas:views', { items: externalViews() })
      let syncQueued = false
      let knownSessionIds = new Set()
      const liveUnsubscribers = new Map()
      const syncLiveSessions = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        for (const id of snapshot.ids) {
          if (liveUnsubscribers.has(id)) continue
          const scope = ctx.sessions.scope(id)
          const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
          if (session === undefined) continue
          const publish = () => {
            if (overlay.hidden) return
            const state = session.getSnapshot()
            const text = state.partial?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n') ?? ''
            send('canvas:live-reply', { sessionId: id, running: state.running, text })
          }
          liveUnsubscribers.set(id, session.subscribe(publish))
          publish()
        }
        for (const [id, unsubscribe] of liveUnsubscribers) if (!snapshot.ids.includes(id)) { unsubscribe(); liveUnsubscribers.delete(id) }
      }
      let syncFailureLogged = false
      const syncSessions = () => {
        if (syncQueued) return
        syncQueued = true
        queueMicrotask(() => {
          syncQueued = false
          const sessions = sessionSnapshot(ctx)
          const sessionIds = new Set(sessions.map(session => session.id))
          const removedSessionIds = [...knownSessionIds].filter(id => !sessionIds.has(id))
          knownSessionIds = sessionIds
          // 失败必须留痕：2026-09-26 之前这里是个空 catch，把「每次同步都 400」
          // 吞得一干二净 —— 画布里的 DSH 会话节点长期不更新，却没有任何信号。
          // 只记一次（同步每次会话变化都跑），避免刷屏淹没真问题。
          const report = detail => {
            if (syncFailureLogged) return
            syncFailureLogged = true
            console.warn('dsh-canvas: 会话列表同步失败（画布节点可能滞后）— ' + detail)
          }
          void fetch('/canvas/api/sessions/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions, removedSessionIds }) })
            .then(response => { if (!response.ok) report('HTTP ' + response.status) })
            .catch(error => report(error instanceof Error ? error.message : String(error)))
        })
      }
      const syncTheme = () => {
        const dark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
        // 品牌令牌随主题下发（pure=#3964fe 原生蓝 / zafkiel=#c23a2e / kurkuriel=#9e1b1b），
        // 画布 iframe 是独立文档不继承令牌，读到什么发什么；读不到则画布保持兜底蓝。
        let accent = ''
        try {
          accent = getComputedStyle(document.documentElement).getPropertyValue('--dsw-static-deepseek-450').trim()
          if (accent === '') accent = getComputedStyle(document.body).getPropertyValue('--dsw-static-deepseek-450').trim()
        } catch { /* 父文档样式不可读（极少见），保持画布默认色 */ }
        if (!/^#[0-9a-f]{3,8}$/i.test(accent) && !/^rgba?\(/i.test(accent)) accent = ''
        // 读不到令牌（桌面主题样式层被重渲染清掉的自愈窗口期）时只发明暗，
        // 保留画布现有品牌色，避免被打回兜底蓝且无人再触发重发。
        const payload = { dark }
        if (accent !== '') payload.accent = accent
        send('canvas:theme', payload)
      }
      // 桌面端无边框窗口的窗控按钮组（V4 #miasaki-titlebar .tb-group，V3 兜底 .tb-capsule，
      // fixed top:5px right:8px）零占位浮在页面右上角，画布工具条同为 fixed 右上会叠压。
      // 量出按钮组左缘到视口右缘的距离 + 余量下发，iframe 用它做 --canvas-chrome-reserve；
      // 普通浏览器无窗控组传 0。
      //
      // 取数口径（2026-09-27）：**契约优先，DOM 兜底**。
      //   ① 契约在位（`d.has('chrome.bounds')`）→ 用 `d.chrome.bounds()` 量得的**壳窗控按钮组**
      //      （`#miasaki-titlebar .tb-group`）视口矩形取数；量不到（返回 null / 非桌面壳 / 按钮未挂载）
      //      一律 0 —— 契约量的是壳的资产，**不是**官方 DSH chrome 的位置，两者不可互推。
      //   ② 契约缺失（浏览器直开 / 旧壳）→ 退化为下面这段一次性 DOM 探针，行为与契约出现之前
      //      逐字等价（.tb-group 优先 + .tb-capsule 兜底）。
      //
      // 为什么必须订阅而不是「量一次就够」：窗口尺寸**确实**不影响按钮组的 right 偏移，但
      // **同排其他插件会往按钮组里插按钮** —— sidebar 线的终端键插在 `.tb-group` 首位
      // （dsh-miasaki-sidebar/client.js 的 titlebarButton.ensure，宽度 108px → 136px）。
      // 画布只在 open() / onFrameLoad() / showMapOverlay() 三条路径各量一次，注入若发生在
      // 首次取数之后，就会**一直少让 28px** 且不会自愈。故契约在位时必须订阅 chrome.onChange
      // （注册在下方，退订挂在 apply 的清理效果里）；契约缺失时没有变更源，只能一次性探针。
      const syncChrome = () => {
        let reserve = 0
        try {
          // 「契约可用」= 对象在、且能力表里登记了 chrome.bounds（契约文档的推荐写法
          // `d && d.has && d.has(...)`）。子 frame 只拿到没有 has 的空壳对象，这里按
          // 「契约不可用」处理 → 走下面的 DOM 兜底，与浏览器直开同一条路径。
          if (d !== undefined && typeof d.has === 'function' && d.has('chrome.bounds')) {
            const box = d.chrome?.bounds?.() ?? null
            if (box !== null && box.width > 0) reserve = Math.ceil(window.innerWidth - box.left + 6)
          } else {
            const capsule = document.querySelector('#miasaki-titlebar .tb-group') ??
              document.querySelector('#miasaki-titlebar .tb-capsule')
            if (capsule instanceof HTMLElement) {
              const rect = capsule.getBoundingClientRect()
              if (rect.width > 0) reserve = Math.ceil(window.innerWidth - rect.left + 6)
            }
          }
        } catch { /* 无父文档 / 契约或探针异常：reserve 兜底 0 */ }
        send('canvas:chrome', { reserve })
      }
      // 订阅按钮组的尺寸 / 位置变化（壳窗控组被插入新按钮、被重排、或 DPI / 窗口变化）。
      // 契约缺失时无订阅源，`unsubscribeChrome` 为 null —— 由上面的 DOM 探针承担。
      const unsubscribeChrome = d !== undefined && typeof d.has === 'function' && d.has('chrome.onChange')
        ? d.chrome.onChange(syncChrome)
        : null
      const syncCurrentSession = () => {
        syncSessions()
        syncLiveSessions()
        syncTheme()
        syncChrome()
        if (!overlay.hidden) {
          send('canvas:workspaces', { workspaces: workspaceSnapshot(ctx) })
          send('canvas:current-session', { session: currentSession(ctx) })
        }
      }
      let mapOpenFallback = 0
      let mapOpening = false
      const showMapOverlay = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = false
        overlay.hidden = false
        overlay.classList.remove('is-opening')
        syncCurrentSession()
      }
      const open = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = true
        setSwitchView('map')
        // Keep the iframe laid out while hidden so its canvas can receive a
        // real scroll offset. display:none would clamp scrollTop back to zero.
        overlay.hidden = false
        overlay.classList.add('is-opening')
        window.requestAnimationFrame(() => {
          send('canvas:map-opened')
          publishExternalViews()
          syncCurrentSession()
        })
        mapOpenFallback = window.setTimeout(showMapOverlay, 300)
      }
      const onFrameLoad = () => {
        syncCurrentSession()
        publishExternalViews()
        if (mapOpening) send('canvas:map-opened')
      }
      const onMessage = event => {
        if (event.origin !== location.origin || event.data?.source !== 'dsh-canvas') return
        if (event.data.type === 'canvas:close') return close()
        if (event.data.type === 'canvas:map-ready') return showMapOverlay()
        if (event.data.type === 'canvas:request-current') {
          send('canvas:workspaces', { workspaces: workspaceSnapshot(ctx) })
          return send('canvas:current-session', { session: currentSession(ctx) })
        }
        if (event.data.type === 'canvas:open-session') {
          // DSH 0.1.7：导航 API 是 ctx.uiWorkspace.openSession（ctx.sessions.open
          // 已从 ISessions 删除，旧调用每次都是 TypeError）。失败带走真实原因。
          try { ctx.uiWorkspace.openSession(event.data.sessionId); close() } catch (error) { reportBridgeFailure('canvas:open-session', error); send('canvas:bridge-error', { message: `关联的 DSH 会话已不可用（${reasonOf(error)}）` }) }
          // Best-effort anchor to the requested turn: chat nodes expose their
          // source event seq (anchorSeq) and render with data-chat-anchor-key,
          // so resolve seq -> node key -> scroll once the view materializes.
          const seq = event.data.seq
          if (Number.isInteger(seq)) {
            const tryScroll = attempt => {
              const scope = ctx.sessions.scope(event.data.sessionId)
              const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
              if (session === undefined) return
              const chat = session.getSnapshot()?.chat
              if (chat === undefined) return
              let key = undefined
              for (const node of chat.nodes.values()) {
                if (node.anchorSeq === seq) { key = node.key; break }
              }
              if (key !== undefined) {
                const row = document.querySelector(`[data-chat-anchor-key="${CSS.escape(key)}"]`)
                if (row instanceof HTMLElement) row.scrollIntoView({ block: 'start' })
                return
              }
              if (attempt < 3) window.setTimeout(() => tryScroll(attempt + 1), 500)
            }
            window.setTimeout(() => tryScroll(0), 300)
          }
          return
        }
        if (event.data.type === 'canvas:activate-session') {
          // Bidirectional current-session sync: switch DSH's current session
          // without closing the map; the sessions-list subscription re-sends
          // canvas:current-session so the map follows the new highlight.
          // 同 canvas:open-session：0.1.7 起走 ctx.uiWorkspace.openSession。
          try { ctx.uiWorkspace.openSession(event.data.sessionId) } catch (error) { reportBridgeFailure('canvas:activate-session', error); send('canvas:bridge-error', { message: `关联的 DSH 会话已不可用（${reasonOf(error)}）` }) }
          return
        }
        if (event.data.type === 'canvas:fork-session') {
          const atSeq = Number.isInteger(event.data.atSeq) ? event.data.atSeq : undefined
          ctx.sessions.fork({ sessionId: event.data.sessionId, atSeq, increaseTitle: true }).then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('canvas:forked-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? 'DSH 分支' } })
          }).catch(() => { send('canvas:bridge-error', { message: 'DSH 分支创建失败，请确认源会话已经完成当前轮次' }) })
          return
        }
        if (event.data.type === 'canvas:send-message') {
          const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
          if (text === '') return send('canvas:bridge-error', { requestId: event.data.requestId, message: '消息不能为空' })
          prompt(event.data.sessionId, text).then(() => {
            send('canvas:message-sent', { requestId: event.data.requestId, sessionId: event.data.sessionId })
          }).catch(error => {
            send('canvas:bridge-error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : 'DSH 消息发送失败' })
          })
          return
        }
        if (event.data.type === 'canvas:create-session') {
          const workspaceId = typeof event.data.workspaceId === 'string' && event.data.workspaceId !== '' && event.data.workspaceId !== 'dsh-ungrouped' ? event.data.workspaceId : undefined
          const cwd = typeof event.data.cwd === 'string' && event.data.cwd !== '' ? event.data.cwd : undefined
          const create = workspaceId === undefined ? ctx.sessions.create(cwd === undefined ? {} : { cwd }) : ctx.sessions.create({ workspaceId })
          create.then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('canvas:created-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? '新会话', cwd: snapshot.byId[id]?.cwd ?? cwd ?? null } })
          }).catch(() => { send('canvas:bridge-error', { requestId: event.data.requestId, message: 'DSH 会话创建失败，请先在 DSH 选择工作目录' }) })
        }
      }
      const onKeyDown = event => { if (event.key === 'Escape' && !overlay.hidden) close() }
      // Follow DSH's live theme switch — both signals, one observer:
      // body[data-ds-dark-theme] is the web client's dark-mode flag, and
      // html[data-miasaki-theme] is the desktop shell's brand-theme attribute
      // (hot-swapped with its style layer, no reload); without watching the
      // latter the map keeps the old brand color after a desktop theme switch.
      const themeObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => syncTheme())
      if (themeObserver !== null && document.body) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-miasaki-theme'] })
      }
      const unsubscribeSessions = ctx.sessions.list.subscribe(syncCurrentSession)
      const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(syncCurrentSession)
      frame.addEventListener('load', onFrameLoad)
      window.addEventListener('message', onMessage)
      window.addEventListener('keydown', onKeyDown)
      // 注册表变化（插件装/卸外部视图项）时就地下发一次，不等下一次开浮层。
      window.addEventListener('dsh-canvas:view-items', publishExternalViews)
      ctx.effect(() => () => {
        // 复位幂等守卫：允许后续（HMR 完整回收后/插件重装）重新挂载一份
        window.__DSH_CANVAS_BOOTED__ = false
        frame.removeEventListener('load', onFrameLoad)
        window.removeEventListener('message', onMessage)
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('dsh-canvas:view-items', publishExternalViews)
        themeObserver?.disconnect()
        // 契约订阅同批退订（与主题观察者同居清理路径）：漏掉会让壳在插件卸载后继续
        // 回调已销毁的闭包 —— HMR/重挂后叠加出多份发送者。
        if (typeof unsubscribeChrome === 'function') unsubscribeChrome()
        unsubscribeSessions()
        unsubscribeWorkspaces()
        for (const unsubscribe of liveUnsubscribers.values()) unsubscribe()
        host.remove()
        style.remove()
      }, 'canvas: web workspace switch')
    }
    return module.exports
  },
})
