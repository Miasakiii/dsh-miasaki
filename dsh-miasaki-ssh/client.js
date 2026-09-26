// Client half of @miasaki/dsh-ssh.
//
// 路线丁（全屏浮层，方案 2026-09-14-ssh-fullscreen-overlay-plan.md）：SSH 是**会话之外的
// 全屏功能模块** —— body 级宿主 + 常驻 iframe + visibility 隐藏 + sessionStorage 开关记忆。
// 入口有三处：① 会话头胶囊（conversation.session.header.actions，order 26，与 canvas
// 胶囊合成一体）；② **hero 态**（首屏 / 会话头没有胶囊时）的 launcher（shell.overlay，
// order 40，方案 §14；显隐两维判据 + 同排官方 chrome 实测让位，见下方 launcherShouldRender
// 与 syncLauncherOffset，2026-09-26 B3/B4）；③ 画布页外部视图槽按钮（canvas:view 广播）。
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

    // ---- 口径①「壳窗控口径」消费桌面契约（2026-09-27 T4）----------------------
    // 口径①今天量的是壳自己的资产 `#miasaki-titlebar .tb-group`，却靠**猜类名**：
    // 壳改一次选择器（v3 的 `.tb-capsule` 就是这么变成兜底的）、或侧栏线往组里注入
    // 一颗终端键（组宽 108 → 136），插件都得跟着改一遍。契约 v1.2 增补
    // `chrome.bounds()`（**壳窗控按钮组**在视口坐标下的矩形，量不到返回 `null`）把这件事
    // 变成有版本号、可探测的读取面；`chrome.onChange(cb)` 是驱动它的 ResizeObserver
    // 信号（组尺寸 / 位置变化，含「侧栏线后来插了一颗键」）。
    //
    // **契约对象只在模块初始化时取一次**（契约 `10-contract.js` 由 initialization_script
    // 注入、早于插件 client 装载 ⇒ 这里读得到就是**整个页面生命期**都在；页面里换壳只能靠
    // 重载，模块单例届时一并重建）。**矩形不缓存、每次重测重取**：窗口尺寸变化会直接挪动
    // 组的位置（右侧按钮组），缓存成快照就会把落点钉死 —— 读取本身是纯几何、无副作用。
    //
    // **降级方向**：量不到（浏览器 / 旧壳 / 子 frame 只拿到空壳）时一律回落到原来的
    // DOM 探针（含 `.tb-capsule` 双类名兜底）—— 这条兜底路径**不删**。
    const desktopContract = typeof window !== 'undefined' ? window.miasakiDesktop ?? null : null

    /**
     * 能力探测。**两条独立判据**：① 有 `has` 就走 `has(name)`（契约的正式读法，
     * 与 `desktop-contract.md` 给的消费方式逐字一致 —— 用法按规范，不按实现）；
     * ② 没有 `has` 但能力表是数组就查表 —— 只探测**同一个已捕获对象自己声明的**能力，
     * 不额外放宽准入（`has` 返回非 `true` 一律当没有，缺 `has` 的**空壳**对象仍被排除）。
     */
    const hasContractCapability = name => {
      if (desktopContract === null) return false
      let reported = false
      try { reported = typeof desktopContract.has === 'function' && desktopContract.has(name) === true } catch { reported = false }
      if (reported) return true
      try { return Array.isArray(desktopContract.capabilities) && desktopContract.capabilities.indexOf(name) >= 0 } catch { return false }
    }

    /**
     * 读一次契约的窗控组矩形（视口坐标），归一到与 DOM 探针**同一形状**（补 `left` / `top`）
     * ⇒ 其上的 reserve 算式与垂直对齐判据**一处实现、两条数据源**，不会算出两套口径。
     * 契约缺席 / 能力未提供 / 抛异常 / 量不到（`null`）都返回 `null` ⇒ 调用方回落 DOM 探针。
     * 契约只承诺返回 `{ left, top, right, bottom, width, height }`，但**缺项按「量不到」处理**
     * （`applyRect` 的 `Number.isFinite` 判据会退回默认值）—— 不在这里替壳编一个默认 top/height。
     */
    const contractChromeRect = () => {
      // 先验 `chrome` 本身：探针读的是**能力表**，而能力表与暴露面理论上可能漂移
      // （壳侧登记了 `chrome.bounds` 却没挂 `chrome`）—— 别让这种漂移变成 TypeError。
      if (desktopContract === null || desktopContract.chrome === null || typeof desktopContract.chrome !== 'object') return null
      if (!hasContractCapability('chrome.bounds')) return null
      let rect = null
      try { rect = desktopContract.chrome.bounds() } catch { return null } // 契约定时器 / 壳侧异常不得拖垮顶栏重测
      if (rect === null || rect === undefined || typeof rect !== 'object') return null
      if (typeof rect.left !== 'number' || typeof rect.width !== 'number') return null
      return {
        left: rect.left,
        width: rect.width,
        height: typeof rect.height === 'number' ? rect.height : null,
        top: typeof rect.top === 'number' ? rect.top : null,
      }
    }

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

    // ---- launcher 的「躲开同一行官方 chrome」偏移（2026-09-26 B3）-------------
    // 纯函数、无 DOM 依赖，供契约测试直读（同 `readThemeSnapshot` 的做法）。
    // 输入视口宽（CSS px）与官方 chrome 的最左边界（CSS px），返回 launcher 的 CSS
    // `right` 偏移（px）：**退到 chrome 左侧留 `gap` 呼吸位**。量不到（视口宽不可用 /
    // chrome 缺席 ⇒ chromeLeft 为 Infinity）返回 null ⇒ 调用方移除变量、CSS 回落桌面壳
    // 窗控口径。负数归零（chrome 已越过视口右缘的退化场景）。
    const LAUNCHER_GAP_PX = 8
    // 让位时**顺带吸收紧邻的官方兄弟按钮**：dockkit strip 末端除 chrome 容器外，左边
    // 还可能挨着「加标签 / 分栏」等按钮（不可用时呈浅灰），只量容器会和它们叠上。
    // 上限 48px：再远就是 tab 条 / 标题本身，不该算进让位量。
    const CHROME_ADJACENT_PX = 48
    const ROW_CHROME_SELECTORS = ['[data-conversation-header-corner]', '[data-dockkit-strip-chrome]']
    const launcherClearanceOffset = ({ viewportWidth, chromeLeft, gap = LAUNCHER_GAP_PX }) => {
      if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return null
      if (!Number.isFinite(chromeLeft)) return null
      return Math.max(0, Math.ceil(viewportWidth - chromeLeft + gap))
    }
    // ---- 锚点必须**落在视口内**才参与让位（2026-09-26 B4）---------------------
    // 右栏收起时 `[data-dockkit-strip-chrome]` 被官方
    // `transform: translateX(var(--dsh-sidebar-width))` 整体推到视口右缘之外 —— 实测
    // `left=1590 / width=64 / height=28`（视口宽 1248）：宽高都是真实值，旧 0×0 判据
    // （`width<=0||height<=0`）拦不住它。
    // **归因澄清（B4 对照实验，避免把原因记错）**：它不是「持续叠压」的根因 —— 让位量取
    // `Math.min`，屏外坐标（1590）比在场锚点（corner 1080）更大，min 根本不会选它。它的价值是
    // **语义正确性**：视口外的锚点在几何上不可能与 launcher 叠压，把它计进来只会在「它是唯一
    // 在场锚点」时凭空造出一个 `clearance = 0`（再被 max 兜回兜底值），让「量不到」与「量到
    // 一个无效值」两件事混在一起、不可分辨。持久性根因是**零 DOM 变动的 CSS 变量让位线变化**
    // —— 见 `useLauncherVisible` 里的 rootObserver。
    const inViewportRow = (rect, viewportWidth) =>
      rect.width > 0 && rect.height > 0 && rect.left < viewportWidth
    // ---- 过渡期跟随重测（2026-09-26 B4）---------------------------------------
    // 官方右栏开合 / 分栏切换是 **CSS transform 过渡**（`.P3OORG_panel [data-dockkit-host=dock]`
    // 的 `transition: transform var(--ds-transition-duration-slow)`），chrome 的位置在几百毫秒
    // 里连续变化。对照实验（无头 Chromium，属性触发官方过渡；实测数据见 CHANGELOG）：
    // **只在触发瞬间测一次**的实现里，过渡期间 launcher 与刚移入视口的 strip **最大重叠 41px**，
    // 要等 `transitionend` 才在下一次纠正 —— 那就是用户图一的那一帧。
    // 跟随重测把这个窗口收掉：逐帧跟到连续 `FOLLOW_SETTLE_FRAMES` 帧不再变化；硬上限
    // `FOLLOW_MAX_FRAMES` 兜住「值一直抖」的极端情况（约 1.5s）。
    // **下限 `FOLLOW_MIN_FRAMES` 不可省**：过渡前段 chrome 还在视口外（被 `inViewportRow`
    // 滤掉）时让位量会一直取兜底值、连续多帧「不变」，若据此收手，等 chrome 真正移进视口
    // 就没人再测了 —— 实测正是这个早停让过渡期间残留 41px 叠压（收手下限补上后归零）。
    const FOLLOW_SETTLE_FRAMES = 4
    const FOLLOW_MIN_FRAMES = 30
    const FOLLOW_MAX_FRAMES = 90

    // rAF 取用（2026-09-26 B4）：浏览器恒有；契约测试的 VM 桩没有 ⇒ 退回原来的同步回退，
    // 既有测试的确定性不受影响（跟随重测在无 rAF 宿主上直接不启动，见 startFollow）。
    const hasAnimationFrame = typeof requestAnimationFrame === 'function'
    const raf = hasAnimationFrame
      ? requestAnimationFrame
      : fn => (typeof setTimeout === 'function' ? setTimeout(fn, 16) : fn())

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
      //
      // right 的**两个口径**（2026-09-26 B3 修）：
      // ① 兜底 = 壳窗控口径 `--dsh-ssh-chrome-reserve + 16px`（桌面壳量出的窗控组宽度）；
      // ② 实际 = `--dsh-ssh-launcher-right`（`syncLauncherOffset()` 实测 DSH 自身在这
      //    一行的 chrome 后取「两者更靠左」的那个）。为什么必须叠 ②：桌面壳把自家窗控
      //    组之外的空间让给 DSH 官方控件（`--ms-titlebar-reserve`），于是会话头的
      //    corner（右栏折叠时的「展开」键）与右栏 dockkit strip 的两颗 chrome 键正好
      //    被顶到 launcher 的默认落点上 —— 实测 2496px 宽 / 200% 缩放的桌面壳窗口里，
      //    launcher 文字与官方那颗「▭」只差 1.5 CSS px（按钮盒重叠 14px），用户
      //    两次反馈「SSH 按钮还是有问题」的可见缺陷就是这个叠压。
      '.dsh-ssh-launcher button{position:absolute;top:var(--dsh-ssh-chrome-top,5px);right:var(--dsh-ssh-launcher-right,calc(var(--dsh-ssh-chrome-reserve,0px) + 16px));pointer-events:auto;height:var(--dsh-ssh-chrome-height,28px);padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}' +
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

      // ---- 桌面壳窗控 reserve（口径①：契约优先 + DOM 兜底）------------------
      // 两个消费者：① 浮层内 iframe 走 postMessage（iframe 侧的 `--ssh-chrome-reserve`）；
      // ② 宿主里的 launcher 走宿主 CSS 变量 —— 它不在 iframe 内，收不到 postMessage。
      // 2026-09-27 T4：量取改**契约优先**（`chrome.bounds()`，见文件头），量不到才回落原来的
      // DOM 探针。两条路径产出**同一个 `rect` 形状** ⇒ 下面的 reserve 算式与垂直对齐判据共用
      // 一份实现，不存在两套口径。**必须在 apply 期间主动调一次**：下面的 load 监听只在
      // iframe 加载时才跑，而 iframe 是懒加载的（用户没开过浮层就永远不加载），靠它设变量会漏。
      const syncChrome = () => {
        let reserve = 0
        let chromeTop = 5
        let chromeHeight = 28
        const applyRect = rect => {
          if (rect === null || !(rect.width > 0)) return
          reserve = Math.ceil(window.innerWidth - rect.left + 6)
          // launcher 的**垂直对齐**：与窗控组同顶同高。量不到就退回默认 5 / 28
          // （普通浏览器没有窗控，这两个值不影响任何人）。限界防呆：窗控量出的
          // 高度不该超出 20–44，超了说明量错了，宁可退回默认也不跟着摆歪。
          if (Number.isFinite(rect.top) && rect.top >= 0 && rect.top <= 40) chromeTop = Math.round(rect.top)
          if (Number.isFinite(rect.height) && rect.height >= 20 && rect.height <= 44) chromeHeight = Math.round(rect.height)
        }
        try {
          // 口径①-a：契约（量的是**壳的**按钮组，壳有权代理）。
          const contracted = contractChromeRect()
          if (contracted !== null) applyRect(contracted)
          else {
            // 口径①-b：DOM 探针兜底（浏览器 / 旧壳 / 子 frame 空壳）。双类名兜底必须保留：
            // `.tb-group` 是现行，`.tb-capsule` 是 v3 旧类名（老壳仍可能是它）。
            const capsule = document.querySelector('#miasaki-titlebar .tb-group') ??
              document.querySelector('#miasaki-titlebar .tb-capsule')
            if (capsule instanceof HTMLElement) {
              const rect = capsule.getBoundingClientRect()
              if (rect.width > 0) {
                // 垂直对齐（DOM 兜底路径的既有读法）：读 computed `top`，**此行行为不改**。
                // 与契约路径的 `bounds().top`（几何）在窗口无缩放时同值（`tb-group` 实为
                // `position:fixed; top:11px; right:8px`，见 `03-switcher.js:60`），归一到同一个
                // `rect.top` 字段后由 `applyRect` 统一处理。
                const top = Number.parseFloat(window.getComputedStyle(capsule).top)
                applyRect({ left: rect.left, width: rect.width, height: rect.height, top })
              }
            }
          }
        } catch { /* 无父文档场景兑底 0 */ }
        // 顶栏「会话布」段的可用性（D2 语义边界）：canvas 只注册在会话头 actions 槽
        // ⇒ hero 态（无会话头）没有任何胶囊可供委托，顶栏那一段必然是死按钮。
        // 与其让用户点了没反应，不如让浮层**不渲染**它 —— 宿主把事实随 chrome 消息下发。
        // 判据失败时保守显示（宁可多一颗按钮，也别让别人把入口判丢）。
        let canvasAvailable = true
        try { canvasAvailable = document.querySelector('.dsh-canvas-switch') !== null } catch { /* 查询失败：保守显示 */ }
        shellReserve = reserve // launcher 落点取 max 用（见 syncLauncherOffset）
        try {
          const root = document.documentElement.style
          root.setProperty('--dsh-ssh-chrome-reserve', reserve + 'px')
          root.setProperty('--dsh-ssh-chrome-top', chromeTop + 'px')
          root.setProperty('--dsh-ssh-chrome-height', chromeHeight + 'px')
        } catch { /* 只读环境 */ }
        try { frame.contentWindow?.postMessage({ source: 'dsh-ssh', type: 'chrome', version: 1, reserve, canvasAvailable, overlayToken: overlayMsgToken }, location.origin) } catch { /* iframe 刚卸载 */ }
        // launcher 自己的落点：壳窗控口径 + 同排官方 chrome 让位（见 syncLauncherOffset）。
        // 挂在 syncChrome 上，apply 期间与 iframe load 时都会各量一次。
        syncLauncherOffset()
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

      // ---- 口径①的额外重测信号：契约 `chrome.onChange`（2026-09-27 T4）----------
      // 契约背后是壳侧对按钮组的 ResizeObserver ⇒ 「侧栏线后来往组里注入了一颗终端键」
      // （组宽 108 → 136，让位量少 28px）这类变化有了**直接信号**，不必等窗口 resize 或
      // 某次 DOM 变动顺带补测。**与 `rootObserver` 不互斥、不是替代关系**（见 useLauncherVisible）：
      //   · 本信号管**壳的**按钮组（口径①的数据源变了 ⇒ 重测顶栏 reserve 与落点）；
      //   · `rootObserver` 管**官方**那一侧（`--ms-titlebar-reserve` 变化 ⇒ 官方 chrome 平移，
      //     全程零 DOM 变动）—— 那是 B4 的成果，契约化口径①之后它照旧盯着官方。
      // 退订挂在既有 fiber 清理路径（ctx.effect 的 teardown）上：订阅归本 fiber，重挂不留悬空订阅。
      let unsubscribeChromeContract = null
      const subscribeChromeContract = () => {
        if (unsubscribeChromeContract !== null) return // 幂等：重复 apply / HMR 不得叠订阅
        if (desktopContract === null || desktopContract.chrome === null || typeof desktopContract.chrome !== 'object') return
        if (!hasContractCapability('chrome.onChange')) return
        let off = null
        try { off = desktopContract.chrome.onChange(remeasureChromeContract) } catch { off = null }
        unsubscribeChromeContract = typeof off === 'function' ? off : () => {}
      }
      const disposeChromeContractSubscription = () => {
        const off = unsubscribeChromeContract
        unsubscribeChromeContract = null
        if (off === null) return
        try { off() } catch { /* 壳侧退订抛异常不得阻断 fiber 清理 */ }
      }
      /** 壳窗控组尺寸 / 位置变化 ⇒ 立刻重测（同步：契约的 observer 回调在 paint 前，此刻量得到新值）。 */
      const remeasureChromeContract = () => {
        syncChrome()
        // 落点还跟着官方那一侧（口径②），壳组变化会移动 launcher 的起点 ⇒ 一并校正一次。
        syncLauncherOffset()
      }

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

      // ---- 「同一行里的官方 chrome」让位（2026-09-26 B3 修，B4 补取数时机与视口判据）----
      // 用户第二次复报「SSH 按钮还是有问题」并附两张桌面壳截图（红框圈住右上角那一排）。
      // 逐像素量测（2496×1546 截图 = 1248×773 CSS × 200% 缩放）得到的**可见缺陷**：
      //   · launcher 的按钮盒 ≈ x[2081,2148]，官方那颗「▭」的按钮盒 ≈ x[2120,2176]
      //     —— **重叠 28 物理 px（14 CSS px）**，文字与图标只差 1.5 CSS px，视觉上贴在一起；
      //   · 右栏展开时它俩之间又插进右栏 dockkit chrome 的两颗键（全屏 / 收起），
      //     launcher 被夹在中间，两侧都只剩 3 物理 px。
      // 根因：launcher 的 right 只按**桌面壳窗控组**算（`--dsh-ssh-chrome-reserve`），
      // 而桌面壳把窗控组之外的空间让给 DSH 官方控件（`--ms-titlebar-reserve`，默认 128px、
      // sidebar 线注入终端键后升到 156px）⇒ 官方控件被顶到窗控组左侧的同一行里，
      // 正好压在 launcher 的落点上。这不是「该不该显示」的问题（B1/B2 已定：主页显示、
      // 胶囊在场时不显示），而是**同一行里两块 chrome 抢位**。
      // 修法沿用本仓既有的「实测让位」纪律（canvas 线 syncChrome / desktop 线
      // `--ms-titlebar-reserve` 都是这个套路）：量出这一行里 DSH 官方 chrome 的**最左边界**，
      // 把 launcher 退到它左侧留呼吸位。两个锚点都是官方既有属性：
      //   · `[data-conversation-header-corner]` —— 会话头右端（右栏折叠时「展开」键在此；
      //     canvas 线早已用它做 :has() 锚点）；
      //   · `[data-dockkit-strip-chrome]` —— 右栏 dockkit strip 末端的「全屏 / 收起」两键
      //     （desktop 线用它做让位，注释里写明它恒存、只在分栏最右格渲染）。
      //
      // 2026-09-26 B4（用户第三次复报「还是会有问题，点击页面后可能恢复正常」）：B3 只修了
      // 「用哪个口径」，**取数时机**与**锚点在场判据**各留了一个洞，叠加出的缺陷与用户截图
      // 逐像素吻合。用无头 Chromium + 复刻桌面壳标题栏（`#miasaki-titlebar .tb-group` +
      // `--ms-titlebar-reserve`）逐帧量测 + **对照实验**（同一探针分别跑「修复前语义」与
      // 「修复后语义」）拿到的现场，两个洞各自独立可复现：
      //   · 洞 A —— **过渡期间只有一次测量**：右栏开合走 CSS transform 过渡
      //     （`--ds-transition-duration-slow`）。对照实测：只在触发瞬间测一次的实现里，
      //     过渡期间 launcher 与刚移入视口的 strip **最大重叠 41px**，随后靠 `transitionend`
      //     才纠正 —— 41px 正是用户图一里 `{SSH[]` 那个叠压量级（瞬时，但每次开右栏都出现）；
      //   · 洞 B（**持久性叠压的根因**）—— **CSS 变量让位线变化不带任何 DOM 变动**：桌面壳
      //     侧栏线把 `--ms-titlebar-reserve`（128 → 156px）写在 documentElement 上，这条线一变
      //     官方整行 chrome 就整体平移。对照实测：把安全线 156→220px 后，落点变量
      //     **一次都没有重测**（取值序列只有一个旧值），strip 从 x[1028,1092] 移到 x[964,1028]
      //     后与 launcher **持续重叠 20px** —— 这就是用户「还是会有问题」的持久形态；
      //     「点击页面后可能恢复正常」＝ 点击引发某处 React 重渲染，才顺带补上一次测量
      //     （= 用户图二，SSH 退到 x≈950）；
      //   · 附带修正 —— 视口外的锚点不参与（`inViewportRow`）：右栏收起时 dockkit strip 被
      //     `transform: translateX(var(--dsh-sidebar-width))` 推到视口右缘之外，实测
      //     `left=1590 / 64×28`（视口 1248），宽高非零 ⇒ 旧 0×0 判据拦不住。它**不是**叠压的
      //     根因（让位量取 min，屏外坐标更大、选不中），修的是「量不到」与「量到无效值」
      //     混在一起的语义问题（详见 `inViewportRow` 上方注释）。
      // B4 的修法：① 过渡期逐帧跟随到值稳定（`startFollow`）；② 观察 **documentElement 的
      // style**，让安全线变化有重测信号（`rootObserver`）；③ 补 `transitionend` /
      // `visibilitychange` / `fonts.ready` 三个补充信号；④ 视口外的锚点一律不参与。
      /** 壳窗控口径量出的 reserve；供 launcher 落点取 max（见 syncLauncherOffset）。 */
      let shellReserve = 0
      let launcherOffsetLast = null

      /**
       * 量出同排官方 chrome 的最左边界，写进 `--dsh-ssh-launcher-right`。
       * 口径 = max(壳窗控口径 reserve+16, 躲开官方 chrome 的偏移)：前者与 iframe 顶栏
       * 共用同一个 reserve 变量（这里不动它），后者由 `launcherClearanceOffset()` 纯函数算；
       * 两者取更靠左的那个，保证既不被窗控压住、也不压在官方控件上。
       * 量不到（视口宽不可用 / 在场 chrome 全在视口外）⇒ 移除变量，CSS 回落壳窗控口径。
       * @returns 本次测得的偏移（px），量不到时为 null（跟随重测用返回值判断是否仍在变）。
       */
      const syncLauncherOffset = () => {
        let offset = null
        try {
          const viewportWidth = Number.isFinite(window.innerWidth) ? window.innerWidth : 0
          let chromeLeft = Number.POSITIVE_INFINITY
          for (const selector of ROW_CHROME_SELECTORS) {
            for (const node of document.querySelectorAll(selector)) {
              const rect = node.getBoundingClientRect()
              // 视口外的锚点不参与：右栏收起时 dockkit strip 被 transform 推到视口右缘之外，
              // 宽高却仍是真实值（0×0 判据拦不住），会把让位量污染成 0。见 inViewportRow。
              if (!inViewportRow(rect, viewportWidth)) continue
              // 每个锚点**独立**累积：兄弟链的断链判据必须以本锚点自己的左边界为基准，
              // 否则前一个锚点把 chromeLeft 拉小之后，这里会在错误的距离上提前 break。
              let nodeLeft = rect.left
              // 吸收紧邻（间距 ≤ 48px）的官方兄弟按钮：dockkit strip 末端除 chrome 容器
              // 外，左边可能还挨着「加标签 / 分栏」等键，只量容器会和它们叠上。
              for (let sibling = node.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
                const siblingRect = sibling.getBoundingClientRect()
                if (!inViewportRow(siblingRect, viewportWidth)) continue
                if (nodeLeft - siblingRect.right > CHROME_ADJACENT_PX) break // 再往左就不是紧邻了
                nodeLeft = Math.min(nodeLeft, siblingRect.left)
              }
              chromeLeft = Math.min(chromeLeft, nodeLeft)
            }
          }
          const clearance = launcherClearanceOffset({ viewportWidth, chromeLeft })
          if (clearance !== null) offset = Math.max(shellReserve + 16, clearance)
        } catch { /* 无父文档 / 只读环境：保持壳窗控口径 */ }
        if (offset === null) {
          // 量不到（hero 态 / 无窗控环境）：清变量 ⇒ CSS 回落壳窗控口径。
          // removeProperty 幂等，未写过时调用也无副作用。
          launcherOffsetLast = null
          try { document.documentElement.style.removeProperty('--dsh-ssh-launcher-right') } catch { /* 只读环境 */ }
          return null
        }
        if (offset === launcherOffsetLast) return offset // 去重：同一偏移不重复写样式
        launcherOffsetLast = offset
        try { document.documentElement.style.setProperty('--dsh-ssh-launcher-right', offset + 'px') } catch { /* 只读环境 */ }
        return offset
      }

      /**
       * 过渡期跟随重测（2026-09-26 B4，常量与理由见文件头 `FOLLOW_*`）。
       *
       * 只在**有 rAF** 的宿主启动：契约测试的 VM 桩没有 rAF，而回退实现是同步执行
       * ⇒ 逐帧递归会变成同一个 tick 里的同步递归。桩环境不需要跟随（它的 DOM 不会自己动）。
       */
      let followRaf = null
      let followStableFrames = 0
      let followFrames = 0
      const followTick = () => {
        followRaf = null
        const before = launcherOffsetLast
        syncLauncherOffset()
        followFrames += 1
        // 值还在变 ⇒ 说明过渡 / 布局还没停，继续跟。但**「值不变」不等于过渡结束**：
        // 过渡前段 chrome 还在视口外时让位量恒取兜底值、可以连着多帧不变，据此收手就会
        // 漏掉它移进视口的那一刻（实测残留 41px 叠压）。故下限 FOLLOW_MIN_FRAMES 内无条件跟。
        followStableFrames = launcherOffsetLast === before ? followStableFrames + 1 : 0
        const settled = followStableFrames >= FOLLOW_SETTLE_FRAMES && followFrames >= FOLLOW_MIN_FRAMES
        if (!settled && followFrames < FOLLOW_MAX_FRAMES) followRaf = raf(followTick)
      }
      const startFollow = () => {
        if (!hasAnimationFrame) return
        followStableFrames = 0
        followFrames = 0
        if (followRaf === null) followRaf = raf(followTick)
      }
      const stopFollow = () => {
        if (followRaf === null) return
        try { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(followRaf) } catch { /* 无 cancelAnimationFrame 的宿主 */ }
        followRaf = null
      }

      /**
       * launcher 的唯一显隐判据：在主页 **且** 本线胶囊不在场。
       *
       * 2026-09-26 B3 记录：曾把「会话面板已绑定会话」（`[data-conversation-header-corner]`
       * 存在）也当成一维来隐藏 launcher，实机量测后**撤回** —— 空白会话里官方
       * `hideChrome = blank` 不渲染 titleCluster（胶囊缺席）但对话相位仍是 hero
       * （`ConversationMainPanel` 的 `hero = sessionId === void 0 || (blank && (open || summaryBlank))`，
       * 输入框仍居中），那正是用户口中的「主页」⇒ 入口该在；B1 的「只在主页显示」指的
       * 也是这一维（`[data-slot="main.conversation"]`）。该锚点现在只用于**让位测量**（见上）。
       */
      const launcherShouldRender = () => onConversationHome() && !ownEntryPresent()

      /**
       * 订阅 launcher 的显隐判据。面板切换、会话头挂载 / 卸载都由官方 React 增删 DOM 完成，
       * 没有可读信号，因此用 MutationObserver 观察；rAF 节流合并流式输出期间的高频 DOM 变动
       * （只在布尔值真正翻转时才 setState，避免无谓重渲染）。
       *
       * 订阅用 `usePaintEffect`（= useLayoutEffect，见文件头）：首次 `syncNow()` 必须跑在
       * paint 之前，否则刷新时会先闪一帧多余的 SSH。
       */
      function useLauncherVisible() {
        const [visible, setVisible] = react.useState(launcherShouldRender)
        usePaintEffect(() => {
          let scheduled = false
          /** 立即测一次（判据 + 落点 + 跟随）。 */
          const syncNow = () => {
            const next = launcherShouldRender()
            setVisible(prev => (prev === next ? prev : next))
            // 同排官方 chrome 会随「右栏开合 / 会话头挂载」出入 ⇒ 每次变动重测一次落点。
            // 只在可见时测：隐藏时测了也没人看，还能避免流式输出期间白白读布局。
            if (next) {
              syncLauncherOffset()
              // 官方 chrome 此刻可能正在 transform 过渡里（右栏开合 / 分栏切换）⇒ 跟到稳定为止，
              // 否则落点会钉在过渡中间值上（见文件头 FOLLOW_* 的实测记录）。
              startFollow()
            }
          }
          const schedule = () => {
            if (scheduled) return
            scheduled = true
            raf(() => { scheduled = false; syncNow() })
          }
          syncNow()
          const observer = new MutationObserver(schedule)
          // 观察项除子树增删外**必须包含右栏那两个属性**：官方 panel 开合是改属性 +
          // 改 transform（不卸载、不增删节点），只看 childList 会漏掉「dockkit chrome
          // 进出这一行」⇒ launcher 落点停在旧值上。两个属性都是低频变更（用户开合面板
          // / 切全屏），rAF 节流后开销可忽略。
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-sidebar-right-open', 'data-sidebar-right-panel'],
          })
          // 根元素 style（2026-09-26 B4 补，**持久性叠压的根因信号**）：桌面壳侧栏线把
          // 安全线 `--ms-titlebar-reserve`（默认 128px → 注入终端键后 156px）写在
          // `document.documentElement.style` 上；这条安全线一变，官方整行 chrome 整体平移
          // —— 而**全程零 DOM 变动**，childList 与右栏属性判据一个都收不到。
          // 无头 Chromium 实测（探针 D 阶段）：把安全线 156→220px 后，落点变量**一次都没有
          // 重测**（取值序列只有一个旧值），dockkit strip 从 x[1028,1092] 移到 x[964,1028]
          // 后与 launcher **持续重叠 20px** —— 这正是用户「还是会有问题」的持久形态，而
          // 「点击页面后可能恢复正常」是因为点击引发了某处 React 重渲染，才顺带补上一次测量。
          // **必须同步测、不走 schedule 的 rAF 节流**：安全线是 inline style 覆盖 `:root`
          // 声明、**同步生效**（没有过渡），延后一帧就会露出「chrome 已平移、launcher 还没跟」
          // 的叠压窗口（实测正是 20px）。MutationObserver 回调是微任务、浏览器尚未绘制，
          // 这里 `getBoundingClientRect()` 强制布局读到的就是新位置 ⇒ 同一帧内改完。
          // 但 `documentElement.style` 的写入方不止我们（皮肤线 / 侧栏线 / 官方都在写），
          // 逐次强制布局太贵 ⇒ 先做一次**廉价**的相关变量比对，只有真的变了才重测。
          // 顺带断掉自触发：我们写的是 `--dsh-ssh-launcher-right`，不在关心列表里。
          const WATCHED_ROOT_VARS = ['--ms-titlebar-reserve', '--dsh-ssh-chrome-reserve']
          let rootVarsLast = null
          const onRootStyleChange = () => {
            let key
            try {
              const inline = document.documentElement.style
              key = WATCHED_ROOT_VARS.map(name => inline.getPropertyValue(name)).join('|')
            } catch { key = null } // 读不到 inline style（只读宿主）⇒ 退化成每次都测
            if (key !== null && key === rootVarsLast) return
            rootVarsLast = key
            syncNow()
          }
          const rootObserver = new MutationObserver(onRootStyleChange)
          rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
          // 窗口尺寸变化同样会挪动官方 chrome 的左边界（右栏是推挤式布局）。
          const onResize = () => schedule()
          window.addEventListener('resize', onResize)
          // 过渡收尾的「最后一帧」保证（2026-09-26 B4）：跟随机制通常已经覆盖，但系统级
          // 「减少动效」、掉帧、后台标签页都可能让 rAF 提前收手；过渡结束事件是权威信号。
          // 捕获阶段监听 document：官方的过渡元素在 React 树深处，不冒泡到 window 也能收到。
          const onTransitionEnd = () => schedule()
          document.addEventListener('transitionend', onTransitionEnd, true)
          // 后台标签页不跑 rAF：切回窗口时补测一次，避免跟随在不可见期间空转后留下旧落点。
          const onVisibilityChange = () => schedule()
          document.addEventListener('visibilitychange', onVisibilityChange)
          // 字体落地会改变官方 chrome 的实测宽度（Inter/Montserrat 与回退字体不等宽）
          // ⇒ 补测一次。`document.fonts` 在极老宿主上可能缺席。
          try { document.fonts?.ready?.then?.(() => schedule()) } catch { /* 无字体接口：跳过 */ }
          return () => {
            observer.disconnect()
            rootObserver.disconnect()
            window.removeEventListener('resize', onResize)
            document.removeEventListener('transitionend', onTransitionEnd, true)
            document.removeEventListener('visibilitychange', onVisibilityChange)
            stopFollow()
          }
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
       * **判据（2026-09-25 B2 定，2026-09-26 B3 复核后维持两维）**：`在主页` **且**
       * `本线胶囊不在场`（见上方 `launcherShouldRender()`）——
       * ① 2026-09-25 B1 补「在不在主页」（`shell.overlay` 是 root 级浮层，每一屏都渲染；
       *    判据是官方 `[data-slot="main.conversation"]` 隔离锚点）；
       * ② 2026-09-25 B2 补「本线胶囊不在场」（旧判据推演官方 `useSessions` 的 `blank` 字段，
       *    与「会话头会不会渲染」**不等价** ⇒ 会话窗口里 launcher 与胶囊同时在场）。
       * B3 一度想再补「会话未绑定」一维，实机量测后撤回（理由见 `launcherShouldRender()`）；
       * 那次的真正缺陷是**同一行里的叠压**，修在 `syncLauncherOffset()`。
       * 两维都只认 DOM 事实，**结构性杜绝双入口**（验收用
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
      // 口径①的额外重测信号：契约可用即在 apply 期间挂上（幂等，退订在下面的 teardown）。
      // 挂在这里而不是放进 launcher 的订阅 effect：顶栏 reserve 与 launcher 的可见性无关
      // （浮层内 iframe 也消费同一个 reserve），hero 态也要跟。
      subscribeChromeContract()

      // Reset the idempotence guard and every page-level side effect when the fiber
      // is torn down (HMR full recycle / plugin reinstall), so the next apply can
      // mount again with a clean page.
      ctx.effect(() => () => {
        window.__DSH_SSH_BOOTED__ = false
        window.removeEventListener('message', onCanvasView)
        window.removeEventListener('message', onOverlayMessage)
        // 契约订阅归本 fiber：不退还的话，HMR / 重装后壳侧回调会打到已拆除的闭包上。
        disposeChromeContractSubscription()
        const index = canvasViewItems.indexOf(VIEW_ITEM)
        if (index >= 0) canvasViewItems.splice(index, 1)
        window.dispatchEvent(new CustomEvent('dsh-canvas:view-items', { detail: { items: canvasViewItems.slice() } }))
        // launcher 的 reserve / 落点变量归本 fiber（§14.4）：不清掉会在 documentElement 上留痕。
        try {
          const root = document.documentElement.style
          root.removeProperty('--dsh-ssh-chrome-reserve')
          root.removeProperty('--dsh-ssh-chrome-top')
          root.removeProperty('--dsh-ssh-chrome-height')
          root.removeProperty('--dsh-ssh-launcher-right')
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
    // 同上：launcher 让位量的纯函数（无 DOM 依赖，可直接单测）。
    module.exports.launcherClearanceOffset = launcherClearanceOffset
    // 同上：让位测量的视口过滤纯函数（B4，无 DOM 依赖）。
    module.exports.inViewportRow = inViewportRow
    // 2026-09-27 T4：口径①的契约读法（能力探测 + 矩形归一），供契约测试直读。
    module.exports.hasContractCapability = hasContractCapability
    module.exports.contractChromeRect = contractChromeRect

    return module.exports
  },
})
