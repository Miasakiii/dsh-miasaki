  /* ---------- 主题化窗控裸键组 + 空白拖动（无边框窗口 · V3 零占位 / V4 去胶囊） ---------- */

  // 窗口控制按钮图标：四枚统一 10×10 视口 SVG（stroke=currentColor、圆头端帽、Fluent 线形），
  // 取代 Unicode 字符（–/□/✕）：字符字形粗细/基线/视觉重量不一，SVG 统一描边后三按钮一致
  var TB_ICONS = {
    min: '<svg viewBox="0 0 10 10" aria-hidden="true"><line x1="1.5" y1="5" x2="8.5" y2="5"/></svg>',
    max: '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" rx="1"/></svg>',
    restore: '<svg viewBox="0 0 10 10" aria-hidden="true">' +
      '<rect x="1.5" y="3.5" width="5" height="5" rx="1"/>' +
      '<path d="M3.5 3.5 V2.5 A1 1 0 0 1 4.5 1.5 H7.5 A1 1 0 0 1 8.5 2.5 V5.5 A1 1 0 0 1 7.5 6.5 H6.5"/></svg>',
    close: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5"/></svg>'
  }

  // 最大化状态：true=最大化 false=还原 null=未知。远程页无 IPC 权限（capability 只授
  // start-dragging），改由 Rust 侧 eval 派发 CustomEvent `miasaki-max-state`（与桌宠状态
  // 推送同构）；null 时经 hash cmd=want-max 请求 Rust 重推，非 Tauri 环境点击本地翻转兜底。
  //
  // 2026-09-26「无限刷新」修复 P4（跨实例共享 + 自动请求双熔断）：
  // 状态与请求计数原本只活在**这份脚本实例**的作用域里。只要页面上存在多份实例，或实例被
  // 反复重建，每个实例就各自重试一次，合起来表现为「一秒多轮、停不下来」——实测 WebView2
  // History 库在 20 秒里留下 20+ 条重复 URL 访问、且 pet.log 里**从未**出现 `hash-cmd want-max`
  // （说明请求都在被抹掉前就没到达壳侧）。现在两样状态都挂到 `window`：
  //   · 任一份实例收到 Rust 推送 → 全体实例立刻收敛，不再各自重问；
  //   · 自动请求加「窗口内次数 + 总量」双熔断 —— 即使推送永远到不了，也只请求有限次。
  // 用户主动点最大化按钮不走本路径（页面已有状态可翻转，见 buildTitlebar 的点击分支）。
  var MAX_REQ_WINDOW_MS = 10000
  var MAX_REQ_PER_WINDOW = 3
  var MAX_REQ_TOTAL = 8

  function sharedMaxReq() {
    try {
      if (!window.__msMaxReq || typeof window.__msMaxReq !== 'object') {
        window.__msMaxReq = { at: 0, times: [], total: 0, tripped: false }
      }
      return window.__msMaxReq
    } catch (e) {
      return { at: 0, times: [], total: 0, tripped: false }
    }
  }

  var MAX_STATE = null
  try { if (typeof window.__msMaxState === 'boolean') MAX_STATE = window.__msMaxState } catch (e) { /* ignore */ }

  /** 读当前最大化状态：**window 级共享值优先**（其它实例已收到推送时本实例立刻跟随）。 */
  function currentMaxState() {
    try {
      if (typeof window.__msMaxState === 'boolean') MAX_STATE = window.__msMaxState
    } catch (e) { /* ignore */ }
    return MAX_STATE
  }

  function setMaxState(v) {
    MAX_STATE = v
    try { window.__msMaxState = v } catch (e) { /* ignore */ }
  }

  function syncMaxBtn() {
    var bar = document.getElementById('miasaki-titlebar')
    if (!bar) return
    var btn = bar.querySelector('.tb-btn[data-act="max"]')
    if (!btn) return
    var wantMax = MAX_STATE === true
    if (btn.getAttribute('data-max-state') !== String(wantMax)) {
      btn.innerHTML = wantMax ? TB_ICONS.restore : TB_ICONS.max
      btn.setAttribute('data-max-state', String(wantMax))
      btn.setAttribute('title', wantMax ? '\u8FD8\u539F' : '\u6700\u5927\u5316')
    }
  }

  function wireMaxState() {
    try {
      window.addEventListener('miasaki-max-state', function (e) {
        try {
          var d = e && e.detail
          setMaxState(!!(d && d.max))
          syncMaxBtn()
        } catch (e2) { /* ignore */ }
      })
    } catch (e) { /* ignore */ }
  }

  function requestMaxState() {
    var now = Date.now()
    var s = sharedMaxReq()
    if (now - s.at < 10000) return
    // 已有共享答案（别的实例收到过推送）→ 不再问
    if (currentMaxState() !== null) return
    s.times = s.times.filter(function (t) { return now - t < MAX_REQ_WINDOW_MS })
    if (s.tripped || s.total >= MAX_REQ_TOTAL || s.times.length >= MAX_REQ_PER_WINDOW) {
      s.tripped = true
      return
    }
    s.at = now
    s.total++
    s.times.push(now)
    try { petHashCmd('want-max') } catch (e) { /* ignore */ }
  }

  /* 契约 v1.1（2026-09-25）受控写能力：**窗控**。
     与标题栏那三枚按钮走**同一个** `petHashCmd`（hash 的唯一写者 —— 保持 W0-T0.2 的结论，
     不新增写者）；契约侧只暴露 `minimize`/`maximize`/`close` 这些人话名，内部协议名
     `min`/`max` 的映射留在这里。
     **双向校验**：白名单外的值一律忽略（事件可被任意页面脚本派发）。 */
  try {
    window.addEventListener('miasaki-window-command', function (e) {
      try {
        var c = e && e.detail && e.detail.command
        if (c === 'minimize') petHashCmd('min')
        else if (c === 'maximize') petHashCmd('max')
        else if (c === 'close') petHashCmd('close')
      } catch (e2) { /* 命令派发失败不影响其它逻辑 */ }
    })
  } catch (e) { /* ignore */ }

  /* ---------- 空白拖动（V3）：页面零占位后没有自绘拖动条 ----------
   * document 级捕获 mousedown：落在窗口顶部 36px 且事件路径上无「可交互元素」
   * （复用 tauri 内置 drag-region 的判定口径：可点击标签 / contenteditable /
   * tabindex / 交互 role）→ 调 tauri 原生 start_dragging；双击 → internal_toggle_maximize。
   * 页面按钮/页签/输入框照常点击，空白处可拖窗，与 Windows 标题栏体感一致。 */
  var DRAG_H = 36
  var DRAG_CLICKABLE_TAGS = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, LABEL: 1, SUMMARY: 1 }
  var DRAG_INTERACTIVE_ROLES = { button: 1, link: 1, menuitem: 1, tab: 1, checkbox: 1, radio: 1, switch: 1, option: 1 }

  function dragIsClickable(el) {
    if (!el || el.nodeType !== 1) return false
    return !!DRAG_CLICKABLE_TAGS[el.tagName] ||
      (el.hasAttribute && el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') ||
      (el.hasAttribute && el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') ||
      (el.getAttribute && !!DRAG_INTERACTIVE_ROLES[el.getAttribute('role')])
  }

  function wireDragZone() {
    try {
      if (document.__miasakiDragWired) return
      document.__miasakiDragWired = true
      document.addEventListener('mousedown', function (e) {
        try {
          if (e.button !== 0) return
          if (e.detail !== 1 && e.detail !== 2) return
          if (e.clientY > DRAG_H) return
          // 事件路径自底向上：按钮组自身/内部(窗控、徽章)不拖；首个可交互元素即放行点击
          var node = e.target
          while (node && node.nodeType === 1) {
            if (node.id === 'miasaki-titlebar') return
            if (dragIsClickable(node)) return
            node = node.parentNode
          }
          // 顶部空白 → 原生拖动 / 双击最大化（与 tauri data-tauri-drag-region 同一 IPC）
          e.preventDefault()
          var cmd = e.detail === 2 ? 'internal_toggle_maximize' : 'start_dragging'
          try {
            if (window.__TAURI_INTERNALS__) window.__TAURI_INTERNALS__.invoke('plugin:window|' + cmd)
          } catch (e2) { /* 非 Tauri 环境忽略 */ }
        } catch (e3) { /* 拖拽失败不影响页面 */ }
      }, true)
    } catch (e) { /* ignore */ }
  }

  function buildTitlebar() {
    // 本地唤醒页同样需要窗控按钮组（无边框窗口）；页面零占位，按钮组浮于内容之上
    if (document.getElementById('miasaki-titlebar') || !document.body) return
    var bar = document.createElement('div')
    bar.id = 'miasaki-titlebar'
    bar.innerHTML =
      '<div class="tb-group">' +
      '<img class="tb-brand" src="' + ICON_BASE + META[current].icon + '" alt="" title="">' +
      '<div class="tb-btn" data-act="min" title="\u6700\u5C0F\u5316">' + TB_ICONS.min + '</div>' +
      '<div class="tb-btn" data-act="max" title="\u6700\u5927\u5316/\u8FD8\u539F">' + TB_ICONS.max + '</div>' +
      '<div class="tb-btn tb-close" data-act="close" title="\u5173\u95ED">' + TB_ICONS.close + '</div>' +
      '</div>'
    // 徽记 icon 失败 → 字形兜底；onerror 用 JS 挂载，换主题后始终引用最新 current
    var brand = bar.querySelector('.tb-brand')
    if (brand) brand.onerror = function () { window.__msGlyphFallback && window.__msGlyphFallback(this, current) }
    document.body.appendChild(bar)
    // 让位量自动化（2026-09-27）：壳成为 `--ms-titlebar-reserve` 的唯一写者，见 watchTitlebarReserve
    watchTitlebarReserve(bar)
    bar.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('.tb-btn') : null
      if (!b) return
      var act = b.getAttribute('data-act')
      if (act === 'min') petHashCmd('min')
      else if (act === 'max') {
        petHashCmd('max')
        // 非 Tauri 环境(普通浏览器预览)兜底：从未收到 Rust 推送时本地翻转图标
        if (currentMaxState() === null) setMaxState(true)
        else if (IS_LOCAL) setMaxState(!MAX_STATE)
        syncMaxBtn()
      }
      else if (act === 'close') petHashCmd('close')
    })
    updateTitlebar()
    syncMaxBtn()
    if (currentMaxState() === null) requestMaxState()
  }

  function updateTitlebar() {
    var brand = document.querySelector('#miasaki-titlebar .tb-brand')
    if (brand) {
      // 清上次加载失败的字形兜底残留（位于胶囊内，data-glyph 标记），再换新主题图标
      var holder = brand.parentNode
      if (holder) {
        var g = holder.querySelector('span[data-glyph="1"]')
        if (g) holder.removeChild(g)
      }
      brand.style.display = ''
      var next = ICON_BASE + META[current].icon
      if (brand.src !== next) brand.src = next
      // 悬浮提示当前主题（顶部无文字，悬停徽章可知主题）
      brand.title = META[current].name + ' · ' + META[current].sub
    }
  }

  /* ---------- 让位量自动化：壳是 `--ms-titlebar-reserve` 的唯一写者（2026-09-27） ---------- */

  // 为什么搬进壳：窗控组是**零占位浮层**（03-switcher.js:51 height:0），官方 DSH 控件靠
  // `--ms-titlebar-reserve` 让开它（`:90` 会话头 padding-right、`:110` dockkit strip margin-right）。
  // 此前这个变量由 **sidebar 线硬编码写 156px**（它往组里插了一个终端键）——
  // 于是「组实宽」这一事实被抄成了常量，而注释里早写明「其他注入方都往 brand 紧前插」：
  // 每多一个注入方，那个常量就失真一次（它已经改过一次：118 → 156）。
  // 现在壳观测**实宽**自行计算，任何注入方插/删按钮都会自动跟随：
  //     组宽 108 → 128 = 108 + right(8) + 呼吸(12)   ← 无注入键形态
  //     组宽 136 → 156 = 136 + 8 + 12               ← sidebar 插终端键后的形态，亦为静态兜底值
  // 兜底：量不到 / ResizeObserver 不可用 ⇒ 本函数不动，
  // `03-switcher.js:89` 的 `:root{--ms-titlebar-reserve:156px}` 仍在（inline 才覆盖它）。
  // 该兜底 2026-09-27 由 128 改为 156：兜底是「无人写」时的最后防线，须按**注入形态上界**
  // 取值——否则「sidebar 删写入（当天生效）+ 壳自动计算未重编（旧 exe）」的空档期里，
  // 变量无人写、回落到 128，官方 ExpandButton 会压住终端键（实机事件见 03-switcher.js 同处注释）。
  var TB_RESERVE_RIGHT = 8
  var TB_RESERVE_GAP = 12

  function syncTitlebarReserve() {
    try {
      var group = document.querySelector('#miasaki-titlebar .tb-group')
      if (!group || typeof group.getBoundingClientRect !== 'function') return
      var width = group.getBoundingClientRect().width
      if (!(width > 0)) return
      document.documentElement.style.setProperty(
        '--ms-titlebar-reserve', Math.round(width + TB_RESERVE_RIGHT + TB_RESERVE_GAP) + 'px')
    } catch (e) { /* 极端环境（无 documentElement）静默：CSS 层已有静态兜底 */ }
  }

  /** 观测窗控组实宽；组内插/删按钮（sidebar 的终端键等）会触发重算。同一元素只挂一个观测者。 */
  function watchTitlebarReserve(bar) {
    var group = bar && bar.querySelector ? bar.querySelector('.tb-group') : null
    if (!group) return
    syncTitlebarReserve()
    try {
      if (typeof ResizeObserver !== 'function') return
      var prev = window.__msTbReserveRO
      if (prev && prev.__msTarget === group) return
      if (prev) { try { prev.disconnect() } catch (e) { /* ignore */ } }
      var ro = new ResizeObserver(function () { syncTitlebarReserve() })
      ro.__msTarget = group
      ro.observe(group)
      window.__msTbReserveRO = ro
    } catch (e) { /* 观测不可用 ⇒ 静态兜底仍生效 */ }
  }
