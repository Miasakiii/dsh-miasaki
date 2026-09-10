// verifier.cjs — 验证器选取与异构性判定（G4，2026-09-10）
//
// 为什么存在：主协议 §6.4 第 6 条已经发现病灶——
//   「涉及 UI / 浏览器 / 真实环境的产物不得只信 worker 自测：Agent 写的测试易与
//     实现共用盲点（实测：DSH 与 Kimi Code 均出现自测通过、真实浏览器失败）」
// 但当时**验证者与拆解者是同一个**（都是 Commander），且 Commander 是"想让它过"的一方。
//
// 本模块把「谁来验证」变成可判定的问题，核心是**异构性**：
//   · 同一个 agent 验证自己 → 自验，禁止（level = none）
//   · 不同 agent、同一模型 → 共用同一套盲点（level = agent）
//   · 不同模型             → 盲点大概率不重合（level = model）
//   · 不同厂商             → 最强异构（level = vendor）
//
// ── 一个关键的现实约束与应对 ──────────────────────────────────────────
// 勘察发现：8 个活动 agent 的 manifest.model **全是 `cli-default`**，
// 即"不同模型"这一级在当前数据下**无法判定**。但 fleet 有一个别处没有的条件：
// **本机 8 个 agent CLI 天然来自不同厂商**。所以本模块以「agent → 厂商」的
// 静态映射作为**不依赖 manifest 数据**的异构依据 —— 即使模型字段缺失，
// 厂商级异构仍可判定。这正是 G4 在当前数据下仍可落地的原因。
//
// 全部为纯函数、无 IO。

'use strict'

/**
 * agent → 厂商映射（内置）。
 *
 * 依据是本机实际安装的 npm 包（`npm ls -g` 实测）：
 *   @deepseek-ai/dsh · @earendil-works/pi-coding-agent · @mimo-ai/cli ·
 *   bailian-cli · agent-browser · claude · gemini · opencode
 * 可由 shared/agent-vendors.json 覆盖（用于新增 agent 或纠正归属）。
 */
const DEFAULT_VENDORS = Object.freeze({
  claude: 'anthropic',
  gemini: 'google',
  opencode: 'sst',
  pi: 'earendil-works',
  dsh: 'deepseek',
  mimo: 'xiaomi',
  bl: 'alibaba',
  'agent-browser': 'independent',
})

/** 异构等级，由弱到强。none 表示自验（必须拒绝）。 */
const HETERO_LEVELS = Object.freeze(['none', 'agent', 'model', 'vendor'])

function levelRank(level) {
  const i = HETERO_LEVELS.indexOf(level)
  return i < 0 ? -1 : i
}

/** a 是否达到或超过 b 的异构强度。 */
function levelAtLeast(a, b) {
  return levelRank(a) >= levelRank(b)
}

/** 查厂商；未登记返回 'unknown'（不猜）。 */
function vendorOf(agentId, vendors) {
  const table = vendors || DEFAULT_VENDORS
  const v = table[agentId]
  return typeof v === 'string' && v !== '' ? v : 'unknown'
}

/**
 * 规范化模型名。`cli-default` 与空值一律视为**未声明**——
 * 它不携带任何区分信息，当成真值会让「不同模型」这一级产生虚假的异构结论。
 */
function normalizeModel(model) {
  if (typeof model !== 'string') return null
  const m = model.trim()
  if (m === '' || m === 'cli-default') return null
  return m
}

/**
 * 判定产出者与验证者之间的异构性。
 *
 * @param {string} producerId
 * @param {string} verifierId
 * @param {object} ctx { agents: Map<id, {model?}>, vendors? }
 * @returns {{level: string, ok: boolean, sameModel: boolean, sameVendor: boolean,
 *            modelKnown: boolean, reasons: string[]}}
 */
