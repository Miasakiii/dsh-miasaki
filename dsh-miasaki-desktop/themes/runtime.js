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

  /* ---------- 人格会话联动:主题 → Agent 预设(whale/kurumi/inverse) ----------
   * 切换主题时用对应桌宠的 Agent 预设开一个新会话(官方 RPC:
   * POST /api/session.create,payload.agentPreset)。每个主题只自动创建一次,
   * 记录在 localStorage(miasaki.petSessions);同级部署无该预设或 RPC 不可用
   * 时静默降级,绝不阻断主题切换。 */
  var PERSONA_MAP = { pure: 'whale', zafkiel: 'kurumi', kurkuriel: 'inverse' }
  var PERSONA_NAMES = { pure: '\u9CB8\u9C7C\u5A18', zafkiel: '\u72C2\u4E09', kurkuriel: '\u53CD\u8F6C\u72C2\u4E09' }
  var PET_SESSION_KEY = 'miasaki.petSessions'
  var personaToastTimer = null
  function personaToast(msg) {
    try {
      if (!document.body) return
      var el = document.getElementById('miasaki-persona-toast')
      if (!el) {
        el = document.createElement('div')
        el.id = 'miasaki-persona-toast'
        el.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483646;' +
          'background:rgba(20,18,26,.94);color:#e8e2d8;border:1px solid rgba(217,179,106,.55);border-radius:10px;' +
          'padding:8px 14px;font:12.5px/1.5 "Segoe UI",system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);' +
          'max-width:76vw;text-align:center;pointer-events:none;opacity:0;transition:opacity .25s ease'
        document.body.appendChild(el)
      }
      el.textContent = msg
      el.style.opacity = '1'
      if (personaToastTimer) clearTimeout(personaToastTimer)
      personaToastTimer = setTimeout(function () { el.style.opacity = '0' }, 3600)
    } catch (e) { /* 提示失败不影响功能 */ }
  }
  function loadPetSessions() {
    try {
      var m = JSON.parse(localStorage.getItem(PET_SESSION_KEY) || '{}')
      return (m && typeof m === 'object') ? m : {}
    } catch (e) { return {} }
  }
  function savePetSessions(m) {
    try { localStorage.setItem(PET_SESSION_KEY, JSON.stringify(m)) } catch (e) { /* ignore */ }
  }
  function ensurePersonaSession(theme) {
    if (IS_LOCAL) return
    try {
      var preset = PERSONA_MAP[theme]
      if (!preset) return
      var m = loadPetSessions()
      if (m[theme]) {
        personaToast('\u300C' + PERSONA_NAMES[theme] + '\u300D\u4EBA\u683C\u4F1A\u8BDD\u5DF2\u5EFA\u7ACB\uFF0C\u53EF\u5728\u4F1A\u8BDD\u5217\u8868\u4E2D\u9009\u62E9')
        return
      }
      function rpcSend(method, payload) {
        var rpcId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('m-' + Date.now() + '-' + Math.random().toString(36).slice(2))
        return fetch('/api/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: rpcId, method: method, payload: payload })
        }).then(function (res) { return res.json() })
      }
      // 优先挂到当前工作区(workspace.list 第一个),避免新会话落到 Host 默认目录
      rpcSend('workspace.list', {}).then(function (f) {
        var wsOpt = {}
        try {
          var items = f && f.result && f.result.ok && f.result.value && f.result.value.items
          if (items && items.length && items[0].workspaceId) wsOpt = { workspaceId: items[0].workspaceId }
        } catch (e) { /* ignore */ }
        return rpcSend('session.create', Object.assign({ agentPreset: preset }, wsOpt))
      }).then(function (full) {
        if (full && full.result && full.result.ok) {
          m[theme] = full.result.value.sessionId
          savePetSessions(m)
          personaToast('\u5DF2\u521B\u5EFA\u300C' + PERSONA_NAMES[theme] + '\u300D\u4EBA\u683C\u4F1A\u8BDD\uFF0C\u53EF\u5728\u4F1A\u8BDD\u5217\u8868\u6253\u5F00')
        } else {
          var err = full && full.result && full.result.error ? (full.result.error.code || full.result.error.message) : 'unknown'
          personaToast('\u4EBA\u683C\u4F1A\u8BDD\u521B\u5EFA\u5931\u8D25:' + err)
        }
      }).catch(function (e) {
        personaToast('\u4EBA\u683C\u4F1A\u8BDD\u521B\u5EFA\u5931\u8D25:' + ((e && e.message) ? e.message : '\u7F51\u7EDC\u9519\u8BEF'))
      })
    } catch (e) { /* 联动失败绝不阻断主题切换 */ }
  }

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
    '#miasaki-titlebar .tb-brand{animation:none}' +
    '#miasaki-titlebar #tb-theme,#miasaki-titlebar .tb-sub{transition:none}' +
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
    'background-color:var(--dsw-alias-bg-base,var(--ms-panel,#1e1a27));' +
    // 主题装饰底线：--ms-deco-line 由各主题定义；独立声明 + 逐层回退，装饰层失效不拖垮基底
    'background-image:var(--ms-deco-line,none);background-repeat:no-repeat;' +
    'background-position:0 100%;background-size:100% 1px;' +
    'color:var(--dsw-alias-label-primary,var(--ms-text,#e4def0));font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
    'user-select:none;-webkit-user-select:none;cursor:default;}' +
    '#miasaki-titlebar::before{content:"";position:absolute;left:0;top:0;bottom:0;' +
    // 回退色为 transparent：DSH 令牌(--dsw-specific-sidebar-fill)未就绪(页面加载早期)时
    // 不显示色块——此前回退深色 #1e1a27 会在加载期形成"左上角闪烁黑块"，令牌就绪后才
    // 变主题色；DSH 渲染完成后令牌生效，色块与侧栏同时出现，视觉衔接。
    'width:var(--ms-sidebar-w,280px);background:var(--dsw-specific-sidebar-fill,transparent);' +
    'border-right:1px solid var(--dsw-alias-border-l1,transparent);box-sizing:border-box;pointer-events:none;}' +
    '#miasaki-titlebar::after{content:"";position:absolute;top:0;bottom:0;left:var(--ms-details-left,auto);' +
    'width:1px;background:var(--dsw-alias-border-l2,transparent);pointer-events:none;opacity:0;}' +
    '#miasaki-titlebar[data-details-open]::after{opacity:1;}' +
    // 本地唤醒页：无 DSH 侧栏/详情布局，隐藏模拟分隔线色块，标题栏保持纯净
    '#miasaki-titlebar[data-local]::before,#miasaki-titlebar[data-local]::after{display:none;}' +
    '#miasaki-titlebar>*{position:relative;z-index:1;}' +
    '#miasaki-titlebar .tb-drag{flex:1;height:100%;cursor:move;}' +
    '#miasaki-titlebar .tb-title{font-size:11.5px;font-weight:500;letter-spacing:.03em;' +
    'display:flex;align-items:center;opacity:.85;}' +
    '#miasaki-titlebar .tb-brand{width:20px;height:20px;border-radius:50%;flex:none;object-fit:cover;display:block;' +
    'margin-right:7px;box-shadow:0 0 5px var(--ms-glow,rgba(217,179,106,.35));animation:ms-brand-breathe 3.2s ease-in-out infinite;}' +
    // 主题文字：margin 承担原 gap 间距；收起时 max-width/margin/opacity 过渡淡出
    // （display:none 无过渡，侧栏收起动画期间文字瞬间消失 → 切换不连贯）
    '#miasaki-titlebar #tb-theme{margin-right:7px;max-width:240px;overflow:hidden;white-space:nowrap;' +
    'transition:opacity .18s ease,max-width .18s ease,margin-right .18s ease;}' +
    '#miasaki-titlebar .tb-sub{font-size:10.5px;font-weight:400;opacity:.55;letter-spacing:.02em;' +
    'max-width:240px;overflow:hidden;white-space:nowrap;' +
    'transition:opacity .18s ease,max-width .18s ease,margin-right .18s ease;}' +
    // 侧栏收起态：主题文字淡出(仅留图标)；::before 宽随 --ms-sidebar-w 逐帧跟随 DSH 收起动画
    '#miasaki-titlebar[data-sidebar-collapsed] #tb-theme,' +
    '#miasaki-titlebar[data-sidebar-collapsed] .tb-sub{opacity:0;max-width:0;margin-right:0;pointer-events:none;}' +
    '#miasaki-titlebar[data-sidebar-collapsed]::before{border-right-color:transparent;}' +
    '@keyframes ms-brand-breathe{0%,100%{opacity:.78}50%{opacity:1}}' +
    '#miasaki-titlebar .tb-btn{width:28px;height:28px;display:flex;align-items:center;justify-content:center;' +
    'cursor:pointer;font-size:13px;border-radius:999px;color:var(--dsw-alias-label-secondary,var(--ms-text,#e4def0));' +
    'opacity:.9;transition:background .15s ease,color .15s ease;}' +
    '#miasaki-titlebar .tb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--ms-hover,#2a2434));' +
    'color:var(--dsw-alias-label-primary,var(--ms-accent,#d9b36a));opacity:1;}' +
    '#miasaki-titlebar .tb-btn:active{transform:scale(.94);}' +
    // 按钮图标统一 SVG 线形：同一视口/描边/端帽，消除字符字形(–/□/✕)粗细基线不一
    '#miasaki-titlebar .tb-btn svg{width:10px;height:10px;display:block;fill:none;' +
    'stroke:currentColor;stroke-width:1;stroke-linecap:round;stroke-linejoin:round;}' +
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
    '#miasaki-aurora .aur-c{width:38vw;height:38vw;left:28vw;bottom:-16vw;}' +
    '#miasaki-close-mask{position:fixed;inset:0;z-index:100001;background:rgba(6,5,10,.55);' +
    'opacity:0;pointer-events:none;transition:opacity .2s ease;}' +
    '#miasaki-close-mask.on{opacity:1;pointer-events:auto;}' +
    '#miasaki-close-dialog{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
    'z-index:100002;display:none;min-width:320px;max-width:430px;border-radius:12px;' +
    'padding:18px 20px 16px;background:var(--ms-panel,#1e1a27);border:1px solid var(--ms-accent,#d9b36a);' +
    'color:var(--ms-text,#e4def0);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
    'box-shadow:0 18px 44px rgba(0,0,0,.55);}' +
    '#miasaki-close-dialog.on{display:block;}' +
    '#miasaki-close-dialog .mc-title{font-size:14.5px;font-weight:600;margin-bottom:6px;}' +
    '#miasaki-close-dialog .mc-body{font-size:12.5px;line-height:1.65;opacity:.82;}' +
    '#miasaki-close-dialog .mc-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}' +
    '#miasaki-close-dialog .mc-btn{padding:6px 16px;font-size:12.5px;border-radius:6px;cursor:pointer;' +
    'border:1px solid var(--ms-border,#3a3243);background:transparent;color:var(--ms-text,#e4def0);' +
    'font-family:inherit;letter-spacing:.04em;}' +
    '#miasaki-close-dialog .mc-btn:hover{background:var(--ms-hover,#2a2434);}' +
    '#miasaki-close-dialog .mc-btn.mc-ok{background:var(--ms-danger,#c23a2e);' +
    'border-color:var(--ms-danger,#c23a2e);color:#fff;}' +
    '#miasaki-close-dialog .mc-btn.mc-ok:hover{filter:brightness(1.08);}'

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
    if (reduced || !document.body) { apply(target); ensurePersonaSession(target); return }
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
      ensurePersonaSession(target)
      overlay.classList.remove('run')
    }, reduced ? 150 : 400)
  }

  function buildSwitcher() {
    if (!document.body || IS_LOCAL) return
    // 仅当切换条真实挂载在文档中时才视为已构建：若元素被页面重渲染移除，
    // switcher 变量仍指向旧节点（parentNode=null），此前按变量非空判断会导致
    // 1s 巡检永远无法重建（按钮永久消失）；构建中途抛错时同理可重试。
    if (switcher && switcher.parentNode) return
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
    var opts = switcher.querySelectorAll('.ms-opt')
    for (var ki = 0; ki < opts.length; ki++) {
      var oo = opts[ki]
      var tt = oo.getAttribute('data-theme')
      oo.setAttribute('title', TIPS[tt] || (META[tt].name + ' · ' + META[tt].sub))
    }
    (function bindTipHover() {
      try {
        var tip = switcher.querySelector('.ms-tip')
        var opts2 = switcher.querySelectorAll('.ms-opt')
        for (var k2 = 0; k2 < opts2.length; k2++) {
          (function (optEl) {
            var tt2 = optEl.getAttribute('data-theme')
            optEl.addEventListener('mouseenter', function () {
              if (tip && TIPS[tt2]) tip.textContent = TIPS[tt2]
            })
            optEl.addEventListener('mouseleave', function () {
              if (tip) tip.textContent = TIPS[current]
            })
          })(opts2[k2])
        }
      } catch (e) {}
    })()
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

  // 图标加载失败时退回文字字形（data-glyph 标记便于需要重建容器的地方清理残留）
  window.__msGlyphFallback = function (img, theme) {
    try {
      img.style.display = 'none'
      var g = document.createElement('span')
      g.setAttribute('data-glyph', '1')
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


  /* 思考强度：跟随 DSH 模型选择器的推理等级（用户手动选择 → 稳定不抖动）
   * 显示形如 "deepseek-v4-flash-vision-exp · Max"。映射：off→idle、low/light/medium→work、high/max→deep */
  var CUR_INT = 'idle'
  var CUR_ACT = 'idle'   // busy / idle —— 总指挥会话"生成中"活动状态
  var CUR_WAIT = false   // true —— 等待 Operator 审批工具调用
  var PET_TIER_MS = 1500
  var PET_ACT_CONFIRM_N = 2 // 防抖:act 翻转需连续 N 次扫描一致
  var PET_WAIT_CONFIRM_N_OFF = 2 // 审批消失需 N 次确认;出现立即上报
  var _actPending = null   // 候选新值
  var _actPendingN = 0
  var _waitPending = false
  var _waitPendingN = 0
  var EFFORT_RE = /(max|high|medium|light|low|off|standard|\u6807\u51c6|\u9ad8|\u4e2d|\u4f4e|\u5173\u95ed)/i
  // 生成中文本(DSH 页面"停止生成"按钮,严格完全匹配避免误报)
  var ACT_BTN_TEXT = ['\u505C\u6B62\u751F\u6210', 'Stop', 'Stop generating', '\u505C\u6B62'] // 停止生成 / Stop / 停止
  // 审批按钮文本对(允许/拒绝 / Approve/Deny / 同意/拒绝)
  var APPROVE_TEXT = ['\u5141\u8BB8', 'Approve', 'Allow', '\u540C\u610F', '\u6279\u51C6'] // 允许/Approve/Allow/同意/批准
  var DENY_TEXT = ['\u62D2\u7EDD', 'Deny', 'Reject', '\u4E0D\u5141\u8BB8', '\u53D6\u6D88'] // 拒绝/Deny/Reject/不许可/取消
  // 审批容器候选(限定到对话框/审批组件内,避免误报普通按钮)
  var APPROVE_CONTAINER_SEL = '[role="dialog"],[role="alertdialog"],[class*="modal" i],[class*="approve" i],[class*="confirm" i],[class*="permission" i]'

  function scanEffort() {
    if (!document.body) return null
    var nodes = document.querySelectorAll('button, [role="button"], span')
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      if (el.closest && el.closest('#miasaki-switcher')) continue
      var t = (el.textContent || '').trim()
      if (!t || t.length > 48) continue
      var m = t.match(/[^\u00b7\u00b7]*[\u00b7\u00b7]\s*([^\u00b7\u00b7]{1,12})$/i)
      var label = m ? m[1] : null
      if (!label || !EFFORT_RE.test(label)) continue
      var l = label.toLowerCase()
      if (l.indexOf('max') >= 0) return 'deep'
      if (l.indexOf('high') >= 0 || l.indexOf('\u9ad8') >= 0) return 'work'
      if (l.indexOf('medium') >= 0 || l.indexOf('light') >= 0 || l.indexOf('low') >= 0 ||
          l.indexOf('\u4e2d') >= 0 || l.indexOf('\u4f4e') >= 0 || l.indexOf('\u6807\u51c6') >= 0) return 'work'
      if (l.indexOf('off') >= 0 || l.indexOf('\u5173\u95ed') >= 0) return 'idle'
    }
    return null
  }

  // 严格按钮文本匹配(完全等于,空白 trim,长度 < 16 防误命中大段文本)
  function isBtnTextMatch(t, candidates) {
    if (!t) return false
    var s = t.replace(/\s+/g, ' ').trim()
    if (!s || s.length > 16) return false
    for (var i = 0; i < candidates.length; i++) if (s === candidates[i]) return true
    return false
  }

  // 检测"生成中":页面上存在"停止生成"类按钮(限 #miasaki-switcher / 主题注入组件外)
  function scanActivity() {
    if (!document.body) return 'idle'
    var btns = document.querySelectorAll('button, [role="button"]')
    for (var i = 0; i < btns.length; i++) {
      var el = btns[i]
      if (el.closest && (el.closest('#miasaki-switcher') || el.closest('#miasaki-titlebar'))) continue
      if (!el.offsetParent && getComputedStyle(el).visibility !== 'visible') continue
      if (isBtnTextMatch(el.textContent, ACT_BTN_TEXT)) return 'busy'
    }
    return 'idle'
  }

  // 检测"等待审批":在 dialog/modal/approve 容器内同时存在允许类+拒绝类按钮
  function scanApproval() {
    if (!document.body) return false
    var containers = document.querySelectorAll(APPROVE_CONTAINER_SEL)
    for (var i = 0; i < containers.length; i++) {
      var c = containers[i]
      if (c.closest && c.closest('#miasaki-switcher')) continue
      if (!c.offsetParent) continue
      var btns = c.querySelectorAll('button, [role="button"]')
      var hasApprove = false, hasDeny = false
      for (var j = 0; j < btns.length; j++) {
        var t = (btns[j].textContent || '').replace(/\s+/g, ' ').trim()
        if (!hasApprove && isBtnTextMatch(t, APPROVE_TEXT)) hasApprove = true
        if (!hasDeny && isBtnTextMatch(t, DENY_TEXT)) hasDeny = true
        if (hasApprove && hasDeny) return true
      }
    }
    return false
  }

  function petEvalIntensity() {
    var tier = scanEffort()
    if (tier !== null && tier !== CUR_INT) {
      CUR_INT = tier
    }
    // act 防抖(2 次连续一致才生效,防流式指示闪烁)
    var act = scanActivity()
    if (act === _actPending) {
      _actPendingN++
    } else {
      _actPending = act
      _actPendingN = 1
    }
    if (_actPendingN >= PET_ACT_CONFIRM_N && _actPending !== CUR_ACT) {
      CUR_ACT = _actPending
    }
    // wait:出现立即上报;消失 2 次确认
    var wait = scanApproval()
    if (wait) {
      CUR_WAIT = true
      _waitPending = false
      _waitPendingN = 0
    } else {
      if (_waitPending) _waitPendingN++
      else { _waitPending = true; _waitPendingN = 1 }
      if (_waitPendingN >= PET_WAIT_CONFIRM_N_OFF) {
        CUR_WAIT = false
        _waitPending = false
      }
    }
    syncHash()
  }
  var tierTimer = setInterval(petEvalIntensity, PET_TIER_MS)

  /* 临时探针:Operator 在 console 跑 __miasakiProbe() 校准选择器
   * 会在桌宠气泡位输出"busy/wait 候选元素"列表,便于把 ACT_BTN_TEXT / APPROVE_TEXT /
   * DENY_TEXT / APPROVE_CONTAINER_SEL 调成当前 DSH 版本实际命中的文本与容器类名。 */
  window.__miasakiProbe = function () {
    var out = []
    var btns = document.querySelectorAll('button, [role="button"]')
    for (var i = 0; i < btns.length; i++) {
      var el = btns[i]
      if (el.closest && el.closest('#miasaki-switcher')) continue
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim()
      if (!t || t.length > 24) continue
      var inDlg = el.closest('[role="dialog"],[role="alertdialog"],[class*="modal" i]') ? 'in-dialog' : 'free'
      out.push({ kind: 'btn', text: t.slice(0, 20), ctx: inDlg, hidden: !el.offsetParent })
    }
    console.log('[miasaki probe] act=', scanActivity(), 'wait=', scanApproval())
    console.table(out.slice(0, 60))
    return out
  }

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

  /* ---------- 关闭确认弹窗（所有关闭入口收敛于此；确认后经 hash 通道通知 Rust 收尾） ---------- */
  var closeMask = null
  var closeDlg = null
  function buildCloseDialog() {
    if (!document.body || document.getElementById('miasaki-close-dialog')) return
    // 页面重渲染把旧 DOM 清掉时，闭包引用随之重置（重新构建）
    closeMask = document.createElement('div')
    closeMask.id = 'miasaki-close-mask'
    closeDlg = document.createElement('div')
    closeDlg.id = 'miasaki-close-dialog'
    closeDlg.innerHTML =
      '<div class="mc-title">关闭 Miasaki？</div>' +
      '<div class="mc-body">关闭应用将退出由桌面端启动的 DSH 服务，下次打开桌面端时会自动重新拉起。确定要关闭应用吗？</div>' +
      '<div class="mc-btns">' +
      '<button class="mc-btn mc-cancel">取消</button>' +
      '<button class="mc-btn mc-ok">关闭应用</button></div>'
    function hide() {
      if (closeMask) closeMask.classList.remove('on')
      if (closeDlg) closeDlg.classList.remove('on')
    }
    closeMask.addEventListener('click', hide)
    closeDlg.addEventListener('click', function (ev) { ev.stopPropagation() })
    closeDlg.querySelector('.mc-cancel').addEventListener('click', hide)
    closeDlg.querySelector('.mc-ok').addEventListener('click', function () {
      hide()
      // 本地唤醒页优先 invoke 命令（IPC 不受 URL 协议形态影响），失败回退 hash 通道；
      // 远程 DSH 页走 hash 通道（watchdog 统一解析）
      function shutdownViaHash() { petHashCmd('shutdown') }
      if (IS_LOCAL && window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke('shutdown').catch(shutdownViaHash)
      } else {
        shutdownViaHash()
      }
    })
    document.body.appendChild(closeMask)
    document.body.appendChild(closeDlg)
  }
  window.__miasakiOpenCloseDialog = function () {
    try {
      buildCloseDialog()
      if (closeMask) closeMask.classList.add('on')
      if (closeDlg) closeDlg.classList.add('on')
    } catch (e) { /* 弹窗失败不阻断关闭请求 */ }
  }

  // sync geometry
  // 对照 DSH 主布局（@deepseek-ai/dsh-client-ui-layout AppFrame，验证于 0.1.1-rc.1）：
  //   <div style="grid-template-columns: `${cols.sidebar}px minmax(0,1fr) ${cols.details}px`">
  //     <div class="sidebarCol">…  <!-- bg:--dsw-specific-sidebar-fill / border-right:--dsw-alias-border-l1 -->
  //     <div class="detailsCol">… <!-- border-left:--dsw-alias-border-l2；折叠时 cols.details=0 且去 border -->
  // titlebar 的 ::before/::after 模拟侧栏与详情分隔线向上延伸，与 DSH 的分隔线须逐像素重合。
  // 侧栏几何诊断位：最近一次解析/实测宽与收起判定（syncHash 写入 hash diag，Rust 落日志）
  var CUR_SIDEBAR_W = -1
  var CUR_COLLAPSED = 0
  // DSH 布局容器缓存：页面重渲染后 isConnected=false 时重新扫描
  var _frameCache = null
  // ResizeObserver 帧级同步：侧栏收起/展开是 CSS 动画（轨道宽逐帧变化），1s 巡检跟不上
  // 节奏 → 观察侧栏列元素尺寸，动画期间每帧驱动标题栏几何，与 DSH 动画同步；巡检仅兜底。
  var _sbObserver = null
  function watchSidebarEl(el) {
    if (typeof ResizeObserver === 'undefined') return
    try {
      if (!_sbObserver) {
        _sbObserver = new ResizeObserver(function () { syncTitlebarGeometry() })
      }
      if (_sbObserver.__el !== el) {
        if (_sbObserver.__el) {
          try { _sbObserver.unobserve(_sbObserver.__el) } catch (e) { /* ignore */ }
        }
        _sbObserver.observe(el)
        _sbObserver.__el = el
      }
    } catch (e) { /* RO 失败回退 1s 巡检 */ }
  }

  function syncTitlebarGeometry() {
    var bar = document.getElementById('miasaki-titlebar')
    if (!bar) return
    try { /* 装饰层异常绝不外泄（曾因 removeAttribute 误调 style 对象导致 onReady 级联中断） */
      var declW = -1
      var details = 0
      var frameWidth = 0
      // 信号 A：grid 容器轨道声明（首列=侧栏，含 0px；末列≥2 轨道时视为详情面板宽）
      // 优先缓存（RO 动画期间每帧调用，避免反复全量扫描）
      var frame = (_frameCache && _frameCache.isConnected) ? _frameCache : null
      if (!frame) {
        var candidates = document.querySelectorAll('#root [style]')
        for (var i = 0; i < candidates.length; i++) {
          var st = candidates[i].style
          if (st && st.gridTemplateColumns) { frame = candidates[i]; break }
        }
        _frameCache = frame
      }
      if (frame) {
        var px = frame.style.gridTemplateColumns.match(/([0-9.]+)px/g)
        if (px && px.length) {
          declW = parseFloat(px[0])
          if (px.length >= 2) details = parseFloat(px[px.length - 1]) || 0
        }
        var rect = frame.getBoundingClientRect()
        if (rect && rect.width > 0) frameWidth = rect.width
      }
      // 信号 B：首列元素实测宽（含 0；比轨道声明更贴近视觉宽度，grid item 默认 stretch）
      var firstW = -1
      if (frame && frame.firstElementChild && frame.firstElementChild.getBoundingClientRect) {
        firstW = frame.firstElementChild.getBoundingClientRect().width
        watchSidebarEl(frame.firstElementChild)
      }
      // 信号 C：sidebar 类元素可见性/宽度（防 DSH 改用 CSS modules 哈希类名后 B 失效）
      var sbW = -1
      var sbEl = document.querySelector('#root [class*="sidebar" i]')
      if (sbEl && sbEl.getBoundingClientRect) {
        sbW = sbEl.offsetParent === null ? 0 : sbEl.getBoundingClientRect().width
      }
      // 采用宽度：首列实测(B) > 轨道声明(A) > sidebar 元素(C) > 默认 280
      var useW = 280
      if (firstW >= 0) useW = firstW
      else if (declW >= 0) useW = declW
      else if (sbW >= 0) useW = sbW
      bar.style.setProperty('--ms-sidebar-w', useW + 'px')
      // 收起判定（方向驱动 + 稳态兜底）：RO 逐帧采样下，收窄方向第一帧即置收起（文字随
      // DSH 收起动画同步淡出）、展开方向立即恢复（文字随展开动画同步淡入）→ 切换连贯；
      // 无方向变化（稳态/首帧）按隐藏、归零、窄于 100px 兜底。
      var prevW = CUR_SIDEBAR_W
      var shrinking = prevW >= 0 && useW < prevW - 1
      var growing = prevW >= 0 && useW > prevW + 1
      var collapsed
      if (shrinking) collapsed = true
      else if (growing) collapsed = false
      else collapsed = sbW === 0 || useW === 0 || useW < 100
      if (collapsed) bar.setAttribute('data-sidebar-collapsed', '1')
      else bar.removeAttribute('data-sidebar-collapsed')
      // 诊断位（hash diag 尾追加，Rust 变化时落日志 → 导出诊断可远程定位）
      CUR_SIDEBAR_W = useW
      CUR_COLLAPSED = collapsed ? 1 : 0
      if (details > 0 && frameWidth > 0) {
        // detailsCol 的 border-left(1px) 位于第三轨道起点（容器右缘 - 轨道宽），与此值重合
        bar.style.setProperty('--ms-details-left', (frameWidth - details) + 'px')
        bar.setAttribute('data-details-open', '1')
      } else {
        bar.removeAttribute('data-details-open')
        bar.style.removeProperty('--ms-details-left')
      }
    } catch (e) { /* keep default；失败由 1s 巡检重试 */ }
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
    // 关闭确认弹窗无条件构建（本地唤醒页同样需要：Alt+F4 走系统关闭路径 + 弹窗确认）
    try { buildCloseDialog() } catch (e) {}
    // 标题栏本地/远程页均构建（本地页同样需要拖动区与窗口按钮）
    try { buildTitlebar() } catch (e) {}
    // 最大化状态同步本地/远程页均需要（Rust eval 派发的 CustomEvent 两页同源）
    try { wireMaxState() } catch (e) {}
    if (!IS_LOCAL) {
      // 装饰层逐一隔离：单个构建异常不得中断后续构建与巡检启动（装饰层失败不阻断原则）
      try { buildSwitcher() } catch (e) {}
      try { buildWatermark() } catch (e) {}
      try { buildAurora() } catch (e) {}
    }
    refreshSwitcher()
    syncHash()
    notifyPet()
    // 自愈：切换条/标题栏/主题属性/样式层被页面重渲染清掉时自动重建（1s 巡检，切换后无空窗）
    setInterval(function () {
      try { /* 巡检单次失败不影响下一轮 */
      if (!document.getElementById('miasaki-titlebar')) buildTitlebar()
      if (!document.getElementById('miasaki-switcher') && !IS_LOCAL) buildSwitcher()
      if (!document.getElementById('miasaki-close-dialog')) buildCloseDialog()
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
      if (!IS_LOCAL) syncTitlebarGeometry()
      // 最大化状态未知（推送丢失/标题栏重建）→ 10s 间隔经 hash 请求 Rust 重推（本地页同通道）
      if (MAX_STATE === null && document.getElementById('miasaki-titlebar')) requestMaxState()
      } catch (e) { /* keep */ }
    }, 1000)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady)
  } else {
    onReady()
  }
})()
