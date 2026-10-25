// agent-facts.cjs — P2-B（2026-10-21）：manifest / observed 的事实合并（派生分离）
//
// 问题（D3）：扫描器把「发现事实」（cli / kind / present / 能力边界 / 权限 / model_info / preflight）
// 与 Operator 可编辑字段混在 `manifest.json` 里，且 `registry.json` 再存一份快照 ⇒ 同批数据多份拷贝，
// 谁是最新值没有单一事实源。
//
// 本模块把口径拆开：
//   · `agents/<id>/manifest.json`：**Operator 字段**（name / runtime / model / model_price /
//     metering / metering_source / skills / persona_prompt / limits / updated_at）
//   · `agents/<id>/observed.json`：**扫描/探测事实**（present / runtime_kind / kind / cli /
//     capabilities / capability_boundary / invoke_contract / permissions / model_info / preflight）
//   · 消费方统一经 `readAgentFacts()` 读**合并视图**（observed 覆盖 manifest；observed 缺席时
//     回退 manifest —— 兼容窗口，不静默丢事实）。
//
// 纪律：observed 只由扫描器 / scan-models 经 bus-apply 写；本模块只读。

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 属于「发现事实」的键：扫描器写 observed.json，manifest 不再承载。 */
const DISCOVERED_KEYS = Object.freeze([
  'present', 'runtime_kind', 'kind', 'cli', 'capabilities', 'capability_boundary',
  'invoke_contract', 'permissions', 'model_info', 'preflight',
])

const OBSERVED_SCHEMA_VERSION = 1

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

/** 读 observed.json（缺席返回 null —— 由调用方决定回退口径）。 */
function readObserved(root, agentId) {
  return readJson(path.join(root, 'agents', agentId, 'observed.json'))
}

/** 读 manifest.json（Operator 字段；缺席返回 null）。 */
function readManifest(root, agentId) {
  return readJson(path.join(root, 'agents', agentId, 'manifest.json'))
}

/**
 * 合并视图（按 agent 目录）：manifest 为底，observed 的发现事实覆盖之。
 * 供已持有目录路径的消费方（archive/测试夹具）使用；`readAgentFacts(root,id)` 是便捷包装。
 */
function readAgentFactsFrom(agentDir) {
  const manifest = readJson(path.join(agentDir, 'manifest.json'))
  if (!manifest) return null
  const observed = readJson(path.join(agentDir, 'observed.json'))
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) {
    return Object.assign({}, manifest, { _facts_source: 'manifest-only' })
  }
  const facts = Object.assign({}, manifest, { _facts_source: 'manifest+observed' })
  for (const k of DISCOVERED_KEYS) {
    if (observed[k] !== undefined) facts[k] = observed[k]
  }
  if (observed.observed_at !== undefined) facts.observed_at = observed.observed_at
  return facts
}

/** 合并视图（按 root + agentId）。 */
function readAgentFacts(root, agentId) {
  return readAgentFactsFrom(path.join(root, 'agents', agentId))
}

/**
 * 把一份「混合视图」拆成 { operator, discovered } 两部分（扫描器迁移用）。
 * 不在 DISCOVERED_KEYS 里的键一律保留在 operator（未知的 Operator 字段不丢）。
 */
function splitFacts(mixed) {
  const operator = {}
  const discovered = {}
  for (const [k, v] of Object.entries(mixed || {})) {
    if (k === '_facts_source' || k === 'observed_at') continue
    if (DISCOVERED_KEYS.includes(k)) discovered[k] = v
    else operator[k] = v
  }
  return { operator, discovered }
}

/** 是否为「发现事实」键（列表外部消费方可用）。 */
function isDiscoveredKey(k) {
  return DISCOVERED_KEYS.includes(k)
}

module.exports = {
  DISCOVERED_KEYS,
  OBSERVED_SCHEMA_VERSION,
  readJson,
  readObserved,
  readManifest,
  readAgentFactsFrom,
  readAgentFacts,
  splitFacts,
  isDiscoveredKey,
}
