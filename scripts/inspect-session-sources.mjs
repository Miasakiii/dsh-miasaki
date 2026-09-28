#!/usr/bin/env node
// 会话日志取证：解剖 `session*.jsonl.zstd` 的物理行，报告每条 durable 消息的 `source.kind`。
//
// 为什么需要它（2026-09-27 实机故障定位耗时十几轮的根因）：
//   `format v4 message requires a producer-owned source kind` 这类报错**不会**落到
//   host 日志（它是 turn 级错误，直接顶到 UI），只能从会话日志反查。而会话日志是
//   **逐帧追加的 zstd**：一个文件里有许多独立帧（实测单文件可达数万帧），
//   `zstdDecompressSync(整文件)` 只解得出**第一帧**（就是 header 那一行），
//   于是「日志看起来是空的」——本工具按帧 magic 切分后逐帧解压，才能读全。
//
// 它报告什么：
//   · 每个会话文件的 header version、事件类型分布；
//   · 全部 durable 消息槽（user/message、assistant/message、tool/result、
//     system/message、developer/message、agent/inbox/spliced.inserted、
//     session/title-llm-request.messages）的 source kind 分布；
//   · **异常清单**：缺失 source / source 非对象 / kind 空或非字符串 / kind === "plugin"
//     —— 后两类正是 v4 准入会抛错的形态。
//
// 判定口径与 DSH 自身的校验对齐（`dsh-session-format-v3-to-v4` 的 mapEventMessages）。
// 注意：磁盘上没有异常**不等于**运行时不会报错 —— 被准入拒绝的消息根本落不了盘。
// 要判断「某个插件会不会写出这种消息」，用 `check-message-sources.mjs` 扫它的源码。
//
// 用法：
//   node scripts/inspect-session-sources.mjs                    # 自动发现 ~/.dsh 下所有会话根
//   node scripts/inspect-session-sources.mjs --root <目录>      # 指定根（可重复）
//   node scripts/inspect-session-sources.mjs --limit 50         # 只扫最近 N 个文件（按 mtime）
//   node scripts/inspect-session-sources.mjs --json             # 机器可读输出
//
// 零依赖（只用 node:zlib / node:fs）、只读、不碰运行中的 DSH。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MARK = '[session-sources]'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 产出 durable 消息的 v4 事件 → 消息所在字段（**相对 `row.data`** 的路径；空数组 = data 本身）。 */
const MESSAGE_SLOTS = {
  'user/message': [],
  'developer/message': ['message'],
  'system/message': ['message'],
  'assistant/message': ['message'],
  'tool/result': ['message'],
  'agent/inbox/spliced': ['inserted'],
  'session/title-llm-request': ['messages'],
}

/** 官方（或已随 v4 迁移表登记的）生产者 kind；不在此列也不算异常，只提示。 */
const KNOWN_KINDS = new Set([
  'tool', 'model', 'user', 'tool-jobs', 'agent-instructions', 'runtime-context',
  'system-prompt', 'skill-catalog', 'subagent-settled', 'subagent-report',
  'dsh-session-title-llm', 'agent-message', 'user-approval', 'goal',
  'model-selection', 'compact-checkpoint', 'compact-basic', 'ptc-mode',
  'repeat-tool-reminder', 'tool-registry', 'webhook', 'schedule', 'team-message',
  'skill-invocation', 'coordinator', 'plan-mode', 'time-context', 'tmux-context',
  'hooks-codex', 'hooks-claude-code', 'cordis-host-runner', 'tool-goal',
  'tool-cordis', 'session-reference',
])

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const roots = []
for (const [index, arg] of argv.entries()) {
  if (arg === '--root') roots.push(argv[index + 1])
}
const limitIndex = argv.indexOf('--limit')
const limit = limitIndex === -1 ? 0 : Number(argv[limitIndex + 1])

/** 逐帧解压：zstd 帧以固定 magic 起头，帧与帧之间没有额外分隔。 */
function decodeFrames(buffer) {
  const offsets = []
  let at = buffer.indexOf(ZSTD_MAGIC, 0)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(ZSTD_MAGIC, at + 4)
  }
  const parts = []
  let failedFrames = 0
  for (const [index, start] of offsets.entries()) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch { // guard-ok: 末帧可能仍在写入；失败已计入 failedFrames 并在结果里报告，不是静默吞错
      // 末帧可能仍在写入；其余失败说明该 magic 只是压缩数据里的巧合。
      failedFrames += 1
      parts.push('')
    }
  }
  return { text: parts.join(''), frames: offsets.length, failedFrames }
}

function collectFiles(directory, sink) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return sink
  }
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) collectFiles(full, sink)
    else if (entry.name.endsWith('.zstd')) sink.push(full)
  }
  return sink
}

