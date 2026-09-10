#!/usr/bin/env node
// DSH 「双模型图片准入」运行时补丁 —— 让插件声明的图片执行路由参与准入判定。
//
// 背景：DSH 的 `session.prompt` 在提交带图消息时，按「当前会话模型是否声明支持图片」
// 硬拒整条消息（`dsh-api-session-controller/lib/index.js`）。该判定是 host 私有的，
// 没有任何插件可挂的 waterfall，因此「主模型 + 辅助模型」无法在不改本体的情况下
// 让图片进入官方管道。本补丁把该判定**委托**给一个可选服务：
//
//   ctx.get("dualModelVisionRoute")  →  { for(agent) -> {provider, model} | undefined }
//
// 关键性质 —— 未装插件时零退化：
//   服务不存在（undefined）时，补丁走**与原生逐字相同**的分支（含错误信息）；
//   只有 `@miasaki/dsh-dual-model` 提供了该服务，准入才按「主 OR 辅任一支持图片」放宽。
//   因此本补丁是**纯可选依赖**，装/卸插件都自然，裸 DSH 行为与打补丁前完全一致。
//
// 代价：**DSH 升级会覆盖该包，升级后需重新应用**。这正是本脚本入库的原因 ——
// 补丁规则与基线进版本控制，升级后能重建、能校验、能回退，而不是依赖某台机器上的
// 一次性产物。
//
// 补丁形态：行导向的锚点编辑，锚点在源文件里必须唯一（否则报错而非瞎改）。
// 本补丁只有 1 条编辑（replaceRange，替换 2 行）。见 EDITS。
//
// 用法：
//   node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 与 baseline 产物逐字节比对
//   node patch.mjs status            # 检查已安装 bundle 的补丁状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等：已打过则跳过）
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   node patch.mjs seal              # 由 baseline 原始文件重生成 baseline 产物并打印其 SHA-256
//   通用参数：--target <index.js 路径>  覆盖自动探测
//
// 设计文档：../../design/2026-09-10-dual-model-design.md §3.4

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'index.original.js')
const PATCHED_FILE = join(BASELINE, 'index.patched.js')

export const TARGET_PACKAGE = '@deepseek-ai/dsh-api-session-controller'
/** DSH 版本基线：锚点文本与两份 baseline 都取自这个版本。 */
export const BASELINE_DSH_VERSION = '0.1.5-rc.1'
/** 官方原版 index.js 的 SHA-256（与安装目录的 index.js.dsh-bak 逐字节一致）。 */
export const ORIGINAL_SHA256 = '16ECB48F33996EFE72868F1603223214430634C5AC4C3E8FE9060BF240E990FF'
/** 应用本补丁后的 SHA-256（由 `seal` 生成并回填）。 */
export const PATCHED_SHA256 = '58574E8A9BA2C31423250D1ED5FAF5503B54C973D62743EE8B10EFBC3034A930'
/** 补丁特征串：出现即视为已应用（用于幂等与状态判定）。 */
const PATCH_MARKER = 'dualModelVisionRoute'

// ---------------------------------------------------------------------------
// 编辑规则（1 条）。
//
// 被替换的两行（原生）：
//   const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
//   if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) throw ...
//
// 替换为三分支结构：无路由 → 原生分支（逐字保留，含错误信息）；有路由 → union 语义。
// `expect` 断言被替换的每一行（trim 后全等），防止 DSH 改版后改错层级。
// ---------------------------------------------------------------------------
const EDITS = [
  {
    id: 'vision-route-admission',
    mode: 'replaceRange',
    anchor: 'const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);',
    count: 2,
    expect: [
      'const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);',
      'if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) throw new RemoteError("session/attachment-invalid", `Model "${current.model}" does not support image input.`, { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });',
    ],
    lines: [
      '\t\t\t\t\t\tconst visionRoute = this.ctx.get("dualModelVisionRoute");',
      '\t\t\t\t\t\tconst routed = visionRoute === void 0 ? void 0 : visionRoute.for(agent);',
      '\t\t\t\t\t\tif (routed === void 0) {',
      '\t\t\t\t\t\t\tconst model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);',
      '\t\t\t\t\t\t\tif (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) throw new RemoteError("session/attachment-invalid", `Model "${current.model}" does not support image input.`, { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });',
      '\t\t\t\t\t\t} else {',
      '\t\t\t\t\t\t\tconst assist = await this.ctx.llm.resolveModelInfo(routed.provider, routed.model);',
      '\t\t\t\t\t\t\tif (assist.inputModalities !== void 0 && !assist.inputModalities.includes("image")) {',
      '\t\t\t\t\t\t\t\tconst model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);',
      '\t\t\t\t\t\t\t\tif (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) throw new RemoteError("session/attachment-invalid", `Neither "${current.model}" nor "${routed.model}" supports image input.`, { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });',
      '\t\t\t\t\t\t\t}',
      '\t\t\t\t\t\t}',
    ],
  },
]

