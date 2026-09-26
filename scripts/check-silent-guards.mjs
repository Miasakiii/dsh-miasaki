#!/usr/bin/env node
// 「守卫必须显式失败」闸门 —— 静默降级 / 静默断链的常态化拦截。
//
// ── 为什么需要 ───────────────────────────────────────────────────────────────
// 同类 bug 在本仓已第四例，前三次都是逐例修，没有形成闸门：
//   ① `desktop/scripts/build-init.mjs` 的 `existsSync(src)` 守卫让删素材后**静默跳过**，
//      回归照常 PASS，断链直到下次重跑脚本才暴露；
//   ② `fleet/workers/graph/verifier-pick.mjs` 的 `loadVendors()` 读不存在的
//      `shared/agent-vendors.json` 后**静默回退默认值**，而两处文档仍宣称「可覆盖」；
//   ③ `appearance/package.json` 的 `files` 缺 `assets/`，而 `lib/icon-presets.js` 引用
//      `assets/presets/*.png` —— 位图预设**静默消失**（仓库内有、发布时丢）；
//   ④ appearance 写盘失败吞错（已于 2026-09-26 修：500 + changed:false + 可读原因）。
// 四例的共同结构不是「catch 空」，而是：**一个本该存在的输入缺失时，代码选择继续跑**。
//
// ── 扫描边界（重要设计决策）────────────────────────────────────────────────
// 本闸门**不**扫全仓语法形态：全仓空 catch 有 250+ 处，绝大多数是浏览器侧的正当降级
// （隐私模式禁 localStorage、布局未定、socket 已关、清理路径）—— 把它们全判为问题，
// 闸门会被自己的噪声淹没。因此只扫「静默降级会真正造成不可见损失」的两类位置：
//   · **host 半**：各线 `index.js` / `lib/**`（排除 `client.js` / `app.js`）
//   · **构建链与工具链**：`scripts/**`、`workers/**`、`patches/*/{patch,rebuild-baseline}.mjs`
// 判据：这两类位置的产物是「安装到 profile 的插件」与「打包/注入的产物」—— 静默降级
// 不会让人看见，只会让东西消失。浏览器半的降级至少还有 UI 可观察。
//
// ── 四类规则（含各自的生效范围）─────────────────────────────────────────────
//   R1 静默跳过守卫 —— `if (!existsSync(x))` 的分支只 return/continue/break，不 throw/exit。
//                      范围：host 半 + 构建链。
//   R2 静默吞错     —— 空 catch / `.catch(() => {})` / `.catch(() => null)`。
//                      **范围只有构建链**：运行时 host 半的空 catch 多是清理路径
//                      （`ws.close()` / `term.dispose()` / `fit.fit()`），吞掉不产生
//                      「缺件产物且无人知晓」，把它们全判为问题会让闸门被噪声淹没
//                      （实测：不加此限制时 R2 命中 90 处，其中 70 处是 ssh/sidebar/canvas
//                      的清理与布局降级）。
//   R3 静默回退读取 —— `readJsonOrNull()` / `safeReadJSON()` 这类「读失败即 null」的调用点。
//                      范围：host 半 + 构建链。
//   R4 声明清单缺口 —— `package.json` 的 `files` 与磁盘/代码引用的两向不一致
//                      （正向：列了不存在；反向：代码引用的资源没被覆盖 = 第 ③ 例）。
//                      范围：全部八线。
//
// ── 本闸门**抓不到**的形态（别把它的绿灯当成全面保证）──────────────────────
//   · 「写失败返回成功」（第 ④ 例 appearance 的原始形态）—— 需要行为测试，不是语法；
//   · 文档宣称存在但仓库里没有的文件（第 ② 例的另一半）—— 见 check-doc-versions.mjs 版本表；
//   · 运行时才成立的断链（装了 profile 才发现资源缺件）—— 属实机验收，见回归矩阵 §3；
//   · 浏览器半的静默降级 —— 刻意排除（见上）。
//
// ── 判定与豁免 ──────────────────────────────────────────────────────────────
//   · 源码同一行或上一行写 `// guard-ok: <理由>` → 视为**已就地决策**，合规；
//   · 存量登记在 `scripts/silent-guard-baseline.json`（**冻结，不是背书**）；
//   · 当前命中 − 基线 = 新增 → **exit 1**；基线有、当前无 → 提示可回收。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/check-silent-guards.mjs            # 闸门（新增即 exit 1）
//   node scripts/check-silent-guards.mjs --report   # 只列命中，恒 exit 0
//   node scripts/check-silent-guards.mjs --update   # 用当前命中重写基线（须人工复核 diff）

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(ROOT, 'scripts', 'silent-guard-baseline.json')

