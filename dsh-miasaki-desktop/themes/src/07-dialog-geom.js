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

