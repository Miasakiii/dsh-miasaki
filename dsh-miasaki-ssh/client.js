// Client half of @miasaki/dsh-ssh.
//
// 一条会话里其实有两套并行的「视图切换」UI（2026-09-09 SPIKE 结论）：
//   1. 官方 tab 栏 —— `conversation.view` 注册项投影成 `role="tablist"`，在会话头**第二行**；
//   2. canvas 的「对话 / 会话布」胶囊 —— 注册在 `conversation.session.header.actions`，
//      在会话头**第一行**标题右侧（与「后台任务」同一 flex 行）。
//
// 用户 2026-09-10 反馈：SSH 作为一个视图，入口却在第二行 tab 栏里排在「会话用量」
// 后面，位置不对；它应该和「对话 / 会话布」那组切换按钮在一起。故本文件：
//   - 入口迁到 `conversation.session.header.actions`（order 26，紧跟 canvas 的 25），
//     并用纯 CSS 把两个胶囊**合成为同一个控件**：一个胶囊里的「对话 | 会话布 | SSH」
//     三段（canvas 文件一行未改，canvas 不在场时本段退回完整胶囊）；
//   - `conversation.view` 注册**保持不变**（页面 / 保活 / scrollback 回放全部不动），
//     只是把官方 tab 栏里那个 tab 收起，避免同一入口在第二行重复出现。
//
// 切换方式：DSH 没有对外暴露 View 切换 API —— `selectView` 只存在于官方
// `conversation.session.header` 的 inject face（`lib/client.js` 16705–16713），而
// `conversation.session.header.actions` 渲染时 owner props 是空对象 `{}`
// （同文件 15072），第三方插件拿不到 store 也拿不到 selectView。官方唯一的切换路径
// 就是 tab 按钮自己的 onClick，所以这里**委托点击官方 tab 按钮**，并全程带守卫：
// 找不到 tab 时点击静默无效、绝不抛错，也不影响 tab 栏（此时收手不隐藏，用户照旧
// 能从第二行进入）。
window.__ModuleLoader__.load({
  id: '@miasaki/dsh-ssh',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')

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
      '.dsh-canvas-switch:has(+ .dsh-ssh-switch button.active) button[aria-label="对话"].active:not(:hover){background:transparent;color:var(--dsw-alias-label-secondary,#6b7280)}'

    module.exports.inject = ['slots']

    module.exports.apply = ctx => {
      // Idempotence guard: DSH HMR / re-applies must not stack a second entry.
      if (window.__DSH_SSH_BOOTED__) return
      window.__DSH_SSH_BOOTED__ = true

      const VIEW_LABEL = 'SSH'

      const style = document.createElement('style')
      style.textContent = SWITCH_CSS
      document.head.append(style)

      // ---- 官方 tab 栏桥接（唯一的切换通道，见文件头注释）---------------------
      // 查询范围限定在**会话头**里：自己的按钮就挂在会话头 actions 槽内，用它当锚点。
      // 页面上别处也可能有 `role="tablist"`（设置面板等），全局查会误伤。
      const ownHeader = () => {
        const anchor = document.querySelector('.dsh-ssh-switch')
        return anchor === null ? null : anchor.closest('header')
      }
      const tabButtons = () => {
        const header = ownHeader()
        return Array.from((header === null ? document : header).querySelectorAll('[role="tablist"] [role="tab"]'))
      }
      /** 本插件注册的那个 tab：官方把 registration 的 label 渲染为 tab 文本。 */
      const ownTab = () => {
        for (const tab of tabButtons()) {
          if ((tab.textContent ?? '').trim() === VIEW_LABEL) return tab
        }
        return null
      }
      // 收起第二行那个 tab：入口已经在第一行，同一入口出现两次只会让人以为点错了。
      // 这是对官方 UI 的覆盖，所以做成「能收才收」：找不到 tab（结构变了 / 尚未渲染）
      // 就什么都不做 —— 最坏情况退回「双入口」，而不是没入口。
      const hiddenTabs = new Set()
      const hideOwnTab = () => {
        const tab = ownTab()
        if (tab === null || tab.style.display === 'none') return
        tab.style.display = 'none'
        hiddenTabs.add(tab)
      }
      // 卸载时复原：插件被停用 / 重装后，官方 tab 栏回到原样。
      const restoreTabs = () => {
        for (const tab of hiddenTabs) tab.style.display = ''
        hiddenTabs.clear()
      }
      /** 当前是否停在 SSH 视图 —— 官方把激活态写在 `aria-selected` 上。 */
      const viewIsSsh = () => {
        const tab = ownTab()
        return tab !== null && tab.getAttribute('aria-selected') === 'true'
      }
      /** 切到 SSH 视图：委托官方 tab 按钮的 onClick（就是 selectView 的唯一入口）。 */
      const selectSsh = () => {
        const tab = ownTab()
        if (tab === null) return false
        tab.click()
        return true
      }
      // 下面 dismissCanvasOverlay() 会**自己**去点 canvas 的「对话」按钮：那一下不是用户点的，
      // 不能连锁触发「切回默认视图」（见 onDialogClick）—— 否则点「SSH」会先切 chat、再切 ssh，
      // 视图连着换两次（iframe 也卸载重建两次，画面白闪一下）。
      let dismissing = false
      // 「会话布」是 canvas 的全屏浮层（z-index 100、盖住整个 frame）：它开着时切视图
      // 只会看到浮层。这里先走 canvas 自己的「对话」按钮把它关掉 —— 用它的按钮而不是
      // 直接 `overlay.hidden = true`，是为了让 canvas 的胶囊激活态同步复位（直接改
      // DOM 会让它以为会话布还开着）。canvas 不在场时 querySelector 落空，跳过即可。
      const dismissCanvasOverlay = () => {
        const overlay = document.querySelector('.dsh-canvas-overlay')
        if (overlay === null || overlay.hidden) return
        const back = document.querySelector('.dsh-canvas-switch button[aria-label="对话"]')
        if (back === null) return
        dismissing = true
        back.click()
        dismissing = false
      }
      /** 回到「对话」：官方 tab 栏里 order 最小的 view（chat 恒为第一个非 SSH tab）。 */
      const selectDefaultView = () => {
        for (const tab of tabButtons()) {
          if ((tab.textContent ?? '').trim() === VIEW_LABEL) continue
          if (tab.getAttribute('aria-selected') === 'true') return false
          tab.click()
          return true
        }
        return false
      }
      // canvas 的「对话」段只管关掉它自己的浮层，管不了 DSH 的 View —— 停在 SSH 视图时
      // 点它，屏幕上什么都不会变。合成一个控件之后那就是「点了没反应」，所以在这里补上：
      // 捕获它的点击，若当前停在 SSH 就同时切回默认视图（委托同一个官方 tab 通道）。
      // canvas 重渲染会重建这个按钮，所以绑定挂在 sync() 里按引用去重、卸载时解绑。
      let dialogButton = null
      const onDialogClick = () => {
        if (dismissing) return
        if (viewIsSsh()) selectDefaultView()
      }
      const bindDialogButton = () => {
        const button = document.querySelector('.dsh-canvas-switch button[aria-label="对话"]')
        if (button === dialogButton) return
        if (dialogButton !== null) dialogButton.removeEventListener('click', onDialogClick)
        dialogButton = button
        if (button !== null) button.addEventListener('click', onDialogClick)
      }
      const unbindDialogButton = () => {
        if (dialogButton === null) return
        dialogButton.removeEventListener('click', onDialogClick)
        dialogButton = null
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
        dismissCanvasOverlay()
        selectSsh()
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
          // 每次 header 子树变化都校正一次：既同步激活态（切会话 / 点 tab 会重建 tab 栏），
          // 也把重建出来的 tab 重新收起（内联 display 只跟着元素走）。
          const sync = () => {
            hideOwnTab()
            setActive(viewIsSsh())
            bindDialogButton()
          }
          sync()
          const node = rootRef.current
          const header = node === null ? null : node.closest('header')
          if (header === null) return undefined
          const observer = new MutationObserver(sync)
          observer.observe(header, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] })
          // 观察 header 而非自身：自身是 flex:none，被挤压时宽度不变，观察不到溢出。
          let resize = null
          if (typeof ResizeObserver === 'function') {
            resize = new ResizeObserver(() => measure())
            resize.observe(header)
          }
          return () => {
            observer.disconnect()
            unbindDialogButton()
            if (resize !== null) resize.disconnect()
          }
        }, [measure])
        // 每次渲染后校正一次（覆盖 header 宽度未变但同排其他控件变宽的情况）。
        react.useEffect(() => { measure() })
        const onClick = () => {
          dismissCanvasOverlay()
          selectSsh()
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

      /** SSH 页面本身：iframe 隔离，xterm 由 iframe 文档自己加载。 */
      function SshView() {
        return react.createElement('iframe', {
          src: '/ssh/',
          title: 'SSH',
          // Fill the conversation view area; the iframe document owns all of
          // its own styling (layout, theme, fonts).
          style: {
            display: 'block',
            width: '100%',
            height: '100%',
            border: '0',
            background: '#0b0e14',
          },
        })
      }

      // 页面注册：机制不变（DSH 托管激活态与每会话记忆；切走会卸载重建，故 host 侧
      // 保留 scrollback 并在 attach 时回放）。入口按钮只是**另一个**触发点。
      ctx.slots.inject(
        'conversation.view',
        () => ctx.slots.register({
          name: 'conversation.view',
          id: 'ssh',
          order: 20,
          label: () => VIEW_LABEL,
        }, SshView),
      )

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

      // Reset the idempotence guard and every page-level side effect when the fiber
      // is torn down (HMR full recycle / plugin reinstall), so the next apply can
      // mount again with a clean page.
      ctx.effect(() => () => {
        window.__DSH_SSH_BOOTED__ = false
        restoreTabs()
        unbindDialogButton()
        window.removeEventListener('message', onCanvasView)
        const index = canvasViewItems.indexOf(VIEW_ITEM)
        if (index >= 0) canvasViewItems.splice(index, 1)
        window.dispatchEvent(new CustomEvent('dsh-canvas:view-items', { detail: { items: canvasViewItems.slice() } }))
        style.remove()
      }, 'ssh: view')
    }

    return module.exports
  },
})
