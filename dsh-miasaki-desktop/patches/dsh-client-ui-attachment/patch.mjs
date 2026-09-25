#!/usr/bin/env node
// DSH 消息图片画廊「宽高比保持」运行时补丁 —— 多图 tile 不再压成 64×64 方块。
//
// 背景（用户反馈「修复图片显示的问题」）：消息里连发多张截图时，官方画廊
// （`@deepseek-ai/dsh-client-ui-attachment` 的 MessageImage）把每张图都渲染成
// **固定 64×64 且 object-fit:cover** 的方片。宽高比偏离 1:1 的图因此被裁得只剩
// 一小块：716×34 的红条截图只剩原图 1/21 的区域被放大显示，完全无法辨认；
// 84×32、70×36 这类小截图同样面目全非。单图场景官方有 singleFit（长边 240 +
// 比例 clamp）不受影响，问题只在多图 tile 这一路。
//
// 修法（纯 CSS，不碰渲染逻辑）：
//   1. tile 定宽 64px → 宽自适应（min 44 / max 220），高仍 64px；
//   2. tile 内 img 由 cover 裁切改为 contain 完整显示（高度 100%、宽度按原始
//      宽高比、超宽图受 max-width 约束后 contain 居中留白）。
// 常规横图（16:9 → 114×64）contain 与 cover 等价，无留白无裁切；超宽图
// （如 21:1 红条 → 220×10.5）完整可见；竖图 clamp 在 min-width 44 内居中。
// 单图（singleFit）与缩略图（thumbnail 变体）两条路的选择器特异性均不受影响。
//
// 为什么直接改 bundle：与既有五件 DSH 本体补丁同一范式（见
// ../dsh-client-ui-settings-models/patch.mjs 头部注释）—— 本机无 pnpm 全量
// 重建链路，补丁规则与基线进版本控制，DSH 升级覆盖后靠 verify/status 报警并按
// README 重打。
//
// 补丁形态：唯一子串替换（minified bundle 里 CSS 是一个大字符串字面量，行级
// 编辑不适用）。每条替换的 from 必须在源文件里**恰好出现一次**，否则报错而非瞎改。
//
// 用法：
//   node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 逐字节比对 + 语法闸门
//   node patch.mjs status            # 已安装 bundle 的补丁状态与语法状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等）
//   node patch.mjs resync            # 由 .dsh-bak 重打
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   node patch.mjs rebuild           # 改过 EDITS 后：由 baseline 原始文件重建 golden 产物
//   通用参数：--target <client.js 路径>
//
// 出口不变量：产物必须过语法闸门（vm.Script / 经典脚本目标）—— client bundle
// 是多包合并产物，一个包语法坏了会让整份 bundle 不注册、页面所有插件一起失效。

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'client.original.js')
const PATCHED_FILE = join(BASELINE, 'client.patched.js')

export const TARGET_PACKAGE = '@deepseek-ai/dsh-client-ui-attachment'
/** DSH 版本基线：CSS 锚点与两份 baseline 都取自这个版本。 */
export const BASELINE_DSH_VERSION = '0.1.7-rc.2'
/** 官方原版 client.js 的 SHA-256。 */
export const ORIGINAL_SHA256 = '538711EF1FD7CBEDD7C80817AFB878A2568868F7EF7E0E23D56843C32CF5E969'
/** 应用本补丁后的 SHA-256。 */
export const PATCHED_SHA256 = 'DDDBFA9495CAEAA6EDCE46010CA95BE3D4F3DA799E10E198FBECC6A4DC78B69F'
/** 补丁特征串：出现即视为已应用（幂等与状态判定）。 */
const PATCH_MARKER = '.R_Yw7q_frame[data-variant=tile] img{object-fit:contain'

// ---------------------------------------------------------------------------
// 编辑规则。from 必须唯一命中；to 为替换文本。CSS 文本取自 baseline 第 766 行
// 的 MessageImage.module.css 字面量（改 tile 尺寸规则 + tile 内 img 显示规则）。
// ---------------------------------------------------------------------------
const EDITS = [
  {
    id: 'gallery-tile-size',
    // 定宽定高 64×64 → 高仍 64、宽按图片宽高比自适应（44–220）。
    from: '.R_Yw7q_frame[data-variant=tile]{width:64px;min-width:64px;height:64px;min-height:64px}',
    to: '.R_Yw7q_frame[data-variant=tile]{width:auto;min-width:44px;max-width:220px;height:64px;min-height:64px}',
  },
  {
    id: 'gallery-tile-fit',
    // base 的 cover/100%/100% 之后插一条 tile 专用 contain 规则（特异性
    // (0,2,1) 高于 base (0,1,1)；thumbnail 变体那条虽同为 (0,2,1) 但选择器域
    // 互斥，不会同时命中同一元素）。
    from: '.R_Yw7q_frame img{object-fit:cover;width:100%;height:100%;display:block}',
    to: '.R_Yw7q_frame img{object-fit:cover;width:100%;height:100%;display:block}.R_Yw7q_frame[data-variant=tile] img{object-fit:contain;width:auto;height:100%;max-width:220px}',
  },
]

