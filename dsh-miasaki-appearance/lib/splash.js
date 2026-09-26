// @miasaki/dsh-appearance — Boot Splash 首帧启动画（纯逻辑，无运行时依赖）。
//
// 设计：design/2026-09-22-appearance-boot-splash-design.md（2026-09-22 定稿，2026-09-26 实施）。
// 跨线契约：../dsh-miasaki-shared-docs/cross/boot-loading-2026-09-22.md。
//
// 三层注入（都在既有 webserver/index-inject 表内，不新增订阅点）：
//   style(head)  #mia-splash 的样式与动效（含 prefers-reduced-motion 全静止）
//   html (body)  splash 容器 DOM（纹章 + wordmark + 流动三点）
//   script(body) 退场生命周期：主信号 = appearance client 装载；兜底 = MutationObserver
//                 观察 body；超时 = 2.5s 无条件淡出（401/错误页硬用例）
//
// 纪律（与 lib/config.js 的 buildBootScript 同源）：
//   - 产出物是注入进 index.html 的**文本**：style 不得含 `</style`，script 不得含 `</script`；
//   - 首帧脚本任何异常都不得外抛（body placement 的经典 script 抛错会阻断后续注入行与
//     官方 __DSH_BOOT_READY__ 尾巴）；
//   - 总开关关闭或 bootSplash='off' ⇒ 三个函数全返回空串（「关掉即原生」硬契约）。
import { sanitizeConfig } from './config.js'

/** 退场超时（ms）。≥ 桌面壳 loading 正常就绪后的 navigate 时延；401/错误页由它兜底。 */
export const SPLASH_TIMEOUT_MS = 2500

/** 淡出时长（ms）。脚本侧 remove 与样式侧 transition 必须同源。 */
export const SPLASH_FADE_MS = 300

/** splash 容器 id（client 退场钩子与测试都按它找节点）。 */
export const SPLASH_ROOT_ID = 'mia-splash'

/** 退场完成标记（dataset 名；幂等守卫，HMR/双信号只退一次）。 */
export const SPLASH_DONE_FLAG = 'miaSplashDone'

/** 退场函数在全局的名字（client 半经 window 调用）。 */
export const SPLASH_EXIT_NAME = '__miaSplashExit'

/** 纹章外环转速（s）：三主题共用一档，方向按皮肤分。 */
const RING_SECONDS = 24

/**
 * 门控：是否注入 splash。总开关关闭 / bootSplash='off' / 配置非法 ⇒ 不注入。
 * @param {object} config - 任意来源的配置候选（内部会 sanitize）。
 * @returns {boolean} 是否注入。
 */
export function splashEnabled(config) {
  const safe = sanitizeConfig(config)
  return safe.enabled === true && safe.motion.bootSplash !== 'off'
}

/** 纹章内联 SVG（三皮肤同骨架，纯 transform/opacity 动效；零外部资产）。
 *  旋转方向不在 SVG 上体现——由样式按皮肤输出（buildSplashStyle 的 skin 分支）。 */
function emblemSvg() {
  return (
    '<svg class="mia-bs-emblem" viewBox="0 0 96 96" width="96" height="96" aria-hidden="true" focusable="false">' +
    '<circle class="mia-bs-ring" cx="48" cy="48" r="42" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 10" stroke-linecap="round"/>' +
    '<circle class="mia-bs-ring mia-bs-ring-inner" cx="48" cy="48" r="33" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 9" stroke-linecap="round"/>' +
    // 徽记骨架与本线「默认」应用图标同语言（左右短块+长块 + 中央两圆点），品牌一致性。
    '<g fill="currentColor">' +
    '<rect x="29" y="35" width="8" height="8" rx="2"/>' +
    '<rect x="29" y="47" width="8" height="19" rx="2"/>' +
    '<rect x="59" y="35" width="8" height="8" rx="2"/>' +
    '<rect x="59" y="47" width="8" height="19" rx="2"/>' +
    '<circle cx="48" cy="41" r="3.6"/>' +
    '<circle cx="48" cy="56" r="3.6"/>' +
    '</g>' +
    '</svg>'
  )
}

/**
 * splash 样式（head style 行）。
 *
 * **颜色全部走变量继承、不 hardcode**：boot style 把皮肤 token 定义在 `body` 上
 * （`html[data-mia-skin=x] body{…}`），`#mia-splash` 是 body 子节点 ⇒ 直接继承；
 * 明暗由官方 `body[data-ds-dark-theme]` 切换 alias 端点 ⇒ **本行不需要分两段**，
 * 且皮肤在运行期被换掉时启动画跟着变（首帧即当前皮肤，不会先原生后跳）。
 * fallback 字面仅在全链路 CSS 缺失时兜底（官方浅色端 #f5f6f7 / 深色端由 alias 自带）。
 *
 * 踩坑记录（2026-09-26 实施期）：初版从皮肤 token 表取 `--dsw-static-neutral-bluish-950`
 * 当底色——静态色阶是**明度中立**的调色板（M2 §2 已确证），该端恒为最深色，浅色模式下
 * 变成「墨夜底 + 墨夜字」的不可见组合；表里的 6 个半透明 alias 也是两端同值，同样不能
 * 用来推导明暗。能承载明暗语义的只有官方 alias 的**实时值**，故走 var() 继承。
 * @param {object} config - 任意来源的配置候选。
 * @returns {string} CSS 文本；不注入时返回空串。
 */
