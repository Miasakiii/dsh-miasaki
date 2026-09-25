#!/usr/bin/env node
// patch-live-audit.mjs — 运行时补丁 live 状态审计（L2 实机项，不进 verify-all）。
//
// 为什么单独立项：`scripts/verify-all.mjs` 里的六项「patch verify」全是**离线自证**——
// 由 baseline 重建补丁产物并比对 SHA，证明「补丁规则与基线自洽」，且**故意不碰安装目录**
// （DSH 升级覆盖补丁后这一项仍应 PASS）。代价是一个真实的盲区：
//   2026-09-23 之前，DSH 已实装 0.1.7-alpha.2，而六个旧基线补丁在 live 安装目录里
//   全部 `unknown`（升级覆盖）——离线回归 93 项全绿，而 dual-model 发图被拒、
//   计时恢复、会话头保护等运行时能力实际不在场，用户侧表现为「功能静默缺失」。
// 本工具回答 verify 回答不了的那个问题：**补丁此刻在不在 live 安装里**。
//
// 判定（每个**目标**一行；双半补丁两行）：
//   patched   ✅ 补丁在 live 文件里生效
//   original  ⚪ live 是干净原版（从未打 / 升级刚覆盖回原版）
//   unknown   🟡 live 与 baseline 原版、补丁版都不同（升级漂移 / 外部改动）
//   missing   ➖ 目标文件不存在（该包未安装 / 布局不同）
// 退出码：
//   1 —— 任一补丁在「live dsh 版本 == 该补丁 baseline 版本」下未 patched。
//        这是真正的回归（基线对得上却没打上），必须修。
//   0 —— 全部 patched；或未打/漂移均由**版本升级**解释（live 版本 != baseline），
//        此时应按各补丁 README「升级后怎么办」重打，属预期状态，只告警。
//
// 用法：
//   node scripts/patch-live-audit.mjs            # 人读表格
//   node scripts/patch-live-audit.mjs --json     # 机器可读（同字段）
// 环境变量：
//   MIASAKI_DSH_INSTALL_ROOT     CLI 布局安装根（含 @deepseek-ai/dsh/node_modules/…）
//   MIASAKI_DSH_PROFILE_MODULES  profile 平坦布局根（~/.dsh/profiles/node_modules）
//
// 实现注记：不 spawn 任何子进程——直接 import 各补丁的 `classify` 在本进程内分类
// （补丁的 CLI 都有 `import.meta.url` 守卫，被 import 时不执行）。受限沙箱下
// 捕获子进程 stdio 会 EPERM，纯进程内实现没有这个问题。
// 目标契约：单目标补丁导出 TARGET_PACKAGE + TARGET_RELATIVE + classify；**双半**补丁
// （shared-docs 的 `dsh-browser-playwright`）改导出 `LIVE_TARGETS`——每半一个目标文件、
// 各自成行、各自判回归（2026-09-24 三轮复审补入该件：它原本是审计盲区，而它被打回
// 原版会让 web UI 连启动屏都过不去）。profile 布局探测含每个 profile 的
// `~/.dsh/profiles/<name>/node_modules`（第三方插件不装在 CLI 树里）。

import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 补丁目录：桌面端六件 + dual-model 一件 + shared-docs 一件（第三方插件，双半）。 */
const PATCH_ROOTS = [
  { dir: join(ROOT, 'dsh-miasaki-desktop', 'patches'), label: 'desktop' },
  { dir: join(ROOT, 'dsh-miasaki-dual-model', 'patches'), label: 'dual-model' },
  // 2026-09-24 三轮复审补入：`@yeesy369/dsh-browser-playwright` 双半补丁原在审计之外，
  // 而它被打回原版会让 web UI 连启动屏都过不去——离线全绿 + live 全 unknown 的盲区重现。
  { dir: join(ROOT, 'dsh-miasaki-shared-docs', 'dsh-platform', 'patches'), label: 'shared-docs' },
]

/** CLI 布局安装根候选（npm 全局 / 显式覆盖）：<root>/@deepseek-ai/dsh/node_modules/<pkg>/<rel> */
function cliRoots() {
  const roots = []
  if (process.env.MIASAKI_DSH_INSTALL_ROOT) roots.push(process.env.MIASAKI_DSH_INSTALL_ROOT)
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules'))
  roots.push('/usr/local/lib/node_modules')
  return roots
}

/** profile 平坦布局根候选（junction 农场，与 CLI 树同一份字节）：<root>/<pkg>/<rel>。
 *  含 `~/.dsh/profiles/node_modules` 与**每个 profile** 的 `<profile>/node_modules`
 *  （第三方插件装在 `profiles/web/…`，只查平坦根会误报 missing）。 */
function profileRoots() {
  const roots = []
  if (process.env.MIASAKI_DSH_PROFILE_MODULES) roots.push(process.env.MIASAKI_DSH_PROFILE_MODULES)
  const profiles = join(homedir(), '.dsh', 'profiles')
  roots.push(join(profiles, 'node_modules'))
  try {
    for (const name of readdirSync(profiles).sort()) roots.push(join(profiles, name, 'node_modules'))
  } catch { /* profiles 目录不存在：只保留上面的候选 */ }
  return roots
}

/** 读 live dsh 版本：任一 CLI 根下 @deepseek-ai/dsh/package.json 的 version。 */
async function liveDshVersion() {
  for (const root of cliRoots()) {
    const pkg = join(root, '@deepseek-ai', 'dsh', 'package.json')
    if (!existsSync(pkg)) continue
    try {
      const json = JSON.parse(await readFile(pkg, 'utf8'))
      if (typeof json.version === 'string') return json.version
    } catch { /* 换个候选 */ }
  }
  return null
}