const LINES = [
  'dsh-miasaki-sidebar',
  'dsh-miasaki-canvas',
  'dsh-miasaki-fleet',
  'dsh-miasaki-desktop',
  'dsh-miasaki-ssh',
  'dsh-miasaki-dual-model',
  'dsh-miasaki-appearance',
  'dsh-miasaki-usage',
]

/** 扫描根：八线 + 仓库脚本 + 跨线补丁（playwright）。 */
const SCAN_ROOTS = [
  ...LINES.map(line => join(ROOT, line)),
  join(ROOT, 'scripts'),
  join(ROOT, 'dsh-miasaki-shared-docs', 'dsh-platform', 'patches'),
]

/** 不进入的目录：产物 / 外部 / 浏览器渲染层 / 文档 / 测试 / 运行时档案。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'target', 'vendor', '_refs', 'baseline', 'test', 'tests',
  'design', 'docs', 'themes', 'agents', 'tasks', 'logs', 'coverage', 'src-tauri', '.vs',
  '.pnpm-store', 'cordis', 'injected', 'frames', 'states', 'sprites', 'assets',
])

/** 闸门自身不参与扫描（否则它的正则字面量会自我命中）。 */
const SELF_SKIP = new Set(['scripts/check-silent-guards.mjs', 'scripts/check-doc-versions.mjs'])

const RESOURCE_EXT = /\.(?:png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf)$/i
const EXPLICIT_FAILURE = /throw\b|process\.exit\b|process\.exitCode\b|errors\.push|failures\.push|problems\.push|issues\.push|\bfailed\b|\bfailures\b/

/* ---------- 文件遍历 ---------- */

function collectFiles(dir, out) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(full, out)
    } else if (entry.isFile()) {
      if (!/\.(?:js|mjs|cjs)$/.test(entry.name)) continue
      if (/\.test\.(?:js|mjs|cjs)$/.test(entry.name)) continue
      if (entry.name === 'client.js' || entry.name === 'app.js' || entry.name.endsWith('.min.js')) continue
      out.push(full)
    }
  }
  return out
}

const relOf = full => relative(ROOT, full).split('\\').join('/')

/**
 * 构建链 / 本地工具链：这里的静默吞错会产出「缺件产物且无人知晓」。
 * 运行时 host 半（各线 index.js / lib/**）不算 —— 它们的清理路径吞错不产生不可见损失。
 */
const isBuildChain = rel => /(?:^|\/)(?:scripts|workers|patches|preset-sources|fleet-monitor)\//.test(rel)

/* ---------- 源码工具 ---------- */

/**
 * 去注释但**保持索引与行号不变**的副本（注释内容替换成等量空格）。
 * 只在它上面做模式匹配：否则注释里讨论「`.catch(() => {})` 那个 bug」的文字会被当成代码
 * （首版实测：`canvas/index.js:11` 的一行中文注释就是这样误报的）。
 * 取展示片段时回到原文，索引因等长替换而完全对齐。
 * 已知近似：字符串字面量里的 `//`（如 URL）会被当注释抹掉 —— 这只会漏报，不会误报。
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
}

/** 去注释后只剩空白 ⇒ 空块。 */
const isBlank = body => body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim() === ''

/** 从 `(` 处起做括号配平，返回闭合位置。 */
function matchParen(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 取紧随其后的 `{...}` 块或单条语句（到行尾）。 */
function readGuardedBody(text, from) {
  let i = from
  while (i < text.length && /\s/.test(text[i])) i++
  if (text[i] === '{') {
    let depth = 0
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(i + 1, j) }
    }
    return text.slice(i + 1)
  }
  const nl = text.indexOf('\n', i)
  return text.slice(i, nl === -1 ? text.length : nl)
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length
const normalize = snippet => snippet.replace(/\s+/g, ' ').trim().slice(0, 120)

/** 命中行或上一行是否写了 `// guard-ok: 理由`。 */
function hasInlineWaiver(text, index) {
  const line = lineOf(text, index)
  const lines = text.split('\n')
  for (const probe of [lines[line - 1] ?? '', lines[line - 2] ?? '']) {
    if (/guard-ok\s*:/.test(probe)) return true
  }
  return false
}