function assessHeterogeneity(producerId, verifierId, ctx) {
  const reasons = []

  if (producerId === verifierId) {
    return {
      level: 'none',
      ok: false,
      sameModel: true,
      sameVendor: true,
      modelKnown: false,
      reasons: [`验证者与产出者是同一个 agent（${producerId}）—— 自验，禁止`],
    }
  }

  const agents = (ctx && ctx.agents) || new Map()
  const p = agents.get(producerId)
  const v = agents.get(verifierId)
  const pModel = normalizeModel(p && p.model)
  const vModel = normalizeModel(v && v.model)
  const pVendor = vendorOf(producerId, ctx && ctx.vendors)
  const vVendor = vendorOf(verifierId, ctx && ctx.vendors)

  const modelKnown = pModel !== null && vModel !== null
  const vendorKnown = pVendor !== 'unknown' && vVendor !== 'unknown'
  const sameModel = modelKnown && pModel === vModel
  const sameVendor = vendorKnown && pVendor === vVendor

  // 从强到弱判定。厂商不同 ⇒ 必然不同模型，故厂商级优先。
  let level = 'agent'
  if (vendorKnown && !sameVendor) {
    level = 'vendor'
  } else if (modelKnown && !sameModel) {
    level = 'model'
  }

  if (!modelKnown) {
    reasons.push('模型未声明（manifest.model 为 cli-default 或缺失），无法按模型判定异构')
  } else if (sameModel) {
    reasons.push(`两者同为模型 ${pModel} —— 同源盲点可能重合，异构性仅达 agent 级`)
  }
  if (vendorKnown && sameVendor) {
    reasons.push(`两者同厂商 ${pVendor}`)
  }
  if (!vendorKnown) {
    reasons.push(`厂商归属未知（${pVendor === 'unknown' ? producerId : verifierId} 未登记），无法按厂商判定`)
  }

  return { level, ok: true, sameModel, sameVendor, modelKnown, reasons }
}

/**
 * 为某个产出者挑选验证者。
 *
 * @param {string} producerId
 * @param {object} ctx { agents: Map, vendors?, getAgent?(id) → {enabled, alive, archived, confidence} }
 * @param {object} [opts] { minLevel='agent', includeUnavailable?, requireAvailable? }
 */
function selectVerifiers(producerId, ctx, opts) {
  const o = opts || {}
  const minLevel = o.minLevel || 'agent'
  const candidates = []
  const warnings = []

  const agents = (ctx && ctx.agents) || new Map()
  for (const id of agents.keys()) {
    if (id === producerId) continue
    const het = assessHeterogeneity(producerId, id, ctx)
    if (!levelAtLeast(het.level, minLevel)) continue

    const meta = typeof ctx.getAgent === 'function' ? ctx.getAgent(id) : null
    const available = meta ? (meta.enabled === true && meta.alive !== false && meta.archived !== true) : true
    if (o.requireAvailable !== false && !available && !o.includeUnavailable) continue

    candidates.push({
      agentId: id,
      level: het.level,
      levelRank: levelRank(het.level),
      available,
      unavailableReason: available ? null : (meta && meta.archived ? '已归档' : (!meta || meta.enabled !== true ? '开关未开启' : '判活失败')),
      confidence: meta && Number.isFinite(meta.confidence) ? meta.confidence : null,
      notes: het.reasons,
    })
  }

  // 排序：异构强度优先（强异构更能发现盲点），其次可用性，再次历史 confidence
  candidates.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1
    if (b.levelRank !== a.levelRank) return b.levelRank - a.levelRank
    const ca = a.confidence === null ? -1 : a.confidence
    const cb = b.confidence === null ? -1 : b.confidence
    if (cb !== ca) return cb - ca
    return a.agentId.localeCompare(b.agentId)
  })

  if (candidates.length === 0) {
    warnings.push(`没有满足 minLevel=${minLevel} 的验证者候选`)
  }
  // 当前数据下的普遍情况：没有一个候选达到 model 或 vendor 级
  if (candidates.length > 0 && !candidates.some((c) => c.levelRank >= levelRank('model'))) {
    warnings.push('所有候选的异构性都只达 agent 级 —— 模型字段普遍缺失，无法保证盲点不重合')
  }

  return { producerId, minLevel, candidates, warnings }
}

