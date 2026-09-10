// bus-contract.test.mjs — G0 总线契约校验单测（2026-09-10）
//
// 覆盖 graph / result / event / patch 四类契约与超步版本派生。
// 这些是 applier 与 validate-bus 共用的唯一口径，一旦放松，
// 坏数据会直接进总线，因此边界条件优先于happy path。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_EVENT_BYTES,
  currentBusVersion,
  makeEvent,
  sortPatchesDeterministic,
  validateEvent,
  validateGraph,
  validatePatch,
  validateResult,
} from '../workers/lib/bus-contract.mjs'

/** 收集校验错误，便于断言「通过了」或「报了哪些错」。 */
function check(fn) {
  const errs = []
  const pass = fn((where, msg) => errs.push(`${where}: ${msg}`))
  return { pass, errs, text: errs.join(' | ') }
}

const sha = 'a'.repeat(64)

// ---------------------------------------------------------------------------
// graph 子对象
// ---------------------------------------------------------------------------

test('graph：合法节点通过，缺失字段不算错误（增量式采用）', () => {
  assert.equal(check((f) => validateGraph(undefined, 'g', f)).errs.length, 0, '无 graph = 不入图，等同现状')
  const ok = check((f) => validateGraph({ node_kind: 'work' }, 'g', f))
  assert.equal(ok.pass, true, ok.text)
})

test('graph：node_kind 必须在枚举内', () => {
  const bad = check((f) => validateGraph({ node_kind: 'parallel' }, 'g', f))
  assert.equal(bad.pass, false)
  assert.match(bad.text, /node_kind 非法/)
})

test('graph：reduce / verify 必须声明非空 consumes（否则汇合点没有意义）', () => {
  const reduce = check((f) => validateGraph({ node_kind: 'reduce' }, 'g', f))
  assert.match(reduce.text, /reduce 必须声明非空 consumes/)

  const verify = check((f) => validateGraph({ node_kind: 'verify', consumes: [] }, 'g', f))
  assert.match(verify.text, /verify 必须声明非空 consumes/)

  // fan_out 拆解任务，允许无上游
  const fanOut = check((f) => validateGraph({ node_kind: 'fan_out' }, 'g', f))
  assert.equal(fanOut.pass, true, fanOut.text)
})

test('graph：consumes 的边必须按数据命名（task + artifact）', () => {
  const noArtifact = check((f) => validateGraph({
    node_kind: 'work',
    consumes: [{ task: 't-0010' }],
  }, 'g', f))
  assert.match(noArtifact.text, /缺少 artifact/)

  const badTask = check((f) => validateGraph({
    node_kind: 'work',
    consumes: [{ task: 'task-10', artifact: 'result.json' }],
  }, 'g', f))
  assert.match(badTask.text, /task 形态非法/)

  const dup = check((f) => validateGraph({
    node_kind: 'reduce',
    consumes: [
      { task: 't-0010', artifact: 'result.json' },
      { task: 't-0010', artifact: 'other.json' },
    ],
  }, 'g', f))
  assert.match(dup.text, /重复声明同一上游/)
})

test('graph：group / parent 形态约束', () => {
  const badGroup = check((f) => validateGraph({ node_kind: 'work', group: 'group-3' }, 'g', f))
  assert.match(badGroup.text, /group 形态非法/)

  const badParent = check((f) => validateGraph({ node_kind: 'work', parent: '009' }, 'g', f))
  assert.match(badParent.text, /parent 形态非法/)

  const ok = check((f) => validateGraph({ node_kind: 'work', group: 'g-0003', parent: 't-0009' }, 'g', f))
  assert.equal(ok.pass, true, ok.text)
})

// ---------------------------------------------------------------------------
// result.json 节点交付契约
// ---------------------------------------------------------------------------

function goodResult(over) {
  return {
    task_id: 't-0012',
    status: 'completed',
    conclusion: '结论一句话',
    completeness: { done: ['项A'], missing: [] },
    evidence: [{ type: 'file', ref: 'artifacts/a.csv', sha256: sha }],
    artifacts: [{ path: 'artifacts/a.csv', bytes: 12, sha256: sha }],
    ...over,
  }
}

test('result：完整契约通过', () => {
  const r = check((f) => validateResult(goodResult(), 'r', f, 't-0012'))
  assert.equal(r.pass, true, r.text)
})

test('result：task_id 必须与所在任务目录一致（防张冠李戴）', () => {
  const r = check((f) => validateResult(goodResult(), 'r', f, 't-0099'))
  assert.match(r.text, /与所在任务目录不一致/)
})

