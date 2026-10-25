#!/usr/bin/env node
// enqueue-due.mjs — P2-D（2026-10-21）：把到期的 schedule 转成 queued 任务（无常驻 daemon）
//
// 设计（Cherry A6「搬语义不搬 daemon」）：
//   · 真相 = `state/schedules.json`（Operator/Commander 经 bus-apply 写）；
//   · 本 CLI 是**一次性触发器**：外部（Windows 任务计划 / 手动 / DSH 定时插件）周期调用；
//   · **幂等**：任务行 append 与 schedules 的 next_fire_at 推进在**同一次超步**提交
//     （要么都生效要么都不动）⇒ 同一时刻重复调用不会重复建任务；
//   · 错过多个窗口只补一次（next = 实际触发时刻 + interval），不雪崩补跑。
//
// 用法：
//   node workers/scheduler/enqueue-due.mjs                 # 建到期任务（写总线）
//   node workers/scheduler/enqueue-due.mjs --check         # 只校验 + 列到期，不写
//   node workers/scheduler/enqueue-due.mjs --json          # JSON 输出
//   node workers/scheduler/enqueue-due.mjs --now 2026-10-22T00:00:00Z --max 3
//
// 退出码：0 成功（含无到期）/ 1 校验失败或写入失败 / 2 用法/环境错误

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import schedule from '../lib/schedule.cjs'

