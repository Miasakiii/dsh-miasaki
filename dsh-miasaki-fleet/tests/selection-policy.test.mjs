// selection-policy.test.mjs — P2-F（2026-10-21）：可插拔选型策略（只排序、不执行）
//
// 覆盖：
//   · 策略文档校验（default 必须已定义 / weights 键与数值 / 未知键）；
//   · resolveStrategyWeights：未知策略**显式失败**（不静默回退默认）；
//   · 行为：同一能力图，cheap 与 reliable 产生不同排序（权重确实作用于 score）；
//   · CLI：--list-strategies 可用；--strategy 拼错 exit 2（不猜）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import policyLib from '../workers/lib/selection-policy.cjs'
import { buildCapabilityGraph, selectAgents } from '../workers/lib/capability-graph.cjs'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(FLEET_DIR, 'workers', 'graph', 'agent-pick.mjs')

function resolveWeights(id) {
  return policyLib.resolveStrategyWeights(policyLib.DEFAULT_POLICY, id).weights
}

function makeGraph() {
  return buildCapabilityGraph([
    // 便宜但历史一般：confidence = 1/2 = 0.5
    { id: 'alpha', kind: 'coding-agent', skills: ['coding'], enabled: true, alive: true, accepted: 0, reopened: 0, failed: 0, modelPrice: { input: 1, output: 1 } },
    // 贵但历史很好：confidence = 10/11 ≈ 0.909
    { id: 'beta', kind: 'coding-agent', skills: ['coding'], enabled: true, alive: true, accepted: 9, reopened: 0, failed: 0, modelPrice: { input: 200, output: 200 } },
  ], {})
}

test('随仓策略文件合法（shared/selection-policy.json）', () => {
  const doc = JSON.parse(readFileSync(join(FLEET_DIR, 'shared', 'selection-policy.json'), 'utf8'))
  const v = policyLib.validatePolicy(doc)
  assert.equal(v.ok, true, JSON.stringify(v.problems))
  assert.equal(doc.default, 'balanced')
  for (const id of ['balanced', 'cheap', 'reliable', 'coverage']) {
    assert.ok(doc.strategies[id], `缺少策略 ${id}`)
  }
})

test('validatePolicy：default 指向未定义策略 / 权重缺失 / 未知键 ⇒ 显式报问题', () => {
  const base = JSON.parse(JSON.stringify(policyLib.DEFAULT_POLICY))
  assert.equal(policyLib.validatePolicy(base).ok, true)

  const badDefault = JSON.parse(JSON.stringify(base))
  badDefault.default = 'nope'
  assert.equal(policyLib.validatePolicy(badDefault).ok, false)

  const badWeights = JSON.parse(JSON.stringify(base))
  delete badWeights.strategies.balanced.weights.coverage
  const v = policyLib.validatePolicy(badWeights)
  assert.equal(v.ok, false)
  assert.match(v.problems.map((p) => p.where + ':' + p.message).join('|'), /weights\.coverage/)

  const unknownKey = JSON.parse(JSON.stringify(base))
  unknownKey.strategies.balanced.weights.speed = 1
  assert.equal(policyLib.validatePolicy(unknownKey).ok, false)
})

test('resolveStrategyWeights：未知策略抛错（不静默回退），默认取 default', () => {
  assert.deepEqual(resolveWeights('balanced'), { coverage: 100, confidence: 20, cost: 10, load: 5 })
  assert.throws(() => resolveWeights('nope'), /未知选型策略/)
  const def = policyLib.resolveStrategyWeights(policyLib.DEFAULT_POLICY, null)
  assert.equal(def.id, 'balanced')
})

test('行为：cheap 偏向便宜、reliable 偏向高成功率（权重确实参与排序）', () => {
  const graph = makeGraph()
  const ctx = { estTokens: 1000, maxCostRef: 256 }

  const cheap = selectAgents(['coding'], graph, { ...ctx, weights: resolveWeights('cheap') })
  assert.equal(cheap.candidates[0].agentId, 'alpha', 'cheap 策略应把便宜 agent 排前')

  const reliable = selectAgents(['coding'], graph, { ...ctx, weights: resolveWeights('reliable') })
  assert.equal(reliable.candidates[0].agentId, 'beta', 'reliable 策略应把高成功率 agent 排前')

  // 策略只排序：候选集合不变（硬判定不因策略而变）。
  assert.deepEqual(cheap.candidates.map((c) => c.agentId).sort(), reliable.candidates.map((c) => c.agentId).sort())
})

test('CLI：--list-strategies 输出全部策略；--strategy 拼错 ⇒ exit 2（显式失败）', () => {
  const ok = spawnSync(process.execPath, [CLI, '--list-strategies'], { cwd: FLEET_DIR, encoding: 'utf8' })
  assert.equal(ok.status, 0)
  for (const id of ['balanced', 'cheap', 'reliable', 'coverage']) assert.match(ok.stdout, new RegExp(id))

  const bad = spawnSync(process.execPath, [CLI, '--strategy', 'nope', '--need', 'coding'], { cwd: FLEET_DIR, encoding: 'utf8' })
  assert.equal(bad.status, 2)
  assert.match(String(bad.stderr), /未知选型策略/)
})