test('result：evidence 必须存在且每项可核对（不接受自由文本）', () => {
  const missing = check((f) => validateResult(goodResult({ evidence: undefined }), 'r', f, 't-0012'))
  assert.match(missing.text, /evidence 应为 array/)

  const emptyOk = check((f) => validateResult(goodResult({ evidence: [] }), 'r', f, 't-0012'))
  assert.equal(emptyOk.pass, true, '可空数组但字段必须在')

  const noRef = check((f) => validateResult(goodResult({ evidence: [{ type: 'url' }] }), 'r', f, 't-0012'))
  assert.match(noRef.text, /缺少 ref/)

  const badType = check((f) => validateResult(goodResult({ evidence: [{ type: '感觉', ref: 'x' }] }), 'r', f, 't-0012'))
  assert.match(badType.text, /type 非法/)

  const badTaskRef = check((f) => validateResult(
    goodResult({ evidence: [{ type: 'task', ref: 't-0010/result.json' }] }), 'r', f, 't-0012',
  ))
  assert.match(badTaskRef.text, /type=task 的 ref 应为 t-0000/)
})

test('result：产物必须带 sha256（consumes 校验的依据）', () => {
  const r = check((f) => validateResult(goodResult({
    artifacts: [{ path: 'a.csv', bytes: 1 }],
  }), 'r', f, 't-0012'))
  assert.match(r.text, /sha256 缺失或形态非法/)
})

test('result：failed / blocked 必须说明卡在哪', () => {
  const r = check((f) => validateResult(goodResult({ status: 'blocked', blockers: [] }), 'r', f, 't-0012'))
  assert.match(r.text, /blockers 不应为空/)

  const okBlocked = check((f) => validateResult(
    goodResult({ status: 'blocked', blockers: ['等 Operator 开 bl'] }), 'r', f, 't-0012',
  ))
  assert.equal(okBlocked.pass, true, okBlocked.text)
})

test('result：status 与 conclusion 不得缺省', () => {
  const r = check((f) => validateResult(goodResult({ status: 'ok', conclusion: '  ' }), 'r', f, 't-0012'))
  assert.match(r.text, /status 非法/)
  assert.match(r.text, /conclusion 缺失/)
})

// ---------------------------------------------------------------------------
// 机器事件
// ---------------------------------------------------------------------------

test('event：合法事件通过，verifier:<agent> 形式的作者被接受', () => {
  const ok = check((f) => validateEvent({
    ts: '2026-09-10T00:00:00Z', event: 'task.started',
    author: 'dispatcher', bus_version: 3, task_id: 't-0012',
  }, 'e', f))
  assert.equal(ok.pass, true, ok.text)

  const verifier = check((f) => validateEvent({
    ts: '2026-09-10T00:00:00Z', event: 'task.verified',
    author: 'verifier:opencode', bus_version: 4, task_id: 't-0012', reason: '对抗验证未找到反例',
  }, 'e', f))
  assert.equal(verifier.pass, true, verifier.text)
})

test('event：未登记的类型与非法作者被拒', () => {
  const badType = check((f) => validateEvent({
    ts: '2026-09-10T00:00:00Z', event: 'task.whatever', author: 'commander', bus_version: 1,
  }, 'e', f))
  assert.match(badType.text, /event 类型非法/)

  const badAuthor = check((f) => validateEvent({
    ts: '2026-09-10T00:00:00Z', event: 'task.started', author: 'scout', bus_version: 1, task_id: 't-0012',
  }, 'e', f))
  assert.match(badAuthor.text, /author 非法/)
})

test('event：task / reason 按类型分别必填', () => {
  // task.started 需要 task_id 但不需要 reason
  const noTask = check((f) => validateEvent({
    ts: '2026-09-10T00:00:00Z', event: 'task.started', author: 'dispatcher', bus_version: 1,
  }, 'e', f))
  assert.match(noTask.text, /需要合法的 task_id/)

  // 变更类事件必须说明理由
  const noReason = check((f) => validateEvent({
    ts: '2026-09-10T00:00:00Z', event: 'task.created', author: 'commander', bus_version: 1, task_id: 't-0012',
  }, 'e', f))
  assert.match(noReason.text, /需要 reason/)

  // 超步提交事件不需要 task_id
  const commit = check((f) => validateEvent({
    ts: '2026-09-10T00:00:00Z', event: 'superstep.committed', author: 'applier', bus_version: 1,
  }, 'e', f))
  assert.equal(commit.pass, true, commit.text)
})

test('event：超长事件被拒（附加写语义的前提）', () => {
  const fat = check((f) => validateEvent({
    ts: '2026-09-10T00:00:00Z', event: 'task.started', author: 'dispatcher', bus_version: 1,
    task_id: 't-0012', blob: 'x'.repeat(MAX_EVENT_BYTES),
  }, 'e', f))
  assert.match(fat.text, /字节，超过 \d+ 上限/)
})

