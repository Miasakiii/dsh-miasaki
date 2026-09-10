// bus-apply.test.mjs — G0 applier 端到端测试（2026-09-10）
//
// 直接调用 workers/lib/bus-apply-core.cjs（不 spawn 子进程）：
// 受限环境下子进程管道不可用，且核心逻辑本就该与命令行解耦。
// 每个用例在独立临时目录里跑，断言的是**文件真的被写成什么样**。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import core from '../workers/lib/bus-apply-core.cjs'

const sha = 'b'.repeat(64)

/** 建一个空工作区，并登记用例结束后的清理。 */
function freshRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-bus-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function readText(root, rel) {
  return readFileSync(join(root, rel), 'utf8')
}

function goodResult(taskId, over) {
  return {
    task_id: taskId,
    status: 'completed',
    conclusion: '结论',
    evidence: [{ type: 'file', ref: 'a.csv', sha256: sha }],
    artifacts: [{ path: 'a.csv', bytes: 3, sha256: sha }],
    ...over,
  }
}

function appendPatch(over) {
  return {
    op: 'append',
    path: 'state/graph-events.jsonl',
    value: { event: 'task.started', task_id: 't-0012' },
    author: 'dispatcher',
    expected_version: 0,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 基本提交与版本派生
// ---------------------------------------------------------------------------

test('首次提交：空总线版本为 0，提交后为 1，且版本可从事件流派生', (t) => {
  const root = freshRoot(t)
  assert.equal(core.readCurrentVersion(root), 0, '无事件流时版本为 0')

  const r = core.applyPatches(root, [{
    op: 'append',
    path: 'state/tasks.jsonl',
    value: { op: 'create', task: { id: 't-0001', status: 'queued' } },
    author: 'commander',
    expected_version: 0,
  }], {})

  assert.equal(r.ok, true, r.error)
  assert.equal(r.previousVersion, 0)
  assert.equal(r.currentVersion, 1)
  assert.equal(core.readCurrentVersion(root), 1, '版本必须能从事件流派生，不依赖独立状态文件')
  assert.equal(existsSync(join(root, 'state', 'bus-version.json')), false, '刻意不落版本文件')

  const tasks = core.readJsonl(join(root, 'state', 'tasks.jsonl'))
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].task.id, 't-0001')
})

test('事件由 applier 统一盖章 bus_version，调用方不必知道版本', (t) => {
  const root = freshRoot(t)
  core.applyPatches(root, [appendPatch()], {})

  const events = core.readEvents(root)
  const started = events.find((e) => e.event === 'task.started')
  assert.ok(started, '业务事件应已落盘')
  assert.equal(started.bus_version, 1, '补丁未给 bus_version，由 applier 填当前的超步版本')
  assert.equal(started.author, 'dispatcher', '作者继承补丁的 author')

  const commit = events.find((e) => e.event === 'superstep.committed')
  assert.ok(commit, '每个超步必须留下提交事件（版本的定义）')
  assert.equal(commit.bus_version, 1)
  assert.equal(commit.patch_count, 1)
  assert.equal(commit.author, 'applier')
})

test('多补丁一次提交 = 一个超步 = 一个版本号', (t) => {
  const root = freshRoot(t)
  const r = core.applyPatches(root, [
    appendPatch({ value: { event: 'task.started', task_id: 't-0012' } }),
    appendPatch({ value: { event: 'artifact.written', task_id: 't-0012', path: 'a.csv' } }),
    appendPatch({ value: { event: 'task.completed', task_id: 't-0012' } }),
  ], {})

  assert.equal(r.ok, true, r.error)
  assert.equal(r.patchCount, 3)
  assert.equal(r.currentVersion, 1, '三个补丁属于同一超步，只递增一次')

  const commits = core.readEvents(root).filter((e) => e.event === 'superstep.committed')
  assert.equal(commits.length, 1)
})

// ---------------------------------------------------------------------------
// 乐观并发（CAS）
// ---------------------------------------------------------------------------

