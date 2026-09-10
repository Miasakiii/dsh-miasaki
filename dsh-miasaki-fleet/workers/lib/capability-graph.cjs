// capability-graph.cjs — 能力图的构建、替代查找与选型（G2，2026-09-10）
//
// 为什么存在：fleet 的 agent 选择目前靠 manifest.skills 的**扁平字符串数组**
// 加 §6.3 的人工决策表。它只能回答「谁会什么」，回答不了：
//   · 任务要的能力现在**有没有人提供**（缺口）
//   · 某个 agent 归档/关闭后，**谁能替代**它（替代关系）
//   · 多个候选里选谁**代价最低而覆盖最全**（选型）
//
// 真实数据第一次跑起来就暴露了词表问题：归档的 coder 声明 `code`，活动 agent
// 声明 `coding` —— 字符串不等，替代关系因此断裂。所以本模块的第一件事是
// **能力规范化**（canonicalize），把技能名收敛到 canonical 能力 id。
//
// ── 别名策略：保守 + 可审计 ────────────────────────────────────────────
// 只收录**明确同义**的别名（如 code/coding）。不做相似度猜测——能力词表的
// 收敛是语义决策，应由人确认；本模块负责把它**显式化并可审计**，而不是替人猜。
// 未被任何 agent 提供的能力、以及疑似同义但未归一的技能，都通过 capabilityGaps
// 报出来，作为词表演进的输入。
//
// 全部为纯函数、无 IO：agent 记录与词表由调用方注入。
//
// 设计依据见 docs/graph-engineering-fleet-design.md §4（边类型清单、confidence
// 回填、选型算法）。

'use strict'

// ---------------------------------------------------------------------------
// 能力词表
// ---------------------------------------------------------------------------

/**
 * 内置别名表：技能名（小写）→ canonical 能力名。
 *
 * **只收录明确同义的**。真实数据里观察到的 code/coding 是确凿的一对；
 * 其余（如 analysis 与 comparative-analysis、browser 与 web-automation）
 * 语义是否等同需人工确认，故不预置，交由 capabilityGaps 报出。
 *
 * 可由调用方通过 opts.vocab.aliases 覆盖（CLI 支持读 shared/capability-vocab.json）。
 */
const DEFAULT_ALIASES = Object.freeze({
  code: 'coding',
  scripting: 'coding',
})

/** 能力 id 前缀：让能力节点与 agent / model 节点在图里一眼可分。 */
const CAP_PREFIX = 'cap:'

/** 规范化技能名：去空白、转小写、去连字符差异。 */
function normalizeSkill(skill) {
  return String(skill == null ? '' : skill).trim().toLowerCase()
}

/**
 * 把技能名归一为 canonical 能力名（不含前缀）。
 * 未命中别名表时**原样返回**——不猜，保留可审计性。
 *
 * 自定义别名表是**补充**而非替换：命中的用自定义，未命中的回落内置表。
 * 理由：调用方通常只想补几个别名（如把 research 并入 analysis），
 * 不该因此丢掉内置已确认的 code/coding。
 */
function canonicalize(skill, aliases) {
  const s = normalizeSkill(skill)
  if (s === '') return ''
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, s)) return aliases[s]
  return DEFAULT_ALIASES[s] || s
}

/** 技能名 → 能力节点 id。 */
function capabilityId(skill, aliases) {
  const c = canonicalize(skill, aliases)
  return c === '' ? '' : `${CAP_PREFIX}${c}`
}

// ---------------------------------------------------------------------------
// 图构建
// ---------------------------------------------------------------------------

/**
 * 由 agent 记录构建能力图。
 *
 * @param {Array<object>} agents 记录形如
 *   { id, skills[], model?, modelPrice?: {input,output}?, metering?,
 *     archived?, enabled?, alive?, state?, accepted?, reopened?, failed? }
 * @param {object} [opts] { vocab: { aliases } }
 * @returns {{agents: Map, capabilities: Map, edges: Array, issues: Array}}
 *   capabilities: Map<capId, { id, name, agents: string[], archivedAgents: string[] }>
 */
