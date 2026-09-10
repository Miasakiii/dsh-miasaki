// bus-contract.cjs — 文件总线契约校验的唯一实现（G0，2026-09-10）
//
// 为什么存在：G0 之前，总线契约散落在两处 —— schemas/*.schema.json 是给人看的
// 文档，workers/validate-bus.mjs 是手写校验，两者靠人工保持一致。新增
// graph / result / patch / event 四类契约后，两处漂移的风险会显著上升。
//
// 本模块把「什么算合法」收敛为一份**可执行定义**：
//   · workers/bus/bus-apply.mjs  —— 写入时调用（事前拦截）
//   · workers/validate-bus.mjs   —— 巡检时调用（事后兜底）
// 同一口径，两处消费。与 workers/lib/liveness.cjs 的做法一致。
//
// 全部为纯函数、无 IO：校验失败通过注入的 `fail(where, msg)` 回调上报，
// 由调用方决定是抛异常（applier）还是记错误（巡检）。
//
// 设计依据见 docs/graph-engineering-fleet-design.md §2.2 / §3.2 / §3.6 / §5.3。

'use strict'

// ---------------------------------------------------------------------------
// 通用谓词
// ---------------------------------------------------------------------------

/** 非空字符串。 */
function isStr(v) {
  return typeof v === 'string' && v.trim() !== ''
}

/** 有限数字（拒绝 NaN / Infinity / 数字字符串）。 */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 非负整数。 */
function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0
}

/** 普通对象（排除数组与 null）。 */
function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** task id 形态：t-0001。所有引用型字段都用它，避免自由文本混入。 */
const TASK_ID_RE = /^t-\d{4}$/
/** 钻石图分组 id 形态：g-0003。 */
const GROUP_RE = /^g-\d{4}$/
/** agent id 形态（与 registry 校验口径一致）。 */
const AGENT_ID_RE = /^[a-z0-9-]+$/
/** sha256 十六进制摘要。 */
const SHA256_RE = /^[0-9a-f]{64}$/

function isTaskId(v) {
  return typeof v === 'string' && TASK_ID_RE.test(v)
}

// ---------------------------------------------------------------------------
// 节点图（tasks.jsonl 的 graph 子对象）—— 设计 §3.2
// ---------------------------------------------------------------------------

/** 节点在图中的角色。 */
const NODE_KINDS = new Set(['work', 'fan_out', 'reduce', 'verify', 'gate'])

/**
 * 校验 graph 子对象。缺失即「不入图」，等同现状，不算错误（增量式采用）。
 *
 * @param {object} g      待校验的 graph 对象
 * @param {string} where  错误定位前缀
 * @param {Function} fail fail(where, msg)
 * @returns {boolean} 是否通过
 */