/** 定位一个补丁的 live 目标文件：CLI 布局优先，profile 布局兜底。 */
function locateTarget(pkg, rel) {
  for (const root of cliRoots()) {
    const candidate = join(root, '@deepseek-ai', 'dsh', 'node_modules', pkg, rel)
    if (existsSync(candidate)) return { path: candidate, layout: 'cli' }
  }
  for (const root of profileRoots()) {
    const candidate = join(root, pkg, rel)
    if (existsSync(candidate)) return { path: candidate, layout: 'profile' }
  }
  return null
}

/** 枚举补丁目录下的 patch.mjs（每目录一个）。 */
async function discoverPatches() {
  const { readdir } = await import('node:fs/promises')
  const out = []
  for (const root of PATCH_ROOTS) {
    if (!existsSync(root.dir)) continue
    for (const name of (await readdir(root.dir)).sort()) {
      const file = join(root.dir, name, 'patch.mjs')
      if (existsSync(file)) out.push({ dir: name, file, line: root.label })
    }
  }
  return out
}

const STATE_MARK = {
  patched: '✅',
  original: '⚪',
  unknown: '🟡',
  missing: '➖',
}

async function main() {
  const asJson = process.argv.includes('--json')
  const liveVersion = await liveDshVersion()
  const patches = await discoverPatches()
  const rows = []

  for (const entry of patches) {
    let mod
    try {
      // Windows 下动态 import 绝对路径必须是 file:// URL（裸路径会被当成协议 'c:'）。
      mod = await import(pathToFileURL(entry.file).href)
    } catch (error) {
      rows.push({ ...entry, state: 'missing', detail: `import 失败：${error.message}` })
      continue
    }
    const pkg = mod.TARGET_PACKAGE
    const baseline = mod.BASELINE_DSH_VERSION
    if (typeof pkg !== 'string') {
      rows.push({ ...entry, state: 'missing', detail: '补丁未导出 TARGET_PACKAGE' })
      continue
    }
    // 目标清单：单目标补丁用 TARGET_RELATIVE + classify；双半补丁自报 LIVE_TARGETS
    //（每半一个目标文件、各自一个 classify），每个目标单独成行、单独判回归。
    const targets = Array.isArray(mod.LIVE_TARGETS) && mod.LIVE_TARGETS.length > 0
      ? mod.LIVE_TARGETS
      : [{ label: null, rel: mod.TARGET_RELATIVE ?? join('lib', 'client.js'), classify: mod.classify }]
    for (const target of targets) {
      const label = target.label ?? null
      if (typeof target.classify !== 'function') {
        rows.push({ ...entry, pkg, baseline, label, state: 'missing', detail: '目标未提供 classify' })
        continue
      }
      const rel = target.rel
      const located = locateTarget(pkg, rel)
      if (located === null) {
        rows.push({ ...entry, pkg, baseline, label, rel, state: 'missing', detail: 'live 安装里找不到目标文件' })
        continue
      }
      const { state } = await target.classify(await readFile(located.path, 'utf8'))
      // 基线对得上却没打上 = 真回归；版本漂移导致的未打 = 升级后需重打（告警）。
      const drift = state !== 'patched' && liveVersion !== null && baseline !== liveVersion
      rows.push({
        ...entry,
        pkg,
        baseline,
        label,
        rel,
        state,
        layout: located.layout,
        path: located.path,
        regression: state !== 'patched' && !drift && state !== 'missing',
        drift,
      })
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ liveVersion, rows }, null, 2))
  } else {
    console.log(`live dsh 版本：${liveVersion ?? '（未解析到）'}`)
    console.log('')
    for (const row of rows) {
      const name = row.label ? `${row.pkg} (${row.label})` : (row.pkg ?? row.dir)
      const head = `${STATE_MARK[row.state] ?? '?'} ${row.state.padEnd(8)} ${name}`
      const tail = row.state === 'patched'
        ? `（baseline ${row.baseline}，${row.layout} 布局）`
        : row.state === 'missing'
          ? `—— ${row.detail ?? ''}`
          : `（baseline ${row.baseline}${row.regression ? '，与 live 版本一致却未生效——回归！' : row.drift ? `，live 已升级，需重打` : ''}）`
      console.log(`${head} ${tail}`)
      if (row.path && row.state !== 'patched') console.log(`           ${row.path}`)
    }
    const bad = rows.filter(row => row.regression)
    const drift = rows.filter(row => row.drift)
    console.log('')
    console.log(`合计 ${rows.length} 个目标 / ${patches.length} 件补丁：patched ${rows.filter(r => r.state === 'patched').length} / 未生效 ${rows.filter(r => r.state !== 'patched' && r.state !== 'missing').length} / 未安装 ${rows.filter(r => r.state === 'missing').length}`)
    if (bad.length > 0) {
      console.log(`🔴 ${bad.length} 个补丁在基线版本匹配的 live 安装上未生效——按各补丁 README 重打（先 node <patch.mjs> status 核对）`)
    } else if (drift.length > 0) {
      console.log(`🟡 ${drift.length} 个补丁因 DSH 升级待重打（verify-all 的离线自证不受影响；属预期状态）`)
    } else {
      console.log('✅ live 安装与补丁基线一致')
    }
  }

  const regressions = rows.filter(row => row.regression)
  if (regressions.length > 0) process.exitCode = 1
}

await main()