function buildCapabilityGraph(agents, opts) {
  const aliases = opts && opts.vocab && opts.vocab.aliases ? opts.vocab.aliases : DEFAULT_ALIASES
  const agentMap = new Map()
  const capabilities = new Map()
  const edges = []
  const issues = []

  for (const raw of agents || []) {
    if (!raw || typeof raw.id !== 'string' || raw.id === '') continue
    const archived = raw.archived === true

    // 能力级 confidence 需要任务声明能力需求（v2 才做）。v1 用 agent 级成功率，
    // 带 Laplace 平滑：无历史时返回 0.5（既不奖励也不惩罚新 agent）。
    const accepted = Number.isFinite(raw.accepted) ? raw.accepted : 0
    const reopened = Number.isFinite(raw.reopened) ? raw.reopened : 0
    const failed = Number.isFinite(raw.failed) ? raw.failed : 0
    const confidence = (accepted + 1) / (accepted + reopened + failed + 2)

    const agent = {
      id: raw.id,
      archived,
      enabled: raw.enabled === true,
      alive: raw.alive !== false,
      state: raw.state || null,
      model: raw.model || null,
      modelPrice: raw.modelPrice || null,
      metering: raw.metering || null,
      confidence: Math.round(confidence * 1000) / 1000,
      history: { accepted, reopened, failed },
      capabilities: [],
      skills: [],
    }

    const seen = new Set()
    for (const skill of Array.isArray(raw.skills) ? raw.skills : []) {
      const norm = normalizeSkill(skill)
      if (norm === '') continue
      const cap = canonicalize(norm, aliases)
      const id = `${CAP_PREFIX}${cap}`
      if (seen.has(id)) {
        if (norm !== cap) {
          issues.push({
            kind: 'duplicate_after_canonicalize',
            agentId: agent.id,
            skill: norm,
            canonical: cap,
            detail: `${norm} 与 ${cap} 规范后撞成同一能力（档案里冗余声明）`,
          })
        }
        continue
      }
      seen.add(id)
      agent.skills.push(norm)
      agent.capabilities.push(id)

      if (!capabilities.has(id)) {
        capabilities.set(id, { id, name: cap, agents: [], archivedAgents: [] })
      }
      const node = capabilities.get(id)
      if (archived) node.archivedAgents.push(agent.id)
      else node.agents.push(agent.id)

      edges.push({
        from: `agent:${agent.id}`,
        to: id,
        type: 'provides',
        confidence: agent.confidence,
        archived,
      })
    }

    // costs 边：只有声明了单价才有；当前归档档案有真实模型，活动档案多为 null
    if (agent.modelPrice && Number.isFinite(agent.modelPrice.input) && Number.isFinite(agent.modelPrice.output)) {
      edges.push({
        from: `agent:${agent.id}`,
        to: 'ledger',
        type: 'costs',
        usd_per_1k_input: agent.modelPrice.input,
        usd_per_1k_output: agent.modelPrice.output,
      })
    }

    if (agent.capabilities.length === 0) {
      issues.push({ kind: 'no_capabilities', agentId: agent.id, detail: '档案未声明任何技能，选型时永远匹配不上' })
    }
    if (!agent.model || agent.model === 'cli-default') {
      issues.push({ kind: 'no_explicit_model', agentId: agent.id, detail: `model=${agent.model ?? 'null'}，多模型选型缺乏真实数据` })
    }

    agentMap.set(agent.id, agent)
  }

  // 能力节点排序，保证输出稳定（便于 diff 与测试）
  for (const node of capabilities.values()) {
    node.agents.sort()
    node.archivedAgents.sort()
  }

  return { agents: agentMap, capabilities, edges, issues }
}

// ---------------------------------------------------------------------------
// 替代查找（对应 §4.3 的 substitutable_by 边）
// ---------------------------------------------------------------------------

/**
 * 找某 agent 的替代者：按能力覆盖度排序，分「完全覆盖」与「部分覆盖」两档。
 *
 * 为什么不用一个阈值一刀切：真实情况下常常没有完全替代者，此时
 * 「覆盖 3/4、缺 zh-report」这种部分信息对 Commander 才有决策价值。
 *
 * @param {string} agentId          被替代的 agent
 * @param {object} graph            buildCapabilityGraph 的结果
 * @param {object} [opts]           { includeArchived?, includeUnavailable?, minCoverage? }
 */
