#!/usr/bin/env node
// task-ready.mjs — 查询任务图的就绪集（G1，2026-09-10）
//
// 为什么需要它：主协议 §5 的依赖规则此前只写在文档里，没有任何可执行的消费方
// （派单器只检查开关与预算）。本 CLI 把它变成可查询的事实：
//   · 哪些任务依赖已满足、可以开工（就绪集）
//   · 哪些任务图就绪但 fleet 现在做不了（可派集与就绪集的差值）
//   · 某个任务为什么被挡住（--explain）
//
// 判定逻辑全部在 workers/lib/task-graph.cjs（纯函数），本文件只负责
// 「读总线 → 组装上下文 → 呈现」。
//
// 用法：
//   node workers/graph/task-ready.mjs                 # 图就绪集
//   node workers/graph/task-ready.mjs --dispatchable  # 可派集（叠加开关/判活/预算）
//   node workers/graph/task-ready.mjs --explain t-0012
//   node workers/graph/task-ready.mjs --groups
//   node workers/graph/task-ready.mjs --json
//
// 退出码：0 有就绪任务 / 1 无就绪任务 / 2 环境错误

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import core from '../lib/bus-apply-core.cjs'
import { evaluateLiveness } from '../lib/liveness.mjs'
import {
  buildGraph,
  dispatchableSet,
  evaluateDispatchable,
  effectiveDeps,
  foldTasks,
  groupSummary,
  readySet,
} from '../lib/task-graph.mjs'

