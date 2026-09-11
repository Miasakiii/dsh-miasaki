#!/usr/bin/env node
// DSH 会话头「窄宽度溢出保护」运行时补丁。
//
// 背景：官方会话头（`@deepseek-ai/dsh-client-ui-conversation`）把一行分成
//   titleCluster   flex:1 + min-width:0   ← 可被一路压到 0
//     crumbs                             ← 标题，min-width:0 + overflow:hidden，先被裁没
//     headerActions  flex:none            ← 不收缩（各插件往里塞控件）
//   headerUtilities  flex:none            ← 不收缩
//   headerCorner     flex:none            ← 不收缩
// 因此当这一行的可用宽度小于「固定项之和」时，titleCluster 被压到 0，而它内部 flex:none
// 的 headerActions 无处安放、**溢出**并与同样从 x≈0 起画的 utilities 重叠 —— 表现为
// 控件互相压盖、标题消失（2026-09-10 实机：展开右侧边栏后「对话/会话布」被图标盖住）。
//
// 本补丁只做一件事：把 headerActions 从「不收缩」改为「可收缩 + 横向可滚」，
// 让溢出退化成**可滚动**而不是**压叠** —— 任何插件、任何窄窗口都不再出现不可用状态。
// 它是 canvas 线自适应降级（画布切换器在窄宽度下收成图标）的**兜底**：前者保住可用性，
// 本补丁保证最坏情况下也只是需要横向滚动。
//
// 代价与边界（与 settings-models 补丁同）：DSH 升级会覆盖该包，需重新应用；
// 只改这一个包的 client 产物，不动 DSH 源码、不动其他包。
//
// 用法：
//   node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 与记录的产物 SHA 比对
//   node patch.mjs status            # 检查已安装 bundle 的补丁状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等：已打过则跳过）
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   通用参数：--target <client.js 路径>  覆盖自动探测
//
// 设计文档：../../../dsh-miasaki-canvas/design/2026-09-10-conversation-header-crowding-fix.md

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'client.original.js')

export const TARGET_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'
/** DSH 版本基线：锚点文本与原始 baseline 都取自这个版本。 */
export const BASELINE_DSH_VERSION = '0.1.5-rc.1'
/** 官方原版 client.js 的 SHA-256（与安装目录的 client.js.dsh-bak 逐字节一致）。 */
export const ORIGINAL_SHA256 = '81314DFD95864F2522F8EDB812E3F8E08B04A8EF2141913E6E8CBDAAE1FFC37F'
/**
 * 应用本补丁后的 SHA-256。
 *
 * 与 settings-models 补丁的差别：这里**不存 patched 全文**（目标 632KB，再存一份不划算），
 * 改存产物 SHA —— `verify` 用「由原始 baseline 重建后的 SHA 是否等于本常量」自证，
 * 与逐字节比对等价（SHA 相等即逐字节相等），锚点失配时仍会响亮报错。
 */
export const PATCHED_SHA256 = 'D9A841DE123218E7CAEF52B1B5016075E07967CE62F899832B7284380C99C198'
/** 补丁特征串：出现即视为已应用（用于幂等与状态判定）。 */
const PATCH_MARKER = '.wSkVaW_headerActions{flex:0 1 auto'

// ---------------------------------------------------------------------------
// 编辑规则。锚点是编译产物里的 CSS 片段原文（**不使用 hash 类名前缀做选择器**，
// 但锚点文本本身含类名 —— DSH 升级若改了 hash 前缀，锚点会失配并响亮报错，
// 这正是想要的行为：宁可失败，也不瞎改）。锚点必须全文件唯一。
// ---------------------------------------------------------------------------
const EDITS = [
  {
    id: 'header-actions-scrollable',
    mode: 'replaceSubstring',
    anchor: '.wSkVaW_headerActions{flex:none;align-items:center;gap:8px;display:flex}',
    replacement: '.wSkVaW_headerActions{flex:0 1 auto;min-width:0;align-items:center;gap:8px;display:flex;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}.wSkVaW_headerActions::-webkit-scrollbar{display:none}',
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

/** 判定一份 bundle 的状态：original / patched / unknown。 */
export function classify(text) {
  const sha = createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
  if (sha === ORIGINAL_SHA256) return { state: 'original', sha }
  if (text.includes(PATCH_MARKER)) return { state: 'patched', sha }
  return { state: 'unknown', sha }
}

/** 定位已安装的 client.js：环境变量 → npm 全局目录 → 常见 POSIX 路径。 */
function defaultTarget() {
  const candidates = []
  if (process.env.MIASAKI_DSH_CONVERSATION_BUNDLE) candidates.push(process.env.MIASAKI_DSH_CONVERSATION_BUNDLE)
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

/** verify：baseline 原始文件 → 重建 → 产物 SHA 必须等于记录的 PATCHED_SHA256。 */
async function cmdVerify() {
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  const rebuilt = applyPatch(original)
  const sha = createHash('sha256').update(rebuilt, 'utf8').digest('hex').toUpperCase()
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
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_CONVERSATION_BUNDLE）')
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
}

async function cmdApply(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_CONVERSATION_BUNDLE）')
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
  console.log('[patch] 提示   浏览器侧生效需刷新页面；若 DSH host 启动早于本次写入，client-hmr 会热推 rebuilt 帧')
}

async function cmdRevert(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_CONVERSATION_BUNDLE）')
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