test('版本冲突整体拒绝，不写入任何内容', (t) => {
  const root = freshRoot(t)
  core.applyPatches(root, [appendPatch()], {}) // 版本 → 1
  const before = readText(root, 'state/graph-events.jsonl')

  const r = core.applyPatches(root, [appendPatch({ expected_version: 0 })], {})
  assert.equal(r.ok, false)
  assert.equal(r.code, 3, '冲突必须用独立的退出码，便于调用方区分契约错误')
  assert.equal(r.conflict, true)
  assert.equal(r.currentVersion, 1, '拒绝时回报当前版本，调用方可直接重读重试')
  assert.equal(readText(root, 'state/graph-events.jsonl'), before, '冲突时总线不得被改动')
})

test('同批补丁中任一版本过期 → 整批拒绝（不做部分提交）', (t) => {
  const root = freshRoot(t)
  core.applyPatches(root, [appendPatch()], {})

  const r = core.applyPatches(root, [
    appendPatch({ expected_version: 1 }),
    appendPatch({ expected_version: 0 }), // 过期
  ], {})
  assert.equal(r.code, 3)
  assert.equal(core.readCurrentVersion(root), 1, '整批拒绝后版本不变')
})

// ---------------------------------------------------------------------------
// 契约闸门
// ---------------------------------------------------------------------------

test('未登记路径被拒，且不写入', (t) => {
  const root = freshRoot(t)
  const r = core.applyPatches(root, [{
    op: 'set', path: 'workers/validate-bus.mjs', value: {}, author: 'commander', expected_version: 0, reason: 'x',
  }], {})
  assert.equal(r.code, 2)
  assert.match(r.error, /不在可写白名单内/)
  assert.equal(existsSync(join(root, 'workers')), false, '被拒的补丁不得创建任何文件')
})

test('result.json：合法契约写入成功，非法契约被拒在总线之外', (t) => {
  const root = freshRoot(t)

  // 合法
  const ok = core.applyPatches(root, [{
    op: 'set',
    path: 'tasks/t-0012/result.json',
    value: goodResult('t-0012'),
    author: 'dispatcher',
    expected_version: 0,
    reason: '交付物落盘',
  }], {})
  assert.equal(ok.ok, true, ok.error)
  const written = JSON.parse(readText(root, 'tasks/t-0012/result.json'))
  assert.equal(written.task_id, 't-0012')
  assert.equal(written.artifacts[0].sha256, sha)

  // 非法：缺 evidence（下游 consumes 校验的依据）
  const bad = core.applyPatches(root, [{
    op: 'set',
    path: 'tasks/t-0013/result.json',
    value: { task_id: 't-0013', status: 'completed', conclusion: 'x' },
    author: 'dispatcher',
    expected_version: 1,
    reason: '交付物落盘',
  }], {})
  assert.equal(bad.code, 2)
  assert.match(bad.error, /evidence 应为 array/)
  assert.equal(existsSync(join(root, 'tasks', 't-0013', 'result.json')), false, '非法结果不得落盘')
})

test('result.json 的 task_id 与目录不符 → 拒绝（防张冠李戴）', (t) => {
  const root = freshRoot(t)
  const r = core.applyPatches(root, [{
    op: 'set',
    path: 'tasks/t-0012/result.json',
    value: goodResult('t-0099'),
    author: 'dispatcher',
    expected_version: 0,
    reason: 'x',
  }], {})
  assert.equal(r.code, 2)
  assert.match(r.error, /与所在任务目录不一致/)
})

test('非法事件（未登记类型）被拒在总线之外', (t) => {
  const root = freshRoot(t)
  const r = core.applyPatches(root, [appendPatch({ value: { event: 'task.exploded', task_id: 't-0012' } })], {})
  assert.equal(r.code, 2)
  assert.match(r.error, /event 类型非法/)
  assert.equal(core.readEvents(root).length, 0, '坏事件不得进总线')
})

test('目录穿越被拒', (t) => {
  const root = freshRoot(t)
  const r = core.applyPatches(root, [{
    op: 'append', path: 'state/../state/tasks.jsonl', value: {}, author: 'commander', expected_version: 0,
  }], {})
  // 归一化后仍在白名单内则放行；逃出工作区才拒绝 —— 这里验证后者
  const escape = core.applyPatches(root, [{
    op: 'append', path: '../../outside.jsonl', value: {}, author: 'commander', expected_version: 0,
  }], {})
  assert.equal(escape.code, 2)
  assert.match(escape.error, /不在可写白名单内|逃出工作区/)
  assert.ok(r.code === 0 || r.code === 2, '归一化路径的判定允许两种结果，但绝不能写到工作区外')
})

