// scheduler.test.mjs — P2-D（2026-10-21）：定时任务语义（无常驻 daemon）
//
// 覆盖 workers/lib/schedule.cjs（纯函数）与 workers/scheduler/enqueue-due.mjs（一次性触发器）：
//   · schedules 校验：id 形态 / interval ≥ 60 / next_fire_at ISO / task 必填；
//   · due 判定与「错过多个窗口只补一次」；
//   · **幂等**：同一 now 重复调用不重复建任务；next_fire_at 与任务行同一次超步推进；
//   · 无 schedules / 空 schedules 均安全返回 0；坏 schedules --check exit 1。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import schedule from '../workers/lib/schedule.cjs'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(FLEET_DIR, 'workers', 'scheduler', 'enqueue-due.mjs')
const NOW = '2026-10-22T00:00:00Z'

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-sched-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(join(FLEET_DIR, 'workers'), join(root, 'workers'), { recursive: true })
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(root, 'tasks'), { recursive: true })
  writeFileSync(join(root, 'state', 'tasks.jsonl'), '', 'utf8')
  writeFileSync(join(root, 'state', 'graph-events.jsonl'), '', 'utf8')
  return root
}

function writeSchedules(root, schedules) {
  writeFileSync(join(root, 'state', 'schedules.json'), JSON.stringify({
    version: 1, updated_at: NOW, schedules,
  }, null, 2) + '\n', 'utf8')
}

function runCli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: FLEET_DIR,
    env: { ...process.env, BUS_ROOT: root },
    stdio: 'ignore',
  })
  return r.status
}

function readRows(root) {
  return readFileSync(join(root, 'state', 'tasks.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

function readDoc(root) {
  return JSON.parse(readFileSync(join(root, 'state', 'schedules.json'), 'utf8'))
}

const GOOD = {
  id: 's-check',
  enabled: true,
  interval_seconds: 3600,
  next_fire_at: '2026-10-21T23:00:00Z',
  last_fired_at: null,
  fire_count: 0,
  task: { title: '定时巡检', assignee: 'pi', brief: '检查 fleet 健康' },
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('validateSchedules：合法通过；id/interval/next_fire_at/task 非法各自报问题', () => {
  const ok = schedule.validateSchedules({ version: 1, schedules: [GOOD] })
  assert.equal(ok.ok, true, JSON.stringify(ok.problems))

  const bad = schedule.validateSchedules({
    version: 1,
    schedules: [
      { ...GOOD, id: 'x', interval_seconds: 10, next_fire_at: 'not-a-time', task: {} },
      { ...GOOD, id: 's-dup' },
      { ...GOOD, id: 's-dup' },
    ],
  })
  assert.equal(bad.ok, false)
  const msgs = bad.problems.map((p) => p.where + ':' + p.message).join('|')
  assert.match(msgs, /id 非法/)
  assert.match(msgs, /interval_seconds 必须 ≥ 60/)
  assert.match(msgs, /next_fire_at 必须是 ISO 时间/)
  assert.match(msgs, /title 缺失/)
  assert.match(msgs, /id 重复/)
})

test('dueSchedules：只取 enabled 且 next_fire_at ≤ now，按时间升序、受 max 限制', () => {
  const doc = { version: 1, schedules: [
    { ...GOOD, id: 's-b', next_fire_at: '2026-10-22T00:00:00Z' },
    { ...GOOD, id: 's-a', next_fire_at: '2026-10-21T23:30:00Z' },
    { ...GOOD, id: 's-off', enabled: false, next_fire_at: '2026-10-21T00:00:00Z' },
    { ...GOOD, id: 's-later', next_fire_at: '2026-10-22T01:00:00Z' },
  ] }
  const now = Date.parse('2026-10-22T00:30:00Z')
  const due = schedule.dueSchedules(doc, now, 5).map((s) => s.id)
  assert.deepEqual(due, ['s-a', 's-b'])
  assert.deepEqual(schedule.dueSchedules(doc, now, 1).map((s) => s.id), ['s-a'])
})

test('advanceSchedule：last_fired_at/fire_count 推进；next = 实际触发 + interval（不雪崩补跑）', () => {
  const fired = Date.parse('2026-10-22T05:00:00Z')
  const next = schedule.advanceSchedule(GOOD, fired)
  assert.equal(next.last_fired_at, '2026-10-22T05:00:00.000Z')
  assert.equal(next.fire_count, 1)
  assert.equal(next.next_fire_at, '2026-10-22T06:00:00.000Z', '错过窗口只补一次')
})

// ---------------------------------------------------------------------------
// CLI：真实 bus-apply 超步 + 幂等
// ---------------------------------------------------------------------------

test('CLI：到期 ⇒ 建任务 + 推进 schedules（brief 落盘）；同一 now 幂等', (t) => {
  const root = makeRoot(t)
  writeSchedules(root, [GOOD])

  assert.equal(runCli(root, ['--now', NOW]), 0)
  let rows = readRows(root)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].op, 'create')
  assert.equal(rows[0].task.status, 'queued')
  assert.equal(rows[0].task.assignee, 'pi')
  const taskId = rows[0].task.id
  assert.ok(existsSync(join(root, 'tasks', taskId, 'brief.md')), 'brief 必须落盘（派单前置）')
  let doc = readDoc(root)
  assert.equal(doc.schedules[0].fire_count, 1)
  assert.ok(Date.parse(doc.schedules[0].next_fire_at) > Date.parse(NOW))

  // 幂等：同一 now 再跑不新增任务、不重复推进
  assert.equal(runCli(root, ['--now', NOW]), 0)
  rows = readRows(root)
  assert.equal(rows.length, 1, '同一时刻重复触发必须幂等（任务行 + next_fire_at 同超步）')
  assert.equal(readDoc(root).schedules[0].fire_count, 1)
})

test('CLI：到下一次触发时刻 ⇒ 建第二个任务且 id 递增', (t) => {
  const root = makeRoot(t)
  writeSchedules(root, [GOOD])
  assert.equal(runCli(root, ['--now', NOW]), 0)
  const next = readDoc(root).schedules[0].next_fire_at
  assert.equal(runCli(root, ['--now', next]), 0)
  const rows = readRows(root)
  assert.equal(rows.length, 2)
  const ids = rows.map((r) => r.task.id)
  assert.deepEqual(ids, ['t-0001', 't-0002'])
})

test('CLI：无 schedules 文件 / 无到期 ⇒ exit 0（不建任务）', (t) => {
  const root = makeRoot(t)
  assert.equal(runCli(root, ['--now', NOW]), 0)
  assert.equal(readRows(root).length, 0)
  writeSchedules(root, [{ ...GOOD, next_fire_at: '2026-10-23T00:00:00Z' }])
  assert.equal(runCli(root, ['--now', NOW]), 0)
  assert.equal(readRows(root).length, 0)
})

test('CLI：坏 schedules ⇒ --check exit 1（显式失败，不猜）', (t) => {
  const root = makeRoot(t)
  writeSchedules(root, [{ ...GOOD, interval_seconds: 5 }])
  assert.equal(runCli(root, ['--check', '--now', NOW]), 1)
})
