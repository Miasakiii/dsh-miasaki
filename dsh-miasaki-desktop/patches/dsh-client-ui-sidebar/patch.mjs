#!/usr/bin/env node
// DSH 侧边栏头部悬浮提示「被遮盖」修复运行时补丁。
//
// 背景：官方侧边栏（`@deepseek-ai/dsh-client-ui-sidebar`）头部各控件
//   （logo「新建会话」、侧边栏开关、折叠态「新会话」pill、面板行、以及
//   shell.leading 窗槽控件）的 Tooltip **都不带 portal** —— 气泡作为锚点的
//  兄弟节点渲染在侧边栏列内（logoRow 的 overflow:hidden 里），
//  靠 `position: fixed; z-index: 100` 越过祖先裁剪。但侧边栏列整体早于
//  中间列绘制，中间列（会话头 titleRow 的 `container-type: inline-size`
//  布局遏制 = 叠加上下文、tabs 行 z-index:1、以及窗口变窄时侧边栏
//  覆盖在被挤压的中间列之上）会把气泡**盖住/裁掉**：鼠标悬浮左上角
//  logo 想读「新建会话」提示，只看到气泡被切掉的一丝或整块不见
//  （2026-09-28 实机截图：深色气泡只剩左端 3px）。
//
// 本补丁只做一件事：给这个包的全部 6 处 Tooltip 加 `portal: true` ——
// 官方 primitives 为此提供的逃生通道：气泡改挂 document.body，
// z-index 升到 1100（`.bubble[data-portal]`），祖先的裁剪容器与叠加上下文
// 再也盖不住它。几何（side/align/fit 钳制）与内容完全不变，纯 DOM 挂点 +
// z-index 变化，不碰任何交互逻辑。
//
// 代价与边界（与其余补丁同）：DSH 升级会覆盖该包，需重新应用；
// 只改这一个包的 client 产物，不动 DSH 源码、不动其他包。
//   portal 气泡的 z-index(1100) 仍低于全屏浮层（设置 1001/模态 1000
// 之下……准确说：1100 > 1001，模态场景本就不该看到 tooltip，行为与官方
// 菜单层一致）；与 pet-panel 的瞬时 toast(2147483646) 相遇时 toast 在上，
// 但 toast 仅人格切换后 3.6s 可见，可接受。
//
// 用法：
//   node patch.mjs verify            # 离线自证：baseline 原始 → 重建 → 与记录的产物 SHA 比对 + 语法闸门
//   node patch.mjs status            # 检查已安装 bundle 的补丁状态与语法状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等：已打过则跳过）
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   通用参数：--target <client.js 路径>  覆盖自动探测
//
// 设计文档：../design/2026-09-28-sidebar-tooltip-portal.md

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'client.original.js')

export const TARGET_PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar'
/** DSH 版本基线：锚点文本与原始 baseline 都取自这个版本。 */
export const BASELINE_DSH_VERSION = '0.2.0-rc.1'
/** 官方原版 client.js 的 SHA-256（与安装目录的 client.js.dsh-bak 逐字节一致）。 */
export const ORIGINAL_SHA256 = '57C5C6AC6B74E7757CB545110D5C2C9881EFE4F6D2C5265944BF417EB27C690F'
/**
 * 应用本补丁后的 SHA-256。
 *
 * 与 conversation 补丁同：**不存 patched 全文**（6 处插入、产物靠重建自证），
 * verify 用「由原始 baseline 重建后的 SHA 是否等于本常量」自证。
 */
export const PATCHED_SHA256 = 'CE314B9691C23F53B94B3D665CE8F2D37BE4F7FB2DA665A7F3314D4BBDC2A6F6'
/** 补丁特征串：出现即视为已应用（用于幂等与状态判定）。 */
const PATCH_MARKER = '\t\t\t\t\t\t\t\tdelayMs: 500,\n\t\t\t\t\t\t\t\tportal: true,'

