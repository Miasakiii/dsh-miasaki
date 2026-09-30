#!/usr/bin/env node
// DSH 会话浏览器「侧线会话不占列表」运行时补丁。
//
// 背景：`@miasaki/dsh-sidebar` 的「辅助对话」用官方 `sessions.fork` 建一条侧线 ——
//   它继承主会话到「最后一个已完成轮次」的上下文、可继续对话，是一条**真会话**。
//   官方把「会话列表显示什么」这一投影留在壳里，插件既没有「不进列表」的接口，
//   也写不了会话元数据（`sessions.d.ts` 没有隐藏/过滤入口；`origin` 只有 subagent
//   一个取值且由宿主写入）。于是侧线会以普通会话的身份出现在左侧列表与会话搜索里 ——
//   用户的原话是「辅助对话怎么还是有记录，会上会话记录」。
//
//   官方**自己**解决同类问题的方式在这一个函数里：`sessionVisible()` 把
//   `origin === "subagent"` 的会话整条排除（"Subagent children use their parent
//   header catalog"）—— 也就是说「建了会话但不进列表」在 DSH 里是既有形态，
//   只是没有向插件开放。本补丁补的正是这一个开口。
//
// 本补丁只做一件事：在 `sessionVisible()` 的 origin 判定之后追加一条判定 ——
//   若会话 id 出现在**插件声明的隐藏集合**里，则不显示。
//   声明读取自 localStorage 键 `miasaki-sidebar:sidechat:hidden:v1`
//   （JSON 字符串数组；`@miasaki/dsh-sidebar` 侧线登记表变更时重写）。
//   `sessionVisible()` 是列表分组、扁平列表、会话搜索**共用的唯一可见性判据**
//   （`deriveGroups` → `groupByWorkspace`、`deriveSearchResults`、`visibleSessionIds`
//   全部经它），所以一处判定即覆盖「列表 + 搜索」两条路径，无遗漏面。
//
// 失败语义（关键）：**声明缺席即官方原状**。localStorage 读不到、键不存在、
//   内容不是合法 JSON、元素不是字符串 —— 一律按「没有侧线」处理，官方列表行为
//   一字不变。补丁绝不因为声明的问题而影响任何人（插件没装时本补丁等于空操作）。
//
// 代价与边界（与其余补丁同）：DSH 升级会覆盖该包，需重新应用；只改这一个包的
//   client 产物，不动 DSH 源码、不动其他包。官方桌面端走 app.asar，天然不受影响。
//
// 用法：
//   node patch.mjs verify            # 离线自证：baseline 原始 → 重建 → 与记录的产物 SHA 比对 + 语法闸门
//   node patch.mjs status            # 检查已安装 bundle 的补丁状态与语法状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等：已打过则跳过）
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   通用参数：--target <client.js 路径>  覆盖自动探测（默认探测 %APPDATA%\npm 全局安装）
//
// 设计文档：../../../dsh-miasaki-sidebar/design/2026-09-27-sidebar-m2-sidechat-design.md §5.1(E)

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'client.original.js')

export const TARGET_PACKAGE = '@deepseek-ai/dsh-client-ui-workspace'
/** DSH 版本基线：锚点文本与原始 baseline 都取自这个版本。 */
export const BASELINE_DSH_VERSION = '0.2.0-rc.2'
/** 官方原版 client.js 的 SHA-256（与安装目录的 client.js.dsh-bak 逐字节一致）。 */
export const ORIGINAL_SHA256 = 'E784543780FB8AC7C38C853AFD26B9B1713C6907EEC2B07EFF37461E07BD3BE9'
/** 应用本补丁后的 SHA-256（产物不落盘，用 SHA 自证：重建 == 逐字节相等）。 */
export const PATCHED_SHA256 = '511E7A12438973FF558432CADC4D9E16480895A2BE3E78F1C4960477D53F5234'
/**
 * 补丁特征串：出现即视为已应用（用于幂等与状态判定）。
 * 取自己插入的那一行判定 —— 它在本包产物里唯一。
 */
const PATCH_MARKER = '\t\t\tif (miasakiSideChatHidden(session.id)) return false;'

