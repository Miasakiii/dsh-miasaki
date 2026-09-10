// verifier.test.mjs — G4 验证器选取与异构性判定单测（2026-09-10）
//
// 两组重点：
//   1. **异构等级**：自验必须被拒；同模型只算 agent 级；不同厂商才算最强异构。
//   2. **契约**：verdict.json 的三条硬约束（署名 / 拒绝须有依据 / findings 须有证据）。
//
// 代理人数据取自 2026-09-10 真实勘察快照。注意其中一条**现实约束**：
// 8 个活动 agent 的 model 全是 cli-default → 「不同模型」这一级无法判定，
// 厂商级异构是当前唯一可达的强异构依据。测试把这个行为固定下来。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { validateVerdict } from '../workers/lib/bus-contract.mjs'
import {
  assessHeterogeneity,
  buildVerifierBrief,
  normalizeModel,
  selectVerifiers,
  summarizeVerdicts,
  vendorOf,
} from '../workers/lib/verifier.mjs'

function check(fn) {
  const errs = []
  const pass = fn((where, msg) => errs.push(`${where}: ${msg}`))
  return { pass, errs, text: errs.join(' | ') }
}

/** 真实档案快照（2026-09-10）：活动 agent 的 model 普遍是 cli-default。 */
const REAL_AGENTS = new Map(Object.entries({
  claude: { model: 'cli-default', enabled: true, alive: true },
  gemini: { model: 'cli-default', enabled: false, alive: true },
  opencode: { model: 'cli-default', enabled: true, alive: true },
  pi: { model: 'cli-default', enabled: true, alive: true },
  dsh: { model: 'cli-default', enabled: false, alive: true },
  mimo: { model: 'cli-default', enabled: false, alive: true },
  bl: { model: 'cli-default', enabled: true, alive: true },
  'agent-browser': { model: 'cli-default', enabled: true, alive: true },
}))

