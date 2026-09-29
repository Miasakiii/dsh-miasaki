#!/usr/bin/env node
// Markdown 链接闸门 —— 治「文档里的相对链接在仓库外必然 404」。
//
// ── 为什么需要 ───────────────────────────────────────────────────────────────
// 2026-09-29 一次性扫描发现：184 个入库文档里有 **49 处相对链接解析不到目标**，分布在 14 个
// 文件。形态高度一致 —— **路径视角不统一**：
//   · 少一层：`dsh-miasaki-*/design/` 里写 `../dsh-miasaki-shared-docs/…`（应 `../../`）
//   · 多一层：`dsh-miasaki-appearance/design/` 里写 `../../../dsh-miasaki-shared-docs/…`
//   · 根视角：`docs/` 里写 `dsh-miasaki-shared-docs/…`；`dsh-platform/` 里写 `scripts/…`
// 链接坏掉不会让程序崩，但**读者点不动**，而作者以为自己引对了 —— 与「当前态失真」同族：
// 不报错，只是把错误固化成事实。
//
// 更隐蔽的一类：链接指向 **gitignore 的目录**（`_refs/`）。本机看着完全正常，
// clone 出去必然 404 —— 本闸门对这类同样报错（判据是「目标必须**已入库**」）。
//
// 注意：`check-doc-versions.mjs` 头部曾写「断链见 check-silent-guards.mjs 的 R4」，
// 但 R4 是「声明清单缺口」，**并不覆盖文件系统层面的断链** —— 那 49 处就是这么逃过去的。
// 「注释声称覆盖、实现没覆盖」是本仓的复发形态，本闸门即补上这个真实缺口。
//
// ── 做法 ────────────────────────────────────────────────────────────────────
// 扫 `git ls-files '*.md'`，逐行提取相对链接，两项判定：
//   R1 目标不存在                        → 失败
//   R2 目标存在但未入库（clone 后没有）   → 失败
//   R3 解析后越出仓库根                   → 失败
// 豁免：在链接所在行或**紧邻的上一行**写 `<!-- md-links-ok: <理由> -->`
// （口径与 check-silent-guards 的 `guard-ok` 一致）。
//
// ── 边界（别把它当全面保证）─────────────────────────────────────────────────
//   · **只查入库的 .md**。`_refs/` / `vendor/` 等不入库内容、以及 `.js` / `.yml` / `.json`
//     里的路径字符串一律不管。
//   · **只查相对链接**。`http(s)://`、`mailto:`、`tel:`、`data:`、纯 `#anchor` 跳过
//     —— 外链可达性不在范围（那需要联网，且会引入 flaky）。
//   · **不校验锚点**。`path.md#L15-L30` 只验 `path.md` 存在；锚点是否仍指向对的内容不查
//     （那是语义判断，机器判不了）。
//   · **围栏代码块（``` / ~~~）内的示例不算链接**，已整块跳过。
//   · **逐行提取**：跨行书写的 markdown 链接（极罕见）会漏检。
//   · 非路径形态（如 `tavern-worldbook:…` 这类协议样式）按「含 scheme」跳过。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/check-md-links.mjs            # 校验（有断链 exit 1）
//   node scripts/check-md-links.mjs --list     # 只列出全部相对链接与判定，不设退出码

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIST_ONLY = process.argv.includes('--list')