// ---------------------------------------------------------------------------
// merge 与 --check
// ---------------------------------------------------------------------------

test('merge 在已有内容上浅合并（能力图回填 confidence 的场景）', (t) => {
  const root = freshRoot(t)
  core.applyPatches(root, [{
    op: 'set',
    path: 'agents/scout/capability.json',
    value: { version: 1, agent_id: 'scout', nodes: [], edges: [] },
    author: 'scanner',
    expected_version: 0,
    reason: '扫描生成',
  }], {})

  const r = core.applyPatches(root, [{
    op: 'merge',
    path: 'agents/scout/capability.json',
    value: { generated_at: '2026-09-10T00:00:00Z' },
    author: 'commander',
    expected_version: 1,
    reason: '回填 confidence',
  }], {})
  assert.equal(r.ok, true, r.error)

  const cap = JSON.parse(readText(root, 'agents/scout/capability.json'))
  assert.equal(cap.agent_id, 'scout', 'merge 必须保留原有键')
  assert.equal(cap.generated_at, '2026-09-10T00:00:00Z')
})

test('--check 只校验不写入，但报告将要变成的版本', (t) => {
  const root = freshRoot(t)
  const r = core.applyPatches(root, [appendPatch()], { check: true })

  assert.equal(r.ok, true, r.error)
  assert.equal(r.check, true)
  assert.equal(r.previousVersion, 0)
  assert.equal(r.currentVersion, 1, 'dry-run 也要报出下一版本，便于调用方预判')
  assert.equal(core.readCurrentVersion(root), 0, 'dry-run 不得改变版本')
  assert.equal(existsSync(join(root, 'state', 'graph-events.jsonl')), false, 'dry-run 不得落盘')
})

// ---------------------------------------------------------------------------
// 确定性与可重放性
// ---------------------------------------------------------------------------

test('确定性：同一组补丁无论以什么顺序提交，落盘顺序与结果都相同', (t) => {
  const a = { op: 'append', path: 'state/tasks.jsonl', value: { op: 'create', task: { id: 't-0002' } }, author: 'commander', expected_version: 0 }
  const b = { op: 'append', path: 'state/tasks.jsonl', value: { op: 'create', task: { id: 't-0001' } }, author: 'dispatcher', expected_version: 0 }
  const c = { op: 'append', path: 'state/graph-events.jsonl', value: { event: 'task.started', task_id: 't-0001' }, author: 'dispatcher', expected_version: 0 }

  const root1 = freshRoot(t)
  const root2 = freshRoot(t)
  const root3 = freshRoot(t)
  core.applyPatches(root1, [a, b, c], {})
  core.applyPatches(root2, [c, b, a], {})
  core.applyPatches(root3, [b, c, a], {})

  const norm = (root) => readText(root, 'state/tasks.jsonl')
  assert.equal(norm(root1), norm(root2), '到达顺序不得影响落盘顺序（否则重放不可复现）')
  assert.equal(norm(root2), norm(root3))

  // 事件流里除 ts 外也应一致
  const eventsOf = (root) => core.readEvents(root).map((e) => `${e.event}|${e.author}|${e.task_id || ''}`)
  assert.deepEqual(eventsOf(root1), eventsOf(root2))
  assert.deepEqual(eventsOf(root2), eventsOf(root3))
})

test('空补丁列表被拒（不产生空超步）', (t) => {
  const root = freshRoot(t)
  const r = core.applyPatches(root, [], {})
  assert.equal(r.code, 2)
  assert.match(r.error, /没有补丁/)
  assert.equal(core.readCurrentVersion(root), 0)
})

test('连续超步版本单调递增', (t) => {
  const root = freshRoot(t)
  for (let i = 1; i <= 3; i++) {
    const r = core.applyPatches(root, [appendPatch({ expected_version: i - 1, value: { event: 'task.started', task_id: `t-00${10 + i}` } })], {})
    assert.equal(r.ok, true, r.error)
    assert.equal(r.currentVersion, i)
  }
  assert.equal(core.readCurrentVersion(root), 3)
})
