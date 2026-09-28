#!/usr/bin/env
// DSH 官方品牌徽标 HARNESS → miasaki 部署品牌名运行时补丁。
//
// 背景：侧边栏品牌行由两个 slot 组成 —— `sidebar.brand.mark`（官方
//   FishLogo 鲸鱼）与 `sidebar.brand.name`。后者由官方插件
//   `@deepseek-ai/dsh-client-ui-brand-official` 填充，渲染
//   BrandWordmark{ includeMark:false }：deepseek 字标 + 黑胶囊徽标
//   「HARNESS」（7 个转曲 path + rect 胶囊底，官方徽标区 viewBox
//   "26 0 156 24"，胶囊 rect x=129.348 y=5.5 w=52 h=14 rx=2，
//   字母取反色 token --dsw-alias-label-primary-inverted）。
//
// 本补丁把 `sidebar.brand.name` 的 occupant 换成部署自有实现
//   MiasakiBrandName：deepseek 字标 8 个 path 与官方逐字节一致
//   （视觉不变），胶囊内徽标 HARNESS → MIASAKI（SVG <text>，
//   黑底 rect 几何不变、取官方同款反色 token）。鲸鱼 mark 不动。
//   slot 声明见 dsh-client-ui-sidebar（single slot，后注册的
//   occupant 胜出）；本补丁走「改 occupant 实现」而非再写一个
//   注册插件，与既有七个本体补丁同属「不新增 profile 装载」路线。
//
// 代价与边界（与其余补丁同）：DSH 升级会覆盖该包，需重新应用；
// 只改这一个包的 client 产物，不动 DSH 源码、不动其他包。
//   BrandWordmark 全局仅本包一处在用，补丁影响面 = 仅侧边栏品牌名；
//   会话主视觉的鱼是声明包自带 animated fallback，不受影响。
//
// 用法：
//   node patch.mjs verify            # 离线自证：baseline 原始 → 重建 → 与记录的产物 SHA 比对 + 语法闸门
//   node patch.mjs status            # 检查已安装 bundle 的补丁状态与语法状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等：已打过则跳过）
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
export const BASELINE_DSH_VERSION = '0.2.0-rc.1'
/** 官方原版 client.js 的 SHA-256（1863 B，与安装目录当前文件一致）。 */
export const ORIGINAL_SHA256 = '22BB7E181A8D93372E1D14927B201612B09A02C84EA3D0F36933CFFF1DE47D71'
/**
 * 应用本补丁后的 SHA-256。
 *
 * 与 sidebar 补丁同：**不存 patched 全文**（产物靠重建自证），
 * verify 用「由原始 baseline 重建后的 SHA 是否等于本常量」自证。
 */
export const PATCHED_SHA256 = '821DD9B3CA7AA6E0C16493033D47E39A9DB5EEC099B62E5730A4A6C601660F3F'
/** 补丁特征串：出现即视为已应用（用于幂等与状态判定）。 */
const PATCH_MARKER = 'return (0, react_jsx_runtime.jsx)(MiasakiBrandName, {});'