// ---------------------------------------------------------------------------
// 编辑规则。锚点是编译产物里的 JS 片段原文；锚点必须全文件唯一。
// 6 处 Tooltip 逐一加 `portal: true,`（保持原有缩进）。
// ---------------------------------------------------------------------------
const EDITS = [
  {
    // shell.leading 窗槽：侧边栏全隐时（macOS desktop）的打开侧边栏按钮
    id: 'leading-toggle-portal',
    anchor: [
      'label: t("toggle.open"),',
      '\t\t\t\t\tshortcutKeys: shortcut?.keys,',
      '\t\t\t\t\tdelayMs: 500,',
      '\t\t\t\t\tchildren:',
    ].join('\n'),
    replacement: [
      'label: t("toggle.open"),',
      '\t\t\t\t\tshortcutKeys: shortcut?.keys,',
      '\t\t\t\t\tdelayMs: 500,',
      '\t\t\t\t\tportal: true,',
      '\t\t\t\t\tchildren:',
    ].join('\n'),
  },
  {
    // shell.leading 窗槽：侧边栏全隐时的新建会话按钮
    id: 'leading-newsession-portal',
    anchor: [
      'label: t("session.new.label"),',
      '\t\t\t\t\tshortcutKeys: newShortcut?.keys,',
      '\t\t\t\t\tdelayMs: 500,',
      '\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {',
      '\t\t\t\t\t\ttype: "button",',
      '\t\t\t\t\t\tclassName: HeaderLeadingControls_module_css_default.iconButton,',
    ].join('\n'),
    replacement: [
      'label: t("session.new.label"),',
      '\t\t\t\t\tshortcutKeys: newShortcut?.keys,',
      '\t\t\t\t\tdelayMs: 500,',
      '\t\t\t\t\tportal: true,',
      '\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {',
      '\t\t\t\t\t\ttype: "button",',
      '\t\t\t\t\t\tclassName: HeaderLeadingControls_module_css_default.iconButton,',
    ].join('\n'),
  },
  {
    // 折叠轨道态的全局面板行（side 默认 right，同样会探入中间列）
    id: 'panel-row-portal',
    anchor: [
      'return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {',
      '\t\t\t\tlabel,',
      '\t\t\t\tdelayMs: 500,',
      '\t\t\t\tdisabled: wide,',
    ].join('\n'),
    replacement: [
      'return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {',
      '\t\t\t\tlabel,',
      '\t\t\t\tdelayMs: 500,',
      '\t\t\t\tportal: true,',
      '\t\t\t\tdisabled: wide,',
    ].join('\n'),
  },
  {
    // 侧边栏开关按钮（「收起/打开侧边栏」）
    id: 'sidebar-toggle-portal',
    anchor: [
      'label: toggleLabel,',
      '\t\t\t\tshortcutKeys: shortcut?.keys,',
      '\t\t\t\tdelayMs: 500,',
      '\t\t\t\tside: captionTooltipSide,',
    ].join('\n'),
    replacement: [
      'label: toggleLabel,',
      '\t\t\t\tshortcutKeys: shortcut?.keys,',
      '\t\t\t\tdelayMs: 500,',
      '\t\t\t\tportal: true,',
      '\t\t\t\tside: captionTooltipSide,',
    ].join('\n'),
  },
  {
    // **用户报告点**：左上角 logo 的「新建会话」tooltip（side 默认 right）
    id: 'sidebar-brand-portal',
    anchor: [
      'label: t("session.new.label"),',
      '\t\t\t\t\t\t\t\tshortcutKeys: newShortcut?.keys,',
      '\t\t\t\t\t\t\t\tdelayMs: 500,',
      '\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {',
    ].join('\n'),
    replacement: [
      'label: t("session.new.label"),',
      '\t\t\t\t\t\t\t\tshortcutKeys: newShortcut?.keys,',
      '\t\t\t\t\t\t\t\tdelayMs: 500,',
      '\t\t\t\t\t\t\t\tportal: true,',
      '\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {',
    ].join('\n'),
  },
  {
    // 展开态「新会话」pill（disabled:wide；折叠态启用）
    id: 'sidebar-newsession-portal',
    anchor: [
      'label: t("session.new.label"),',
      '\t\t\t\t\t\tshortcutKeys: newShortcut?.keys,',
      '\t\t\t\t\t\tdelayMs: 500,',
      '\t\t\t\t\t\tside: captionTooltipSide,',
      '\t\t\t\t\t\tdisabled: wide,',
    ].join('\n'),
    replacement: [
      'label: t("session.new.label"),',
      '\t\t\t\t\t\tshortcutKeys: newShortcut?.keys,',
      '\t\t\t\t\t\tdelayMs: 500,',
      '\t\t\t\t\t\tportal: true,',
      '\t\t\t\t\t\tside: captionTooltipSide,',
      '\t\t\t\t\t\tdisabled: wide,',
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
  if (process.env.MIASAKI_DSH_SIDEBAR_BUNDLE) candidates.push(process.env.MIASAKI_DSH_SIDEBAR_BUNDLE)
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
    for (const edit of EDITS) {
      const at = rebuilt.indexOf(edit.replacement.slice(0, 48))
      if (at >= 0) console.error(`  ${edit.id} 产物片段: ${rebuilt.slice(at, at + 120)}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`[patch] PASS 由 baseline 原始文件重建出与记录一致的补丁产物（${EDITS.length} 条编辑，SHA-256 ${sha.slice(0, 16)}…）；两侧语法闸门通过`)
}

async function cmdStatus(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_SIDEBAR_BUNDLE）')
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
    console.log('[patch] 提示   该文件既非 0.1.7-rc.2 原版也非补丁版——DSH 很可能已升级，需先核对锚点再适配')
  }
}

async function cmdApply(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_SIDEBAR_BUNDLE）')
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
  console.log('[patch] 提示   浏览器侧生效需刷新页面；若 DSH host 启动早于本次写入，client-hmr 会热推 rebuilt 帧')
}

async function cmdRevert(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_SIDEBAR_BUNDLE）')
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
