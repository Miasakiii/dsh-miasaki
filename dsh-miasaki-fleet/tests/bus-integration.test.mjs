// bus-integration.test.mjs — G0 集成测试（2026-09-10）
//
// 覆盖 bus-contract / bus-apply 单测覆盖不到的部分：**validate-bus.mjs 新增的
// 图校验路径**（任务图引用完整性、钻石图分组、事件流版本单调性、result.json）。
// 这些代码在真实数据里要等到有人入图才会执行，若不在此处验证，等于从未跑过。
//
// 做法：在临时目录搭一个最小合法总线（BUS_ROOT 覆盖），用 spawnSync 调
// validate-bus.mjs，断言退出码。子进程 stdio 用 'ignore' —— 受限沙箱下
// 管道捕获会 EPERM，而 ignore 不会；代价是拿不到输出，因此断言只看退出码。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import core from '../workers/lib/bus-apply-core.cjs'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VALIDATE = join(FLEET_DIR, 'workers', 'validate-bus.mjs')

const sha = 'c'.repeat(64)

function writeJsonl(p, rows) {
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
}

/**
 * 搭一个最小合法总线。validate-bus 要求 registry / tasks / ledger / events
 * 四个文件存在，因此全部创建（后三者可为空）。
 */
function makeBus(t, opts) {
  const o = opts || {}
  const root = mkdtempSync(join(tmpdir(), 'fleet-it-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(join(root, 'agents', 'registry.json'), '[]\n', 'utf8')
  writeJsonl(join(root, 'state', 'tasks.jsonl'), o.tasks || [])
  writeFileSync(join(root, 'state', 'ledger.jsonl'), '', 'utf8')
  writeFileSync(join(root, 'state', 'events.jsonl'), '', 'utf8')
  if (o.events) writeJsonl(join(root, 'state', 'graph-events.jsonl'), o.events)

  for (const [id, result] of Object.entries(o.results || {})) {
    mkdirSync(join(root, 'tasks', id), { recursive: true })
    writeFileSync(join(root, 'tasks', id, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
  return root
}

/** 跑 validate-bus，返回退出码。spawn 本身失败返回 -1。 */
function validate(root) {
  const r = spawnSync(process.execPath, [VALIDATE], {
    cwd: FLEET_DIR,
    env: { ...process.env, BUS_ROOT: root },
    stdio: 'ignore',
  })
  if (r.error) return -1
  return r.status
}

function task(id, graph, over) {
  return { op: 'create', task: { id, title: `任务 ${id}`, status: 'queued', ...(graph ? { graph } : {}), ...over } }
}

/** 一个完整的钻石图：fan_out → 2 路并行 work → reduce。 */
function diamond() {
  return [
    task('t-0009', { node_kind: 'fan_out', group: 'g-0001' }),
    task('t-0010', { node_kind: 'work', group: 'g-0001', parent: 't-0009' }),
    task('t-0011', { node_kind: 'work', group: 'g-0001', parent: 't-0009' }),
    task('t-0012', {
      node_kind: 'reduce',
      group: 'g-0001',
      parent: 't-0009',
      consumes: [
        { task: 't-0010', artifact: 'result.json' },
        { task: 't-0011', artifact: 'result.json' },
      ],
    }),
  ]
}

// ---------------------------------------------------------------------------

test('基线：没有 graph 字段的旧总线照常通过（增量式采用的前提）', (t) => {
  const root = makeBus(t, { tasks: [task('t-0001'), task('t-0002')] })
  assert.equal(validate(root), 0, '未入图的总线必须与 G0 之前完全一致')
})

test('合法钻石图通过（fan_out → 并行 work → reduce）', (t) => {
  const root = makeBus(t, { tasks: diamond() })
  assert.equal(validate(root), 0)
})

test('consumes 引用不存在的任务 → 校验失败', (t) => {
  const root = makeBus(t, {
    tasks: [
      task('t-0001'),
      task('t-0002', { node_kind: 'reduce', consumes: [{ task: 't-0099', artifact: 'result.json' }] }),
    ],
  })
  assert.equal(validate(root), 1, '悬空的 consumes 边必须在巡检时暴露')
})

test('consumes 指向自己 → 校验失败', (t) => {
  const root = makeBus(t, {
    tasks: [task('t-0001', { node_kind: 'work', consumes: [{ task: 't-0001', artifact: 'result.json' }] })],
  })
  assert.equal(validate(root), 1)
})

test('parent 引用不存在的任务 → 校验失败', (t) => {
  const root = makeBus(t, {
    tasks: [task('t-0001', { node_kind: 'work', parent: 't-0099' })],
  })
  assert.equal(validate(root), 1)
})

test('同一 group 出现两个 reduce → 校验失败（汇合点必须唯一）', (t) => {
  const root = makeBus(t, {
    tasks: [
      task('t-0010', { node_kind: 'work', group: 'g-0001' }),
      task('t-0011', { node_kind: 'work', group: 'g-0001' }),
      task('t-0012', { node_kind: 'reduce', group: 'g-0001', consumes: [{ task: 't-0010', artifact: 'result.json' }] }),
      task('t-0013', { node_kind: 'reduce', group: 'g-0001', consumes: [{ task: 't-0011', artifact: 'result.json' }] }),
    ],
  })
  assert.equal(validate(root), 1)
})

test('reduce 缺 consumes → 契约校验失败（在 validate 侧同样拦截）', (t) => {
  const root = makeBus(t, { tasks: [task('t-0012', { node_kind: 'reduce', group: 'g-0001' })] })
  assert.equal(validate(root), 1)
})

test('事件流：合法的递增提交版本通过', (t) => {
  const root = makeBus(t, {
    tasks: [task('t-0001')],
    events: [
      { ts: '2026-09-10T00:00:00Z', event: 'task.created', author: 'commander', bus_version: 1, task_id: 't-0001', reason: '建任务' },
      { ts: '2026-09-10T00:00:01Z', event: 'superstep.committed', author: 'applier', bus_version: 1 },
      { ts: '2026-09-10T00:00:02Z', event: 'task.started', author: 'dispatcher', bus_version: 2, task_id: 't-0001' },
      { ts: '2026-09-10T00:00:03Z', event: 'superstep.committed', author: 'applier', bus_version: 2 },
    ],
  })
  assert.equal(validate(root), 0)
})

test('事件流：提交版本不递增 → 校验失败（版本定义 fold 边界，回退即损坏）', (t) => {
  const dup = makeBus(t, {
    tasks: [task('t-0001')],
    events: [
      { ts: '2026-09-10T00:00:01Z', event: 'superstep.committed', author: 'applier', bus_version: 1 },
      { ts: '2026-09-10T00:00:02Z', event: 'superstep.committed', author: 'applier', bus_version: 1 },
    ],
  })
  assert.equal(validate(dup), 1, '重复版本号必须失败')

  const backward = makeBus(t, {
    tasks: [task('t-0001')],
    events: [
      { ts: '2026-09-10T00:00:01Z', event: 'superstep.committed', author: 'applier', bus_version: 5 },
      { ts: '2026-09-10T00:00:02Z', event: 'superstep.committed', author: 'applier', bus_version: 2 },
    ],
  })
  assert.equal(validate(backward), 1, '版本回退必须失败')
})

test('事件流：非法事件（未登记类型 / 缺 reason）→ 校验失败', (t) => {
  const badType = makeBus(t, {
    tasks: [task('t-0001')],
    events: [{ ts: '2026-09-10T00:00:00Z', event: 'task.exploded', author: 'commander', bus_version: 1 }],
  })
  assert.equal(validate(badType), 1)

  const noReason = makeBus(t, {
    tasks: [task('t-0001')],
    events: [{ ts: '2026-09-10T00:00:00Z', event: 'task.created', author: 'commander', bus_version: 1, task_id: 't-0001' }],
  })
  assert.equal(validate(noReason), 1, '变更类事件缺 reason 必须失败')
})

test('result.json：合法通过，非法（缺 evidence / task_id 不符）失败', (t) => {
  const good = makeBus(t, {
    tasks: [task('t-0001')],
    results: {
      't-0001': {
        task_id: 't-0001',
        status: 'completed',
        conclusion: '结论',
        evidence: [{ type: 'file', ref: 'a.csv', sha256: sha }],
        artifacts: [{ path: 'a.csv', bytes: 1, sha256: sha }],
      },
    },
  })
  assert.equal(validate(good), 0)

  const noEvidence = makeBus(t, {
    tasks: [task('t-0001')],
    results: { 't-0001': { task_id: 't-0001', status: 'completed', conclusion: '结论' } },
  })
  assert.equal(validate(noEvidence), 1)

  const mismatched = makeBus(t, {
    tasks: [task('t-0001')],
    results: {
      't-0001': {
        task_id: 't-0002',
        status: 'completed',
        conclusion: '结论',
        evidence: [],
      },
    },
  })
  assert.equal(validate(mismatched), 1, 'task_id 与目录不符必须失败')
})

// ---------------------------------------------------------------------------
// 闭环：applier 写入 → 巡检通过
// ---------------------------------------------------------------------------

test('闭环：经 applier 写入的图与事件，validate-bus 立即通过', (t) => {
  const root = makeBus(t, { tasks: [] })

  // 用 applier 建一个带图的钻石结构（t-0009 fan_out + t-0010 work）
  const r1 = core.applyPatches(root, [
    {
      op: 'append',
      path: 'state/tasks.jsonl',
      value: task('t-0009', { node_kind: 'fan_out', group: 'g-0001' }),
      author: 'commander',
      expected_version: 0,
    },
    {
      op: 'append',
      path: 'state/tasks.jsonl',
      value: task('t-0010', { node_kind: 'work', group: 'g-0001', parent: 't-0009' }),
      author: 'commander',
      expected_version: 0,
    },
    {
      op: 'append',
      path: 'state/graph-events.jsonl',
      value: { event: 'task.created', task_id: 't-0009', reason: '拆解' },
      author: 'commander',
      expected_version: 0,
    },
  ], {})
  assert.equal(r1.ok, true, r1.error)
  assert.equal(r1.currentVersion, 1)

  assert.equal(validate(root), 0, 'applier 写入后总线段必须自洽')

  // 再提交一个 result.json（走同一入口）
  const r2 = core.applyPatches(root, [{
    op: 'set',
    path: 'tasks/t-0010/result.json',
    value: {
      task_id: 't-0010',
      status: 'completed',
      conclusion: '完成',
      evidence: [{ type: 'task', ref: 't-0009' }],
      artifacts: [{ path: 'a.txt', bytes: 2, sha256: sha }],
    },
    author: 'dispatcher',
    expected_version: 1,
    reason: '交付',
  }], {})
  assert.equal(r2.ok, true, r2.error)
  assert.equal(validate(root), 0, '交付物写入后仍须自洽')
})

test('闭环：applier 拒绝的补丁不会污染总线（巡检仍通过）', (t) => {
  const root = makeBus(t, { tasks: [task('t-0001')] })

  // 悬空的 consumes：applier 只校验补丁自身的合法性，引用完整性由巡检负责。
  // 因此这一条应当**写入成功**，但要能被巡检抓出来 —— 这正是两层各管一段的意义。
  const r = core.applyPatches(root, [{
    op: 'append',
    path: 'state/tasks.jsonl',
    value: task('t-0002', { node_kind: 'reduce', consumes: [{ task: 't-0099', artifact: 'result.json' }] }),
    author: 'commander',
    expected_version: 0,
  }], {})
  assert.equal(r.ok, true, r.error)
  assert.equal(validate(root), 1, '写入时放行的悬空引用，必须由巡检拦下')
})
