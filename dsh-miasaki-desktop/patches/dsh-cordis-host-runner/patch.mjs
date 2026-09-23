#!/usr/bin/env node
// DSH `cordis_inspect_query`(platform: client)「永久挂起」修复补丁。
//
// 背景（2026-09-10 诊断，证据见本目录 README）：
//   Host 的 CordisInspectRegistryService.resolveClientQuery 只接受**成功**的页面应答：
//
//       if (!resolution.ok) return { accepted: false };       // ← 错误应答被丢弃
//       catch { return { accepted: false }; }                 // ← 输出校验失败同样丢弃
//       this.pending.delete(requestId); pending.settle(...)   // ← 只有成功才走到这里
//
//   而浏览器侧（@deepseek-ai/dsh-cordis-client-runner 的 ClientCordisInspectRegistry.query）
//   对一次广播**只回一次**，不重试；回执 answered 也无人检查。于是当客户端 provider 抛错时
//   （最典型：查一个不在客户端目录里的 Service key → `no catalogued Service named "X"`），
//   这个错误在链路上被彻底吞掉：pending 既不 settle 也不清理。
//
//   工具 cordis_inspect_query 本身没有声明 timeoutMs，而
//   @deepseek-ai/dsh-tool-call-timeout-policy 对未声明者直接 `return next()` —— 没有兜底
//   deadline。因此唯一的结束路径是 exec.signal 被中断（用户按 Esc / 取消回合）。
//   实测（127 个会话日志、96 次 client 查询）：7 次真挂死，最长 13420 秒（3 小时 43 分）后
//   才以 `Client inspect query ... was cancelled` 收场；而 host 平台的同类错误会**立刻返回**。
//
// 本补丁做两件事，且**不改变多页面语义**：
//   ① resolveClientQuery 在拒绝一个应答时，把原因记进 pending.lastFailure（仍然不 settle，
//      因为另一个页面可能持有该 provider —— 先到先得只对**成功**应答成立）；
//   ② queryClient 给每次查询挂一个 15000ms 兜底定时器：到期后 settle 成 `timeout` 错误，
//      并把 ① 记录到的真实拒绝原因写进错误消息。
//   于是「永久挂起」退化为「15 秒后带准确原因的报错」，而多标签页抢答语义原样保留。
//
// 为什么是 15 秒：实测成功的 client 查询耗时 0–4 秒（页面内存操作），15 秒留足余量，
// 又远小于人类感知的「卡住了」。
//
// 边界与代价：只改这一个包的 lib/index.js（package.json main/exports 的唯一入口，
// 全安装目录无深路径引用 lib/types/inspect-registry.js）。DSH 升级会覆盖该文件，
// 需按 README「升级后怎么办」重打。
//
// 用法：
//   node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 与记录的产物 SHA 比对
//   node patch.mjs status            # 检查已安装 lib/index.js 的补丁状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等：已打过则跳过）
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   通用参数：--target <index.js 路径>  覆盖自动探测

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'index.original.js')

export const TARGET_PACKAGE = '@deepseek-ai/dsh-cordis-host-runner'
/** 该包 package.json 的 main/exports 唯一入口。 */
export const TARGET_RELATIVE = join('lib', 'index.js')
/** DSH 版本基线：锚点文本与原始 baseline 都取自这个版本。 */
export const BASELINE_DSH_VERSION = '0.1.7-alpha.2'
/** 官方原版 lib/index.js 的 SHA-256（与安装目录的 index.js.dsh-bak 逐字节一致）。 */
export const ORIGINAL_SHA256 = 'AC73F8669B536CF0F5E1728F7F64EAD820DD37FEB784E80A9EF600F95F680839'
/**
 * 应用本补丁后的 SHA-256。
 *
 * 与 dsh-client-ui-* 系列补丁同一契约：**不存 patched 全文**，只记产物 SHA —— `verify`
 * 用「由原始 baseline 重建后的 SHA 是否等于本常量」自证，与逐字节比对等价（SHA 相等即
 * 逐字节相等），锚点失配时仍会响亮报错。
 */
export const PATCHED_SHA256 = 'D3126110630D4755166CCC335E4E5C251A545FF2258BC74F3B0CFE317E822C3E'
/** 补丁特征串：出现即视为已应用（用于幂等与状态判定）。 */
const PATCH_MARKER = 'pending.lastFailure = resolution.message;'

/** 兜底超时（毫秒）。实测成功路径 0–4 秒；见顶部说明「为什么是 15 秒」。 */
export const CLIENT_QUERY_DEADLINE_MS = 15000