function validateGraph(g, where, fail) {
  let bad = 0
  const err = (msg) => { bad++; fail(where, msg) }

  // 缺失即「不入图」：等同现状，不是错误。宽容处理让调用方不必先判空 ——
  // 增量式采用是本设计的前提（无 graph 字段的旧台账一律按 work 节点对待）。
  if (g === undefined || g === null) return true
  if (!isObj(g)) { err('graph 应为 object'); return false }

  if (!NODE_KINDS.has(g.node_kind)) {
    err(`graph.node_kind 非法: ${JSON.stringify(g.node_kind)}（应为 ${[...NODE_KINDS].join('|')}）`)
  }
  if (g.group !== undefined && !(typeof g.group === 'string' && GROUP_RE.test(g.group))) {
    err(`graph.group 形态非法: ${JSON.stringify(g.group)}（应为 g-0000）`)
  }
  if (g.parent !== undefined && !isTaskId(g.parent)) {
    err(`graph.parent 形态非法: ${JSON.stringify(g.parent)}（应为 t-0000）`)
  }

  // consumes[] —— 数据依赖：本任务真的要读谁的哪个产物
  if (g.consumes !== undefined) {
    if (!Array.isArray(g.consumes)) {
      err('graph.consumes 应为 array')
    } else {
      const seen = new Set()
      g.consumes.forEach((c, i) => {
        const w = `${where} graph.consumes[${i}]`
        if (!isObj(c)) { fail(w, '应为 object'); bad++; return }
        if (!isTaskId(c.task)) { fail(w, `task 形态非法: ${JSON.stringify(c.task)}`); bad++ }
        else if (seen.has(c.task)) { fail(w, `consume 重复声明同一上游: ${c.task}`); bad++ }
        else seen.add(c.task)
        if (!isStr(c.artifact)) { fail(w, '缺少 artifact（边按数据命名，不能只写"第二步"）'); bad++ }
        if (c.required !== undefined && typeof c.required !== 'boolean') { fail(w, 'required 应为 boolean'); bad++ }
      })
    }
  }

  // produces —— 本任务的产出契约（供下游 consumes 引用）
  if (g.produces !== undefined) {
    if (!isObj(g.produces)) {
      err('graph.produces 应为 object')
    } else {
      if (!isStr(g.produces.artifact)) err('graph.produces.artifact 缺失')
      if (g.produces.schema !== undefined && !isStr(g.produces.schema)) err('graph.produces.schema 应为 string')
    }
  }

  // 结构性规则：reduce 是汇合点，没有上游就没有意义
  if (g.node_kind === 'reduce') {
    if (!Array.isArray(g.consumes) || g.consumes.length === 0) {
      err('node_kind=reduce 必须声明非空 consumes（汇合点的定义）')
    }
  }
  // verify 必须消费被验证的对象
  if (g.node_kind === 'verify') {
    if (!Array.isArray(g.consumes) || g.consumes.length === 0) {
      err('node_kind=verify 必须声明非空 consumes（验证对象）')
    }
  }

  return bad === 0
}

// ---------------------------------------------------------------------------
// 节点交付契约（tasks/<id>/result.json）—— 设计 §3.6
// ---------------------------------------------------------------------------

const RESULT_STATUS = new Set(['completed', 'blocked', 'failed'])
const EVIDENCE_TYPES = new Set(['url', 'file', 'task', 'command'])

/**
 * 校验节点交付契约 result.json。
 *
 * 这是「节点要有契约」的落点：人类可读的 result-<id>.md 保持不变，
 * result.json 提供机器可读的结论 + 证据 + 产物指纹，让下游 consumes
 * 校验与验收预检成为可能。
 *
 * @param {object} r            待校验对象
 * @param {string} where        错误定位前缀
 * @param {Function} fail       fail(where, msg)
 * @param {string} [expectTaskId] 若给出，则校验 task_id 与其一致
 */
