// check-style.mjs — 仓库级文件形态与脱敏闸门（2026-09-30，`repo` 类别第 6 项）
//
// ## 为什么需要它
//
// 本仓有两条**成文但无闸门**的纪律，都属于「写在文档里、没有任何东西会拦下违反」：
//
//   ① **文件形态**（`.editorconfig` / `.gitattributes`）—— 默认 LF + UTF-8 无 BOM；
//      `ENGINEERING.md` 还记着一笔真实事故：CI 首跑因 `windows-latest` 的 `core.autocrlf`
//      把 LF 转成 CRLF，**逐字节比对类检查一次失败 8 项**。
//   ② **公开仓库脱敏**（2026-09-29 起）—— 入库内容不得含维护者身份痕迹（用户名、
//      `C:\Users\<名>\…` 绝对路径）。审计口径是「人名零命中」，但**没有任何自动检查**。
//
// 本闸门落地这两条。上线过程本身留下两笔值得记的账（都写在这里，省得后人重犯）：
//
//   · **一条被我误判的「违规」**：`grep` 扫到 fleet 归档 transcript 里 3 处
//     `C:\Users\<用户名>\…`，我一度判为「脱敏那轮漏掉的**入库**文件」。故障注入暴露了真相 ——
//     注入到那两个文件后闸门毫无反应，查 `.gitignore` 才知道它们**根本没入库**（是运行时产物），
//     而 `grep` 扫的是工作区、不是入库集。**结论：入库文件零违规**；那 3 处与派单器的落盘脱敏
//     仍然是值得做的（防的是「哪天有人把它们 un-ignore 或提交」）。
//   · **一次被闸门当场抓住的自摆乌龙**：本文件头部最初把上面那个（未证实的）路径**原样抄了进来**
//     ⇒ 提交后它成了入库文件，闸门立刻报 `[identity] scripts/check-style.mjs`。
//     教训：写「脱敏」相关说明时，**示例一律用占位**；也说明这类检查必须扫自己的源码。
//     现在这段文字本身也是判据的活样本 —— 它只出现占位写法。
//
// ## 判据（三类，判据都在文件字节上，不做启发式）
//
//   1. **无 BOM**：不以 EF BB BF 开头。
//   2. **LF only**：不含 CRLF。
//   3. **末行有换行**：最后一个字节是 LF（空文件豁免）。
//   4. **脱敏**：`C:\Users\<段>\…`（含正斜杠形态）里的 `<段>` 必须是**占位写法**
//      （`<…>` / `%…%` / `...`）；否则视为真实用户名泄漏。
//
// ## 存量冻结（`scripts/style-baseline.json`）
//
// 1–3 类有**明确接受**的存量：`dsh-miasaki-fleet/agents/*/manifest.json` 等由 PowerShell
// 写回 BOM、17 处 CRLF 是文档里记明「不批量转换以免零语义 diff 淹没真实改动」的历史文件、
// 27 处无末行换行里大半是**逐字节校验的补丁基线**（改了会让 SHA 失配）。
// 基线里的条目**缺一即报「可回收」**（不删基线 = 把「没去扫」固化成「已干净」，本仓有前车之鉴）。
// 脱敏类**没有基线**（上线时已零命中），新增即失败。
//
// ## 覆盖边界（**别把绿灯当全面保证**）
//
//   · 只扫**文本文件**：按扩展名白名单 + 前 8KB 无 NUL 判定；二进制（png/webp/exe/zip）不扫。
//   · 脱敏查**两种形态**：① 路径形态 `C:\Users\<段>\…`（段必须是占位）——**无基线、永远生效**；
//     ② 裸词形态 —— 词表来自 `_refs/identity-terms.txt`（**本地、不入库**，一行一个词、`#` 注释）。
//     词表不存在时**显式打印跳过**（CI 没有这个文件，属常态），不静默。
//     **刻意不把维护者名字写进本脚本** —— 那本身就违反脱敏纪律。
//   · 仍然抓不到：改名换姓的间接指代、图片/二进制里的痕迹、git 历史里的旧提交。
//   · 入库边界由 `git ls-files` 决定；git 不可用（受限沙箱下 spawn 走管道会 EPERM）时
//     回退**文件系统遍历**并**显式打印**回退原因 —— 不静默换口径。
//
// ## 用法
//
//   node scripts/check-style.mjs            # 闸门（CI 与本地同一套）
//   node scripts/check-style.mjs --update   # 重写存量基线（须人工复核 diff）
//   node scripts/check-style.mjs --report   # 只报告不判定（排查用）

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(ROOT, 'scripts', 'style-baseline.json')