// ---------------------------------------------------------------------------
// 编辑规则。锚点取自 lib/index.js（打包产物，tab 缩进，双引号字符串）。
// 每条锚点必须全文件唯一 —— applyPatch 在 0 次或多次命中时抛错：宁可失败，也不瞎改。
// replacement 用数组 join 书写，避免长字符串里 tab 缩进被编辑器吞掉。
// ---------------------------------------------------------------------------
const EDITS = [
  {
    id: 'record-client-refusal',
    // 客户端明确拒绝了这次查询：记下原因（但不 settle —— 别的页面可能答得出）。
    anchor: [
      '\t\tif (!resolution.ok) return { accepted: false };',
      '\t\ttry {',
    ].join('\n'),
    replacement: [
      '\t\tif (!resolution.ok) {',
      '\t\t\tpending.lastFailure = resolution.message;',
      '\t\t\treturn { accepted: false };',
      '\t\t}',
      '\t\ttry {',
    ].join('\n'),
  },
  {
    id: 'record-output-refusal',
    // 应答到达了但输出不符合 provider 声明的 schema：同样只记录、不 settle。
    anchor: [
      '\t\t} catch {',
      '\t\t\treturn { accepted: false };',
      '\t\t}',
      '\t\tthis.pending.delete(requestId);',
    ].join('\n'),
    replacement: [
      '\t\t} catch (error) {',
      '\t\t\tpending.lastFailure = error instanceof Error ? error.message : String(error);',
      '\t\t\treturn { accepted: false };',
      '\t\t}',
      '\t\tthis.pending.delete(requestId);',
    ].join('\n'),
  },
  {
    id: 'client-query-deadline',
    // 兜底：15 秒内没有任何页面给出被接受的应答，就带着记录到的拒绝原因报错收场。
    anchor: [
      '\t\tconst result = new Promise((resolve) => {',
      '\t\t\tthis.pending.set(requestId, {',
      '\t\t\t\trequest,',
      '\t\t\t\tmethod,',
      '\t\t\t\tsettle: resolve',
      '\t\t\t});',
      '\t\t});',
    ].join('\n'),
    replacement: [
      '\t\tconst result = new Promise((resolve) => {',
      '\t\t\tthis.pending.set(requestId, {',
      '\t\t\t\trequest,',
      '\t\t\t\tmethod,',
      '\t\t\t\tsettle: resolve',
      '\t\t\t});',
      '\t\t});',
      '\t\tconst deadlineMs = ' + String(CLIENT_QUERY_DEADLINE_MS) + ';',
      '\t\tconst timer = setTimeout(() => {',
      '\t\t\tconst pending = this.pending.get(requestId);',
      '\t\t\tif (pending === void 0) return;',
      '\t\t\tthis.pending.delete(requestId);',
      '\t\t\tconst reason = pending.lastFailure === void 0 ? "no page answered" : "the client refused it: " + pending.lastFailure;',
      '\t\t\tpending.settle({',
      '\t\t\t\tok: false,',
      '\t\t\t\treason: "timeout",',
      '\t\t\t\tmessage: `Client inspect query ${providerId}.${methodName} timed out after ${deadlineMs}ms with no accepted page response (${reason})`',
      '\t\t\t});',
      '\t\t\tthis.ctx.emit("cordis/inspect-query-resolved", { requestId });',
      '\t\t}, deadlineMs);',
    ].join('\n'),
  },
  {
    id: 'clear-deadline',
    // 查询被中断或已结束时清掉定时器，避免补丁自己泄漏计时器。
    anchor: [
      '\t\t} finally {',
      '\t\t\tsignal.removeEventListener("abort", onAbort);',
      '\t\t}',
    ].join('\n'),
    replacement: [
      '\t\t} finally {',
      '\t\t\tclearTimeout(timer);',
      '\t\t\tsignal.removeEventListener("abort", onAbort);',
      '\t\t}',
    ].join('\n'),
  },
]

/** 在 source 中定位唯一锚点并替换；不唯一或不存在即报错（宁可失败，也不瞎改）。 */
export function applyPatch(source) {
  if (source.includes(PATCH_MARKER)) throw new Error('该文件已包含补丁标记，拒绝重复应用')
  let output = source
  for (const edit of EDITS) {
    const hits = output.split(edit.anchor).length - 1
    if (hits !== 1) throw new Error(`${edit.id}: 锚点必须唯一，实际命中 ${hits} 次`)
    output = output.split(edit.anchor).join(edit.replacement)
  }
  return output
}

