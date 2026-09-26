#!/usr/bin/env node
// 文档版本台账闸门 —— 治「文档说一个版本、代码是另一个版本」这类当前态失真。
//
// ── 为什么需要 ───────────────────────────────────────────────────────────────
// 评审报告 §八 列了 30+ 处「当前态失真」，其中最容易被下一个人当成事实的就是版本号：
// 例如 desktop 的 `design/HANDOVER.md` 写 v0.1.4，而 `package.json` 是 0.1.0。
// 版本号失真不会让程序崩，但会让所有基于它的判断（"这版有没有这个能力"）系统性偏错——
// 与代码 bug 同量级，只是更慢。
//
// ── 做法：单点台账，机器校验 ─────────────────────────────────────────────────
// 根 `README.md` 里维护一块 `<!-- version-ledger -->` 区块，逐线记录 `package.json`
// 的 version。本脚本校验该区块与八线 `package.json` 逐字一致：
//   · 数值不一致 → 失败；
//   · 缺某条线 / 多出未知目录 → 失败。
// 改版本后跑 `--update` 一键同步（diff 只动版本号那一格，易复核）。
//
// ── 边界（别把它当全面保证）─────────────────────────────────────────────────
//   · 只校验**这一块台账**。README 正文、各线 design/CHANGELOG 里的版本叙述不在范围内
//     —— 那些是历史叙述，逐条校验会把「历史条目按体例不改」的既有约定推翻。
//   · 不校验 `docs/` 与 `design/` 里的其它版本号（同上）。
//   · 断链（文档引用了不存在的文件）不在本闸门范围，见 check-silent-guards.mjs 的 R4
//     与报告 §八「断链」一节。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/check-doc-versions.mjs            # 校验（不一致 exit 1）
//   node scripts/check-doc-versions.mjs --report   # 只打印台账与实测值
//   node scripts/check-doc-versions.mjs --update   # 按 package.json 重写台账块

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const README_PATH = join(ROOT, 'README.md')
const START_MARK = '<!-- version-ledger:start'
const END_MARK = '<!-- version-ledger:end -->'

/** 权威列表：八线的显示名与目录（顺序即台账顺序）。 */
const LINES = [
  ['桌面端', 'dsh-miasaki-desktop'],
  ['Fleet', 'dsh-miasaki-fleet'],
  ['Canvas', 'dsh-miasaki-canvas'],
  ['Sidebar', 'dsh-miasaki-sidebar'],
  ['SSH', 'dsh-miasaki-ssh'],
  ['双模型', 'dsh-miasaki-dual-model'],
  ['外观', 'dsh-miasaki-appearance'],
  ['用量统计', 'dsh-miasaki-usage'],
]

const ROW_RE = /^\|\s*([^|]+?)\s*\|\s*`?([\w-]+)\/?`?\s*\|\s*([^\s|]+)\s*\|\s*$/

function readVersion(dir) {
  const pkgPath = join(ROOT, dir, 'package.json')
  if (!existsSync(pkgPath)) return null
  try { return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? null } catch { return null }
}

function ledgerBounds(text) {
  const start = text.indexOf(START_MARK)
  const end = text.indexOf(END_MARK)
  if (start === -1 || end === -1 || end < start) return null
  return { start, end }
}

/** 解析台账块里的行 → Map<目录, {name, version, raw}>。 */
function parseLedger(block) {
  const rows = new Map()
  for (const line of block.split('\n')) {
    const match = line.match(ROW_RE)
    if (match === null) continue
    const [, name, dir, version] = match
    if (dir === '线' || /^dsh-miasaki-/.test(dir) === false) continue
    rows.set(dir, { name: name.trim(), version: version.trim(), raw: line })
  }
  return rows
}

function buildLedger(existing) {
  const head = `${START_MARK} — 由 \`scripts/check-doc-versions.mjs\` 校验；改 package.json 版本后跑 \`node scripts/check-doc-versions.mjs --update\` -->`
  const lines = [
    head,
    '**版本台账**（机器校验的唯一版本来源；上表正文里的版本号是叙述，冲突以本表为准）：',
    '',
    '| 线 | 目录 | `package.json` |',
    '|---|---|---|',
  ]
  for (const [fallbackName, dir] of LINES) {
    const name = existing.get(dir)?.name ?? fallbackName
    lines.push(`| ${name} | \`${dir}/\` | ${readVersion(dir) ?? '（缺 package.json）'} |`)
  }
  lines.push(END_MARK)
  return lines.join('\n')
}

const text = readFileSync(README_PATH, 'utf8')
const bounds = ledgerBounds(text)

const actual = new Map(LINES.map(([, dir]) => [dir, readVersion(dir)]))

if (bounds === null) {
  console.error(`[doc-versions] README.md 里找不到版本台账块（${START_MARK} … ${END_MARK}）。`)
  console.error('  修法：node scripts/check-doc-versions.mjs --update 生成。')
  process.exit(1)
}

const block = text.slice(bounds.start, bounds.end)
const existing = parseLedger(block)
const args = process.argv.slice(2)

if (args.includes('--update')) {
  const rebuilt = buildLedger(existing)
  writeFileSync(README_PATH, text.slice(0, bounds.start) + rebuilt + text.slice(bounds.end), 'utf8')
  console.log(`[doc-versions] 台账已重写：${LINES.length} 条 → README.md`)
  process.exit(0)
}

const mismatches = []
const missing = []
for (const [name, dir] of LINES) {
  const row = existing.get(dir)
  if (row === undefined) { missing.push(`${name}（${dir}）`); continue }
  const want = actual.get(dir)
  if (want === null) { mismatches.push(`${dir}：package.json 缺失或不可解析`); continue }
  if (row.version !== want) mismatches.push(`${name}（${dir}）：台账 ${row.version} ≠ package.json ${want}`)
}
const unknown = [...existing.keys()].filter(dir => !LINES.some(([, known]) => known === dir))

console.log(`[doc-versions] 台账 ${existing.size} 条 / 权威 ${LINES.length} 条 — 不一致 ${mismatches.length} / 缺行 ${missing.length} / 未知行 ${unknown.length}`)
for (const [name, dir] of LINES) {
  const row = existing.get(dir)
  console.log(`  ${row !== undefined && row.version === actual.get(dir) ? 'OK  ' : 'DIFF'} ${name.padEnd(4)} ${dir.padEnd(20)} 台账 ${(row?.version ?? '—').padEnd(20)} package.json ${actual.get(dir) ?? '—'}`)
}

if (args.includes('--report')) process.exit(0)

if (mismatches.length > 0 || missing.length > 0 || unknown.length > 0) {
  for (const item of mismatches) console.error(`  不一致 ${item}`)
  for (const item of missing) console.error(`  台账缺行 ${item}`)
  for (const item of unknown) console.error(`  台账含未知目录 ${item}`)
  console.error('\n[doc-versions] 失败：README.md 的版本台账与各线 package.json 不一致。')
  console.error('  修法：node scripts/check-doc-versions.mjs --update，并复核 diff（只应动版本号那一格）。')
  process.exit(1)
}
console.log('\n[doc-versions] 版本台账与八线 package.json 一致。')
