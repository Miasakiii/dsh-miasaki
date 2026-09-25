/* 10-contract.js — 桌面壳 ↔ 渲染层契约 v1（W1-T1.2，2026-09-25）
 *
 * 为什么需要它：七线插件目前各自"猜环境"——靠 UA、靠 `window.__TAURI__` 是否存在、
 * 靠某个 DOM 节点在不在。壳与页面之间没有**有版本号、可探测、可降级**的能力面。
 * 官方 Electron 桌面端的做法是 `window.dshDesktop`（`protocolVersion: 1`，且只在产品
 * origin 的主帧暴露真身、其它 frame 只给空壳）——本分片对齐该语义，命名用本项目自己的
 * `miasakiDesktop`，避免与官方将来可能引入的同名对象冲突。
 *
 * 设计纪律（三条，改本文件前先读）：
 *   ① **只暴露确实实现的能力**：能力表即事实，不写"将来会有"的占位；
 *   ② **只读 + 订阅，不提供写通道**：本壳的写通道（窗控命令 / 主题切换 / 拖窗）已经有
 *      既有实现（hash 字段协议，见 05-sensors.js 的 petHashCmd 与 02-core.js 的 syncHash）。
 *      在这里再实现一套写通道会立刻造出**第三个 hash 写者**——正是 W0-T0.2 刚修掉的竞态。
 *      需要写能力的插件请走既有通道（标题栏按钮 / hash 协议），不要在契约里开新口子；
 *   ③ **子 frame 只给空壳**：initialization_script 会注入每个文档（08-ready.js:3-8 有
 *      实机教训：iframe 里也建了一套假窗控），因此 SSH / 画布 iframe 必须只拿到
 *      `{ protocolVersion, isDesktop, isLocalPage }`，不得拿到能力对象。
 *
 * 消费方式（插件侧建议写法，与官方"桌面端缺失则回落 web 实现"同构）：
 *     var d = window.miasakiDesktop
 *     if (d && d.has && d.has('theme.onChange')) { ... } else { 走 web 兜底路径 }
 */
;(function () {
  'use strict'

  var PROTOCOL_VERSION = 1
  var THEME_ATTR = 'data-miasaki-theme'
  var THEMES = ['pure', 'zafkiel', 'kurkuriel']
  // 素材服务的基址（main.rs 起在 39800，白名单仅 pets|icons）。此前 04-deco.js:96 内联
  // 硬编码同一地址——契约把它公开出来，插件不必再抄一遍端口。
  var ASSET_BASE = 'http://127.0.0.1:39800/'

  // 与 02-core.js:85 同一判据（Windows 上 Tauri 2 本地页是 http://tauri.localhost）
  var IS_LOCAL = false
  try { IS_LOCAL = location.protocol === 'tauri:' || /^tauri\.localhost$/i.test(location.hostname || '') } catch (e) {}
  var IS_TOP = true
  try { IS_TOP = window.top === window } catch (e) { IS_TOP = false }

  function currentTheme() {
    try {
      var v = document.documentElement && document.documentElement.getAttribute(THEME_ATTR)
      return THEMES.indexOf(v) >= 0 ? v : null
    } catch (e) { return null }
  }

  /** 订阅主题变更（基于属性观察，不依赖任何内部闭包状态）。返回退订函数。 */
  function onThemeChange(cb) {
    if (typeof cb !== 'function') return function () {}
    try {
      var obs = new MutationObserver(function () { cb(currentTheme()) })
      obs.observe(document.documentElement, { attributes: true, attributeFilter: [THEME_ATTR] })
      return function () { try { obs.disconnect() } catch (e) {} }
    } catch (e) { return function () {} }
  }

  /** 订阅最大化状态（Rust 侧 eval 派发 CustomEvent `miasaki-max-state`，见 06-titlebar.js:33-43）。 */
  function onMaxStateChange(cb) {
    if (typeof cb !== 'function') return function () {}
    var handler = function (e) {
      try { cb(!!(e && e.detail && e.detail.max)) } catch (e2) { /* 订阅者异常不影响派发方 */ }
    }
    try { window.addEventListener('miasaki-max-state', handler) } catch (e) { return function () {} }
    return function () { try { window.removeEventListener('miasaki-max-state', handler) } catch (e) {} }
  }

  /* ---------- v1.1 受控写能力（2026-09-25）----------
   *
   * 纪律：契约**自己不开写通道**。窗控与主题切换都走「派发内部事件 → 由寄生分片执行」——
   * 这样 `location.hash` 仍只有 `05-sensors.petHashCmd` 与 `02-core.syncHash` 两个写者，
   * 不会多出第三个（那正是 W0-T0.2 刚修掉的竞态）。
   *
   * **双向校验**：契约侧白名单（且只暴露 `minimize`/`maximize`/`close` 这种人话名，
   * 不把内部协议名 `min`/`max` 透出去），执行侧（寄生分片）**再校验一次** ——
   * 事件可被任意页面脚本派发，不能只靠发起方自觉。
   *
   * **返回值语义**：`true` = 已派发，**不代表已生效**。Rust 侧按 33ms 轮询消费命令并按
   * `seq` 去重；需要确认结果请订阅既有回执通道（如 `window.onMaxStateChange`）。
   */
  var CONTROL_NAMES = ['minimize', 'maximize', 'close']

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }))
      return true
    } catch (e) {
      return false
    }
  }

  /** 切换主题；非法名返回 false（不派发）。 */
  function setTheme(name) {
    if (THEMES.indexOf(name) < 0) return false
    return emit('miasaki-theme-set', { theme: name })
  }

  /** 窗控命令；非法名返回 false（不派发）。 */
  function windowControl(name) {
    if (CONTROL_NAMES.indexOf(name) < 0) return false
    return emit('miasaki-window-command', { command: name })
  }

  var CAPABILITIES = [
    'theme.current', 'theme.onChange', 'theme.set',
    'window.maxState.subscribe', 'window.controls',
    'assets.baseUrl'
  ]

  var full = {
    protocolVersion: PROTOCOL_VERSION,
    isDesktop: true,
    isLocalPage: IS_LOCAL,
    capabilities: CAPABILITIES.slice(),
    has: function (name) { return CAPABILITIES.indexOf(name) >= 0 },
    theme: { current: currentTheme, onChange: onThemeChange, set: setTheme },
    window: {
      onMaxStateChange: onMaxStateChange,
      controls: {
        minimize: function () { return windowControl('minimize') },
        maximize: function () { return windowControl('maximize') },
        close: function () { return windowControl('close') }
      }
    },
    assets: { baseUrl: ASSET_BASE }
  }

  // 子 frame / 非产品页只给空壳（与官方"能力按 frame 降级"一致）
  var shell = { protocolVersion: PROTOCOL_VERSION, isDesktop: true, isLocalPage: IS_LOCAL }

  try { window.miasakiDesktop = IS_TOP ? full : shell } catch (e) { /* 极端环境（无 window）静默 */ }
})()