/** 判定一份 lib/index.js 的状态：original / patched / unknown。 */
export function classify(text) {
  const sha = createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
  if (sha === ORIGINAL_SHA256) return { state: 'original', sha }
  if (text.includes(PATCH_MARKER)) return { state: 'patched', sha }
  return { state: 'unknown', sha }
}

/** 定位已安装的 lib/index.js：环境变量 → npm 全局目录 → 常见 POSIX 路径。 */
function defaultTarget() {
  const candidates = []
  if (process.env.MIASAKI_DSH_CORDIS_HOST_RUNNER) candidates.push(process.env.MIASAKI_DSH_CORDIS_HOST_RUNNER)
  const rel = join('@deepseek-ai', 'dsh', 'node_modules', TARGET_PACKAGE, TARGET_RELATIVE)
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', rel))
  candidates.push(join('/usr/local/lib/node_modules', rel))
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

function parseArgs(argv) {
  const args = { mode: argv[0] ?? 'status', yes: false, target: null }
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--yes') args.yes = true
    else if (argv[i] === '--target') { args.target = argv[i + 1] ?? null; i += 1 }
  }
  return args
}

/**
 * 重建产物必须是可解析的 ESM —— 本补丁注入的是代码而不是 CSS，语法破了必须响亮失败。
 * 写到系统临时目录再 `node --check`；临时目录不可写时只 WARN（离线自证不该因此挂掉）。
 */
async function assertParses(source) {
  const file = join(tmpdir(), `dsh-cordis-host-runner-patch-check-${process.pid}.mjs`)
  try {
    await writeFile(file, source, 'utf8')
  } catch (error) {
    console.log(`[patch] WARN 跳过语法校验（临时目录不可写：${error instanceof Error ? error.message : String(error)}）`)
    return
  }
  try {
    // stdio: 'ignore' 是刻意的：受限沙箱下捕获子进程管道会 EPERM，而这里只看退出码。
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' })
    if (result.error !== undefined) throw new Error(`无法启动 node --check：${result.error.message}`)
    if (result.status !== 0) throw new Error(`node --check 退出码 ${result.status}`)
    console.log('[patch] PASS 重建产物的 ESM 语法校验通过（node --check）')
  } finally {
    await rm(file, { force: true })
  }
}

/** 从 source 中抠出 resolveClientQuery 方法体（花括号配对，字符串里没有裸花括号）。 */
function extractResolveClientQuery(source) {
  const marker = '\tresolveClientQuery(agent, requestId, resolution) {'
  const start = source.indexOf(marker)
  if (start < 0) throw new Error('未在产物中找到 resolveClientQuery 方法')
  const open = start + marker.length - 1
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('resolveClientQuery 方法体花括号不平衡')
}

/**
 * 行为断言：本补丁修复的**核心行为**是「页面明确拒绝一次查询时，Host 必须记下原因，
 * 而不是把这次应答静默丢弃」。用最小假 registry 跑重建产物里那个真实方法：
 *   · 补丁产物 —— 拒绝后 pending 必须仍在、未 settle、`lastFailure` 记下真实消息；
 *   · baseline 原版 —— 同样输入下 `lastFailure` 必须仍是 undefined（反例：证明断言有区分力，
 *     否则一个恒真的断言会给假绿灯）。
 */
function assertRefusalIsRecorded(source, expected) {
  const build = new Function('validateOutput', `return ({ ${extractResolveClientQuery(source)} })`)
  const methods = build((_platform, _provider, _method, data) => data)

  const settledValues = []
  const pending = {
    request: { agentId: 'agent-1', provider: 'Service' },
    method: { name: 'listService' },
    settle: value => settledValues.push(value),
  }
  const emitted = []
  const registry = {
    pending: new Map([['inspect-1', pending]]),
    ctx: { emit: name => emitted.push(name) },
  }

  const outcome = methods.resolveClientQuery.call(
    registry,
    { id: 'agent-1' },
    'inspect-1',
    { ok: false, reason: 'provider-error', message: 'no catalogued Service named "conversation"' },
  )

  const recorded = pending.lastFailure
  const label = expected ? '补丁产物' : 'baseline 原版'
  if (outcome.accepted !== false) throw new Error(`${label}：拒绝应答不应被 accepted`)
  if (registry.pending.has('inspect-1') !== true) throw new Error(`${label}：拒绝应答不应清理 pending`)
  if (settledValues.length !== 0) throw new Error(`${label}：拒绝应答不应 settle`)
  if (emitted.length !== 0) throw new Error(`${label}：拒绝应答不应广播 resolved`)
  if (expected === true && recorded !== 'no catalogued Service named "conversation"') {
    throw new Error(`补丁产物：lastFailure 未记录真实拒绝原因（实为 ${String(recorded)}）`)
  }
  if (expected === false && recorded !== undefined) {
    throw new Error(`baseline 原版：不应记录 lastFailure（实为 ${String(recorded)}）——断言失去区分力`)
  }
}