const ROOT = process.env.BUS_ROOT
  ? path.resolve(process.env.BUS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const STATE_DIR = path.join(ROOT, 'state')
const SCHEDULES_PATH = path.join(STATE_DIR, 'schedules.json')
const TASKS_PATH = path.join(STATE_DIR, 'tasks.jsonl')
const APPLIER = path.join(ROOT, 'workers', 'bus', 'bus-apply.mjs')

function parseArgs(argv) {
  const opts = { check: false, json: false, now: null, max: 5 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') opts.check = true
    else if (a === '--json') opts.json = true
    else if (a === '--now') {
      const v = argv[++i]
      if (!v || schedule.parseTime(v) === null) throw new Error('--now 需要合法 ISO 时间')
      opts.now = v
    } else if (a === '--max') {
      const v = argv[++i]
      if (!/^\d+$/.test(v || '') || Number(v) < 1 || Number(v) > 50) throw new Error('--max 需要 1..50 的整数')
      opts.max = Number(v)
    } else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

function printHelp() {
  console.log(`enqueue-due — 把到期 schedule 转成 queued 任务（P2-D）

  --check        只校验 + 列到期（不写总线）
  --json         JSON 输出
  --now <iso>    注入当前时间（测试用）
  --max <n>      本次最多触发 n 个（1..50，默认 5）

环境变量：BUS_ROOT 覆盖工作区根
退出码：0 成功（含无到期）/ 1 校验或写入失败 / 2 用法错误`)
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

/** 现有任务 id 的最大序号（目录 + 台账双重取，避免碰撞）。 */
function maxTaskNumber() {
  let max = 0
  try {
    for (const d of fs.readdirSync(path.join(ROOT, 'tasks'))) {
      const m = /^t-(\d{4})$/.exec(d)
      if (m) max = Math.max(max, Number(m[1]))
    }
  // guard-ok: tasks 目录不存在 = 尚无历史任务（首次运行合法；id 从 t-0001 起）
  } catch { /* tasks 目录不存在 = 无历史任务 */ }
  try {
    for (const line of fs.readFileSync(TASKS_PATH, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        const id = row && row.task && row.task.id
        const m = /^t-(\d{4})$/.exec(String(id || ''))
        if (m) max = Math.max(max, Number(m[1]))
      // guard-ok: 坏行由 validate-bus 显式拦截；此处只为分配 id 防碰撞，跳过不影响判定
      } catch { /* 坏行由 validate-bus 负责；这里只是防碰撞 */ }
    }
  // guard-ok: 台账不存在 = 首次运行（无历史任务），不猜 id
  } catch { /* 无台账 = 无历史任务 */ }
  return max
}

function padTaskId(n) {
  return `t-${String(n).padStart(4, '0')}`
}

function runApplier(patches) {
  const r = spawnSync(process.execPath, [APPLIER, '--stdin'], {
    input: JSON.stringify(patches),
    encoding: 'utf8',
    env: { ...process.env, BUS_ROOT: ROOT },
    timeout: 30000,
  })
  return {
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    error: r.error ? String(r.error.message) : null,
  }
}

function emitEvent(taskId, scheduleId, nowIso) {
  // 事件是审计不是闸门：失败只告警，不改变已提交的任务/schedules（best-effort，与派单器同策略）。
  const r = spawnSync(process.execPath, [
    APPLIER, '--emit-event', 'schedule.fired',
    '--author', 'scheduler',
    '--task', taskId,
    '--reason', `schedule ${scheduleId} 到期触发`,
    '--field', `schedule_id=${scheduleId}`,
    '--field', `fired_at=${nowIso}`,
  ], { encoding: 'utf8', env: { ...process.env, BUS_ROOT: ROOT }, timeout: 15000 })
  if (r.status !== 0) {
    console.error(`[scheduler] ⚠ schedule.fired 事件未入流（bus-apply exit ${r.status}）：${String(r.stdout || '') + String(r.stderr || '')}`)
  }
}

function briefFor(scheduleObj, taskId, nowIso) {
  const t = scheduleObj.task
  const lines = [
    `# ${t.title}`,
    '',
    `- 任务 id：${taskId}`,
    `- 来源：定时 schedule \`${scheduleObj.id}\``,
    `- 触发时间：${nowIso}`,
    `- assignee：${t.assignee}`,
    '',
    '## 目标',
    '',
    t.brief || '（schedule 未提供 brief：由 Commander 按 title 补充任务书）',
    '',
  ]
  return lines.join('\n')
}

function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (e) { console.error(`[scheduler] ${e.message}`); return 2 }

  if (!fs.existsSync(SCHEDULES_PATH)) {
    console.log(`[scheduler] 无 ${path.relative(ROOT, SCHEDULES_PATH)}（没有登记任何 schedule）`)
    return 0
  }
  const doc = readJson(SCHEDULES_PATH)
  if (!doc) { console.error('[scheduler] schedules.json 解析失败'); return 1 }
  const validated = schedule.validateSchedules(doc)
  if (!validated.ok) {
    console.error(`[scheduler] schedules 校验失败 ${validated.problems.length} 处：`)
    for (const p of validated.problems) console.error(`  ${p.where}: ${p.message}`)
    return 1
  }

  const nowMs = opts.now ? schedule.parseTime(opts.now) : Date.now()
  const nowIso = schedule.toIso(nowMs)
  const due = schedule.dueSchedules(doc, nowMs, opts.max)

  const payload = {
    now: nowIso,
    schedules: doc.schedules.length,
    due: due.map((s) => ({ id: s.id, next_fire_at: s.next_fire_at })),
    created: [],
  }

  if (opts.check) {
    console.log(`[scheduler] 校验通过：${doc.schedules.length} 个 schedule，当前到期 ${due.length} 个（未写盘）`)
    for (const s of due) console.log(`  due ${s.id.padEnd(20)} next=${s.next_fire_at} assignee=${s.task.assignee}`)
    if (opts.json) console.log(JSON.stringify(payload))
    return 0
  }

  if (due.length === 0) {
    console.log(`[scheduler] 无到期 schedule（共 ${doc.schedules.length} 个，now=${nowIso}）`)
    if (opts.json) console.log(JSON.stringify(payload))
    return 0
  }

  // 分配任务 id + 生成补丁（一次超步：N 条任务 append + schedules set）
  let nextNum = maxTaskNumber() + 1
  const patches = []
  const created = []
  const docNext = Object.assign({}, doc, { schedules: doc.schedules.map((s) => Object.assign({}, s)) })
  const byId = new Map(docNext.schedules.map((s) => [s.id, s]))

  for (const s of due) {
    const taskId = padTaskId(nextNum++)
    const createdAt = nowIso
    patches.push({
      op: 'append',
      path: 'state/tasks.jsonl',
      value: {
        op: 'create',
        task: {
          id: taskId,
          title: s.task.title,
          assignee: s.task.assignee,
          status: 'queued',
          created_at: createdAt,
          updated_at: createdAt,
          retries: 0,
          tokens: 0,
          cost: 0,
          depends_on: [],
          waiting_for: null,
        },
      },
      author: 'scheduler',
      reason: `schedule ${s.id} 到期触发（next=${s.next_fire_at}）`,
      expected_version: -1,
    })
    const advanced = schedule.advanceSchedule(byId.get(s.id), nowMs)
    byId.set(s.id, advanced)
    created.push({ task_id: taskId, schedule_id: s.id, title: s.task.title, assignee: s.task.assignee })
  }
  docNext.updated_at = nowIso
  docNext.schedules = docNext.schedules.map((s) => byId.get(s.id))
  patches.push({
    op: 'set',
    path: 'state/schedules.json',
    value: docNext,
    author: 'scheduler',
    reason: `enqueue-due：触发 ${due.length} 个 schedule`,
    expected_version: -1,
  })

  // brief 先写盘（applier 失败时回滚删除 —— 不留下「有目录无台账」的孤儿）
  const briefPaths = []
  try {
    for (const c of created) {
      const dir = path.join(ROOT, 'tasks', c.task_id)
      fs.mkdirSync(dir, { recursive: true })
      const bp = path.join(dir, 'brief.md')
      fs.writeFileSync(bp, briefFor(doc.schedules.find((s) => s.id === c.schedule_id), c.task_id, nowIso), 'utf8')
      briefPaths.push(bp)
    }
  } catch (e) {
    // guard-ok: 清理失败不改变主判定（主错误在下一行显式上报）；brief 孤儿由后续扫描/Operator 处理
    for (const bp of briefPaths) { try { fs.rmSync(bp, { force: true }) } catch { /* ignore */ } }
    console.error(`[scheduler] 写 brief 失败（未提交总线）：${e.message}`)
    return 1
  }

  const result = runApplier(patches)
  if (result.status !== 0) {
    // guard-ok: 清理失败不掩盖主错误（applier 失败已显式上报并 exit 1）
    for (const bp of briefPaths) { try { fs.rmSync(bp, { force: true }) } catch { /* ignore */ } }
    console.error(`[scheduler] ✗ bus-apply exit ${result.status}${result.error ? `（${result.error}）` : ''}`)
    const detail = (result.stdout + '\n' + result.stderr).trim()
    if (detail) console.error(detail)
    console.error('[scheduler] 未提交（一次超步原子）；修复后重跑即可（幂等）')
    return 1
  }

  for (const c of created) emitEvent(c.task_id, c.schedule_id, nowIso)
  payload.created = created
  console.log(`[scheduler] 经唯一入口落盘：${created.length} 个任务 + schedules 一次超步提交`)
  for (const c of created) console.log(`  ${c.task_id}  ← ${c.schedule_id}  ${c.title}（${c.assignee}）`)
  if (opts.json) console.log(JSON.stringify(payload))
  return 0
}

process.exit(main())
