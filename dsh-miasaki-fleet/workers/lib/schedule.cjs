// schedule.cjs — P2-D（2026-10-21）：定时任务语义（无常驻 daemon）
//
// 为什么存在：fleet 没有调度器。设计采用 Cherry A6 的「搬语义不搬 daemon」：
//   · `state/schedules.json` 是**唯一真相**（Operator/Commander 经 bus-apply 写）；
//   · `workers/scheduler/enqueue-due.mjs` 是**一次性 CLI**：由外部触发器（Windows 任务计划 /
//     手动 / 未来 DSH 定时插件）周期调用，把到期 schedule 转成 queued 任务；
//   · **幂等**：`next_fire_at` 只在一次超步里推进（任务行 + schedules 更新原子提交），
//     同一时刻重复调用不会重复建任务；错过的窗口只补一次（不雪崩补跑）。
//
// 纯函数集中在写文件，CLI 只做 IO 与 bus-apply 调用（判定单点，便于单测）。

'use strict'

const MIN_INTERVAL_SECONDS = 60
const SCHEDULE_ID_RE = /^s-[a-z0-9-]+$/

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isNonEmptyStr(v) {
  return typeof v === 'string' && v.trim() !== ''
}

/** 解析 ISO 时间；失败返回 null（不猜）。 */
function parseTime(v) {
  if (!isNonEmptyStr(v)) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function toIso(ms) {
  return new Date(ms).toISOString()
}

/**
 * 计算「下一次触发时刻」：严格晚于 `fromMs`。
 * 若 `fromMs` 已远超原计划（错过的窗口），**只补一次**：下一次 = 实际触发时刻 + interval。
 */
function nextFireAt(fromMs, intervalSeconds) {
  return toIso(fromMs + intervalSeconds * 1000)
}

/**
 * 校验 schedules 文档。
 * @returns {{ok: boolean, problems: Array<{where: string, message: string}>}}
 */
function validateSchedules(doc) {
  const problems = []
  const err = (where, message) => problems.push({ where, message })
  if (!isObj(doc)) { err('$', 'schedules 应为 object'); return { ok: false, problems } }
  if (doc.version !== 1) err('$.version', `version 非法: ${doc.version}（应为 1）`)
  if (!Array.isArray(doc.schedules)) { err('$.schedules', 'schedules 应为 array'); return { ok: false, problems } }

  const ids = new Set()
  doc.schedules.forEach((s, i) => {
    const w = `$.schedules[${i}]`
    if (!isObj(s)) { err(w, '应为 object'); return }
    if (!isNonEmptyStr(s.id) || !SCHEDULE_ID_RE.test(s.id)) err(`${w}.id`, `id 非法: ${JSON.stringify(s.id)}（应形如 s-daily-check）`)
    else if (ids.has(s.id)) err(`${w}.id`, `id 重复: ${s.id}`)
    else ids.add(s.id)
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') err(`${w}.enabled`, 'enabled 应为 boolean')
    if (!Number.isFinite(s.interval_seconds) || s.interval_seconds < MIN_INTERVAL_SECONDS) {
      err(`${w}.interval_seconds`, `interval_seconds 必须 ≥ ${MIN_INTERVAL_SECONDS}`)
    }
    if (parseTime(s.next_fire_at) === null) err(`${w}.next_fire_at`, 'next_fire_at 必须是 ISO 时间')
    if (s.last_fired_at !== null && s.last_fired_at !== undefined && parseTime(s.last_fired_at) === null) {
      err(`${w}.last_fired_at`, 'last_fired_at 必须是 ISO 时间或 null')
    }
    if (s.fire_count !== undefined && (!Number.isInteger(s.fire_count) || s.fire_count < 0)) err(`${w}.fire_count`, 'fire_count 应为非负整数')
    if (!isObj(s.task)) err(`${w}.task`, 'task 应为 object（title/assignee 必填）')
    else {
      if (!isNonEmptyStr(s.task.title)) err(`${w}.task.title`, 'title 缺失')
      if (!isNonEmptyStr(s.task.assignee)) err(`${w}.task.assignee`, 'assignee 缺失')
      if (s.task.brief !== undefined && typeof s.task.brief !== 'string') err(`${w}.task.brief`, 'brief 应为 string')
    }
  })
  return { ok: problems.length === 0, problems }
}

/**
 * 取到期 schedule（enabled 且 next_fire_at <= now），按 next_fire_at 升序，最多 max 个。
 * @param {number} nowMs
 * @param {number} [max=5]
 */
function dueSchedules(doc, nowMs, max) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 5
  if (!isObj(doc) || !Array.isArray(doc.schedules)) return []
  return doc.schedules
    .filter((s) => isObj(s) && s.enabled !== false && parseTime(s.next_fire_at) !== null && parseTime(s.next_fire_at) <= nowMs)
    .sort((a, b) => parseTime(a.next_fire_at) - parseTime(b.next_fire_at))
    .slice(0, limit)
}

/**
 * 推进一个 schedule（纯函数）：触发一次后的新对象。
 * 错过多个窗口时只补一次 —— next = firedAt + interval（不是原 next + interval）。
 */
function advanceSchedule(s, firedAtMs) {
  const interval = s.interval_seconds
  return Object.assign({}, s, {
    last_fired_at: toIso(firedAtMs),
    fire_count: (Number.isInteger(s.fire_count) ? s.fire_count : 0) + 1,
    next_fire_at: nextFireAt(firedAtMs, interval),
  })
}

/** 取文档中所有 schedule id（Operator/CLI 用）。 */
function listScheduleIds(doc) {
  return (isObj(doc) && Array.isArray(doc.schedules)) ? doc.schedules.map((s) => s && s.id).filter(isNonEmptyStr) : []
}

module.exports = {
  MIN_INTERVAL_SECONDS,
  SCHEDULE_ID_RE,
  parseTime,
  toIso,
  nextFireAt,
  validateSchedules,
  dueSchedules,
  advanceSchedule,
  listScheduleIds,
}
