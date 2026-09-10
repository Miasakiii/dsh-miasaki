// task-graph.test.mjs — G1 任务图与就绪度判定单测（2026-09-10）
//
// 两组重点：
//   1. **等价性**：对无 graph 字段的任务，新判定必须与主协议 §5 的旧规则
//      （legacyReady）逐字一致 —— 这是 G1「零行为变更」的证明，而非口头承诺。
//   2. **consume 语义**：数据依赖比时序依赖严格（要求上游已验收 + 产物存在）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  buildGraph,
  dispatchableSet,
  effectiveDeps,
  evaluateDispatchable,
  evaluateReadiness,
  foldTasks,
  groupSummary,
  legacyReady,
  readySet,
} from '../workers/lib/task-graph.mjs'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s
}

function readJsonl(p) {
  return stripBom(readFileSync(p, 'utf8'))
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/** 造一条 create 行。 */
function create(id, over) {
  return { op: 'create', task: { id, title: `任务 ${id}`, status: 'queued', ...over } }
}

/** 只检查依赖、不做产物检查的 ctx。 */
function ctxOf(rows, opts) {
  const tasks = foldTasks(rows)
  return { tasks, artifactExists: (opts && opts.artifactExists) || (() => true) }
}

// ---------------------------------------------------------------------------
// 台账重放
// ---------------------------------------------------------------------------

test('foldTasks：按 task_id 重放最后一条相关记录', () => {
  const tasks = foldTasks([
    create('t-0001'),
    { op: 'assign', task_id: 't-0001', assignee: 'scout' },
    { op: 'update', task_id: 't-0001', status: 'running' },
    { op: 'update', task_id: 't-0001', status: 'done' },
  ])
  const t = tasks.get('t-0001')
  assert.equal(t.status, 'done')
  assert.equal(t.assignee, 'scout')
  assert.equal(t.accepted, false, 'worker 交付的 done 不等于已验收')
})

test('foldTasks：验收标记与 reopen 的相互作用', () => {
  const accepted = foldTasks([
    create('t-0001'),
    { op: 'update', task_id: 't-0001', status: 'done' },
    { op: 'update', task_id: 't-0001', status: 'done', accepted: true },
  ])
  assert.equal(accepted.get('t-0001').accepted, true)

  // reopen 让验收失效并回到队列 —— 否则重开的任务会被下游当作已通过
  const reopened = foldTasks([
    create('t-0001'),
    { op: 'update', task_id: 't-0001', status: 'done', accepted: true },
    { op: 'reopen', task_id: 't-0001', reason: '结论缺来源' },
  ])
  assert.equal(reopened.get('t-0001').status, 'queued')
  assert.equal(reopened.get('t-0001').accepted, false)
})

test('foldTasks：cancel 置终态，悬空记录被跳过（那是巡检的职责）', () => {
  const tasks = foldTasks([
    create('t-0001'),
    { op: 'cancel', task_id: 't-0001' },
    { op: 'update', task_id: 't-9999', status: 'done' }, // 无对应 create
  ])
  assert.equal(tasks.get('t-0001').status, 'cancelled')
  assert.equal(tasks.size, 1, '悬空记录不得凭空造出任务')
})

// ---------------------------------------------------------------------------
// 依赖的两种语义
// ---------------------------------------------------------------------------

test('effectiveDeps：有 consumes 用 consumes，否则回退 depends_on', () => {
  const withConsumes = {
    id: 't-0002',
    depends_on: ['t-0001'],
    graph: { node_kind: 'reduce', consumes: [{ task: 't-0003', artifact: 'result.json' }] },
  }
  assert.deepEqual(effectiveDeps(withConsumes), [
    { kind: 'consumes', task: 't-0003', artifact: 'result.json', required: true },
  ], 'consumes 存在时覆盖 depends_on')

  const oldStyle = { id: 't-0002', depends_on: ['t-0001'], graph: null }
  assert.deepEqual(effectiveDeps(oldStyle), [{ kind: 'depends_on', task: 't-0001' }])

  // 有 graph 但没声明 consumes → 仍回退旧语义（增量式采用）
  const graphNoConsumes = { id: 't-0002', depends_on: ['t-0001'], graph: { node_kind: 'work' } }
  assert.deepEqual(effectiveDeps(graphNoConsumes), [{ kind: 'depends_on', task: 't-0001' }])
})

test('consumes 比 depends_on 严格：要求上游已验收 + 产物存在', () => {
  const base = [
    create('t-0001'),
    { op: 'update', task_id: 't-0001', status: 'done' }, // done 但未验收
    create('t-0002', {
      graph: { node_kind: 'work', consumes: [{ task: 't-0001', artifact: 'result.json' }] },
    }),
  ]
  const notAccepted = evaluateReadiness('t-0002', ctxOf(base))
  assert.equal(notAccepted.ready, false)
  assert.match(notAccepted.reasons.join(' '), /尚未验收通过/)

  const accepted = [
    create('t-0001'),
    { op: 'update', task_id: 't-0001', status: 'done', accepted: true },
    create('t-0002', {
      graph: { node_kind: 'work', consumes: [{ task: 't-0001', artifact: 'result.json' }] },
    }),
  ]
  assert.equal(evaluateReadiness('t-0002', ctxOf(accepted)).ready, true)

  // 已验收但产物缺失 → 仍不就绪（数据依赖的核心：读的是文件，不是状态）
  const missing = evaluateReadiness('t-0002', ctxOf(accepted, { artifactExists: () => false }))
  assert.equal(missing.ready, false)
  assert.match(missing.reasons.join(' '), /上游产物缺失/)

  // required:false 的可选输入缺产物不挡路
  const optional = [
    ...accepted.slice(0, 2),
    create('t-0003', {
      graph: { node_kind: 'work', consumes: [{ task: 't-0001', artifact: 'opt.json', required: false }] },
    }),
  ]
  assert.equal(evaluateReadiness('t-0003', ctxOf(optional, { artifactExists: () => false })).ready, true)
})

test('钻石图：reduce 必须等到所有 work 验收完成且产物齐备', () => {
  const rows = [
    create('t-0009', { graph: { node_kind: 'fan_out', group: 'g-0001' } }),
    create('t-0010', { graph: { node_kind: 'work', group: 'g-0001', parent: 't-0009' } }),
    create('t-0011', { graph: { node_kind: 'work', group: 'g-0001', parent: 't-0009' } }),
    create('t-0012', {
      graph: {
        node_kind: 'reduce',
        group: 'g-0001',
        parent: 't-0009',
        consumes: [
          { task: 't-0010', artifact: 'result.json' },
          { task: 't-0011', artifact: 'result.json' },
        ],
      },
    }),
    { op: 'update', task_id: 't-0010', status: 'done', accepted: true },
  ]

  const half = evaluateReadiness('t-0012', ctxOf(rows))
  assert.equal(half.ready, false)
  assert.match(half.reasons.join(' '), /t-0011 未完成/)

  const full = [
    ...rows,
    { op: 'update', task_id: 't-0011', status: 'done', accepted: true },
  ]
  assert.equal(evaluateReadiness('t-0012', ctxOf(full)).ready, true)

  // 组摘要供诊断，不参与判定
  const summary = groupSummary(foldTasks(full), 'g-0001')
  assert.equal(summary.counts.total, 4)
  assert.equal(summary.counts.accepted, 2)
  assert.equal(summary.reduceId, 't-0012')
})

test('就绪集：无依赖的任务直接就绪，广播扇出真的能并行', () => {
  const rows = [
    create('t-0009', { graph: { node_kind: 'fan_out', group: 'g-0001' } }),
    create('t-0010', { graph: { node_kind: 'work', group: 'g-0001' } }),
    create('t-0011', { graph: { node_kind: 'work', group: 'g-0001' } }),
    create('t-0012', { graph: { node_kind: 'work', group: 'g-0001' } }),
  ]
  const { ready } = readySet(ctxOf(rows))
  assert.deepEqual(ready, ['t-0009', 't-0010', 't-0011', 't-0012'],
    '三者互不依赖 → 必须同时出现在就绪集（旧规则做不到）')
})

// ---------------------------------------------------------------------------
// ★ 等价性：无 graph 的任务，新旧判定必须一致
// ---------------------------------------------------------------------------

test('等价性：手工构造的状态组合下，新判定与旧规则逐字一致', () => {
  const statuses = ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled']
  const acceptedFlags = [false, true]

  for (const upStatus of statuses) {
    for (const upAccepted of acceptedFlags) {
      for (const selfStatus of statuses) {
        const rows = [
          create('t-0001'),
          { op: 'update', task_id: 't-0001', status: upStatus, ...(upAccepted ? { accepted: true } : {}) },
          create('t-0002', { depends_on: ['t-0001'] }),
          { op: 'update', task_id: 't-0002', status: selfStatus },
        ]
        const ctx = ctxOf(rows)
        const oldWay = legacyReady(ctx.tasks.get('t-0002'), ctx.tasks)
        const newWay = evaluateReadiness('t-0002', ctx).ready
        assert.equal(
          newWay, oldWay,
          `不一致：上游=${upStatus}${upAccepted ? '(accepted)' : ''} 自身=${selfStatus} → 旧 ${oldWay} / 新 ${newWay}`,
        )
      }
    }
  }
})

test('等价性：真实台账（state/tasks.jsonl）上新旧判定完全一致', () => {
  const rows = readJsonl(join(FLEET_DIR, 'state', 'tasks.jsonl'))
  const ctx = ctxOf(rows)
  assert.ok(ctx.tasks.size > 0, '真实台账不该是空的')

  let compared = 0
  for (const [id, task] of ctx.tasks) {
    if (task.graph !== null) continue // 已入图的任务本就走新语义，不参与等价性比对
    const oldWay = legacyReady(task, ctx.tasks)
    const newWay = evaluateReadiness(id, ctx).ready
    assert.equal(newWay, oldWay, `真实台账不一致：${id} → 旧 ${oldWay} / 新 ${newWay}`)
    compared++
  }
  assert.ok(compared >= 8, `至少应比对 8 个真实任务，实际 ${compared}`)
})

// ---------------------------------------------------------------------------
// 可派判定：图就绪之上叠加 fleet 现实约束
// ---------------------------------------------------------------------------

test('可派 = 图就绪 + assignee + 开关 + 判活 + 预算', () => {
  const rows = [
    create('t-0001', { assignee: 'scout' }),
  ]
  const tasks = foldTasks(rows)

  const ok = evaluateDispatchable('t-0001', {
    tasks,
    agentState: () => ({ enabled: true, alive: true, budgetOk: true }),
  })
  assert.equal(ok.ready, true, ok.reasons.join(' '))

  const cases = [
    [{ enabled: false, alive: true, budgetOk: true }, /开关未开启/],
    [{ enabled: true, alive: false, budgetOk: true }, /判活失败/],
    [{ enabled: true, alive: true, budgetOk: false }, /预算已熔断/],
  ]
  for (const [state, re] of cases) {
    const r = evaluateDispatchable('t-0001', { tasks, agentState: () => state })
    assert.equal(r.ready, false)
    assert.match(r.reasons.join(' '), re)
    assert.equal(r.graphReady, true, '图本身是就绪的，被现实约束挡住 —— 两者要能区分')
  }

  // 未指定 assignee
  const noAssignee = evaluateDispatchable('t-0001', { tasks: foldTasks([create('t-0001')]) })
  assert.match(noAssignee.reasons.join(' '), /未指定 assignee/)

  // agent 无档案
  const noProfile = evaluateDispatchable('t-0001', { tasks, agentState: () => null })
  assert.match(noProfile.reasons.join(' '), /agent 无档案/)
})

test('就绪集 vs 可派集：差值就是「图能做但 fleet 做不了」的那批', () => {
  const rows = [
    create('t-0001', { assignee: 'scout' }),
    create('t-0002', { assignee: 'scout' }),
    create('t-0003'), // 未指定 assignee
    { op: 'update', task_id: 't-0002', status: 'running' },
  ]
  const tasks = foldTasks(rows)
  const ctx = { tasks, agentState: () => ({ enabled: true, alive: true, budgetOk: true }) }

  // 图就绪：t-0001 与 t-0003 都可开工（t-0003 只是还没分配）
  const graphView = readySet(ctx)
  assert.deepEqual(graphView.ready, ['t-0001', 't-0003'])

  // 可派：t-0003 被 assignee 缺失挡住
  const dispatchView = dispatchableSet(ctx)
  assert.deepEqual(dispatchView.ready, ['t-0001'])
  assert.equal(dispatchView.blocked.length, 2)
  const t3 = dispatchView.blocked.find((b) => b.taskId === 't-0003')
  assert.match(t3.reasons.join(' '), /未指定 assignee/)
  assert.equal(t3.graphReady, true, '它图上是就绪的，缺的是分配 —— 两者必须可区分')
})

test('就绪集：终态任务不进任何一边', () => {
  const rows = [
    create('t-0001', { assignee: 'scout' }),
    create('t-0002', { assignee: 'scout' }),
    { op: 'update', task_id: 't-0002', status: 'done', accepted: true },
    { op: 'cancel', task_id: 't-0002' },
  ]
  const tasks = foldTasks(rows)
  const r = dispatchableSet({ tasks, agentState: () => ({ enabled: true, alive: true, budgetOk: true }) })

  assert.deepEqual(r.ready, ['t-0001'])
  assert.deepEqual(r.finished, ['t-0002'], '已取消的任务是终态')
  assert.equal(r.blocked.length, 0)
})

// ---------------------------------------------------------------------------
// 图结构问题
// ---------------------------------------------------------------------------

test('buildGraph：暴露悬挂引用与自环（不负责契约形态，那是 bus-contract 的职责）', () => {
  const tasks = foldTasks([
    create('t-0001', { depends_on: ['t-0099'] }),
    create('t-0002', { graph: { node_kind: 'work', consumes: [{ task: 't-0002', artifact: 'x' }] } }),
    create('t-0003', { graph: { node_kind: 'work', parent: 't-0099' } }),
  ])
  const g = buildGraph(tasks)
  const kinds = g.issues.map((i) => i.kind).sort()
  assert.deepEqual(kinds, ['dangling', 'dangling_parent', 'self_loop'])
})