/** 默认根：全局 sessions + 每个 profile 的 sessions（0.1.7 起会话可按 profile 隔离）。 */
function defaultRoots() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const found = []
  const global = join(home, 'sessions')
  try {
    if (statSync(global).isDirectory()) found.push(global)
  } catch { // guard-ok: 本机可能没有全局会话根（只做了 profile 隔离），其它根会兜住
    // 没有该根即跳过：不是错误，另有根会兜住。
  }
  const profiles = join(home, 'profiles')
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const sessions = join(profiles, entry.name, 'sessions')
      try {
        if (statSync(sessions).isDirectory()) found.push(sessions)
      } catch { // guard-ok: 该 profile 未做会话隔离（会话仍写全局根）即跳过，不是吞错
        // 该 profile 没有独立会话根（未做隔离）即跳过。
      }
    }
  } catch { // guard-ok: 本机可能没有 profiles 目录（只有全局会话根），不是吞错
    // 无 profiles 目录：只有全局会话根。
  }
  return found
}

function sourceOf(message) {
  const source = message.source
  if (source === undefined) return { kind: '<missing>', abnormal: '缺失 source' }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return { kind: '<non-object>', abnormal: 'source 非对象' }
  const kind = source.kind
  if (typeof kind !== 'string' || kind.length === 0) return { kind: '<empty>', abnormal: 'kind 空或非字符串' }
  if (kind === 'plugin') return { kind, abnormal: 'kind === "plugin"（v4 硬拒的退役写法）' }
  return { kind, abnormal: null }
}

const rootsToScan = roots.length > 0 ? roots : defaultRoots()
if (rootsToScan.length === 0) {
  console.error(`${MARK} 没有可扫描的会话根：请用 --root <目录> 指定`)
  process.exit(2)
}

const files = []
for (const root of rootsToScan) collectFiles(root, files)
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
const selected = limit > 0 ? files.slice(0, limit) : files

const kindCounts = new Map()
const typeCounts = new Map()
const versionCounts = new Map()
const abnormal = []
const unregisteredKinds = new Map()
let parsedRows = 0
let failedFiles = 0

for (const file of selected) {
  let decoded
  try {
    decoded = decodeFrames(readFileSync(file))
  } catch (error) {
    failedFiles += 1
    abnormal.push({ file, line: 0, kind: '<read-failed>', abnormal: error.message })
    continue
  }
  const lines = decoded.text.split('\n').filter(line => line.trim().length > 0)
  let version = 'unknown'
  for (const [index, line] of lines.entries()) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    parsedRows += 1
    if (row.type === 'session') {
      version = String(row.version)
      continue
    }
    if (typeof row.type !== 'string') continue
    typeCounts.set(row.type, (typeCounts.get(row.type) ?? 0) + 1)
    const path = MESSAGE_SLOTS[row.type]
    if (path === undefined) continue
    const value = path.reduce((carry, key) => (carry === null || typeof carry !== 'object' ? undefined : carry[key]), row.data)
    if (value === undefined) continue
    const slot = path.length === 0 ? 'data' : `data.${path.join('.')}`
    for (const message of Array.isArray(value) ? value : [value]) {
      if (message === null || typeof message !== 'object' || Array.isArray(message)) continue
      const { kind, abnormal: why } = sourceOf(message)
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1)
      if (why !== null) abnormal.push({ file, line: index, type: row.type, slot, kind, abnormal: why, role: message.role })
      else if (!KNOWN_KINDS.has(kind)) unregisteredKinds.set(kind, (unregisteredKinds.get(kind) ?? 0) + 1)
    }
  }
  versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1)
}

if (asJson) {
  console.log(JSON.stringify({
    roots: rootsToScan,
    files: selected.length,
    parsedRows,
    failedFiles,
    versions: Object.fromEntries(versionCounts),
    eventTypes: Object.fromEntries(typeCounts),
    sourceKinds: Object.fromEntries(kindCounts),
    unregisteredKinds: Object.fromEntries(unregisteredKinds),
    abnormal,
  }, null, 2))
  process.exit(abnormal.length > 0 ? 1 : 0)
}

console.log(`${MARK} 根：${rootsToScan.join('  |  ')}`)
console.log(`${MARK} 文件 ${selected.length} 个（共发现 ${files.length} 个），解析事件行 ${parsedRows} 条`)
console.log(`${MARK} header 代次：${[...versionCounts.entries()].map(([v, n]) => `v${v}×${n}`).join(' ')}`)
console.log(`\n── 事件类型 ──`)
for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(count).padStart(7)}  ${type}`)
console.log(`\n── 消息 source.kind ──`)
for (const [kind, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(7)}  ${kind}`)
if (unregisteredKinds.size > 0) {
  console.log(`\n── 未登记但形态合法（可能是新插件）──`)
  for (const [kind, count] of [...unregisteredKinds.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(7)}  ${kind}`)
}

if (abnormal.length === 0) {
  console.log(`\n${MARK} 未发现异常 source（磁盘上无 v4 准入会拒绝的消息）`)
  console.log(`${MARK} 提示：运行时被拒的消息**不会落盘**，要查写入方请跑 check-message-sources.mjs`)
  process.exit(0)
}
console.log(`\n${MARK} 异常 ${abnormal.length} 处：`)
for (const item of abnormal.slice(0, 40)) {
  console.log(`  ${item.file}:${item.line}  [${item.type ?? '-'}${item.slot === undefined ? '' : '.' + item.slot}] ${item.kind} — ${item.abnormal}${item.role === undefined ? '' : `（role=${item.role}）`}`)
}
if (abnormal.length > 40) console.log(`  ……另有 ${abnormal.length - 40} 处`)
process.exit(1)
