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
const crypto = require('node:crypto')
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

/**
 * 读 JSONL。
 *
 * @param {string} p
 * @param {{badLines?: number}} [stats] 可选出参：坏行数写回 `stats.badLines`。
 *
 * 为什么需要这个出参：坏行此前**静默跳过**，而 `validate-bus` 的巡检**不在派单路径上** ——
 * 一条被截断的 `update status=done` 会让任务在判定器眼里仍是 `queued` ⇒ **放行派单**，
 * 而派单器侧看不到任何信号（2026-09-30 由 t-0010 独立复核 F6 指出）。
 * 计数交给判定器（`task-ready`）显式拒绝，静默跳过的语义不变（巡检仍会报错）。
 */
function readJsonl(p, stats) {
  if (!fs.existsSync(p)) return []
  const raw = stripBom(fs.readFileSync(p, 'utf8'))
  const out = []
  for (const ln of raw.split(/\r?\n/)) {
    if (!ln.trim()) continue
    try { out.push(JSON.parse(ln)) } catch { /* 坏行由巡检报错，这里跳过 */ }
  }
  // 坏行计数用「非空行数 − 成功解析数」**推导**，刻意不改上面那一行 ——
  // 它是 `scripts/silent-guard-baseline.json` 冻结的存量静默降级（R2），改文本会让基线报
  // 「可回收」而语义其实没变（仍是跳过 + 由巡检报错）。计数只是把同一事实**显式**交给判定器。
  if (stats) stats.badLines = raw.split(/\r?\n/).filter((l) => l.trim()).length - out.length
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

/**
 * 临时文件名：**必须唯一**（pid + uuid）。
 *
 * 为什么不能是 `${p}.tmp`（2026-10-20 修，monkeyscan 0cbb0）：applier 是「每次调用
 * 一个短生命周期 node 进程」，monitor / dispatcher / discovery 各自会起一个；并发写
 * 同一目标时共享固定临时名 ⇒ 一方的 rename 会发布另一方的字节，另一方 rename 变
 * ENOENT → partial（code 4）。唯一名让每个写入者占自己的临时文件。
 */
function tmpPathFor(p) {
  return `${p}.${process.pid}.${crypto.randomUUID()}.tmp`
}

/** 原子替换：写临时文件后 rename。与 publish-pulse 同一铁律。 */
function writeJsonAtomic(p, value) {
  ensureDir(p)
  const tmp = tmpPathFor(p)
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameWithRetry(tmp, p)
  } catch (e) {
    // 失败路径必须清理自己的临时文件（renameWithRetry 已清时这里就是 ENOENT，
    // 吞掉是正当的 —— 清理失败不得掩盖原异常）
    try { fs.unlinkSync(tmp) } catch { /* guard-ok: 兜底清理，失败不得掩盖原异常 */ }
    throw e
  }
}