// ---------------------------------------------------------------------------
// 编辑规则。锚点是编译产物里的 JS 片段原文；锚点必须全文件唯一。
// 两条编辑：①在 Brand.js region 末尾插入部署组件 MiasakiBrandName；
// ②OfficialBrandName 的返回改成渲染该组件。
// ---------------------------------------------------------------------------
const EDITS = [
  {
    id: 'miasaki-brand-name-component',
    anchor: [
      '\t\t//#endregion',
      '\t\t//#region lib/types/client/index.js',
    ].join('\n'),
    replacement: [
      '\t\t//#endregion',
      '\t\t// miasaki 部署品牌：deepseek 字标（与官方 BrandWordmark 的字母 path',
      '\t\t// 逐字节一致）+ 黑胶囊「MIASAKI」替换官方「HARNESS」徽标。',
      '\t\tconst MIASAKI_WORDMARK_LETTERS = [',
      '\t\t\t"M68.416 18.2447H67.0501V16.1272H68.416C69.2619 16.1272 70.1166 15.9163 70.6671 15.3304C71.2181 14.7444 71.426 13.8455 71.426 12.9471C71.426 12.0487 71.2268 11.1498 70.6671 10.5643C70.1083 9.97831 69.2619 9.76744 68.416 9.76744C67.5701 9.76744 66.7154 9.97831 66.1639 10.5643C65.6129 11.1503 65.4049 12.0487 65.4049 12.9471V21.6435H63.009V7.6582H65.4049V8.54883H65.8442C65.8918 8.49393 65.9394 8.44728 65.9875 8.40064C66.5871 7.85353 67.5049 7.6582 68.4072 7.6582C69.8212 7.6582 71.2341 8.00998 72.1607 8.98662C73.0868 9.96325 73.4143 11.4632 73.4143 12.9558C73.4143 14.4485 73.0785 15.9406 72.1607 16.925C71.2424 17.9094 69.8212 18.2457 68.416 18.2457V18.2447Z",',
      '\t\t\t"M31.9551 8.03497H33.3204V10.1525H31.9551C31.1087 10.1525 30.2545 10.3633 29.7035 10.9493C29.1525 11.5353 28.945 12.4342 28.945 13.3326C28.945 14.231 29.1447 15.1294 29.7035 15.7154C30.2623 16.3014 31.1087 16.5122 31.9551 16.5122C32.8015 16.5122 33.6562 16.3014 34.2072 15.7154C34.7582 15.1294 34.9657 14.231 34.9657 13.3326V4.62842H37.3611V18.6219H34.9657V17.7313H34.5264C34.4783 17.7857 34.4307 17.8329 34.3826 17.8795C33.7835 18.4261 32.8652 18.6219 31.9629 18.6219C30.5494 18.6219 29.136 18.2707 28.2099 17.294C27.2838 16.3174 26.9563 14.817 26.9563 13.3248C26.9563 11.8327 27.2916 10.34 28.2099 9.35561C29.136 8.37898 30.5494 8.03497 31.9551 8.03497Z",',
      '\t\t\t"M49.3786 13.1431V13.9948H42.9984V12.2996H47.2305C47.1348 11.6825 46.9113 11.1043 46.5119 10.682C45.9371 10.0727 45.0503 9.85409 44.1723 9.85409C43.2943 9.85409 42.4076 10.0727 41.8328 10.682C41.258 11.2913 41.05 12.2213 41.05 13.1435C41.05 14.0658 41.2575 15.003 41.8328 15.6046C42.4076 16.2061 43.2939 16.433 44.1723 16.433C45.0508 16.433 45.9371 16.2143 46.5119 15.6046C46.5916 15.5186 46.6635 15.4248 46.7354 15.331H49.0992C48.8918 16.0657 48.5643 16.7299 48.0691 17.2454C47.111 18.2531 45.6339 18.6205 44.1723 18.6205C42.7108 18.6205 41.2337 18.2609 40.2755 17.2454C39.3174 16.2299 38.9661 14.6828 38.9661 13.1435C38.9661 11.6043 39.3096 10.0494 40.2755 9.04168C41.242 8.03396 42.7108 7.66663 44.1723 7.66663C45.6339 7.66663 47.111 8.02618 48.0691 9.04168C49.0351 10.0572 49.3786 11.6043 49.3786 13.1435V13.1431Z",',
      '\t\t\t"M61.4045 13.1431V13.9948H55.0243V12.2996H59.2564C59.1602 11.6825 58.9372 11.1043 58.5378 10.682C57.963 10.0727 57.0762 9.85409 56.1982 9.85409C55.3202 9.85409 54.4335 10.0727 53.8587 10.682C53.2839 11.2913 53.0759 12.2213 53.0759 13.1435C53.0759 14.0658 53.2834 15.003 53.8587 15.6046C54.4335 16.2061 55.3202 16.433 56.1982 16.433C57.0762 16.433 57.963 16.2143 58.5378 15.6046C58.6179 15.5186 58.6894 15.4248 58.7608 15.331H61.1251C60.9171 16.0657 60.5897 16.7299 60.0945 17.2454C59.1364 18.2531 57.6593 18.6205 56.1982 18.6205C54.7372 18.6205 53.2596 18.2609 52.3014 17.2454C51.3432 16.2299 50.9919 14.6828 50.9919 13.1435C50.9919 11.6043 51.3355 10.0494 52.3014 9.04168C53.2678 8.03396 54.7367 7.66663 56.1982 7.66663C57.6598 7.66663 59.1364 8.02618 60.0945 9.04168C61.061 10.0572 61.4045 11.6043 61.4045 13.1435V13.1431Z",',
      '\t\t\t"M80.242 18.6214C81.7035 18.6214 83.1801 18.4105 84.1383 17.809C85.0965 17.2075 85.4482 16.2931 85.4482 15.3869C85.4482 14.4807 85.1042 13.5585 84.1383 12.9647C83.1801 12.371 81.703 12.1518 80.242 12.1518C79.6186 12.1518 79.0438 12.0658 78.6366 11.8394C78.2294 11.6047 78.0778 11.2534 78.0778 10.9017C78.0778 10.5499 78.2216 10.1908 78.6366 9.9639C79.0438 9.72921 79.6749 9.65147 80.2973 9.65147C80.9198 9.65147 81.5509 9.73747 81.9591 9.9639C82.3663 10.1986 82.5179 10.5499 82.5179 10.9017H84.9531C84.9531 9.99499 84.6421 9.07327 83.7719 8.47951C82.9017 7.88576 81.5679 7.66663 80.2424 7.66663C78.9169 7.66663 77.5837 7.8775 76.713 8.47951C75.8427 9.08104 75.5308 9.99499 75.5308 10.9017C75.5308 11.8083 75.8423 12.73 76.713 13.3238C77.5832 13.9176 78.9165 14.1367 80.2424 14.1367C80.929 14.1367 81.688 14.2227 82.1428 14.4491C82.5985 14.676 82.7579 15.0351 82.7579 15.3869C82.7579 15.7387 82.5985 16.0977 82.1428 16.3246C81.688 16.5511 80.9931 16.6371 80.3066 16.6371C79.62 16.6371 78.9169 16.5511 78.4694 16.3246C78.0224 16.0982 77.8543 15.7387 77.8543 15.3869H75.0435C75.0435 16.2935 75.3865 17.2153 76.3534 17.809C77.3194 18.4028 78.7809 18.6214 80.2424 18.6214H80.242Z",',
      '\t\t\t"M97.4733 13.1431V13.9948H91.0932V12.2996H95.3252C95.23 11.6825 95.006 11.1043 94.6071 10.682C94.0313 10.0727 93.1456 9.85409 92.2666 9.85409C91.3876 9.85409 90.5018 10.0727 89.927 10.682C89.3522 11.2913 89.1452 12.2213 89.1452 13.1435C89.1452 14.0658 89.3522 15.003 89.927 15.6046C90.5018 16.2061 91.3886 16.433 92.2666 16.433C93.1446 16.433 94.0313 16.2143 94.6071 15.6046C94.6863 15.5186 94.7587 15.4248 94.8301 15.331H97.1935C96.9855 16.0657 96.6585 16.7299 96.1639 17.2454C95.2057 18.2531 93.7281 18.6205 92.2666 18.6205C90.805 18.6205 89.3284 18.2609 88.3703 17.2454C87.4121 16.2299 87.0613 14.6828 87.0613 13.1435C87.0613 11.6043 87.4043 10.0494 88.3703 9.04168C89.3367 8.03396 90.806 7.66663 92.2666 7.66663C93.7272 7.66663 95.2057 8.02618 96.1639 9.04168C97.1298 10.0572 97.4729 11.6043 97.4729 13.1435L97.4733 13.1431Z",',
      '\t\t\t"M113.5 4.62817H111.104V18.6217H113.5V4.62817Z",',
      '\t\t\t"M117.589 12.8154L121.517 18.6208H118.554L114.625 12.8154L118.554 8.15088H121.517L117.589 12.8154Z",',
      '\t\t];',
      '\t\t/**',
      '\t\t* Render the miasaki deployment name artwork without its independently slotted mark.',
      '\t\t* @param props - Host-supplied presentation (size, className), same contract as the official wordmark.',
      '\t\t* @returns the deepseek wordmark with the miasaki badge.',
      '\t\t*/',
      '\t\tfunction MiasakiBrandName({ size = 24, className }) {',
      '\t\t\treturn (0, react_jsx_runtime.jsxs)("svg", {',
      '\t\t\t\twidth: size * 156 / 24,',
      '\t\t\t\theight: size,',
      '\t\t\t\tclassName,',
      '\t\t\t\tviewBox: "26 0 156 24",',
      '\t\t\t\tfill: "none",',
      '\t\t\t\t"aria-hidden": "true",',
      '\t\t\t\tchildren: [',
      '\t\t\t\t\t...MIASAKI_WORDMARK_LETTERS.map((d, index) => (0, react_jsx_runtime.jsx)("path", { key: `miasaki-letter-${index}`, d, fill: "currentColor" })),',
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("rect", { x: "129.348", y: "5.5", width: "52", height: "14", rx: "2", fill: "currentColor" }),',
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("text", {',
      '\t\t\t\t\t\tx: "136.5",',
      '\t\t\t\t\t\ty: "15",',
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
    id: 'miasaki-brand-name-usage',
    anchor: [
      '\t\tfunction OfficialBrandName() {',
      '\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.BrandWordmark, { includeMark: false });',
      '\t\t}',
    ].join('\n'),
    replacement: [
      '\t\tfunction OfficialBrandName() {',
      '\t\t\treturn (0, react_jsx_runtime.jsx)(MiasakiBrandName, {});',
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
  if (state === 'unknown') {
    console.log('[patch] 提示   该文件既非 0.1.7-rc.2 原版也非补丁版——DSH 很可能已升级，需先核对锚点再适配')
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
