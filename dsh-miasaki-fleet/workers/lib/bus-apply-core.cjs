// bus-apply-core.cjs — applier 的核心逻辑（G0，2026-09-10）
//
// 与 workers/bus/bus-apply.mjs 的分工：
//   · 本模块：纯逻辑 + 文件 IO，接收 root 参数，返回结构化结果，**从不调用 process.exit**
//   · CLI：解析命令行、读补丁、打印、决定退出码
//
// 这样分开的原因有两个：
//   1. 可测性 —— 测试可直接以临时目录为 root 调用 applyPatches 并断言文件内容，
//      无需 spawn 子进程（受限环境里 spawn 子进程会因管道受限而失败）；
//   2. applier 将来可能被非 CLI 消费者调用（面板插件、其他工作区），
//      逻辑不该绑死在命令行上。
//
// 超步语义、写者收敛、版本派生的设计依据见 docs/graph-engineering-fleet-design.md
// §2.2 / §5.4。

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const contract = require('./bus-contract.cjs')

/** 契约非法：调用方的补丁本身有问题（exit 2）。 */
class ContractError extends Error {
  constructor(where, msg) {
    super(`${where}: ${msg}`)
    this.name = 'ContractError'
  }
}

/** 供 bus-contract 回调使用：直接抛，由 applyPatches 统一转成结构化结果。 */
function fail(where, msg) {
  throw new ContractError(where, msg)
}

// ---------------------------------------------------------------------------
// IO 辅助（BOM / CRLF 容错，与 validate-bus / publish-pulse 同口径）
// ---------------------------------------------------------------------------

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s
}

function eventsPath(root) {
  return path.join(root, 'state', 'graph-events.jsonl')
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return []
  const raw = stripBom(fs.readFileSync(p, 'utf8'))
  const out = []
  for (const ln of raw.split(/\r?\n/)) {
    if (!ln.trim()) continue
    try { out.push(JSON.parse(ln)) } catch { /* 坏行由巡检报错，这里跳过 */ }
  }
  return out
}

function readJsonOrNull(p) {
  try {
    const raw = stripBom(fs.readFileSync(p, 'utf8')).trim()
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
}

/** Windows 上目标可能被读者短暂占用（面板轮询、杀毒），重试比直接失败务实。 */
function renameWithRetry(from, to, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(from, to); return } catch (e) {
      lastErr = e
      if (i < attempts - 1) {
        const until = Date.now() + 50
        while (Date.now() < until) { /* 短自旋：保持同步、不引入异步复杂度 */ }
      }
    }
  }
  try { fs.unlinkSync(from) } catch { /* 清理失败不掩盖原错误 */ }
  throw lastErr
}

/** 原子替换：写临时文件后 rename。与 publish-pulse 同一铁律。 */
function writeJsonAtomic(p, value) {
  ensureDir(p)
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameWithRetry(tmp, p)
}