/** markdown 链接 / 图片：`[text](target)`、`![alt](target)`，允许 target 被 <> 包裹并带可选 title。 */
const LINK_RE = /!?\[[^\]]*\]\(\s*<?([^)>\s]+)>?/g
/** 豁免标记（口径同 check-silent-guards 的 guard-ok：命中行或紧邻上一行）。 */
const EXEMPT_RE = /<!--\s*md-links-ok\s*:/
const FENCE_RE = /^\s*(?:```|~~~)/
/** 真外链与协议样式：`https:` `mailto:` `tavern-worldbook:` … */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function gitLines(args) {
  const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return out.split('\n').filter(Boolean)
}

/** 入库文件集，以及由它们反推的「入库目录集」（用于判定链到目录的情况）。 */
const tracked = new Set(gitLines(['ls-files']).map(toPosix))
const trackedDirs = new Set()
for (const f of tracked) {
  let d = dirname(f)
  while (d && d !== '.' && d !== '/' && d !== '') {
    trackedDirs.add(toPosix(d))
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
}

function toPosix(p) {
  return p.replace(/\\/g, '/')
}

function isTracked(rel) {
  return tracked.has(rel) || trackedDirs.has(rel)
}

const problems = []
const allLinks = []
let linkCount = 0
let fileCount = 0

for (const file of gitLines(['ls-files', '*.md'])) {
  const abs = join(ROOT, file)
  // 刻意不写 `if (!existsSync(abs)) continue` —— `git ls-files` 的输出即权威，
  // 万一它列出已被删除的文件，readFileSync 会**响亮抛错**，比静默跳过更有用。
  fileCount++
  const dir = toPosix(dirname(file))
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE_RE.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    for (const m of line.matchAll(LINK_RE)) {
      const raw = m[1].trim()
      if (raw === '' || raw.startsWith('#')) continue
      if (SCHEME_RE.test(raw)) continue        // 外链 / 协议样式，一律不管
      const bare = raw.split('#')[0]
      if (bare === '') continue
      linkCount++
      const exempt = EXEMPT_RE.test(line) || (i > 0 && EXEMPT_RE.test(lines[i - 1]))
      let decoded = bare
      // 非法百分号转义时回退为字面比对 —— 刻意如此，且不改变判定语义
      // （回退后照旧走「目标必须存在」+「目标必须已入库」两条判定，不会把断链放过。）
      // guard-ok: 回退不改变判定语义（口径：须紧邻命中行，故写在注释块最后一行）
      try { decoded = decodeURIComponent(bare) } catch { /* 按字面比对 */ }
      const resolved = toPosix(normalize(join(dir === '.' ? '' : dir, decoded)))
      // 目录型链接带尾斜杠（如 `design/`），去尾斜杠才能与 trackedDirs / tracked 比对。
      const rel = toPosix(normalize(resolved)).replace(/\/+$/, '') || '.'
      allLinks.push({ file, line: i + 1, raw, rel, exempt })
      if (exempt) continue
      if (rel.startsWith('..')) {
        problems.push({ file, line: i + 1, raw, kind: 'R3 越出仓库根' })
        continue
      }
      if (!existsSync(join(ROOT, rel))) {
        problems.push({ file, line: i + 1, raw, kind: 'R1 目标不存在' })
        continue
      }
      if (!isTracked(rel)) {
        problems.push({ file, line: i + 1, raw, kind: 'R2 目标未入库（clone 后必断）' })
      }
    }
  }
}

if (LIST_ONLY) {
  console.log(`[md-links] ${fileCount} 个入库文档 / ${linkCount} 个相对链接`)
  for (const l of allLinks) {
    console.log(`  ${l.exempt ? '豁免' : '    '}  ${l.file}:${l.line}  →  ${l.raw}`)
  }
  process.exitCode = 0
} else if (problems.length === 0) {
  console.log(`[md-links] PASS —— ${fileCount} 个入库文档 / ${linkCount} 个相对链接，全部解析到已入库目标`)
} else {
  console.error(`[md-links] FAIL ${problems.length} 处断链（扫了 ${fileCount} 个文档 / ${linkCount} 个相对链接）：`)
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}`)
    console.error(`      ${p.kind}  →  ${p.raw}`)
  }
  console.error('[md-links] 修法：把路径改成相对**该文件**的正确形式；若目标本就不入库，改成反引号代码路径（别做链接）。')
  process.exitCode = 1
}
