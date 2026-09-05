
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

