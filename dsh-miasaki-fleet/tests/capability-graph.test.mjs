// capability-graph.test.mjs — G2 能力图单测（2026-09-10）
//
// 数据取自 2026-09-10 对 agents/ 与 agents/archive/ 的真实勘察快照
// （见 docs/graph-engineering-fleet-design.md §4.6 与本轮报告）：
//   · 活动 8 个 agent 的 model 普遍是 cli-default（无真实模型数据）
//   · 归档的 coder 声明 `code`，活动 agent 声明 `coding` —— 词表断裂
// 用真实快照而非编造数据，是为了让「替代查找找不到人」这类结论可信。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildCapabilityGraph,
  canonicalize,
  capabilityGaps,
  capabilityId,
  findSubstitutes,
  selectAgents,
} from '../workers/lib/capability-graph.mjs'

/** 真实档案快照（2026-09-10 勘察）。 */
const REAL_AGENTS = [
  { id: 'agent-browser', skills: ['web-automation', 'browser'], model: 'cli-default', metering: 'unknown', enabled: true, alive: true },
  { id: 'bl', skills: ['bailian-resources', 'bailian-chat'], model: 'cli-default', metering: 'console-usage', enabled: true, alive: true },
  { id: 'claude', skills: ['analysis', 'coding', 'multi-step-tools', 'json-output'], model: 'cli-default', metering: 'json-cost-usd', enabled: true, alive: true },
  { id: 'dsh', skills: ['headless-orchestration', 'dsd-native'], model: 'cli-default', metering: 'session', enabled: false, alive: true },
  { id: 'gemini', skills: ['google-chat'], model: 'cli-default', metering: 'unknown', enabled: false, alive: true },
  { id: 'mimo', skills: ['light-chat'], model: 'cli-default', metering: 'unknown', enabled: false, alive: true },
  { id: 'opencode', skills: ['coding', 'cli-task-runner'], model: 'cli-default', metering: 'unknown', enabled: true, alive: true },
  { id: 'pi', skills: ['coding'], model: 'cli-default', metering: 'unknown', enabled: true, alive: true },
  // 归档：有真实模型与技能，是「替代关系断裂」的当事方
  { id: 'coder', skills: ['code', 'scripting', 'engineering', 'zh-report'], model: 'deepseek-v4-flash', modelPrice: { input: 0.0001, output: 0.0002 }, archived: true },
  { id: 'analyst', skills: ['research', 'comparative-analysis', 'zh-report'], model: 'deepseek-v4-pro', modelPrice: { input: 0.0005, output: 0.0015 }, archived: true },
]

function graphOf(agents) {
  return buildCapabilityGraph(agents || REAL_AGENTS)
}

// ---------------------------------------------------------------------------
// 能力规范化
// ---------------------------------------------------------------------------

test('canonicalize：只归一明确同义的技能，不猜', () => {
  assert.equal(canonicalize('code'), 'coding', 'code/coding 是确凿的同义对')
  assert.equal(canonicalize('scripting'), 'coding')
  assert.equal(canonicalize('CODE'), 'coding', '大小写不敏感')
  assert.equal(canonicalize('  coding  '), 'coding', '去空白')

  // 语义是否等同需人工确认的一律不动 —— 猜错比不猜更糟
  assert.equal(canonicalize('analysis'), 'analysis')
  assert.equal(canonicalize('comparative-analysis'), 'comparative-analysis')
  assert.equal(canonicalize('browser'), 'browser')
  assert.equal(canonicalize('web-automation'), 'web-automation')
  assert.equal(canonicalize(''), '')
})

test('canonicalize：自定义词表是补充而非替换', () => {
  const custom = { research: 'analysis' }
  assert.equal(canonicalize('research', custom), 'analysis', '自定义别名生效')
  assert.equal(canonicalize('code', custom), 'coding', '内置别名仍然生效 —— 补充几个不该丢掉已确认的')
})

// ---------------------------------------------------------------------------
// 图构建
// ---------------------------------------------------------------------------

