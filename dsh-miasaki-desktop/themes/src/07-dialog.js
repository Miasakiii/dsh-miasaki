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
