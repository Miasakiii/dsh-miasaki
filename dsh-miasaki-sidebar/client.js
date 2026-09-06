window.__ModuleLoader__.load({
  id: '@miasaki/dsh-sidebar',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')

    const STORAGE_KEY = 'miasaki-sidebar:v1'
    const WIDTH_MIN = 300
    const WIDTH_MAX = 600
    const WIDTH_DEFAULT = 400
    // ≥1280px the panel squeezes the AppFrame grid (spike-measured floor: the
    // center column keeps ≥600px at the default 400px panel); below that the
    // panel floats over a scrim, and under 768px it becomes a full drawer.
    const PUSH_MIN_VIEWPORT = 1280
    const DRAWER_MAX_VIEWPORT = 768
    // Below canvas's fixed overlay (z-index 100) on purpose: the fullscreen
    // canvas covers the sidebar by design, and raising z would stack the
    // sidebar on top of the canvas toolbar (design §3.1.1 constraint 4).
    const PANEL_Z = 60

    // Same anchor strategy as the spike: the AppFrame frame div is the only
    // inline `grid-template-columns` writer under #root; the hashed class is
    // unstable so the style attribute is the stable fact. One selector, here.
    const FRAME_SELECTOR = '#root div[style*="grid-template-columns"]'

    const clampWidth = px => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(px)))

    const TAB_IDS = ['review', 'terminal', 'sidechat']
    const loadPersisted = () => {
      try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
        return {
          open: raw.open === true,
          width: clampWidth(typeof raw.width === 'number' ? raw.width : WIDTH_DEFAULT),
          // null = no active tab: the shell shows the "open a tab" empty state
          // (Edge-style picker) instead of a tab page.
          tab: TAB_IDS.includes(raw.tab) ? raw.tab : null,
        }
      } catch { return { open: false, width: WIDTH_DEFAULT, tab: null } }
    }

    // Module-level store shared by the header toggle and the shell overlay
    // entry (useSyncExternalStore across both slot components; DSH React is
    // 18.3.1 — same pattern as the canvas switch store).
    const store = {
      state: { ...loadPersisted(), viewport: 0, dragging: false, chromeReserve: 0, titlebarVisible: false, reviewCwd: null },
      listeners: new Set(),
      get: () => store.state,
      set(patch) {
        const next = { ...store.state, ...patch }
        const persistKeys = ['open', 'width', 'tab']
        if (persistKeys.some(key => next[key] !== store.state[key])) {
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(persistKeys.map(key => [key, next[key]])))) } catch { /* 私有模式等写入失败时丢弃 */ }
        }
        store.state = next
        for (const listener of store.listeners) listener()
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
    }

    /** Desktop shell reserves its fixed 32px titlebar row: the panel top must clear it (spike §3.1.1: #root is margin-top'd by the shell). */
    const measureChromeReserve = () => {
      let reserve = 0
      try {
        const bar = document.getElementById('miasaki-titlebar')
        if (bar instanceof HTMLElement) {
          const rect = bar.getBoundingClientRect()
          reserve = Math.ceil(rect.height > 0 ? rect.bottom : 32)
        }
      } catch { /* 无桌面壳时兜底 0 */ }
      if (reserve !== store.get().chromeReserve) store.set({ chromeReserve: reserve })
    }

    const pushFrame = () => {
      const frame = document.querySelector(FRAME_SELECTOR)
      if (!(frame instanceof HTMLElement)) return
      const state = store.get()
      // Dragging keeps pushing (live squeeze feedback); `data-dragging` only
      // disables the CSS width transition while the pointer is down.
      const push = state.open && state.viewport >= PUSH_MIN_VIEWPORT ? state.width : 0
      const wanted = push > 0 ? `${push}px` : ''
      if (frame.style.paddingRight !== wanted) frame.style.paddingRight = wanted
    }

    const pushClear = () => {
      const frame = document.querySelector(FRAME_SELECTOR)
      if (frame instanceof HTMLElement && frame.style.paddingRight !== '') frame.style.paddingRight = ''
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
        `.dsh-sidebar-scrim{position:fixed;inset:0;z-index:${PANEL_Z};background:rgba(0,0,0,.32)}`,
        `.dsh-sidebar-panel{position:fixed;top:var(--sidebar-chrome-reserve,0);right:0;bottom:0;z-index:${PANEL_Z};display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#f5f7fa);border-left:1px solid var(--dsw-alias-border-l2,#d1d5db);color:var(--dsw-alias-label-primary,#111827);transition:width .18s ease}`,
        `.dsh-sidebar-panel[data-dragging]{transition:none}`,
        `.dsh-sidebar-tabs{display:flex;align-items:center;gap:2px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));flex:none}`,
        `.dsh-sidebar-tab{height:28px;border:0;border-radius:8px;background:transparent;padding:0 10px;color:var(--dsh-sidebar-ink,var(--dsw-alias-label-secondary,#6b7280));font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}`,
        `.dsh-sidebar-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        // Selected tab reuses the hover token (the DSH left sidebar's neutral
        // gray pill is the agreed reference, not the brand-blue selected).
        `.dsh-sidebar-tab[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-tab[disabled]{opacity:.45;cursor:not-allowed}`,
        `.dsh-sidebar-spacer{flex:1}`,
        `.dsh-sidebar-close{height:24px;width:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);font:600 12px Inter,system-ui,sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center}`,
        `.dsh-sidebar-close:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-body{flex:1;min-height:0;overflow:auto;padding:14px 16px;font:400 12px/1.7 Inter,system-ui,sans-serif;color:var(--dsw-alias-label-secondary,#6b7280)}`,
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
        // Review tab: checklist header, per-entry naming, line-level diff.
        `.dsh-sidebar-review{display:flex;flex-direction:column;gap:12px;height:100%}`,
        `.dsh-sidebar-review-head{display:flex;align-items:center;gap:8px;flex:none}`,
        `.dsh-sidebar-review-title{font:600 13px Inter,system-ui,sans-serif;color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-badge{font:600 11px Inter,system-ui,sans-serif;border-radius:999px;padding:2px 8px;line-height:1.4}`,
        `.dsh-sidebar-badge-warn{background:var(--dsw-static-deepseek-450,#9e1b1b);color:#fff}`,
        `.dsh-sidebar-badge-ok{background:var(--dsw-alias-interactive-bg-selected,#e5e7eb);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-refresh{margin-left:auto;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font-size:14px;line-height:1}`,
        `.dsh-sidebar-refresh:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-note-attach{display:flex;flex-direction:column;gap:8px;flex:none}`,
        `.dsh-sidebar-filelist{display:flex;flex-direction:column;min-height:0;overflow:auto}`,
        `.dsh-sidebar-file{border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.04));margin-bottom:6px;flex:none;display:flex;align-items:stretch}`,
        `.dsh-sidebar-file-main{flex:1;min-width:0;display:flex;flex-direction:column}`,
        `.dsh-sidebar-file.unnamed{border-color:var(--dsw-static-deepseek-450,#9e1b1b)}`,
        `.dsh-sidebar-file-row{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:5px 8px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;text-align:left;font:400 12px Inter,system-ui,sans-serif}`,
        `.dsh-sidebar-file-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}`,
        `.dsh-sidebar-xy{font:600 10px/1 Inter,monospace;background:var(--dsw-alias-interactive-bg-selected,#e5e7eb);border-radius:4px;padding:2px 4px;color:var(--dsw-alias-label-secondary,#6b7280);flex:none}`,
        `.dsh-sidebar-fpath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Inter,monospace}`,
        `.dsh-sidebar-notechip{flex:none;max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-file.named .dsh-sidebar-notechip{color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-expandbtn{flex:none;width:24px;border:0;border-left:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font-size:12px}`,
        `.dsh-sidebar-expandbtn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-syncdot{flex:none;color:var(--dsw-static-deepseek-450,#9e1b1b);font-size:12px}`,
        `.dsh-sidebar-hunkwrap{border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}`,
        `.dsh-sidebar-dline{font:400 11px/1.5 Consolas,'Courier New',monospace;padding:0 8px;white-space:pre;color:var(--dsw-alias-label-secondary,#6b7280)}`,
        `.dsh-sidebar-dline-add{background:rgba(22,163,74,.16);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-dline-del{background:rgba(220,38,38,.14);color:var(--dsw-alias-label-primary,#111827)}`,
        `.dsh-sidebar-dline::before{content:' '}`,
        `.dsh-sidebar-dline-add::before{content:'+'}`,
        `.dsh-sidebar-dline-del::before{content:'-'}`,
        `.dsh-sidebar-diffnote{padding:8px;font:400 11px/1.5 Inter,system-ui,sans-serif;color:var(--dsw-alias-label-tertiary,#9ca3af)}`,
        `.dsh-sidebar-emptyhint{padding:20px;text-align:center;color:var(--dsw-alias-label-tertiary,#9ca3af);font:400 12px Inter,system-ui,sans-serif}`,
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

      // --- Review tab data interface (roadmap §4.1) -----------------------
      const REVIEW_PREFIX = '/sidebar/api/review'
      // cwd lives in the store, refreshed from the DSH sessions service; the
      // review routes take it as a query param (status/checklist) or in the
      // POST body (diff) — always send both from the caller's payload.
      const fetchReview = (path, opts = {}) => {
        const cwd = store.get().reviewCwd
        if (cwd === null || cwd === undefined) return Promise.reject(new Error('当前会话没有工作区'))
        const url = new URL(REVIEW_PREFIX + path, location.origin)
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

      function useReviewCwd() {
        return react.useSyncExternalStore(store.subscribe, () => store.get().reviewCwd)
      }

      // List of every changed file, one line per entry (design §4.1: status
      // snapshot is the M1 "本轮改动" view; no session-event tracking yet).
      function ReviewTab() {
        const cwd = useReviewCwd()
        const [entries, setEntries] = react.useState([])
        const [loading, setLoading] = react.useState(true)
        const [docSync, setDocSync] = react.useState({ pending: [] })
        const [notes, setNotes] = react.useState({})
        const [seenAt, setSeenAt] = react.useState(null)
        const [refreshTick, setRefreshTick] = react.useState(0)
        const [expanded, setExpanded] = react.useState(new Set())

        react.useEffect(() => {
          if (cwd === null) { setLoading(false); return }
          let cancelled = false
          let timer = null
          const fetchAll = () => {
            if (cancelled) return
            setLoading(true)
            fetchReview('/status')
              .then(d => {
                if (cancelled) return
                if (d.status) {
                  setEntries(d.status.entries ?? [])
                  setDocSync(d.docSync ?? { pending: [] })
                  setSeenAt(Date.now())
                }
                setLoading(false)
              })
              .catch(() => { if (!cancelled) setLoading(false) })
          }
          fetchAll()
          // 60s TTL: keep the panel authoritative without constant polling.
          timer = window.setInterval(fetchAll, 60_000)
          return () => { cancelled = true; window.clearInterval(timer) }
        }, [cwd, refreshTick])

        react.useEffect(() => {
          if (cwd === null) return
          let cancelled = false
          fetchReview('/checklist')
            .then(d => { if (!cancelled && d.checklist) setNotes(d.checklist.notes ?? {}) })
            .catch(() => {})
          return () => { cancelled = true }
        }, [cwd, refreshTick])

        if (cwd === null) {
          return react.createElement('div', { className: 'dsh-sidebar-body' },
            react.createElement('p', null, '打开一个会话后即可查看审查数据。'))
        }

        const unnamedCount = entries.filter(entry => !(notes[entry.path] || '').trim()).length
        const syncMissing = (docSync.pending ?? []).flatMap(p => p.missing)
        const allNamed = entries.length > 0 && unnamedCount === 0
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
          fetchReview('/checklist', {
            method: 'POST',
            body: JSON.stringify({ patch: { notes: { [path]: current !== '' ? '' : '已点名' } } }),
          }).catch(() => {})
        }
        const refresh = () => setRefreshTick(t => t + 1)

        return react.createElement('div', { className: 'dsh-sidebar-review' },
          react.createElement('div', { className: 'dsh-sidebar-review-head' },
            react.createElement('span', { className: 'dsh-sidebar-review-title' }, '收尾自检'),
            react.createElement('span', { className: 'dsh-sidebar-badge ' + (allNamed ? 'dsh-sidebar-badge-ok' : 'dsh-sidebar-badge-warn') },
              entries.length === 0 ? '工作区干净' : (allNamed ? '全部点名' : `${unnamedCount} 条未点名`)),
            react.createElement('button', {
              type: 'button',
              className: 'dsh-sidebar-refresh',
              title: '刷新',
              onClick: refresh,
            }, '↻')),
          react.createElement('div', { className: 'dsh-sidebar-filelist' },
            loading
              ? react.createElement('div', { className: 'dsh-sidebar-emptyhint' }, '载入中…')
              : entries.length === 0
                ? react.createElement('div', { className: 'dsh-sidebar-emptyhint' }, '工作区干净，无需审查')
                : entries.map(entry => {
                    const note = (notes[entry.path] || '').trim()
                    const isOpen = expanded.has(entry.path)
                    return react.createElement('div', {
                      key: entry.path,
                      className: 'dsh-sidebar-file ' + (note !== '' ? 'named' : 'unnamed'),
                    },
                      react.createElement('div', { className: 'dsh-sidebar-file-main' },
                        react.createElement('button', {
                          type: 'button',
                          className: 'dsh-sidebar-file-row',
                          title: note !== '' ? `已点名：${note}` : '点击点名',
                          onClick: () => toggleNote(entry.path),
                        },
                          react.createElement('span', { className: 'dsh-sidebar-xy' }, entry.xy),
                          react.createElement('span', { className: 'dsh-sidebar-fpath' }, entry.path),
                          syncMissing.length > 0 && react.createElement('span', { className: 'dsh-sidebar-syncdot' }, '⚠'),
                          note !== ''
                            ? react.createElement('span', { className: 'dsh-sidebar-notechip' }, '已点名')
                            : react.createElement('span', { className: 'dsh-sidebar-notechip' }, '点名…')),
                        isOpen && react.createElement('div', { className: 'dsh-sidebar-hunkwrap' },
                          react.createElement(DiffViewer, { path: entry.path }))),
                      react.createElement('button', {
                        type: 'button',
                        className: 'dsh-sidebar-expandbtn',
                        title: isOpen ? '收起 diff' : '展开 diff',
                        onClick: () => openExpand(entry.path),
                      }, isOpen ? '−' : '+'))
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
          fetchReview('/diff', {
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
          note: '打开系统终端到会话 cwd 的启动器（M1 待填充）。',
          icon: cardIcon([{ shape: 'rect', x: 1.5, y: 2.5, w: 13, h: 11 }, { d: 'M4.5 6l2.5 2-2.5 2M9 10.5h3' }]),
        },
        {
          id: 'sidechat', label: '辅助对话',
          note: '上下文隔离的侧线追问（M2 提供）。',
          icon: cardIcon([{ shape: 'rect', x: 1.5, y: 2.5, w: 13, h: 9, rx: 2.5 }, { d: 'M5.5 11.5v2.6l3.2-2.6' }]),
        },
      ]

      // Edge-style empty state: the picker the panel opens on when no tab is
      // active (first run, or after closing the last tab).
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
              onClick: () => store.set({ tab: tab.id }),
            }, tab.icon, react.createElement('span', null, tab.label)))))
      }

      const TAB_BODIES = { review: ReviewTab }

      function Shell() {
        const state = react.useSyncExternalStore(store.subscribe, store.get)
        if (!state.open) return null
        const pushMode = state.viewport >= PUSH_MIN_VIEWPORT
        const drawerMode = !pushMode && state.viewport < DRAWER_MAX_VIEWPORT
        const width = drawerMode ? Math.min(state.viewport, state.width) : state.width
        const activeTab = state.tab === null ? null : (TABS.find(tab => tab.id === state.tab) ?? TABS[0])
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
        const TabBody = activeTab === null ? null : (TAB_BODIES[activeTab.id] ?? null)
        return react.createElement(react.Fragment, null,
          !pushMode && react.createElement('div', { className: 'dsh-sidebar-scrim', onClick: onScrimClick, 'aria-hidden': 'true' }),
          react.createElement('section', {
            className: 'dsh-sidebar-panel',
            'data-dragging': state.dragging || undefined,
            style: {
              width: `${width}px`,
              '--sidebar-chrome-reserve': `${state.chromeReserve}px`,
            },
            role: 'complementary',
            'aria-label': '侧栏',
          },
            activeTab === null
              ? react.createElement(EmptyState)
              : react.createElement(react.Fragment, null,
                  react.createElement('div', { className: 'dsh-sidebar-tabs', role: 'tablist', 'aria-label': '侧栏工具' },
                    TABS.map(tab => react.createElement('button', {
                      key: tab.id,
                      type: 'button',
                      role: 'tab',
                      className: 'dsh-sidebar-tab',
                      'aria-selected': tab.id === state.tab ? 'true' : 'false',
                      disabled: tab.id === 'sidechat',
                      title: tab.label,
                      onClick: () => store.set({ tab: tab.id }),
                    }, tab.label)),
                    react.createElement('div', { className: 'dsh-sidebar-spacer' }),
                    react.createElement('button', {
                      type: 'button',
                      className: 'dsh-sidebar-close',
                      'aria-label': '关闭当前标签页',
                      title: '关闭标签页',
                      onClick: () => store.set({ tab: null }),
                    }, '×')),
                  TabBody === null
                    ? react.createElement('div', { className: 'dsh-sidebar-body' },
                        react.createElement('strong', null, activeTab.label), ' — ', activeTab.note)
                    : react.createElement('div', { className: 'dsh-sidebar-body dsh-sidebar-review-wrap' },
                        react.createElement(TabBody))),
            react.createElement('div', { className: 'dsh-sidebar-resize', onPointerDown: startDrag, 'aria-hidden': 'true' })))
      }
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'sidebar-shell',
      }, Shell))

      // --- Layout sync: push + watchdog + chrome reserve + viewport -------
      const syncAll = () => {
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
      window.addEventListener('resize', onResize)
      window.addEventListener('keydown', onKeyDown)
      store.subscribe(syncAll)
      syncAll()

      ctx.effect(() => () => {
        // Reset the idempotence guard so a later full reload can remount.
        window.__DSH_SIDEBAR_BOOTED__ = false
        watchdog.disconnect()
        window.clearInterval(watchdogTimer)
        window.removeEventListener('resize', onResize)
        window.removeEventListener('keydown', onKeyDown)
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