test('buildCapabilityGraph：code 与 scripting 归一到同一能力节点', () => {
  const g = graphOf()
  const coder = g.agents.get('coder')
  assert.deepEqual(coder.capabilities.sort(), ['cap:coding', 'cap:engineering', 'cap:zh-report'],
    'code 与 scripting 必须合并为 cap:coding，而不是各占一个节点')

  const coding = g.capabilities.get('cap:coding')
  assert.deepEqual(coding.agents, ['claude', 'opencode', 'pi'], '活动提供者')
  assert.deepEqual(coding.archivedAgents, ['coder'], '归档提供者单列')
  assert.equal(coding.agents.includes('coder'), false, '归档的不能混进活动提供者')
})

test('buildCapabilityGraph：confidence 用 Laplace 平滑，无历史为 0.5', () => {
  const g = graphOf([
    { id: 'newbie', skills: ['x'], enabled: true },
    { id: 'reliable', skills: ['x'], enabled: true, accepted: 8, reopened: 0, failed: 0 },
    { id: 'flaky', skills: ['x'], enabled: true, accepted: 1, reopened: 3, failed: 2 },
  ])
  assert.equal(g.agents.get('newbie').confidence, 0.5, '无历史既不奖励也不惩罚')
  assert.ok(g.agents.get('reliable').confidence > 0.8)
  assert.ok(g.agents.get('flaky').confidence < 0.5)
})

test('buildCapabilityGraph：报出真实数据里的两个系统性问题', () => {
  const g = graphOf()
  const kinds = g.issues.map((i) => i.kind)
  assert.ok(kinds.includes('no_explicit_model'),
    '活动档案 model 普遍为 cli-default —— 多模型选型缺乏真实数据，必须报出来')

  const noCaps = graphOf([{ id: 'empty', skills: [], enabled: true }]).issues
    .filter((i) => i.kind === 'no_capabilities')
  assert.equal(noCaps.length, 1, '没有任何技能的 agent 永远匹配不上，必须报出来')
})

// ---------------------------------------------------------------------------
// 替代查找
// ---------------------------------------------------------------------------

test('替代查找：coder 归档后只有部分替代者，缺口被明确列出', () => {
  const g = graphOf()
  const r = findSubstitutes('coder', g)

  assert.equal(r.found, true)
  assert.deepEqual(r.required, ['cap:coding', 'cap:engineering', 'cap:zh-report'])
  assert.deepEqual(r.full, [], '真实数据里没有能完全替代 coder 的 agent')

  assert.equal(r.partial.length, 3, 'claude / opencode / pi 都能覆盖 coding')
  for (const p of r.partial) {
    assert.equal(p.coverage, 0.333, '3 项能力里覆盖 1 项')
    assert.deepEqual(p.covered, ['cap:coding'])
    assert.deepEqual(p.missing, ['cap:engineering', 'cap:zh-report'])
  }
})

test('替代查找：analyst 完全没有替代者（诚实结论优于虚假匹配）', () => {
  const g = graphOf()
  const r = findSubstitutes('analyst', g)
  assert.deepEqual(r.required, ['cap:comparative-analysis', 'cap:research', 'cap:zh-report'])
  assert.deepEqual(r.full, [])
  assert.deepEqual(r.partial, [], 'analysis ≠ research，不做相似度猜测')
  assert.match(r.reason, /没有任何 agent 提供所需能力/)
})

test('替代查找：默认排除归档与未开启，可显式放开', () => {
  // 用专门构造的数据集：真实快照里未开启的 agent（dsh/gemini/mimo）恰好与其他
  // agent 没有共同能力，无法体现「能力够但不可用」这一情形。
  const g = graphOf([
    { id: 'src', skills: ['coding'], archived: true },
    { id: 'on', skills: ['coding'], enabled: true, alive: true },
    { id: 'off', skills: ['coding'], enabled: false, alive: true },
    { id: 'arch', skills: ['coding'], archived: true },
  ])

  const strict = findSubstitutes('src', g)
  assert.deepEqual(strict.full.map((c) => c.agentId), ['on'], '默认只给可用的')

  const loose = findSubstitutes('src', g, { includeUnavailable: true, includeArchived: true })
  assert.deepEqual(loose.full.map((c) => c.agentId).sort(), ['arch', 'off', 'on'])

  const off = loose.full.find((c) => c.agentId === 'off')
  assert.equal(off.available, false, '放进候选不等于可用 —— available 必须如实')
})

