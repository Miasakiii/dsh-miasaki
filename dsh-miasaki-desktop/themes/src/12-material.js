/* 12-material.js — 原生材质事实的落地（W4.2 材质分层，2026-09-25）
 *
 * ## 解决什么
 *
 * 外观线的玻璃档位 `mica` 语义是「用系统云母」，但它的实现是页面侧
 * `backdrop-filter: blur(40px) saturate(1.6)`。在 Win11 上原生 Mica 同时生效 ⇒
 * Chromium 的模糊叠在 DWM 材质之上 = **两层模糊**：更糊、更耗电，而且与
 * 「用系统云母」这个语义自相矛盾（也正是外观线自己文档里标注"web 近似"的由来）。
 *
 * ## 分工：壳说事实，页面选分支
 *
 *   · 壳：`initialization_script` 前缀给**预判值**（Win11 且未设 `MIASAKI_NO_MICA` ⇒ true），
 *         页面就绪后（600ms）用 DWM 的**实际结果**广播修正 `miasaki-native-material`；
 *   · 本分片：把事实落到 `html[data-mia-native-mica="on|off"]`；
 *   · 外观线：`mica` 档的玻璃规则挂在 `:not([data-mia-native-mica="on"])` 上 ——
 *         原生生效时不加页面侧模糊，只留 alpha tint。
 *
 * ## 为什么属性要尽早落
 *
 * 外观线的 boot style 写在 index.html 文本里（**解析期**生效），而本分片在
 * `document_start` 就跑（`initialization_script`）—— 比解析期更早。因此外观线那条
 * `:not(...)` 选择器在**首帧**就能命中正确分支，不存在"先叠一层再撤"的过渡闪烁。
 * 预判只在 DWM 实际拒绝材质时失准，那种情况由广播在 600ms 内修正。
 *
 * ## 纪律
 *
 * ① 不做材质决策，只搬运事实（选分支是外观线的事，两者不共享配置）；
 * ② 拿不到预判值一律按 `off` —— **保守**：宁可让页面侧玻璃兜住视觉，也不要出现
 *    "以为有原生材质、结果什么都没有"的裸窗口；
 * ③ 全程 try/catch：本分片在 document_start 跑，抛错会污染页面最早期的执行。
 */
;(function () {
  'use strict'

  var ATTR = 'data-mia-native-mica'

  function apply(mica) {
    try {
      var root = document.documentElement
      if (root) root.setAttribute(ATTR, mica ? 'on' : 'off')
    } catch (e) { /* 极端环境（无 documentElement）静默 */ }
  }

  // ① 首帧：壳给的预判值（缺失或非 true 一律按 off）
  try {
    apply(window.__MIA_NATIVE_MICA__ === true)
  } catch (e) { /* ignore */ }

  // ② 修正：壳在页面就绪后广播 DWM 的实际结果
  try {
    window.addEventListener('miasaki-native-material', function (e) {
      try {
        apply(!!(e && e.detail && e.detail.mica))
      } catch (e2) { /* ignore */ }
    })
  } catch (e) { /* ignore */ }
})()