/**
 * 生成验证者的任务书文本（对抗立场 + 独立契约）。
 *
 * 三条设计要点，每条都针对一种真实的失效：
 *   · **对抗立场**：目标不是"确认通过"而是"找出反例"——找不到反例才给 pass
 *   · **独立输入**：只给产出物与原始验收标准，不给执行者的推理过程（防被叙事带偏）
 *   · **结构化输出**：verdict.json 契约（拒绝必须给 findings，findings 必须有 evidence）
 */
function buildVerifierBrief(taskId, producerId, opts) {
  const o = opts || {}
  const artifacts = Array.isArray(o.artifacts) ? o.artifacts : []
  const acceptance = Array.isArray(o.acceptance) ? o.acceptance : []

  const lines = [
    `# 验证任务 ${taskId}（独立验证，产出者：${producerId}）`,
    '',
    '## 你的立场',
    '你**不是**来确认这份交付物没问题的，而是来**推翻**它的。',
    '只有当你**找不到任何反例**时，才给出 pass。',
    '产出者与你是不同的执行者，你们可能共用同一套盲点——请优先攻击"看起来最理所当然"的部分。',
    '',
    '## 只看这些（独立契约）',
    '- 产出物本身',
    '- 原始验收标准',
    '',
    '**不要**参考产出者的推理过程、自我评价或测试结论——它们可能正是盲点所在。',
    '',
    '## 产出物',
  ]
  if (artifacts.length === 0) lines.push('- （未列出，请以任务目录下的 `result.json` 与 `result/` 为准）')
  else for (const a of artifacts) lines.push(`- \`${a}\``)

  lines.push('', '## 原始验收标准')
  if (acceptance.length === 0) lines.push('1. （未结构化提供，请从 brief.md 读取）')
  else acceptance.forEach((a, i) => lines.push(`${i + 1}. ${a}`))

  lines.push(
    '',
    '## 必须产出',
    `写入 \`tasks/${taskId}/verdict.json\`：`,
    '',
    '```json',
    JSON.stringify({
      task_id: taskId,
      verifier: '<你的 agent id>',
      verdict: 'pass | reject',
      findings: [
        { severity: 'high | medium | low', claim: '一句可判断的陈述', evidence: { type: 'file', ref: '...' } },
      ],
      confidence: 0.0,
      checked_at: '<ISO-8601 UTC>',
    }, null, 2),
    '```',
    '',
    '**规则**：给出 `reject` 时必须至少有一条 finding——拒绝必须说明依据；',
    '每条 finding 必须有可核对的 `evidence`。找不到反例时给 `pass`，`findings` 可为空数组。',
  )
  return lines.join('\n')
}

/**
 * 汇总某任务的全部验证结论。
 *
 * 多次验证（例如重开后复验）时，**最新一条**决定当前状态——
 * 与主协议 §4.5 的台账重放口径一致。任一 reject 都不会被后来的 pass 静默抹掉：
 * 它保留在历史里，供"这个任务被驳回过几次"的诊断使用。
 */
function summarizeVerdicts(verdicts, taskId) {
  const mine = (verdicts || []).filter((v) => v && v.task_id === taskId)
  if (mine.length === 0) return { taskId, verified: false, verdict: null, rejectCount: 0, latest: null }
  const latest = mine[mine.length - 1]
  return {
    taskId,
    verified: true,
    verdict: latest.verdict,
    latest,
    total: mine.length,
    rejectCount: mine.filter((v) => v.verdict === 'reject').length,
  }
}

module.exports = {
  DEFAULT_VENDORS,
  HETERO_LEVELS,
  levelRank,
  levelAtLeast,
  vendorOf,
  normalizeModel,
  assessHeterogeneity,
  selectVerifiers,
  buildVerifierBrief,
  summarizeVerdicts,
}
