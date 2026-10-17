#!/usr/bin/env
// DSH 官方品牌徽标 → miasaki 部署品牌名运行时补丁。
//
// 背景：侧边栏品牌行由两个 slot 组成 —— `sidebar.brand.mark`（官方
//   FishLogo 鲸鱼）与 `sidebar.brand.name`。后者由官方插件
//   `@deepseek-ai/dsh-client-ui-brand-official` 填充，渲染
//   BrandWordmark{ includeMark:false }：deepseek 字标（8 个转曲 path）+
//   黑胶囊徽标「HARNESS」（rect 胶囊 x=129.348 y=5.5 w=52 h=14 rx=2，
//   7 个转曲字母，反色 token --dsw-alias-label-primary-inverted），
//   徽标区 viewBox "26 0 156 24"、宽 size*156/24。
//
// 本补丁把 `sidebar.brand.name` 的 occupant 换成部署自有实现
//   DshMiasakiBrandName：**「DSH」字标 + 黑胶囊「MIASAKI」**（用户
//   2026-10-12 点名形态）。鲸鱼 mark（`sidebar.brand.mark` 的 FishLogo）
//   不动，故左上角读作「鲸鱼 + DSH + MIASAKI 徽标」。slot 声明见
//   dsh-client-ui-sidebar（single slot，后注册的 occupant 胜出）；本补丁走
//   「改 occupant 实现」而非再写一个注册插件，与其余本体补丁同属
//   「不新增 profile 装载」路线。
//
// 几何（全部量出来的，不是估的）：
//   字标 —— Segoe UI 700 / 20px 的「DSH」：cap 高 14.00、advance 41.279、
//     ink 1.000→39.957 用户单位；官方字标 ink 为 y 4.628→18.622（高 13.99）
//     ⇒ 基线取 18.62（ink 底对齐）、字号取 20（cap 高与官方字标逐值等高）。
//   胶囊 —— 官方 HARNESS 徽标的 rect 几何原样搬用（x/宽 52/高 14/y 5.5/
//     圆角 2 + 反色文字 token），内文换成 MIASAKI（<text> 居中，
//     text-anchor:middle 落在胶囊中心 —— 不依赖字体 advance 的估算）。
//   横向排布 —— 复刻官方的「字标 ink 右 → 胶囊左」间距：官方
//     x 121.517 → 129.348 = 7.831 ⇒ 胶囊左 = 39.957 + 7.831 = 47.788；
//     右侧余量取官方同值 0.652 ⇒ viewBox 宽 100.44、胶囊中心 73.788。
//
// 历史（三版）：2026-09-28 首版 HARNESS → MIASAKI（deepseek 字标保留）；
//   2026-10-12 改「整块 DSH」；2026-10-12 晚按用户「DSH 字标加黑胶囊
//   MIASAKI」改为当前形态。两个历史形态都由 classify 识别为 legacy，
//   apply 可直接覆盖升级（并把「上一版产物」另存 .dsh-prev-bak 留档）。
//
// 代价与边界（与其余补丁同）：DSH 升级会覆盖该包，需重新应用；
// 只改这一个包的 client 产物，不动 DSH 源码、不动其他包。
//   BrandWordmark 全局仅本包一处在用，补丁影响面 = 仅侧边栏品牌名；
//   会话主视觉的鱼是声明包自带 animated fallback，不受影响。
//
// 用法：
//   node patch.mjs verify            # 离线自证：baseline 原始 → 重建 → 与记录的产物 SHA 比对 + 语法闸门
//   node patch.mjs status            # 检查已安装 bundle 的补丁状态与语法状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等：已打过则跳过；历史形态可直接升级）
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   通用参数：--target <client.js 路径>  覆盖自动探测
//
// 设计文档：../../design/2026-09-28-miasaki-brand-wordmark.md

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'client.original.js')

export const TARGET_PACKAGE = '@deepseek-ai/dsh-client-ui-brand-official'
/** DSH 版本基线：锚点文本与原始 baseline 都取自这个版本。 */
export const BASELINE_DSH_VERSION = '0.2.1-rc.2'
/** 官方原版 client.js 的 SHA-256（1863 B，与安装目录当前文件一致）。 */
export const ORIGINAL_SHA256 = '22BB7E181A8D93372E1D14927B201612B09A02C84EA3D0F36933CFFF1DE47D71'
/**
 * 应用本补丁后的 SHA-256（DSH 字标 + 黑胶囊 MIASAKI 版）。
 *
 * 与 sidebar 补丁同：**不存 patched 全文**（产物靠重建自证），
 * verify 用「由原始 baseline 重建后的 SHA 是否等于本常量」自证。
 */
export const PATCHED_SHA256 = '250CAF785F449B9C8D8D9728A562B3163A37372C4031A3C24FB41EFA518B725D'
/** 补丁特征串：出现即视为已应用（用于幂等与状态判定）。 */
const PATCH_MARKER = 'return (0, react_jsx_runtime.jsx)(DshMiasakiBrandName, {});'
/**
 * 历史补丁产物特征串（两种形态）：
 *   ① 2026-09-28–2026-10-12：「deepseek 字标 + 黑胶囊 MIASAKI」；
 *   ② 2026-10-12 白天：「整块 DSH」。
 * 识别它们只为让 `apply` 能直接升级（否则会被当成 unknown 而要求 --yes）。
 */