/** 只扫这些扩展名（文本）；其余（含二进制）不判。 */
const TEXT_EXT = new Set([
  '.md', '.mjs', '.js', '.cjs', '.json', '.yml', '.yaml', '.ps1', '.rs',
  '.toml', '.css', '.ts', '.tsx', '.txt', '.html', '.schema', '.gitattributes', '.editorconfig',
])

/** 文件系统回退遍历时的跳过目录（与 check-silent-guards.mjs 同口径）。 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'target', 'vendor', '_refs', '.vs',
  '.workbuddy', '.workbuddy-ai', '.learnings', '.monkeycode', '.freebuff',
  '.cluster', '.openclaw', '.zcode', '.commandcode', 'injected',
])

const BOM = [0xEF, 0xBB, 0xBF]

/**
 * 占位写法：`<用户>` / `%USERPROFILE%` / `...` / `…` 都算「读者能懂、且不泄漏真实名字」。
 * `…`（U+2026）是首跑时漏掉的一形态 —— 桌面端 README 用它写「某个用户的路径」，
 * 被误报成了真实用户名（闸门自身的假阳性，比漏报更容易让人把闸门关掉）。
 */
const PLACEHOLDER = /^(<.*>|%.*%|\.{2,}|…)$/

/** `C:\Users\<段>` 与 `C:/Users/<段>` 两种形态。 */
const USER_PATH = /[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'`）)、，,;；]+)/g

/** 本地身份词表（**不入库**）：一行一个词，`#` 起注释。CI 里通常不存在 ⇒ 显式跳过裸词检查。 */
const IDENTITY_TERMS_PATH = join(ROOT, '_refs', 'identity-terms.txt')

/** 运行期载入的词表（main 赋值；见 IDENTITY_TERMS_PATH 的说明）。 */
let IDENTITY_TERMS = []

function listTrackedFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  if (r.error || r.status !== 0) return null
  return r.stdout.split('\0').filter(Boolean)
}

function walkFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walkFiles(full, out)
    else out.push(relative(ROOT, full).split('\\').join('/'))
  }
  return out
}

/** 裸词命中：**大小写敏感**（与 `git grep -F` 同口径）。导出给自证用。 */
function termsHit(text, terms) {
  return terms.filter(term => text.includes(term))
}

/** 读文件并判定四类；返回 problems 数组（元素 `{ rule, file, detail }`）。 */
function inspect(rel) {
  const problems = []
  let bytes
  try {
    bytes = readFileSync(join(ROOT, rel))
  } catch (error) {
    // 读不了 = **没判定**。闸门最坏的形态是「没看却说没事」，所以这里如实报成问题（不是静默跳过）。
    return [{ rule: 'unreadable', file: rel, detail: `读不了（${error instanceof Error ? error.message : String(error)}）—— 该项未被判定` }]
  }
  if (bytes.length === 0) return problems

  // 二进制：前 8KB 出现 NUL 即跳过（png/webp/exe/zip 等）
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return problems

  if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
    problems.push({ rule: 'bom', file: rel, detail: '以 UTF-8 BOM 开头（.editorconfig 约定无 BOM）' })
  }

  const text = bytes.toString('utf8')
  if (text.includes('\r\n')) {
    problems.push({ rule: 'crlf', file: rel, detail: '含 CRLF（本仓逐字节比对类检查会被它打穿）' })
  }
  if (bytes[bytes.length - 1] !== 0x0A) {
    problems.push({ rule: 'noEof', file: rel, detail: '末行没有换行符' })
  }

  // 脱敏：只在文本里找路径形态；占位写法放行
  for (const m of text.matchAll(USER_PATH)) {
    const segment = m[1]
    if (PLACEHOLDER.test(segment)) continue
    problems.push({
      rule: 'identity',
      file: rel,
      detail: `疑似真实用户名的绝对路径：${m[0]}（应改成 %USERPROFILE% 占位或中性路径）`,
    })
  }
  // 裸词形态（词表来自本地不入库文件；CI 里通常为空 ⇒ 只做路径形态）
  for (const term of termsHit(text, IDENTITY_TERMS)) {
    problems.push({
      rule: 'identity',
      file: rel,
      detail: `命中本地身份词表里的「${term}」—— 公开仓库不得含维护者身份痕迹；写示例请用占位写法`,
    })
  }
  return problems
}