/** 追加一行 JSONL。单进程单入口，无需文件锁。 */
function appendJsonl(p, row) {
  ensureDir(p)
  fs.appendFileSync(p, `${JSON.stringify(row)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// 路径与取值校验
// ---------------------------------------------------------------------------

/** 把补丁 path 解析为绝对路径，并防目录穿越。 */
function resolveTarget(root, p) {
  const norm = p.replace(/\\/g, '/')
  const abs = path.resolve(root, norm)
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ContractError('patch.path', `路径逃出工作区: ${p}`)
  }
  return abs
}

/**
 * 校验补丁 value 是否符合目标路径的契约。
 * v1 只强制 result.json（G0 交付物之一）与事件；其余路径等 G1/G2 落地时收紧。
 *
 * @param {object} patch 补丁对象（需同时拿到 path 与 value）
 */
function validateValueForPath(patch) {
  const norm = patch.path.replace(/\\/g, '/')
  if (/^tasks\/t-\d{4}\/result\.json$/.test(norm)) {
    const taskId = norm.split('/')[1]
    contract.validateResult(patch.value, `patch.value (${norm})`, fail, taskId)
  }
  if (/^tasks\/t-\d{4}\/verdict\.json$/.test(norm)) {
    const taskId = norm.split('/')[1]
    contract.validateVerdict(patch.value, `patch.value (${norm})`, fail, taskId)
  }
  if (norm === 'state/graph-events.jsonl' && !contract.isObj(patch.value)) {
    throw new ContractError('patch.value', 'graph-events 补丁的 value 应为事件对象')
  }
}

// ---------------------------------------------------------------------------
// 单个补丁的应用
// ---------------------------------------------------------------------------

/**
 * 应用一个已校验的补丁，返回写入字节数。
 *
 * @param {string} root       工作区根
 * @param {object} patch      已通过契约校验的补丁
 * @param {number} busVersion 本超步版本号（事件统一盖上这个章，调用方不必知道版本）
 */
function applyOnePatch(root, patch, busVersion) {
  const normPath = patch.path.replace(/\\/g, '/')
  const targetAbs = resolveTarget(root, normPath)

  if (patch.op === 'append') {
    if (normPath === 'state/graph-events.jsonl') {
      const ev = contract.makeEvent(patch.value.event, patch.value, {
        ts: patch.value.ts,
        author: patch.value.author || patch.author,
        busVersion,
        reason: patch.value.reason,
        traceId: patch.value.trace_id,
        spanId: patch.value.span_id,
        parentSpanId: patch.value.parent_span_id,
      })
      contract.validateEvent(ev, 'patch.value (event)', fail)
      appendJsonl(targetAbs, ev)
      return Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1
    }
    const row = { ...patch.value }
    if (row.ts === undefined && row.op === undefined) row.ts = new Date().toISOString()
    appendJsonl(targetAbs, row)
    return Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
  }

  if (patch.op === 'set') {
    writeJsonAtomic(targetAbs, patch.value)
    return Buffer.byteLength(JSON.stringify(patch.value, null, 2), 'utf8')
  }

  if (patch.op === 'merge') {
    const existing = readJsonOrNull(targetAbs)
    if (existing !== null && !contract.isObj(existing)) {
      throw new ContractError('patch.op', `merge 目标不是 object，无法合并: ${patch.path}`)
    }
    writeJsonAtomic(targetAbs, { ...(existing || {}), ...patch.value })
    return Buffer.byteLength(JSON.stringify(patch.value), 'utf8')
  }

  throw new ContractError('patch.op', `未知 op: ${patch.op}`)
}

// ---------------------------------------------------------------------------
// 超步：校验 → 并发检查 → 确定性排序 → 应用 → 提交版本
// ---------------------------------------------------------------------------

/** 读机器事件流。 */
function readEvents(root) {
  return readJsonl(eventsPath(root))
}

/** 当前总线版本（从事件流派生，无独立状态文件）。 */
function readCurrentVersion(root) {
  return contract.currentBusVersion(readEvents(root))
}

/**
 * 执行一个超步。
 *
 * 返回值恒为对象（不抛异常），由调用方决定如何呈现与退码：
 *   { ok, code, previousVersion, currentVersion, patchCount, bytes, paths,
 *     error?, partial?, duplicateWarnings? }
 *
 * code 语义与 CLI 退出码一致：0 成功 / 2 契约非法 / 3 版本冲突 / 4 IO 失败。
 */
function applyPatches(root, patches, opts) {
  const options = opts || {}
  const list = Array.isArray(patches) ? patches : []
  const previousVersion = readCurrentVersion(root)

  if (list.length === 0) {
    return { ok: false, code: 2, error: '没有补丁可提交', previousVersion, currentVersion: previousVersion }
  }

  // ① 契约校验
  try {
    list.forEach((p, i) => {
      contract.validatePatch(p, `补丁[${i}]`, fail)
      validateValueForPath(p)
    })
  } catch (e) {
    return { ok: false, code: 2, error: e.message, previousVersion, currentVersion: previousVersion }
  }

  // ② 乐观并发：任何补丁的期望版本不等于当前版本即整体拒绝（不做部分提交）
  const stale = list.filter((p) => p.expected_version !== previousVersion)
  if (stale.length > 0) {
    return {
      ok: false,
      code: 3,
      conflict: true,
      error: `版本冲突：期望 ${stale.map((p) => p.expected_version).join(',')}，当前 ${previousVersion}`,
      previousVersion,
      currentVersion: previousVersion,
    }
  }

  // ③ 确定性排序：同一组补丁无论以什么顺序到达，落盘顺序都相同
  const ordered = contract.sortPatchesDeterministic(list)

  // 同一超步内多次写同一非 JSONL 路径 → 疑似重复补丁，显式告警（不拒绝）
  const touched = new Map()
  for (const p of ordered) {
    const key = p.path.replace(/\\/g, '/')
    touched.set(key, (touched.get(key) || 0) + 1)
  }
  const duplicateWarnings = [...touched.entries()]
    .filter(([k, n]) => n > 1 && !k.endsWith('.jsonl'))
    .map(([k, n]) => `同一超步内 ${k} 被写 ${n} 次（非 JSONL 路径疑似重复补丁）`)

  const newVersion = previousVersion + 1
  const paths = [...touched.keys()]

  if (options.check) {
    return {
      ok: true, code: 0, check: true, patchCount: ordered.length, paths,
      previousVersion, currentVersion: newVersion, duplicateWarnings,
    }
  }

  // ④ 应用
  let bytes = 0
  try {
    for (const p of ordered) bytes += applyOnePatch(root, p, newVersion)
  } catch (e) {
    // 中途失败：总线可能已部分写入。不尝试回滚（无事务），但必须让调用方
    // 知道「本超步未提交版本号」，以便重读后重试。
    const code = e instanceof ContractError ? 2 : 4
    return {
      ok: false, code, partial: true, error: e.message,
      previousVersion, currentVersion: previousVersion,
    }
  }

  // ⑤ 提交超步版本号 —— 这一步成功才算本超步生效
  const commit = contract.makeEvent('superstep.committed', {
    bus_version: newVersion,
    patch_count: ordered.length,
    paths,
    bytes,
  }, { author: 'applier', busVersion: newVersion, reason: `提交 ${ordered.length} 个补丁` })
  appendJsonl(eventsPath(root), commit)

  return {
    ok: true, code: 0, patchCount: ordered.length, bytes, paths,
    previousVersion, currentVersion: newVersion, duplicateWarnings,
  }
}

module.exports = {
  ContractError,
  eventsPath,
  readEvents,
  readCurrentVersion,
  applyPatches,
  // 供测试或其他消费者使用的底层能力
  readJsonl,
  readJsonOrNull,
  writeJsonAtomic,
  appendJsonl,
  resolveTarget,
  applyOnePatch,
}
