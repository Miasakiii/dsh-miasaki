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

  /* W4.3（2026-09-25）窗口底色回传：把「页面实际底色」经 hash 报给壳。
     Rust 侧的窗口底 / Mica 回退色是**硬编码两档**（main.rs:1652-1655：kurkuriel→浅、
     其余→深）、**只在窗口创建时算一次**，运行期切主题或换皮肤时不会更新 —— Win10
     （Mica 不可用）下会露出旧主题的实色底。
     只在 apply() / 首帧算一次：`getComputedStyle` 是强制同步布局，不可放进高频路径
     （diag 段 1.5s 一轮曾造成 15–47ms 尖峰的教训见本文件顶部）。
     取不到不透明底就返回空串 —— **不上报**，壳保持既有硬编码，不引入新的错误来源。 */
  /* @slice:native-bg:begin —— themes/test/native-bg.test.js 按此标记截段做底色解析行为闸门，勿删/勿改本行 */
  var CUR_BG = ''
  function parseCssColor(value) {
    var m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(String(value || ''))
    if (!m) return null
    var a = m[4] === undefined ? 1 : (m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]))
    if (!(a >= 0 && a <= 1)) return null
    return { r: +m[1], g: +m[2], b: +m[3], a: a }
  }
  function toHexColor(color) {
    var h = function (n) {
      var s = Math.max(0, Math.min(255, Math.round(n))).toString(16)
      return s.length === 1 ? '0' + s : s
    }
    return h(color.r) + h(color.g) + h(color.b)
  }
  function resolveNativeBg() {
    try {
      if (!window.getComputedStyle) return ''
      var body = document.body || document.documentElement
      if (!body) return ''
      var top = parseCssColor(getComputedStyle(body).backgroundColor)
      if (!top || top.a === 0) return ''
      if (top.a >= 1) return toHexColor(top)
      var under = parseCssColor(getComputedStyle(document.documentElement).backgroundColor)
      if (!under || under.a < 1) return '' // 拿不到不透明底 → 放弃上报
      var a = top.a
      return toHexColor({
        r: top.r * a + under.r * (1 - a),
        g: top.g * a + under.g * (1 - a),
        b: top.b * a + under.b * (1 - a)
      })
    } catch (e) { return '' }
  }
  /* @slice:native-bg:end */

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
        // W4.3：窗口底色（6 位十六进制，不带 `#`——`#` 会截断 fragment）。空串即不上报。
        var bgPart = CUR_BG === '' ? '' : '&bg=' + CUR_BG
        history.replaceState(null, '', '#miasaki-theme=' + current + '&int=' + CUR_INT + actPart + waitPart + petPart + bgPart + '&diag=' + DIAG_CACHE)
      }
    } catch (e) { /* ignore */ }
  }

  // W0-T0.3（2026-09-25）删除 notifyPet：它 invoke 的 `set_pet_mode` 命令**从未注册**
  // （注册表 main.rs:1607-1618 共 10 个命令，无此名），调用恒失败并被 .catch() 静默吞掉，
  // 只留下"IPC 通道存在"的假象。桌宠主题联动实际由 hash 通道完成：
  // syncHash 写 `miasaki-theme` → Rust 消费点（main.rs:1191-1204）→ pet.set_mode/set_theme
  // （映射口径见 main.rs:947 `pet_mode_for`）。连同删除 00-boot.js 中仅供它使用的 PET_MODES。

  // 本地唤醒页判定：Windows 上 Tauri 2 本地页协议为 http://tauri.localhost，
  // 单协议判定(location.protocol === 'tauri:')恒 false → 本地页出现切换条/水印/
  // 光晕等"画面不统一"回归(2026-08-29 修过,后于重构中丢失)。protocol + hostname 双重判定。
  var IS_LOCAL = location.protocol === 'tauri:' || /^tauri\.localhost$/i.test(location.hostname || '')

  // 主题来源优先级（W0-T0.1 2026-09-25 修复断链）：
  //   ① 壳注入的 window.__MIA_THEME__ —— Rust 在窗口创建时读 prefs.json 注入（main.rs:1647-1649），
  //      是**权威值**，也是唯一能跨「本地唤醒页(tauri.localhost) ↔ DSH 页(127.0.0.1:3080)」的通道
  //      （两页不同源，localStorage 不互通）。
  //   ② URL 参数 miasaki-theme（外部直达/调试）
  //   ③ localStorage（页面内切换后的持久值）
  // 修复前：壳注入了 __MIA_THEME__ 但 themes/src 全片零读取 → loading 页 localStorage 为空
  // ⇒ current 退化成 'pure'，而该页 :root 默认色板是 zafkiel ⇒ 启动画面与 DSH 页主题不一致（闪窗）。
  /* @slice:theme-source:begin —— themes/test/theme-source.test.js 按此标记截段做优先级行为闸门，勿删/勿改本行 */
  var current = 'pure'
  try {
    var saved = localStorage.getItem(KEY)
    if (ORDER.indexOf(saved) >= 0) current = saved
    var qp = new URLSearchParams(location.search).get('miasaki-theme')
    if (ORDER.indexOf(qp) >= 0) current = qp
    // 非壳环境（普通浏览器）为 undefined → indexOf 返回 -1，天然不生效
    if (ORDER.indexOf(window.__MIA_THEME__) >= 0) current = window.__MIA_THEME__
  } catch (e) { /* ignore */ }
  /* @slice:theme-source:end */

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
    // W4.3：样式层刚换 → 先重算窗口底色，再同步（顺序即契约：syncHash 读 CUR_BG）
    CUR_BG = resolveNativeBg()
    syncHash(true)
    refreshSwitcher()
    updateTitlebar()
    try { updateWatermark() } catch (e) { /* 装饰失败由自愈巡检恢复 */ }
    try { updateAurora() } catch (e) { /* 同上 */ }
  }

  /* 契约 v1.1（2026-09-25）受控写能力：**主题切换**。
     契约分片是独立 IIFE、拿不到本作用域的 `apply`/`current`，故以**内部事件**为界：
     契约只派发 `miasaki-theme-set`，这里执行。
     **双向校验**（事件可被任意页面脚本派发）：白名单 + 与当前值不同才动 ——
     重复 apply 会白跑一整轮样式重算与自愈巡检。 */
  try {
    window.addEventListener('miasaki-theme-set', function (e) {
      try {
        var t = e && e.detail && e.detail.theme
        if (ORDER.indexOf(t) >= 0 && t !== current) apply(t)
      } catch (e2) { /* 执行失败不影响页面其它逻辑 */ }
    })
  } catch (e) { /* ignore */ }

