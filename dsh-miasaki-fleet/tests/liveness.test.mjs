// liveness.test.mjs — F3 心跳判活单测（本线首个自动化测试，2026-09-07）
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_HEARTBEAT_MS,
  STALE_FACTOR,
  evaluateLiveness,
  parseTimestamp,
} from '../workers/lib/liveness.mjs'

const NOW = Date.parse('2026-09-07T12:00:00Z')
/** 本机档案普遍声明 30s 心跳。 */
const manifest = { limits: { heartbeat_ms: 30_000 } }
/** 预算 = 30s × 3 = 90s。 */
const BUDGET_MS = 30_000 * STALE_FACTOR

const at = offsetMs => new Date(NOW - offsetMs).toISOString()

test('parseTimestamp 只接受 UTC 形式', () => {
  assert.equal(parseTimestamp('2026-09-07T12:00:00Z'), NOW)
  assert.equal(parseTimestamp('2026-09-07T12:00:00.500Z'), NOW + 500)
  assert.equal(parseTimestamp('2026-09-07T12:00:00+00:00'), NOW)
  // 带真实偏移 / 缺 T / 空 / 非字符串一律拒绝
  assert.equal(parseTimestamp('2026-09-07T12:00:00+08:00'), null)
  assert.equal(parseTimestamp('2026-09-07 12:00:00'), null)
  assert.equal(parseTimestamp(''), null)
  assert.equal(parseTimestamp(null), null)
  assert.equal(parseTimestamp(undefined), null)
})

test('新鲜心跳的 running 正常计入', () => {
  const live = evaluateLiveness({ state: 'running', heartbeat_at: at(10_000) }, manifest, NOW)
  assert.equal(live.state, 'running')
  assert.equal(live.alive, true)
  assert.equal(live.stale, false)
  assert.equal(live.reason, null)
})

test('心跳过龄的 running 降级为 unknown —— 崩溃的 worker 不能永远显示在跑', () => {
  // 边界内：正好 89s 仍算新鲜
  const edge = evaluateLiveness({ state: 'running', heartbeat_at: at(BUDGET_MS - 1_000) }, manifest, NOW)
  assert.equal(edge.state, 'running')
  assert.equal(edge.stale, false)

  // 超预算：这是本次修复的核心场景
  const dead = evaluateLiveness({ state: 'running', heartbeat_at: at(BUDGET_MS + 1_000) }, manifest, NOW)
  assert.equal(dead.state, 'unknown', 'stale 的 running 必须降级，否则 fleet 永远显示在跑')
  assert.equal(dead.alive, false)
  assert.equal(dead.stale, true)
  assert.match(dead.reason, /心跳已停 91s（上限 90s）/)

  // 停了很久（真实场景：status 停在 8-17，实际早已死亡）
  const longDead = evaluateLiveness({ state: 'running', heartbeat_at: '2026-08-17T13:40:00Z' }, manifest, NOW)
  assert.equal(longDead.state, 'unknown')
  assert.equal(longDead.stale, true)

  // draining 同样受判活约束
  const draining = evaluateLiveness({ state: 'draining', heartbeat_at: at(BUDGET_MS + 5_000) }, manifest, NOW)
  assert.equal(draining.state, 'unknown')
  assert.equal(draining.stale, true)
})

test('running 缺少可解析心跳 → 不可信', () => {
  for (const beat of [undefined, null, '', 'whenever', '2026-09-07 12:00:00']) {
    const live = evaluateLiveness({ state: 'running', heartbeat_at: beat }, manifest, NOW)
    assert.equal(live.state, 'unknown', `heartbeat_at=${String(beat)} 应判为不可信`)
    assert.equal(live.stale, true)
    assert.match(live.reason, /缺少可解析的 heartbeat_at/)
  }
})

test('未来心跳按 stale 处理（时钟回拨 / 跨机复制）', () => {
  const future = evaluateLiveness({ state: 'running', heartbeat_at: at(-(BUDGET_MS + 5_000)) }, manifest, NOW)
  assert.equal(future.state, 'unknown')
  assert.equal(future.stale, true)
  assert.match(future.reason, /超前 95s，时钟不可信/)

  // 轻微超前（写盘时钟抖动）仍容忍，不误报
  const skew = evaluateLiveness({ state: 'running', heartbeat_at: at(-2_000) }, manifest, NOW)
  assert.equal(skew.state, 'running')
  assert.equal(skew.stale, false)
})

test('终态不需要心跳背书', () => {
  // stopped 就是 stopped，心跳多久之前无关
  const stopped = evaluateLiveness({ state: 'stopped', heartbeat_at: '2020-01-01T00:00:00Z' }, manifest, NOW)
  assert.deepEqual(
    { state: stopped.state, alive: stopped.alive, stale: stopped.stale },
    { state: 'stopped', alive: false, stale: false },
  )
  // idle/blocked/error 保持原状且算存活（enabled 时计入 online）
  for (const state of ['idle', 'blocked', 'error']) {
    const live = evaluateLiveness({ state, heartbeat_at: '2020-01-01T00:00:00Z' }, manifest, NOW)
    assert.equal(live.state, state, `${state} 不应被判活改写`)
    assert.equal(live.alive, true)
    assert.equal(live.stale, false)
  }
})

test('无 status / 无 manifest 心跳周期的兜底', () => {
  assert.equal(evaluateLiveness(null, manifest, NOW).state, 'no-status')
  assert.equal(evaluateLiveness({}, manifest, NOW).state, 'no-status')
  assert.equal(evaluateLiveness({ state: '' }, manifest, NOW).state, 'no-status')

  // manifest 未声明 heartbeat_ms → 用 DEFAULT_HEARTBEAT_MS
  const budget = DEFAULT_HEARTBEAT_MS * STALE_FACTOR
  const noLimits = { limits: {} }
  assert.equal(evaluateLiveness({ state: 'running', heartbeat_at: at(budget - 1_000) }, noLimits, NOW).stale, false)
  assert.equal(evaluateLiveness({ state: 'running', heartbeat_at: at(budget + 1_000) }, noLimits, NOW).stale, true)
  // 非法声明（0 / 负数 / 非数字）同样回落默认值
  for (const bad of [0, -1, 'fast', null]) {
    const live = evaluateLiveness({ state: 'running', heartbeat_at: at(budget + 1_000) }, { limits: { heartbeat_ms: bad } }, NOW)
    assert.equal(live.stale, true, `heartbeat_ms=${String(bad)} 应回落默认预算`)
  }
})
