// task-graph.cjs — 任务图的解析与就绪度判定（G1，2026-09-10）
//
// 为什么存在：主协议 §5 规定「depends_on 中的任务全部 done 后，Commander 才允许
// assign」，但这是一条**靠自觉的约定**——workers/dispatch/dispatch-task.ps1 里
// 没有任何依赖判定代码（它只检查开关与预算）。换句话说，图在此之前只存在于
// Commander 的脑子里，没有被任何可执行的东西消费过。
//
// 本模块把它变成可执行的判定：给定 tasks.jsonl 的行，算出
//   · 当前图长什么样（节点 / 分组 / 悬挂引用）
//   · 哪些任务就绪（依赖满足），哪些被什么挡住
//   · 哪些任务可派（在就绪之上再叠加 fleet 的现实约束：开关 / 判活 / 预算）
//
// ── 依赖的两种语义（G1 的关键设计）────────────────────────────────────
//   depends_on  时序偏好（旧）→ 满足条件：上游 status === 'done'
//   consumes    数据依赖（新）→ 满足条件：上游 done ∧ 已验收 ∧ 产物存在
//
// 任务**有** graph.consumes 时用 consumes，**没有**时回退到 depends_on。
// 这条回退规则让「无 graph 字段的旧任务」的行为与 G1 之前**逐字一致**——
// 增量式采用的前提，也是 tests/task-graph.test.mjs 里等价性测试的对象。
//
// 全部为纯函数、无 IO：产物存在性与 agent 现实状态通过 ctx 注入，
// 因此可在临时目录/内存数据上完整测试。

'use strict'

const contract = require('./bus-contract.cjs')

/** 任务的终态集合：到达这些状态后不再需要调度。 */
const TERMINAL = new Set(['done', 'cancelled', 'failed'])

// ---------------------------------------------------------------------------
// 台账重放
// ---------------------------------------------------------------------------

/**
 * 按 task_id 重放 tasks.jsonl，得到每个任务的当前状态。
 *
 * 与主协议 §4.5 一致：「当前状态 = 按 task_id 重放最后一条相关记录」。
 * 引用不存在任务的记录直接跳过——那是巡检（validate-bus）的职责，不是调度器的。
 *
 * @param {Array<object>} rows tasks.jsonl 的行
 * @returns {Map<string, object>} taskId → 任务视图
 */
