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
 *   ② **写能力一律"派发内部事件、由寄生分片执行"，契约自己不碰 `location.hash`**（v1.1 起）：
 *      本壳的 hash 写者只有两个（`02-core.syncHash` 与 `05-sensors.petHashCmd`）；在契约里
 *      直接实现一套写通道会立刻造出**第三个写者**——正是 W0-T0.2 刚修掉的竞态。
 *      `theme.set` / `window.controls` 因此只 `dispatchEvent`（`miasaki-theme-set` /
 *      `miasaki-window-command`），落到 `02-core` / `06-titlebar` 执行。**新增写能力照此办理**；
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

  /* ---------- v1.2 壳 chrome 几何（2026-09-27）----------
   *
   * 由来（2026-09-27 全线审查 §4-①）：窗控按钮组是**零占位浮层**，右上角那一带同时被
   * 三方使用——sidebar 往组里插按钮、canvas / ssh 各自量宽度做避让、壳自己用
   * `--ms-titlebar-reserve` 给官方控件让位。三方**同一个事实三种取数**（量 DOM / 读变量 /
   * 硬编码常量），且 canvas 还写死了「宽度固定，无需监听」这个已被 sidebar 注入打破的前提。
   *
   * 本能力把那个事实收敛成一个**只读**接口（壳说事实、插件选分支，与 12-material 的
   * `data-mia-native-mica` 同一分工）：**只给矩形，避让量由各插件自己算**——
   * 它们的呼吸位不同（canvas 6px、ssh 6+8px），壳无权替它们决定。
   *
   * 边界：① 不提供官方 DSH chrome 的位置（那是官方资产，ssh 自己量，见其口径②）；
   *      ② 子 frame 不暴露（纪律③）——canvas / ssh 都是**主帧量、iframe 消费**
   *      （canvas/client.js 的 `canvas:chrome`、ssh 的 `--ssh-chrome-reserve` 下发），无需开口子。
   *
   * 已知限制：订阅那一刻 `.tb-group` 必须已存在 —— `ResizeObserver` 只报**被观察元素自身**的盒子，
   * 而 `#miasaki-titlebar` 是 `height:0` + 全宽的容器（观察它拿不到按钮增减）。实机路径成立：
   * 本分片在 `DOMContentLoaded` 就建好标题栏，插件 client 装载更晚；且消费侧都有重量兜底
   * （canvas 在 open/onFrameLoad 重量、ssh 另有 rootObserver）。
   */
  var TB_SELECTOR = '#miasaki-titlebar .tb-group'

  /** 壳窗控按钮组在视口坐标下的矩形；量不到（无按钮组 / 本地页未建 / 无 API）返回 null。 */
  function chromeBounds() {
    try {
      var el = document.querySelector(TB_SELECTOR)
      if (!el || typeof el.getBoundingClientRect !== 'function') return null
      var r = el.getBoundingClientRect()
      if (!r || !(r.width > 0)) return null
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    } catch (e) { return null }
  }

  /**
   * 订阅壳窗控组尺寸/位置变化（`ResizeObserver`；sidebar 插入终端键、窗控键增减都会触发）。
   * 回调收到最新 `chromeBounds()`（可能为 null）。返回退订函数；环境不支持时返回空退订。
   */
  function onChromeChange(cb) {
    if (typeof cb !== 'function') return function () {}
    try {
      var el = document.querySelector(TB_SELECTOR)
      if (!el || typeof ResizeObserver !== 'function') return function () {}
      var ro = new ResizeObserver(function () {
        try { cb(chromeBounds()) } catch (e) { /* 订阅者异常不影响派发方 */ }
      })
      ro.observe(el)
      return function () { try { ro.disconnect() } catch (e) {} }
    } catch (e) { return function () {} }
  }

  var CAPABILITIES = [
    'theme.current', 'theme.onChange', 'theme.set',
    'window.maxState.subscribe', 'window.controls',
    'chrome.bounds', 'chrome.onChange',
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
    // v1.2：壳 chrome 几何（只读 + 订阅；见上方 §v1.2 注释）
    chrome: { bounds: chromeBounds, onChange: onChromeChange },
    assets: { baseUrl: ASSET_BASE }
  }

  // 子 frame / 非产品页只给空壳（与官方"能力按 frame 降级"一致）
  var shell = { protocolVersion: PROTOCOL_VERSION, isDesktop: true, isLocalPage: IS_LOCAL }

  try { window.miasakiDesktop = IS_TOP ? full : shell } catch (e) { /* 极端环境（无 window）静默 */ }
})()
