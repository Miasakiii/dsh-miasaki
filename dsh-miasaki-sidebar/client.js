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
        `.dsh-sidebar-review-head{display:flex;align-items:center;gap:8px;flex:none}`,
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
        // 6px 8px padding, xs-13 type. The indent carries the tree depth.
        `.dsh-sidebar-file-row{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:6px 8px 6px 17px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;text-align:left;font:var(--dsw-font-xs-13,13px/20px system-ui)}`,
        `.dsh-sidebar-file-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}`,
        `.dsh-sidebar-file-row.unnamed{box-shadow:inset 2px 0 0 var(--dsw-static-deepseek-450,#9e1b1b)}`,
        `.dsh-sidebar-fileicon{flex:none;width:14px;height:14px;display:block}`,
        `.dsh-sidebar-fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
        `.dsh-sidebar-syncdot{flex:none;color:var(--dsw-static-deepseek-450,#9e1b1b);font:var(--dsw-font-xxxs-11,11px/14px system-ui)}`,
        `.dsh-sidebar-stat{flex:none;display:flex;gap:5px;font:var(--dsw-font-xxxs-strong-11,500 11px/14px system-ui);font-family:var(--ds-font-family-code,Consolas,monospace)}`,
        `.dsh-sidebar-stat-add{color:var(--dsw-alias-state-success-primary,#16a34a)}`,
        `.dsh-sidebar-stat-del{color:var(--dsw-alias-state-error-primary,#dc2626)}`,
        `.dsh-sidebar-stat-binary{color:var(--dsw-alias-label-tertiary,#9ca3af);font-weight:400}`,
        `.dsh-sidebar-expandbtn{flex:none;width:20px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:var(--dsw-font-xxxs-11,11px/14px system-ui)}`,
        `.dsh-sidebar-expandbtn:hover{color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-hunkwrap{border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}`,
        `.dsh-sidebar-dline{font:var(--dsw-font-xxxs-11,11px/14px system-ui);font-family:var(--ds-font-family-code,Consolas,monospace);padding:0 8px;white-space:pre;color:var(--dsw-alias-label-secondary,#6b7280)}`,
        `.dsh-sidebar-dline-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 16%,transparent);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-dline-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 14%,transparent);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-dline::before{content:' '}`,
        `.dsh-sidebar-dline-add::before{content:'+'}`,
        `.dsh-sidebar-dline-del::before{content:'-'}`,
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
      ].join('')
      document.head.append(style)

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
          .then(r => r.ok ? r.json() : r.text().then(t => Promise.reject(new Error(r.status + ' ' + t))))
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
        const [docSync, setDocSync] = react.useState({ pending: [] })
        const [notes, setNotes] = react.useState({})
        const [refreshTick, setRefreshTick] = react.useState(0)
        const [expanded, setExpanded] = react.useState(new Set())
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
                setLoading(false)
              })
              .catch(() => { if (!cancelled) setLoading(false) })
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
        const emptyHint = statusMeta?.noCommits === true && view === 'last'
          ? '仓库还没有提交，尚无「上一轮更改」'
          : view === 'last' ? '最近一次提交没有改动' : '这个视图下没有改动'
        const toggleGroup = dir => setOpenGroups(prev => {
          const next = new Set(prev)
          if (next.has(dir)) next.delete(dir)
          else next.add(dir)
          return next
        })
        const openExpand = path => {
          setExpanded(prev => {
            const next = new Set(prev)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
          })
        }
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
                        const isDiffOpen = expanded.has(entry.path)
                        return react.createElement('div', { key: entry.path, className: 'dsh-sidebar-file-entry' },
                          react.createElement('div', { className: 'dsh-sidebar-file-rowwrap' },
                            react.createElement('button', {
                              type: 'button',
                              className: 'dsh-sidebar-file-row' + (note !== '' ? '' : ' unnamed'),
                              title: note !== '' ? `已点名：${note}（点击取消）` : '点击点名',
                              onClick: () => toggleNote(entry.path),
                            },
                              react.createElement(FileIcon, { path: entry.path }),
                              react.createElement('span', { className: 'dsh-sidebar-fname' }, entry.name),
                              syncMissing.length > 0 && react.createElement('span', { className: 'dsh-sidebar-syncdot' }, '⚠'),
                              react.createElement(StatCell, { add: entry.add, del: entry.del, binary: entry.binary })),
                            react.createElement('button', {
                              type: 'button',
                              className: 'dsh-sidebar-expandbtn',
                              title: isDiffOpen ? '收起 diff' : '展开 diff',
                              'aria-expanded': String(isDiffOpen),
                              onClick: () => openExpand(entry.path),
                            }, isDiffOpen ? '−' : '+')),
                          isDiffOpen && react.createElement('div', { className: 'dsh-sidebar-hunkwrap' },
                            react.createElement(DiffViewer, { path: entry.path })))
                      }))
                  })))
      }

      // Line-level diff for one file (design §4.1: hunks + add/del/ctx rows,
      // light self-built parser on the host; binary/truncation show a note).
      function DiffViewer({ path }) {
        const [diff, setDiff] = react.useState(null)
        const [state, setState] = react.useState('loading')
        react.useEffect(() => {
          let cancelled = false
          setState('loading')
          fetchSidebar('/review/diff', {
            method: 'POST',
            body: JSON.stringify({ path }),
          })
            .then(d => { if (!cancelled) { setDiff(d.diff); setState('done') } })
            .catch(() => { if (!cancelled) setState('error') })
          return () => { cancelled = true }
        }, [path])
        if (state === 'loading') return react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '加载 diff…')
        if (state === 'error') return react.createElement('div', { className: 'dsh-sidebar-diffnote' }, 'diff 加载失败')
        if (!diff || diff.binary) return react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '二进制文件，无行级 diff')
        if (!diff.hunks || diff.hunks.length === 0) return react.createElement('div', { className: 'dsh-sidebar-diffnote' }, '无行级变更')
        return react.createElement('div', null,
          diff.truncated && react.createElement('div', { className: 'dsh-sidebar-diffnote' }, 'diff 过长，仅显示前 20000 行'),
          diff.hunks.map((hunk, hi) => react.createElement('div', { key: hi },
            hunk.lines.map((line, li) => react.createElement('div', {
              key: li,
              className: 'dsh-sidebar-dline dsh-sidebar-dline-' + line.t,
            }, line.s || '')))))
      }

      // Terminal launcher tab (design §6.1): the host spawns a real system
      // terminal at the session cwd. State machine is explicit —
      // checking → idle → opening → opened | failed — so the button never
      // reports success on a failed spawn.
      // 官方右栏正文：接收框架注入（本组件目前不消费 tabInfo，但必须接受 props）。
      function TerminalTab(props) {
        void props
        const cwd = react.useSyncExternalStore(store.subscribe, () => store.get().reviewCwd)
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
            react.createElement('div', { className: 'dsh-sidebar-term-label' }, '终端类型'),
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
                      shell.available ? shell.bin : '未安装'))))),
          react.createElement('button', {
            type: 'button',
            className: 'dsh-sidebar-term-go',
            disabled: busy || picked === null,
            onClick: open,
          }, phase === 'opening' ? '正在启动…' : '打开系统终端'),
          result !== null && react.createElement('div', {
            className: 'dsh-sidebar-term-result' + (result.ok ? '' : ' err'),
            role: 'status',
          },
            result.message,
            !result.ok && react.createElement('div', null,
              react.createElement('button', { type: 'button', className: 'dsh-sidebar-term-retry', onClick: open }, '重试'))))
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

      ctx.effect(() => () => {
        window.__DSH_SIDEBAR_BOOTED__ = false
        unsubscribeSessions()
        document.removeEventListener('visibilitychange', onVisibilityChange)
        store.listeners.clear()
        reviewView.listeners.clear()
        style.remove()
      }, 'sidebar: content lifecycle')
    }

    return module.exports
  },
})