function findSubstitutes(agentId, graph, opts) {
  const o = opts || {}
  const minCoverage = Number.isFinite(o.minCoverage) ? o.minCoverage : 0.01
  const target = graph.agents.get(agentId)
  if (!target) return { agentId, found: false, reason: '目标 agent 不在图中', full: [], partial: [] }

  const required = [...target.capabilities].sort()
  if (required.length === 0) {
    return { agentId, found: true, required, full: [], partial: [], reason: '目标 agent 未声明任何能力，无从匹配' }
  }

  const full = []
  const partial = []

  for (const cand of graph.agents.values()) {
    if (cand.id === agentId) continue
    if (cand.archived && !o.includeArchived) continue
    if (!cand.enabled && !o.includeUnavailable) continue

    const have = new Set(cand.capabilities)
    const covered = required.filter((c) => have.has(c))
    const missing = required.filter((c) => !have.has(c))
    const coverage = covered.length / required.length
    if (coverage < minCoverage) continue

    const entry = {
      agentId: cand.id,
      coverage: Math.round(coverage * 1000) / 1000,
      covered,
      missing,
      confidence: cand.confidence,
      available: cand.enabled && cand.alive && !cand.archived,
    }
    if (missing.length === 0) full.push(entry)
    else partial.push(entry)
  }

  const byCoverage = (a, b) => (b.coverage - a.coverage) || a.agentId.localeCompare(b.agentId)
  full.sort(byCoverage)
  partial.sort(byCoverage)

  return {
    agentId,
    found: true,
    required,
    full,
    partial,
    reason: full.length === 0 && partial.length === 0 ? '没有任何 agent 提供所需能力' : null,
  }
}

// ---------------------------------------------------------------------------
// 选型（对应 §4.5 的评分替换 §6.3 人工决策表）
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS = Object.freeze({
  coverage: 100, // 能力覆盖是主项
  confidence: 20, // 历史可靠性
  cost: 10, // 成本惩罚上限
  load: 5, // 负载惩罚上限
})

/**
 * 给单个 agent 打分。分数可解释：每一项都由调用方可见的数据算出。
 *
 *   score = coverage·coverageRatio + confidence·(conf − 0.5)
 *         − cost·normalizedCost − load·loadRatio
 *
 * 无声明单价的 agent 按 0 成本计（当前活动档案普遍没有 model_price），
 * 因此成本项在数据补齐前不产生区分度——这一点在 issues 里会被报出来。
 */
function scoreAgent(agent, required, ctx) {
  const weights = { ...DEFAULT_WEIGHTS, ...(ctx && ctx.weights) }
  const have = new Set(agent.capabilities)
  const covered = required.filter((c) => have.has(c))
  const missing = required.filter((c) => !have.has(c))
  const coverageRatio = required.length === 0 ? 1 : covered.length / required.length

  const confTerm = weights.confidence * (agent.confidence - 0.5)

  let costTerm = 0
  if (agent.modelPrice && Number.isFinite(ctx && ctx.estTokens)) {
    const perK = (agent.modelPrice.input + agent.modelPrice.output) / 2
    const raw = (perK * (ctx.estTokens / 1000))
    const maxRaw = Number.isFinite(ctx && ctx.maxCostRef) && ctx.maxCostRef > 0 ? ctx.maxCostRef : 1
    costTerm = weights.cost * Math.min(1, raw / maxRaw)
  }

  const loadTerm = weights.load * (agent.state === 'running' ? 1 : 0)

  const score = weights.coverage * coverageRatio + confTerm - costTerm - loadTerm

  return {
    agentId: agent.id,
    score: Math.round(score * 100) / 100,
    coverageRatio: Math.round(coverageRatio * 1000) / 1000,
    covered,
    missing,
    confidence: agent.confidence,
    available: agent.enabled && agent.alive && !agent.archived,
    breakdown: { coverage: weights.coverage * coverageRatio, confidence: confTerm, cost: -costTerm, load: -loadTerm },
  }
}

