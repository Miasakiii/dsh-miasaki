  // 主题同步通道：URL hash（replaceState 不触发刷新；Rust 侧轮询解析 → 联动桌宠）
  // hash 内附带诊断位：stylesLen.headOK.attached.….sidebarW.collapsed，便于无 IPC 环境远程排障
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
          d = len + '.' + headOk + '.' + attached + '.' + sw + '.' + ERR_COUNT + '.' + baseOk + '.' + swTop + '.' + vh + '.' + encodeURIComponent(eSw) + '.' + encodeURIComponent(swCss) +
            '.' + CUR_SIDEBAR_W + '.' + CUR_COLLAPSED
        } catch (e) { /* ignore */ }
        var actPart = '&act=' + CUR_ACT
        var waitPart = CUR_WAIT ? '&wait=1' : '&wait=0'
        history.replaceState(null, '', '#miasaki-theme=' + current + '&int=' + CUR_INT + actPart + waitPart + '&diag=' + d)
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

  // 本地唤醒页判定：Windows 上 Tauri 2 本地页协议为 http://tauri.localhost，
  // 单协议判定(location.protocol === 'tauri:')恒 false → 本地页出现切换条/水印/
  // 光晕等"画面不统一"回归(2026-08-29 修过,后于重构中丢失)。protocol + hostname 双重判定。
  var IS_LOCAL = location.protocol === 'tauri:' || /^tauri\.localhost$/i.test(location.hostname || '')

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

