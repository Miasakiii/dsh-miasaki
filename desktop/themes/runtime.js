/* ============================================================
 * Miasaki 主题注入运行时（injected on every document）
 * 职责：主题属性管理 · 明暗锁定 · 悬浮切换条 · 切换过渡 · 水印
 * 构建时由 scripts/build-init.mjs 将 themes/*.css 内联进
 * window.__MIASAKI_STYLES__ 后与本文件合并。
 * ============================================================ */
(function () {
  'use strict'
  if (window.__MIASAKI_BOOTED__) return
  window.__MIASAKI_BOOTED__ = true

  // 全局错误陷阱：异常可视化到屏幕左上角（诊断用，可被 MiMo 读取）
  var ERR_COUNT = 0
  window.addEventListener('error', function (e) {
    ERR_COUNT++
    try {
      var d = document.createElement('div')
      d.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#d00;color:#fff;' +
        'font:11px monospace;padding:5px 8px;max-width:700px;white-space:pre-wrap;border-radius:0 0 8px 0'
      d.textContent = 'MIASAKI-ERR: ' + (e.message || e.type) + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno
      document.body.appendChild(d)
    } catch (e2) { /* ignore */ }
  })

  var STYLES = (typeof window.__MIASAKI_STYLES__ === 'object' && window.__MIASAKI_STYLES__) || {}
  var KEY = 'miasaki.theme'
  var ORDER = ['pure', 'zafkiel', 'kurkuriel']
  var META = {
    pure: { name: '原版', sub: '简约纯净', glyph: '\u25EF', icon: 'theme-pure.png' },
    zafkiel: { name: '刻刻帝', sub: 'Zafkiel \u00b7 XII', glyph: 'XII', icon: 'theme-zafkiel.png' },
    kurkuriel: { name: '狂狂帝', sub: 'Kurkuriel \u00b7 \u53cd\u8f6c', glyph: '\u264f', icon: 'theme-inverse.png' }
  }
  var TIPS = {
    pure: '\u539f\u7248 DSH \u00b7 \u7b80\u7ea6\u7eaf\u51c0',
    zafkiel: '\u3075\u3075\u3075\uff0c\u4eca\u665a\u7684\u65f6\u95f4\u4e5f\u5c5e\u4e8e\u6211\u5462',
    kurkuriel: '\u9009\u597d\u4e86\u5417\uff1f\u6211\u8ba8\u538c\u72b9\u8c6b\u7684\u4eba'
  }
  var FORCE_DARK = { pure: null, zafkiel: true, kurkuriel: false }
  // 原版主题明暗三档：system=跟随 DSH 自身偏好 / light / dark
  var BRIGHT = 'system'
  try {
    var bs = localStorage.getItem('miasaki.bright')
    if (bs === 'light' || bs === 'dark' || bs === 'system') BRIGHT = bs
  } catch (e) { /* ignore */ }
  var PET_MODES = { pure: 'whale', zafkiel: 'kurumi', kurkuriel: 'inverse' }

  // 主题同步通道：URL hash（replaceState 不触发刷新；Rust 侧轮询解析 → 联动桌宠）
  // hash 内附带诊断位：stylesLen.headOK.attached，便于无 IPC 环境远程排障
  function syncHash() {
    try {
      if (history.replaceState) {
        var d = '0.0.0.0.0.0.0.0.0.0.0.0'
        try {
          var len = (STYLES[current] || '').length
          var headOk = document.head ? 1 : 0
          var attached = styleEl && styleEl.parentNode !== null ? 1 : 0
          var sw = document.getElementById('miasaki-switcher') ? 1 : 0
          var pt = document.getElementById('miasaki-pet') ? 1 : 0
          var baseOk = baseEl && baseEl.parentNode !== null && baseEl.textContent.length > 100 ? 1 : 0
          var swEl = document.getElementById('miasaki-switcher')
          var swTop = swEl ? Math.round(swEl.getBoundingClientRect().top) : -999
          var vh = window.innerHeight || 0
          var eSw = '?'
          var swCss = '?'
          if (swEl && document.elementFromPoint) {
            var rect = swEl.getBoundingClientRect()
            var cx2 = Math.round(rect.left + rect.width / 2)
            var cy2 = Math.round(rect.top + rect.height / 2)
            var topEl = (cx2 > 0 && cy2 > 0 && cx2 < vh * 2) ? document.elementFromPoint(cx2, cy2) : null
            eSw = topEl ? (topEl.id || topEl.tagName || '?').toString().slice(0, 8) : 'null'
            var cs = getComputedStyle(swEl)
            swCss = cs.position + '/' + cs.zIndex + '/' + cs.visibility + '/' + cs.display
          }
          var canvas = document.querySelector('#miasaki-pet canvas')
          var px = 'no'
          var cov = 0
          var petHidden = 0
          if (pet.root) {
            petHidden = pet.root.style.display === 'none' ? 1 : 0
          }
          if (canvas) {
            try {
              var dctx = canvas.getContext('2d')
              var dd = dctx.getImageData(96, 104, 1, 1).data
              px = dd[0] + ',' + dd[1] + ',' + dd[2] + ',' + dd[3]
              var full = dctx.getImageData(0, 0, 192, 208).data
              var hits = 0
              var total = 0
              for (var yy = 8; yy < 208; yy += 16) {
                for (var xx = 8; xx < 192; xx += 16) {
                  total++
                  if (full[(yy * 192 + xx) * 4 + 3] > 24) hits++
                }
              }
              cov = Math.round(hits * 100 / total)
            } catch (e2) { px = 'taint' }
          }
          d = len + '.' + headOk + '.' + attached + '.' + sw + '.' + pt + '.' + ERR_COUNT + '.' + baseOk + '.' + swTop + '.' + vh + '.' + encodeURIComponent(eSw) + '.' + encodeURIComponent(swCss) + '.' + px + '.' + cov + '.' + petHidden
        } catch (e) { /* ignore */ }
        history.replaceState(null, '', '#miasaki-theme=' + current + '&int=' + CUR_INT + '&diag=' + d)
      }
    } catch (e) { /* ignore */ }
  }

  function notifyPet() {
    try {
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke('set_pet_mode', {
          mode: PET_MODES[current] || 'whale'
        }).catch(function () {})
      }
    } catch (e) { /* 非 Tauri 环境（普通浏览器）忽略 */ }
  }

  var IS_LOCAL = location.protocol === 'tauri:'

  var current = 'pure'
  try {
    var saved = localStorage.getItem(KEY)
    if (ORDER.indexOf(saved) >= 0) current = saved
    var qp = new URLSearchParams(location.search).get('miasaki-theme')
    if (ORDER.indexOf(qp) >= 0) current = qp
  } catch (e) { /* ignore */ }

  var styleEl = null
  function ensureStyle() {
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = 'miasaki-theme-layer'
    }
    // 文档创建时 head 可能尚未就绪：已创建但未挂载 → 补挂载
    var head = document.head || document.documentElement
    if (styleEl.parentNode === null && head) {
      head.appendChild(styleEl)
    }
    return styleEl
  }

  var baseEl = null
  function ensureBase() {
    if (!baseEl) {
      baseEl = document.createElement('style')
      baseEl.id = 'miasaki-switcher-css'
    }
    var head = document.head || document.documentElement
    if (baseEl.parentNode === null && head) {
      head.appendChild(baseEl)
    }
    return baseEl
  }

  function setAttr(t) {
    var el = document.documentElement
    if (el) el.setAttribute('data-miasaki-theme', t)
  }

  function syncDark() {
    if (!document.body) return
    var want = FORCE_DARK[current]
    if (current === 'pure') {
      // 原版：明暗三档（浅/深/跟随系统）
      if (BRIGHT === 'dark') want = true
      else if (BRIGHT === 'light') want = false
      else return // system：不干预 DSH 自身偏好
    }
    if (want === null) return
    document.body.toggleAttribute('data-ds-dark-theme', want)
  }

  var observer = null
  function startObserver() {
    if (observer || !document.body) return
    observer = new MutationObserver(function (muts) {
      var want = FORCE_DARK[current]
      if (current === 'pure') {
        if (BRIGHT === 'dark') want = true
        else if (BRIGHT === 'light') want = false
        else return
      }
      if (want === null) return
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].type === 'attributes') { syncDark(); return }
      }
    })
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme']
    })
  }

  function apply(t) {
    if (ORDER.indexOf(t) < 0) t = 'pure'
    current = t
    setAttr(t)
    ensureStyle()
    if (styleEl) styleEl.textContent = STYLES[t] || ''
    syncDark()
    try { localStorage.setItem(KEY, t) } catch (e) { /* ignore */ }
    updateWatermark()
    refreshSwitcher()
    if (INPAGE_PET) petUpdateMode(t)
    updateTitlebar()
    syncHash()
    notifyPet()
  }

  /* ---------- 悬浮切换条（全部变量带回退色，样式层异常时仍可见可用） ---------- */
  var SWITCHER_CSS =
    '#miasaki-switcher{position:fixed;right:16px;bottom:16px;z-index:99990;' +
    'font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;user-select:none;' +
    'direction:ltr;text-align:left;}' +
    '#miasaki-switcher .ms-btn{position:relative;width:46px;height:46px;border-radius:50%;display:flex;' +
    'align-items:center;justify-content:center;cursor:pointer;' +
    'background:var(--ms-panel,#1e1a27);border:2px solid var(--ms-accent,#d9b36a);color:var(--ms-accent,#d9b36a);' +
    'box-shadow:0 0 0 4px rgba(0,0,0,.22),0 6px 20px rgba(0,0,0,.5);' +
    'transition:transform .2s ease;' +
    'font-family:Georgia,"Times New Roman",serif;font-size:13px;font-weight:700;}' +
    '#miasaki-switcher .ms-btn::after{content:"";position:absolute;inset:-6px;border-radius:50%;' +
    'border:1px solid var(--ms-accent,#d9b36a);opacity:.5;animation:ms-ping 2.6s ease-out infinite;}' +
    '@keyframes ms-ping{0%{transform:scale(.8);opacity:.6}70%{transform:scale(1.15);opacity:0}100%{opacity:0}}' +
    '#miasaki-switcher .ms-btn:hover{transform:scale(1.08);}' +
    '#miasaki-switcher .ms-panel{position:absolute;right:0;bottom:58px;display:none;' +
    'flex-direction:column;gap:4px;padding:8px;border-radius:12px;min-width:176px;' +
    'background:var(--ms-panel,#1e1a27);border:1px solid var(--ms-accent,#d9b36a);color:var(--ms-text,#e4def0);' +
    'box-shadow:0 12px 30px rgba(0,0,0,.5);}' +
    '#miasaki-switcher.open .ms-panel{display:flex;}' +
    '#miasaki-switcher .ms-opt{display:flex;align-items:center;gap:10px;padding:7px 10px;' +
    'border-radius:8px;cursor:pointer;}' +
    '#miasaki-switcher .ms-opt:hover{background:var(--ms-hover,#2a2434);}' +
    '#miasaki-switcher .ms-opt.active{box-shadow:inset 0 0 0 1.5px var(--ms-accent,#d9b36a);}' +
    '#miasaki-switcher .ms-glyph{width:30px;height:30px;flex:none;border-radius:50%;' +
    'display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;' +
    'border:1px solid var(--ms-accent,#d9b36a);color:var(--ms-accent,#d9b36a);background:transparent;}' +
    '#miasaki-switcher .ms-name{font-size:13px;font-weight:600;}' +
    '#miasaki-switcher .ms-sub{font-size:11px;opacity:.62;}' +
    '#miasaki-switcher .ms-tip{font-size:11px;opacity:.55;padding:3px 10px 1px;max-width:200px;}' +
    '#miasaki-overlay{position:fixed;inset:0;z-index:99999;pointer-events:none;opacity:0;}' +
    '#miasaki-overlay.run{animation:ms-sweep .4s ease forwards;}' +
    '@keyframes ms-sweep{0%{opacity:0}45%{opacity:.85}100%{opacity:0}}' +
    '@media (prefers-reduced-motion: reduce){' +
    '#miasaki-switcher .ms-btn::after{animation:none}' +
    '#miasaki-overlay.run{animation:ms-sweep .15s ease forwards;}}' +
    '#miasaki-switcher .ms-bright{display:none;align-items:center;gap:6px;padding:5px 10px 2px;' +
    'border-top:1px solid var(--ms-border,#3a3243);margin-top:4px;}' +
    '#miasaki-switcher .ms-bright .mb-label{font-size:11px;opacity:.6;margin-right:4px;}' +
    '#miasaki-switcher .ms-bright .mb{width:26px;height:26px;border-radius:50%;display:flex;' +
    'align-items:center;justify-content:center;cursor:pointer;font-size:13px;' +
    'border:1px solid transparent;opacity:.55;}' +
    '#miasaki-switcher .ms-bright .mb:hover{background:var(--ms-hover,#2a2434);opacity:.9;}' +
    '#miasaki-switcher .ms-bright .mb.on{border-color:var(--ms-accent,#d9b36a);opacity:1;}' +
    '#miasaki-titlebar{position:fixed;left:0;top:0;right:0;height:36px;z-index:100000;' +
    'display:flex;align-items:center;gap:10px;padding:0 8px 0 12px;' +
    'background:var(--ms-panel,#1e1a27);border-bottom:1px solid var(--ms-border,#3a3243);' +
    'color:var(--ms-text,#e4def0);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
    'user-select:none;-webkit-user-select:none;cursor:default;}' +
    '#miasaki-titlebar .tb-drag{flex:1;height:100%;cursor:move;-webkit-app-region:no-drag;}' +
    '#miasaki-titlebar .tb-title{font-size:12.5px;font-weight:600;letter-spacing:.04em;' +
    'display:flex;align-items:center;gap:8px;}' +
    '#miasaki-titlebar .tb-title .tb-dot{width:8px;height:8px;border-radius:50%;background:var(--ms-accent,#d9b36a);}' +
    '#miasaki-titlebar .tb-btn{width:34px;height:26px;display:flex;align-items:center;justify-content:center;' +
    'cursor:pointer;font-size:12px;border-radius:6px;color:var(--ms-text,#e4def0);}' +
    '#miasaki-titlebar .tb-btn:hover{background:var(--ms-hover,#2a2434);}' +
    '#miasaki-titlebar .tb-btn.tb-close:hover{background:#c23a2e;color:#fff;}' +
    'body #root{margin-top:36px;height:calc(100vh - 36px)!important;}'

  var switcher = null
  var overlay = null

  function refreshSwitcher() {
    if (!switcher) return
    var btn = switcher.querySelector('.ms-btn')
    if (btn) {
      btn.innerHTML = '<img src="' + ICON_BASE + META[current].icon + '" alt=""' +
        ' onerror="window.__msGlyphFallback && window.__msGlyphFallback(this, \'' + current + '\')">'
    }
    var opts = switcher.querySelectorAll('.ms-opt')
    for (var i = 0; i < opts.length; i++) {
      opts[i].classList.toggle('active', opts[i].getAttribute('data-theme') === current)
    }
    var tip = switcher.querySelector('.ms-tip')
    if (tip) tip.textContent = TIPS[current]
    var bright = switcher.querySelector('.ms-bright')
    if (bright) {
      bright.style.display = current === 'pure' ? 'flex' : 'none'
      var mbs = bright.querySelectorAll('.mb')
      for (var j = 0; j < mbs.length; j++) {
        mbs[j].classList.toggle('on', mbs[j].getAttribute('data-b') === BRIGHT)
      }
    }
    switcher.setAttribute('title', TIPS[current])
  }

  function runOverlay(target) {
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || !document.body) { apply(target); return }
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'miasaki-overlay'
      document.body.appendChild(overlay)
    }
    overlay.style.background = (target === 'zafkiel')
      ? 'radial-gradient(circle at 50% 50%, rgba(217,179,106,.9) 0%, rgba(194,58,46,.55) 55%, rgba(12,11,17,0) 75%)'
      : (target === 'kurkuriel')
        ? 'linear-gradient(100deg, rgba(158,27,27,.85) 0%, rgba(36,31,34,.9) 45%, rgba(158,27,27,0) 75%)'
        : 'radial-gradient(circle, rgba(128,128,128,.35), rgba(128,128,128,0) 70%)'
    overlay.classList.remove('run')
    void overlay.offsetWidth
    overlay.classList.add('run')
    setTimeout(function () {
      apply(target)
      overlay.classList.remove('run')
    }, reduced ? 150 : 400)
  }

  function buildSwitcher() {
    if (switcher || !document.body) return
    switcher = document.createElement('div')
    switcher.id = 'miasaki-switcher'
    var html = '<div class="ms-btn" title=""></div><div class="ms-panel">'
    for (var i = 0; i < ORDER.length; i++) {
      var t = ORDER[i]
      html += '<div class="ms-opt" data-theme="' + t + '">' +
        '<div class="ms-glyph"><img src="' + ICON_BASE + META[t].icon + '" alt=""' +
        ' onerror="window.__msGlyphFallback && window.__msGlyphFallback(this, \'' + t + '\')"></div>' +
        '<div><div class="ms-name">' + META[t].name + '</div>' +
        '<div class="ms-sub">' + META[t].sub + '</div></div></div>'
    }
    // 原版主题明暗三档（仅纯色主题显示）
    html += '<div class="ms-bright"><span class="mb-label">明暗</span>' +
      '<span class="mb" data-b="light" title="浅色">\u2600</span>' +
      '<span class="mb" data-b="dark" title="深色">\u263E</span>' +
      '<span class="mb" data-b="system" title="跟随系统">\u{1F5A5}</span></div>'
    html += '<div class="ms-tip"></div></div>'
    switcher.innerHTML = html
    switcher.addEventListener('click', function (ev) {
      var opt = ev.target && ev.target.closest ? ev.target.closest('.ms-opt') : null
      if (opt) {
        var target = opt.getAttribute('data-theme')
        switcher.classList.remove('open')
        if (target !== current) runOverlay(target)
        return
      }
      var mb = ev.target && ev.target.closest ? ev.target.closest('.mb') : null
      if (mb) {
        BRIGHT = mb.getAttribute('data-b')
        try { localStorage.setItem('miasaki.bright', BRIGHT) } catch (e) { /* ignore */ }
        syncDark()
        refreshSwitcher()
        return
      }
      if (ev.target && ev.target.closest && ev.target.closest('.ms-btn')) {
        switcher.classList.toggle('open')
      }
    })
    switcher.addEventListener('mouseleave', function () {
      switcher.classList.remove('open')
    })
    document.body.appendChild(switcher)
    refreshSwitcher()
  }

  /* ---------- 原创水印（注入层独占装饰） ---------- */
  var WATERMARKS = {
    zafkiel: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
      '<g fill="none" stroke="#D9B36A">' +
      '<circle cx="200" cy="200" r="150" stroke-width="3"/>' +
      '<circle cx="200" cy="200" r="126" stroke-width="1"/>' +
      '<circle cx="200" cy="200" r="64" stroke-width="1.5"/>' +
      '<circle cx="148" cy="252" r="42" stroke-width="14" stroke-dasharray="5 9"/>' +
      '<circle cx="252" cy="148" r="30" stroke-width="12" stroke-dasharray="4 8"/>' +
      '<g stroke-width="2">' +
      '<path d="M200 50v26"/><path d="M200 324v26"/>' +
      '<path d="M50 200h26"/><path d="M324 200h26"/>' +
      '<g transform="rotate(30 200 200)"><path d="M200 50v20"/><path d="M200 330v20"/></g>' +
      '<g transform="rotate(60 200 200)"><path d="M200 50v20"/><path d="M200 330v20"/></g>' +
      '<g transform="rotate(120 200 200)"><path d="M200 50v20"/><path d="M200 330v20"/></g>' +
      '<g transform="rotate(150 200 200)"><path d="M200 50v20"/><path d="M200 330v20"/></g>' +
      '</g>' +
      '<path d="M200 200L200 118" stroke-width="4"/>' +
      '<path d="M200 200L252 236" stroke-width="3"/>' +
      '<path d="M200 200L232 168" stroke-width="1.5"/>' +
      '</g>' +
      '<g fill="#D9B36A" font-family="Georgia,serif" font-size="24" text-anchor="middle" dominant-baseline="central">' +
      '<text x="200" y="44">XII</text><text x="284" y="53">I</text><text x="345" y="115">II</text>' +
      '<text x="368" y="200">III</text><text x="345" y="285">IV</text><text x="284" y="347">V</text>' +
      '<text x="200" y="372">VI</text><text x="116" y="347">VII</text><text x="55" y="285">VIII</text>' +
      '<text x="32" y="200">IX</text><text x="55" y="115">X</text><text x="116" y="53">XI</text>' +
      '</g></svg>',
    kurkuriel: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
      '<g fill="none" stroke="#5E6572">' +
      '<path d="M80 200 A120 120 0 0 1 172 85" stroke-width="3"/>' +
      '<path d="M228 85 A120 120 0 0 1 320 200" stroke-width="3" stroke-dasharray="14 9"/>' +
      '<path d="M320 200 A120 120 0 0 1 228 315" stroke-width="3"/>' +
      '<path d="M172 315 A120 120 0 0 1 80 200" stroke-width="3" stroke-dasharray="6 11"/>' +
      '<circle cx="200" cy="200" r="86" stroke-width="1.5" stroke-dasharray="24 16 8 16"/>' +
      '<circle cx="200" cy="200" r="52" stroke-width="1.5"/>' +
      '<g stroke-width="2">' +
      '<path d="M200 80v22"/><path d="M200 298v22"/>' +
      '<path d="M80 200h22"/><path d="M298 200h22"/>' +
      '<g transform="rotate(45 200 200)"><path d="M200 80v16"/><path d="M200 304v16"/></g>' +
      '<g transform="rotate(135 200 200)"><path d="M200 80v16"/><path d="M200 304v16"/></g>' +
      '</g>' +
      '<path d="M200 200L200 128" stroke-width="4"/>' +
      '<path d="M200 200L243 228" stroke-width="3"/>' +
      '</g>' +
      '<g stroke="#9E1B1B" fill="none" stroke-width="2.5" stroke-linejoin="round">' +
      '<path d="M140 60 L154 44 L148 76 L168 62 L158 92 L182 88"/>' +
      '<path d="M300 332 L288 348 L294 320 L276 336 L286 308 L264 312"/>' +
      '</g>' +
      '<g fill="#5E6572" font-family="Georgia,serif" font-size="30" text-anchor="middle" dominant-baseline="central">' +
      '<text x="200" y="40">\u264c</text><text x="348" y="200">\u264d</text>' +
      '<text x="200" y="360">\u264e</text><text x="52" y="200">\u264f</text>' +
      '</g></svg>'
  }

  function buildWatermark() {
    if (!document.body || IS_LOCAL) return
    var svg = WATERMARKS[current]
    if (!svg) return
    var wm = document.createElement('div')
    wm.id = 'miasaki-watermark'
    wm.innerHTML = svg
    document.body.appendChild(wm)
  }

  function updateWatermark() {
    var wm = document.getElementById('miasaki-watermark')
    if (wm && wm.parentNode) wm.parentNode.removeChild(wm)
    buildWatermark()
  }

  /* ---------- 桌宠（Codex 式状态宠物，页面内嵌） ---------- */
  var PET_CSS =
    '#miasaki-pet{position:fixed;right:16px;bottom:74px;width:192px;height:208px;z-index:99980;' +
    'cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;}' +
    '#miasaki-pet:active{cursor:grabbing;}' +
    '#miasaki-pet canvas{width:100%;height:100%;display:block;}' +
    '#miasaki-pet canvas.bob{animation:ms-bob 3.2s ease-in-out infinite;}' +
    '#miasaki-pet canvas.pulse{animation:ms-grow .4s ease;}' +
    '@keyframes ms-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}' +
    '@keyframes ms-grow{0%{transform:scale(.92)}55%{transform:scale(1.06)}100%{transform:scale(1)}}' +
    '#miasaki-pet .pet-bubble{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);' +
    'margin-bottom:8px;background:rgba(30,26,39,.95);color:#e4def0;padding:8px 12px;border-radius:12px;' +
    'font-size:13px;line-height:1.45;white-space:nowrap;border:1px solid rgba(217,179,106,.4);' +
    'box-shadow:0 5px 14px rgba(0,0,0,.4);z-index:10;display:none;max-width:230px;}' +
    '#miasaki-pet .pet-bubble.show{display:block;}' +
    '#miasaki-pet .pet-bubble::after{content:"";position:absolute;left:50%;bottom:-7px;margin-left:-7px;' +
    'border:7px solid transparent;border-top-color:rgba(30,26,39,.95);}' +
    '#miasaki-pet .pet-bubble.approval{border-color:#c23a2e;background:#241a1e;}' +
    '#miasaki-pet .pet-bubble.approval::after{border-top-color:#241a1e;}' +
    '#miasaki-pet .pet-bubble .pb-btns{display:flex;gap:8px;margin-top:7px;}' +
    '#miasaki-pet .pet-bubble .pb-btn{padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;' +
    'border:1px solid rgba(255,255,255,.25);text-align:center;}' +
    '#miasaki-pet .pet-bubble .pb-btn.ok{background:#2f5d3a;color:#eaf6ec;}' +
    '#miasaki-pet .pet-bubble .pb-btn.no{background:#5d2a2f;color:#f8e9ea;}' +
    '#miasaki-pet .pet-menu{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);' +
    'margin-bottom:8px;background:rgba(24,20,32,.97);border:1px solid rgba(255,255,255,.14);' +
    'border-radius:12px;padding:6px;font-size:13px;color:#e4def0;min-width:178px;' +
    'box-shadow:0 10px 26px rgba(0,0,0,.5);z-index:20;display:none;}' +
    '#miasaki-pet .pet-menu.show{display:block;}' +
    '#miasaki-pet .pet-menu .pm-i{padding:7px 12px;border-radius:7px;cursor:pointer;display:flex;gap:9px;align-items:center;}' +
    '#miasaki-pet .pet-menu .pm-i:hover{background:rgba(255,255,255,.1);}' +
    '#miasaki-pet .pet-menu .pm-i.active{box-shadow:inset 0 0 0 1.5px #d9b36a;}' +
    '#miasaki-pet .pet-menu .pm-sep{height:1px;background:rgba(255,255,255,.14);margin:5px 8px;}' +
    '#miasaki-pet-hidden{position:fixed;right:18px;bottom:18px;width:18px;height:18px;border-radius:50%;' +
    'background:rgba(217,179,106,.9);box-shadow:0 2px 8px rgba(0,0,0,.4);z-index:99985;cursor:pointer;display:none;}' +
    '#miasaki-switcher .ms-glyph img{width:24px;height:24px;border-radius:50%;object-fit:cover;display:block;}' +
    '#miasaki-switcher .ms-btn img{width:30px;height:30px;border-radius:50%;object-fit:cover;display:block;}' +
    '#miasaki-pet .pet-menu .pm-ico{width:22px;height:22px;border-radius:50%;object-fit:cover;flex:none;}'

  var PET_NAMES = { whale: 'DS 鲸鱼娘', kurumi: '狂三', inverse: '反转狂三' }
  var PET_QUOTES = {
    whale: ['咕噜咕噜…', '（吐泡泡）', '呜~ 我在听', '今天的代码也拜托了', '（摇尾巴）'],
    kurumi: ['ふふふ…', '啊啦，你来了呢', '时间，可是很宝贵的哦', '刻刻帝在看着你', '（轻笑）'],
    inverse: ['选好了吗？', '别让我等太久', '（冷笑）', '效率。现在。', '你的时间，归我支配']
  }
  var PET_ROWS = { idle: 0, runRight: 1, runLeft: 2, wave: 3, jump: 4, failed: 5, wait: 6, run: 7, review: 8 }
  var PET_FPS = { idle: 8, runRight: 10, runLeft: 10, wave: 10, jump: 11, failed: 6, wait: 6, run: 9, review: 8 }
  var PET_ASSET = 'http://127.0.0.1:39800/pets/'
  var ICON_BASE = 'http://127.0.0.1:39800/icons/'

  // 图标加载失败时退回文字字形
  window.__msGlyphFallback = function (img, theme) {
    try {
      img.style.display = 'none'
      var g = document.createElement('span')
      g.textContent = META[theme] ? META[theme].glyph : '?'
      if (img.parentNode) img.parentNode.appendChild(g)
    } catch (e) { /* ignore */ }
  }

  var pet = {
    root: null, canvas: null, bubble: null, menu: null,
    mode: 'whale', state: 'idle', atlasCache: {}, anim: null, timer: null,
    x: null, y: null, hidden: false, dragging: null, moved: 0,
    quoteTimer: null, lastClick: 0, approval: null, scanTimer: null
  }

  function petLoadAtlas(name) {
    var url = PET_ASSET + name + '/spritesheet.png'
    if (pet.atlasCache[url]) return Promise.resolve(pet.atlasCache[url])
    return new Promise(function (resolve, reject) {
      var img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = function () {
        try {
          var w = img.naturalWidth
          var h = img.naturalHeight
          var cv = document.createElement('canvas')
          cv.width = w
          cv.height = h
          var cx = cv.getContext('2d')
          cx.drawImage(img, 0, 0)
          var data = cx.getImageData(0, 0, w, h).data
          var rows = Math.floor(h / 208)
          var frames = {}
          var step = 8
          for (var r = 0; r < rows; r++) {
            var cols = []
            for (var c = 0; c < 8; c++) {
              var hits = 0
              for (var y = r * 208 + 4; y < (r + 1) * 208 - 4 && hits < 30; y += step) {
                for (var x = c * 192 + 4; x < (c + 1) * 192 - 4; x += step) {
                  if (data[(y * w + x) * 4 + 3] > 24) { hits++; break }
                }
              }
              if (hits >= 8) cols.push(c)
            }
            frames[r] = cols
          }
          var entry = { canvas: cv, frames: frames }
          pet.atlasCache[url] = entry
          resolve(entry)
        } catch (e) {
          reject(e)
        }
      }
      img.onerror = function () { reject(new Error('atlas ' + name + ' load failed')) }
      img.src = url
    })
  }

  function petDraw(row, col) {
    var entry = pet.atlasCache[PET_ASSET + pet.mode + '/spritesheet.png']
    if (!entry || !pet.canvas) return
    var cx = pet.canvas.getContext('2d')
    cx.clearRect(0, 0, 192, 208)
    cx.drawImage(entry.canvas, col * 192, row * 208, 192, 208, 0, 0, 192, 208)
  }

  /* 鲸鱼娘（纯色主题）立绘三态：随思考强度成长（小→中→大） */
  var PET_STATE_IMAGES = { idle: 'idle.png', work: 'work.png', deep: 'deep.png' }
  var stateImgCache = {}
  function petDrawState() {
    var url = PET_ASSET + 'whale/states/' + (PET_STATE_IMAGES[pet.state] || PET_STATE_IMAGES.idle)
    var cached = stateImgCache[url]
    if (cached) {
      petDrawStateNow(cached)
      return
    }
    var img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = function () {
      stateImgCache[url] = img
      petDrawStateNow(img)
    }
    img.onerror = function () {
      try { if (pet.bubble) petSay('立绘加载失败：' + url, 8000) } catch (e) { /* ignore */ }
    }
    img.src = url
  }
  function petDrawStateNow(img) {
    if (!pet.canvas) return
    var cx = pet.canvas.getContext('2d')
    cx.clearRect(0, 0, 192, 208)
    var h = 192
    var w = img.width / img.height * h
    cx.drawImage(img, (192 - w) / 2, 208 - h, w, h)
    syncHash()
  }

  function petStop() {
    if (pet.timer) { clearInterval(pet.timer); pet.timer = null }
    pet.anim = null
  }

  function petPlay(state, opts) {
    opts = opts || {}
    var fps = opts.fps || PET_FPS[state] || 8
    var loop = opts.loop !== undefined ? opts.loop : state === 'idle' || state === 'working' || state === 'wait'
    var atlasUrl = PET_ASSET + pet.mode + '/spritesheet.png'
    petLoadAtlas(pet.mode).then(function (entry) {
      var rowName = state === 'working' ? 'run' : state
      var cols = entry.frames[PET_ROWS[rowName]] || entry.frames[PET_ROWS.idle] || [0]
      if (!cols.length) cols = [0]
      petStop()
      var i = 0
      pet.anim = { row: PET_ROWS[rowName], cols: cols, fps: fps, loop: loop, atlas: atlasUrl }
      function tick() {
        if (pet.anim && pet.anim.atlas === atlasUrl) {
          petDraw(pet.anim.row, pet.anim.cols[i])
          i++
          if (i >= pet.anim.cols.length) {
            if (pet.anim.loop) { i = 0 } else {
              petStop()
              if (opts.onEnd) opts.onEnd()
              return
            }
          }
        }
      }
      pet.timer = setInterval(tick, 1000 / fps)
      tick()
    }).catch(function (e) {
      // 图集加载失败：显形到气泡（诊断与用户可见）
      pet.atlasErr = String(e).slice(0, 60)
      try {
        if (pet.bubble) petSay('素材加载失败：' + pet.atlasErr, 8000)
      } catch (e2) { /* ignore */ }
    })
  }

  function petSetState(state) {
    if (state === pet.state) return
    pet.state = state
    if (pet.mode === 'whale') {
      // 立绘三态：停止帧动画，切换立绘 + 成长脉冲
      petStop()
      petDrawState()
      if (pet.canvas) {
        pet.canvas.classList.remove('pulse')
        void pet.canvas.offsetWidth
        pet.canvas.classList.add('pulse')
        pet.canvas.classList.toggle('bob', state === 'idle')
      }
      return
    }
    petPlay(state)
  }

  function petUpdateMode(theme) {
    var m = PET_MODES[theme] || 'whale'
    if (m === pet.mode && pet.root) return
    pet.mode = m
    pet.state = ''
    if (m === 'whale') {
      petStop()
      petDrawState()
      if (pet.canvas) pet.canvas.classList.toggle('bob', true)
    } else {
      petSetState('idle')
    }
  }

  function petSay(text, ms, cls) {
    if (!pet.bubble) return
    pet.bubble.innerHTML = ''
    pet.bubble.textContent = text
    pet.bubble.className = 'pet-bubble show' + (cls ? ' ' + cls : '')
    if (pet.quoteTimer) clearTimeout(pet.quoteTimer)
    pet.quoteTimer = setTimeout(function () { pet.bubble.className = 'pet-bubble' }, ms || 3200)
  }

  function petRandomQuote() {
    var q = PET_QUOTES[pet.mode]
    if (q) petSay(q[Math.floor(Math.random() * q.length)])
  }

  function petHide() {
    pet.hidden = true
    if (pet.root) pet.root.style.display = 'none'
    var dot = document.getElementById('miasaki-pet-hidden')
    if (dot) dot.style.display = 'block'
    try { localStorage.setItem('miasaki.pet.hidden', '1') } catch (e) {}
  }

  function petShow() {
    pet.hidden = false
    if (pet.root) pet.root.style.display = ''
    var dot = document.getElementById('miasaki-pet-hidden')
    if (dot) dot.style.display = 'none'
    try { localStorage.removeItem('miasaki.pet.hidden') } catch (e) {}
  }

  function petHashCmd(cmd) {
    try {
      if (!history.replaceState) return
      history.replaceState(null, '', '#miasaki-theme=' + current + '&cmd=' + cmd + '&seq=' + Date.now())
      setTimeout(function () {
        try { history.replaceState(null, '', '#miasaki-theme=' + current) } catch (e) {}
      }, 1600)
    } catch (e) {}
  }

  var APPROVE_TEXT_RE = /允许|批准|同意|approve|allow|accept/i
  var REJECT_TEXT_RE = /拒绝|驳回|deny|reject/i

  function petScanApproval() {
    if (!pet.root) return
    var approveBtn = null
    var rejectBtn = null
    var nodes = document.querySelectorAll('button, [role="button"]')
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      if (el.offsetWidth === 0 && el.offsetHeight === 0) continue
      var t = (el.textContent || '').trim()
      if (!t || t.length > 24) continue
      if (!approveBtn && APPROVE_TEXT_RE.test(t)) approveBtn = el
      if (!rejectBtn && REJECT_TEXT_RE.test(t)) rejectBtn = el
      if (approveBtn && rejectBtn) break
    }
    var found = !!(approveBtn || rejectBtn)
    var prev = pet.approval
    var sameTargets = prev && prev.approve === approveBtn && prev.reject === rejectBtn
    if (found && !sameTargets) {
      pet.approval = { approve: approveBtn, reject: rejectBtn }
      petSetState('wait')
      var b = pet.bubble
      b.innerHTML = ''
      b.className = 'pet-bubble show approval'
      var label = document.createElement('div')
      label.textContent = '有待审批事项'
      var btns = document.createElement('div')
      btns.className = 'pb-btns'
      var ok = document.createElement('div')
      ok.className = 'pb-btn ok'
      ok.textContent = '允许'
      var no = document.createElement('div')
      no.className = 'pb-btn no'
      no.textContent = '拒绝'
      ok.addEventListener('click', function () {
        if (approveBtn) approveBtn.click()
        b.className = 'pet-bubble'
        pet.approval = null
        petSetState('idle')
      })
      no.addEventListener('click', function () {
        if (rejectBtn) rejectBtn.click()
        b.className = 'pet-bubble'
        pet.approval = null
        petSetState('idle')
      })
      btns.appendChild(ok)
      btns.appendChild(no)
      b.appendChild(label)
      b.appendChild(btns)
    } else if (!found && pet.approval) {
      pet.approval = null
      if (pet.bubble.classList.contains('approval')) pet.bubble.className = 'pet-bubble'
      petSetState('idle')
    }
  }

  /* 思考强度：按 DOM 变异频率分三档（待机/常规/深度），经 hash 上报给桌宠窗口 */
  var CUR_INT = 'idle'
  var mutCount = 0
  var PET_TIER_MS = 2500
  function petEvalIntensity() {
    var tier = mutCount <= 1 ? 'idle' : (mutCount <= 9 ? 'work' : 'deep')
    mutCount = 0
    CUR_INT = tier
    syncHash()
    if (!INPAGE_PET || !pet.root) return
    if (pet.state === 'wait') return
    if (pet.mode === 'whale') {
      if (pet.state !== tier) petSetState(tier)
    } else {
      if (tier === 'idle') {
        if (pet.state !== 'idle') petSetState('idle')
      } else if (pet.state !== 'working') {
        petSetState('working')
      }
    }
  }
  var tierTimer = setInterval(petEvalIntensity, PET_TIER_MS)

  function petSetPos(x, y) {
    pet.x = Math.max(0, Math.min(window.innerWidth - 192, x))
    pet.y = Math.max(0, Math.min(window.innerHeight - 208, y))
    pet.root.style.left = pet.x + 'px'
    pet.root.style.top = pet.y + 'px'
    pet.root.style.right = 'auto'
    pet.root.style.bottom = 'auto'
  }

  function buildPet() {
    if (pet.root || !document.body || IS_LOCAL) return
    pet.root = document.createElement('div')
    pet.root.id = 'miasaki-pet'
    pet.canvas = document.createElement('canvas')
    pet.canvas.width = 192
    pet.canvas.height = 208
    pet.bubble = document.createElement('div')
    pet.bubble.className = 'pet-bubble'
    pet.menu = document.createElement('div')
    pet.menu.className = 'pet-menu'
    var items = [
      ['pure', '原版 · DS 鲸鱼娘', 'theme-pure.png'],
      ['zafkiel', '刻刻帝 · 狂三', 'theme-zafkiel.png'],
      ['kurkuriel', '狂狂帝 · 反转狂三', 'theme-inverse.png']
    ]
    var menuHtml = ''
    for (var mi = 0; mi < items.length; mi++) {
      menuHtml += '<div class="pm-i" data-theme="' + items[mi][0] + '">' +
        '<img class="pm-ico" src="' + ICON_BASE + items[mi][2] + '" alt=""' +
        ' onerror="this.style.display=\'none\'">' + items[mi][1] + '</div>'
    }
    menuHtml += '<div class="pm-sep"></div>' +
      '<div class="pm-i" data-act="hidepet">\u{1F564} 隐藏桌宠</div>' +
      '<div class="pm-i" data-act="minimize">\u{1F5D6} 最小化主窗口</div>' +
      '<div class="pm-i" data-act="exit">\u274C 退出应用</div>'
    pet.menu.innerHTML = menuHtml
    pet.root.appendChild(pet.bubble)
    pet.root.appendChild(pet.menu)
    pet.root.appendChild(pet.canvas)
    document.body.appendChild(pet.root)
    var dot = document.createElement('div')
    dot.id = 'miasaki-pet-hidden'
    dot.title = '恢复桌宠'
    document.body.appendChild(dot)

    var saved = null
    try { saved = localStorage.getItem('miasaki.pet.pos') } catch (e) {}
    if (saved) {
      var p = saved.split(',')
      if (p.length === 2) { pet.x = +p[0]; pet.y = +p[1] }
    }
    if (pet.x === null || isNaN(pet.x)) {
      pet.x = Math.max(8, window.innerWidth - 16 - 192)
      pet.y = Math.max(8, window.innerHeight - 74 - 208)
    }
    petSetPos(pet.x, pet.y)

    // 拖动（指针事件，页面内任意位置可拖）
    pet.root.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return
      pet.dragging = { sx: ev.clientX, sy: ev.clientY, ox: pet.x, oy: pet.y }
      pet.moved = 0
      if (pet.root.setPointerCapture) pet.root.setPointerCapture(ev.pointerId)
    })
    pet.root.addEventListener('pointermove', function (ev) {
      if (!pet.dragging) return
      var dx = ev.clientX - pet.dragging.sx
      var dy = ev.clientY - pet.dragging.sy
      pet.moved = Math.max(pet.moved, Math.abs(dx) + Math.abs(dy))
      petSetPos(pet.dragging.ox + dx, pet.dragging.oy + dy)
    })
    pet.root.addEventListener('pointerup', function () {
      var wasDrag = pet.moved > 5
      pet.dragging = null
      try { localStorage.setItem('miasaki.pet.pos', pet.x + ',' + pet.y) } catch (e) {}
      if (wasDrag) return
      hidePetMenu()
      var now = Date.now()
      if (now - pet.lastClick < 350) {
        // 双击：挥手
        pet.lastClick = 0
        petPlay('wave', { loop: false, onEnd: function () { petSetState('idle') } })
        petRandomQuote()
      } else {
        pet.lastClick = now
        petPlay('jump', { loop: false, onEnd: function () { petSetState('idle') } })
        petRandomQuote()
      }
    })
    pet.root.addEventListener('contextmenu', function (ev) {
      ev.preventDefault()
      hidePetBubble()
      pet.menu.classList.toggle('show')
    })
    pet.menu.addEventListener('click', function (ev) {
      var item = ev.target && ev.target.closest ? ev.target.closest('.pm-i') : null
      if (!item) return
      var theme = item.getAttribute('data-theme')
      var act = item.getAttribute('data-act')
      pet.menu.classList.remove('show')
      if (theme && ORDER.indexOf(theme) >= 0) {
        runOverlay(theme)
      } else if (act === 'hidepet') {
        petHide()
      } else if (act === 'minimize') {
        petHashCmd('hide')
      } else if (act === 'exit') {
        petHashCmd('exit')
      }
    })
    document.addEventListener('click', function (ev) {
      if (!pet.menu.contains(ev.target) && !pet.root.contains(ev.target)) hidePetMenu()
    })
    dot.addEventListener('click', petShow)

    pet.mode = PET_MODES[current] || 'whale'
    pet.state = ''
    if (pet.mode === 'whale') {
      petDrawState()
      pet.canvas.classList.toggle('bob', true)
    } else {
      petSetState('idle')
    }
    try { if (localStorage.getItem('miasaki.pet.hidden') === '1') petHide() } catch (e) {}
    pet.scanTimer = setInterval(petScanApproval, 2500)
  }

  function hidePetMenu() { if (pet.menu) pet.menu.classList.remove('show') }
  function hidePetBubble() {
    if (pet.bubble) pet.bubble.className = 'pet-bubble'
    if (pet.quoteTimer) clearTimeout(pet.quoteTimer)
  }

  /* 工作状态侦测：页面活动 → working，静默 → idle（忽略桌宠自身 DOM） */
  var actObs = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target
      if (t && t.closest && (
        t.closest('#miasaki-pet') || t.closest('#miasaki-switcher') ||
        t.closest('#miasaki-watermark') || t.closest('#miasaki-overlay')
      )) continue
      mutCount++
      return
    }
  })

  /* ---------- 主题化标题栏（无边框窗口） ---------- */
  var INPAGE_PET = false // 桌宠已迁至独立置顶窗

  function buildTitlebar() {
    if (document.getElementById('miasaki-titlebar') || !document.body || IS_LOCAL) return
    var bar = document.createElement('div')
    bar.id = 'miasaki-titlebar'
    bar.innerHTML =
      '<div class="tb-title"><span class="tb-dot"></span>Miasaki · DSH · <span id="tb-theme"></span></div>' +
      '<div class="tb-drag" title="拖动窗口"></div>' +
      '<div class="tb-btn" data-act="min" title="最小化">\u2013</div>' +
      '<div class="tb-btn" data-act="max" title="最大化/还原">\u25A1</div>' +
      '<div class="tb-btn tb-close" data-act="close" title="关闭">\u2715</div>'
    document.body.appendChild(bar)
    // 拖动：pointer 事件 → hash move=dx,dy（增量）→ Rust 移动窗口
    bar.querySelector('.tb-drag').addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return
      var sx = ev.clientX
      var sy = ev.clientY
      var moved = false
      function mv(e) {
        var dx = Math.round(e.clientX - sx)
        var dy = Math.round(e.clientY - sy)
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
        if (moved) {
          try {
            history.replaceState(null, '', '#miasaki-theme=' + current + '&int=' + CUR_INT + '&move=' + dx + ',' + dy)
          } catch (err) { /* ignore */ }
          sx = e.clientX
          sy = e.clientY
        }
      }
      function up() {
        window.removeEventListener('pointermove', mv)
        window.removeEventListener('pointerup', up)
        try {
          history.replaceState(null, '', '#miasaki-theme=' + current + '&int=' + CUR_INT)
        } catch (err) { /* ignore */ }
      }
      window.addEventListener('pointermove', mv)
      window.addEventListener('pointerup', up)
    })
    bar.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('.tb-btn') : null
      if (!b) return
      var act = b.getAttribute('data-act')
      if (act === 'min') petHashCmd('min')
      else if (act === 'max') petHashCmd('max')
      else if (act === 'close') petHashCmd('exit')
    })
    updateTitlebar()
  }

  function updateTitlebar() {
    var el = document.getElementById('tb-theme')
    if (el) el.textContent = META[current].name
  }

  /* ---------- 启动 ---------- */
  setAttr(current)
  function onReady() {
    setAttr(current)
    ensureStyle()
    if (styleEl) styleEl.textContent = STYLES[current] || ''
    syncDark()
    startObserver()
    try { localStorage.setItem(KEY, current) } catch (e) { /* ignore */ }
    var base = ensureBase()
    base.textContent = SWITCHER_CSS + PET_CSS
    if (!IS_LOCAL) {
      buildTitlebar()
      buildSwitcher()
      buildWatermark()
      if (INPAGE_PET) buildPet()
      actObs.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    }
    refreshSwitcher()
    syncHash()
    notifyPet()
    // 自愈：切换条/标题栏/主题属性/样式层被页面重渲染清掉时自动重建
    setInterval(function () {
      if (!document.getElementById('miasaki-titlebar') && !IS_LOCAL) buildTitlebar()
      if (!document.getElementById('miasaki-switcher')) buildSwitcher()
      if (INPAGE_PET && !document.getElementById('miasaki-pet') && !IS_LOCAL) buildPet()
      if (document.documentElement.getAttribute('data-miasaki-theme') !== current) setAttr(current)
      ensureStyle()
      ensureBase()
      if (baseEl && baseEl.textContent !== (SWITCHER_CSS + PET_CSS)) {
        baseEl.textContent = SWITCHER_CSS + PET_CSS
      }
      if (styleEl && styleEl.textContent !== (STYLES[current] || '')) {
        styleEl.textContent = STYLES[current] || ''
      }
      syncDark()
    }, 5000)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady)
  } else {
    onReady()
  }
})()