function ctxOf(agents, extra) {
  return {
    agents,
    getAgent: (id) => agents.get(id) || null,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// 模型规范化与厂商
// ---------------------------------------------------------------------------

test('normalizeModel：cli-default 视为未声明（它不携带区分信息）', () => {
  assert.equal(normalizeModel('cli-default'), null, '当成真值会让"不同模型"产生虚假异构结论')
  assert.equal(normalizeModel(''), null)
  assert.equal(normalizeModel(null), null)
  assert.equal(normalizeModel(undefined), null)
  assert.equal(normalizeModel('  claude-sonnet-4-6  '), 'claude-sonnet-4-6')
})

test('vendorOf：未登记的 agent 返回 unknown，不猜', () => {
  assert.equal(vendorOf('claude'), 'anthropic')
  assert.equal(vendorOf('gemini'), 'google')
  assert.equal(vendorOf('coder'), 'unknown', '归档的自建 agent 未登记 → 不猜厂商')
  assert.equal(vendorOf('claude', { claude: 'custom-vendor' }), 'custom-vendor', '可覆盖')
})

// ---------------------------------------------------------------------------
// 异构性判定
// ---------------------------------------------------------------------------

test('异构判定：自验被拒（level=none）', () => {
  const ctx = ctxOf(REAL_AGENTS)
  const r = assessHeterogeneity('claude', 'claude', ctx)
  assert.equal(r.level, 'none')
  assert.equal(r.ok, false, '自验必须被判定为不可接受')
  assert.match(r.reasons.join(' '), /自验，禁止/)
})

test('异构判定：不同厂商 = 最强异构（当前数据下唯一可达的强异构）', () => {
  const ctx = ctxOf(REAL_AGENTS)
  const r = assessHeterogeneity('claude', 'opencode', ctx)
  assert.equal(r.level, 'vendor', 'anthropic vs sst')
  assert.equal(r.ok, true)
  assert.equal(r.modelKnown, false, '两者模型都是 cli-default → 未声明')
  assert.match(r.reasons.join(' '), /模型未声明/)
})

test('异构判定：同厂商不同 agent 只算 agent 级', () => {
  const ctx = ctxOf(REAL_AGENTS)
  const r = assessHeterogeneity('claude', 'claude-peer', {
    agents: new Map([
      ['claude', { model: 'claude-sonnet-4-6' }],
      ['claude-peer', { model: 'claude-haiku-4' }],
    ]),
    vendors: { claude: 'anthropic', 'claude-peer': 'anthropic' },
  })
  // 模型不同 → model 级；但同厂商 → 不升到 vendor，也不降到 agent
  assert.equal(r.level, 'model')
  assert.equal(r.sameVendor, true)
  assert.match(r.reasons.join(' '), /同厂商 anthropic/)
})

test('异构判定：同模型不同 agent 只算 agent 级（同源盲点）', () => {
  const ctx = {
    agents: new Map([
      ['a', { model: 'deepseek-v4-flash' }],
      ['b', { model: 'deepseek-v4-flash' }],
    ]),
    vendors: { a: 'deepseek', b: 'deepseek' },
  }
  const r = assessHeterogeneity('a', 'b', ctx)
  assert.equal(r.level, 'agent', '同模型 + 同厂商 → 最弱的异构等级')
  assert.equal(r.sameModel, true)
  assert.match(r.reasons.join(' '), /同源盲点可能重合/)
})

test('异构判定：厂商未登记时保守降级，并说明原因', () => {
  const ctx = {
    agents: new Map([
      ['coder', { model: 'deepseek-v4-flash' }],
      ['claude', { model: 'cli-default' }],
    ]),
  }
  const r = assessHeterogeneity('coder', 'claude', ctx)
  assert.equal(r.level, 'agent', '厂商未知且模型未能同时确认 → 只能给最低级')
  assert.match(r.reasons.join(' '), /厂商归属未知/)
})

// ---------------------------------------------------------------------------
// 验证者选取
// ---------------------------------------------------------------------------

test('选验证者：默认排除自验与不可用者，按异构强度排序', () => {
  const ctx = ctxOf(REAL_AGENTS)
  const r = selectVerifiers('claude', ctx, {})

  const ids = r.candidates.map((c) => c.agentId)
  assert.equal(ids.includes('claude'), false, '自己不能验证自己')
  for (const c of r.candidates) {
    assert.equal(c.available, true, '默认只给可用的')
    assert.equal(c.level, 'vendor', '真实数据下活动 agent 两两之间都是厂商级异构')
  }
  // gemini / dsh / mimo 开关未开 → 被排除
  assert.equal(ids.includes('gemini'), false)
  assert.ok(ids.includes('opencode') && ids.includes('pi') && ids.includes('bl'))
})

test('选验证者：includeUnavailable 时放进候选但如实标注', () => {
  const ctx = ctxOf(REAL_AGENTS)
  const r = selectVerifiers('claude', ctx, { includeUnavailable: true })
  const gemini = r.candidates.find((c) => c.agentId === 'gemini')
  assert.ok(gemini)
  assert.equal(gemini.available, false)
  assert.equal(gemini.unavailableReason, '开关未开启')
  // 可用的仍排在前面
  assert.equal(r.candidates[0].available, true)
})

test('选验证者：minLevel 是下限，更强的异构等级同样满足', () => {
  const ctx = ctxOf(REAL_AGENTS)
  const r = selectVerifiers('claude', ctx, { minLevel: 'model' })
  assert.ok(r.candidates.length > 0, 'vendor 比 model 更强，理应满足这个下限')
  assert.ok(r.candidates.every((c) => c.level === 'vendor'))
})

test('选验证者：一个候选都没有时给出明确警告', () => {
  const ctx = {
    agents: new Map([['only', { model: 'cli-default', enabled: true, alive: true }]]),
    getAgent: () => ({ enabled: true, alive: true }),
  }
  const r = selectVerifiers('only', ctx, {})
  assert.deepEqual(r.candidates, [], '全局只有一个 agent 时，没有人能验证它')
  assert.ok(r.warnings.some((w) => /没有满足 minLevel/.test(w)))
})

test('选验证者：异构性普遍只达 agent 级时给出警告', () => {
  const ctx = {
    agents: new Map([
      ['a', { model: 'cli-default', enabled: true, alive: true }],
      ['b', { model: 'cli-default', enabled: true, alive: true }],
    ]),
    getAgent: (id) => ({ enabled: true, alive: true }),
    vendors: {}, // 全未登记厂商
  }
  const r = selectVerifiers('a', ctx, {})
  assert.equal(r.candidates.length, 1)
  assert.ok(r.warnings.some((w) => /只达 agent 级/.test(w)),
    '这正是当前数据下必须让使用者看到的风险')
})

// ---------------------------------------------------------------------------
// 任务书生成
// ---------------------------------------------------------------------------

test('验证任务书：对抗立场 + 独立契约 + 结构化输出三要素齐备', () => {
  const brief = buildVerifierBrief('t-0013', 'claude', {
    artifacts: ['tasks/t-0013/result.json'],
    acceptance: ['结论必须引用至少两个来源', '不得修改任务目录外的文件'],
  })

  assert.match(brief, /推翻/, '立场必须是推翻而非确认')
  assert.match(brief, /找不到任何反例/, '通过的标准是"找不到反例"')
  assert.match(brief, /不要\*\*参考产出者的推理过程/, '独立契约：不看执行者的叙事')
  assert.match(brief, /verdict\.json/)
  assert.match(brief, /拒绝必须说明依据/)

  // 产出的 JSON 片段必须自洽（能被解析）
  const m = brief.match(/```json\n([\s\S]*?)\n```/)
  assert.ok(m, '必须给出可照抄的 JSON 模板')
  const tpl = JSON.parse(m[1])
  assert.equal(tpl.task_id, 't-0013')
  assert.ok('verdict' in tpl && 'findings' in tpl)
})

test('验证任务书：未提供产物与标准时给出兜底指引而非空模板', () => {
  const brief = buildVerifierBrief('t-0001', 'pi')
  assert.match(brief, /未列出/)
  assert.match(brief, /brief\.md/)
})

// ---------------------------------------------------------------------------
// 结论汇总
// ---------------------------------------------------------------------------

test('汇总：最新一条决定当前状态，但驳回历史不被抹掉', () => {
  const verdicts = [
    { task_id: 't-0013', verifier: 'opencode', verdict: 'reject', findings: [{ severity: 'high', claim: 'x', evidence: {} }] },
    { task_id: 't-0013', verifier: 'pi', verdict: 'pass', findings: [] },
    { task_id: 't-0099', verifier: 'pi', verdict: 'reject', findings: [] },
  ]
  const s = summarizeVerdicts(verdicts, 't-0013')
  assert.equal(s.verified, true)
  assert.equal(s.verdict, 'pass', '最新一条决定当前状态（重开后复验通过）')
  assert.equal(s.total, 2)
  assert.equal(s.rejectCount, 1, '驳回过一次这个事实必须保留，供诊断使用')

  assert.equal(summarizeVerdicts(verdicts, 't-0001').verified, false)
  assert.equal(summarizeVerdicts(null, 't-0013').verified, false)
})

// ---------------------------------------------------------------------------
// verdict.json 契约
// ---------------------------------------------------------------------------

function goodVerdict(over) {
  return {
    task_id: 't-0013',
    verifier: 'opencode',
    verdict: 'pass',
    findings: [],
    confidence: 0.8,
    checked_at: '2026-09-10T00:00:00Z',
    ...over,
  }
}

test('verdict 契约：合法通过', () => {
  const r = check((f) => validateVerdict(goodVerdict(), 'v', f, 't-0013'))
  assert.equal(r.pass, true, r.text)
})

test('verdict 契约：验证者必须署名（匿名验证无法追责也无法判定异构）', () => {
  const r = check((f) => validateVerdict(goodVerdict({ verifier: undefined }), 'v', f, 't-0013'))
  assert.match(r.text, /缺少 verifier/)
})

test('verdict 契约：reject 必须给出 findings', () => {
  const r = check((f) => validateVerdict(goodVerdict({ verdict: 'reject' }), 'v', f, 't-0013'))
  assert.match(r.text, /findings 不应为空/)

  const ok = check((f) => validateVerdict(goodVerdict({
    verdict: 'reject',
    findings: [{ severity: 'high', claim: '声称覆盖 X，实测未覆盖', evidence: { type: 'file', ref: 'a.csv' } }],
  }), 'v', f, 't-0013'))
  assert.equal(ok.pass, true, ok.text)
})

test('verdict 契约：每条 finding 必须有 severity / claim / evidence', () => {
  const noClaim = check((f) => validateVerdict(goodVerdict({
    findings: [{ severity: 'high', evidence: {} }],
  }), 'v', f, 't-0013'))
  assert.match(noClaim.text, /缺少 claim/)

  const noEvidence = check((f) => validateVerdict(goodVerdict({
    findings: [{ severity: 'high', claim: 'x' }],
  }), 'v', f, 't-0013'))
  assert.match(noEvidence.text, /缺少 evidence/, '对抗验证的结论同样要有依据')

  const badSeverity = check((f) => validateVerdict(goodVerdict({
    findings: [{ severity: 'critical', claim: 'x', evidence: {} }],
  }), 'v', f, 't-0013'))
  assert.match(badSeverity.text, /severity 非法/)
})

test('verdict 契约：verdict 枚举、confidence 区间、task_id 与目录一致', () => {
  assert.match(check((f) => validateVerdict(goodVerdict({ verdict: 'maybe' }), 'v', f)).text, /verdict 非法/)
  assert.match(check((f) => validateVerdict(goodVerdict({ confidence: 1.5 }), 'v', f)).text, /confidence 应为 0\.\.1/)
  assert.match(check((f) => validateVerdict(goodVerdict(), 'v', f, 't-0099')).text, /与所在任务目录不一致/)
})
