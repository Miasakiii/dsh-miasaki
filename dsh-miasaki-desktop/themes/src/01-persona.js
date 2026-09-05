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

