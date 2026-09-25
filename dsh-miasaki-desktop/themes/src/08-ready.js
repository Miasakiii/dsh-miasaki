  /* ---------- 启动 ---------- */
  setAttr(current)
  // 窗口级 chrome 只在顶层 frame 构建：Tauri initialization_script 会注入所有
  // frame（WebView2 行为），SSH/画布等 iframe 里若也构建，页面右上会浮一套假
  // 窗控、右下浮一颗假主题球（2026-09-12 用户反馈的「两套窗控/多一颗球」即此
  // 因）。主题属性与样式层各 frame 照常，不受影响。
  var IS_TOP = true
  try { IS_TOP = window.top === window } catch (e) { IS_TOP = false }
  function onReady() {
    setAttr(current)
    ensureStyle()
    if (styleEl) styleEl.textContent = styleFor(current)
    syncDark()
    startObserver()
    startYieldObserver() // M2 S6：appearance 门控属性翻转时机（让位/恢复）
    try { localStorage.setItem(KEY, current) } catch (e) { /* ignore */ }
    var base = ensureBase()
    base.textContent = SWITCHER_CSS
    // 关闭确认弹窗无条件构建（本地唤醒页同样需要：Alt+F4 走系统关闭路径 + 弹窗确认）
    try { buildCloseDialog() } catch (e) {}
    if (IS_TOP) {
      // 标题栏本地/远程页均构建（本地页同样需要拖动区与窗口按钮）；子 frame 跳过
      try { buildTitlebar() } catch (e) {}
      // 最大化状态同步本地/远程页均需要（Rust eval 派发的 CustomEvent 两页同源）
      try { wireMaxState() } catch (e) {}
    }
    // 空白拖动判定（document 级捕获，页面零占位后由它接管拖窗）
    try { wireDragZone() } catch (e) {}
    if (!IS_LOCAL) {
      // 装饰层逐一隔离：单个构建异常不得中断后续构建与巡检启动（装饰层失败不阻断原则）
      if (IS_TOP) { try { buildSwitcher() } catch (e) {} }
      try { buildWatermark() } catch (e) {}
      try { buildAurora() } catch (e) {}
    }
    refreshSwitcher()
    // W4.3：首帧也报一次窗口底色（此前 apply() 未跑过时 CUR_BG 为空）
    CUR_BG = resolveNativeBg()
    syncHash(true) // 启动首帧强制重算 diag（后续按 DIAG_MIN_INTERVAL_MS 节流）
    // 自愈：切换条/标题栏/主题属性/样式层被页面重渲染清掉时自动重建（1s 巡检，切换后无空窗）
    setInterval(function () {
      try { /* 巡检单次失败不影响下一轮 */
      if (IS_TOP && !document.getElementById('miasaki-titlebar')) buildTitlebar()
      if (IS_TOP && !document.getElementById('miasaki-switcher') && !IS_LOCAL) buildSwitcher()
      if (!document.getElementById('miasaki-close-dialog')) buildCloseDialog()
      if (!document.getElementById('miasaki-aurora') && !IS_LOCAL) buildAurora()
      if (document.documentElement.getAttribute('data-miasaki-theme') !== current) setAttr(current)
      ensureStyle()
      ensureBase()
      if (baseEl && baseEl.textContent !== SWITCHER_CSS) {
        baseEl.textContent = SWITCHER_CSS
      }
      if (styleEl && styleEl.textContent !== styleFor(current)) {
        styleEl.textContent = styleFor(current)
      }
      syncDark()
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
