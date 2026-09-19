  // 主题同步通道：URL hash（replaceState 不触发刷新；Rust 侧轮询解析 → 联动桌宠）
  // hash 内附带诊断位：stylesLen.headOK.attached.switcher.errCount.baseOK.switcherTop.vh.topEl.switcherCss，
  // 便于无 IPC 环境远程排障（2026-09-05 侧栏几何同步移除后 diag 尾两位固定为 0.0）
  //
  // 性能约束（2026-09-08）：diag 段里的 getBoundingClientRect / document.elementFromPoint /
  // getComputedStyle 都是**强制同步布局**调用，而 syncHash 由 05-sensors 的状态扫描每 1.5s
  // 触发一次；在长会话 + agent 流式输出（DOM 持续变化）时，每轮重算会把渲染主线程拖住
  // （实测每次 15~47ms 尖峰），表现为输入迟钝 / 发送无响应 / 输出不刷新。
  // 因此 diag 改为按 DIAG_MIN_INTERVAL_MS 节流重算并缓存，常规同步只写轻量字段。
  var DIAG_MIN_INTERVAL_MS = 10000
  var DIAG_CACHE = '0.0.0.0.0.0.0.0.0.0.0.0'
  var DIAG_AT = 0

  function computeDiag() {
    var d = '0.0.0.0.0.0.0.0.0.0.0.0'
    try {
      var len = styleFor(current).length
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
        '.0.0'
    } catch (e) { /* ignore */ }
    return d
  }

  // force=true：主题切换/启动等样式层刚变的时机，立即重算 diag（不等节流窗口）
  function syncHash(force) {
    try {
      if (history.replaceState) {
        var now = Date.now()
        if (force === true || now - DIAG_AT >= DIAG_MIN_INTERVAL_MS) {
          DIAG_AT = now
          DIAG_CACHE = computeDiag()
        }
        var actPart = '&act=' + CUR_ACT
        var waitPart = CUR_WAIT ? '&wait=1' : '&wait=0'
        // M2(v3):官方契约六态通道（dsh-pet-panel 上报 window.__miasakiPetPanel）。
        // 5s 内有心跳才合并进 hash（pet=/pettool=/petts=）；本函数是 hash 单写者，
        // pet-panel 只更新全局对象不写 hash。通道静默 → 不带 pet 字段 → Rust 走 DOM 兜底。
        var petPart = ''
        try {
          var pp = window.__miasakiPetPanel
          if (pp && pp.ts && now - pp.ts < 5000) {
            // R4(2026-09-16):petkey = 审批的稳定身份（官方 PendingApproval.key），
            // 供 Rust 侧挂「可交互审批气泡」并按 id 精确移除；空 = 无身份（不挂可交互气泡）。
            petPart = '&pet=' + pp.state + '&pettool=' + encodeURIComponent(pp.tool || '') +
              '&petts=' + pp.ts + '&petkey=' + encodeURIComponent(pp.key || '')
          }
        } catch (e) { /* ignore */ }
        history.replaceState(null, '', '#miasaki-theme=' + current + '&int=' + CUR_INT + actPart + waitPart + petPart + '&diag=' + DIAG_CACHE)
      }
    } catch (e) { /* ignore */ }
  }

  function notifyPet(forTheme) {
    try {
      var targetTheme = forTheme || current
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke('set_pet_mode', {
          mode: PET_MODES[targetTheme] || 'whale'
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
    if (el) {
      el.setAttribute('data-miasaki-theme', t)
      // M2 S6 让位协议的双向保险标记：让位时置位，appearance 线据此判定
      // 「desktop 是否按协议让位」（§8 override-conflict——桌面壳在位却未让位才冲突）。
      if (appearanceYield()) el.setAttribute('data-miasaki-theme-yield', 'skin')
      else el.removeAttribute('data-miasaki-theme-yield')
    }
  }

  function syncDark() {
    // 让位：明暗所有权归官方 presenter（overrideTokens 注册会触发它的全量 apply），
    // desktop 的 FORCE_DARK 锁定停用；此前锁定的属性由 presenter 的下一次 apply 修正。
    if (appearanceYield()) return
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
      if (appearanceYield()) return
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

  // M2 S6：appearance 门控属性（data-mia-appearance / data-mia-skin）的观察者——
  // 与上面的明暗 observer 职责不同。appearance 的 boot script 写属性可能晚于本 init
  // script 的首次判定（时序补偿，M2 §4.1 设计约束 2），必须监听翻转时机：
  // 让位发生 → 重跑 apply(current)（styleFor 按新状态只注入 deco + 置 yield 标记）；
  // 让位解除（用户关总开关）→ 同样重跑，恢复 skin 注入与明暗锁定，无需刷新页面。
  var yieldObserver = null
  function recomputeYield() {
    try { apply(current) } catch (e) { /* 巡检兜底 */ }
  }
  function startYieldObserver() {
    if (yieldObserver || !document.documentElement) return
    yieldObserver = new MutationObserver(function () { recomputeYield() })
    yieldObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-mia-appearance', 'data-mia-skin', 'data-mia-wallpaper']
    })
  }

  function apply(t) {
    if (ORDER.indexOf(t) < 0) t = 'pure'
    current = t
    setAttr(t)
    ensureStyle()
    if (styleEl) styleEl.textContent = styleFor(t)
    syncDark()
    try { localStorage.setItem(KEY, t) } catch (e) { /* ignore */ }
    // 核心同步优先:桌宠 hash 通道 / 切换条图标 / 标题栏 —— 装饰层失败不得阻断
    // force=true：样式层刚换，diag 需立即反映新主题（不等节流窗口）
    syncHash(true)
    notifyPet()
    refreshSwitcher()
    updateTitlebar()
    try { updateWatermark() } catch (e) { /* 装饰失败由自愈巡检恢复 */ }
    try { updateAurora() } catch (e) { /* 同上 */ }
  }

