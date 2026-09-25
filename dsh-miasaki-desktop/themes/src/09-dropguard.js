// 桌面端拖放安全网（design/drag-drop-attachment-upload.md §4.2，最小档）。
//
// 背景：main.rs 主窗 .disable_drag_drop_handler() 后，WebView2 原生 HTML5 拖放直达
// 页面，官方 ComposerAttachments 的 document 级 DnD 在**对话视图**照常工作；但其余
// 页面（轨迹 / 用量 / 设置）以及本地启动页没有官方处理器，drop 落空会触发浏览器默认
// 行为 = 导航到拖入的 file:// 路径，DSH SPA 被整体换掉（白屏、无恢复入口）。
//
// 本片只兜底，不抢官能：
//   · dragover 一律 preventDefault——不阻止则 drop 根本不触发（浏览器口径）；
//     官方遮罩的 dropEffect 由官方自己设置，此处不干预；
//   · drop 只认文件拖放（dataTransfer.types 含 Files）——拖选中文本 / 链接完全不碰，
//     与官方同一判据；
//   · 官方已消费（defaultPrevented）的 drop 原样放行——同 target 同 phase 的其余监听
//     仍会收到事件，精准让位、不破坏遮罩与 onAddFiles；
//   · 最小档静默阻止（完整体验档的 1.5s 轻提示按设计 §4.2 留待实机反馈后再评）。
//
// 形态：自包含 IIFE（本片在 08-ready.js 闭合大 IIFE 之后拼接，不共享其作用域）；
// 全部副作用即监听器本身，无常驻状态、无定时器，随页面卸载自然消失。
;((function () {
  var isFileDrag = function (e) {
    try {
      return !!(e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1)
    } catch (err) { return false }
  }
  var stop = function (e) {
    if (e.cancelable) e.preventDefault()
  }
  document.addEventListener('dragover', stop, false)
  document.addEventListener('drop', function (e) {
    if (!isFileDrag(e)) return
    if (e.defaultPrevented) return
    stop(e)
  }, false)
})())