function validateResult(r, where, fail, expectTaskId) {
  let bad = 0
  const err = (msg) => { bad++; fail(where, msg) }

  if (!isObj(r)) { err('result.json 应为 object'); return false }

  if (!isTaskId(r.task_id)) err(`task_id 形态非法: ${JSON.stringify(r.task_id)}`)
  else if (expectTaskId && r.task_id !== expectTaskId) {
    err(`task_id 与所在任务目录不一致: ${r.task_id} vs ${expectTaskId}`)
  }

  if (!RESULT_STATUS.has(r.status)) {
    err(`status 非法: ${JSON.stringify(r.status)}（应为 ${[...RESULT_STATUS].join('|')}）`)
  }

  // 结论：下游要能直接引用或转交，不能为空
  if (!isStr(r.conclusion)) err('conclusion 缺失（下游需要可直接引用的一句话结论）')

  if (r.completeness !== undefined) {
    if (!isObj(r.completeness)) err('completeness 应为 object')
    else {
      for (const k of ['done', 'missing']) {
        if (r.completeness[k] !== undefined && !Array.isArray(r.completeness[k])) {
          err(`completeness.${k} 应为 array`)
        }
      }
    }
  }

  // 证据：G4 验证器与验收预检都依赖它 —— 必填且每项可解析
  if (!Array.isArray(r.evidence)) {
    err('evidence 应为 array（可空数组，但字段必须存在）')
  } else {
    r.evidence.forEach((e, i) => {
      const w = `${where} evidence[${i}]`
      if (!isObj(e)) { fail(w, '应为 object'); bad++; return }
      if (!EVIDENCE_TYPES.has(e.type)) { fail(w, `type 非法: ${JSON.stringify(e.type)}`); bad++ }
      if (!isStr(e.ref)) { fail(w, '缺少 ref（证据必须是可核对的引用，不接受自由文本）'); bad++ }
      if (e.type === 'task' && !isTaskId(e.ref)) { fail(w, `type=task 的 ref 应为 t-0000: ${e.ref}`); bad++ }
      if (e.sha256 !== undefined && !(typeof e.sha256 === 'string' && SHA256_RE.test(e.sha256))) {
        fail(w, 'sha256 形态非法')
      }
    })
  }

  if (r.blockers !== undefined && !Array.isArray(r.blockers)) err('blockers 应为 array')

  if (r.artifacts !== undefined) {
    if (!Array.isArray(r.artifacts)) {
      err('artifacts 应为 array')
    } else {
      r.artifacts.forEach((a, i) => {
        const w = `${where} artifacts[${i}]`
        if (!isObj(a)) { fail(w, '应为 object'); bad++; return }
        if (!isStr(a.path)) fail(w, '缺少 path')
        if (!isNonNegInt(a.bytes)) fail(w, 'bytes 应为非负整数')
        if (!(typeof a.sha256 === 'string' && SHA256_RE.test(a.sha256))) {
          fail(w, 'sha256 缺失或形态非法（产物指纹是 consumes 校验的依据）')
        }
      })
    }
  }

  // 语义一致性：status=failed/blocked 时应有说明
  if ((r.status === 'failed' || r.status === 'blocked') && (!Array.isArray(r.blockers) || r.blockers.length === 0)) {
    err(`status=${r.status} 时 blockers 不应为空（失败必须说明卡在哪）`)
  }

  return bad === 0
}

// ---------------------------------------------------------------------------
// 验证器结论（tasks/<id>/verdict.json）—— 设计 §6.2
// ---------------------------------------------------------------------------

const VERDICT_VALUES = new Set(['pass', 'reject'])
const FINDING_SEVERITIES = new Set(['high', 'medium', 'low'])

/**
 * 校验验证器结论 verdict.json（G4 的交付契约）。
 *
 * 三条硬约束，每条都对应一种真实的失败模式：
 *   · 验证者必须署名            → 匿名验证无法追责，也无法判定异构性
 *   · verdict=reject 必须有 findings → 「拒绝」必须说明依据，否则是噪声
 *   · findings 每项必须有 evidence   → 对抗验证的结论同样要有可核对的依据
 */
