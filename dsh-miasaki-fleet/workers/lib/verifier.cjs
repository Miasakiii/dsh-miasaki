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
 * @param {object} ctx { agents: Map, vendors?, getAgent?(id) → {enabled, alive, archived, confidence, firstRun?} }
 *   `firstRun`（该 agent 从未运行过）来自 `liveness.cjs` 的 `isFirstRun`，用于**首跑豁免**（见下）；
 *   字段缺席按「非首跑」处理（保守：不豁免）。
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
    // 可用性判据。**首跑豁免**（2026-09-30 统一口径）：从未运行过的 agent（无 `status.json`）
    // 在判活里给 `alive=false`，但那是「没跑过」不是「僵尸」—— 不加豁免的话它**永远当不了验证者**，
    // 与派单闸门那侧「新 agent 永远派不出去」是**同族形态**（两侧此前各自实现，结论相反）。
    // 口径单点在 `liveness.cjs` 的 `isFirstRun`，经 `ctx.getAgent` 的 `firstRun` 传入。
    const firstRunOk = meta !== null && meta.firstRun === true
    const available = meta
      ? (meta.enabled === true && (meta.alive !== false || firstRunOk) && meta.archived !== true)
      : true
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

// ---------------------------------------------------------------------------
// WORK-01（2026-10-22）：判官前置的确定性 shell 闸
//
// 来源：外部逆向清单（luanyujia-workbench 09-改造参考 Hermes 05-改造清单 A 类第 9 条）
// —— 「质量闸：判官前置的确定性 shell 检查」。判据（照抄其验收命令）：
//   闸命令 exit≠0 ⇒ 判官**不被调用**；续跑提示 == 闸输出的**尾部 3000 字符**。
//
// 为什么判官之前必须先有确定性闸：判官（LLM 验证者）是**昂贵且会自欺**的一环——
// 测试都没跑过就让模型判「通过」，它真能给你编一个「看起来跑过了」的结论
// （ralph 那类「completion is worker self-declaration」正是没有这道闸的形态）。
// 反过来，确定性检查（exit code）不会客气：0 就是 0，非 0 就是非 0。
//
// 三条边界，每条都对着一种真实失效：
//   ① **只认显式声明**（brief 的 `gate:` 行或 --gate 传入），不猜——猜出来的命令
//      可能跑错东西，而「跑错还退出 0」比不跑更危险（虚假放行）。
//   ② **exitCode 不可信时显式失败**（非整数 ⇒ ok:false + error），不给结论——
//      与全仓「守卫必须显式失败」同口径：判据本身坏了的时候沉默 = 放行。
//   ③ **续跑提示只要尾部**：闸输出可能几万行，全量回贴会把生产者的上下文
//      再次顶爆（它刚炸过一次）；尾部 3000 字符含失败详情，且截断必须留痕。
// ---------------------------------------------------------------------------

/** 续跑提示的最大字符数（lyj 判据：尾部 3000 字符）。 */
const GATE_CONTINUATION_MAX = 3000

/**
 * 从 brief 文本里显式提取闸命令。
 *
 * 认 `gate:` / `确定性闸：` / `闸命令：` 三种写法（中英文冒号均可），
 * 取行尾剩余部分为命令。**没有声明就返回 null** —— 不猜。
 *
 * @param {string} briefText
 * @returns {string|null}
 */
function parseGateCommand(briefText) {
  if (typeof briefText !== 'string') return null
  // ⚠ 两个从 PowerShell/.NET 正则往 Node 抄时的陷阱（实测炸过）：
  //   ① `(?m)` 顶层内联标志在 JS 里**从来不是合法语法**（.NET 合法）⇒ 必须写成 /m flag；
  //   ② 字符类 `[:：]` 的 `[:` 开头会被 V8 当 POSIX 类 ⇒ 冒号用 (?::|：)。
  const m = briefText.match(/^[^\S\r\n]*(?:gate|确定性闸|闸命令)[^\S\r\n]*(?::|：)[^\S\r\n]*(.+?)[^\S\r\n]*$/m)
  if (!m) return null
  const cmd = m[1].trim()
  return cmd === '' ? null : cmd
}

/**
 * 取输出的尾部作为续跑提示（带截断标记，保证结果有界）。
 *
 * @param {string} output
 * @param {number} [max] 尾部字符上限
 * @returns {string}
 */
function tailForContinuation(output, max) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : GATE_CONTINUATION_MAX
  const text = typeof output === 'string' ? output : String(output ?? '')
  if (text.length <= limit) return text
  const marker = `…[earlier output truncated; showing last ${limit} chars]\n`
  return marker + text.slice(text.length - limit)
}

/**
 * 判定确定性闸的结果。
 *
 * @param {{exitCode: number, output?: string}} result
 * @returns {{ok: boolean, passed: boolean, continuation: string|null, error: string|null}}
 *   `ok=false` 表示判据本身不可信（exitCode 不是整数）—— 调用方必须显式失败，
 *   不得当作 passed 放行，也不得当作 failed 打回。
 */