/** 一份 bundle 文本的 SHA-256（大写十六进制）。 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
}

/**
 * 语法闸门：产物必须是可解析的**经典脚本**（与加载路径一致：浏览器按普通
 * 脚本求值 window.__ModuleLoader__.load(...)）。
 */
export function assertParses(source, label) {
  try {
    new Script(source, { filename: 'bundle.js' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} 不是合法 JavaScript：${message}${locateSyntaxError(error, source)}`)
  }
}

/** 语法判定的非抛错版本：合法返回 null。 */
export function parseVerdict(source) {
  try {
    new Script(source, { filename: 'bundle.js' })
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
    const hit = /bundle\.js:(\d+)/.exec(stack)
    return hit === null ? message : `${message}（第 ${hit[1]} 行）`
  }
}

/** 从 SyntaxError 调用栈抠出 `bundle.js:<行号>` 并附 ±2 行上下文。 */
function locateSyntaxError(error, source) {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
  const hit = /bundle\.js:(\d+)/.exec(stack)
  if (hit === null) return ''
  const line = Number(hit[1])
  const lines = source.split('\n')
  const from = Math.max(0, line - 3)
  const to = Math.min(lines.length, line + 2)
  const context = []
  for (let i = from; i < to; i += 1) {
    context.push(`       ${i + 1 === line ? '>>' : '  '} ${i + 1}: ${(lines[i] || '').slice(0, 200)}`)
  }
  return `\n       出错行 ${line}：\n${context.join('\n')}`
}

/** 统计子串出现次数（唯一性判据用，不能依赖 indexOf 的首次命中）。 */
function countOccurrences(text, needle) {
  if (needle === '') throw new Error('编辑规则 from 不得为空串')
  let count = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * 应用补丁到一份 bundle 文本，返回新文本。纯函数，verify / apply / rebuild 共用。
 * 每条编辑的 from 必须恰好命中一次；幂等由调用方先查 PATCH_MARKER。
 */
export function applyPatch(source) {
  let text = source
  for (const edit of EDITS) {
    const hits = countOccurrences(text, edit.from)
    if (hits !== 1) {
      throw new Error(`${edit.id}: 锚点必须唯一命中（实际 ${hits} 次）——DSH 版本可能已变，请核对 baseline 后适配`)
    }
    text = text.replace(edit.from, edit.to)
  }
  assertParses(text, 'applyPatch 产物')
  return text
}

/** 判定一份 bundle 的状态：original / patched / unknown。 */
export function classify(text) {
  if (text.includes(PATCH_MARKER)) return { state: 'patched', sha: sha256(text) }
  if (sha256(text) === ORIGINAL_SHA256) return { state: 'original', sha: sha256(text) }
  return { state: 'unknown', sha: sha256(text) }
}

/** 定位已安装的 client.js：环境变量 → npm 全局目录。 */
function defaultTarget() {
  const candidates = []
  if (process.env.MIASAKI_DSH_BUNDLE) candidates.push(process.env.MIASAKI_DSH_BUNDLE)
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

async function cmdVerify() {
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  const patched = await readFile(PATCHED_FILE, 'utf8')
  assertParses(patched, 'baseline/client.patched.js')
  const rebuilt = applyPatch(original)
  const sha = sha256(rebuilt)
  if (rebuilt !== patched) {
    console.error('[patch] FAIL 重建结果与 baseline 产物不一致')
    console.error(`  重建 SHA-256: ${sha}`)
    console.error(`  baseline     : ${sha256(patched)}`)
    process.exitCode = 1
    return
  }
  console.log(`[patch] PASS 由 baseline 原始文件重建出逐字节一致的补丁产物（${EDITS.length} 条编辑，SHA-256 ${sha.slice(0, 16)}…）`)
  console.log('[patch] PASS 两侧产物的语法闸门通过（vm.Script / 经典脚本目标）')
  if (sha !== PATCHED_SHA256) {
    console.error('[patch] FAIL PATCHED_SHA256 常量与产物不一致')
    console.error(`  产物  : ${sha}`)
    console.error(`  常量  : ${PATCHED_SHA256}`)
    console.error('  修法  : 把上面「产物」那行写回 patch.mjs 的 PATCHED_SHA256')
    process.exitCode = 1
    return
  }
  console.log('[patch] PASS PATCHED_SHA256 常量与产物一致')
}

async function cmdStatus(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_BUNDLE）')
    process.exitCode = 2
    return
  }
  const text = await readFile(target, 'utf8')
  const { state, sha } = classify(text)
  const backup = `${target}.dsh-bak`
  console.log(`[patch] 目标   ${target}`)
  console.log(`[patch] 状态   ${state}  (SHA-256 ${sha.slice(0, 16)}…)`)
  console.log(`[patch] 备份   ${existsSync(backup) ? backup : '（无）'}`)
  const broken = parseVerdict(text)
  console.log(`[patch] 语法   ${broken === null ? '合法' : `非法 —— ${broken}`}`)
  if (state === 'unknown') {
    console.log(`[patch] 提示   该文件既非 ${BASELINE_DSH_VERSION} 原版也非补丁版——DSH 很可能已升级，需先核对锚点再适配`)
  }
}

async function cmdApply(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js')
    process.exitCode = 2
    return
  }
  const text = await readFile(target, 'utf8')
  const { state } = classify(text)
  if (state === 'patched') {
    const broken = parseVerdict(text)
    if (broken === null) {
      console.log('[patch] 已应用，跳过（幂等）')
      return
    }
    console.error(`[patch] 已应用但产物语法非法：${broken}；请用 resync 由备份重打`)
    process.exitCode = 1
    return
  }
  if (state === 'unknown' && !args.yes) {
    console.error('[patch] 目标文件不是已知的官方原版，可能已被其他改动或 DSH 升级过；确认无误后加 --yes 强制应用')
    process.exitCode = 2
    return
  }
  const patched = applyPatch(text)
  const backup = `${target}.dsh-bak`
  if (!existsSync(backup)) await copyFile(target, backup)
  await writeFile(target, patched, 'utf8')
  console.log(`[patch] 已应用 → ${target}`)
  console.log(`[patch] 备份   ${backup}`)
  console.log(`[patch] 结果   ${Buffer.byteLength(patched, 'utf8')} 字节，SHA-256 ${sha256(patched).slice(0, 16)}…`)
  console.log('[patch] 提示   浏览器侧生效需刷新页面（client-hmr 可能已热推 rebuilt 帧）')
}

async function cmdResync(args) {
  const target = args.target ?? defaultTarget()
  const backup = `${target}.dsh-bak`
  if (!existsSync(backup)) {
    console.error(`[patch] 没有备份可用：${backup}——直接用 apply`)
    process.exitCode = 1
    return
  }
  const backupText = await readFile(backup, 'utf8')
  if (sha256(backupText) !== ORIGINAL_SHA256) {
    console.error('[patch] 备份不是已知的官方原版，拒绝 resync（请改走 rebuild-baseline 重新适配）')
    process.exitCode = 1
    return
  }
  const patched = applyPatch(backupText)
  await writeFile(target, patched, 'utf8')
  console.log(`[patch] 已由备份重打 → ${target}`)
  console.log('[patch] 提示   浏览器侧生效需刷新页面')
}

async function cmdRevert(args) {
  const target = args.target ?? defaultTarget()
  const backup = `${target}.dsh-bak`
  if (!existsSync(backup)) {
    console.error(`[patch] 没有备份可用：${backup}`)
    process.exitCode = 1
    return
  }
  await copyFile(backup, target)
  console.log(`[patch] 已还原 → ${target}`)
}

async function cmdRebuild() {
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  if (sha256(original) !== ORIGINAL_SHA256) {
    console.error('[patch] baseline 原始文件与 ORIGINAL_SHA256 不一致，拒绝重建')
    process.exitCode = 1
    return
  }
  const patched = applyPatch(original)
  assertParses(patched, '重建产物')
  await writeFile(PATCHED_FILE, patched, 'utf8')
  console.log(`[patch] 已重建 ${PATCHED_FILE}`)
  console.log(`[patch] SHA-256 ${sha256(patched)} —— 回填到 patch.mjs 的 PATCHED_SHA256 后跑 verify`)
}

const COMMANDS = { verify: cmdVerify, status: cmdStatus, apply: cmdApply, resync: cmdResync, revert: cmdRevert, rebuild: cmdRebuild }

// 仅在直接执行时跑 CLI（被 import 时不执行）——与其余补丁同一契约。
// 缺了这道守卫，任何 import 本文件的工具（如 scripts/patch-live-audit.mjs 的
// live 状态审计）都会以调用方的 argv 误跑一次 status：污染审计输出，还可能
// 把调用方的 exitCode 一起改掉。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2))
  const command = COMMANDS[args.mode]
  if (command === undefined) {
    console.error(`[patch] 未知命令：${args.mode}（可用：${Object.keys(COMMANDS).join(' / ')}）`)
    process.exitCode = 2
  } else {
    try {
      await command(args)
    } catch (error) {
      console.error(`[patch] 失败：${error instanceof Error ? error.message : String(error)}`)
      console.error('[patch] 提示   锚点失效通常意味着 DSH 已升级；请按 README「升级后怎么办」核对锚点并更新 EDITS 与 baseline。')
      process.exitCode = 1
    }
  }
}
