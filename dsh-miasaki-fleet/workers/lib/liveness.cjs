// liveness.cjs — worker 心跳判活的唯一口径（F3，2026-09-07）
//
// 问题：此前 `alive` 只判断 `state !== 'stopped'`，完全不看 `heartbeat_at`。
// worker 进程崩溃 / 被杀 / 挂死时，它最后写下的 `status.json` 会永远留在盘上，
// 内容仍是合法的 `state: "running"` —— 于是：
//   · fleet-monitor 面板永远显示它在线、在跑；
//   · publish-pulse 把它计入 running，桌宠因此永远停在「忙碌中…」；
//   · 没有任何告警，因为从数据上看一切正常。
// 每个 manifest 都声明了 `limits.heartbeat_ms`（本机档案普遍 30000），但在本模块
// 之前没有任何代码消费它。这是「陈旧数据比没有数据更危险」的典型情形。
//
// 判定：龄期 = now - heartbeat_at，超过 `heartbeat_ms × STALE_FACTOR` 即为 stale。
// stale 的 running/draining 一律降级为 `unknown`（不可信），不再计入 running。
// 未来时间戳同样按 stale 处理：时钟回拨或跨机复制的档案不可信。
//
// 与消费侧的关系：本模块是 fleet 侧「生产端」判活；桌面端另有 pulse 文件级
// stale 检查（PULSE_STALE_SECS，防发布器自身死亡）。两层各管一段，不重叠。
//
// 写成 CommonJS：消费者一为 ESM（publish-pulse.mjs），一为 CJS
// （fleet-monitor/server.js）。CJS 能被两者共用，反之不行。

'use strict'

/** 心跳容忍倍数：允许错过 3 个周期再判 stale（留足调度抖动与写盘延迟余量）。 */
const STALE_FACTOR = 3

/** manifest 未声明 heartbeat_ms 时的兜底周期。 */
const DEFAULT_HEARTBEAT_MS = 30_000

/** 判活只对「声称在活动」的状态有意义；终态无需心跳背书。 */
const ACTIVE_STATES = new Set(['running', 'draining'])

/**
 * 解析 ISO-8601 时间戳 → epoch 毫秒；不可解析返回 null。
 * 只接受 UTC（`Z` / `+00:00`）：总线里的时间戳恒为 UTC 口径。
 */
function parseTimestamp(ts) {
  if (typeof ts !== 'string' || ts.trim() === '') return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]00:00)$/.test(ts.trim())) return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 判定单个 agent 的心跳新鲜度。
 *
 * @param {object|null} status   该 agent 的 status.json（可为 null）
 * @param {object|null} manifest 该 agent 的 manifest.json（读 limits.heartbeat_ms）
 * @param {number} nowMs         当前 epoch 毫秒（显式传入，便于测试）
 * @returns {{state: string, alive: boolean, stale: boolean, ageMs: number|null, reason: string|null}}
 *   `state` 为**修正后**的状态：stale 的 running/draining 降级为 `unknown`。
 *   `reason` 仅在 stale 时给出，用于面板与日志点名原因。
 */
function evaluateLiveness(status, manifest, nowMs) {
  const rawState = typeof (status && status.state) === 'string' && status.state !== '' ? status.state : null
  if (rawState === null) {
    return { state: 'no-status', alive: false, stale: false, ageMs: null, reason: null }
  }
  // 终态不需要心跳背书：stopped 就是 stopped。
  if (!ACTIVE_STATES.has(rawState)) {
    return { state: rawState, alive: rawState !== 'stopped', stale: false, ageMs: null, reason: null }
  }

  const declared = manifest && manifest.limits ? manifest.limits.heartbeat_ms : undefined
  const period = Number.isFinite(declared) && declared > 0 ? declared : DEFAULT_HEARTBEAT_MS
  const budget = period * STALE_FACTOR
  const beat = parseTimestamp(status && status.heartbeat_at)

  // 声称 running 却没有可解析的心跳 → 不可信（契约要求 running 必带 heartbeat_at）。
  if (beat === null) {
    return { state: 'unknown', alive: false, stale: true, ageMs: null, reason: `${rawState} 但缺少可解析的 heartbeat_at` }
  }
  const ageMs = nowMs - beat
  if (ageMs > budget) {
    return {
      state: 'unknown',
      alive: false,
      stale: true,
      ageMs,
      reason: `${rawState} 但心跳已停 ${Math.round(ageMs / 1000)}s（上限 ${Math.round(budget / 1000)}s）`,
    }
  }
  if (ageMs < -budget) {
    return { state: 'unknown', alive: false, stale: true, ageMs, reason: `heartbeat_at 超前 ${Math.round(-ageMs / 1000)}s，时钟不可信` }
  }
  return { state: rawState, alive: true, stale: false, ageMs, reason: null }
}

module.exports = { STALE_FACTOR, DEFAULT_HEARTBEAT_MS, parseTimestamp, evaluateLiveness }