function validateVerdict(v, where, fail, expectTaskId) {
  let bad = 0
  const err = (msg) => { bad++; fail(where, msg) }

  if (!isObj(v)) { err('verdict.json 应为 object'); return false }

  if (!isTaskId(v.task_id)) err(`task_id 形态非法: ${JSON.stringify(v.task_id)}`)
  else if (expectTaskId && v.task_id !== expectTaskId) {
    err(`task_id 与所在任务目录不一致: ${v.task_id} vs ${expectTaskId}`)
  }

  if (!isStr(v.verifier)) err('缺少 verifier（验证者必须署名，匿名验证既无法追责也无法判定异构）')
  if (v.verifier_model !== undefined && !isStr(v.verifier_model)) err('verifier_model 应为 string')
  if (v.producer_model !== undefined && !isStr(v.producer_model)) err('producer_model 应为 string')

  if (!VERDICT_VALUES.has(v.verdict)) {
    err(`verdict 非法: ${JSON.stringify(v.verdict)}（应为 pass|reject）`)
  }

  if (v.findings !== undefined && !Array.isArray(v.findings)) {
    err('findings 应为 array')
  } else if (Array.isArray(v.findings)) {
    v.findings.forEach((f, i) => {
      const w = `${where} findings[${i}]`
      if (!isObj(f)) { fail(w, '应为 object'); bad++; return }
      if (!FINDING_SEVERITIES.has(f.severity)) fail(w, `severity 非法: ${JSON.stringify(f.severity)}（应为 high|medium|low）`)
      if (!isStr(f.claim)) fail(w, '缺少 claim（发现必须是一句可判断的陈述）')
      if (f.evidence === undefined) fail(w, '缺少 evidence（对抗验证的结论同样要有依据）')
    })
  }

  // 语义一致性：拒绝必须说明依据
  if (v.verdict === 'reject' && (!Array.isArray(v.findings) || v.findings.length === 0)) {
    err('verdict=reject 时 findings 不应为空（拒绝必须给出依据，否则只是噪声）')
  }

  if (v.confidence !== undefined
    && (typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1)) {
    err('confidence 应为 0..1')
  }
  if (v.checked_at !== undefined && !isStr(v.checked_at)) err('checked_at 应为 string')

  return bad === 0
}

// ---------------------------------------------------------------------------
// 机器事件流（state/graph-events.jsonl）—— 设计 §5.3
// ---------------------------------------------------------------------------

/** 单行事件字节上限：超过会破坏追加写语义，也说明塞了不该塞的内容。 */
const MAX_EVENT_BYTES = 4096

/**
 * 事件类型表。`task` / `reason` 标记该字段是否必填。
 * v1 只要求埋 4 类（task.started / artifact.written / task.completed /
 * edge.consumed），但契约先于实现定义完整，避免后续改契约。
 */
const EVENT_TYPES = Object.freeze({
  'task.created': { task: true, reason: true },
  'task.assigned': { task: true, reason: true },
  'task.started': { task: true, reason: false },
  'artifact.written': { task: true, reason: false },
  'edge.consumed': { task: true, reason: false },
  'task.completed': { task: true, reason: false },
  'task.verified': { task: true, reason: true },
  'task.reopened': { task: true, reason: true },
  'failure.detected': { task: true, reason: true },
  'checkpoint.written': { task: false, reason: true },
  'interrupt.raised': { task: true, reason: true },
  'interrupt.resumed': { task: true, reason: true },
  'superstep.committed': { task: false, reason: false },
})

/**
 * 合法的写者角色。事件必须能点名作者，否则审计无从下手。
 * `verifier` / `scanner` 通常带 `:<agent-id>` 后缀（G4 验证器、能力图扫描器）。
 */
const EVENT_AUTHORS = new Set(['commander', 'dispatcher', 'operator', 'applier', 'verifier', 'scanner'])

/** 写者可以带限定后缀，如 `verifier:opencode`（G4 验证器）。 */
function isEventAuthor(v) {
  if (!isStr(v)) return false
  const base = v.split(':')[0]
  if (!EVENT_AUTHORS.has(base)) return false
  if (v.includes(':') && !AGENT_ID_RE.test(v.split(':').slice(1).join(':'))) return false
  return true
}

/**
 * 校验一条机器事件。
 *
 * 必带：ts / event / author / bus_version（+ 类型要求的 task / reason）
 * 可选：trace_id / span_id / parent_span_id / 事件特有字段
 */