test('替代查找：无能力的 agent 给出明确原因而不是空结果', () => {
  const g = graphOf([{ id: 'empty', skills: [], enabled: true }])
  const r = findSubstitutes('empty', g)
  assert.deepEqual(r.full, [])
  assert.match(r.reason, /未声明任何能力/)
})

// ---------------------------------------------------------------------------
// 选型
// ---------------------------------------------------------------------------

test('选型：按覆盖度排序，可用的排在不可用之前', () => {
  const g = graphOf()
  const r = selectAgents(['coding'], g)

  assert.deepEqual(r.required, ['cap:coding'])
  assert.deepEqual(r.candidates.map((c) => c.agentId), ['claude', 'opencode', 'pi'],
    '三者都覆盖 coding，claude 因历史 confidence 更高排前')
  assert.ok(r.candidates.every((c) => c.available))
  assert.ok(r.candidates.every((c) => c.missing.length === 0))
})

test('选型：裸技能名会被 canonical 化，code 与 coding 等价', () => {
  const g = graphOf()
  const byRaw = selectAgents(['code'], g)
  const byCanonical = selectAgents(['cap:coding'], g)
  assert.deepEqual(byRaw.required, byCanonical.required)
  assert.deepEqual(byRaw.candidates.map((c) => c.agentId), byCanonical.candidates.map((c) => c.agentId))
})

test('选型：报出无人提供的能力（缺口），而不是静默给空候选', () => {
  const g = graphOf()
  const r = selectAgents(['coding', 'research'], g)
  assert.deepEqual(r.missingCapabilities, ['cap:research'], 'research 只有归档的 analyst 提供')
  // 有覆盖 coding 的候选仍在，但 missing 里能看到 research 没人做
  assert.ok(r.candidates.length > 0)
  assert.ok(r.candidates.every((c) => c.missing.includes('cap:research')))
})

test('选型：requireFull 只留完全覆盖者', () => {
  const g = graphOf()
  const r = selectAgents(['coding', 'zh-report'], g, { requireFull: true })
  assert.deepEqual(r.candidates, [], '无人同时覆盖 coding 与 zh-report')
})

test('选型：不可用候选带明确原因', () => {
  const g = graphOf([{ id: 'off', skills: ['x'], enabled: false, alive: true }])
  const r = selectAgents(['x'], g, { includeUnavailable: true })
  assert.equal(r.candidates.length, 1)
  assert.equal(r.candidates[0].available, false)
  assert.equal(r.candidates[0].unavailableReason, '开关未开启')
})

test('选型：评分可解释，每一项都能追溯到输入', () => {
  const g = graphOf()
  const r = selectAgents(['coding'], g)
  for (const c of r.candidates) {
    assert.ok(Number.isFinite(c.score))
    assert.ok(Number.isFinite(c.breakdown.coverage))
    assert.ok(Number.isFinite(c.breakdown.confidence))
    // 覆盖度是主项：全覆盖的候选，coverage 项应等于权重上限
    assert.equal(c.breakdown.coverage, 100)
  }
})

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

test('capabilityGaps：报出只有归档提供的能力（一关就断）', () => {
  const g = graphOf()
  const gaps = capabilityGaps(g)

  const archivedOnly = gaps.archivedOnly.map((x) => x.capability)
  assert.ok(archivedOnly.includes('cap:engineering'), 'engineering 只有归档的 coder 提供')
  assert.ok(archivedOnly.includes('cap:research'), 'research 只有归档的 analyst 提供')
  assert.ok(archivedOnly.includes('cap:comparative-analysis'))
  assert.ok(archivedOnly.includes('cap:zh-report'))
})

test('capabilityGaps：报出疑似同义但未归一的能力（词表演进输入）', () => {
  const g = graphOf()
  const gaps = capabilityGaps(g)
  const pairs = gaps.suspectedSynonyms.map((s) => `${s.a}|${s.b}`)
  assert.ok(
    pairs.includes('cap:analysis|cap:comparative-analysis') || pairs.includes('cap:analysis|cap:cli-task-runner'),
    `应报出名称存在包含关系的能力对，实际：${pairs.join(' , ')}`,
  )
  // 只提示，不自动合并
  assert.ok(g.capabilities.has('cap:analysis') && g.capabilities.has('cap:comparative-analysis'),
    '提示归提示，节点仍各自独立')
})