/**
 * 按任务的能力需求选型，返回按分数排序的候选。
 *
 * 与 §6.3 人工决策表的关系：人工表降级为**兜底**（本函数无可用候选时），
 * 不是被删除——图求解失败时仍需要人拍板。
 *
 * @param {string[]} required 能力 id 或裸技能名（会自动 canonical 化）
 * @param {object} graph
 * @param {object} [opts] { includeArchived?, includeUnavailable?, weights?, estTokens?, maxCostRef?, requireFull? }
 */
function selectAgents(required, graph, opts) {
  const o = opts || {}
  const normalized = [...new Set((required || []).map((r) => {
    if (typeof r !== 'string' || r.trim() === '') return ''
    return r.startsWith(CAP_PREFIX) ? r : capabilityId(r, o.vocab && o.vocab.aliases)
  }).filter(Boolean))].sort()

  const candidates = []
  for (const agent of graph.agents.values()) {
    if (agent.archived && !o.includeArchived) continue

    const scored = scoreAgent(agent, normalized, o)
    if (o.requireFull && scored.missing.length > 0) continue
    if (scored.covered.length === 0 && normalized.length > 0) continue // 一点都覆盖不上就不进候选
    // 不可用原因**总是**标注（无论是否被 includeUnavailable 放进候选）——
    // 调用方需要看到「为什么它排在后面」或者「为什么它被排除」。
    if (!scored.available) {
      scored.unavailableReason = agent.archived ? '已归档' : (!agent.enabled ? '开关未开启' : '判活失败')
    }
    candidates.push(scored)
  }

  // 不可用的排在可用之后，其余按分数降序；同分按 id 保证稳定
  candidates.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    return a.agentId.localeCompare(b.agentId)
  })

  // 缺口 = 没有任何**活动**提供者的能力。注意区分两种情况：
  //   · 图上完全没有这个节点     → 纯粹的未知能力（技能名可能写错了）
  //   · 有节点但只有归档/无人提供 → 能力断层（例如 coder 归档后的 engineering）
  // 两者对 Commander 的含义不同，但对选型而言都是「现在没人能做」。
  const missingCapabilities = normalized.filter((c) => {
    const node = graph.capabilities.get(c)
    return !node || node.agents.length === 0
  })

  return { required: normalized, candidates, missingCapabilities }
}

// ---------------------------------------------------------------------------
// 诊断：能力缺口与词表问题
// ---------------------------------------------------------------------------

/**
 * 图层面的诊断。这是能力图「活起来」的地方——它报出的是**系统性问题**，
 * 不是单个任务的问题：
 *   · 无人提供的能力（能力缺口）
 *   · 只有归档 agent 提供的能力（一关就断）
 *   · 疑似同义但未归一的技能（词表演进输入）
 */
function capabilityGaps(graph) {
  const orphan = []
  const archivedOnly = []
  for (const node of graph.capabilities.values()) {
    if (node.agents.length === 0) {
      if (node.archivedAgents.length > 0) archivedOnly.push({ capability: node.id, archivedAgents: node.archivedAgents })
      else orphan.push({ capability: node.id })
    }
  }

  // 疑似同义：canonical 名互为前缀/包含关系（保守提示，不自动合并）
  const names = [...graph.capabilities.keys()].map((id) => id.slice(CAP_PREFIX.length)).sort()
  const suspected = []
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]
      const b = names[j]
      if (a.length >= 4 && b.includes(a)) {
        suspected.push({ a: `${CAP_PREFIX}${a}`, b: `${CAP_PREFIX}${b}`, reason: '名称存在包含关系，可能是同一能力的两种写法' })
      }
    }
  }

  return {
    orphanCapabilities: orphan.sort((x, y) => x.capability.localeCompare(y.capability)),
    archivedOnly: archivedOnly.sort((x, y) => x.capability.localeCompare(y.capability)),
    suspectedSynonyms: suspected,
    issues: graph.issues,
  }
}

module.exports = {
  CAP_PREFIX,
  DEFAULT_ALIASES,
  DEFAULT_WEIGHTS,
  normalizeSkill,
  canonicalize,
  capabilityId,
  buildCapabilityGraph,
  findSubstitutes,
  scoreAgent,
  selectAgents,
  capabilityGaps,
}
