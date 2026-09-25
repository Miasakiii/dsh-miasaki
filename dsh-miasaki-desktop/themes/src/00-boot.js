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

  // DSH web 鉴权 cookie 注入（v2026-09-05 修复「桌面端黑屏」）：
  // dsh web 重启后旧 cookie 失效 → 401 纯文本页（深色底 = 黑屏）。
  //
  // 本段是**兜底链**：主路径是 loading 页用 `~/.dsh/.credentials.yaml` 里的
  // browser-session.secret 签好 cookie、经 IPC 预置进 WebView2（main.rs set_auth_cookie），
  // 使首次 `GET /` 即带有效 cookie，401 不发生。
  //
  // 2026-09-23 加固（复审 P2-B，两处）：
  //  ① **绝不改写已有 `dsh-auth-*` cookie 的值**：init script 无 IPC，本段只有硬编码
  //     兜底 secret，而预置 cookie 用的是 credentials 里的真 secret。两者一旦漂移，
  //     无条件覆写会把**有效**cookie 换成无效的 —— 首次导航成功，下一次整页导航即 401，
  //     正是「预置注入」要防的场景被兜底链自己制造出来。现在只在**无 cookie**时签名；
  //     有 cookie 时仅按**原值**续写 Max-Age（保留「预置 session cookie → 持久 cookie」
  //     的原设计意图，但不动值）。
  //  ② 401 → reload 补**跨文档熔断**：原实现只在单个文档内做四轮停检，跨文档可无限
  //     reload（每次新文档都重签/重判）。现用 sessionStorage 记次数，超过上限停止重载
  //     并显示可见错误提示；第 MAX 次前若「有 cookie 却仍 401」，清掉这份无效 cookie，
  //     给兜底签名最后一次自愈机会。
  /* @slice:auth-cookie:begin —— themes/test/auth-cookie.test.js 按此标记截段做行为闸门，勿删/勿改本行 */
  ;(function () {
    try {
      if (location.origin !== 'http://127.0.0.1:3080') return
      if (typeof crypto === 'undefined' || !crypto.subtle) return
      var SECRET_B64 = '2h4nw6Dhj2bmzH3ATVS3MAcld_4DEW1PieSSOi_ETas' // 仅无 cookie 时使用
      var AUTHORITY = '127.0.0.1:3080'
      var COOKIE_PREFIX = 'dsh-auth-'
      var COOKIE_TAIL = '; Path=/; Max-Age=2592000; SameSite=Strict'
      var RELOAD_KEY = 'miasaki.auth.reloads'
      var MAX_RELOADS = 3
      var b64url = function (u8) {
        var s = ''
        for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      }
      var fromB64url = function (s) {
        var bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
        var u8 = new Uint8Array(bin.length)
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
        return u8
      }

      // ---- 已有鉴权 cookie 的读写（cookie 名固定为 dsh-auth-<sha256(authority)>） ----
      var readAuthCookie = function () {
        var jar = String(document.cookie || '').split(';')
        for (var i = 0; i < jar.length; i++) {
          var item = jar[i].replace(/^\s+/, '')
          if (item.indexOf(COOKIE_PREFIX) !== 0) continue
          var eq = item.indexOf('=')
          if (eq <= 0) continue
          var value = item.slice(eq + 1)
          if (value !== '') return { name: item.slice(0, eq), value: value }
        }
        return null
      }
      var dropAuthCookie = function (name) {
        try { document.cookie = name + '=; Path=/; Max-Age=0' } catch (e) { /* ignore */ }
      }

      // ---- 兜底签名（只在无 cookie 时执行） ----
      var signFallback = function () {
        return crypto.subtle.importKey('raw', fromB64url(SECRET_B64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
          .then(function (key) {
            var issued = Date.now()
            var expires = issued + 30 * 86400 * 1000
            var payload = JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: issued, expiresAt: expires })
            var body = b64url(new TextEncoder().encode(payload))
            return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)).then(function (sig) {
              return body + '.' + b64url(new Uint8Array(sig))
            })
          })
          .then(function (signed) {
            return crypto.subtle.digest('SHA-256', new TextEncoder().encode(AUTHORITY)).then(function (dig) {
              document.cookie = COOKIE_PREFIX + b64url(new Uint8Array(dig)) + '=v1.' + signed + COOKIE_TAIL
            })
          })
      }
      var ensureCookie = function () {
        var existing = readAuthCookie()
        if (existing !== null) {
          // 同值续写：把预置的 session cookie 升级为持久 cookie（原设计意图），
          // 值一个字节都不动 —— 见段首 ①。
          try { document.cookie = existing.name + '=' + existing.value + COOKIE_TAIL } catch (e) { /* ignore */ }
          return Promise.resolve()
        }
        return signFallback()
      }

      // ---- 401 检测（原逻辑保持不变：text/plain 文档 body/innerText 无保证，三级兜底） ----
      var is401 = function () {
        try {
          if (document.body) {
            var t = (document.body.innerText || '') || (document.body.textContent || '')
            if (t && (t.indexOf('authentication required') !== -1
              || t.indexOf('reopen the URL printed') !== -1)) return true
          }
          var r = document.documentElement
          if (r && r.textContent && (r.textContent.indexOf('authentication required') !== -1
            || r.textContent.indexOf('reopen the URL printed') !== -1)) return true
        } catch (e2) { /* ignore */ }
        return false
      }

      // ---- 跨文档熔断计数（sessionStorage：同标签页跨导航保留，新窗口自然归零） ----
      var readCount = function () {
        try {
          var n = parseInt(sessionStorage.getItem(RELOAD_KEY) || '0', 10)
          return isNaN(n) || n < 0 ? 0 : n
        } catch (e) { return 0 }
      }
      var writeCount = function (n) {
        try { sessionStorage.setItem(RELOAD_KEY, String(n)) } catch (e) { /* ignore */ }
      }
      var clearCount = function () {
        try { sessionStorage.removeItem(RELOAD_KEY) } catch (e) { /* ignore */ }
      }
      // 复位只在**确实到达正常文档**时做：本段跑在 document_start，那时 body 尚不存在，
      // is401() 必然为 false —— 若据此复位，熔断计数永远归零、等于没有熔断。
      var resetIfDocumentSettled = function () {
        try {
          var rs = document.readyState
          if (rs === 'interactive' || rs === 'complete') clearCount()
        } catch (e) { /* ignore */ }
      }
      var showHalt = function (tries) {
        var paint = function () {
          try {
            if (!document.body || document.getElementById('miasaki-auth-halt') !== null) return
            var el = document.createElement('div')
            el.id = 'miasaki-auth-halt'
            el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#7f1d1d;'
              + 'color:#fff;font:12px/1.7 monospace;padding:8px 12px;white-space:pre-wrap'
            el.textContent = 'MIASAKI: 鉴权 cookie 注入失败 —— 已连续重载 ' + tries + ' 次仍返回 401，停止自动重载。\n'
              + '可能原因：~/.dsh/.credentials.yaml 的 client-connection/browser-session.secret 与 00-boot 兜底常量不一致'
              + '（桌面端重启会用真 secret 自动预置，可先重启）。\n'
              + '处理：重启桌面端；仍不行则清除 127.0.0.1:3080 的站点数据 / cookie 后重开。'
            document.body.appendChild(el)
          } catch (e) { /* ignore */ }
        }
        try {
          if (document.body) paint()
          else document.addEventListener('DOMContentLoaded', paint)
        } catch (e) { /* ignore */ }
      }

      var reloading = false
      var check = function () {
        if (reloading) return
        if (!is401()) { resetIfDocumentSettled(); return }
        var n = readCount() + 1
        writeCount(n)
        if (n > MAX_RELOADS) { showHalt(MAX_RELOADS); return }
        // 最后一次机会：已有 cookie 却仍是 401 → 这份 cookie 已无效，清掉它，
        // 让 reload 后的文档走「无 cookie → 兜底签名」路径。
        if (n === MAX_RELOADS) {
          var stale = readAuthCookie()
          if (stale !== null) dropAuthCookie(stale.name)
        }
        reloading = true
        location.reload()
      }
      var armChecks = function () {
        // 四轮检查（2026-09-22 加固）：401 是 text/plain 文档，body/innerText 到位时机
        // 无保证，漏检即永久停住。文档解析完成时再挂一次（此时判定最可靠）。
        check()
        setTimeout(check, 100)
        setTimeout(check, 400)
        setTimeout(check, 1200)
      }
      try { document.addEventListener('DOMContentLoaded', check) } catch (e) { /* ignore */ }

      // 签名失败也必须挂上 401 兜底检查（原来整段在 .then 里，失败即静默停摆）。
      ensureCookie().then(armChecks, armChecks)
    } catch (e) { /* ignore */ }
  })()
  /* @slice:auth-cookie:end */

  // 全局错误陷阱：异常可视化到屏幕左上角（诊断用，可被 MiMo 读取）
  // 只保留**最新一条**（2026-09-23 修复）：早期实现每次 error 都 appendChild 一个
  // 新 div，反复触发时红条沿屏幕向下堆叠、盖住页面内容（实机截图里红条已压住
  // 会话区）。改为复用同一个 div 更新文本；重入场景（页面重渲染把旧节点清掉）
  // 由 parentNode 判空兜底重建。次数由文本内 [N] 承担，ERR_COUNT 另有 hash
  // 诊断位消费，语义不变。
  //
  // 2026-09-25 过滤浏览器调度产物：Chrome/WebView2 在 ResizeObserver 回调引起
  // 观察元素尺寸反复变化、超过单帧派发上限时，会以 ErrorEvent 形式向 window 抛
  // "ResizeObserver loop completed with undelivered notifications."
  // （Firefox 措辞 "ResizeObserver loop limit exceeded"）。该事件**没有脚本来源**
  // （filename 落文档 URL、lineno 为 0），触发者是宿主页面自身的观察器（DSH 本体的
  // 流式跟滚 / 布局过渡 / 虚拟列表），与注入层无关：注入层全部覆盖物均为
  // position:fixed，唯一自建 RO（侧栏几何同步）只读布局、只写 fixed 标题栏，
  // 结构上不可能自反馈成环（2026-09-25 实机截图复现后逐环路核查确认）。
  // 这类事件若照单全收：①红条误报注入层缺陷；②ERR_COUNT 随宿主页每次布局过渡
  // 虚增，污染 hash diag 的 errCount 诊断位与 Rust 日志。故按「消息变体 + 无脚本
  // 来源」双重判据直接忽略——宁可漏显示一条无法定位的浏览器内部提示，也不让
  // 诊断通道长期「狼来了」。
  function isBrowserArtifactError(e) {
    try {
      var m = String((e && e.message) || '').replace(/^\s+|\s+$/g, '')
      if (!/^ResizeObserver loop (completed with undelivered notifications\.|limit exceeded\.?)$/.test(m)) return false
      // 真实脚本异常必有行号；调度产物类事件 lineno 为 0/缺失
      return !e.lineno
    } catch (e3) { return false }
  }
  var ERR_COUNT = 0
  var ERR_BAR = null
  window.addEventListener('error', function (e) {
    if (isBrowserArtifactError(e)) return
    ERR_COUNT++
    try {
      if (ERR_BAR === null || ERR_BAR.parentNode === null) {
        ERR_BAR = document.createElement('div')
        ERR_BAR.id = 'miasaki-err'
        ERR_BAR.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#d00;color:#fff;' +
          'font:11px monospace;padding:5px 8px;max-width:700px;white-space:pre-wrap;border-radius:0 0 8px 0'
        document.body.appendChild(ERR_BAR)
      }
      ERR_BAR.textContent = 'MIASAKI-ERR[' + ERR_COUNT + ']: ' + (e.message || e.type) + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno
    } catch (e2) { /* ignore */ }
  })

  var STYLES = (typeof window.__MIASAKI_STYLES__ === 'object' && window.__MIASAKI_STYLES__) || {}
  // M2 S6 让位协议（appearance M2 设计 §4.1）：appearance 线接管主题时（总开关 on 且皮肤非
  // pure），desktop **停注入 skin 配色层**并停明暗锁定——装饰层与 --ms-* 恒保留。
  // 判定属性由 appearance 的 boot script 写在 <html> 上。
  function appearanceYield() {
    try {
      var root = document.documentElement
      return root.getAttribute('data-mia-appearance') === 'on' && (root.getAttribute('data-mia-skin') || 'pure') !== 'pure'
    } catch (e) { return false }
  }
  // 非 pure 主题样式为 {skin, deco} 两层；让位只注入 deco，否则 deco + skin
  // （级联等价于拆分前；让位期配色由 appearance 线的 static 覆盖接管）。
  function styleFor(t) {
    var s = STYLES[t]
    if (!s) return ''
    if (typeof s === 'string') return s
    return appearanceYield() ? (s.deco || '') : (s.deco || '') + (s.skin || '')
  }
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
  // W0-T0.3（2026-09-25）删除 PET_MODES：它与 Rust 侧 main.rs:947 `pet_mode_for` 是重复定义，
  // 且唯一使用者 notifyPet 已随 `set_pet_mode`（未注册命令）一并删除。主题→桌宠角色的
  // 事实源在 Rust 侧，改映射时只改 main.rs:947 与 pet_native/dot.rs:34（两者互相标注）。