function validateEvent(e, where, fail) {
  let bad = 0
  const err = (msg) => { bad++; fail(where, msg) }

  if (!isObj(e)) { err('事件应为 object'); return false }

  const spec = EVENT_TYPES[e.event]
  if (spec === undefined) {
    err(`event 类型非法: ${JSON.stringify(e.event)}（未在事件类型表中登记）`)
    // 类型非法时仍继续检查公共字段，便于一次性暴露问题
  }

  if (!isStr(e.ts)) err('缺少 ts')
  if (!isEventAuthor(e.author)) {
    err(`author 非法: ${JSON.stringify(e.author)}（应为 ${[...EVENT_AUTHORS].join('|')}，可带 :<agent-id> 后缀）`)
  }
  if (!isNonNegInt(e.bus_version)) err('bus_version 应为非负整数（超步提交边界）')

  if (spec) {
    if (spec.task && !isTaskId(e.task_id)) {
      err(`事件 ${e.event} 需要合法的 task_id，实为 ${JSON.stringify(e.task_id)}`)
    }
    if (spec.reason && !isStr(e.reason)) {
      err(`事件 ${e.event} 需要 reason（变更类事件必须说明理由）`)
    }
  }
  if (e.task_id !== undefined && e.task_id !== null && !isTaskId(e.task_id)) {
    err(`task_id 形态非法: ${JSON.stringify(e.task_id)}`)
  }

  for (const k of ['trace_id', 'span_id', 'parent_span_id']) {
    if (e[k] !== undefined && e[k] !== null && !isStr(e[k])) err(`${k} 应为 string 或 null`)
  }

  // 行长度约束：这是「只追加、可安全并发读」的前提
  const bytes = Buffer.byteLength(JSON.stringify(e), 'utf8')
  if (bytes > MAX_EVENT_BYTES) {
    err(`事件序列化后 ${bytes} 字节，超过 ${MAX_EVENT_BYTES} 上限（请把大内容放产物文件，事件只存引用）`)
  }

  return bad === 0
}

/**
 * 构造一条合法事件（补默认字段）。校验仍须单独调用 —— 构造函数不替调用方担保。
 */
function makeEvent(type, fields, opts) {
  const o = opts || {}
  return {
    ts: o.ts || new Date().toISOString(),
    event: type,
    author: o.author || 'applier',
    bus_version: isNonNegInt(o.busVersion) ? o.busVersion : 0,
    ...(o.reason !== undefined ? { reason: o.reason } : {}),
    ...(o.traceId !== undefined ? { trace_id: o.traceId } : {}),
    ...(o.spanId !== undefined ? { span_id: o.spanId } : {}),
    ...(o.parentSpanId !== undefined ? { parent_span_id: o.parentSpanId } : {}),
    ...(fields || {}),
  }
}

// ---------------------------------------------------------------------------
// 超步版本：从事件流派生，不引入独立状态文件 —— 设计 §5.4
// ---------------------------------------------------------------------------

/**
 * 当前总线版本 = 最后一条 superstep.committed 事件的 bus_version；
 * 无事件时返回 0。
 *
 * 刻意不落 `bus-version.json`：版本号是事件流的派生态，多一份状态文件
 * 就多一处可能与真相不一致的地方（这正是 G3 要治的病）。
 */
function currentBusVersion(events) {
  if (!Array.isArray(events)) return 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e && e.event === 'superstep.committed' && isNonNegInt(e.bus_version)) return e.bus_version
  }
  return 0
}

// ---------------------------------------------------------------------------
// 补丁（唯一写入入口的输入）—— 设计 §2.2
// ---------------------------------------------------------------------------

const PATCH_OPS = new Set(['append', 'set', 'merge'])

/** 可写路径白名单。任何未列出的路径一律拒绝。 */
const PATCH_PATH_RULES = [
  { re: /^state\/tasks\.jsonl$/, ops: ['append'] },
  { re: /^state\/graph-events\.jsonl$/, ops: ['append'] },
  { re: /^state\/ledger\.jsonl$/, ops: ['append'] },
  { re: /^agents\/[a-z0-9-]+\/capability\.json$/, ops: ['set', 'merge'] },
  { re: /^tasks\/t-\d{4}\/result\.json$/, ops: ['set'] },
  { re: /^tasks\/t-\d{4}\/verdict\.json$/, ops: ['set'] },
]