/**
 * 行为断言：把注入的超时兜底代码块从重建产物里抠出来，注入一个**假的 setTimeout**
 * （立即捕获回调而不是真等 15 秒），再手动触发它，断言「无人应答」确实被结算成 timeout
 * 错误、且错误消息里带着此前记录的拒绝原因。
 * 同时断言：查询已结算（pending 里没有该 id）时回调是安全的 no-op。
 */
function assertDeadlineSettles(source) {
  const start = source.indexOf('\t\tconst deadlineMs = ')
  const endMarker = '\t\t}, deadlineMs);'
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error('未在产物中找到超时兜底代码块')
  const block = source.slice(start, end + endMarker.length)
  const build = new Function('setTimeout', 'providerId', 'methodName', 'requestId', `${block}\nreturn timer;`)

  let fire
  let delay
  const fakeSetTimeout = (callback, ms) => { fire = callback; delay = ms }
  const settled = []
  const emitted = []
  const registry = {
    pending: new Map([['inspect-7', {
      request: {},
      method: {},
      lastFailure: 'no catalogued Service named "conversation"',
      settle: value => settled.push(value),
    }]]),
    ctx: { emit: name => emitted.push(name) },
  }

  build.call(registry, fakeSetTimeout, 'Service', 'listService', 'inspect-7')
  if (delay !== CLIENT_QUERY_DEADLINE_MS) throw new Error(`超时兜底应为 ${CLIENT_QUERY_DEADLINE_MS}ms，实为 ${String(delay)}`)
  if (typeof fire !== 'function') throw new Error('超时兜底未注册回调')
  fire()

  if (registry.pending.has('inspect-7')) throw new Error('超时后应从 pending 中移除该查询')
  if (settled.length !== 1) throw new Error(`超时应恰好结算一次，实为 ${settled.length} 次`)
  if (settled[0]?.ok !== false || settled[0]?.reason !== 'timeout') throw new Error(`超时应结算为 timeout 失败，实为 ${JSON.stringify(settled[0])}`)
  if (typeof settled[0]?.message !== 'string' || !settled[0].message.includes('no catalogued Service named "conversation"')) {
    throw new Error(`超时错误消息应带出此前的拒绝原因，实为 ${String(settled[0]?.message)}`)
  }
  if (!emitted.includes('cordis/inspect-query-resolved')) throw new Error('超时后应广播 cordis/inspect-query-resolved')
  if (source.includes('clearTimeout(timer);') !== true) throw new Error('缺少 clearTimeout(timer) —— 定时器会泄漏')

  // 已结算的查询：回调必须是安全 no-op（否则会把别人的 pending 误当作自己那条）。
  const empty = { pending: new Map(), ctx: { emit: () => { throw new Error('no-op 分支不应广播') } } }
  build.call(empty, fakeSetTimeout, 'Service', 'listService', 'inspect-8')
  fire()
}