// ---------------------------------------------------------------------------
// 编辑规则。锚点是编译产物里的 JS 片段原文（含原有 tab 缩进）；锚点必须全文件唯一。
//
// 一条编辑：把官方 JSDoc 之后、`sessionVisible()` 之前的位置让给声明读取函数，
// 再在 origin 判定之后追加一行隐藏判定。**不改动官方任何既有分支**。
// ---------------------------------------------------------------------------
const EDITS = [
  {
    id: 'sidechat-hidden-visibility-gate',
    anchor: [
      '\t\t* Ordinary sessions are visible; among blank sessions, only the current one',
      '\t\t* is visible. Subagent children use their parent header catalog; archived',
      '\t\t* sessions follow the archived filter, while their accounting slots remain',
      '\t\t* either way so unarchiving restores position.',
      '\t\t*/',
      '\t\tfunction sessionVisible(session, current, archived, archivedFilter) {',
      '\t\t\tif (session.origin === "subagent") return false;',
    ].join('\n'),
    replacement: [
      '\t\t* Ordinary sessions are visible; among blank sessions, only the current one',
      '\t\t* is visible. Subagent children use their parent header catalog; archived',
      '\t\t* sessions follow the archived filter, while their accounting slots remain',
      '\t\t* either way so unarchiving restores position.',
      '\t\t*/',
      '\t\t/**',
      '\t\t* miasaki 侧线（@miasaki/dsh-sidebar「辅助对话」）的列表隐藏声明。',
      '\t\t*',
      '\t\t* 侧线是官方 sessions.fork 出的真会话：有上下文、能继续对话，但官方没有',
      '\t\t* 「不进列表」的插件接口，插件也写不了会话元数据 —— 于是约定一份**跨包声明**：',
      '\t\t* 插件把侧线 child 会话 id 写进 localStorage 的 JSON 字符串数组，本包只读它。',
      '\t\t* 声明缺失、格式非法、存储不可用一律按「没有侧线」处理：官方列表行为不变。',
      '\t\t*/',
      '\t\tconst MIASAKI_SIDECHAT_HIDDEN_KEY = "miasaki-sidebar:sidechat:hidden:v1";',
      '\t\tlet miasakiSideChatHiddenRaw = null;',
      '\t\tlet miasakiSideChatHiddenSet = new Set();',
      '\t\tfunction miasakiSideChatHidden(sessionId) {',
      '\t\t\tlet raw;',
      '\t\t\ttry {',
      '\t\t\t\traw = window.localStorage.getItem(MIASAKI_SIDECHAT_HIDDEN_KEY);',
      '\t\t\t} catch (error) {',
      '\t\t\t\t// guard-ok: 存储不可用（被禁用 / 隐私模式 / 安全异常）时按「没有侧线声明」',
      '\t\t\t\t// 显式降级，官方列表的既有行为一字不变 —— 对外部环境缺失的降级，不是吞业务错误。',
      '\t\t\t\treturn false;',
      '\t\t\t}',
      '\t\t\tif (raw !== miasakiSideChatHiddenRaw) {',
      '\t\t\t\tmiasakiSideChatHiddenRaw = raw;',
      '\t\t\t\tconst next = new Set();',
      '\t\t\t\tif (raw !== null) {',
      '\t\t\t\t\ttry {',
      '\t\t\t\t\t\tconst parsed = JSON.parse(raw);',
      '\t\t\t\t\t\tif (Array.isArray(parsed)) for (const id of parsed) if (typeof id === "string" && id.length > 0) next.add(id);',
      '\t\t\t\t\t} catch (error) {',
      '\t\t\t\t\t\tconsole.warn("[dsh-client-ui-workspace] miasaki 侧线隐藏声明不是合法 JSON，已忽略：", error);',
      '\t\t\t\t\t}',
      '\t\t\t\t}',
      '\t\t\t\tmiasakiSideChatHiddenSet = next;',
      '\t\t\t}',
      '\t\t\treturn miasakiSideChatHiddenSet.has(sessionId);',
      '\t\t}',
      '\t\tfunction sessionVisible(session, current, archived, archivedFilter) {',
      '\t\t\tif (session.origin === "subagent") return false;',
      '\t\t\tif (miasakiSideChatHidden(session.id)) return false;',
    ].join('\n'),
  },
]

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
}