test('makeEvent：补默认字段但仍需单独校验', () => {
  const ev = makeEvent('task.started', { task_id: 't-0012' }, { author: 'dispatcher', busVersion: 7 })
  assert.equal(ev.event, 'task.started')
  assert.equal(ev.author, 'dispatcher')
  assert.equal(ev.bus_version, 7)
  assert.equal(ev.task_id, 't-0012')
  assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(check((f) => validateEvent(ev, 'e', f)).pass, true)
})

// ---------------------------------------------------------------------------
// 超步版本：从事件流派生
// ---------------------------------------------------------------------------

test('currentBusVersion：从事件流派生，无需独立状态文件', () => {
  assert.equal(currentBusVersion([]), 0)
  assert.equal(currentBusVersion(null), 0)
  assert.equal(currentBusVersion([{ event: 'task.started', bus_version: 5 }]), 0, '业务事件不定义版本，只有提交事件定义')

  const events = [
    { event: 'task.started', bus_version: 1 },
    { event: 'superstep.committed', bus_version: 1 },
    { event: 'artifact.written', bus_version: 2 },
    { event: 'superstep.committed', bus_version: 2 },
  ]
  assert.equal(currentBusVersion(events), 2, '取最后一条提交事件')

  // 坏数据不得让版本凭空跳变
  assert.equal(currentBusVersion([{ event: 'superstep.committed', bus_version: 'x' }]), 0)
})

// ---------------------------------------------------------------------------
// 补丁
// ---------------------------------------------------------------------------

test('patch：合法补丁通过', () => {
  const ok = check((f) => validatePatch({
    op: 'append', path: 'state/tasks.jsonl', value: { op: 'create' },
    author: 'commander', expected_version: 0,
  }, 'p', f))
  assert.equal(ok.pass, true, ok.text)
})

test('patch：路径白名单是硬闸 —— 未登记路径一律拒绝', () => {
  for (const p of ['state/events.jsonl', 'workers/validate-bus.mjs', 'AGENTS.md', 'agents/scout/manifest.json']) {
    const r = check((f) => validatePatch({
      op: 'set', path: p, value: {}, author: 'commander', expected_version: 0, reason: 'x',
    }, 'p', f))
    assert.equal(r.pass, false, `${p} 不应被允许写入`)
    assert.match(r.text, /不在可写白名单内/)
  }
})

test('patch：op 必须与路径允许的操作匹配', () => {
  const r = check((f) => validatePatch({
    op: 'set', path: 'state/tasks.jsonl', value: {}, author: 'commander', expected_version: 0, reason: 'x',
  }, 'p', f))
  assert.match(r.text, /不接受 op=set/)
})

test('patch：变更类写入必须说明理由与作者，且必须给期望版本', () => {
  const noReason = check((f) => validatePatch({
    op: 'set', path: 'tasks/t-0012/result.json', value: {}, author: 'dispatcher', expected_version: 0,
  }, 'p', f))
  assert.match(noReason.text, /需要 reason/)

  const noAuthor = check((f) => validatePatch({
    op: 'append', path: 'state/tasks.jsonl', value: {}, expected_version: 0,
  }, 'p', f))
  assert.match(noAuthor.text, /缺少 author/)

  const noVersion = check((f) => validatePatch({
    op: 'append', path: 'state/tasks.jsonl', value: {}, author: 'commander',
  }, 'p', f))
  assert.match(noVersion.text, /expected_version 应为非负整数/)
})

test('patch：拒绝非枚举 op 与缺失 value', () => {
  const r = check((f) => validatePatch({
    op: 'delete', path: 'state/tasks.jsonl', author: 'commander', expected_version: 0,
  }, 'p', f))
  assert.match(r.text, /op 非法/)
  assert.match(r.text, /缺少 value/)
})

// ---------------------------------------------------------------------------
// 超步确定性排序
// ---------------------------------------------------------------------------

test('sortPatchesDeterministic：到达顺序不影响落盘顺序', () => {
  const a = { path: 'state/tasks.jsonl', author: 'commander', op: 'append', expected_version: 0 }
  const b = { path: 'state/tasks.jsonl', author: 'dispatcher', op: 'append', expected_version: 0 }
  const c = { path: 'agents/scout/capability.json', author: 'scanner', op: 'set', expected_version: 0 }

  const shuffled = [c, a, b]
  const out1 = sortPatchesDeterministic(shuffled).map((p) => p.author)
  const out2 = sortPatchesDeterministic([b, c, a]).map((p) => p.author)
  const out3 = sortPatchesDeterministic([a, b, c]).map((p) => p.author)

  assert.deepEqual(out1, out2, '同一组补丁的不同到达顺序必须产出同一落盘顺序')
  assert.deepEqual(out2, out3)
  // 入参不被修改
  assert.deepEqual(shuffled.map((p) => p.author), ['scanner', 'commander', 'dispatcher'])
})