function evaluateGate(result) {
  const r = result || {}
  const code = r.exitCode
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 0) {
    return {
      ok: false,
      passed: false,
      continuation: null,
      error: `闸的 exitCode 不可信（${JSON.stringify(code)}）—— 判据本身坏了，拒绝给出结论`,
    }
  }
  if (code === 0) {
    return { ok: true, passed: true, continuation: null, error: null }
  }
  return {
    ok: true,
    passed: false,
    continuation: tailForContinuation(r.output ?? ''),
    error: null,
  }
}

/**
 * 生成验证者的任务书文本（对抗立场 + 独立契约）。
 *
 * 三条设计要点，每条都针对一种真实的失效：
 *   · **对抗立场**：目标不是"确认通过"而是"找出反例"——找不到反例才给 pass
 *   · **独立输入**：只给产出物与原始验收标准，不给执行者的推理过程（防被叙事带偏）
 *   · **结构化输出**：verdict.json 契约（拒绝必须给 findings，findings 必须有 evidence）
 *
 * WORK-01 接线：`opts.gate` 传入确定性闸命令时，任务书的第一节就是它——
 * 判官必须先跑闸，exit≠0 时**不许**写 verdict（pass 或 reject 都不行），
 * 把闸输出尾部作为续跑提示退回给产出者。
 */
function buildVerifierBrief(taskId, producerId, opts) {
  const o = opts || {}
  const artifacts = Array.isArray(o.artifacts) ? o.artifacts : []
  const acceptance = Array.isArray(o.acceptance) ? o.acceptance : []
  const gate = typeof o.gate === 'string' && o.gate.trim() !== '' ? o.gate.trim() : null

  const lines = [
    `# 验证任务 ${taskId}（独立验证，产出者：${producerId}）`,
    '',
    '## 你的立场',
    '你**不是**来确认这份交付物没问题的，而是来**推翻**它的。',
    '只有当你**找不到任何反例**时，才给出 pass。',
    '产出者与你是不同的执行者，你们可能共用同一套盲点——请优先攻击"看起来最理所当然"的部分。',
    '',
  ]

  // WORK-01：判官前置的确定性闸。有声明 ⇒ 它是第 0 步，且失败时不许写 verdict；
  // 无声明 ⇒ 不静默跳过（那正是「没有闸」的缺陷形态），而是把退出码归因的
  // 注意事项写清楚——管道 / `||` / `&` / `&&` 全都会藏退出码（VER-01 的教训）。
  if (gate) {
    lines.push(
      '## 第 0 步：确定性闸（必须先跑，不过就不许往下走）',
      '',
      '```bash',
      gate,
      '```',
      '',
      '判据（硬规则）：',
      `- 退出码 **0** ⇒ 闸通过，继续下面的验证。`,
      `- 退出码 **非 0** ⇒ **不许**写 verdict.json（pass / reject 都不行），`,
      `  也**不许**调用任何模型判断——把闸输出的**尾部 ${GATE_CONTINUATION_MAX} 字符**作为续跑提示`,
      '  退回给产出者修（提示里写清：闸命令、退出码、尾部输出、要它改什么）。',
      '- ⚠ 管道会藏退出码：`npm test | head -20` 的退出码属于 `head`（恒 0）——',
      '  要可信的退出码，别让被测命令的输出经过管道或 `|| true`。',
      '',
    )
  } else {
    lines.push(
      '## 第 0 步：确定性闸（本任务**未声明**）',
      '',
      'brief 里没有 `gate:` 行——你没有可跑的确定性闸。此时先自己判断：',
      '- 有没有一条命令能对产物给出非 0 即失败的判定（测试 / 类型检查 / 构建）？',
      '  有就先跑它，判据同上（不过就不许往下走）；',
      '- 确实没有（纯文档 / 设计类交付）⇒ 在 verdict.json 里写明 `"gate": null` 与理由，',
      '  不许静默跳过这一节。',
      '- ⚠ 跑任何命令都注意退出码归因：管道 / `||` / `&` / `&&` 会藏退出码',
      '  （`npm test | tee log` 的退出码属于 `tee`）。',
      '',
    )
  }

  lines.push(
    '## 只看这些（独立契约）',
    '- 产出物本身',
    '- 原始验收标准',
    '',
    '**不要**参考产出者的推理过程、自我评价或测试结论——它们可能正是盲点所在。',
    '',
    '## 产出物',
  )
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
      gate: gate ? '<ran | not-run>' : null,
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
  // WORK-01（2026-10-22）：判官前置确定性闸
  GATE_CONTINUATION_MAX,
  parseGateCommand,
  tailForContinuation,
  evaluateGate,
}