/** verify：baseline 原始文件 → 重建 → 产物 SHA 等于记录值，且语法与关键行为自证。 */
async function cmdVerify() {
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  const rebuilt = applyPatch(original)
  const sha = createHash('sha256').update(rebuilt, 'utf8').digest('hex').toUpperCase()
  await assertParses(rebuilt)
  assertRefusalIsRecorded(original, false)
  assertRefusalIsRecorded(rebuilt, true)
  console.log('[patch] PASS 拒绝应答行为断言：补丁产物记录原因且不抢答，baseline 原版不记录（断言有区分力）')
  assertDeadlineSettles(rebuilt)
  console.log('[patch] PASS 超时兜底行为断言：无人应答 15s 后结算为 timeout，消息带出真实拒绝原因')
  if (sha !== PATCHED_SHA256) {
    console.error('[patch] FAIL 由 baseline 重建的产物与记录的 SHA 不一致')
    console.error(`  重建 SHA-256: ${sha}`)
    console.error(`  记录 SHA-256: ${PATCHED_SHA256}`)
    console.error(`  长度 重建=${Buffer.byteLength(rebuilt, 'utf8')}（原始 ${Buffer.byteLength(original, 'utf8')}）`)
    for (const edit of EDITS) {
      const at = rebuilt.indexOf(edit.replacement.slice(0, 48))
      if (at >= 0) console.error(`  ${edit.id} 产物片段: ${rebuilt.slice(at, at + 120)}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`[patch] PASS 由 baseline 原始文件重建出与记录一致的补丁产物（${EDITS.length} 条编辑，SHA-256 ${sha.slice(0, 16)}…）`)
}

async function cmdStatus(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 lib/index.js（用 --target 指定，或设 MIASAKI_DSH_CORDIS_HOST_RUNNER）')
    process.exitCode = 2
    return
  }
  const text = await readFile(target, 'utf8')
  const { state, sha } = classify(text)
  const backup = `${target}.dsh-bak`
  console.log(`[patch] 目标   ${target}`)
  console.log(`[patch] 状态   ${state}  (SHA-256 ${sha.slice(0, 16)}…)`)
  console.log(`[patch] 备份   ${existsSync(backup) ? backup : '（无）'}`)
  if (state === 'unknown') {
    console.log(`[patch] 提示   该文件既非 ${BASELINE_DSH_VERSION} 原版也非补丁版——DSH 很可能已升级，需先核对锚点再适配`)
  }
  if (state === 'original') {
    console.log('[patch] 提示   补丁未生效；node patch.mjs apply 后需重启 DSH host 进程')
  }
}

async function cmdApply(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 lib/index.js（用 --target 指定，或设 MIASAKI_DSH_CORDIS_HOST_RUNNER）')
    process.exitCode = 2
    return
  }
  const text = await readFile(target, 'utf8')
  const { state } = classify(text)
  if (state === 'patched') {
    console.log('[patch] 已应用，跳过（幂等）')
    return
  }
  if (state === 'unknown' && !args.yes) {
    console.error('[patch] 目标文件不是已知的原始版本，可能已被其他改动或 DSH 升级过；确认无误后加 --yes 强制应用')
    process.exitCode = 2
    return
  }
  const patched = applyPatch(text)
  const backup = `${target}.dsh-bak`
  if (!existsSync(backup)) await copyFile(target, backup)
  await writeFile(target, patched, 'utf8')
  const sha = createHash('sha256').update(patched, 'utf8').digest('hex').toUpperCase()
  console.log(`[patch] 已应用 → ${target}`)
  console.log(`[patch] 备份   ${backup}`)
  console.log(`[patch] 结果   ${Buffer.byteLength(patched, 'utf8')} 字节，SHA-256 ${sha.slice(0, 16)}…${sha === PATCHED_SHA256 ? '（与记录一致）' : ''}`)
  console.log('[patch] 提示   生效需**重启 DSH host 进程**（Node 已加载的模块不会热更新）；重启前查询仍会挂起。')
}

async function cmdRevert(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 lib/index.js（用 --target 指定，或设 MIASAKI_DSH_CORDIS_HOST_RUNNER）')
    process.exitCode = 2
    return
  }
  const backup = `${target}.dsh-bak`
  if (!existsSync(backup)) {
    console.error(`[patch] 没有备份可还原：${backup}`)
    process.exitCode = 2
    return
  }
  await copyFile(backup, target)
  console.log(`[patch] 已还原 ${target} ← ${backup}`)
  console.log('[patch] 提示   还原同样需要重启 DSH host 进程才生效。')
}

// 仅在直接执行时跑 CLI（被 import 时不执行）。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2))
  const commands = { verify: cmdVerify, status: cmdStatus, apply: cmdApply, revert: cmdRevert }
  const command = commands[args.mode]
  if (command === undefined) {
    console.error(`[patch] 未知模式：${args.mode}（可选 verify / status / apply / revert）`)
    process.exitCode = 2
  } else {
    // 锚点缺失/不唯一时给出可读结论，而不是抛裸栈——这是 DSH 升级后最可能的失败点。
    try {
      await command(args)
    } catch (error) {
      console.error(`[patch] 失败：${error instanceof Error ? error.message : String(error)}`)
      console.error('[patch] 提示：锚点失效通常意味着 DSH 已升级；请按 README「升级后怎么办」核对锚点并更新 EDITS 与 baseline。')
      process.exitCode = 1
    }
  }
}
