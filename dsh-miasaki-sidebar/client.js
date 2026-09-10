window.__ModuleLoader__.load({
  id: '@miasaki/dsh-sidebar',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')

    // 自研右栏壳已于 2026-09-10 退役（design/2026-09-10-migrate-to-official-rightbar.md）：
    // 审查 / 终端改为官方右栏的 tab 类型（@deepseek-ai/dsh-client-ui-sidebar-right）。
    // 壳层的注册点与生命周期已移除，但部分壳函数（推挤 / tab 列表 / 空态 / 抽屉判定）
    // 仍作为**未调用的死代码**留在文件里，待第二阶段清理 —— 它们不再产生任何副作用。

    const STORAGE_PREFIX = 'miasaki-sidebar:v3'
    // Migration sources, newest first: v2 was per-session with a single `tab`,
    // v1 (≤ v0.3.x) was one global key. Each is read once, rewritten as v3 and
    // removed — see loadPersisted().
    const LEGACY_PREFIX_V2 = 'miasaki-sidebar:v2'
    const LEGACY_KEY_V1 = 'miasaki-sidebar:v1'
    const WIDTH_MIN = 300
    const WIDTH_MAX = 600
    const WIDTH_DEFAULT = 400
    // ≥1280px the panel squeezes the AppFrame grid (spike-measured floor: the
    // center column keeps ≥600px at the default 400px panel); below that the
    // panel floats over a scrim, and under 768px it becomes a full drawer.
    const PUSH_MIN_VIEWPORT = 1280
    const DRAWER_MAX_VIEWPORT = 768
    // Axis lock for the drawer swipe (px): below this the gesture is still
    // ambiguous and is neither claimed nor released.
    const DRAWER_SWIPE_AXIS_PX = 8
    // Below canvas's fixed overlay (z-index 100) on purpose: the fullscreen
    // canvas covers the sidebar by design, and raising z would stack the
    // sidebar on top of the canvas toolbar (design §3.1.1 constraint 4).
    const PANEL_Z = 60

    // Frame resolution (2026-09-08 rework; re-verified on DSH 0.1.5-rc.1,
    // 2026-09-10): every slot host renders <div data-slot="<slotKey>">, so the
    // centre-panel anchor is the semantic entry point — its parentElement is
    // the AppFrame center column and one level up is the frame itself. DSH
    // 0.1.2 hosted the conversation at a ROOT-level 'conversation' slot; 0.1.5
    // moved it under the root 'main' keyed slot (key 'conversation'), so the
    // host is now [data-slot="main"] and the old selector matches nothing.
    // Both are listed because each build matches exactly one — the climb stays
    // unambiguous either way. The frame STILL carries no stable attribute of
    // its own (0.1.5's frame data-* are all conditional, present only when
    // true), so we climb from the anchor, validate with the inline-style
    // fingerprint, and keep the fingerprint query as the last resort.
    // Probe-verified on 0.1.5-rc.1: all three paths resolve to the same node,
    // and the push moved the centre column by exactly the requested amount.
    // Single place, here.
    const FRAME_ANCHOR_SELECTOR = '[data-slot="main"], [data-slot="conversation"]'
    const FRAME_FINGERPRINT = 'div[style*="grid-template-columns"]'
    const FRAME_FALLBACK_SELECTOR = '#root ' + FRAME_FINGERPRINT
    const resolveFrame = () => {
      const anchor = document.querySelector(FRAME_ANCHOR_SELECTOR)
      const viaAnchor = anchor && anchor.closest ? anchor.closest(FRAME_FINGERPRINT) : null
      if (viaAnchor instanceof HTMLElement) return viaAnchor
      const fallback = document.querySelector(FRAME_FALLBACK_SELECTOR)
      return fallback instanceof HTMLElement ? fallback : null
    }

    const clampWidth = px => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(px)))

    // Swipe-to-close for the narrow-viewport drawer (design §3.1: "遮罩 + 右滑
    // 关闭"). Pure decision, thresholds kept LOCAL so the function is
    // self-contained and test/drawer-gesture.test.js can extract and evaluate it
    // without a DOM (client.js has no other unit coverage — it is a
    // __ModuleLoader__ bundle, see smoke-test-matrix §5). Rules, in order:
    //   1. rightward only — a leftward drag is not a dismiss gesture;
    //   2. vertical intent wins: a mostly-vertical gesture belongs to the tab
    //      body's scrolling and must never close the panel;
    //   3. past 30% of the panel width (or 64px, whichever is larger) → close;
    //   4. otherwise a short fast flick (≥32px at ≥0.6px/ms) → close;
    //   5. everything else springs back. elapsedMs ≤ 0 (synthetic events,
    //      clock quirks) can never satisfy the flick gate.
    const drawerCloseDecision = ({ dx, dy, width, elapsedMs }) => {
      const MIN_DISTANCE_PX = 64
      const WIDTH_FRACTION = 0.3
      const MIN_FLICK_PX = 32
      const FLICK_VELOCITY_PX_PER_MS = 0.6
      if (!(dx > 0)) return false
      if (Math.abs(dx) <= Math.abs(dy)) return false
      if (dx >= Math.max(MIN_DISTANCE_PX, width * WIDTH_FRACTION)) return true
      if (dx < MIN_FLICK_PX) return false
      const ms = elapsedMs > 0 ? elapsedMs : Number.POSITIVE_INFINITY
      return dx / ms >= FLICK_VELOCITY_PX_PER_MS
    }

    // --- Tab model (v0.5.0 browser-style tabs) ---------------------------
    // A tab instance is `{ id, type, view? }`: id is `${type}-${seq}` and is
    // what persistence and React keys use, type picks the body component, and
    // the review view travels with the tab so each instance remembers which
    // working-tree view it shows.
    const TAB_TYPES = ['review', 'terminal', 'sidechat']
    const REVIEW_VIEWS = ['unstaged', 'staged', 'all', 'last']
    const REVIEW_VIEW_LABELS = { unstaged: '未暂存', staged: '已暂存', all: '全部分支更改', last: '上一轮更改' }
    const REVIEW_DEFAULT_VIEW = 'unstaged'

    const normalizeTab = raw => {
      if (raw === null || typeof raw !== 'object' || !TAB_TYPES.includes(raw.type)) return null
      const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `${raw.type}-1`
      const tab = { id, type: raw.type }
      if (raw.type === 'review') tab.view = REVIEW_VIEWS.includes(raw.view) ? raw.view : REVIEW_DEFAULT_VIEW
      return tab
    }

    // v3 shape: { open, width, tabs: [{id, type, view?}], active }. v2 stored a
    // single `tab` id; v1 stored nothing but open/width/tab. Both migrate into
    // a one-element tab list (active = that tab), so an upgrade never loses the
    // panel state the user had.
    const normalizePersisted = raw => {
      const legacyTabs = TAB_TYPES.includes(raw.tab)
        ? [{ id: `${raw.tab}-1`, type: raw.tab, ...(raw.tab === 'review' ? { view: REVIEW_DEFAULT_VIEW } : {}) }]
        : []
      const tabs = Array.isArray(raw.tabs) ? raw.tabs.map(normalizeTab).filter(tab => tab !== null) : legacyTabs
      const active = tabs.some(tab => tab.id === raw.active) ? raw.active : (tabs.length > 0 ? tabs[tabs.length - 1].id : null)
      return {
        open: raw.open === true,
        width: clampWidth(typeof raw.width === 'number' ? raw.width : WIDTH_DEFAULT),
        tabs,
        active,
      }
    }
    const sessionStorageKey = sessionId => `${STORAGE_PREFIX}:${sessionId}`

    // Per-session persistence (v3): open/width/tab-list/active per session id.
    // A session with no record keeps the current UI state and starts its own
    // record on the next change, so switching sessions never snaps the panel
    // shut. v2 (per-session single tab) and v1 (global) migrate once into the
    // first session that asks, then disappear.
    const loadPersisted = sessionId => {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      try {
        const stored = localStorage.getItem(sessionStorageKey(sessionId))
        if (stored !== null) return normalizePersisted(JSON.parse(stored))
        for (const legacyKey of [`${LEGACY_PREFIX_V2}:${sessionId}`, LEGACY_KEY_V1]) {
          const legacy = localStorage.getItem(legacyKey)
          if (legacy === null) continue
          const migrated = normalizePersisted(JSON.parse(legacy))
          localStorage.setItem(sessionStorageKey(sessionId), JSON.stringify(migrated))
          localStorage.removeItem(legacyKey)
          return migrated
        }
      } catch { /* 私有模式 / 损坏数据：回落到当前状态 */ }
      return null
    }

    const savePersisted = (sessionId, state) => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      try {
        localStorage.setItem(sessionStorageKey(sessionId), JSON.stringify({ open: state.open, width: state.width, tabs: state.tabs, active: state.active }))
      } catch { /* 私有模式等写入失败时丢弃 */ }
    }

    // Module-level store shared by the header toggle and the shell overlay
    // entry (useSyncExternalStore across both slot components; DSH React is
    // 18.3.1 — same pattern as the canvas switch store).
    const store = {
      state: {
        open: false,
        width: WIDTH_DEFAULT,
        tabs: [],
        active: null,
        sessionId: null,
        viewport: 0,
        dragging: false,
        // Drawer swipe-to-close (drawer mode only): live finger offset in px
        // and the axis-locked drag flag. Neither is persisted — the persist
        // whitelist below is ['open','width','tabs','active'] only.
        drawerOffset: 0,
        drawerDragging: false,
        chromeReserve: 0,
        titlebarVisible: false,
        reviewCwd: null,
        // Page-visibility gate: a hidden document must not keep polling the
        // host, so tab components receive this as their `visible` prop.
        pageVisible: typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
      },
      listeners: new Set(),
      get: () => store.state,
      set(patch) {
        const next = { ...store.state, ...patch }
        const persistKeys = ['open', 'width', 'tabs', 'active']
        if (persistKeys.some(key => next[key] !== store.state[key])) savePersisted(next.sessionId, next)
        store.state = next
        for (const listener of store.listeners) listener()
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
    }

    // --- Tab list operations ---------------------------------------------
    // Every mutation REPLACES the tabs array so useSyncExternalStore sees a new
    // reference; the store's persist check compares by identity on purpose.
    const mkTab = (type, tabs) => {
      let seq = 1
      while (tabs.some(tab => tab.id === `${type}-${seq}`)) seq += 1
      const tab = { id: `${type}-${seq}`, type }
      if (type === 'review') tab.view = REVIEW_DEFAULT_VIEW
      return tab
    }
    const openTab = type => {
      if (!TAB_TYPES.includes(type)) return
      const tabs = store.get().tabs
      const tab = mkTab(type, tabs)
      store.set({ tabs: [...tabs, tab], active: tab.id })
    }
    const activateTab = id => {
      if (store.get().tabs.some(tab => tab.id === id)) store.set({ active: id })
    }
    // Closing the active tab activates its LEFT neighbour, falling back to the
    // one that slid into its slot — browser behaviour, not "close everything".
    const closeTab = id => {
      const tabs = store.get().tabs
      const index = tabs.findIndex(tab => tab.id === id)
      if (index === -1) return
      const next = tabs.filter(tab => tab.id !== id)
      const active = store.get().active === id ? (next[index - 1]?.id ?? next[index]?.id ?? null) : store.get().active
      store.set({ tabs: next, active })
    }
    const setTabView = (id, view) => {
      if (!REVIEW_VIEWS.includes(view)) return
      store.set({ tabs: store.get().tabs.map(tab => (tab.id === id ? { ...tab, view } : tab)) })
    }

    /** Chrome reserve = the shell titlebar's measured height. The V4 titlebar is a
     *  ZERO-OCCUPANCY overlay (`themes/src/03-switcher.js`: `#miasaki-titlebar{height:0}`,
     *  button group `position:fixed`), so this resolves to 0 in BOTH environments today
     *  (L3 probe 2026-09-09, desktop-shell markup: rect.height === 0, `#root` has no
     *  margin-top). The branch stays for a shell that renders a real band (V3-style). */
    const measureChromeReserve = () => {
      let reserve = 0
      try {
        const bar = document.getElementById('miasaki-titlebar')
        if (bar instanceof HTMLElement) {
          const rect = bar.getBoundingClientRect()
          // A node that exists but renders 0-height reserves nothing — true in
          // BOTH environments since the V4 titlebar became a zero-occupancy
          // overlay (probe 2026-09-08 browser / L3 2026-09-09 desktop shell:
          // element present, rect.height === 0). The >0 branch remains for a
          // shell that renders a real band.
          reserve = rect.height > 0 ? Math.ceil(rect.bottom) : 0
        }
      } catch { /* 无桌面壳时兜底 0 */ }
      if (reserve !== store.get().chromeReserve) store.set({ chromeReserve: reserve })
    }

    // Layout push (2026-09-08 rework): the reserved size lives in a CSS
    // variable on <html> and a standing rule consumes it, so a React
    // re-render of the frame cannot drop the reservation (the previous code
    // wrote inline padding and relied on the watchdog to re-add it). The
    // inline write stays as a fallback for the case where the rule's selector
    // stops matching after a DSH upgrade; both carry the same value, so they
    // never double-push. No transition is added here on purpose: the frame's
    // own `transition: grid-template-columns` belongs to the host, and a
    // `transition` shorthand of ours would silently replace it.
    const PUSH_VAR = '--miasaki-sidebar-width'
    const pushWidth = () => {
      const state = store.get()
      // Dragging keeps pushing (live squeeze feedback).
      return state.open && state.viewport >= PUSH_MIN_VIEWPORT ? state.width : 0
    }

    const pushFrame = () => {
      const push = pushWidth()
      const wanted = push > 0 ? `${push}px` : ''
      // Skip identical writes: the watchdog re-runs this on every DOM mutation
      // and an unchanged setProperty still dirties the root style attribute.
      const root = document.documentElement
      if (root.style.getPropertyValue(PUSH_VAR) !== wanted) root.style.setProperty(PUSH_VAR, wanted)
      const frame = resolveFrame()
      if (frame !== null && frame.style.paddingRight !== wanted) frame.style.paddingRight = wanted
    }

    const pushClear = () => {
      document.documentElement.style.removeProperty(PUSH_VAR)
      const frame = resolveFrame()
      if (frame !== null && frame.style.paddingRight !== '') frame.style.paddingRight = ''
    }

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
        // Browser fallback entry: DSH-native icon-button style (28px circle,
        // transparent, secondary ink, hover token lift — copied from
        // dsh-client-ui-sidebar's .iconButton spec, user-picked 2026-09-06).
        `.dsh-sidebar-toggle{width:28px;height:28px;border:none;border-radius:50%;background:none;padding:0;color:var(--dsw-alias-label-secondary,#6b7280);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}`,
        `.dsh-sidebar-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-toggle[aria-pressed="true"]{color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-toggle:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#111827);outline-offset:2px}`,
        `.dsh-sidebar-toggle svg{width:16px;height:16px;display:block;transform:scaleX(-1)}`,
        // Desktop shell titlebar entry: the shell's .tb-btn base (28px round,
        // hover token) already matches the native style — only swap the icon
        // to the 16px DSH panel glyph (mirrored, panel on the right) and make
        // the pressed state a plain ink change, no filled block.
        `#miasaki-titlebar .tb-btn.tb-sidebar svg{width:16px;height:16px;transform:scaleX(-1)}`,
        `#miasaki-titlebar .tb-btn.tb-sidebar[aria-pressed="true"]{background:none;color:var(--dsw-alias-label-primary,#fff);opacity:1}`,
        // Standing layout-push rule: consumes the variable pushFrame() writes.
        // First selector is the official root-slot anchor chain (probe-verified
        // 2026-09-08: #root > [data-slot="root"] > div IS the AppFrame frame);
        // the second is the inline-style fingerprint fallback. No transition —
        // see the PUSH_VAR comment.
        `#root > [data-slot="root"] > div,${FRAME_FALLBACK_SELECTOR}{padding-right:var(${PUSH_VAR},0px)}`,
        `.dsh-sidebar-scrim{position:fixed;inset:0;z-index:${PANEL_Z};background:rgba(0,0,0,.32)}`,
        `.dsh-sidebar-panel{position:fixed;top:var(--sidebar-chrome-reserve,0);right:0;bottom:0;z-index:${PANEL_Z};display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#f5f7fa);border-left:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));color:var(--dsw-alias-label-primary,#111827);transition:width .18s ease}`,
        `.dsh-sidebar-panel[data-dragging]{transition:none}`,
        // Drawer mode only: animate the swipe-to-close offset, and kill the
        // transition while the finger is down so the panel tracks the pointer.
        // `touch-action:pan-y` hands horizontal gestures to our pointer
        // handlers instead of the browser's scroll/back-swipe — the trade-off
        // is that horizontal scrolling INSIDE the drawer is suppressed, which
        // is acceptable on a <768px viewport (the tab bodies scroll
        // vertically) and is the standard mobile-drawer behaviour.
        `.dsh-sidebar-panel[data-drawer]{transition:width .18s ease,transform .18s ease;touch-action:pan-y}`,
        `.dsh-sidebar-panel[data-drawer-dragging]{transition:none;user-select:none}`,
        `.dsh-sidebar-panel[data-drawer] .dsh-sidebar-resize{display:none}`,
        // Tab strip (v0.5.0 browser-style): the strip scrolls horizontally when
        // tabs overflow, so every popover anchored to a button INSIDE it must
        // be position:fixed — an absolute child would be clipped by this
        // overflow (see .dsh-sidebar-popover).
        `.dsh-sidebar-tabs{display:flex;align-items:center;gap:2px;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));flex:none;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}`,
        `.dsh-sidebar-tab{display:flex;align-items:center;gap:4px;height:28px;flex:none;max-width:170px;border:0;border-radius:8px;background:transparent;padding:0 3px 0 10px;color:var(--dsw-alias-label-secondary,#6b7280);font:var(--dsw-font-xxs-strong-12,500 12px/18px system-ui);cursor:pointer;white-space:nowrap}`,
        `.dsh-sidebar-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        // Selected tab reuses the hover token (the DSH left sidebar's neutral
        // gray pill is the agreed reference, not the brand-blue selected).
        `.dsh-sidebar-tab[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-tab:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#111827);outline-offset:-2px}`,
        `.dsh-sidebar-tab-label{overflow:hidden;text-overflow:ellipsis}`,
        `.dsh-sidebar-tab-close{flex:none;width:18px;height:18px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:var(--dsw-font-xxs-strong-12,500 12px/18px system-ui);line-height:1;display:flex;align-items:center;justify-content:center}`,
        `.dsh-sidebar-tab-close:hover{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-tablist{flex:none;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:var(--dsw-font-xxxs-11,11px/14px system-ui);line-height:1;display:flex;align-items:center;justify-content:center}`,
        `.dsh-sidebar-tablist:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-newtab{flex:none;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:var(--dsw-font-xs-13,13px/20px system-ui);line-height:1;display:flex;align-items:center;justify-content:center}`,
        `.dsh-sidebar-newtab:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
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
        // Panes: every open tab stays mounted (browser semantics) and inactive
        // ones are display:none, so switching back never refetches or resets.
        // Horizontal padding 12px matches DSH's --dsh-sidebar-inline-padding,
        // so the panel's left gutter lines up with the host's own sidebars.
        `.dsh-sidebar-panes{flex:1;min-height:0;display:flex;flex-direction:column}`,
        `.dsh-sidebar-pane{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:12px;font:var(--dsw-font-xs-13,13px/20px system-ui);color:var(--dsw-alias-label-secondary,#6b7280)}`,
        // Used inside a pane (which already pads), so it carries no padding of
        // its own — only its own scroll and type scale.
        `.dsh-sidebar-body{flex:1;min-height:0;overflow:auto;font:var(--dsw-font-xs-13,13px/20px system-ui);color:var(--dsw-alias-label-secondary,#6b7280);scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.3)) transparent}`,
        `.dsh-sidebar-body strong{color:var(--dsw-alias-label-primary,#111827)}`,
        // Empty state: Edge-style tab picker (user reference 2026-09-06) —
        // headline + one card per tab; clicking a card opens it. Anchored to
        // the TOP of the pane (was vertically centred, which left ~310px of
        // dead space above and made the panel read as unfinished — visual
        // review 2026-09-09).
        `.dsh-sidebar-empty{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;padding:36px 20px 24px;text-align:center}`,
        `.dsh-sidebar-empty h3{margin:0 0 6px;font:var(--dsw-font-base-strong-16,500 16px/24px system-ui);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-empty p{margin:0 0 24px;font:var(--dsw-font-xxs-12,12px/18px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-cards{display:flex;gap:10px;width:100%;max-width:340px;justify-content:center}`,
        `.dsh-sidebar-card{position:relative;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px 8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.06));cursor:pointer;color:var(--dsw-alias-label-secondary,#6b7280);font:var(--dsw-font-xxs-strong-12,500 12px/18px system-ui)}`,
        `.dsh-sidebar-card:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.35));color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-card:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#111827);outline-offset:2px}`,
        // Disabled card (sidechat, M2): keep the SAME surface as its siblings
        // and express "not yet" with a corner tag + muted label. The old
        // `opacity:.4` greyed the whole card to ~2:1 contrast and made one card
        // look like a different component (visual review 2026-09-09).
        `.dsh-sidebar-card[disabled]{cursor:not-allowed;color:var(--dsw-alias-label-tertiary,#9ca3af);background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.06))}`,
        `.dsh-sidebar-card[disabled]:hover{background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.06));border-color:var(--dsw-alias-border-l2,#d1d5db)}`,
        `.dsh-sidebar-cardtag{position:absolute;top:6px;right:6px;font:var(--dsw-font-xxxs-11,11px/14px system-ui);color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-card svg{width:18px;height:18px;display:block;fill:none;stroke:currentColor;stroke-width:1.1;stroke-linecap:round;stroke-linejoin:round}`,
        `.dsh-sidebar-resize{position:absolute;top:0;bottom:0;left:-3px;width:6px;cursor:col-resize;touch-action:none;z-index:1}`,
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

      /** Current DSH session id (best-effort; null when no session is open). */
      const currentSessionId = () => {
        try {
          const id = ctx.sessions.list.getSnapshot().current
          return typeof id === 'string' && id !== '' ? id : null
        } catch { return null }
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

      /** Restore the active session's remembered panel state (open / width / tab list). */
      const applySessionState = () => {
        const sessionId = currentSessionId()
        if (sessionId === store.get().sessionId) return
        const restored = loadPersisted(sessionId)
        // No record for this session: keep the current UI state and let the
        // next change write this session's own record.
        store.set(restored === null ? { sessionId } : { sessionId, ...restored })
      }

      function useReviewCwd() {
        return react.useSyncExternalStore(store.subscribe, () => store.get().reviewCwd)
      }

      /** One tab's persisted view (review tabs only); other types read the default. */
      function useTabView(tabId) {
        return react.useSyncExternalStore(store.subscribe, () => {
          const tab = store.get().tabs.find(item => item.id === tabId)
          return tab?.view ?? REVIEW_DEFAULT_VIEW
        })
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
        const tabId = tabInfo.tab.id
        const visible = tabInfo.tab.visible
        const cwd = useReviewCwd()
        const view = useTabView(tabId)
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
                onClick: () => { setTabView(tabId, item); close() },
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

      // --- Shell overlay panel --------------------------------------------
      const cardIcon = paths => react.createElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        paths.map((d, i) => d.shape === 'rect'
          ? react.createElement('rect', { key: i, x: d.x, y: d.y, width: d.w, height: d.h, rx: d.rx ?? 1.5 })
          : react.createElement('path', { key: i, d: d.d })))
      const TABS = [
        {
          id: 'review', label: '审查',
          note: '收尾自检清单 + 本轮改动 diff。',
          icon: cardIcon([{ shape: 'rect', x: 3, y: 1.5, w: 10, h: 13 }, { d: 'M5.5 5.5h5M5.5 8h5M5.5 10.5h3' }]),
        },
        {
          id: 'terminal', label: '终端',
          note: '把系统终端打开到当前会话的工作目录。',
          icon: cardIcon([{ shape: 'rect', x: 1.5, y: 2.5, w: 13, h: 11 }, { d: 'M4.5 6l2.5 2-2.5 2M9 10.5h3' }]),
        },
        {
          id: 'sidechat', label: '辅助对话',
          note: '上下文隔离的侧线追问（M2 提供）。',
          icon: cardIcon([{ shape: 'rect', x: 1.5, y: 2.5, w: 13, h: 9, rx: 2.5 }, { d: 'M5.5 11.5v2.6l3.2-2.6' }]),
        },
      ]

      const tabMeta = type => TABS.find(tab => tab.id === type) ?? TABS[0]
      // Same-type instances get a numeric suffix (browser semantics:
      // 审查 / 审查 2), so the strip stays readable with duplicates open.
      const tabLabel = (tabs, tab) => {
        const same = tabs.filter(item => item.type === tab.type)
        const base = tabMeta(tab.type).label
        if (same.length <= 1) return base
        return `${base} ${same.findIndex(item => item.id === tab.id) + 1}`
      }

      // Edge-style empty state: the picker the panel opens on when NO tab is
      // open (first run, or after closing the last one). Clicking a card opens
      // a new tab instance.
      function EmptyState() {
        return react.createElement('div', { className: 'dsh-sidebar-empty' },
          react.createElement('h3', null, '打开标签页'),
          react.createElement('p', null, '选择要在侧边面板中打开的标签。'),
          react.createElement('div', { className: 'dsh-sidebar-cards' },
            TABS.map(tab => react.createElement('button', {
              key: tab.id,
              type: 'button',
              className: 'dsh-sidebar-card',
              disabled: tab.id === 'sidechat',
              title: tab.id === 'sidechat' ? '辅助对话（M2 规划中）' : undefined,
              onClick: () => openTab(tab.id),
            },
              tab.id === 'sidechat' && react.createElement('span', { className: 'dsh-sidebar-cardtag' }, 'M2'),
              tab.icon,
              react.createElement('span', null, tab.label)))))
      }

      const TAB_BODIES = { review: ReviewTab, terminal: TerminalTab }

      function Shell() {
        const state = react.useSyncExternalStore(store.subscribe, store.get)
        if (!state.open) return null
        const pushMode = state.viewport >= PUSH_MIN_VIEWPORT
        const drawerMode = !pushMode && state.viewport < DRAWER_MAX_VIEWPORT
        const width = drawerMode ? Math.min(state.viewport, state.width) : state.width
        const tabs = state.tabs
        const onScrimClick = () => store.set({ open: false })
        const startDrag = event => {
          if (!pushMode) return
          event.preventDefault()
          const startX = event.clientX
          const startWidth = store.get().width
          store.set({ dragging: true })
          const onMove = moveEvent => store.set({ width: clampWidth(startWidth + (startX - moveEvent.clientX)) })
          const onUp = () => {
            store.set({ dragging: false })
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
          }
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
        }
        // Swipe-to-close (drawer mode only, design §3.1). The axis is locked on
        // the first significant move: a vertical gesture is released back to
        // the tab body (no preventDefault, so native scrolling keeps working),
        // a horizontal one drives the live offset and is decided on release.
        const startDrawerSwipe = event => {
          if (!drawerMode) return
          if (event.pointerType === 'mouse' && event.button !== 0) return
          const startX = event.clientX
          const startY = event.clientY
          const startedAt = event.timeStamp
          const panelWidth = width
          let axis = null
          const finish = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            window.removeEventListener('pointercancel', onCancel)
          }
          const onMove = moveEvent => {
            const dx = moveEvent.clientX - startX
            const dy = moveEvent.clientY - startY
            if (axis === null) {
              if (Math.abs(dx) < DRAWER_SWIPE_AXIS_PX && Math.abs(dy) < DRAWER_SWIPE_AXIS_PX) return
              axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
              if (axis === 'y') return
              store.set({ drawerDragging: true })
            }
            if (axis !== 'x') return
            store.set({ drawerOffset: Math.max(0, dx) })
          }
          const onUp = upEvent => {
            finish()
            const dx = upEvent.clientX - startX
            const dy = upEvent.clientY - startY
            const close = axis === 'x' && drawerCloseDecision({
              dx,
              dy,
              width: panelWidth,
              elapsedMs: upEvent.timeStamp - startedAt,
            })
            store.set({ drawerDragging: false, drawerOffset: 0 })
            if (close) store.set({ open: false })
          }
          // A cancelled pointer (system gesture, focus loss) springs back — it
          // must never dismiss the panel on the user's behalf.
          const onCancel = () => {
            finish()
            store.set({ drawerDragging: false, drawerOffset: 0 })
          }
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
          window.addEventListener('pointercancel', onCancel)
        }
        // Visibility gate: only the ACTIVE tab polls, and only while the
        // document is visible. Inactive panes stay mounted but idle (browser
        // semantics: switching back must not refetch or reset their state).
        const pageVisible = state.open && state.pageVisible
        return react.createElement(react.Fragment, null,
          !pushMode && react.createElement('div', { className: 'dsh-sidebar-scrim', onClick: onScrimClick, 'aria-hidden': 'true' }),
          react.createElement('section', {
            className: 'dsh-sidebar-panel',
            'data-dragging': state.dragging || undefined,
            'data-drawer': drawerMode || undefined,
            'data-drawer-dragging': state.drawerDragging || undefined,
            style: {
              width: `${width}px`,
              '--sidebar-chrome-reserve': `${state.chromeReserve}px`,
              // Live swipe offset — drawer mode only, and only while dragging
              // rightward (0 renders nothing, so the panel sits flush).
              transform: drawerMode && state.drawerOffset > 0 ? `translateX(${state.drawerOffset}px)` : undefined,
            },
            onPointerDown: startDrawerSwipe,
            role: 'complementary',
            'aria-label': '侧栏',
          },
            // Empty state owns the whole panel: with zero tabs the strip would
            // render a lone "＋" floating on blank space, which reads as a stray
            // glyph rather than a control (visual review 2026-09-09). The
            // picker cards below are the entry point in that state.
            tabs.length > 0 && react.createElement('div', { className: 'dsh-sidebar-tabs', role: 'tablist', 'aria-label': '侧栏标签页' },
              // ⌄ 全部标签列表（用户拍板本期实现）：标签溢出时也能点到。
              tabs.length > 0 && react.createElement(MenuButton, {
                className: 'dsh-sidebar-tablist',
                label: '所有标签',
                title: '所有标签',
                text: '⌄',
                renderMenu: close => tabs.map(tab => react.createElement('button', {
                  key: tab.id,
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': String(tab.id === state.active),
                  className: 'dsh-sidebar-menuitem',
                  onClick: () => { activateTab(tab.id); close() },
                },
                  react.createElement('span', { className: 'dsh-sidebar-menutick' }, tab.id === state.active ? '✓' : ''),
                  react.createElement('span', { className: 'dsh-sidebar-menuicon' }, tabMeta(tab.type).icon),
                  tabLabel(tabs, tab))),
              }),
              tabs.map(tab => react.createElement('button', {
                key: tab.id,
                type: 'button',
                role: 'tab',
                className: 'dsh-sidebar-tab',
                'aria-selected': tab.id === state.active ? 'true' : 'false',
                title: tabLabel(tabs, tab),
                onClick: () => activateTab(tab.id),
              },
                react.createElement('span', { className: 'dsh-sidebar-tab-label' }, tabLabel(tabs, tab)),
                // A span, not a button: nesting a button inside a button is
                // invalid HTML. Keyboard users reach the same action through
                // the ⌄ list, so this one stays out of the tab order.
                react.createElement('span', {
                  className: 'dsh-sidebar-tab-close',
                  role: 'button',
                  'aria-label': `关闭 ${tabLabel(tabs, tab)}`,
                  title: '关闭标签页',
                  onClick: event => { event.stopPropagation(); closeTab(tab.id) },
                }, '×'))),
              react.createElement(MenuButton, {
                className: 'dsh-sidebar-newtab',
                label: '新建标签',
                title: '新建标签',
                text: '＋',
                align: 'right',
                renderMenu: close => TABS.map(item => react.createElement('button', {
                  key: item.id,
                  type: 'button',
                  role: 'menuitem',
                  className: 'dsh-sidebar-menuitem',
                  disabled: item.id === 'sidechat',
                  onClick: () => {
                    if (item.id === 'sidechat') return
                    openTab(item.id)
                    close()
                  },
                },
                  react.createElement('span', { className: 'dsh-sidebar-menuicon' }, item.icon),
                  item.label)),
              })),
            tabs.length === 0
              ? react.createElement(EmptyState)
              : react.createElement('div', { className: 'dsh-sidebar-panes' },
                  tabs.map(tab => {
                    const meta = tabMeta(tab.type)
                    const Body = TAB_BODIES[tab.type]
                    const isActive = tab.id === state.active
                    return react.createElement('div', {
                      key: tab.id,
                      className: 'dsh-sidebar-pane',
                      role: 'tabpanel',
                      'aria-hidden': String(!isActive),
                      style: { display: isActive ? 'flex' : 'none' },
                    }, Body === undefined
                      ? react.createElement('div', { className: 'dsh-sidebar-body' },
                          react.createElement('strong', null, meta.label), ' — ', meta.note)
                      : react.createElement(Body, { tabId: tab.id, visible: isActive && pageVisible }))
                  })),
            react.createElement('div', { className: 'dsh-sidebar-resize', onPointerDown: startDrag, 'aria-hidden': 'true' })))
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
          disposers.push(ctx.sidebarRightTabs.register({
            id: tab.id,
            kind: tab.kind,
            title: () => tab.title,
            guide: [{ kind: tab.kind, title: tab.title, description: tab.description, order: tab.order }],
          }))
          // ② 正文：key 是**类型 id**（不是 kind）。
          disposers.push(ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tab.id }, tab.Body))
        }
        return () => { for (const dispose of disposers.reverse()) dispose() }
      }, 'sidebar: official right-bar tab types')

      // --- Session 跟随：审查 tab 需要当前会话的 cwd -----------------------
      // 原壳的推挤 / watchdog / chrome reserve 随壳退役，这里只留内容层需要的同步。
      store.set({ viewport: window.innerWidth, reviewCwd: currentSessionCwd() })
      const unsubscribeSessions = ctx.sessions.list.subscribe(() => {
        const cwd = currentSessionCwd()
        if (cwd !== store.get().reviewCwd) store.set({ reviewCwd: cwd })
      })

      ctx.effect(() => () => {
        window.__DSH_SIDEBAR_BOOTED__ = false
        unsubscribeSessions()
        store.listeners.clear()
        style.remove()
      }, 'sidebar: content lifecycle')
    }

    return module.exports
  },
})