export function buildSplashStyle(config) {
  if (!splashEnabled(config)) return ''
  const skin = sanitizeConfig(config).theme.skin
  return (
    `#${SPLASH_ROOT_ID}{` +
    '--mia-bs-accent:var(--dsw-static-deepseek-450,#4d6bfe);' +
    '--mia-bs-fg:var(--dsw-alias-label-primary,#1a1a1a);' +
    'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;' +
    'pointer-events:none;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
    'color:var(--mia-bs-accent);background:var(--dsw-alias-bg-base,#f5f6f7);' +
    `transition:opacity ${SPLASH_FADE_MS}ms ease;opacity:1}` +
    `#${SPLASH_ROOT_ID}.mia-bs-out{opacity:0}` +
    '.mia-bs-emblem{display:block;animation:mia-bs-breathe 2.4s ease-in-out infinite;' +
    'filter:drop-shadow(0 0 12px color-mix(in srgb, var(--mia-bs-accent) 45%, transparent))}' +
    `.mia-bs-ring{transform-origin:48px 48px;animation:mia-bs-spin ${RING_SECONDS}s linear infinite}` +
    `.mia-bs-ring-inner{animation:mia-bs-spin ${(RING_SECONDS * 1.7).toFixed(1)}s linear infinite reverse}` +
    (skin === 'kurkuriel' ? '.mia-bs-ring{animation-direction:reverse}.mia-bs-ring-inner{animation-direction:normal}' : '') +
    (skin === 'pure' ? '.mia-bs-ring,.mia-bs-ring-inner{animation:none}' : '') +
    '@keyframes mia-bs-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' +
    '@keyframes mia-bs-breathe{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.06)}}' +
    '.mia-bs-word{color:var(--mia-bs-fg);font-size:20px;font-weight:600;letter-spacing:8px;line-height:28px}' +
    '.mia-bs-tag{color:var(--mia-bs-accent);font-size:12px;letter-spacing:2px;line-height:18px;opacity:.85}' +
    '.mia-bs-dots{display:flex;gap:8px;margin-top:2px}' +
    '.mia-bs-dots i{width:6px;height:6px;border-radius:50%;background:var(--mia-bs-accent);opacity:.25;animation:mia-bs-flow 1.2s ease-in-out infinite}' +
    '.mia-bs-dots i:nth-child(2){animation-delay:.2s}' +
    '.mia-bs-dots i:nth-child(3){animation-delay:.4s}' +
    '@keyframes mia-bs-flow{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-4px)}}' +
    `@media (prefers-reduced-motion: reduce){#${SPLASH_ROOT_ID}{transition:none}` +
    '.mia-bs-emblem,.mia-bs-ring,.mia-bs-ring-inner,.mia-bs-dots i{animation:none}.mia-bs-dots i{opacity:.6}}'
  )
}

/**
 * splash 容器 DOM（body html 行，原样插入——不得含会破坏文档的字符）。
 * @param {object} config - 任意来源的配置候选。
 * @returns {string} HTML 片段；不注入时返回空串。
 */
export function buildSplashHtml(config) {
  if (!splashEnabled(config)) return ''
  return (
    `<div id="${SPLASH_ROOT_ID}" aria-hidden="true">` +
    emblemSvg() +
    '<div class="mia-bs-word">MIASAKI</div>' +
    '<div class="mia-bs-tag">专属 DSH 桌面端</div>' +
    '<div class="mia-bs-dots"><i></i><i></i><i></i></div>' +
    '</div>'
  )
}

/**
 * splash 退场生命周期（body script 行，同步执行）。
 *
 * 双信号 + 超时（设计 §3.2，谁先到谁执行，幂等）：
 *   主信号 —— appearance client 半装载后调 globalThis.__miaSplashExit()；
 *   兜底 —— MutationObserver 观察 document.body：出现 splash 之外的子节点
 *           （React root / 官方 shell 容器）即退场；
 *   超时 —— 2.5s 无条件淡出（401 / 后端异常 / client 迟迟不装载的硬用例）。
 * @returns {string} 脚本文本；调用方负责门控（本函数自身也守一次）。
 */
export function buildSplashScript() {
  return (
    '(function(){try{' +
    `var d=document.documentElement;if(d.dataset.${SPLASH_DONE_FLAG}==='1')return;` +
    'var exit=function(){' +
    `if(d.dataset.${SPLASH_DONE_FLAG}==='1')return;d.dataset.${SPLASH_DONE_FLAG}='1';` +
    `var el=document.getElementById('${SPLASH_ROOT_ID}');` +
    'if(!el)return;' +
    "el.classList.add('mia-bs-out');" +
    // setTimeout 用裸调用（不写 window.）：VM/异常环境下 window 缺失时整段已在 try 里，
    // 但裸名在浏览器与桩环境都可解析——首帧脚本的可用性优先于风格洁癖。
    `setTimeout(function(){el.parentNode&&el.parentNode.removeChild(el)},${SPLASH_FADE_MS + 100});` +
    '};' +
    `globalThis.${SPLASH_EXIT_NAME}=exit;` +
    // 兜底一：body 出现 splash 之外的子节点（shell 挂载的最早 DOM 证据）
    'var obs=new MutationObserver(function(){' +
    `var kids=document.body?document.body.children:[];` +
    "for(var i=0;i<kids.length;i++){if(kids[i].id!=='mia-splash'){obs.disconnect();exit();return}}" +
    '});' +
    "obs.observe(document.documentElement,{childList:true,subtree:true});" +
    // 兜底二：2.5s 无条件退场（错误页/401 不得被 splash 常驻挡住）
    `setTimeout(function(){obs.disconnect();exit()},${SPLASH_TIMEOUT_MS});` +
    '}catch(e){/* 首帧脚本不得抛错：失败就只是没有启动画 */}})()'
  )
}