function foldTasks(rows) {
  const map = new Map()
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue

    if (row.op === 'create') {
      const t = row.task
      if (!t || !contract.isStr(t.id)) continue
      map.set(t.id, {
        id: t.id,
        title: t.title || '',
        status: t.status || 'queued',
        accepted: t.accepted === true,
        assignee: t.assignee ?? null,
        depends_on: Array.isArray(t.depends_on) ? [...t.depends_on] : [],
        graph: t.graph ?? null,
        retries: typeof t.retries === 'number' ? t.retries : 0,
        created_at: t.created_at ?? null,
        updated_at: t.updated_at ?? t.created_at ?? null,
      })
      continue
    }

    const t = map.get(row.task_id)
    if (!t) continue // 悬空记录：巡检负责报错

    if (row.status !== undefined) t.status = row.status
    if (row.assignee !== undefined) t.assignee = row.assignee
    if (row.accepted !== undefined) t.accepted = row.accepted === true
    if (row.retries !== undefined) t.retries = row.retries
    if (row.updated_at) t.updated_at = row.updated_at

    // reopen 把任务送回队列：验收标记同时失效（否则重开的任务会被当作已通过）
    if (row.op === 'reopen') {
      t.status = 'queued'
      t.accepted = false
    }
    if (row.op === 'cancel') {
      t.status = 'cancelled'
      t.accepted = false
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// 图模型
// ---------------------------------------------------------------------------

/** 该任务的有效依赖边。有 consumes 用 consumes，否则回退 depends_on。 */
function effectiveDeps(task) {
  const g = task && task.graph
  if (g && Array.isArray(g.consumes) && g.consumes.length > 0) {
    return g.consumes.map((c) => ({
      kind: 'consumes',
      task: c.task,
      artifact: c.artifact,
      required: c.required !== false,
    }))
  }
  return (task && Array.isArray(task.depends_on) ? task.depends_on : []).map((id) => ({
    kind: 'depends_on',
    task: id,
  }))
}

/**
 * 构建图模型：节点、按 group 分组、以及结构性问题清单。
 *
 * 这里只报「图上说不通」的问题（悬挂引用、自环、reduce 无上游）；
 * 契约层面的问题（node_kind 枚举、字段形态）由 bus-contract 负责，不重复。
 */
function buildGraph(tasks) {
  const groups = new Map()
  const issues = []

  for (const t of tasks.values()) {
    for (const d of effectiveDeps(t)) {
      if (d.task === t.id) issues.push({ taskId: t.id, kind: 'self_loop', detail: '依赖指向自己' })
      else if (!tasks.has(d.task)) issues.push({ taskId: t.id, kind: 'dangling', detail: `依赖不存在的任务 ${d.task}` })
    }
    const g = t.graph
    if (g && g.parent !== undefined && !tasks.has(g.parent)) {
      issues.push({ taskId: t.id, kind: 'dangling_parent', detail: `parent 不存在: ${g.parent}` })
    }
    if (g && g.group !== undefined) {
      if (!groups.has(g.group)) groups.set(g.group, [])
      groups.get(g.group).push(t.id)
    }
  }
  return { nodes: tasks, groups, issues }
}

/** 某个分组的进度摘要（供面板/诊断，不参与就绪判定）。 */
function groupSummary(tasks, groupId) {
  const members = []
  for (const t of tasks.values()) {
    if (t.graph && t.graph.group === groupId) members.push(t)
  }
  const counts = { total: members.length, done: 0, accepted: 0, blocked: 0, running: 0, queued: 0, other: 0 }
  let reduceId = null
  for (const t of members) {
    if (t.graph.node_kind === 'reduce') reduceId = t.id
    if (t.status === 'done' && t.accepted) counts.accepted++
    else if (t.status === 'done') counts.done++
    else if (t.status === 'blocked') counts.blocked++
    else if (t.status === 'running') counts.running++
    else if (t.status === 'queued') counts.queued++
    else counts.other++
  }
  return { groupId, members: members.map((t) => t.id), reduceId, counts }
}

// ---------------------------------------------------------------------------
// 旧规则（G1 之前的语义）—— 保留用于等价性验证
// ---------------------------------------------------------------------------

/**
 * 主协议 §5 的旧判定：「depends_on 中的任务全部 done 后，Commander 才允许 assign」。
 *
 * 刻意保留为独立函数：它是 G1 承诺「零行为变更」的比对基准，
 * tests/task-graph.test.mjs 用它证明无 graph 字段的任务判定结果未被改动。
 */
function legacyReady(task, tasks) {
  if (!task || task.status !== 'queued') return false
  for (const id of task.depends_on || []) {
    const up = tasks.get(id)
    if (!up || up.status !== 'done') return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 就绪度
// ---------------------------------------------------------------------------

/**
 * 图就绪判定：只看图（任务状态 + 依赖），不看 fleet 现实。
 *
 * @param {string} taskId
 * @param {object} ctx  { tasks, artifactExists?(taskId, artifact) }
 * @returns {{ready: boolean, reasons: string[], deps: Array}}
 */
function evaluateReadiness(taskId, ctx) {
  const tasks = ctx.tasks
  const t = tasks.get(taskId)
  if (!t) return { ready: false, reasons: [`任务不存在: ${taskId}`], deps: [] }

  const reasons = []
  if (t.status !== 'queued') {
    reasons.push(`状态为 ${t.status}，不是 queued`)
  }

  const deps = effectiveDeps(t)
  for (const d of deps) {
    const up = tasks.get(d.task)
    if (!up) {
      reasons.push(`依赖引用了不存在的任务 ${d.task}`)
      continue
    }
    if (d.kind === 'depends_on') {
      // 旧语义：与主协议 §5 逐字一致，只看 done，不看验收
      if (up.status !== 'done') reasons.push(`依赖 ${d.task} 未完成（当前 ${up.status}）`)
      continue
    }
    // 新语义（数据依赖）：产物要被下游读取，因此必须是**已验收**的 done
    if (up.status !== 'done') {
      reasons.push(`数据依赖 ${d.task} 未完成（当前 ${up.status}）`)
    } else if (!up.accepted) {
      reasons.push(`数据依赖 ${d.task} 尚未验收通过`)
    } else if (d.required !== false && typeof ctx.artifactExists === 'function'
      && !ctx.artifactExists(d.task, d.artifact)) {
      reasons.push(`上游产物缺失：${d.task}/${d.artifact}`)
    }
  }

  return { ready: reasons.length === 0, reasons, deps }
}

/**
 * 可派判定：图就绪 + fleet 现实约束（开关 / 判活 / 预算）。
 *
 * 方案 §3.4 的末两项——「图说可以做了，fleet 说现在能不能做」。
 *
 * @param {string} taskId
 * @param {object} ctx { tasks, artifactExists?, agentState?(agentId) → {enabled, alive, budgetOk, exists} }
 */
function evaluateDispatchable(taskId, ctx) {
  const graph = evaluateReadiness(taskId, ctx)
  const reasons = [...graph.reasons]
  const t = ctx.tasks.get(taskId)

  if (t) {
    if (!contract.isStr(t.assignee)) {
      reasons.push('未指定 assignee')
    } else if (typeof ctx.agentState === 'function') {
      const a = ctx.agentState(t.assignee)
      if (a === null || a === undefined) reasons.push(`agent 无档案: ${t.assignee}`)
      else {
        if (a.enabled === false) reasons.push(`agent ${t.assignee} 开关未开启（§4.2 派单许可）`)
        if (a.alive === false) reasons.push(`agent ${t.assignee} 判活失败（心跳过龄，F3）`)
        if (a.budgetOk === false) reasons.push(`agent ${t.assignee} 当日预算已熔断（§7.0）`)
      }
    }
  }

  return { ready: reasons.length === 0, reasons, graphReady: graph.ready, deps: graph.deps }
}

/**
 * 图就绪集（ready set）：依赖已满足、可以开工的任务。
 *
 * 对应 DynTaskMAS 的 ready-set 抽象——worker 的认领依据是**依赖满足**，
 * 而非轮次同步。**只看图，不看 fleet 现实**（开关/判活/预算）；
 * 要连现实约束一起看，用 dispatchableSet。
 *
 * 终态任务（done/cancelled）不进任何一边。
 */
function readySet(ctx) {
  const ready = []
  const blocked = []
  const finished = []
  for (const id of ctx.tasks.keys()) {
    const t = ctx.tasks.get(id)
    if (TERMINAL.has(t.status)) {
      finished.push(id)
      continue
    }
    const r = evaluateReadiness(id, ctx)
    if (r.ready) ready.push(id)
    else blocked.push({ taskId: id, status: t.status, reasons: r.reasons })
  }
  return { ready: ready.sort(), blocked, finished: finished.sort() }
}

/**
 * 可派集：图就绪 ∧ fleet 现实约束（assignee / 开关 / 判活 / 预算）。
 *
 * 与 readySet 的差值就是「图说可以做了，但 fleet 现在做不了」的那批任务——
 * 这个差值本身就是有用的诊断信号（例如"就绪 3 个，但唯一匹配的 agent 预算已熔断"）。
 */
function dispatchableSet(ctx) {
  const ready = []
  const blocked = []
  const finished = []
  for (const id of ctx.tasks.keys()) {
    const t = ctx.tasks.get(id)
    if (TERMINAL.has(t.status)) {
      finished.push(id)
      continue
    }
    const r = evaluateDispatchable(id, ctx)
    if (r.ready) ready.push(id)
    else blocked.push({ taskId: id, status: t.status, reasons: r.reasons, graphReady: r.graphReady })
  }
  return { ready: ready.sort(), blocked, finished: finished.sort() }
}

module.exports = {
  TERMINAL,
  foldTasks,
  effectiveDeps,
  buildGraph,
  groupSummary,
  legacyReady,
  evaluateReadiness,
  evaluateDispatchable,
  readySet,
  dispatchableSet,
}
