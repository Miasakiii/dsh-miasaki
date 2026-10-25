// selection-policy.cjs — P2-F（2026-10-21）：可插拔选型策略（只排序、不执行）
//
// 边界：策略**只影响候选排序**（权重不同 ⇒ 分数不同 ⇒ 顺序不同），不改变「谁能做/谁不可用」
// 的硬判定（类型闸门、判活、开关、覆盖过滤仍在 agent-pick/能力图里）。运行时代码不改，
// 换策略只换 `shared/selection-policy.json` 的默认项或命令行 `--strategy`。
//
// 权重口径与 `workers/lib/capability-graph.cjs` 的 DEFAULT_WEIGHTS 一致（同尺度，不是 0..1）。

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const WEIGHT_KEYS = Object.freeze(['coverage', 'confidence', 'cost', 'load'])

const DEFAULT_POLICY = Object.freeze({
  version: 1,
  default: 'balanced',
  strategies: {
    balanced: {
      description: '默认：覆盖优先，置信度与成本平滑',
      weights: { coverage: 100, confidence: 20, cost: 10, load: 5 },
    },
    cheap: {
      description: '成本优先（仅当档案声明 model_price 时产生区分度）',
      weights: { coverage: 60, confidence: 10, cost: 80, load: 5 },
    },
    reliable: {
      description: '历史成功率优先（Laplace 平滑后的 confidence）',
      weights: { coverage: 70, confidence: 60, cost: 5, load: 5 },
    },
    coverage: {
      description: '能力覆盖优先（宁可贵/慢也不缺能力）',
      weights: { coverage: 160, confidence: 10, cost: 5, load: 5 },
    },
  },
})

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 校验策略文档。返回 {ok, problems:[{where,message}]}。 */
function validatePolicy(doc) {
  const problems = []
  const err = (where, message) => problems.push({ where, message })
  if (!isObj(doc)) { err('$', 'selection-policy 应为 object'); return { ok: false, problems } }
  if (doc.version !== 1) err('$.version', `version 非法: ${doc.version}（应为 1）`)
  if (!isObj(doc.strategies) || Object.keys(doc.strategies).length === 0) {
    err('$.strategies', 'strategies 应为非空 object')
    return { ok: false, problems }
  }
  for (const [id, s] of Object.entries(doc.strategies)) {
    const w = `$.strategies.${id}`
    if (!/^[a-z][a-z0-9-]*$/.test(id)) err(`${w}`, `策略 id 非法: ${id}（应小写字母开头）`)
    if (!isObj(s)) { err(w, '策略应为 object'); continue }
    if (s.description !== undefined && typeof s.description !== 'string') err(`${w}.description`, 'description 应为 string')
    if (!isObj(s.weights)) { err(`${w}.weights`, 'weights 应为 object'); continue }
    for (const k of WEIGHT_KEYS) {
      if (!Number.isFinite(s.weights[k]) || s.weights[k] < 0 || s.weights[k] > 1000) {
        err(`${w}.weights.${k}`, `权重必须是非负数（0..1000）: ${JSON.stringify(s.weights[k])}`)
      }
    }
    for (const k of Object.keys(s.weights)) {
      if (!WEIGHT_KEYS.includes(k)) err(`${w}.weights.${k}`, `未知权重键（仅 ${WEIGHT_KEYS.join('/')}）`)
    }
  }
  if (typeof doc.default !== 'string' || !Object.prototype.hasOwnProperty.call(doc.strategies, doc.default)) {
    err('$.default', `default 必须指向已定义策略: ${JSON.stringify(doc.default)}`)
  }
  return { ok: problems.length === 0, problems }
}

/** 列出策略 id（默认项置顶）。 */
function listStrategies(policy) {
  if (!isObj(policy) || !isObj(policy.strategies)) return []
  const ids = Object.keys(policy.strategies)
  const def = policy.default
  return [def, ...ids.filter((x) => x !== def)]
}

/**
 * 解析策略权重。未知 id 抛错（**不静默回退** —— 打错策略名却按默认跑是危险静默）。
 * @returns {{id: string, description: string, weights: object}}
 */
function resolveStrategyWeights(policy, strategyId) {
  const id = strategyId || (isObj(policy) ? policy.default : 'balanced')
  const s = isObj(policy) && isObj(policy.strategies) ? policy.strategies[id] : null
  if (!s) {
    const known = isObj(policy) && isObj(policy.strategies) ? Object.keys(policy.strategies).join('/') : 'balanced'
    throw new Error(`未知选型策略: ${id}（可用：${known}）`)
  }
  return { id, description: s.description || '', weights: Object.assign({}, s.weights) }
}

/**
 * 读策略文件；缺席用内置默认（策略是可选增强，不是闸门）。
 * @returns {{policy: object, source: 'file'|'default', path: string}}
 */
function loadPolicy(root) {
  const p = path.join(root, 'shared', 'selection-policy.json')
  // guard-ok: 策略文件是可选增强（缺席用内置默认，agent-pick 会打印来源=内置默认；不是静默丢配置）
  if (!fs.existsSync(p)) return { policy: DEFAULT_POLICY, source: 'default', path: p }
  let doc
  try { doc = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch (e) {
    throw new Error(`shared/selection-policy.json 解析失败：${e.message}`)
  }
  const v = validatePolicy(doc)
  if (!v.ok) {
    throw new Error('shared/selection-policy.json 校验失败：' + v.problems.map((x) => x.where + ' ' + x.message).join('；'))
  }
  return { policy: doc, source: 'file', path: p }
}

module.exports = {
  WEIGHT_KEYS,
  DEFAULT_POLICY,
  validatePolicy,
  listStrategies,
  resolveStrategyWeights,
  loadPolicy,
}