/** 自证：在内存里跑一遍判定逻辑，确认四类都**真的能失败**（闸门最坏的失效形态是永远绿）。 */
function selfProof() {
  const cases = [
    { name: 'BOM', bytes: Buffer.concat([Buffer.from(BOM), Buffer.from('# x\n')]), rule: 'bom' },
    { name: 'CRLF', bytes: Buffer.from('# x\r\n'), rule: 'crlf' },
    { name: 'noEof', bytes: Buffer.from('# x'), rule: 'noEof' },
    { name: 'identity', bytes: Buffer.from('p = C:\\Users\\somebody\\x\n'), rule: 'identity' },
  ]
  const failures = []
  for (const c of cases) {
    const problems = []
    const head = c.bytes.subarray(0, 8192)
    if (!head.includes(0)) {
      if (c.bytes.length >= 3 && c.bytes[0] === BOM[0] && c.bytes[1] === BOM[1] && c.bytes[2] === BOM[2]) problems.push('bom')
      const text = c.bytes.toString('utf8')
      if (text.includes('\r\n')) problems.push('crlf')
      if (c.bytes[c.bytes.length - 1] !== 0x0A) problems.push('noEof')
      for (const m of text.matchAll(USER_PATH)) if (!PLACEHOLDER.test(m[1])) problems.push('identity')
    }
    if (!problems.includes(c.rule)) failures.push(`${c.name}（期望命中 ${c.rule}，实得 [${problems.join(',')}]）`)
  }
  // 反例：占位写法与干净文件必须**不**误报
  const clean = Buffer.from('a = C:\\Users\\<用户名>\\x\nb = C:\\Users\\%USERPROFILE%\\y\nc = C:\\Users\\...\\z\n')
  const cp = []
  const text = clean.toString('utf8')
  for (const m of text.matchAll(USER_PATH)) if (!PLACEHOLDER.test(m[1])) cp.push('identity')
  if (cp.length > 0) failures.push(`占位写法被误报：${cp.join(',')}`)

  // 裸词：命中要报，且**大小写必须敏感**（我曾用大小写不敏感的方式复核，把公开账号名
  // 「Miasakiii」误判成用户名泄漏 —— 审计口径 `git grep -F` 是大小写敏感的，闸门follow同一口径）
  if (termsHit('x IdentityProbeTerm y', ['IdentityProbeTerm']).length !== 1) {
    failures.push('裸词检查没能命中注入词')
  }
  if (termsHit('x miasakiii y', ['Miasakiii']).length !== 0) {
    failures.push('裸词检查必须大小写敏感（Miasakiii ≠ Miasakii）')
  }
  return failures
}

const args = process.argv.slice(2)
const mode = args.includes('--update') ? 'update' : args.includes('--report') ? 'report' : 'gate'

const proofFailures = selfProof()
if (proofFailures.length > 0) {
  console.error('[style] 自证失败 —— 判定逻辑坏了，闸门结果不可信：')
  for (const f of proofFailures) console.error(`  · ${f}`)
  process.exit(1)
}

