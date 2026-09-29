// 准入判定 —— 本体补丁与本插件的**共享契约**，抽成纯函数以便单测。
//
// 背景（这条链的失效模式）：
//   本体补丁在用户提交带图消息时调用 `dualModelVisionRoute.for(agent)`：
//     · 返回路由 → 接管图片准入（union 语义：辅助模型或主模型任一能看图就放行）
//     · 返回 undefined → 走官方原生分支（主模型不支持图就抛 MODEL_DOES_NOT_SUPPORT_IMAGES）
//
//   而"图片最终由谁处理"由路由侧 `decideRoute` 决定，它的判据里有一条
//   `hasImage`（来自 `agent/pre-step` 实测）。**两条判据来源不同**：
//     · 准入只看「是否启用 + 是否配置了辅助模型」
//     · 路由还要看「本步是否真的处于图片上下文」
//
//   于是存在这条静默失效链：准入放行 → 但 pre-step 没挂上（attach 失败）或判定抛错
//   → `hasImage` 为 false → `keep`（不切辅助模型）→ **图片发给不支持图的主模型，全程零信号**。
//
// 本模块把「准入」收紧到与「路由」同源：**只有图片执行通道确实建立时才接管控入**。
// 通道没建好时不接管，本体走原生分支给出**可见的**拒绝（"Model X does not support image input"）——
// 可见的失败优于静默的错误，这也是本仓 `check-silent-guards` 闸门的一贯口径。

import { normalizeRoute } from './routing.js'

/**
 * 判断是否接管控入，并给出接管用的图片执行路由。
 *
 * @param {object} input - 判定输入。
 * @param {boolean} input.enabled - 双模型总开关。
 * @param {{ provider?: unknown, model?: unknown } | undefined} input.assist - 辅助模型配置。
 * @param {boolean} input.channelReady - 该 agent 的图片执行通道是否已建立
 *   （即 `agent/pre-step` 与 `agent/request` 两个监听都已成功挂上）。
 * @returns {{ provider: string, model: string } | undefined} 接管时返回路由；不接管返回 `undefined`。
 */
export function decideAdmission(input) {
  const { enabled, assist, channelReady } = input
  if (enabled !== true) return undefined
  const route = normalizeRoute(assist)
  if (route === undefined) return undefined
  // 关键分支：通道未建立时**不接管**。
  // 接管意味着"图交给辅助模型"，但通道没建好就切不了模型 —— 那样放行等于丢图。
  if (channelReady !== true) return undefined
  return route
}

/**
 * 图片上下文判定的失败策略。
 *
 * `agent/pre-step` 里读图失败（`deriveAgentMessages` 抛错、消息形状异常）时，
 * **不能默认「无图」**：准入已经按"有图"放行了，路由再判成"无图"就是上面的失效链。
 * 保守取 `true` —— 多切一次辅助模型的代价（轻微 prompt cache 影响）远小于丢一张图。
 *
 * @param {unknown} error - 捕获到的异常（仅用于留痕，不参与判定）。
 * @returns {true} 恒为 `true`（保守策略的显式表达，便于调用点与测试直接断言）。
 */
export function imageContextOnFailure(error) {
  // 留痕但不抛：pre-step 是 waterfall，抛错会打断整步。
  console.warn('[dual-model] 图片上下文判定失败，保守按「有图」处理（避免静默丢图）', error)
  return true
}
