/* 11-console.js — 渲染层 console 错误旁路（W2 收尾，2026-09-25）
 *
 * 为什么需要：诊断报告的 `--- renderer console (error level, oldest first) ---` 段此前
 * **恒为空** —— Rust 侧的 `diag::push_console_line` 与 `#[tauri::command] diag_console`
 * 早已就位，但没有任何写者。而 `design/TODO.md` 里那个挂了半个月的 P0（偶发「全黑无响应」）
 * 恰恰是**渲染层**的异常：挂起/崩溃前最后的 console.error 往往就是唯一线索。
 *
 * 三条纪律：
 *   ① **只旁路，不改变**：先原样调用原生 `console.error`，再记录 —— 页面的错误可见性与
 *      行为一个字节都不变（记录步骤整体 try/catch，记录失败绝不影响原调用）；
 *   ② **只顶层 frame**：`initialization_script` 注入每个文档，SSH / 画布 iframe 也会被注入，
 *      若子 frame 也上报会把同一批错误重复灌进报告；
 *   ③ **有界 + 节流**：环形缓冲（50 条 / 16 KiB 上限，超出丢最旧），2s 批量推送一次 ——
 *      错误风暴不得把 IPC 或内存打满。
 *
 * 通道：`window.__TAURI__.core.invoke('diag_console', { lines })`。
 * 远程页 IPC 由 `capabilities/remote-dsh.json` 放行（与已有 `start_dragging` 同一份能力声明）；
 * 非壳环境（浏览器直开）没有 `__TAURI__`，静默跳过 —— 本分片在 web 下是零副作用。
 */
;(function () {
  'use strict'

  // 只顶层 frame：初次判断失败（跨源异常）按子 frame 处理（宁可不报，不要重复报）
  var IS_TOP = true
  try { IS_TOP = window.top === window } catch (e) { IS_TOP = false }
  if (!IS_TOP) return
  if (window.__MIASAKI_CONSOLE_HOOKED__) return
  window.__MIASAKI_CONSOLE_HOOKED__ = true

  var MAX_LINES = 50
  var MAX_CHARS = 16384
  var SINGLE_LINE_MAX = 2000
  var FLUSH_MS = 2000

  var buf = []
  var chars = 0
  var timer = null

  function safeString(value) {
    try {
      if (value === null || value === undefined) return String(value)
      if (typeof value === 'string') return value
      // 用**形状判定**而非 `instanceof Error`：跨 realm（iframe 传进来的错误、VM 测试环境）
      // 与原型的 realm 不同，`instanceof` 会漏判，最终把 Error 序列化成 `{}`（信息全丢）。
      if (typeof value === 'object' && typeof value.stack === 'string') {
        return value.stack || value.message || '[error]'
      }
      var json = JSON.stringify(value)
      return json === undefined ? String(value) : json
    } catch (e) {
      return '[unserializable]'
    }
  }

  // 与 `00-boot.js` 红条同一判据的噪声过滤：Chrome/WebView2 在 ResizeObserver 回调引起布局
  // 变化时会产出 "ResizeObserver loop completed with undelivered notifications."
  // （Firefox 措辞 "ResizeObserver loop limit exceeded"）—— 这是**浏览器调度产物、不是脚本
  // 错误**。红条已过滤（00-boot.js 2026-09-25 修复），诊断报告同样不该被它淹没：
  // 报告的价值在"挂起前最后发生了什么"，灌满同一条噪声等于没有报告。
  var SCHEDULER_NOISE = /^ResizeObserver loop (completed with undelivered notifications\.|limit exceeded\.?)$/

  /** 去掉来源前缀后再判噪声（前缀会让正则失配）。 */
  function isSchedulerNoise(s) {
    var body = s.replace(/^\[uncaught\]\s*/, '').replace(/^\[unhandledrejection\]\s*/, '')
    return SCHEDULER_NOISE.test(body.trim())
  }

  function push(line) {
    var s = String(line === null || line === undefined ? '' : line)
    if (s.replace(/\s/g, '') === '') return
    if (isSchedulerNoise(s)) return
    if (s.length > SINGLE_LINE_MAX) s = s.slice(0, SINGLE_LINE_MAX) + '…'
    buf.push(s)
    chars += s.length
    while (buf.length > MAX_LINES || chars > MAX_CHARS) {
      if (buf.length === 0) break
      chars -= buf.shift().length
    }
    schedule()
  }

  function schedule() {
    if (timer !== null) return
    try {
      timer = setTimeout(flush, FLUSH_MS)
    } catch (e) {
      timer = null
    }
  }

  function flush() {
    timer = null
    if (buf.length === 0) return
    var lines = buf.slice()
    buf = []
    chars = 0
    try {
      var t = window.__TAURI__
      if (t && t.core && t.core.invoke) {
        t.core.invoke('diag_console', { lines: lines }).catch(function () {})
      }
    } catch (e) { /* 非壳环境：静默 */ }
  }

  // ① 旁路 console.error（保留原生调用）
  try {
    var origError = console.error
    console.error = function () {
      try { origError.apply(console, arguments) } catch (e) { /* 原生都失败了，记录照旧 */ }
      try {
        var parts = []
        for (var i = 0; i < arguments.length; i++) parts.push(safeString(arguments[i]))
        push(parts.join(' '))
      } catch (e) { /* 记录失败绝不影响原调用 */ }
    }
  } catch (e) { /* console 不可改（极端环境）：放弃旁路 */ }

  // ② 未捕获错误 / 未处理的 Promise 拒绝也进缓冲 —— 挂起前最后的信息常在这里
  try {
    window.addEventListener('error', function (e) {
      try {
        push('[uncaught] ' + safeString(e && (e.message || e.type)))
      } catch (e2) { /* ignore */ }
    })
    window.addEventListener('unhandledrejection', function (e) {
      try {
        push('[unhandledrejection] ' + safeString(e && e.reason))
      } catch (e2) { /* ignore */ }
    })
  } catch (e) { /* ignore */ }
})()
