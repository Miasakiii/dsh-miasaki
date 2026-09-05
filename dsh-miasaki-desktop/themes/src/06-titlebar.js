  /* ---------- 主题化标题栏（无边框窗口） ---------- */

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

  function buildTitlebar() {
    // 本地唤醒页同样需要标题栏（无边框窗口：拖动区 + 窗口按钮），不再因 IS_LOCAL 跳过
    if (document.getElementById('miasaki-titlebar') || !document.body) return
    var bar = document.createElement('div')
    bar.id = 'miasaki-titlebar'
    // 本地页标记：无 DSH 布局可融合，隐藏模拟侧栏/详情分隔线（::before/::after 色块）
    if (IS_LOCAL) bar.setAttribute('data-local', '1')
    bar.innerHTML =
      '<div class="tb-title"><img class="tb-brand" src="' + ICON_BASE + META[current].icon + '" alt="">' +
      '<span id="tb-theme"></span><span class="tb-sub"></span></div>' +
      '<div class="tb-drag" data-tauri-drag-region title="拖动窗口"></div>' +
      '<div class="tb-btn" data-act="min" title="\u6700\u5C0F\u5316">' + TB_ICONS.min + '</div>' +
      '<div class="tb-btn" data-act="max" title="\u6700\u5927\u5316/\u8FD8\u539F">' + TB_ICONS.max + '</div>' +
      '<div class="tb-btn tb-close" data-act="close" title="\u5173\u95ED">' + TB_ICONS.close + '</div>'
    // 徽记 icon 失败 → 字形兜底；onerror 用 JS 挂载，换主题后始终引用最新 current
    var brand = bar.querySelector('.tb-brand')
    if (brand) brand.onerror = function () { window.__msGlyphFallback && window.__msGlyphFallback(this, current) }
    document.body.appendChild(bar)
    // 拖动：交给 Tauri 内置 drag-region（data-tauri-drag-region → OS 级 start_dragging，
    // 系统消息循环接管，彻底跟手；双击标题栏 = 最大化/还原）。
    // 此前用 URL hash 每帧轮询 + set_position 差值应用:33ms 采样滞后、DPI 换算误差、
    // pointer 事件流竞态 → 拖动不跟手/跳变,已弃用。
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
    syncTitlebarGeometry()
  }

  function updateTitlebar() {
    var el = document.getElementById('tb-theme')
    if (el) el.textContent = META[current].name
    var sub = document.querySelector('#miasaki-titlebar .tb-sub')
    if (sub) sub.textContent = META[current].sub
    var brand = document.querySelector('#miasaki-titlebar .tb-brand')
    if (brand) {
      // 清上次加载失败的字形兜底残留（位于 .tb-title 内，data-glyph 标记），再换新主题图标
      var holder = brand.parentNode
      if (holder) {
        var g = holder.querySelector('span[data-glyph="1"]')
        if (g) holder.removeChild(g)
      }
      brand.style.display = ''
      var next = ICON_BASE + META[current].icon
      if (brand.src !== next) brand.src = next
      // 悬浮提示当前主题（侧栏收起、文字隐藏后悬停图标即可知主题）
      brand.title = META[current].name + ' · ' + META[current].sub
    }
  }

