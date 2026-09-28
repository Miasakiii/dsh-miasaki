#!/usr/bin/env node
// 消息来源闸门：仓库内插件源码（以及本机已装的第三方插件）不得使用**退役的 v3 source 写法**。
//
// 为什么需要它（2026-09-27 实机故障）：
//   DSH 0.1.7 起会话日志格式为 **v4**，每条 durable 消息的 `source.kind` 必须是
//   「生产者自有的 kind」（producer-owned）。旧的 v3 写法
//       { kind: "plugin", plugin: "<插件名>" }
//   被**硬拒绝** —— `assertV4SourceRowAdmission`（写/读每一行）与 `assertV4MessageSources`
//   （恢复已发布会话）都抛 `SessionFormatError('format v4 message requires a producer-owned
//   source kind')`。合法形态是 `{ kind: "plugin:<插件名>" }`（即 `plugin:` 前缀）。
//   第三方记忆插件 `@openviking/dsh-memory-plugin@0.2.1` 正是照 v3 写法注入 recall 消息，
//   于是**每一轮运行都在落盘前被拒**，UI 把那句 SessionFormatError 顶成「本轮运行失败」。
//   逐条判据与排查过程见 dsh-miasaki-shared-docs/dsh-platform/
//   dsh-0.1.7-session-v4-source-admission-2026-09-27.md。
//
// 本闸门做两件事：
//   ① 仓库内（九线 + desktop 的 plugins/themes/ui/patches）一律禁止构造式旧写法；
//   ② `--installed`（默认开启）顺带体检本机 `~/.dsh/profiles/*/node_modules` 下的
//      **非官方**插件包 —— CI 上没有该目录时**显式打印跳过原因**（不静默）。
//
// 覆盖边界（**刻意收窄**，别把绿灯当全面保证）：
//   · 抓不到动态拼出的 kind（`kind: someVar`、`"pl" + "ugin"`、模板串）；
//   · 抓不到「消息完全没有 source」（v4 同样拒绝，但静态无法判定哪条消息会落盘）；
//   · 抓不到运行时才注入的消息来源 —— 仓库内扫的是源码，本机体检扫的是已装包源码，
//     二者都不执行插件；
//   · 只认 `kind` 后紧跟引号字面量 `"plugin"` 的形态；`kind: 'plugin '`（带空白）之类
//     变体属上游笔误，不在覆盖内。
//
// 豁免：命中行（或同行注释）写 `// source-ok: <理由>` 即跳过 —— 刻意降级必须留痕，
// 与其他仓库级闸门同一约定。整行注释（`//` `*` `/*` `#` 起首）不参与扫描。
//
// 用法：
//   node scripts/check-message-sources.mjs                # 仓库内 + 本机体检（默认）
//   node scripts/check-message-sources.mjs --no-installed # 只扫仓库内（CI / 无本机 profile 时）
//   node scripts/check-message-sources.mjs --quiet        # 只打印违规与结论
//
// 零依赖、纯离线：受限沙箱与 CI 同样可跑。

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARK = '[message-sources]'

/** 退役的 v3 写法：`kind` 后紧跟字符串字面量 "plugin"。比较式（`kind === "plugin"`）不匹配。 */
const RETIRED_SOURCE = /["']?kind["']?\s*:\s*["'`]plugin["'`]/

/** 参与扫描的源码扩展名。 */
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx'])

/** 一律跳过的目录名（构建产物 / 依赖 / 归档）。 */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'target', '.git', '.pnpm-store', 'injected', '_refs', 'vendor', 'coverage'])

/** 单文件扫描上限：超过即跳过并计数（打包产物可能极大，读进来只是浪费）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024

/** 仓库内被检查的根（相对 ROOT）。 */
const REPO_TARGETS = [
  'dsh-miasaki-sidebar',
  'dsh-miasaki-canvas',
  'dsh-miasaki-fleet',
  'dsh-miasaki-ssh',
  'dsh-miasaki-dual-model',
  'dsh-miasaki-appearance',
  'dsh-miasaki-usage',
  'dsh-miasaki-free-model',
  'dsh-miasaki-desktop/plugins',
  'dsh-miasaki-desktop/themes',
  'dsh-miasaki-desktop/ui',
  'dsh-miasaki-desktop/patches',
]

/** 本机体检时排除的官方包作用域（官方包内含 v3→v4 迁移代码，用的是比较式，本就不该命中）。 */
const OFFICIAL_SCOPES = new Set(['@deepseek-ai'])

/** 一个命中是否属于整行注释（不参与扫描）。 */
function isCommentLine(trimmed) {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')
}

/**
 * 扫描一段文本，收集构造式旧写法。
 * @param text - 文件全文。
 * @param file - 用于报告的路径。
 * @param sink - 命中收集器。
 * @returns 命中条数。
 */
function scanText(text, file, sink) {
  let hits = 0
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (isCommentLine(trimmed)) continue
    if (line.includes('source-ok')) continue
    if (!RETIRED_SOURCE.test(line)) continue
    hits += 1
    sink.push({ file, line: index + 1, text: trimmed.slice(0, 160) })
  }
  return hits
}