/**
 * 校验补丁。applier 的第一道闸：schema 合法 + 路径在白名单内 + 期望版本是整数。
 *
 * @param {object} p     补丁对象
 * @param {string} where 错误定位前缀
 * @param {Function} fail fail(where, msg)
 */
function validatePatch(p, where, fail) {
  let bad = 0
  const err = (msg) => { bad++; fail(where, msg) }

  if (!isObj(p)) { err('补丁应为 object'); return false }

  if (!PATCH_OPS.has(p.op)) err(`op 非法: ${JSON.stringify(p.op)}（应为 ${[...PATCH_OPS].join('|')}）`)
  if (!isStr(p.path)) err('缺少 path')

  if (isStr(p.path)) {
    // 归一化分隔符，兼容 Windows 风格调用方
    const norm = p.path.replace(/\\/g, '/')
    const rule = PATCH_PATH_RULES.find((r) => r.re.test(norm))
    if (!rule) {
      err(`path 不在可写白名单内: ${p.path}（总线只接受已登记的路径）`)
    } else if (PATCH_OPS.has(p.op) && !rule.ops.includes(p.op)) {
      err(`path ${p.path} 不接受 op=${p.op}（允许: ${rule.ops.join('|')}）`)
    }
  }

  if (!isStr(p.author)) err('缺少 author（每次变更都必须能点名作者）')
  if (!isNonNegInt(p.expected_version)) {
    err('expected_version 应为非负整数（乐观并发：拒绝盲写）')
  }
  // append 类补丁也要 reason 吗？不强制 —— 事件本身自带；但变更类必须有
  if (p.op === 'set' || p.op === 'merge') {
    if (!isStr(p.reason)) err(`op=${p.op} 需要 reason（变更类写入必须说明理由）`)
  }
  if (p.value === undefined) err('缺少 value')

  return bad === 0
}

/**
 * 超步内的确定性排序键。
 *
 * 为什么要它：多个 worker CLI 并发产出时，补丁到达 applier 的顺序不确定，
 * 直接按到达顺序写入会让「同样的执行」fold 出不同状态 —— 重放不可复现，
 * 归因与恢复随之失去意义。按稳定键排序后，同一组补丁无论以什么顺序到达，
 * 落盘顺序都相同。
 *
 * 键序：path → author → op。到达时间刻意不参与排序。
 */
function patchSortKey(p) {
  return [String(p && p.path), String(p && p.author), String(p && p.op)]
}

/** 按确定性键排序（不修改入参）。 */
function sortPatchesDeterministic(patches) {
  return [...(patches || [])].sort((a, b) => {
    const ka = patchSortKey(a)
    const kb = patchSortKey(b)
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1
      if (ka[i] > kb[i]) return 1
    }
    return 0
  })
}

module.exports = {
  // 谓词（供消费侧复用，避免各处重写）
  isStr,
  isNum,
  isNonNegInt,
  isObj,
  isTaskId,
  isEventAuthor,
  // 形态常量
  TASK_ID_RE,
  GROUP_RE,
  AGENT_ID_RE,
  SHA256_RE,
  MAX_EVENT_BYTES,
  // graph
  NODE_KINDS,
  validateGraph,
  // result
  RESULT_STATUS,
  EVIDENCE_TYPES,
  validateResult,
  // verdict（G4 验证器结论）
  VERDICT_VALUES,
  FINDING_SEVERITIES,
  validateVerdict,
  // event
  EVENT_TYPES,
  EVENT_AUTHORS,
  validateEvent,
  makeEvent,
  currentBusVersion,
  // patch
  PATCH_OPS,
  PATCH_PATH_RULES,
  validatePatch,
  patchSortKey,
  sortPatchesDeterministic,
}