let termsNote = ''
try {
  IDENTITY_TERMS = readFileSync(IDENTITY_TERMS_PATH, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
} catch (error) {
  IDENTITY_TERMS = []
  termsNote = ' 本地身份词表 _refs/identity-terms.txt 不存在 ⇒ **跳过裸词检查**（CI 常态；路径形态检查不受影响）'
}

const tracked = listTrackedFiles()
let files
let fallbackNote = ''
if (tracked === null) {
  files = walkFiles().sort()
  fallbackNote = '（git 不可用：受限沙箱下 spawn git 走管道会 EPERM ⇒ 回退文件系统遍历，与 git 口径可能略有出入）'
} else {
  files = tracked
}

const scanned = files.filter(f => TEXT_EXT.has(extname(f).toLowerCase()))
const problems = []
for (const f of scanned) problems.push(...inspect(f))

let baseline = { bom: [], crlf: [], noEof: [] }
let baselineNote = ''
try {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  baseline = { bom: parsed.bom ?? [], crlf: parsed.crlf ?? [], noEof: parsed.noEof ?? [] }
} catch (error) {
  // 基线缺失/损坏 ⇒ 按空处理 ⇒ 既有 54 处存量会**全部报成新增并 FAIL**。
  // 这是刻意的 **fail-closed**（宁可吵，不可静默放行）；把原因带出来，免得读者以为闸门抽风。
  baselineNote = ` 基线不可读（${error instanceof Error ? error.message : String(error)}）⇒ 按空处理，存量会全部报成新增`
}

const key = p => `${p.rule}|${p.file}`
const baselined = new Set([
  ...baseline.bom.map(f => `bom|${f}`),
  ...baseline.crlf.map(f => `crlf|${f}`),
  ...baseline.noEof.map(f => `noEof|${f}`),
])

const added = problems.filter(
  p => p.rule === 'identity' || p.rule === 'unreadable' || !baselined.has(key(p)),
)
const currentKeys = new Set(problems.map(key))
const gone = [...baselined].filter(k => !currentKeys.has(k))

console.log(`[style] 扫了 ${scanned.length} 个文本文件${fallbackNote} — 命中 ${problems.length} 处（BOM ${problems.filter(p => p.rule === 'bom').length} / CRLF ${problems.filter(p => p.rule === 'crlf').length} / 末行无换行 ${problems.filter(p => p.rule === 'noEof').length} / 脱敏 ${problems.filter(p => p.rule === 'identity').length} / 未判定 ${problems.filter(p => p.rule === 'unreadable').length}）${baselineNote}${termsNote}`)

if (mode === 'update') {
  const next = {
    note: '文件形态闸门（scripts/check-style.mjs）的**存量冻结**台账。**这是对既有文件的显式接受，不是背书**：'
      + 'BOM 多为 PowerShell 写回产物、CRLF 是文档记明「不批量转换」的历史文件、末行无换行多为逐字节校验的补丁基线。'
      + '新增即失败；条目消失会报「可回收」。只应由 `node scripts/check-style.mjs --update` 变更，且必须人工复核 diff。'
      + '**脱敏类刻意没有基线**（上线时零命中）—— 用户名泄漏不该有「存量」这一说。',
    bom: problems.filter(p => p.rule === 'bom').map(p => p.file).sort(),
    crlf: problems.filter(p => p.rule === 'crlf').map(p => p.file).sort(),
    noEof: problems.filter(p => p.rule === 'noEof').map(p => p.file).sort(),
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  console.log(`[style] 基线已重写：BOM ${next.bom.length} / CRLF ${next.crlf.length} / noEof ${next.noEof.length} → scripts/style-baseline.json`)
  process.exit(0)
}

console.log(`[style] 基线 ${baselined.size} 条 / 新增 ${added.length} / 可回收 ${gone.length}${baseline.bom.length + baseline.crlf.length + baseline.noEof.length === 0 ? '（基线为空）' : ''}`)

if (added.length > 0) {
  console.error('')
  for (const p of added) console.error(`[style] FAIL [${p.rule}] ${p.file} — ${p.detail}`)
}
if (gone.length > 0) {
  console.log('')
  for (const k of gone) console.log(`[style] 可回收（基线里有、当前已无）${k}`)
  console.log('[style] 基线条目「可回收」**不要照着删** —— 先确认是真修好了、还是这一项没被扫到（本仓有过把「没去扫」误读成「已干净」的教训）。')
}

if (mode === 'report') process.exit(0)
if (added.length > 0) {
  console.error('')
  console.error('[style] 失败：有新增的形态/脱敏问题。')
  console.error('  修法：① 形态问题直接把文件改成 LF + 无 BOM + 末行换行（补丁基线等逐字节校验的文件不要改，加进基线）；')
  console.error('        ② 脱敏问题把真实路径改成 %USERPROFILE% 占位或中性绝对路径；')
  console.error('        ③ 确认是刻意保留的存量 → 跑 `node scripts/check-style.mjs --update` 后**人工复核 diff**。')
  process.exit(1)
}
console.log('[style] PASS —— 无新增形态问题，也未发现疑似真实用户名路径。')