/** 追加一行 JSONL（单条 append 自身原子；跨进程互斥由 applyPatches 的 withBusLock 保证）。 */
function appendJsonl(p, row) {
  ensureDir(p)
  fs.appendFileSync(p, `${JSON.stringify(row)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// 跨进程锁（超步临界区互斥）—— 2026-10-20（monkeyscan e5a4b）
// ---------------------------------------------------------------------------
//
// 为什么需要：applier 是「每次调用一个 node 进程」的短生命周期 CLI（monitor /
// dispatcher / discovery 各起一个），`expected_version` 只是快照比较、不是 CAS：
// 两个进程都读到版本 N 就会都通过检查、都提交 N+1（版本重复 ⇒ validate-bus 判
// 事件流损坏；同路径 set/merge 还会静默丢更新）。故把「读版本 → 应用 → 追加提交」
// 整段放进文件锁。
//
// 实现取最小可用：`state/.bus-apply.lock` + `openSync(..., 'wx')` 原子创建；
// 持锁期间记录 pid / 时间；等待者在超时内重试；mtime 超过 staleMs 视为崩溃残留并
// 回收。临界区只有几次同步文件写（毫秒级），故不引入第三方锁库（零依赖纪律）。

/** 锁文件名（位于工作区 state/ 下）。 */
const LOCK_FILE = '.bus-apply.lock'
/** 等锁上限：一次超步是毫秒级，5s 足以覆盖机器抖动；超时按环境错误失败（exit 4）。 */
const LOCK_TIMEOUT_MS = 5000
/** 持锁超过该时长视为崩溃残留（正常超步远小于 1s）。 */
const LOCK_STALE_MS = 60 * 1000
/** 等锁重试间隔。 */
const LOCK_RETRY_MS = 10

/** 锁文件绝对路径。 */
function lockPath(root) {
  return path.join(root, 'state', LOCK_FILE)
}

/** 同步短睡（Atomics.wait；不可用时退化为短自旋）—— 等锁 5s 不能满核 busy loop。 */
function sleepSync(ms) {
  if (!(ms > 0)) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 退化路径：与 renameWithRetry 同款短自旋 */ }
  }
}

/** 尝试原子创建锁；成功 true，已存在 false，其它 IO 错误抛 code='BUS_LOCK_IO'。 */
function tryCreateLock(lp) {
  let fd
  try {
    fd = fs.openSync(lp, 'wx')
  } catch (e) {
    if (e && e.code === 'EEXIST') return false
    const err = new Error(`创建总线锁失败：${e && e.message}`)
    err.code = 'BUS_LOCK_IO'
    throw err
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }))
  } finally {
    fs.closeSync(fd)
  }
  return true
}

/** 锁是否过期（mtime 早于 staleMs）。锁已消失返回 false —— 交给下一轮 open 判定。 */
function isStaleLock(lp, staleMs) {
  try {
    return Date.now() - fs.statSync(lp).mtimeMs > staleMs
  } catch {
    return false
  }
}

/**
 * 获取跨进程锁，返回锁文件路径；超时抛 code='BUS_LOCK_TIMEOUT'。
 *
 * @param {string} root
 * @param {{timeoutMs?: number, staleMs?: number, retryMs?: number}} [opts] 测试可注入
 */
function acquireBusLock(root, opts) {
  const o = opts || {}
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : LOCK_TIMEOUT_MS
  const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : LOCK_STALE_MS
  const retryMs = Number.isFinite(o.retryMs) && o.retryMs > 0 ? o.retryMs : LOCK_RETRY_MS
  const lp = lockPath(root)
  ensureDir(lp)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (tryCreateLock(lp)) return lp
    if (isStaleLock(lp, staleMs)) {
      // 崩溃残留：回收后立即重试。两个等待者同时回收也只有一个能抢到 'wx'。
      try { fs.unlinkSync(lp) } catch { /* guard-ok: 已被另一等待者回收，重试即可 */ }
      if (tryCreateLock(lp)) return lp
    }
    if (Date.now() >= deadline) {
      const err = new Error(
        `获取总线锁超时（${timeoutMs}ms；锁文件 ${lp} 仍被占用，可能有另一个 applier 正在提交）`,
      )
      err.code = 'BUS_LOCK_TIMEOUT'
      throw err
    }
    sleepSync(retryMs)
  }
}

/** 释放锁。删除失败不抛：锁已被 stale 回收时 unlink 报 ENOENT，属正常分支。 */
function releaseBusLock(lp) {
  try { fs.unlinkSync(lp) } catch { /* guard-ok: 锁已被回收/不存在，属正常分支 */ }
}

/**
 * 在总线跨进程锁内执行 fn（同步）。
 *
 * 拿不到锁 → 抛超时错误；fn 抛错也保证释放（finally）—— 否则一次异常会让整个
 * 工作区的写入卡到 stale 超时（60s）才恢复。
 *
 * @param {string} root
 * @param {Function} fn 临界区函数（同步）
 * @param {{timeoutMs?: number, staleMs?: number, retryMs?: number}} [opts]
 */
function withBusLock(root, fn, opts) {
  const lp = acquireBusLock(root, opts)
  try {
    return fn(lp)
  } finally {
    releaseBusLock(lp)
  }
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
 * 校验 tasks.jsonl 的单行形态（写入时拦截，2026-10-20 修 monkeyscan 6e766）。
 *
 * 此前 `state/tasks.jsonl` 的 append 完全不看 value ⇒ 总线写入者可注入一条
 * 任意形态的任务行（含 `graph.consumes[].artifact` 的穿越串、任意 task id）。
 * 该缺陷的另一半在读取侧（task-ready 的产物存在性检查），两侧都要拦：
 *   · 写入侧：行必须是已登记的 op，create 行要有合法 task id 与合法 graph；
 *   · 读取侧：artifact 解析后必须仍在任务目录内（见 task-ready.artifactExists）。
 *
 * 枚举与巡检（validate-bus）共用一份定义：contract.TASK_ROW_OPS / TASK_ROW_STATUSES。
 *
 * @param {object} row   追加行（补丁 value）
 * @param {string} where 错误定位前缀
 */
function validateTaskRow(row, where) {
  if (!contract.isObj(row)) throw new ContractError(where, 'tasks.jsonl 追加行应为 object')
  if (!contract.TASK_ROW_OPS.includes(row.op)) {
    throw new ContractError(
      where,
      `op 非法: ${JSON.stringify(row.op)}（应为 ${contract.TASK_ROW_OPS.join('|')}）`,
    )
  }
  if (row.op === 'create') {
    const t = row.task
    if (!contract.isObj(t)) throw new ContractError(`${where}.task`, 'create 行缺少 task object')
    if (!contract.isTaskId(t.id)) {
      throw new ContractError(`${where}.task.id`, `任务 id 形态非法: ${JSON.stringify(t.id)}（应为 t-0000）`)
    }
    if (t.status !== undefined && !contract.TASK_ROW_STATUSES.includes(t.status)) {
      throw new ContractError(`${where}.task.status`, `status 非法: ${JSON.stringify(t.status)}`)
    }
    // graph 缺失 = 不入图（合法）；存在则按契约校验（含 consumes[].task 形态与 artifact 非空）
    contract.validateGraph(t.graph, `${where}.task.graph`, fail)
    return
  }
  if (!contract.isTaskId(row.task_id)) {
    throw new ContractError(`${where}.task_id`, `task_id 形态非法: ${JSON.stringify(row.task_id)}（应为 t-0000）`)
  }
  if (row.op === 'update' && row.status !== undefined && !contract.TASK_ROW_STATUSES.includes(row.status)) {
    throw new ContractError(`${where}.status`, `status 非法: ${JSON.stringify(row.status)}`)
  }
}

/**
 * 校验补丁 value 是否符合目标路径的契约。
 * v1 只强制 result.json（G0 交付物之一）与事件；其余路径等 G1/G2 落地时收紧。
 * 2026-10-20：补上 tasks.jsonl 追加行的形态校验（此前完全不检查）。
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
  if (norm === 'state/tasks.jsonl' && patch.op === 'append') {
    validateTaskRow(patch.value, `patch.value (${norm})`)
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
 * 单个超步的「并发检查 → 排序 → 应用 → 提交」—— **调用方必须已持有跨进程锁**
 * （`applyPatches` 的落盘路径会包一层 `withBusLock`；`--check` 是纯 dry-run 例外）。
 *
 * 返回值恒为对象（不抛异常）：
 *   { ok, code, previousVersion, currentVersion, patchCount, bytes, paths,
 *     error?, partial?, duplicateWarnings? }
 *
 * code 语义与 CLI 退出码一致：0 成功 / 2 契约非法 / 3 版本冲突 / 4 IO 失败。
 */
function applySuperstep(root, list, options) {
  const previousVersion = readCurrentVersion(root)

  // ① 乐观并发：任何补丁的期望版本不等于当前版本即整体拒绝（不做部分提交）
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

  // ② 确定性排序：同一组补丁无论以什么顺序到达，落盘顺序都相同
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

  // ③ 应用
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

  // ④ 提交超步版本号 —— 这一步成功才算本超步生效
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

/**
 * 执行一个超步。
 *
 * 返回值恒为对象（不抛异常），由调用方决定如何呈现与退码：
 *   { ok, code, previousVersion, currentVersion, patchCount, bytes, paths,
 *     error?, partial?, duplicateWarnings? }
 *
 * code 语义与 CLI 退出码一致：0 成功 / 2 契约非法 / 3 版本冲突 / 4 IO 失败。
 *
 * 2026-10-20 起：真正落盘时「读版本 → 应用 → 追加提交」整段在跨进程锁内执行
 * （`state/.bus-apply.lock`）—— 否则并发 applier 会都通过 expected_version 检查
 * 并提交重复 bus_version（monkeyscan e5a4b）。契约校验是纯 CPU，放在锁外；
 * `--check` 不写盘，也不占锁（dry-run 不应留下锁文件副作用）。
 */
function applyPatches(root, patches, opts) {
  const options = opts || {}
  const list = Array.isArray(patches) ? patches : []

  if (list.length === 0) {
    const previousVersion = readCurrentVersion(root)
    return { ok: false, code: 2, error: '没有补丁可提交', previousVersion, currentVersion: previousVersion }
  }

  // ① 契约校验（锁外：非法补丁不必占用跨进程锁）
  try {
    list.forEach((p, i) => {
      contract.validatePatch(p, `补丁[${i}]`, fail)
      validateValueForPath(p)
    })
  } catch (e) {
    const previousVersion = readCurrentVersion(root)
    return { ok: false, code: 2, error: e.message, previousVersion, currentVersion: previousVersion }
  }

  // ② 落盘路径：整个超步进跨进程锁；--check 纯读，不占锁
  if (options.check) return applySuperstep(root, list, options)
  try {
    return withBusLock(root, () => applySuperstep(root, list, options), options.lock)
  } catch (e) {
    // 锁相关错误（等锁超时 / 创建锁 IO 失败）→ 环境类失败（exit 4），
    // 与「契约非法 2 / 版本冲突 3」区分开；其它异常照旧上抛（不吞未知缺陷）。
    if (e && typeof e.code === 'string' && e.code.startsWith('BUS_LOCK')) {
      const previousVersion = readCurrentVersion(root)
      return { ok: false, code: 4, error: e.message, previousVersion, currentVersion: previousVersion }
    }
    throw e
  }
}

module.exports = {
  ContractError,
  eventsPath,
  readEvents,
  readCurrentVersion,
  applyPatches,
  // 跨进程锁（供测试与其它消费者直接使用）
  withBusLock,
  acquireBusLock,
  lockPath,
  // 供测试或其他消费者使用的底层能力
  readJsonl,
  readJsonOrNull,
  writeJsonAtomic,
  tmpPathFor,
  appendJsonl,
  resolveTarget,
  applyOnePatch,
}