/** 定位唯一的锚点行；不唯一即报错（宁可失败，也不瞎改）。 */
function findUnique(lines, anchor) {
  const hits = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i].trim() === anchor) hits.push(i)
  if (hits.length !== 1) throw new Error(`锚点必须唯一：${anchor}（命中 ${hits.length} 次）`)
  return hits[0]
}

/**
 * 把补丁应用到一份 bundle 文本上，返回新文本。
 * 纯函数：不碰文件系统，便于 `verify` 与单测直接调用。
 */
export function applyPatch(source) {
  if (source.includes(PATCH_MARKER)) throw new Error('该文件已包含补丁标记，拒绝重复应用')
  const lines = source.split('\n')
  for (const edit of EDITS) {
    const at = findUnique(lines, edit.anchor)
    if (Array.isArray(edit.expect)) {
      for (let k = 0; k < edit.expect.length; k += 1) {
        const actual = lines[at + k] === undefined ? null : lines[at + k].trim()
        if (actual !== edit.expect[k]) {
          throw new Error(`${edit.id}: 期望锚点 +${k} 行为 ${JSON.stringify(edit.expect[k])}，实际 ${JSON.stringify(actual)}`)
        }
      }
    }
    if (edit.mode === 'replaceRange') {
      lines.splice(at, edit.count ?? edit.expect.length, ...edit.lines)
    } else {
      throw new Error(`${edit.id}: 未知的编辑模式 ${edit.mode}`)
    }
  }
  return lines.join('\n')
}

/** 判定一份 bundle 的状态：original / patched / unknown。 */
export function classify(text) {
  const sha = createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
  if (sha === ORIGINAL_SHA256) return { state: 'original', sha }
  if (text.includes(PATCH_MARKER)) return { state: 'patched', sha }
  return { state: 'unknown', sha }
}

/** 定位已安装的 index.js：环境变量 → npm 全局目录 → 常见 POSIX 路径。 */
function defaultTarget() {
  const candidates = []
  if (process.env.MIASAKI_DSH_CONTROLLER) candidates.push(process.env.MIASAKI_DSH_CONTROLLER)
  const rel = join('@deepseek-ai', 'dsh', 'node_modules', TARGET_PACKAGE, 'lib', 'index.js')
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

/** verify：baseline 原始文件 → 重建 → 与 baseline 产物逐字节比对。 */
async function cmdVerify() {
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  const patched = await readFile(PATCHED_FILE, 'utf8')
  const rebuilt = applyPatch(original)
  const sha = createHash('sha256').update(rebuilt, 'utf8').digest('hex').toUpperCase()
  if (rebuilt !== patched) {
    console.error('[patch] FAIL 重建结果与 baseline 产物不一致')
    console.error(`  重建 SHA-256: ${sha}`)
    console.error(`  baseline     : ${createHash('sha256').update(patched, 'utf8').digest('hex').toUpperCase()}`)
    console.error(`  长度 重建=${Buffer.byteLength(rebuilt, 'utf8')} baseline=${Buffer.byteLength(patched, 'utf8')}`)
    process.exitCode = 1
    return
  }
  if (PATCHED_SHA256 !== 'PENDING_SEAL' && PATCHED_SHA256 !== sha) {
    console.error(`[patch] FAIL 重建结果与 PATCHED_SHA256 常量不一致（常量 ${PATCHED_SHA256}，实测 ${sha}）`)
    process.exitCode = 1
    return
  }
  console.log(`[patch] PASS 由 baseline 原始文件重建出逐字节一致的补丁产物（${EDITS.length} 条编辑，SHA-256 ${sha.slice(0, 16)}…）`)
}

/** seal：由原始文件重生成 baseline 产物（升级后重新适配时使用）。 */
async function cmdSeal() {
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  const rebuilt = applyPatch(original)
  await writeFile(PATCHED_FILE, rebuilt, 'utf8')
  const sha = createHash('sha256').update(rebuilt, 'utf8').digest('hex').toUpperCase()
  console.log(`[patch] 已封基线产物 → ${PATCHED_FILE}`)
  console.log(`[patch] PATCHED_SHA256 = '${sha}'   ← 请回填到 patch.mjs`)
}

async function cmdStatus(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 index.js（用 --target 指定，或设 MIASAKI_DSH_CONTROLLER）')
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
    console.error('[patch] 未找到已安装的 index.js（用 --target 指定，或设 MIASAKI_DSH_CONTROLLER）')
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
  console.log(`[patch] 结果   ${Buffer.byteLength(patched, 'utf8')} 字节，SHA-256 ${sha.slice(0, 16)}…${sha === PATCHED_SHA256 ? '（与 baseline 产物一致）' : ''}`)
  console.log('[patch] 提示   host 需重启 dsh web 才加载新 bundle')
}

async function cmdRevert(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 index.js（用 --target 指定，或设 MIASAKI_DSH_CONTROLLER）')
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
  const commands = { verify: cmdVerify, status: cmdStatus, apply: cmdApply, revert: cmdRevert, seal: cmdSeal }
  const command = commands[args.mode]
  if (command === undefined) {
    console.error(`[patch] 未知模式：${args.mode}（可选 verify / status / apply / revert / seal）`)
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
