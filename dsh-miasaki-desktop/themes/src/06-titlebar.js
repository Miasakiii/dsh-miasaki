  /* ---------- 主题化窗控胶囊 + 空白拖动（无边框窗口 · V3 零占位叠加） ---------- */

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
  var MAX_STATE = null
  var _lastMaxReqAt = 0

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
          MAX_STATE = !!(d && d.max)
          syncMaxBtn()
        } catch (e2) { /* ignore */ }
      })
    } catch (e) { /* ignore */ }
  }

  function requestMaxState() {
    var now = Date.now()
    if (now - _lastMaxReqAt < 10000) return
    _lastMaxReqAt = now
    try { petHashCmd('want-max') } catch (e) { /* ignore */ }
  }

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
          // 事件路径自底向上：胶囊自身/内部(窗控、徽章)不拖；首个可交互元素即放行点击
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
    // 本地唤醒页同样需要窗控胶囊（无边框窗口）；页面零占位，胶囊浮于内容之上
    if (document.getElementById('miasaki-titlebar') || !document.body) return
    var bar = document.createElement('div')
    bar.id = 'miasaki-titlebar'
    bar.innerHTML =
      '<div class="tb-capsule">' +
      '<img class="tb-brand" src="' + ICON_BASE + META[current].icon + '" alt="" title="">' +
      '<div class="tb-btn" data-act="min" title="\u6700\u5C0F\u5316">' + TB_ICONS.min + '</div>' +
      '<div class="tb-btn" data-act="max" title="\u6700\u5927\u5316/\u8FD8\u539F">' + TB_ICONS.max + '</div>' +
      '<div class="tb-btn tb-close" data-act="close" title="\u5173\u95ED">' + TB_ICONS.close + '</div>' +
      '</div>'
    // 徽记 icon 失败 → 字形兜底；onerror 用 JS 挂载，换主题后始终引用最新 current
    var brand = bar.querySelector('.tb-brand')
    if (brand) brand.onerror = function () { window.__msGlyphFallback && window.__msGlyphFallback(this, current) }
    document.body.appendChild(bar)
    bar.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('.tb-btn') : null
      if (!b) return
      var act = b.getAttribute('data-act')
      if (act === 'min') petHashCmd('min')
      else if (act === 'max') {
        petHashCmd('max')
        // 非 Tauri 环境(普通浏览器预览)兜底：从未收到 Rust 推送时本地翻转图标
        if (MAX_STATE === null) { MAX_STATE = true; syncMaxBtn() }
        else if (IS_LOCAL) { MAX_STATE = !MAX_STATE; syncMaxBtn() }
      }
      else if (act === 'close') petHashCmd('close')
    })
    updateTitlebar()
    syncMaxBtn()
    if (MAX_STATE === null) requestMaxState()
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