const ROOT = process.env.BUS_ROOT
  ? path.resolve(process.env.BUS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const DEFAULT_BUDGET_PER_DAY = 2.0

// ---------------------------------------------------------------------------
// 上下文组装（全部 IO 集中在这里，判定逻辑保持纯函数）
// ---------------------------------------------------------------------------

/** 当日成本。口径与 dispatch-task.ps1 的 Get-DayCost 一致：ts 前缀为今日的 cost 之和。 */
function dayCost(agentDir) {
  const today = new Date().toISOString().slice(0, 10)
  let sum = 0
  for (const row of core.readJsonl(path.join(agentDir, 'usage.jsonl'))) {
    if (typeof row.cost !== 'number') continue
    const day = typeof row.ts === 'string' ? row.ts.slice(0, 10) : null
    if (day === today) sum += row.cost
  }
  return sum
}

/**
 * 各 agent 的现实状态：开关 / 判活 / 预算。
 *
 * ⚠️ 口径对齐：开关与预算的判定与 workers/dispatch/dispatch-task.ps1 保持同一语义
 * （enabled=true 才可派；当日 cost ≥ budget_per_day 即熔断；判活复用 F3 的
 * workers/lib/liveness.cjs）。**改任一侧必须同步另一侧** —— 跨语言无法共享实现，
 * 这是本文件唯一需要人工维护的一致性点。
 */
function loadAgentStates() {
  const dir = path.join(ROOT, 'agents')
  const states = new Map()
  if (!fs.existsSync(dir)) return states

  for (const id of fs.readdirSync(dir)) {
    if (id === 'archive') continue
    const agentDir = path.join(dir, id)
    try {
      if (!fs.statSync(agentDir).isDirectory()) continue
    } catch { continue }

    const manifest = core.readJsonOrNull(path.join(agentDir, 'manifest.json'))
    if (!manifest) continue
    const control = core.readJsonOrNull(path.join(agentDir, 'control.json'))
    const status = core.readJsonOrNull(path.join(agentDir, 'status.json'))
    const live = evaluateLiveness(status, manifest, Date.now())

    const budget = manifest.limits && Number.isFinite(manifest.limits.budget_per_day)
      ? manifest.limits.budget_per_day
      : DEFAULT_BUDGET_PER_DAY

    states.set(id, {
      enabled: control ? control.enabled === true : false,
      alive: live.alive,
      budgetOk: dayCost(agentDir) < budget,
      state: live.state,
    })
  }
  return states
}

/**
 * 产物是否存在。
 *
 * 按约定尝试两个位置：任务根（`tasks/<id>/<artifact>`，result.json 在此）
 * 与交付区（`tasks/<id>/result/<artifact>`，artifacts/ 在此）。
 * 任一命中即视为存在 —— 位置二选一的实现细节不应影响就绪判定。
 */
function artifactExists(taskId, artifact) {
  const candidates = [
    path.join(ROOT, 'tasks', taskId, artifact),
    path.join(ROOT, 'tasks', taskId, 'result', artifact),
  ]
  return candidates.some((p) => fs.existsSync(p))
}

function buildContext() {
  const rows = core.readJsonl(path.join(ROOT, 'state', 'tasks.jsonl'))
  const tasks = foldTasks(rows)
  const agents = loadAgentStates()
  return {
    tasks,
    agents,
    artifactExists,
    agentState: (id) => (agents.has(id) ? agents.get(id) : null),
  }
}

// ---------------------------------------------------------------------------
// 呈现
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, dispatchable: false, explain: null, groups: false, check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--dispatchable') opts.dispatchable = true
    else if (a === '--check') opts.check = true
    else if (a === '--explain') {
      opts.explain = argv[++i]
      if (!opts.explain) throw new Error('--explain 需要任务 id')
    } else if (a === '--groups') opts.groups = true
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

function printHelp() {
  console.log(`task-ready — 查询任务图的就绪集（G1）

  （无参数）          图就绪集：依赖已满足、可以开工的任务
  --dispatchable      可派集：在图就绪之上叠加 assignee / 开关 / 判活 / 预算
  --explain <taskId>  解释某任务为何就绪或被挡
  --groups            打印各钻石图分组的进度摘要
  --check             只检查图结构（悬挂引用/自环/分组完整性），总是以 0 退出（除环境错误）
  --json              以 JSON 输出

环境变量：BUS_ROOT 覆盖工作区根（默认由本文件位置推导）

退出码：0 有就绪任务（或 --check 通过）/ 1 无就绪任务（或 --check 发现结构问题）/ 2 环境错误`)
}

function renderSet(label, result, opts) {
  if (opts.json) return
  if (result.ready.length === 0) {
    console.log(`[task-ready] ${label}：无`)
  } else {
    console.log(`[task-ready] ${label} ${result.ready.length} 个：${result.ready.join(' ')}`)
  }
  for (const b of result.blocked) {
    const flag = b.graphReady === false ? '[图]' : b.graphReady === true ? '[fleet]' : ''
    console.log(`  ✗ ${b.taskId}（${b.status}）${flag} ${b.reasons.join('；')}`)
  }
  if (result.finished.length > 0) {
    console.log(`  · 终态 ${result.finished.length} 个：${result.finished.join(' ')}`)
  }
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`[task-ready] ${e.message}`)
    return 2
  }

  let ctx
  try {
    ctx = buildContext()
  } catch (e) {
    console.error(`[task-ready] 读取总线失败：${e.message}`)
    return 2
  }

  // --explain：单任务细解
  if (opts.explain) {
    const id = opts.explain
    const t = ctx.tasks.get(id)
    if (!t) {
      console.error(`[task-ready] 任务不存在: ${id}`)
      return 2
    }
    const r = evaluateDispatchable(id, ctx)
    const deps = effectiveDeps(t)
    if (opts.json) {
      console.log(JSON.stringify({
        task_id: id, status: t.status, assignee: t.assignee,
        ready: r.ready, graph_ready: r.graphReady, reasons: r.reasons, deps,
      }))
    } else {
      console.log(`[task-ready] ${id}（${t.status}）assignee=${t.assignee ?? '未指定'}`)
      console.log(`  图就绪：${r.graphReady ? '是' : '否'}   可派：${r.ready ? '是' : '否'}`)
      if (deps.length === 0) console.log('  依赖：无')
      else for (const d of deps) {
        const up = ctx.tasks.get(d.task)
        const mark = d.kind === 'consumes' ? '数据依赖' : '时序依赖'
        console.log(`  ${mark}：${d.task}${d.artifact ? `/${d.artifact}` : ''}（上游 ${up ? up.status : '不存在'}${up && up.accepted ? '/已验收' : ''}）`)
      }
      for (const reason of r.reasons) console.log(`  ✗ ${reason}`)
    }
    return r.ready ? 0 : 1
  }

  // --check：图结构完整性（供回归使用，无结构问题即 0）
  if (opts.check) {
    const g = buildGraph(ctx.tasks)
    if (opts.json) {
      console.log(JSON.stringify({ ok: g.issues.length === 0, tasks: ctx.tasks.size, groups: g.groups.size, issues: g.issues }))
    } else if (g.issues.length > 0) {
      for (const i of g.issues) console.error(`[task-ready] FAIL ${i.taskId}: ${i.kind} — ${i.detail}`)
      console.error(`[task-ready] --check 失败：${g.issues.length} 个结构问题`)
    } else {
      console.log(`[task-ready] --check 通过：${ctx.tasks.size} 个任务，${g.groups.size} 个分组，无结构问题`)
    }
    return g.issues.length === 0 ? 0 : 1
  }

  // --groups：分组摘要
  if (opts.groups) {
    const g = buildGraph(ctx.tasks)
    const summaries = [...g.groups.keys()].sort().map((id) => groupSummary(ctx.tasks, id))
    if (opts.json) {
      console.log(JSON.stringify({ groups: summaries, issues: g.issues }))
    } else if (summaries.length === 0) {
      console.log('[task-ready] 没有任务入图（所有任务均无 graph 字段）')
    } else {
      for (const s of summaries) {
        console.log(`[task-ready] ${s.groupId}：${s.counts.total} 个（已验收 ${s.counts.accepted} / 待验收 ${s.counts.done} / 运行 ${s.counts.running} / 阻塞 ${s.counts.blocked} / 待办 ${s.counts.queued}）reduce=${s.reduceId ?? '无'}`)
      }
      for (const i of g.issues) console.log(`  ⚠ ${i.taskId}: ${i.kind} — ${i.detail}`)
    }
    return 0
  }

  // 默认：就绪集 / 可派集
  if (opts.dispatchable) {
    const r = dispatchableSet(ctx)
    if (opts.json) console.log(JSON.stringify(r))
    else renderSet('可派', r, opts)
    return r.ready.length > 0 ? 0 : 1
  }

  const r = readySet(ctx)
  if (opts.json) console.log(JSON.stringify(r))
  else renderSet('图就绪', r, opts)
  return r.ready.length > 0 ? 0 : 1
}

process.exit(main())
