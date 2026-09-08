window.__ModuleLoader__.load({
  id: '@miasaki/dsh-sidebar',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')

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

    // Frame resolution (2026-09-08 rework, probe-verified on DSH 0.1.2-rc.1):
    // every slot host renders <div data-slot="<slotKey>">, so the conversation
    // anchor is the semantic entry point — its parentElement is the AppFrame
    // center column and one level up is the frame itself. The frame carries NO
    // stable attribute of its own (data-dsh-frame / data-pane / data-slot are
    // all absent on this build), so we climb from the official anchor, validate
    // with the inline-style fingerprint, and keep the fingerprint query as the
    // last resort. Single place, here.
    const FRAME_ANCHOR_SELECTOR = '[data-slot="conversation"]'
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

    /** Desktop shell reserves its fixed 32px titlebar row: the panel top must clear it (spike §3.1.1: #root is margin-top'd by the shell). */
    const measureChromeReserve = () => {
      let reserve = 0
      try {
        const bar = document.getElementById('miasaki-titlebar')
        if (bar instanceof HTMLElement) {
          const rect = bar.getBoundingClientRect()
          // A node that exists but renders 0-height reserves nothing. The old
          // `: 32` fallback then pushed the panel down 32px in the browser
          // environment, where the shell ships a hidden titlebar node
          // (probe-measured 2026-09-08: element present, rect.height === 0).
          // The desktop shell keeps rect.height > 0, so it still reserves.
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

    module.exports.inject = ['slots', 'layout', 'sessions']
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
      // All colors come from DSH alias tokens so the panel follows the three
      // themes (web dark/light + desktop brand themes) without any bridge.
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
        `.dsh-sidebar-panel{position:fixed;top:var(--sidebar-chrome-reserve,0);right:0;bottom:0;z-index:${PANEL_Z};display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#f5f7fa);border-left:1px solid var(--dsw-alias-border-l2,#d1d5db);color:var(--dsw-alias-label-primary,#111827);transition:width .18s ease}`,
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
        `.dsh-sidebar-tabs{display:flex;align-items:center;gap:2px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));flex:none;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}`,
        `.dsh-sidebar-tab{display:flex;align-items:center;gap:4px;height:28px;flex:none;max-width:170px;border:0;border-radius:8px;background:transparent;padding:0 3px 0 10px;color:var(--dsw-alias-label-secondary,#6b7280);font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}`,
        `.dsh-sidebar-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        // Selected tab reuses the hover token (the DSH left sidebar's neutral
        // gray pill is the agreed reference, not the brand-blue selected).
        `.dsh-sidebar-tab[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-tab:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#111827);outline-offset:-2px}`,
        `.dsh-sidebar-tab-label{overflow:hidden;text-overflow:ellipsis}`,
        `.dsh-sidebar-tab-close{flex:none;width:18px;height:18px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:600 12px Inter,system-ui,sans-serif;line-height:1;display:flex;align-items:center;justify-content:center}`,
        `.dsh-sidebar-tab-close:hover{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-tablist{flex:none;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center}`,
        `.dsh-sidebar-tablist:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-newtab{flex:none;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:600 13px Inter,system-ui,sans-serif;line-height:1;display:flex;align-items:center;justify-content:center}`,
        `.dsh-sidebar-newtab:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        // Popovers: fixed, because their anchors live inside overflow:auto
        // containers (tab strip / review list head).
        `.dsh-sidebar-popover{position:fixed;z-index:${PANEL_Z + 1};min-width:150px;max-width:280px;max-height:60vh;overflow:auto;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:1px}`,
        `.dsh-sidebar-menuitem{display:flex;align-items:center;gap:6px;width:100%;min-height:28px;padding:4px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;text-align:left;font:400 12px Inter,system-ui,sans-serif}`,
        `.dsh-sidebar-menuitem:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}`,
        `.dsh-sidebar-menuitem[disabled]{opacity:.45;cursor:not-allowed}`,
        `.dsh-sidebar-menuitem[aria-checked="true"]{font-weight:600}`,
        `.dsh-sidebar-menutick{flex:none;width:12px;font-size:11px}`,
        `.dsh-sidebar-menuicon{flex:none;display:flex;color:var(--dsw-alias-label-secondary,#6b7280)}`,
        `.dsh-sidebar-menuicon svg{width:14px;height:14px}`,
        // Panes: every open tab stays mounted (browser semantics) and inactive
        // ones are display:none, so switching back never refetches or resets.
        `.dsh-sidebar-panes{flex:1;min-height:0;display:flex;flex-direction:column}`,
        `.dsh-sidebar-pane{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:12px 14px;font:400 12px/1.7 Inter,system-ui,sans-serif;color:var(--dsw-alias-label-secondary,#6b7280)}`,
        // Used inside a pane (which already pads), so it carries no padding of
        // its own — only its own scroll and type scale.
        `.dsh-sidebar-body{flex:1;min-height:0;overflow:auto;font:400 12px/1.7 Inter,system-ui,sans-serif;color:var(--dsw-alias-label-secondary,#6b7280)}`,
        `.dsh-sidebar-body strong{color:var(--dsw-alias-label-primary,#111827)}`,
        // Empty state: Edge-style tab picker (user reference 2026-09-06) —
        // centered headline + one card per tab; clicking a card opens it.
        `.dsh-sidebar-empty{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 20px;text-align:center}`,
        `.dsh-sidebar-empty h3{margin:0 0 4px;font:600 15px/1.4 Inter,system-ui,sans-serif;color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-empty p{margin:0 0 20px;font:400 12px/1.6 Inter,system-ui,sans-serif;color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-cards{display:flex;gap:10px;width:100%;max-width:340px;justify-content:center}`,
        `.dsh-sidebar-card{flex:1;display:flex;flex-direction:column;align-items:center;gap:9px;padding:18px 8px 13px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.06));cursor:pointer;color:var(--dsw-alias-label-secondary,#6b7280);font:600 12px Inter,system-ui,sans-serif}`,
        `.dsh-sidebar-card:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.35));color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-card:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#111827);outline-offset:2px}`,
        `.dsh-sidebar-card[disabled]{opacity:.4;cursor:not-allowed}`,
        `.dsh-sidebar-card svg{width:18px;height:18px;display:block;fill:none;stroke:currentColor;stroke-width:1.1;stroke-linecap:round;stroke-linejoin:round}`,
        `.dsh-sidebar-resize{position:absolute;top:0;bottom:0;left:-3px;width:6px;cursor:col-resize;touch-action:none;z-index:1}`,
        // Review tab (v0.5.0): view dropdown + directory groups + per-file
        // type icon and +N/-M stats. Naming (点名) stays: an unnamed file row
        // carries a red inset edge, exactly like the pre-v0.5 border.
        `.dsh-sidebar-review{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px}`,
        `.dsh-sidebar-review-head{display:flex;align-items:center;gap:8px;flex:none}`,
        `.dsh-sidebar-viewbtn{display:flex;align-items:center;gap:4px;height:26px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;background:transparent;padding:0 8px;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font:600 12px Inter,system-ui,sans-serif}`,
        `.dsh-sidebar-viewbtn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}`,
        `.dsh-sidebar-caret{font-size:9px;color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-badge{font:600 11px Inter,system-ui,sans-serif;border-radius:999px;padding:2px 8px;line-height:1.4}`,
        `.dsh-sidebar-badge-warn{background:var(--dsw-static-deepseek-450,#9e1b1b);color:#fff}`,
        `.dsh-sidebar-badge-ok{background:var(--dsw-alias-interactive-bg-selected,#e5e7eb);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-refresh{margin-left:auto;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font-size:14px;line-height:1}`,
        `.dsh-sidebar-refresh:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-filelist{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column}`,
        `.dsh-sidebar-group{border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.06));flex:none}`,
        `.dsh-sidebar-group:last-child{border-bottom:0}`,
        `.dsh-sidebar-group-head{display:flex;align-items:center;gap:6px;width:100%;min-height:28px;padding:3px 2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;text-align:left;font:600 11px Inter,system-ui,sans-serif}`,
        `.dsh-sidebar-group-head:hover{color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-grouptoggle{flex:none;width:11px;font-size:9px;color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-groupdir{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Inter,monospace}`,
        `.dsh-sidebar-file-entry{display:flex;flex-direction:column}`,
        `.dsh-sidebar-file-rowwrap{display:flex;align-items:center;gap:2px}`,
        `.dsh-sidebar-file-row{display:flex;align-items:center;gap:7px;width:100%;min-height:30px;padding:3px 2px 3px 17px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;text-align:left;font:400 12px Inter,system-ui,sans-serif}`,
        `.dsh-sidebar-file-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}`,
        `.dsh-sidebar-file-row.unnamed{box-shadow:inset 2px 0 0 var(--dsw-static-deepseek-450,#9e1b1b)}`,
        `.dsh-sidebar-fileicon{flex:none;width:14px;height:14px;display:block}`,
        `.dsh-sidebar-fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
        `.dsh-sidebar-syncdot{flex:none;color:var(--dsw-static-deepseek-450,#9e1b1b);font-size:11px}`,
        `.dsh-sidebar-stat{flex:none;display:flex;gap:5px;font:600 10px/1 Inter,monospace}`,
        `.dsh-sidebar-stat-add{color:#16a34a}`,
        `.dsh-sidebar-stat-del{color:#dc2626}`,
        `.dsh-sidebar-stat-binary{color:var(--dsw-alias-label-tertiary,#9ca3af);font-weight:400}`,
        `.dsh-sidebar-expandbtn{flex:none;width:20px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font-size:11px}`,
        `.dsh-sidebar-expandbtn:hover{color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-hunkwrap{border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}`,
        `.dsh-sidebar-dline{font:400 11px/1.5 Consolas,'Courier New',monospace;padding:0 8px;white-space:pre;color:var(--dsw-alias-label-secondary,#6b7280)}`,
        `.dsh-sidebar-dline-add{background:rgba(22,163,74,.16);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-dline-del{background:rgba(220,38,38,.14);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-dline::before{content:' '}`,
        `.dsh-sidebar-dline-add::before{content:'+'}`,
        `.dsh-sidebar-dline-del::before{content:'-'}`,
        `.dsh-sidebar-diffnote{padding:8px;font:400 11px/1.5 Inter,system-ui,sans-serif;color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-emptyhint{padding:20px;text-align:center;color:var(--dsw-alias-label-tertiary,#9ca3af);font:400 12px Inter,system-ui,sans-serif}`,
        // Terminal launcher tab (design §6.1): cwd readout, shell picker,
        // primary launch button, last-result panel.
        // Terminal tab scrolls inside its own pane (the pane itself is
        // overflow:hidden so the review list can own its scrolling).
        `.dsh-sidebar-term{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px}`,
        `.dsh-sidebar-term-label{font:600 11px Inter,system-ui,sans-serif;color:var(--dsw-alias-label-secondary,#6b7280);text-transform:uppercase;letter-spacing:.04em}`,
        `.dsh-sidebar-term-cwdrow{display:flex;align-items:stretch;gap:6px}`,
        `.dsh-sidebar-term-cwd{flex:1;min-width:0;font:400 11px/1.5 Consolas,'Courier New',monospace;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.04));color:var(--dsw-alias-label-primary,#111827);word-break:break-all}`,
        `.dsh-sidebar-term-copy{flex:none;width:30px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font-size:12px}`,
        `.dsh-sidebar-term-copy:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-term-shells{display:flex;flex-direction:column;gap:4px}`,
        `.dsh-sidebar-term-shell{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font:400 12px Inter,system-ui,sans-serif;text-align:left}`,
        `.dsh-sidebar-term-shell:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}`,
        `.dsh-sidebar-term-shell[aria-checked="true"]{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);border-color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-term-shell[disabled]{opacity:.45;cursor:not-allowed}`,
        `.dsh-sidebar-term-shellname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
        `.dsh-sidebar-term-shellnote{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-term-go{width:100%;min-height:34px;border:0;border-radius:8px;background:var(--dsw-static-deepseek-450,#4b5563);color:#fff;cursor:pointer;font:600 12px Inter,system-ui,sans-serif}`,
        `.dsh-sidebar-term-go:hover:not([disabled]){filter:brightness(1.08)}`,
        `.dsh-sidebar-term-go[disabled]{opacity:.5;cursor:not-allowed}`,
        `.dsh-sidebar-term-result{padding:8px 9px;border-radius:8px;font:400 11px/1.5 Inter,system-ui,sans-serif;border:1px solid var(--dsw-alias-border-l2,#d1d5db);color:var(--dsw-alias-label-secondary,#6b7280)}`,
        `.dsh-sidebar-term-result.err{border-color:var(--dsw-static-deepseek-450,#9e1b1b);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-term-retry{margin-top:6px;border:0;border-radius:6px;padding:3px 8px;background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font:600 11px Inter,system-ui,sans-serif}`,
      ].join('')
      document.head.append(style)

      // --- Toggle entry, environment-switched ------------------------------
      // Desktop shell (miasaki-titlebar present): an icon button rides the
      // shell's own .tb-btn metrics inside the caption group, first in the
      // column (left of the brand badge). Plain browser: the same icon lands
      // in the official session-header actions slot instead. One React
      // registration, the component hides itself when the shell titlebar
      // owns the entry. Icon = DSH's native panel glyph (dsh-client-ui-sidebar
      // `.panelIcon`, 16px fill glyph), mirrored so the panel column reads
      // right-side — user picked the native style over a custom one.
      const SIDEBAR_ICON_PATH = '<path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M9.67272 0.522841C10.8339 0.522841 11.76 0.522714 12.4963 0.602493C13.2453 0.683657 13.8789 0.854248 14.4264 1.25197C14.7504 1.48739 15.0355 1.77247 15.2709 2.0965C15.6686 2.64394 15.8392 3.27758 15.9204 4.02655C16.0002 4.7629 16 5.68895 16 6.85014V9.14986C16 10.3111 16.0002 11.2371 15.9204 11.9735C15.8392 12.7224 15.6686 13.3561 15.2709 13.9035C15.0355 14.2275 14.7504 14.5126 14.4264 14.748C13.8789 15.1458 13.2453 15.3163 12.4963 15.3975C11.76 15.4773 10.8339 15.4772 9.67272 15.4772H6.3273C5.16611 15.4772 4.24006 15.4773 3.50371 15.3975C2.75474 15.3163 2.1211 15.1458 1.57366 14.748C1.24963 14.5126 0.964549 14.2275 0.729131 13.9035C0.331407 13.3561 0.160817 12.7224 0.0796529 11.9735C-0.000126137 11.2371 1.25338e-09 10.3111 1.25338e-09 9.14986V6.85014C1.25329e-09 5.68895 -0.000126137 4.7629 0.0796529 4.02655C0.160817 3.27758 0.331407 2.64394 0.729131 2.0965C0.964549 1.77247 1.24963 1.48739 1.57366 1.25197C2.1211 0.854248 2.75474 0.683657 3.50371 0.602493C4.24006 0.522714 5.16611 0.522841 6.3273 0.522841H9.67272ZM5.54303 1.88715V14.1118C5.78636 14.1128 6.04709 14.1169 6.3273 14.1169H9.67272C10.8639 14.1169 11.7032 14.1164 12.3493 14.0465C12.9824 13.9779 13.3497 13.8494 13.6268 13.6482C13.8354 13.4966 14.0195 13.3125 14.1711 13.1039C14.3723 12.8268 14.5007 12.4595 14.5693 11.8264C14.6393 11.1803 14.6398 10.341 14.6398 9.14986V6.85014C14.6398 5.65896 14.6393 4.81967 14.5693 4.1736C14.5007 3.54048 14.3723 3.17318 14.1711 2.89609C14.0195 2.68747 13.8354 2.50337 13.6268 2.35179C13.3497 2.1506 12.9824 2.02212 12.3493 1.95353C11.7032 1.88358 10.8639 1.88307 9.67272 1.88307H6.3273C6.04709 1.88307 5.78636 1.8862 5.54303 1.88715ZM4.1828 1.91166C3.99125 1.9216 3.8148 1.93577 3.65076 1.95353C3.01764 2.02212 2.65034 2.1506 2.37325 2.35179C2.16463 2.50337 1.98052 2.68747 1.82895 2.89609C1.62776 3.17318 1.49928 3.54048 1.43069 4.1736C1.36074 4.81967 1.36023 5.65896 1.36023 6.85014V9.14986C1.36023 10.341 1.36074 11.1803 1.43069 11.8264C1.49928 12.4595 1.62776 12.8268 1.82895 13.1039C1.98052 13.3125 2.16463 13.4966 2.37325 13.6482C2.65034 13.8494 3.01764 13.9779 3.65076 14.0465C3.81478 14.0642 3.99127 14.0774 4.1828 14.0873V1.91166Z"></path>'
      const SIDEBAR_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">${SIDEBAR_ICON_PATH}</svg>`
      const toggleFrom = current => {
        store.set({ open: !current })
        if (!current) closeNativeDetails()
      }

      function ToggleButton() {
        const state = react.useSyncExternalStore(store.subscribe, () => {
          const snapshot = store.get()
          return snapshot.open + '|' + snapshot.titlebarVisible
        })
        const [openText, titlebarVisibleText] = state.split('|')
        if (titlebarVisibleText === 'true') return null
        const open = openText === 'true'
        return react.createElement('button', {
          type: 'button',
          className: 'dsh-sidebar-toggle',
          'aria-pressed': String(open),
          'aria-label': '侧栏',
          title: '侧栏',
          onClick: () => toggleFrom(open),
        }, react.createElement('svg', {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          dangerouslySetInnerHTML: { __html: SIDEBAR_ICON_PATH },
        }))
      }
      // order lands next to the canvas switch (order 25); browser-only entry.
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'sidebar-toggle',
        order: 30,
      }, ToggleButton))

      // Inject the titlebar variant when the desktop shell is up. The shell
      // builds #miasaki-titlebar independently of this plugin, so the watchdog
      // keeps probing and (re)injects; removing it on teardown restores the
      // shell's own markup (the button carries no shell-side wiring — its
      // click listener is ours and dies with the node). Anchored to the V4
      // `.tb-group` (badge + window controls) with a V3 `.tb-capsule` fallback,
      // placed BEFORE the brand badge per the user's picked spot.
      const syncTitlebarButton = () => {
        const group = document.querySelector('#miasaki-titlebar .tb-group') ?? document.querySelector('#miasaki-titlebar .tb-capsule')
        const visible = group instanceof HTMLElement
        if (!visible) {
          document.querySelector('#miasaki-titlebar .tb-sidebar')?.remove()
          if (store.get().titlebarVisible) store.set({ titlebarVisible: false })
          return
        }
        let button = group.querySelector('.tb-sidebar')
        if (!button) {
          button = document.createElement('div')
          button.className = 'tb-btn tb-sidebar'
          button.setAttribute('data-act', 'sidebar')
          button.setAttribute('role', 'button')
          button.setAttribute('tabindex', '0')
          button.setAttribute('title', '侧栏')
          button.setAttribute('aria-label', '侧栏')
          button.innerHTML = SIDEBAR_ICON_SVG
          button.addEventListener('click', () => toggleFrom(store.get().open))
          group.insertBefore(button, group.firstChild)
        }
        button.setAttribute('aria-pressed', String(store.get().open))
        if (!store.get().titlebarVisible) store.set({ titlebarVisible: true })
      }

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
      function ReviewTab({ tabId, visible = true } = {}) {
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
      function TerminalTab() {
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
              onClick: () => openTab(tab.id),
            }, tab.icon, react.createElement('span', null, tab.label)))))
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
            react.createElement('div', { className: 'dsh-sidebar-tabs', role: 'tablist', 'aria-label': '侧栏标签页' },
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
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'sidebar-shell',
      }, Shell))

      // --- Layout sync: session state + push + watchdog + chrome reserve ----
      const syncAll = () => {
        // Session state first: a restored width/tab must land before the push
        // computation reads it.
        applySessionState()
        pushFrame()
        syncTitlebarButton()
        measureChromeReserve()
        // 0.1.2 restores sessions lazily: the start-of-apply snapshot may be
        // empty and the sessions subscription may not fire afterward, so the
        // watchdog re-reads the cwd too (idempotent, cheap).
        const cwd = currentSessionCwd()
        if (cwd !== store.get().reviewCwd) store.set({ reviewCwd: cwd })
      }
      const onResize = () => {
        store.set({ viewport: window.innerWidth })
        measureChromeReserve()
        pushFrame()
      }
      store.set({ viewport: window.innerWidth, reviewCwd: currentSessionCwd() })
      const unsubscribeSessions = ctx.sessions.list.subscribe(() => {
        const cwd = currentSessionCwd()
        if (cwd !== store.get().reviewCwd) store.set({ reviewCwd: cwd })
      })
      syncAll()
      // Watchdog: a full AppFrame remount drops the inline padding we wrote
      // from outside React, and the shell titlebar may materialize after this
      // plugin's apply — re-assert both on DOM churn; the interval covers a
      // quiet page. Callbacks are idempotent and cheap.
      const watchdog = new MutationObserver(syncAll)
      watchdog.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
      const watchdogTimer = window.setInterval(syncAll, 1500)
      // Escape closes the floating/drawer panel only; the push mode panel is
      // part of the working layout and must not close while typing. When the
      // canvas overlay is up it owns Escape (it covers the panel anyway).
      const onKeyDown = event => {
        if (event.key !== 'Escape') return
        const canvasOverlay = document.querySelector('.dsh-canvas-overlay')
        if (canvasOverlay && canvasOverlay.hidden === false) return
        const state = store.get()
        if (!state.open || state.viewport >= PUSH_MIN_VIEWPORT) return
        store.set({ open: false })
      }
      // Page visibility: tabs consume this through their `visible` prop.
      const onVisibilityChange = () => store.set({ pageVisible: document.visibilityState !== 'hidden' })
      window.addEventListener('resize', onResize)
      window.addEventListener('keydown', onKeyDown)
      document.addEventListener('visibilitychange', onVisibilityChange)
      store.subscribe(syncAll)
      syncAll()

      ctx.effect(() => () => {
        // Reset the idempotence guard so a later full reload can remount.
        window.__DSH_SIDEBAR_BOOTED__ = false
        watchdog.disconnect()
        window.clearInterval(watchdogTimer)
        window.removeEventListener('resize', onResize)
        window.removeEventListener('keydown', onKeyDown)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        unsubscribeSessions()
        store.listeners.clear()
        document.querySelector('#miasaki-titlebar .tb-sidebar')?.remove()
        pushClear()
        style.remove()
      }, 'sidebar: shell lifecycle')
    }

    return module.exports
  },
})
