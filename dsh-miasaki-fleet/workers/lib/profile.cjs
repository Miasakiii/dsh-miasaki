// profile.cjs — P2-G（2026-10-21）：fleet profiles（整套委托快照）
//
// 解决的问题：Operator 的「开关 + 预算」意图散落在 N 个 control.json / manifest.limits 里，
// 想从「日常全开」切到「省预算/专注模式」只能逐个点。profile 是**声明式快照**：
//   · `shared/profiles.json` 里的一个 profile = 启用集合 + 每 agent 日预算；
//   · `workers/profile/apply-profile.mjs` 做差分并经 bus-apply 唯一入口落盘；
//   · profile **不碰发现事实**（kind/cli/model_info/permissions 在 observed.json，不在这里），
//     只写 Operator 字段（control.enabled / manifest.limits.budget_per_day）——职责边界与 P2-B 一致。
//
// 安全：profile 里出现未知 agent id 一律**显式失败**（打错字比少配更危险：静默忽略会让人以为生效）。

'use strict'

const PROFILE_ID_RE = /^[a-z][a-z0-9-]*$/
const AGENT_ID_RE = /^[a-z0-9-]+$/

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 校验 profiles 文档。返回 {ok, problems:[{where,message}]}。 */
function validateProfiles(doc) {
  const problems = []
  const err = (where, message) => problems.push({ where, message })
  if (!isObj(doc)) { err('$', 'profiles 应为 object'); return { ok: false, problems } }
  if (doc.version !== 1) err('$.version', `version 非法: ${doc.version}（应为 1）`)
  if (!isObj(doc.profiles) || Object.keys(doc.profiles).length === 0) {
    err('$.profiles', 'profiles 应为非空 object')
    return { ok: false, problems }
  }
  for (const [id, p] of Object.entries(doc.profiles)) {
    const w = `$.profiles.${id}`
    if (!PROFILE_ID_RE.test(id)) err(w, `profile id 非法: ${id}（应小写字母开头）`)
    if (!isObj(p)) { err(w, 'profile 应为 object'); continue }
    if (p.description !== undefined && typeof p.description !== 'string') err(`${w}.description`, 'description 应为 string')
    if (!Array.isArray(p.enabled)) err(`${w}.enabled`, 'enabled 应为 array（启用集合；未列出的 agent 视为关闭）')
    else {
      const seen = new Set()
      p.enabled.forEach((aid, i) => {
        if (typeof aid !== 'string' || !AGENT_ID_RE.test(aid)) err(`${w}.enabled[${i}]`, `agent id 非法: ${JSON.stringify(aid)}`)
        else if (seen.has(aid)) err(`${w}.enabled[${i}]`, `agent id 重复: ${aid}`)
        else seen.add(aid)
      })
    }
    if (p.budgets !== undefined) {
      if (!isObj(p.budgets)) err(`${w}.budgets`, 'budgets 应为 object（agent id → 日预算）')
      else for (const [aid, v] of Object.entries(p.budgets)) {
        if (!AGENT_ID_RE.test(aid)) err(`${w}.budgets.${aid}`, `agent id 非法: ${aid}`)
        if (!Number.isFinite(v) || v < 0) err(`${w}.budgets.${aid}`, `budget 应为非负数: ${JSON.stringify(v)}`)
      }
    }
  }
  return { ok: problems.length === 0, problems }
}

/** 取指定 profile；不存在返回 null（由 CLI 决定退出码）。 */
function getProfile(doc, profileId) {
  if (!isObj(doc) || !isObj(doc.profiles)) return null
  if (typeof profileId !== 'string' || !Object.prototype.hasOwnProperty.call(doc.profiles, profileId)) return null
  return doc.profiles[profileId]
}

/** 列出 profile id（按文件顺序）。 */
function listProfileIds(doc) {
  return isObj(doc) && isObj(doc.profiles) ? Object.keys(doc.profiles) : []
}

/**
 * 计算差分。agents: [{id, enabled, budget_per_day}]
 * @returns {{changes: Array<{agent_id, kind:'control'|'budget', from, to}>, unknownAgents: string[]}}
 */
function diffProfile(profile, agents) {
  const known = new Set((agents || []).map((a) => a.id))
  const unknownAgents = []
  const enabledSet = new Set()
  for (const aid of profile.enabled || []) {
    if (!known.has(aid)) unknownAgents.push(aid)
    else enabledSet.add(aid)
  }
  for (const aid of Object.keys(profile.budgets || {})) {
    if (!known.has(aid) && !unknownAgents.includes(aid)) unknownAgents.push(aid)
  }

  const changes = []
  for (const a of agents || []) {
    const wantEnabled = enabledSet.has(a.id)
    if (a.enabled !== wantEnabled) {
      changes.push({ agent_id: a.id, kind: 'control', from: a.enabled, to: wantEnabled })
    }
    if (profile.budgets && Object.prototype.hasOwnProperty.call(profile.budgets, a.id)) {
      const want = profile.budgets[a.id]
      if (a.budget_per_day !== want) changes.push({ agent_id: a.id, kind: 'budget', from: a.budget_per_day, to: want })
    }
  }
  return { changes, unknownAgents }
}

module.exports = {
  PROFILE_ID_RE,
  AGENT_ID_RE,
  validateProfiles,
  getProfile,
  listProfileIds,
  diffProfile,
}