const LEGACY_PATCH_MARKERS = [
  'const MIASAKI_WORDMARK_LETTERS = [',
  'const DSH_BRAND_VIEWBOX_WIDTH',
]

// ---------------------------------------------------------------------------
// 编辑规则。锚点是编译产物里的 JS 片段原文；锚点必须全文件唯一。
// 两条编辑：①在 Brand.js region 末尾插入部署组件 DshMiasakiBrandName；
// ②OfficialBrandName 的返回改成渲染该组件。
// ---------------------------------------------------------------------------
const EDITS = [
  {
    id: 'dsh-miasaki-brand-name-component',
    anchor: [
      '\t\t//#endregion',
      '\t\t//#region lib/types/client/index.js',
    ].join('\n'),
    replacement: [
      '\t\t//#endregion',
      '\t\t// miasaki 部署品牌：**「DSH」字标 + 黑胶囊「MIASAKI」**（用户点名形态）。',
      '\t\t// 字标 = Segoe UI 700 / 20px 的 DSH：cap 高 14.00 与官方字标 ink',
      '\t\t//（y 4.628→18.622，高 13.99）逐值等高，基线 18.62 与官方 ink 底对齐。',
      '\t\t// 胶囊 = 官方 HARNESS 徽标的 rect 几何原样（宽 52 / 高 14 / y 5.5 / rx 2，',
      '\t\t// 反色文字 token），内文换成 MIASAKI 并居中。',
      '\t\t// 排布复刻官方「字标 ink 右 121.517 → 胶囊左 129.348」的间距 7.831',
      '\t\t// ⇒ 胶囊左 = 39.957 + 7.831 = 47.788；右侧余量同官方 0.652',
      '\t\t// ⇒ viewBox 宽 100.44、胶囊中心 47.788 + 26 = 73.788。',
      '\t\tconst DSH_MIASAKI_VIEWBOX_WIDTH = 100.44;',
      '\t\tconst DSH_MIASAKI_CAPSULE_X = 47.788;',
      '\t\tconst DSH_MIASAKI_LABEL_X = 73.788;',
      '\t\t/**',
      '\t\t* Render the DSH wordmark followed by the black MIASAKI badge.',
      '\t\t* @param props - Host-supplied presentation (size, className), same contract as the official wordmark.',
      '\t\t* @returns the DSH + MIASAKI wordmark svg.',
      '\t\t*/',
      '\t\tfunction DshMiasakiBrandName({ size = 24, className }) {',
      '\t\t\treturn (0, react_jsx_runtime.jsxs)("svg", {',
      '\t\t\t\twidth: size * DSH_MIASAKI_VIEWBOX_WIDTH / 24,',
      '\t\t\t\theight: size,',
      '\t\t\t\tclassName,',
      '\t\t\t\tviewBox: `0 0 ${DSH_MIASAKI_VIEWBOX_WIDTH} 24`,',
      '\t\t\t\tfill: "none",',
      '\t\t\t\t"aria-hidden": "true",',
      '\t\t\t\tchildren: [',
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("text", {',
      '\t\t\t\t\t\tx: "0",',
      '\t\t\t\t\t\ty: "18.62",',
      '\t\t\t\t\t\tfill: "currentColor",',
      '\t\t\t\t\t\tfontSize: "20",',
      '\t\t\t\t\t\tfontWeight: "700",',
      '\t\t\t\t\t\tletterSpacing: "0",',
      '\t\t\t\t\t\tfontFamily: "\'Segoe UI\', system-ui, sans-serif",',
      '\t\t\t\t\t\tchildren: "DSH"',
      '\t\t\t\t\t}),',
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("rect", {',
      '\t\t\t\t\t\tx: DSH_MIASAKI_CAPSULE_X,',
      '\t\t\t\t\t\ty: "5.5",',
      '\t\t\t\t\t\twidth: "52",',
      '\t\t\t\t\t\theight: "14",',
      '\t\t\t\t\t\trx: "2",',
      '\t\t\t\t\t\tfill: "currentColor"',
      '\t\t\t\t\t}),',
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("text", {',
      '\t\t\t\t\t\tx: DSH_MIASAKI_LABEL_X,',
      '\t\t\t\t\t\ty: "15",',
      '\t\t\t\t\t\ttextAnchor: "middle",',
      '\t\t\t\t\t\tfill: "var(--dsw-alias-label-primary-inverted)",',
      '\t\t\t\t\t\tfontSize: "7.4",',
      '\t\t\t\t\t\tfontWeight: "700",',
      '\t\t\t\t\t\tletterSpacing: "0.2",',
      '\t\t\t\t\t\tfontFamily: "\'Segoe UI\', system-ui, sans-serif",',
      '\t\t\t\t\t\tchildren: "MIASAKI"',
      '\t\t\t\t\t})',
      '\t\t\t\t]',
      '\t\t\t});',
      '\t\t}',
      '\t\t//#endregion',
      '\t\t//#region lib/types/client/index.js',
    ].join('\n'),
  },
  {
    id: 'dsh-miasaki-brand-name-usage',
    anchor: [
      '\t\tfunction OfficialBrandName() {',
      '\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.BrandWordmark, { includeMark: false });',
      '\t\t}',
    ].join('\n'),
    replacement: [
      '\t\tfunction OfficialBrandName() {',
      '\t\t\treturn (0, react_jsx_runtime.jsx)(DshMiasakiBrandName, {});',
      '\t\t}',
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

/** 判定一份 bundle 的状态：original / patched / legacy / unknown。 */
export function classify(text) {
  const sha = sha256(text)
  if (sha === ORIGINAL_SHA256) return { state: 'original', sha }
  if (text.includes(PATCH_MARKER)) return { state: 'patched', sha }
  if (LEGACY_PATCH_MARKERS.some(marker => text.includes(marker))) return { state: 'legacy', sha }
  return { state: 'unknown', sha }
}

/** 定位已安装的 client.js：环境变量 → npm 全局目录 → 常见 POSIX 路径。 */
function defaultTarget() {
  const candidates = []
  if (process.env.MIASAKI_DSH_BRAND_OFFICIAL_BUNDLE) candidates.push(process.env.MIASAKI_DSH_BRAND_OFFICIAL_BUNDLE)
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
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_BRAND_OFFICIAL_BUNDLE）')
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
  if (state === 'legacy') {
    const which = text.includes(LEGACY_PATCH_MARKERS[0]) ? '2026-09-28 版（deepseek 字标 + 胶囊 MIASAKI）' : '2026-10-12 版（整块 DSH）'
    console.log(`[patch] 提示   这是${which}产物；apply 可原地升级为当前形态（DSH 字标 + 胶囊 MIASAKI，无需 --yes）`)
  }
  if (state === 'unknown') {
    console.log('[patch] 提示   该文件既非登记的原版也非本补丁产物——DSH 很可能已升级，需先核对锚点再适配')
  }
}

async function cmdApply(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_BRAND_OFFICIAL_BUNDLE）')
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
  // 写入内容一律取「由仓库 baseline 重建」的产物，**不**对目标就地打补丁：
  // 历史形态产物的锚点与官方原版不同 —— 它们的 OfficialBrandName 已指向
  // MIASAKI_WORDMARK/DshBrandName，对它就地去匹配原版锚点必然命中 0 次
  //（2026-10-12 实测踩到，见 design/CHANGELOG.md）。重建路径写的是**逐字节
  // 确定的内容**（两侧 SHA 自证），同时消掉「目标被第三方手改过」的风险。
  // `original` 状态下目标与 baseline 逐字节相同（SHA 相等），故两种路径一致。
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  const originalSha = sha256(original)
  if (originalSha !== ORIGINAL_SHA256) {
    console.error(`[patch] 拒绝写入：仓库 baseline 与登记 SHA 不符（${originalSha.slice(0, 16)}…）`)
    process.exitCode = 1
    return
  }
  const patched = applyPatch(original)
  const verdict = parseVerdict(patched)
  if (verdict !== null) {
    console.error(`[patch] 拒绝写入：产物语法非法 —— ${verdict}`)
    process.exitCode = 1
    return
  }
  const patchedSha = sha256(patched)
  if (patchedSha !== PATCHED_SHA256) {
    console.error(`[patch] 拒绝写入：重建产物 SHA 与登记不符（${patchedSha.slice(0, 16)}…）`)
    process.exitCode = 1
    return
  }
  if (state === 'legacy') {
    // 两个历史形态各留一份：.dsh-legacy-bak = 最老的（胶囊 MIASAKI）版，
    // .dsh-prev-bak = 上一个（整块 DSH）版。已存在则不覆盖（首次留档为准）。
    const legacyBackup = `${target}.dsh-legacy-bak`
    const prevBackup = `${target}.dsh-prev-bak`
    if (!existsSync(legacyBackup)) {
      await copyFile(target, legacyBackup)
      console.log(`[patch] 历史产物已留档 → ${legacyBackup}`)
    } else if (!existsSync(prevBackup)) {
      await copyFile(target, prevBackup)
      console.log(`[patch] 上一版产物已留档 → ${prevBackup}`)
    }
  }
  const backup = `${target}.dsh-bak`
  if (!existsSync(backup)) await copyFile(target, backup)
  await writeFile(target, patched, 'utf8')
  console.log(`[patch] 已应用 → ${target}`)
  console.log(`[patch] 备份   ${backup}`)
  console.log(`[patch] 结果   ${Buffer.byteLength(patched, 'utf8')} 字节，SHA-256 ${patchedSha.slice(0, 16)}…（与记录一致）`)
  console.log('[patch] 提示   浏览器侧生效需刷新页面；若 DSH host 启动早于本次写入，client-hmr 会热推 rebuilt 帧')
}

async function cmdRevert(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_BRAND_OFFICIAL_BUNDLE）')
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
