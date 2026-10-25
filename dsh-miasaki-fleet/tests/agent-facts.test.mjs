// agent-facts.test.mjs — P2-B（2026-10-21）：manifest / observed 派生分离
//
// 覆盖 workers/lib/agent-facts.cjs：
//   · observed 覆盖 manifest 的发现事实（cli/kind/model_info/…），Operator 字段保留；
//   · observed 缺席 ⇒ 回退 manifest（兼容窗口，`_facts_source` 显式标记）；
//   · splitFacts：发现字段与 Operator 字段拆开，未知 Operator 字段不丢。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import facts from '../workers/lib/agent-facts.cjs'

function makeAgent(t, manifest, observed) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-facts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'agents', 'alpha')
  mkdirSync(dir, { recursive: true })
  if (manifest !== null) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  if (observed !== null) writeFileSync(join(dir, 'observed.json'), JSON.stringify(observed, null, 2) + '\n', 'utf8')
  return { root, dir }
}

const MANIFEST = {
  id: 'alpha', name: 'Alpha', runtime: 'cli', model: 'cli-default', metering_source: 'unknown',
  skills: ['coding'], persona_prompt: 'x',
  limits: { budget_per_day: 2, timeout_ms: 1000, heartbeat_ms: 1000 },
  updated_at: '2026-10-21T00:00:00Z',
}
const OBSERVED = {
  schema_version: 1, agent_id: 'alpha', observed_at: '2026-10-21T00:00:00Z', present: true,
  runtime_kind: 'fake', kind: 'coding-agent',
  cli: { command: 'alpha', binPath: '%USERPROFILE%\\alpha.exe', version: '1.0.0', invoke: 'alpha -p {prompt}' },
  capabilities: ['coding'], capability_boundary: { tool_loop: 'yes' },
  model_info: { value: 'm-1', source: 'config', confidence: 'declared' },
  permissions: { mode: 'read-only', calibration: 'verified' },
  preflight: 'ok',
}

test('DISCOVERED_KEYS：发现事实集合稳定（消费方按此合并）', () => {
  for (const k of ['cli', 'kind', 'present', 'capabilities', 'model_info', 'permissions', 'preflight']) {
    assert.ok(facts.DISCOVERED_KEYS.includes(k), `${k} 必须在发现事实集合里`)
  }
  assert.equal(facts.isDiscoveredKey('limits'), false, 'limits 属 Operator 字段')
})

test('合并视图：observed 覆盖发现事实，Operator 字段保留', (t) => {
  const { root } = makeAgent(t, MANIFEST, OBSERVED)
  const f = facts.readAgentFacts(root, 'alpha')
  assert.equal(f._facts_source, 'manifest+observed')
  assert.equal(f.kind, 'coding-agent')
  assert.equal(f.cli.version, '1.0.0')
  assert.equal(f.model_info.value, 'm-1')
  assert.equal(f.permissions.calibration, 'verified')
  assert.equal(f.name, 'Alpha', 'Operator 字段必须保留')
  assert.equal(f.limits.timeout_ms, 1000)
  assert.equal(f.skills[0], 'coding')
})

test('兼容窗口：observed 缺席 ⇒ 回退 manifest 并显式标记来源', (t) => {
  const { root } = makeAgent(t, { ...MANIFEST, kind: 'coding-agent', cli: { command: 'alpha' } }, null)
  const f = facts.readAgentFacts(root, 'alpha')
  assert.equal(f._facts_source, 'manifest-only')
  assert.equal(f.kind, 'coding-agent')
})

test('splitFacts：拆出 discovered，未知 Operator 字段不丢', () => {
  const { operator, discovered } = facts.splitFacts({
    ...MANIFEST, ...OBSERVED, custom_operator_field: 'keep-me', observed_at: 'x',
  })
  assert.equal(discovered.kind, 'coding-agent')
  assert.equal(discovered.cli.version, '1.0.0')
  assert.equal(operator.kind, undefined)
  assert.equal(operator.custom_operator_field, 'keep-me')
  assert.equal(operator.observed_at, undefined)
})

test('缺失 manifest ⇒ null（不凭 observed 造出半个 agent）', (t) => {
  const { root } = makeAgent(t, null, OBSERVED)
  assert.equal(facts.readAgentFacts(root, 'alpha'), null)
})