/** 从源码片段里取作者原本的说明性注释，作为基线里的 reason 初值。 */
function noteOf(snippet) {
  const block = snippet.match(/\/\*\s*([^*]+?)\s*\*\//)
  if (block) return block[1].trim()
  const line = snippet.match(/\/\/\s*(.+)$/)
  return line ? line[1].trim() : ''
}

/* ---------- R1：静默跳过守卫 ---------- */

const SHORT_CIRCUIT = /\b(?:return|continue|break)\b/

function scanR1(raw, rel) {
  const hits = []
  const text = codeOnly(raw)
  const re = /if\s*\(\s*!\s*(?:fs\.)?existsSync\s*\(/g
  let m
  while ((m = re.exec(text)) !== null) {
    const paren = text.indexOf('(', m.index + m[0].length - 1)
    const close = matchParen(text, paren)
    if (close === -1) continue
    const body = readGuardedBody(text, close + 1)
    const bare = body.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    // 只有「短路离开」才算静默跳过：
    //   `if (!existsSync(x)) return []`        → 命中（缺件即静默少一块）
    //   `if (!existsSync(x)) { }`              → 命中（更糟：什么都不做）
    //   `if (!existsSync(b)) await copy(b)`    → 不命中（守卫分支在做正确的事：先备份）
    if (bare !== '' && !SHORT_CIRCUIT.test(bare)) continue
    // 短路前已经显式失败（抛出 / 退出 / 计入失败计数）→ 合规
    if (EXPLICIT_FAILURE.test(body)) continue
    if (hasInlineWaiver(raw, m.index)) continue
    const line = lineOf(text, m.index)
    hits.push({ rule: 'R1', file: rel, line, snippet: normalize(raw.split('\n')[line - 1]) })
  }
  return hits
}

/* ---------- R2：静默吞错 ---------- */

function scanR2(raw, rel) {
  const hits = []
  if (!isBuildChain(rel)) return hits
  const text = codeOnly(raw)
  const lines = raw.split('\n')

  // 空 catch 块（含只有注释的）
  const re = /catch\s*(?:\([^)]*\))?\s*\{/g
  let m
  while ((m = re.exec(text)) !== null) {
    const open = text.indexOf('{', m.index + 5)
    let depth = 0
    let close = -1
    for (let j = open; j < text.length; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') { depth--; if (depth === 0) { close = j; break } }
    }
    if (close === -1) continue
    if (!isBlank(text.slice(open + 1, close))) continue
    if (hasInlineWaiver(raw, m.index)) continue
    const line = lineOf(text, m.index)
    hits.push({ rule: 'R2', file: rel, line, snippet: normalize(lines[line - 1]) })
  }

  // `.catch(() => {})` / `.catch(() => null)` / `.catch(function () {})`
  const callRe = /\.catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|null\b|undefined\b)|\.catch\s*\(\s*function\s*\([^)]*\)\s*\{\s*\}\s*\)/g
  while ((m = callRe.exec(text)) !== null) {
    if (hasInlineWaiver(raw, m.index)) continue
    const line = lineOf(text, m.index)
    hits.push({ rule: 'R2', file: rel, line, snippet: normalize(lines[line - 1]) })
  }
  return hits
}

/* ---------- R3：静默回退读取 ---------- */

const READERS = /\b(readJsonOrNull|readJSONOrNull|readJsonSafe|readOrNull|safeReadJSON|safeReadJSONL|safeReadJson|tryReadJson)\s*\(/g

function scanR3(raw, rel) {
  const hits = []
  const text = codeOnly(raw)
  const lines = raw.split('\n')
  const re = new RegExp(READERS.source, 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    // 跳过函数定义处（`function readJsonOrNull(`）—— 定义本身不是回退点
    const before = text.slice(Math.max(0, m.index - 12), m.index)
    if (/function\s+$/.test(before)) continue
    if (hasInlineWaiver(raw, m.index)) continue
    const line = lineOf(text, m.index)
    hits.push({ rule: 'R3', file: rel, line, snippet: normalize(lines[line - 1]) })
  }
  return hits
}

/* ---------- R4：声明清单缺口 ---------- */

/** `files` 项是否覆盖某个仓库内相对路径。 */
function coveredByFiles(files, relPath) {
  return files.some(entry => {
    const bare = entry.replace(/\/$/, '')
    if (bare === '') return false
    return relPath === bare || relPath.startsWith(bare + '/')
  })
}

function scanR4() {
  const hits = []
  for (const line of LINES) {
    const pkgPath = join(ROOT, line, 'package.json')
    if (!existsSync(pkgPath)) continue
    let pkg
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { continue }
    const files = Array.isArray(pkg.files) ? pkg.files : null
    if (files === null) continue

    // 正向：列出的路径必须真的在磁盘上
    for (const entry of files) {
      const bare = entry.replace(/\/$/, '')
      if (bare === '' || bare.startsWith('!')) continue
      if (!existsSync(join(ROOT, line, bare))) {
        hits.push({ rule: 'R4', file: `${line}/package.json`, line: 0, snippet: `files 列了不存在的路径：${entry}` })
      }
    }

    // 反向：host 半代码引用的资源必须被 files 覆盖（第 ③ 例）
    const sources = []
    collectFiles(join(ROOT, line), sources)
    for (const full of sources) {
      const text = readFileSync(full, 'utf8')
      const rel = relOf(full)
      for (const match of text.matchAll(/'([\w][\w./-]*\.(?:png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf))'/gi)) {
        const ref = match[1]
        if (/^https?:|^data:/.test(ref)) continue
        const lineNo = lineOf(text, match.index)
        if (!existsSync(join(ROOT, line, ref))) {
          hits.push({ rule: 'R4', file: rel, line: lineNo, snippet: `引用的资源不存在：${ref}` })
        } else if (!coveredByFiles(files, ref)) {
          hits.push({ rule: 'R4', file: rel, line: lineNo, snippet: `引用的资源未被 package.json files 覆盖：${ref}` })
        }
      }
    }
  }
  return hits
}

/* ---------- 采集与比对 ---------- */

const keyOf = hit => `${hit.file}|${hit.rule}|${normalize(hit.snippet)}`

function collect() {
  const hits = []
  for (const root of SCAN_ROOTS) {
    if (!existsSync(root)) continue
    for (const full of collectFiles(root, [])) {
      const rel = relOf(full)
      if (SELF_SKIP.has(rel)) continue
      const text = readFileSync(full, 'utf8')
      hits.push(...scanR1(text, rel), ...scanR2(text, rel), ...scanR3(text, rel))
    }
  }
  hits.push(...scanR4())
  return hits
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { entries: [] }
  try { return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) } catch { return { entries: [] } }
}

const args = process.argv.slice(2)
const mode = args.includes('--update') ? 'update' : args.includes('--report') ? 'report' : 'gate'

const hits = collect()
const byKey = new Map()
for (const hit of hits) {
  const key = keyOf(hit)
  if (!byKey.has(key)) byKey.set(key, [])
  byKey.get(key).push(hit)
}

const baseline = loadBaseline()
const baseCount = new Map((baseline.entries ?? []).map(entry => [entry.key, entry.count ?? 1]))

const added = []
const gone = []
for (const [key, list] of byKey) {
  const allowed = baseCount.get(key) ?? 0
  if (list.length > allowed) added.push(...list.slice(allowed))
}
for (const entry of baseline.entries ?? []) {
  const current = byKey.get(entry.key)?.length ?? 0
  if (current < (entry.count ?? 1)) gone.push(entry)
}

const tally = rule => hits.filter(hit => hit.rule === rule).length
console.log(`[silent-guards] 扫描 ${SCAN_ROOTS.filter(existsSync).length} 个根 — 命中 ${hits.length} 处` +
  `（R1 静默跳过 ${tally('R1')} / R2 静默吞错 ${tally('R2')} / R3 静默回退读取 ${tally('R3')} / R4 声明缺口 ${tally('R4')}）`)
console.log(`[silent-guards] 基线 ${(baseline.entries ?? []).length} 类 / 新增 ${added.length} / 可回收 ${gone.length}`)

if (mode === 'update') {
  const entries = [...byKey.entries()].map(([key, list]) => {
    const previous = (baseline.entries ?? []).find(entry => entry.key === key)
    const sample = list[0]
    return {
      key,
      rule: sample.rule,
      file: sample.file,
      line: sample.line,
      snippet: sample.snippet,
      count: list.length,
      reason: previous?.reason || noteOf(sample.snippet) || '（待补：触碰该文件时补理由）',
    }
  }).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  writeFileSync(BASELINE_PATH, JSON.stringify({
    note: '「守卫必须显式失败」闸门的存量冻结台账。**这是债，不是背书**：条目只表示「尚未核销」，'
      + '每一条都应在后续触碰该文件时补 reason 并就地改写（throw / process.exit / guard-ok 注释）。'
      + '新增条目会让闸门失败，故本文件只应由 `node scripts/check-silent-guards.mjs --update` 变更，且必须人工复核 diff。',
    generatedBy: 'scripts/check-silent-guards.mjs --update',
    entries,
  }, null, 2) + '\n', 'utf8')
  console.log(`[silent-guards] 基线已重写：${entries.length} 类 → scripts/silent-guard-baseline.json`)
  process.exit(0)
}

if (mode === 'report') {
  for (const hit of hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  [${hit.rule}] ${hit.file}:${hit.line}  ${hit.snippet}`)
  }
  process.exit(0)
}

for (const hit of added) {
  console.log(`  新增 [${hit.rule}] ${hit.file}:${hit.line}  ${hit.snippet}`)
}
for (const entry of gone) {
  console.log(`  可回收（基线里有、当前已无）[${entry.rule}] ${entry.file}  ${entry.snippet}`)
}

if (added.length > 0) {
  console.error(`\n[silent-guards] 失败：${added.length} 处新增静默降级。`)
  console.error('  修法三选一：① 守卫显式失败（throw / process.exit(非 0)）；')
  console.error('              ② 资源缺失改为显式声明（package.json files / 清单文件）；')
  console.error('              ③ 确认降级是刻意的 → 在命中行或上一行写 `// guard-ok: <理由>`。')
  process.exit(1)
}
console.log('\n[silent-guards] 无新增静默降级。')