function countOccurrences(text, needle) {
  if (needle === '') throw new Error('编辑规则锚点不得为空串')
  let count = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * 语法闸门：产物必须是可解析的**经典脚本**（与加载路径一致：浏览器按普通
 * 脚本求值 window.__ModuleLoader__.load(...)）。client bundle 是多包合并
 * 产物，一个包语法坏了会让整份 bundle 不注册、页面所有插件一起失效。
 */
export function parseVerdict(source) {
  try {
    new Script(source, { filename: 'bundle.js' })
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
    const hit = /bundle\.js:(\d+)/.exec(stack)
    if (hit === null) return message
    const line = Number(hit[1])
    const lines = source.split('\n')
    const context = []
    for (let i = Math.max(0, line - 3); i < Math.min(lines.length, line + 2); i += 1) {
      context.push(`      ${i + 1 === line ? '>>' : '  '} ${i + 1}: ${(lines[i] || '').slice(0, 200)}`)
    }
    return `${message}（第 ${line} 行）\n${context.join('\n')}`
  }
}

/** 在 source 中定位唯一锚点并替换；不唯一或不存在即报错（宁可失败，也不瞎改）。 */
export function applyPatch(source) {
  if (source.includes(PATCH_MARKER)) throw new Error('该文件已包含补丁标记，拒绝重复应用')
  let output = source
  for (const edit of EDITS) {
    const hits = countOccurrences(output, edit.anchor)
    if (hits !== 1) throw new Error(`${edit.id}: 锚点必须唯一，实际命中 ${hits} 次`)
    output = output.split(edit.anchor).join(edit.replacement)
  }
  return output
}

/**
 * 行为自证：SHA 相等只证明「重建 == 记录」，语法闸门只证明「产物是合法 JS」——
 * **两者都证明不了那段解析逻辑真的对**（本仓 2026-09-28 的白屏事故就是
 * 「SHA 自证 PASS、产物却是语法错误」）。本补丁新增的是一段读取声明并判定的代码，
 * 所以这里把产物里那一段抽出来**真的跑一遍**：键缺失 / 正常 / 坏 JSON / 非数组
 * 四种形态各断言一次。声明坏了必须归到「没有侧线」，绝不能把会话挡在列表外。
 *
 * @param patched - 由 baseline 重建出的产物全文。
 * @returns 失败原因，全部通过则 null。
 */
export function behaviorVerdict(patched) {
  const start = patched.indexOf('const MIASAKI_SIDECHAT_HIDDEN_KEY')
  const end = patched.indexOf('function sessionVisible(', start)
  if (start < 0 || end < 0) return '产物里找不到 miasaki 侧线判定的代码段'
  const snippet = patched.slice(start, end)
  /**
   * **可变**的 window 替身：判定函数在闭包里缓存上一次读到的声明串，
   * 所以替身必须能改（`storage.raw`）—— 否则每个用例都读到同一个值，
   * 测出来的只是第一个用例（首版就是这么错的，被本函数自己抓出来）。
   */
  const storage = { raw: null }
  let hidden
  try {
    hidden = new Function('window', 'console', `${snippet}\nreturn miasakiSideChatHidden;`)(
      { localStorage: { getItem: () => storage.raw } },
      { warn: () => {} },
    )
  } catch (error) {
    return `判定代码段无法求值：${error instanceof Error ? error.message : String(error)}`
  }
  const cases = [
    { name: '键缺失', storage: null, id: 'session-a', want: false },
    { name: '命中', storage: '["session-a"]', id: 'session-a', want: true },
    { name: '未命中', storage: '["session-a"]', id: 'session-b', want: false },
    { name: '空数组', storage: '[]', id: 'session-a', want: false },
    { name: '改回缺失（缓存须失效）', storage: null, id: 'session-a', want: false },
    { name: '坏 JSON', storage: '{ 这不是 JSON', id: 'session-a', want: false },
    { name: '非数组（对象）', storage: '{"session-a":1}', id: 'session-a', want: false },
    { name: '数组里混入非字符串', storage: '["session-a",42,null]', id: 'session-a', want: true },
  ]
  for (const item of cases) {
    storage.raw = item.storage
    const verdict = hidden(item.id)
    if (verdict !== item.want) {
      return `行为自证失败（${item.name}）：声明=${JSON.stringify(item.storage)} 查询=${item.id} 期望=${item.want} 实际=${verdict}`
    }
  }
  return null
}

/** 判定一份 bundle 的状态：original / patched / unknown。 */
export function classify(text) {
  const sha = sha256(text)
  if (sha === ORIGINAL_SHA256) return { state: 'original', sha }
  if (text.includes(PATCH_MARKER)) return { state: 'patched', sha }
  return { state: 'unknown', sha }
}

/** 定位已安装的 client.js：环境变量 → npm 全局目录 → 常见 POSIX 路径。 */
function defaultTarget() {
  const candidates = []
  if (process.env.MIASAKI_DSH_WORKSPACE_BUNDLE) candidates.push(process.env.MIASAKI_DSH_WORKSPACE_BUNDLE)
  const rel = join('@deepseek-ai', 'dsh', 'node_modules', TARGET_PACKAGE, 'lib', 'client.js')
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

/** verify：baseline 原始文件 → 重建 → 产物 SHA 必须等于记录的 PATCHED_SHA256；两侧过语法闸门。 */
async function cmdVerify() {
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  const rebuilt = applyPatch(original)
  const sha = sha256(rebuilt)
  const originalVerdict = parseVerdict(original)
  if (originalVerdict !== null) {
    console.error('[patch] FAIL baseline 原版不是合法 JavaScript')
    console.error(`  ${originalVerdict}`)
    process.exitCode = 1
    return
  }
  const patchedVerdict = parseVerdict(rebuilt)
  if (patchedVerdict !== null) {
    console.error('[patch] FAIL 重建产物不是合法 JavaScript')
    console.error(`  ${patchedVerdict}`)
    process.exitCode = 1
    return
  }
  if (sha !== PATCHED_SHA256) {
    console.error('[patch] FAIL 由 baseline 重建的产物与记录的 SHA 不一致')
    console.error(`  重建 SHA-256: ${sha}`)
    console.error(`  记录 SHA-256: ${PATCHED_SHA256}`)
    console.error(`  长度 重建=${Buffer.byteLength(rebuilt, 'utf8')}（原始 ${Buffer.byteLength(original, 'utf8')}）`)
    process.exitCode = 1
    return
  }
  // SHA 相等只证明「重建 == 记录」；那段解析逻辑对不对，得真的跑一遍。
  const behavior = behaviorVerdict(rebuilt)
  if (behavior !== null) {
    console.error('[patch] FAIL 行为自证未通过 —— 产物逻辑与契约不符')
    console.error(`  ${behavior}`)
    process.exitCode = 1
    return
  }
  console.log(`[patch] PASS 由 baseline 原始文件重建出与记录一致的补丁产物（${EDITS.length} 条编辑，SHA-256 ${sha.slice(0, 16)}…）；两侧语法闸门 + 7 例行为自证通过`)
}

async function cmdStatus(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_WORKSPACE_BUNDLE）')
    process.exitCode = 2
    return
  }
  const text = await readFile(target, 'utf8')
  const { state, sha } = classify(text)
  const backup = `${target}.dsh-bak`
  const verdict = parseVerdict(text)
  console.log(`[patch] 目标   ${target}`)
  console.log(`[patch] 状态   ${state}  (SHA-256 ${sha.slice(0, 16)}…)`)
  console.log(`[patch] 语法   ${verdict === null ? '合法' : `非法 —— ${verdict}`}`)
  console.log(`[patch] 备份   ${existsSync(backup) ? backup : '（无）'}`)
  if (state === 'unknown') {
    console.log('[patch] 提示   该文件既非基线原版也非补丁版——DSH 很可能已升级，需先核对锚点再适配')
  }
}

async function cmdApply(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_WORKSPACE_BUNDLE）')
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
  const verdict = parseVerdict(patched)
  if (verdict !== null) {
    console.error(`[patch] 拒绝写入：产物语法非法 —— ${verdict}`)
    process.exitCode = 1
    return
  }
  const backup = `${target}.dsh-bak`
  if (!existsSync(backup)) await copyFile(target, backup)
  await writeFile(target, patched, 'utf8')
  const sha = sha256(patched)
  console.log(`[patch] 已应用 → ${target}`)
  console.log(`[patch] 备份   ${backup}`)
  console.log(`[patch] 结果   ${Buffer.byteLength(patched, 'utf8')} 字节，SHA-256 ${sha.slice(0, 16)}…${sha === PATCHED_SHA256 ? '（与记录一致）' : ''}`)
  console.log('[patch] 提示   浏览器侧生效需刷新页面；声明键由 @miasaki/dsh-sidebar 写入')
}

async function cmdRevert(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_WORKSPACE_BUNDLE）')
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
