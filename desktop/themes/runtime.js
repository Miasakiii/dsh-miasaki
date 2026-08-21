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
          d = len + '.' + headOk + '.' + attached + '.' + sw + '.' + ERR_COUNT + '.' + baseOk + '.' + swTop + '.' + vh + '.' + encodeURIComponent(eSw) + '.' + encodeURIComponent(swCss)
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
      else {
        // system：移除注入的明暗锁定,恢复 DSH 自身偏好(否则从 zafkiel 切回后残留暗色)
        if (document.body.hasAttribute('data-ds-dark-theme')) {
          document.body.removeAttribute('data-ds-dark-theme')
        }
        return
      }
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
    // 核心同步优先:桌宠 hash 通道 / 切换条图标 / 标题栏 —— 装饰层失败不得阻断
    syncHash()
    notifyPet()
    refreshSwitcher()
    updateTitlebar()
    try { updateWatermark() } catch (e) { /* 装饰失败由自愈巡检恢复 */ }
    try { updateAurora() } catch (e) { /* 同上 */ }
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
    '#miasaki-switcher .ms-panel{position:absolute;right:0;bottom:62px;display:none;' +
    'flex-direction:column;gap:4px;padding:8px;border-radius:12px;min-width:176px;' +
    'background:var(--ms-panel,#1e1a27);border:1px solid var(--ms-accent,#d9b36a);color:var(--ms-text,#e4def0);' +
    'box-shadow:0 12px 30px rgba(0,0,0,.5);z-index:1;}' +
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
    '#miasaki-titlebar{position:fixed;left:0;top:0;right:0;height:32px;z-index:100000;' +
    'display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;' +
    'background:var(--ms-panel,#1e1a27);border-bottom:1px solid var(--ms-border,#3a3243);' +
    'color:var(--ms-text,#e4def0);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
    'user-select:none;-webkit-user-select:none;cursor:default;}' +
    '#miasaki-titlebar .tb-drag{flex:1;height:100%;cursor:move;-webkit-app-region:no-drag;}' +
    '#miasaki-titlebar .tb-title{font-size:11.5px;font-weight:500;letter-spacing:.03em;' +
    'display:flex;align-items:center;gap:6px;opacity:.85;}' +
    '#miasaki-titlebar .tb-title .tb-dot{width:6px;height:6px;border-radius:50%;background:var(--ms-accent,#d9b36a);}' +
    '#miasaki-titlebar .tb-btn{width:30px;height:22px;display:flex;align-items:center;justify-content:center;' +
    'cursor:pointer;font-size:11px;border-radius:5px;color:var(--ms-text,#e4def0);opacity:.8;' +
    'transition:background .15s ease,color .15s ease;}' +
    '#miasaki-titlebar .tb-btn:hover{background:var(--ms-hover,#2a2434);color:var(--ms-accent,#d9b36a);opacity:1;}' +
    '#miasaki-titlebar .tb-btn:active{transform:scale(.94);}' +
    '#miasaki-titlebar .tb-btn.tb-close:hover{background:var(--ms-danger,#c23a2e);color:#fff;opacity:1;}' +
    'html,body{height:100%;overflow:hidden;}' +
    'body #root{margin-top:32px;height:calc(100% - 32px)!important;}' +
    '#miasaki-switcher .ms-glyph img{width:24px;height:24px;border-radius:50%;object-fit:cover;display:block;}' +
    '#miasaki-switcher .ms-btn img{width:30px;height:30px;border-radius:50%;object-fit:cover;display:block;}' +
    '#miasaki-aurora{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;' +
    'transition:opacity .6s ease;}' +
    '#miasaki-aurora .aur-blob{position:absolute;border-radius:50%;filter:blur(90px);' +
    'opacity:0;transition:opacity 1.2s ease;}' +
    '#miasaki-aurora .aur-a{width:52vw;height:52vw;left:-14vw;top:-18vw;}' +
    '#miasaki-aurora .aur-b{width:44vw;height:44vw;right:-12vw;top:16vw;}' +
    '#miasaki-aurora .aur-c{width:38vw;height:38vw;left:28vw;bottom:-16vw;}'

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
    // hover 展开 + 延迟关闭:鼠标移出后 300ms 宽限,移回则取消(解决"一挪开就点不到")
    var closeTimer = null
    function openPanel() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
      switcher.classList.add('open')
    }
    function scheduleClose() {
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = setTimeout(function () {
        switcher.classList.remove('open')
        closeTimer = null
      }, 300)
    }
    switcher.addEventListener('mouseenter', openPanel)
    switcher.addEventListener('mouseleave', scheduleClose)
    // 面板自身 hover 时保持展开(面板是 switcher 子元素,mouseleave 不触发,此兜底防误关)
    var panel = switcher.querySelector('.ms-panel')
    if (panel) panel.addEventListener('mouseenter', openPanel)
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

  /* ---------- 背景光晕层（主题个性层：DSH 面板半透明后透出） ---------- */
  function buildAurora() {
    if (document.getElementById('miasaki-aurora') || !document.body || IS_LOCAL) return
    var a = document.createElement('div')
    a.id = 'miasaki-aurora'
    a.innerHTML =
      '<div class="aur-blob aur-a"></div><div class="aur-blob aur-b"></div>' +
      '<div class="aur-blob aur-c"></div>'
    document.body.appendChild(a)
  }

  function updateAurora() {
    var a = document.getElementById('miasaki-aurora')
    if (a && a.parentNode) a.parentNode.removeChild(a)
    buildAurora()
  }

  function updateWatermark() {
    var wm = document.getElementById('miasaki-watermark')
    if (wm && wm.parentNode) wm.parentNode.removeChild(wm)
    buildWatermark()
  }

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




  function petHashCmd(cmd) {
    try {
      if (!history.replaceState) return
      history.replaceState(null, '', '#miasaki-theme=' + current + '&cmd=' + cmd + '&seq=' + Date.now())
      setTimeout(function () {
        try { history.replaceState(null, '', '#miasaki-theme=' + current) } catch (e) {}
      }, 1600)
    } catch (e) {}
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
  }
  var tierTimer = setInterval(petEvalIntensity, PET_TIER_MS)

  /* 工作状态侦测：页面活动 → working，静默 → idle（忽略注入层自身 DOM） */
  var actObs = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target
      if (t && t.closest && (
        t.closest('#miasaki-switcher') ||
        t.closest('#miasaki-watermark') || t.closest('#miasaki-overlay')
      )) continue
      mutCount++
      return
    }
  })

  /* ---------- 主题化标题栏（无边框窗口） ---------- */

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
    // 拖动：pointer 事件 → hash move=累计物理增量（相对按下起点,×DPR）→ Rust 差值应用
    bar.querySelector('.tb-drag').addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return
      var sx = ev.clientX
      var sy = ev.clientY
      var dpr = window.devicePixelRatio || 1
      var moved = false
      function mv(e) {
        var dx = Math.round((e.clientX - sx) * dpr)
        var dy = Math.round((e.clientY - sy) * dpr)
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
        if (moved) {
          try {
            history.replaceState(null, '', '#miasaki-theme=' + current + '&int=' + CUR_INT + '&move=' + dx + ',' + dy)
          } catch (err) { /* ignore */ }
        }
      }
      function up() {
        window.removeEventListener('pointermove', mv)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        try {
          history.replaceState(null, '', '#miasaki-theme=' + current + '&int=' + CUR_INT + '&move=reset')
          setTimeout(function () {
            try { history.replaceState(null, '', '#miasaki-theme=' + current + '&int=' + CUR_INT) } catch (e) {}
          }, 160)
        } catch (err) { /* ignore */ }
      }
      window.addEventListener('pointermove', mv)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
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
    base.textContent = SWITCHER_CSS
    if (!IS_LOCAL) {
      buildTitlebar()
      buildSwitcher()
      buildWatermark()
      buildAurora()
      actObs.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    }
    refreshSwitcher()
    syncHash()
    notifyPet()
    // 自愈：切换条/标题栏/主题属性/样式层被页面重渲染清掉时自动重建（1s 巡检，切换后无空窗）
    setInterval(function () {
      if (!document.getElementById('miasaki-titlebar') && !IS_LOCAL) buildTitlebar()
      if (!document.getElementById('miasaki-switcher')) buildSwitcher()
      if (!document.getElementById('miasaki-aurora') && !IS_LOCAL) buildAurora()
      if (document.documentElement.getAttribute('data-miasaki-theme') !== current) setAttr(current)
      ensureStyle()
      ensureBase()
      if (baseEl && baseEl.textContent !== SWITCHER_CSS) {
        baseEl.textContent = SWITCHER_CSS
      }
      if (styleEl && styleEl.textContent !== (STYLES[current] || '')) {
        styleEl.textContent = STYLES[current] || ''
      }
      syncDark()
    }, 1000)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady)
  } else {
    onReady()
  }
})()