/** 闸门自证：正例必须命中、反例必须不命中。任何一条不成立即视为闸门失效。 */
function selfTest() {
  const mustHit = [
    ['对象字面量', 'const m = createUserMessage({ source: { kind: "plugin", plugin: "openviking-memory" } })'],
    ['单引号字面量', "source = { kind: 'plugin' }"],
    ['字符串键', 'row["source"] = { "kind": "plugin", plugin: name }'],
  ]
  const mustMiss = [
    ['比较式（迁移/校验代码的正当形态）', 'if (message.source?.kind === "plugin") return null'],
    ['v4 合法形态', 'source: { kind: "plugin:openviking-memory", form: "recall" }'],
    ['比较式不等', 'if (value["kind"] !== "plugin") keep(value)'],
    ['整行注释', '// 不要写 kind: "plugin"，用 plugin:<名>'],
    ['显式豁免', 'source: { kind: "plugin" } // source-ok: 故障注入自证用'],
  ]
  const failures = []
  for (const [label, text] of mustHit) {
    if (scanText(text, '<self-test>', []) !== 1) failures.push(`正例未命中：${label}`)
  }
  for (const [label, text] of mustMiss) {
    if (scanText(text, '<self-test>', []) !== 0) failures.push(`反例误报：${label}`)
  }
  if (failures.length > 0) {
    console.error(`${MARK} 闸门自证失败（闸门本身坏了，先修闸门）：`)
    for (const failure of failures) console.error(`  · ${failure}`)
    return false
  }
  return true
}

/**
 * 递归扫描一个根，收集命中。
 * @param root - 目录。
 * @param filter - 判定某个包目录是否参与（用于跳过官方作用域）。
 * @returns 扫描统计与命中列表。
 */
function scanRoot(root, filter = () => true) {
  const hits = []
  const stats = { files: 0, skippedLarge: 0, visited: new Set() }
  const walk = directory => {
    let real
    try {
      real = realpathSync(directory)
    } catch {
      return
    }
    if (stats.visited.has(real)) return
    stats.visited.add(real)
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const stat = statSync(full)
          isDirectory = stat.isDirectory()
          isFile = stat.isFile()
        } catch {
          continue
        }
      }
      if (isDirectory) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        if (entry.name.startsWith('@') && OFFICIAL_SCOPES.has(entry.name)) continue
        if (!filter(entry.name)) continue
        walk(full)
        continue
      }
      if (!isFile) continue
      if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue
      let size = 0
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      if (size > MAX_FILE_BYTES) {
        stats.skippedLarge += 1
        continue
      }
      let text
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      stats.files += 1
      scanText(text, full, hits)
    }
  }
  walk(root)
  return { hits, stats }
}

/** 发现本机各 profile 的 node_modules。 */
function installedRoots() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const profiles = join(home, 'profiles')
  // guard-ok: CI 上没有 ~/.dsh/profiles 是正常形态；调用方会显式打印跳过原因，不是静默跳过
  if (!existsSync(profiles)) return { roots: [], profiles }
  const roots = []
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules') continue
    const nodeModules = join(profiles, entry.name, 'node_modules')
    if (existsSync(nodeModules)) roots.push({ profile: entry.name, dir: nodeModules })
  }
  return { roots, profiles }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const withInstalled = !argv.includes('--no-installed')

if (!selfTest()) process.exit(1)

const violations = []
let repoFiles = 0
let skippedLarge = 0
const missingTargets = REPO_TARGETS.filter(target => !existsSync(join(ROOT, target)))
if (missingTargets.length > 0) {
  console.error(`${MARK} 声明的扫描根不存在（仓库结构变了？先核对 REPO_TARGETS 与磁盘）：`)
  for (const target of missingTargets) console.error(`  · ${target}`)
  process.exit(1)
}
for (const target of REPO_TARGETS) {
  const dir = join(ROOT, target)
  const { hits, stats } = scanRoot(dir)
  repoFiles += stats.files
  skippedLarge += stats.skippedLarge
  violations.push(...hits)
}
if (!quiet) console.log(`${MARK} 仓库内：扫描 ${repoFiles} 个源码文件，命中 ${violations.length} 处`)

let installedFiles = 0
let installedHits = 0
if (withInstalled) {
  const { roots, profiles } = installedRoots()
  if (roots.length === 0) {
    console.log(`${MARK} 本机体检：跳过 —— ${profiles} 下没有可用 profile（CI 上是正常形态）`)
  } else {
    for (const { profile, dir } of roots) {
      const { hits, stats } = scanRoot(dir)
      installedFiles += stats.files
      installedHits += hits.length
      skippedLarge += stats.skippedLarge
      for (const hit of hits) violations.push({ ...hit, profile })
    }
    if (!quiet) console.log(`${MARK} 本机体检：${roots.length} 个 profile（${roots.map(r => r.profile).join(' / ')}），扫描 ${installedFiles} 个源码文件，命中 ${installedHits} 处`)
  }
}
if (skippedLarge > 0) console.log(`${MARK} 跳过 >8MB 的文件 ${skippedLarge} 个（打包产物，见脚本头部覆盖边界）`)

if (violations.length === 0) {
  console.log(`${MARK} PASS —— 未发现退役的 v3 source 写法（合法形态：kind: "plugin:<插件名>"）`)
  process.exit(0)
}

console.error(`\n${MARK} FAIL —— 发现 ${violations.length} 处退役的 v3 source 写法：`)
console.error('  旧：{ kind: "plugin", plugin: "<插件名>" }   ← DSH 0.1.7+ 的 v4 会硬拒这一形态')
console.error('  新：{ kind: "plugin:<插件名>" }              ← producer-owned kind\n')
for (const violation of violations) {
  const where = violation.profile === undefined ? '' : ` [profile ${violation.profile}]`
  console.error(`  ${violation.file}:${violation.line}${where}`)
  console.error(`    ${violation.text}`)
}
console.error('\n修法：把 kind 改成 `plugin:<插件名>`（并同步改动读取侧的判定条件），或升级到已适配 v4 的插件版本。')
console.error('确属刻意的反例/文档，可在命中行写 `// source-ok: <理由>` 豁免。')
process.exit(1)
