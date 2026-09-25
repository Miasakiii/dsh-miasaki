// Client half of @miasaki/dsh-ssh.
//
// 路线丁（全屏浮层，方案 2026-09-14-ssh-fullscreen-overlay-plan.md）：SSH 是**会话之外的
// 全屏功能模块** —— body 级宿主 + 常驻 iframe + visibility 隐藏 + sessionStorage 开关记忆。
// 入口有三处：① 会话头胶囊（conversation.session.header.actions，order 26，与 canvas
// 胶囊合成一体）；② hero 态 launcher（shell.overlay，order 40，方案 §14）；③ 画布页
// 外部视图槽按钮（canvas:view 广播）。
//
// 2026-09-15 D3 清理：`conversation.view` 注册与官方 tab 委托三件套
// （ownTab/hideOwnTab/restoreTabs/viewIsSsh/selectSsh）**整体删除** —— 浮层已成为唯一
// 形态，tab 委托是回退期产物；主题桥、chrome-reserve、消息协议由浮层 iframe 承接。
window.__ModuleLoader__.load({
  id: '@miasaki/dsh-ssh',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')

    // ---- 首帧防闪（B2 附带）--------------------------------------------------
    // 会话头与本线 launcher 是**两棵不同的 fiber**（前者在 `conversation` 面板里，后者在
    // root 的 `shell.overlay` 里）。React 的 render 阶段不改 DOM ⇒ 首次渲染时 launcher
    // 读到的 DOM **还没有**胶囊（commit 之后才有），判据必然先返回 true。若订阅放在
    // `useEffect`（paint **之后**）里，刷新时停在会话窗口就会**先画出一帧多余的 SSH**。
    // `useLayoutEffect` 在 commit 后、paint 前执行，其 setState 的补偿渲染也在同一帧内
    // 完成 ⇒ 那一帧不会被画出来。单测的 react 桩没有 useLayoutEffect，退回 useEffect。
    const usePaintEffect = typeof react.useLayoutEffect === 'function'
      ? react.useLayoutEffect
      : react.useEffect

    // ---- 会话头部窄宽度自适应（2026-09-10）----------------------------------
    // 与 canvas 线同款判据（阈值、滞回、观察对象都一致），但**各自实现、不共享代码**
    // —— 六线零耦合。官方会话头里 titleCluster 可被压到 0，而 headerActions 是
    // flex:none：中栏窄到放不下时 actions 会溢出压住 headerUtilities，标题也被裁没。
    // 判据是「自身左边界到 header 内容区左边的距离」＝留给标题的余量；进入 / 退出
    // 用两个阈值形成滞回，否则形态切换本身改变占宽会把判定推来推去（抖动）。
    // 数据与归因见 dsh-miasaki-canvas/design/2026-09-10-conversation-header-crowding-fix.md。
    const COMPACT_ENTER_PX = 120
    const COMPACT_RELEASE_PX = 200
    const compactDecision = ({ leftGap, compact, enter = COMPACT_ENTER_PX, release = COMPACT_RELEASE_PX }) =>
      compact ? leftGap < release : leftGap < enter

    /** 紧凑形态的终端图标（内联 SVG，跟随 currentColor 与主题令牌）。 */
    const terminalGlyph = () => react.createElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      react.createElement('path', {
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        d: 'M3 4.5 6.5 8 3 11.5M8.5 11.5h4.5',
      }))

    // 与 `.dsh-canvas-switch` 同源视觉（同一组主题令牌、同样的 28px 按钮与 999px 圆角）。
    // 上下 padding 必须为 0：3px 上下 padding + 1px 边框 ×2 + 28px = 36px，会把官方
    // titleRow（min-height:30px）撑高 6px，行内**所有**控件（含官方那三个）居中后整体下移
    // —— canvas 2026-09-10 逐像素量过这个坑，同排控件的高度契约必须守住：
    // 0 上下 padding 时总高 = 1 + 28 + 1 = 30px。
    const SWITCH_CSS = '.dsh-ssh-switch{display:flex;align-items:center;gap:2px;margin-left:2px;padding:0 3px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:999px;background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.92));backdrop-filter:blur(10px)}' +
      '.dsh-ssh-switch button{height:28px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:var(--dsw-alias-label-secondary,#6b7280);font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}' +
      '.dsh-ssh-switch button:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}' +
      '.dsh-ssh-switch button.active{background:var(--dsw-static-deepseek-450,#111827);color:var(--dsw-static-neutral-bluish-00,#fff)}' +
      '.dsh-ssh-switch button:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#111827);outline-offset:2px}' +
      '.dsh-ssh-switch.is-compact button{width:28px;padding:0;justify-content:center;display:inline-flex;align-items:center}' +
      '.dsh-ssh-switch.is-compact button svg{width:16px;height:16px;display:block}' +
      // ---- 与 canvas 胶囊合成同一个控件（2026-09-10 二次优化）------------------
      // 两个胶囊并排即使在视觉上"同款"，中间那道 8px 缝仍然读作「两组控件」。这里把
      // canvas 胶囊的右端打开、本段左端打开，再用负 margin 吃掉 headerActions 的 gap
      // （官方 `headerActions` 为 gap:8px），于是一个胶囊里就是「对话 | 会话布 | SSH」
      // 三段，中间那条竖线是本段自己的左边框。
      // 全部是**纯 CSS 覆盖**：canvas 文件一行未改；canvas 不在场、或未来有别的插件插在
      // 两者之间时 `+` 不匹配 → 本段退回完整胶囊，退化方向是「又变回两个胶囊」而不是破版。
      '.dsh-canvas-switch:has(+ .dsh-ssh-switch){border-top-right-radius:0;border-bottom-right-radius:0;border-right:0}' +
      '.dsh-canvas-switch + .dsh-ssh-switch{margin-left:-8px;border-top-left-radius:0;border-bottom-left-radius:0}' +
      // 同一个控件里不能同时亮两段：停在 SSH 视图时「对话」段不该再亮（它此时的语义是
      // 「DSH 原生会话视图」，而当前正停在 SSH 上）。:not(:hover) 让 hover 反馈照旧。
      '.dsh-canvas-switch:has(+ .dsh-ssh-switch button.active) button[aria-label="对话"].active:not(:hover){background:transparent;color:var(--dsw-alias-label-secondary,#6b7280)}' +
      // （2026-09-15 D3-F1）这里原有「SSH 视图下隐藏官方对话列宽拖拽手柄」的 :has() 覆盖规则，
      // 它依赖回退视图的 DOM 形态 —— 当年 SSH 是以 conversation.view 挂载的，iframe 落在
      // div[data-phase] 内，规则才可能命中。回退视图随 D3 整体删除后该选择器**永不命中**，
      // 属死代码；而浮层形态本身就是全屏覆盖，官方手柄无需再被本线隐藏 —— 故整条删除。
      // 反证：实机验收在会话态读到官方手柄 display:block（方案 §18 C4c）。
      // ---- 全屏浮层（路线丁 D1）----------------------------------------
      // 与 canvas 同构：body 级宿主 + fixed inset:0 + z-index:100 + 常驻 iframe。
      // **唯一偏离 canvas**（D0 §12 实测后维持）：关闭态用 visibility:hidden +
      // pointer-events:none，不用 display:none —— 元素仍在布局中，尺寸恒等视口，
      // RO 不误触发，隐藏期间输出照收、重开即原样。懒加载：iframe 首开才赋 src。
      '.dsh-ssh-overlay{position:fixed;z-index:100;inset:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#f5f7fa)}' +
      'body[data-ds-dark-theme] .dsh-ssh-overlay{background:#0f1115}' +
      '.dsh-ssh-overlay.is-closed{visibility:hidden;pointer-events:none}' +
      // flex:1 而非 height:100% —— 顶部那条 .dsh-ssh-bar 占固定高度，iframe 取剩余高度。
      '.dsh-ssh-overlay iframe{display:block;width:100%;flex:1 1 auto;min-height:0;border:0;background:transparent}' +
      '.dsh-ssh-overlay .dsh-ssh-loading{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:var(--dsw-alias-label-secondary,#6b7280);font:500 13px Inter,system-ui,sans-serif}' +
      // ---- D1.1 无会话头时的常驻入口（shell.overlay，方案 §14）----------------
      // 类名**故意不复用** `.dsh-ssh-switch`：`ownHeader()` 拿 `.dsh-ssh-switch` 当会话头
      // 锚点（`document.querySelector('.dsh-ssh-switch').closest('header')`），若 launcher
      // 同用一个类，querySelector 可能先命中浮层里这颗，锚点随即失效、tab 三件套全哑。
      // 视觉并列写一份（同令牌、同圆角、同 28px），不共享类名。
      //
      // `pointer-events:none` 必须带 !important：官方 overlayLayer 的规则是
      // `.xxx_overlayLayer>*{pointer-events:auto}`（特异性同为 (0,1,0)），谁后注入谁赢，
      // 顺序不由我们决定。容器一旦被设回 auto，`inset:0` 就**挡住整个应用**——
      // 这是官方 catalog 明示的坑（"entries opt back into pointer events"）。
      '.dsh-ssh-launcher{position:absolute;inset:0;pointer-events:none!important}' +
      // 与桌面壳窗控**同一视觉语言**：无底、无框、hover 才显淡底、同款小圆角；
      // top/height 由 syncChrome 从窗控组**实测**（见下），不写死。
      // 首版是带底带框的 999px 胶囊 + 写死 top:14px —— 实测混在一排线性图标与圆形
      // 头像里太重、不协调，而且比窗控组（top:5px）低 9px，根本没对齐。
      '.dsh-ssh-launcher button{position:absolute;top:var(--dsh-ssh-chrome-top,5px);right:calc(var(--dsh-ssh-chrome-reserve,0px) + 16px);pointer-events:auto;height:var(--dsh-ssh-chrome-height,28px);padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}' +
      '.dsh-ssh-launcher button:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}' +
      '.dsh-ssh-launcher button:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#111827);outline-offset:2px}'

    // ---- 主题桥接（U1，plan §4.2）------------------------------------------
    // 宿主是唯一主题源：这里读宿主**最终计算样式**（body 优先、根元素兜底），白名单化后
    // 经同源 postMessage 下发给 /ssh/ 的 iframe；iframe 侧换成自己的 --ssh-* 语义变量
    // 与 xterm 主题。快照同时写进页面级注册表 `window.__DSH_SSH_THEME__`，iframe 首帧
    // 可同源直读，避免「先闪兜底底色再切主题」。SSH 不调用 setTheme/overrideTokens，
    // 也不另设皮肤选择器 —— appearance 皮肤落地后其最终样式自动被这里读到。
    const THEME_TOKENS = [
      ['bgBase', '--dsw-alias-bg-base'],
      ['layer1', '--dsw-alias-bg-layer-1'],
      ['layer2', '--dsw-alias-bg-layer-2'],
      ['overlay', '--dsw-alias-bg-overlay'],
      ['border', '--dsw-alias-border-l2'],
      ['textPrimary', '--dsw-alias-label-primary'],
      ['textSecondary', '--dsw-alias-label-secondary'],
      ['hoverBg', '--dsw-alias-interactive-bg-hover'],
      ['accent', '--dsw-static-deepseek-450'],
    ]
    function readThemeSnapshot() {
      const dark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
        || document.documentElement?.hasAttribute?.('data-ds-dark-theme') === true
      const readToken = name => {
        for (const scope of [document.body, document.documentElement]) {
          if (scope === null || scope === undefined) continue
          try {
            const value = getComputedStyle(scope).getPropertyValue(name).trim()
            if (value !== '') return value
          } catch { /* 父文档样式不可读（极少见） */ }
        }
        return ''
      }
      const tokens = {}
      for (const [key, name] of THEME_TOKENS) {
        const value = readToken(name)
        if (value !== '') tokens[key] = value
      }
      let typography = null
      try {
        const style = getComputedStyle(document.body ?? document.documentElement)
        typography = { fontFamily: style.fontFamily ?? '', fontSize: style.fontSize ?? '' }
      } catch { /* 保持 iframe 兜底字体 */ }
      return { dark, tokens, typography }
    }

    module.exports.inject = ['slots']

    module.exports.apply = ctx => {
      // Idempotence guard: DSH HMR / re-applies must not stack a second entry.
      if (window.__DSH_SSH_BOOTED__) return
      window.__DSH_SSH_BOOTED__ = true

      const VIEW_LABEL = 'SSH'

      const style = document.createElement('style')
      style.textContent = SWITCH_CSS
      document.head.append(style)

      // ---- 全屏浮层（路线丁 D1：宿主 + 常驻 iframe + 懒加载 + 开关记忆）----
      // 与 canvas 同构（body 级宿主，浮层在会话 DOM 之外，切会话不消失）；唯一
      // 偏离是关闭态用 visibility 而非 display（D0 §12 实测后维持，理由见方案
      // §12.3：visibility 是规范行为，尺寸恒等视口；display:none 靠的是渲染暂停
      // 这种实现细节）。开关状态记 sessionStorage（用户意图，非插件生命周期）。
      const OVERLAY_STORE_KEY = 'dsh-ssh:overlay-open'
      const readOverlayMemory = () => {
        try { return window.sessionStorage.getItem(OVERLAY_STORE_KEY) === '1' } catch { return false }
      }
      const writeOverlayMemory = open => {
        try { window.sessionStorage.setItem(OVERLAY_STORE_KEY, open ? '1' : '0') } catch { /* 无痕模式：记忆不可用则刷新后回到关闭态 */ }
      }
      const host = document.createElement('div')
      host.className = 'dsh-ssh-host'
      host.innerHTML =
        '<section class="dsh-ssh-overlay is-closed">' +
        '<span class="dsh-ssh-loading" hidden>正在加载终端…</span>' +
        '<iframe title="SSH"></iframe>' +
        '</section>'
      document.body.append(host)
      const overlay = host.querySelector('.dsh-ssh-overlay')
      const frame = host.querySelector('iframe')
      const loading = host.querySelector('.dsh-ssh-loading')
      // ---- 顶栏消息协议（D2）----------------------------------------------
      // 浮层里的 SSH 页面自绘顶栏（app.js 侧），它的「对话」「会话布」两颗按钮的
      // 行为落在宿主侧：① `ssh:close` —— 关浮层，并把焦点还给入口（最后一次触发
      // open 的那颗；找不到就还 body，绝不把焦点丢进 iframe）；② `ssh:view` ——
      // 关自己 + 委托点击 canvas 胶囊的「会话布」段（关浮层的同时让 canvas 的
      // 胶囊激活态同步复位，直接改 overlay.hidden 会让它状态不一致 —— 与既有
      // dismissCanvasOverlay 同一条纪律）。消息带 token 防伪（值随机、不进任何日志）。
      const overlayMsgToken = Math.random().toString(36).slice(2)
      const lastOpener = { el: null }
      const openOverlayFrom = el => { lastOpener.el = el ?? null; return openOverlay() }
      const onOverlayMessage = event => {
        if (event.origin !== location.origin) return
        if (event.source !== frame.contentWindow) return
        const data = event.data
        if (data === null || typeof data !== 'object') return
        if (data.source !== 'dsh-ssh' || data.overlayToken !== overlayMsgToken) return
        if (data.type === 'ssh:close') {
          closeOverlay()
          const target = lastOpener.el !== null && lastOpener.el.isConnected ? lastOpener.el : document.body
          try { target.focus({ preventScroll: true }) } catch { /* 不可聚焦则还 body */ }
        } else if (data.type === 'ssh:view' && data.view === 'canvas') {
          closeOverlay()
          // canvas 不在场时 querySelector 落空 → 静默收手（降级：只关自己，不报错）。
          const back = document.querySelector('.dsh-canvas-switch button[aria-label="会话布"]')
          if (back !== null) back.click()
        }
      }
      window.addEventListener('message', onOverlayMessage)
      // iframe 懒加载：首开才赋 src；不碰 SSH 的用户零带宽开销（§5.8）。
      let frameBooted = false
      // 打开流程：首次赋 src（加载态占位防白）→ 解除关闭态。close 与 open 都幂等。
      const openOverlay = () => {
        if (!frameBooted) {
          frameBooted = true
          loading.hidden = false
          frame.src = '/ssh/'
          const markReady = () => { loading.hidden = true }
          frame.addEventListener('load', markReady, { once: true })
          // 加载异常时限兑底：3s 后无论如何撤掉加载态（iframe 内容自己会渲染空态）。
          window.setTimeout(markReady, 3000)
        } else {
          // 重开补一次主题快照（去重逻辑在 push 里）：关闭期间宿主可能换过主题。
          pushThemeSnapshot()
        }
        // 每次打开都重发一次 chrome 消息：浮层打开期间用户无法切换会话，
        // 所以"这一刻的 canvas 可用性"就是顶栏整个可见期的取值（§16.3 的诚实降级）。
        syncChrome()
        overlay.classList.remove('is-closed')
        writeOverlayMemory(true)
        return true
      }
      const closeOverlay = () => {
        overlay.classList.add('is-closed')
        writeOverlayMemory(false)
        return false
      }
      const overlayIsOpen = () => !overlay.classList.contains('is-closed')

      // ---- 桌面壳窗控 reserve（照抄 canvas syncChrome 量法，D0 ③ 已实测）--
      // 两个消费者：① 浮层内 iframe 走 postMessage（iframe 侧的 `--ssh-chrome-reserve`）；
      // ② 宿主里的 launcher 走宿主 CSS 变量 —— 它不在 iframe 内，收不到 postMessage。
      // 按钮组宽度与 right 偏移固定、不随窗口尺寸变化（canvas 同款判据），故量一次即可；
      // 但**必须在 apply 期间主动调一次**：下面的 load 监听只在 iframe 加载时才跑，
      // 而 iframe 是懒加载的（用户没开过浮层就永远不加载），靠它设变量会漏。
      const syncChrome = () => {
        let reserve = 0
        let chromeTop = 5
        let chromeHeight = 28
        try {
          const capsule = document.querySelector('#miasaki-titlebar .tb-group') ??
            document.querySelector('#miasaki-titlebar .tb-capsule')
          if (capsule instanceof HTMLElement) {
            const rect = capsule.getBoundingClientRect()
            if (rect.width > 0) {
              reserve = Math.ceil(window.innerWidth - rect.left + 6)
              // launcher 的**垂直对齐**：与窗控组同顶同高。量不到就退回默认 5 / 28
              // （普通浏览器没有窗控，这两个值不影响任何人）。限界防呆：窗控量出的
              // 高度不该超出 20–44，超了说明量错了，宁可退回默认也不跟着摆歪。
              const top = Number.parseFloat(window.getComputedStyle(capsule).top)
              if (Number.isFinite(top) && top >= 0 && top <= 40) chromeTop = Math.round(top)
              if (rect.height >= 20 && rect.height <= 44) chromeHeight = Math.round(rect.height)
            }
          }
        } catch { /* 无父文档场景兑底 0 */ }
        // 顶栏「会话布」段的可用性（D2 语义边界）：canvas 只注册在会话头 actions 槽
        // ⇒ hero 态（无会话头）没有任何胶囊可供委托，顶栏那一段必然是死按钮。
        // 与其让用户点了没反应，不如让浮层**不渲染**它 —— 宿主把事实随 chrome 消息下发。
        // 判据失败时保守显示（宁可多一颗按钮，也别让别人把入口判丢）。
        let canvasAvailable = true
        try { canvasAvailable = document.querySelector('.dsh-canvas-switch') !== null } catch { /* 查询失败：保守显示 */ }
        try {
          const root = document.documentElement.style
          root.setProperty('--dsh-ssh-chrome-reserve', reserve + 'px')
          root.setProperty('--dsh-ssh-chrome-top', chromeTop + 'px')
          root.setProperty('--dsh-ssh-chrome-height', chromeHeight + 'px')
        } catch { /* 只读环境 */ }
        try { frame.contentWindow?.postMessage({ source: 'dsh-ssh', type: 'chrome', version: 1, reserve, canvasAvailable, overlayToken: overlayMsgToken }, location.origin) } catch { /* iframe 刚卸载 */ }
      }

      // ---- 主题桥（浮层与 view 两个 iframe 共用；快照去重逻辑同 U1）-------
      let themeLastKey = ''
      let themeRevision = 0
      const pushThemeSnapshot = () => {
        let snapshot
        try { snapshot = readThemeSnapshot() } catch { return }
        const key = JSON.stringify(snapshot)
        if (key === themeLastKey) return // 同一快照不重发（去重，plan §4.2-7）
        themeLastKey = key
        themeRevision += 1
        try { window.__DSH_SSH_THEME__ = { source: 'dsh-ssh', type: 'theme', version: 1, revision: themeRevision, ...snapshot } } catch { /* 只读环境 */ }
        try { frame.contentWindow?.postMessage({ source: 'dsh-ssh', type: 'theme', version: 1, revision: themeRevision, ...snapshot }, location.origin) } catch { /* iframe 刚卸载 */ }
      }
      frame.addEventListener('load', () => { themeLastKey = ''; pushThemeSnapshot(); syncChrome() })

      // 「会话布」是 canvas 的全屏浮层（z-index 100、盖住整个 frame）：它开着时切视图
      // 只会看到浮层。这里先走 canvas 自己的「对话」按钮把它关掉 —— 用它的按钮而不是
      // 直接 `overlay.hidden = true`，是为了让 canvas 的胶囊激活态同步复位（直接改
      // DOM 会让它以为会话布还开着）。canvas 不在场时 querySelector 落空，跳过即可。
      const dismissCanvasOverlay = () => {
        const overlay = document.querySelector('.dsh-canvas-overlay')
        if (overlay === null || overlay.hidden) return
        const back = document.querySelector('.dsh-canvas-switch button[aria-label="对话"]')
        if (back === null) return
        back.click()
      }
      // ---- 在「会话布」页面里也给出 SSH 入口（2026-09-10 第六次反馈）---------
      // 用户要的是「会话布页面里那组切换按钮旁边多一个 SSH」，**不是**页面顶上多一条栏
      // —— 上一版曾在浮层之上补整条工具条，被否掉了（「为什么会多出一整个上栏」）。
      // 那组按钮（`对话 | 会话布`）在画布自己的 iframe 文档里（`/canvas/` 的
      // `topbar > .view-switch`），宿主 DOM 碰不到，所以走 canvas 暴露的**外部视图槽**：
      //   1. 本线把视图项写进页面级注册表 `window.__DSH_CANVAS_VIEW_ITEMS__`，
      //      并派发 `dsh-canvas:view-items` 通知；
      //   2. canvas 的 client 半在 iframe 就绪 / 注册表变化时把它转给画布页面；
      //   3. 画布页面在它自己的 `.view-switch` 里多渲染一个按钮；
      //   4. 点击后画布广播 `canvas:view`，本线收到就关浮层 + 切视图。
      // canvas 侧完全不知道 SSH 的存在，只认「有外部视图项」这一件事。
      const VIEW_ITEM = { id: 'ssh', label: VIEW_LABEL }
      const canvasViewItems = window.__DSH_CANVAS_VIEW_ITEMS__ ?? (window.__DSH_CANVAS_VIEW_ITEMS__ = [])
      const publishCanvasViews = () => {
        if (!canvasViewItems.some(item => item !== null && typeof item === 'object' && item.id === VIEW_ITEM.id)) {
          canvasViewItems.push(VIEW_ITEM)
        }
        window.dispatchEvent(new CustomEvent('dsh-canvas:view-items', { detail: { items: canvasViewItems.slice() } }))
      }
      const onCanvasView = event => {
        if (event.origin !== location.origin) return
        const data = event.data
        if (data?.source !== 'dsh-canvas' || data.type !== 'canvas:view' || data.id !== VIEW_ITEM.id) return
        // 画布里的 SSH 按钮：关画布浮层（保持它的胶囊激活态同步）→ 开 SSH 浮层。
        // 无入口元素可还焦（消息源在 iframe 里），记 null ⇒ 关闭时焦点还 body。
        dismissCanvasOverlay()
        openOverlayFrom(null)
      }
      window.addEventListener('message', onCanvasView)
      publishCanvasViews()

      /** 第一行入口：与「对话 / 会话布」并排的「SSH」胶囊按钮。 */
      function SshSwitch() {
        const [active, setActive] = react.useState(false)
        const [compact, setCompact] = react.useState(false)
        const rootRef = react.useRef(null)
        const compactRef = react.useRef(false)
        // 测量并（必要时）切换形态。幂等：判定不变就不 setState，因此可以在每次渲染后
        // 与 ResizeObserver 回调里安全调用。必须在切换后重测 —— 形态本身改变占宽。
        const measure = react.useCallback(() => {
          const node = rootRef.current
          if (node === null) return
          const header = node.closest('header')
          if (header === null) return
          const nodeRect = node.getBoundingClientRect()
          const rect = header.getBoundingClientRect()
          const paddingLeft = Number.parseFloat(window.getComputedStyle(header).paddingLeft) || 0
          const leftGap = nodeRect.left - rect.left - paddingLeft
          const next = compactDecision({ leftGap, compact: compactRef.current })
          if (next !== compactRef.current) {
            compactRef.current = next
            setCompact(next)
          }
        }, [])
        react.useEffect(() => {
          // 每次 header 子树变化都校正一次：同步激活态（浮层开关状态驱动）。
          // D4 尾项②（§17 已知风险②）：三件套删除后 aria-selected 已无消费者，
          // attributeFilter 里的 aria-selected 移除 —— 只留 childList 监听。
          // 其余监听项（header 子树结构变化 ⇒ 激活态同步）不受影响。
          const sync = () => {
            setActive(overlayIsOpen())
          }
          sync()
          const node = rootRef.current
          const header = node === null ? null : node.closest('header')
          if (header === null) return undefined
          const observer = new MutationObserver(sync)
          observer.observe(header, { childList: true, subtree: true })
          // 观察 header 而非自身：自身是 flex:none，被挤压时宽度不变，观察不到溢出。
          let resize = null
          if (typeof ResizeObserver === 'function') {
            resize = new ResizeObserver(() => measure())
            resize.observe(header)
          }
          return () => {
            observer.disconnect()
            if (resize !== null) resize.disconnect()
          }
        }, [measure])
        // 每次渲染后校正一次（覆盖 header 宽度未变但同排其他控件变宽的情况）。
        react.useEffect(() => { measure() })
        const onClick = event => {
          dismissCanvasOverlay()
          openOverlayFrom(event?.currentTarget ?? null)
        }
        return react.createElement('div', {
          ref: rootRef,
          className: compact ? 'dsh-ssh-switch is-compact' : 'dsh-ssh-switch',
          role: 'group',
          'aria-label': 'SSH',
        },
          react.createElement('button', {
            type: 'button',
            className: active ? 'active' : '',
            'aria-pressed': String(active),
            title: VIEW_LABEL,
            'aria-label': VIEW_LABEL,
            onClick,
          }, compact ? terminalGlyph() : VIEW_LABEL))
      }

      // ---- 「在不在主页」判据（2026-09-25 修）---------------------------------
      // 用户报「右上角 SSH 按钮应该只在主页显示，而不是每个界面都有」。
      // 根因：`shell.overlay` 是 **root 级浮层，每一屏都会渲染**，而 launcher 的判据只看
      // 「会话是否空白（hero）」—— 在设置页 / 轨迹页等**非会话界面**上，当前会话同样可能是
      // 空白或摘要未就绪，判据成立 ⇒ 那颗按钮就跟着浮层出现在每一屏的右上角。
      // 官方没有「当前 main 是哪一个」的读取接口（`ctx.uiWorkspace` 只给导航动作），
      // 故叠一层面板锚点：`[data-slot="main.conversation"]` **只在会话面板激活时存在**
      // （隔离契约：其它主面板激活时它不存在；定位首选 `[data-slot="main"]`，判激活用它）。
      // 注意：这**不是**把「有没有会话」改回 DOM 探测 —— hero 判据仍走官方 `useSessions`，
      // 这里只补「在不在主页」这一维。
      const CONVERSATION_PANEL_SELECTOR = '[data-slot="main.conversation"]'
      const onConversationHome = () => {
        try {
          return document.querySelector(CONVERSATION_PANEL_SELECTOR) !== null
        } catch {
          return false // 极少数读不到 DOM 的宿主：宁可不显示，也不要每屏都冒出来
        }
      }

      // ---- 「本线胶囊在不在场」判据（2026-09-25 B2 修）-------------------------
      // 用户报「会话窗口右上角不应该有 SSH 按钮 —— 重复了，胶囊有 SSH 按钮入口」。
      // 根因：旧判据把「会话头会不会渲染」**推断**成了「会话是不是 blank session」，
      // 而官方真正决定会话头 chrome（含 actions 槽）渲不渲染的是：
      //   blank = session === void 0 || conversation === void 0
      //           || (session.blank && conversationPhase(session, conversation) === 'blank')
      //   sessionId === void 0 ? <空 titleRow/> : renderSlot('conversation.session.header', { hideChrome: blank })
      // （`dsh-client-ui-conversation/lib/client.js`）。两个 blank **语义不同**：
      // `SessionSummary.blank` 仍为真、但 conversationPhase 已经不是 blank 时，官方
      // `hideChrome = false` ⇒ **会话头带 chrome 渲染、胶囊出现**，而旧判据照样返回
      // 「hero」⇒ launcher 与胶囊同时在场（就是用户看到的重复）。
      // 现在只认事实：**本线的胶囊在不在 DOM 里**。它探测的不是官方内部结构，而是本线
      // 自己的产物 —— 同类手法本线早已在用（`syncChrome()` 用 `.dsh-canvas-switch` 的
      // 存在性算 canvasAvailable），因此不受官方 blank / conversationPhase 语义漂移影响。
      // 降级方向也是对的：万一胶囊真不在场（注册失败 / 会话头没渲染），launcher 顶上兜底。
      const OWN_ENTRY_SELECTOR = '.dsh-ssh-switch'
      const ownEntryPresent = () => {
        try {
          return document.querySelector(OWN_ENTRY_SELECTOR) !== null
        } catch {
          return false // 读不到 DOM ⇒ 当作「不在场」，交给「在不在主页」那一维兜底
        }
      }

      /** launcher 的唯一显隐判据：在主页 **且** 本线胶囊不在场。 */
      const launcherShouldRender = () => onConversationHome() && !ownEntryPresent()

      /**
       * 订阅 launcher 的显隐判据。面板切换、会话头挂载 / 卸载都由官方 React 增删 DOM 完成，
       * 没有可读信号，因此用 MutationObserver 观察；rAF 节流合并流式输出期间的高频 DOM 变动
       * （只在布尔值真正翻转时才 setState，避免无谓重渲染）。
       *
       * 订阅用 `usePaintEffect`（= useLayoutEffect，见文件头）：首次 `sync()` 必须跑在
       * paint 之前，否则刷新时会先闪一帧多余的 SSH。
       */
      function useLauncherVisible() {
        const [visible, setVisible] = react.useState(launcherShouldRender)
        usePaintEffect(() => {
          let scheduled = false
          const sync = () => {
            const next = launcherShouldRender()
            setVisible(prev => (prev === next ? prev : next))
          }
          const raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : fn => (typeof setTimeout === 'function' ? setTimeout(fn, 16) : fn())
          const schedule = () => {
            if (scheduled) return
            scheduled = true
            raf(() => { scheduled = false; sync() })
          }
          sync()
          const observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true, subtree: true })
          return () => observer.disconnect()
        }, [])
        return visible
      }

      /**
       * D1.1 无会话头时的常驻入口（方案 §14）：注册到 `shell.overlay`（frame 级浮层）。
       *
       * 存在意义：会话头的入口胶囊注册在 `conversation.session.header.actions` 槽里，而官方
       * `ConversationHeader` 在 `sessionId === void 0` 时**只渲染一个空的 titleRow 占位**
       * （`sessionId === void 0 ? <div className={titleRow}/> :
       * renderSlot('conversation.session.header', …)`）⇒ hero 态（首屏）没有胶囊，这里顶上。
       *
       * **判据（2026-09-25 B2 重写）**：`在主页` **且** `本线胶囊不在场`
       * （见上方 `launcherShouldRender()`）。旧判据靠推演官方 `useSessions` 的 blank 字段，
       * 它与「会话头会不会渲染」**不等价** ⇒ 会话窗口里 launcher 与胶囊同时在场
       * （用户报「重复了，胶囊有 SSH 按钮入口」）。
       * 现在只认 DOM 事实，**结构性杜绝双入口**（验收用
       * `document.querySelectorAll('.dsh-ssh-launcher').length === 0` 锁死）。
       *
       * 不再消费任何官方 prop ⇒ **不必再拆两层**判「有没有 useSessions」（React 规则里
       * 「hook 不能条件调用」的前提消失了）；hook 在这里无条件调用。
       */
      function SshLauncher() {
        if (!useLauncherVisible()) return null
        // 视觉与入口胶囊同款（同令牌 / 同圆角 / 同 28px），只显示文字 —— 与胶囊非紧凑态一致。
        return react.createElement('div', { className: 'dsh-ssh-launcher' },
          react.createElement('button', {
            type: 'button',
            title: VIEW_LABEL,
            'aria-label': VIEW_LABEL,
            onClick: event => { dismissCanvasOverlay(); openOverlayFrom(event?.currentTarget ?? null) },
          }, VIEW_LABEL))
      }

      // 入口注册到官方会话头 actions 插槽：与「对话 / 会话布」(order 25) 同一 flex 行，
      // order 26 即紧随其后。注册项 / 监听 / 样式都归当前 fiber，卸载时由 slots 与
      // 下面的 effect 统一回收。
      ctx.slots.inject(
        'conversation.session.header.actions',
        () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'ssh-view-switch',
          order: 26,
        }, SshSwitch),
      )

      // D1.1 无会话头时的常驻入口（方案 §14）。`shell.overlay` 是 frame 级浮层
      // （root scope / list / replaceRisk none）：官方 catalog 明示「a fresh id is added
      // beside the shipped entries」——当前占用者只有 `usage-stats-overlay`，用自有 id
      // 不碰它；order 40 排在它之后。层本身 click-through，条目自己 opt-in 指针事件
      // （容器已在 CSS 里 `pointer-events:none!important`）。
      ctx.slots.inject(
        'shell.overlay',
        () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'ssh-launcher',
          order: 40,
        }, SshLauncher),
      )

      // reserve 量一次并写进宿主 CSS 变量（launcher 的定位消费它）。**必须在 apply 期间调**：
      // iframe 是懒加载的，只挂在它的 load 监听上会漏（详见 syncChrome 上方注释）。
      syncChrome()

      // Reset the idempotence guard and every page-level side effect when the fiber
      // is torn down (HMR full recycle / plugin reinstall), so the next apply can
      // mount again with a clean page.
      ctx.effect(() => () => {
        window.__DSH_SSH_BOOTED__ = false
        window.removeEventListener('message', onCanvasView)
        window.removeEventListener('message', onOverlayMessage)
        const index = canvasViewItems.indexOf(VIEW_ITEM)
        if (index >= 0) canvasViewItems.splice(index, 1)
        window.dispatchEvent(new CustomEvent('dsh-canvas:view-items', { detail: { items: canvasViewItems.slice() } }))
        // launcher 的 reserve 变量归本 fiber（§14.4）：不清掉会在 documentElement 上留痕。
        try {
          const root = document.documentElement.style
          root.removeProperty('--dsh-ssh-chrome-reserve')
          root.removeProperty('--dsh-ssh-chrome-top')
          root.removeProperty('--dsh-ssh-chrome-height')
        } catch { /* 只读环境 */ }
        // 浮层宿主整树回收（含 iframe / 加载态 / 监听）；开关记忆不清除 ——
        // 它是用户意图而非插件生命周期状态（§5.9）。插件重装后记忆态若为真，
        // 下次 apply 会在下面自动恢复浮层。
        host.remove()
        style.remove()
      }, 'ssh: view')

      // 开关记忆恢复（§5.9）：apply 期间读一次；为真则走与入口相同的 open 路径。
      // open 容忍「入口/宿主未就绪」——它只碰自建宿主 DOM，无需等待官方 UI。
      if (readOverlayMemory()) openOverlay()
    }

    // 供契约测试（test/client.test.js）直读主题快照的取数逻辑。
    module.exports.readThemeSnapshot = readThemeSnapshot

    return module.exports
  },
})
