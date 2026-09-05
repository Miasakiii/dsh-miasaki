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
    // 空白拖动判定（document 级捕获，页面零占位后由它接管拖窗）
    try { wireDragZone() } catch (e) {}
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
