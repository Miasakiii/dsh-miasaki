#!/usr/bin/env node
// 锁文件同步闸门 —— 治「改了 package.json 忘了同步锁文件 ⇒ CI 红在装依赖那一步」。
//
// ── 为什么需要 ───────────────────────────────────────────────────────────────
// 2026-09-29 20:44 提交 `8181b89`（七个 web 插件补 peerDependencies）只改了
// `package.json`、没跑 install。此后到 09-30 00:21 的 **11 次推送全部红**，而且红的
// 不是测试：CI 的第 7 步 `pnpm install --frozen-lockfile` 直接以
//   [ERR_PNPM_OUTDATED_LOCKFILE] … specifiers in the lockfile don't match specifiers in package.json
//   * 2 dependencies were added: @deepseek-ai/cordis@^4.0.2, @deepseek-ai/dsh-host-webserver@>=0.1.2-rc.1 <0.3.0
// 退出，第 8/9/10 步（ssh 安装 / desktop 安装 / **九线统一回归**）全部 skipped。
// 也就是说那 3 小时里仓库看起来「CI 在跑」，实际**一个测试都没执行** —— 期间合入的改动
// （dual-model 静默丢图修复、七个包发布就绪等）在 CI 侧从未被验证过。
//
// 为什么本机看不见：本机跑 `pnpm install` **不带** `--frozen-lockfile`，会自动补齐并
// **静默改写工作区**（CI 的 frozen 是默认行为，故本机越是顺手跑过 install 越看不见）。
// 这是「本机全绿 ≠ CI 绿」的第二种成因；第一种（Node 22 与 24 对 pending promise 的
// 宽严差异）见 .github/workflows/verify-all.yml 尾注。
//
// ── 判据 ────────────────────────────────────────────────────────────────────
// 不做全量 YAML 解析，只比对**直接依赖的 specifier**，两侧都换算成「包名 → specifier」：
//   · `pnpm-lock.yaml`    → `importers['.']` 四个依赖段里每个包的 `specifier`
//   · `package-lock.json` → `packages['']` 四个依赖段的同名项
// 差异三类：package.json 有而锁文件无（缺登记）/ 反之（多登记）/ 两侧 specifier 不一致。
//
// **pnpm 侧刻意跨字段合并比对**：`autoInstallPeers: true` 时，package.json 的
// peerDependencies 在锁文件里登记进的是 **dependencies** 段 —— 本仓 sidebar 实测：
// package.json 有 2 个 peerDependencies（cordis / dsh-host-webserver），锁文件
// `importers.dependencies` 里多了同名的两项。按字段名逐段对齐会立刻误报。
//
// ── 边界（别把它当全面保证）─────────────────────────────────────────────────
//   · 只比 specifier，**不校验解析结果**（version / integrity / 传递依赖闭包）—— 那是
//     `--frozen-lockfile` 与 `npm ci` 自己的职责。本闸门的价值是**在推送前**把 CI 会红
//     的那一类差异报出来，不是取代它们。
//   · 只扫 `dsh-miasaki-*` 下**已存在的**锁文件；没有锁文件的线不判 —— 本仓有六条线是
//     peerDependencies-only 的纯插件（不装依赖，CI 也不装它们）。
//   · 覆盖不到的：npm 的 `overrides`、pnpm 的 `patchedDependencies` 等改写规则；
//     以及「锁文件整个被删」这类（那会让 CI 在 `--frozen-lockfile` 处直接报缺锁文件）。
//
// ── 自证（每次运行都跑，不可用 `--skip-self-test` 关闭）──────────────────────
// 闸门最坏的失效形态是「解析器坏掉 ⇒ 永远绿」。故内置 fixture 双向断言：
//   反例（锁文件与 package.json 同步）**必须零差异**；
//   正例（锁文件停在补 peerDependencies 之前）**必须报出那 2 条缺登记**。
// 正例用的就是 8181b89 事故的真实形态；fixture 里还带 `packages:` 段，用来钉住
// 「解析器不会把 packages 段的依赖误当成 importer 的直接依赖」。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/check-lock-sync.mjs                # 校验（有差异 exit 1）
//   node scripts/check-lock-sync.mjs --root <dir>   # 换仓库根跑（复现历史故障 / 自测）

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

const argv = process.argv.slice(2)
const rootFlag = argv.indexOf('--root')
if (rootFlag !== -1 && argv[rootFlag + 1] === undefined) {
  console.error('[lock-sync] 失败：`--root` 后面缺少目录参数。')
  process.exit(2)
}
const ROOT = rootFlag === -1
  ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  : resolve(argv[rootFlag + 1])

/* ---------- 取值工具 ---------- */

/** 去掉 YAML 标量的包裹引号（pnpm 对含 `>` `=` 之类的值会加单引号）。刻意不做类型推断。 */
function unquote(value) {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1)
  return v
}

function readJson(abs) {
  // 刻意不包 try/catch：读不到或不是合法 JSON 都必须**响亮抛错**。
  // 静默回退成 `{}` 会让闸门把「读不出来」当成「没有依赖」，正好是它要抓的失效形态。
  // 去 BOM 是唯一的宽容：它对 JSON 语义毫无影响，但 Windows 侧用 PowerShell 写文件极易
  // 带上它（本闸门 `--root` 自测时实测踩到），留着只会把「文件没问题」报成语法错误。
  const text = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

/** package.json 的四个依赖字段合并成「包名 → specifier」。 */
function pkgDepsOf(pkg) {
  const out = new Map()
  for (const field of DEP_FIELDS) {
    const deps = pkg[field]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, spec] of Object.entries(deps)) out.set(name, String(spec))
  }
  return out
}

/* ---------- pnpm-lock.yaml：只解析 importers['.'] 的直接依赖 ---------- */

/**
 * 按缩进层级读 `importers:` 段（pnpm 生成的结构固定）：
 *   0 空格 = 顶层 key（`importers:` 开始 / `packages:` 等结束）
 *   2 空格 = importer 名（本仓无 workspace，只有一个 `.`）
 *   4 空格 = 依赖段名（dependencies / devDependencies / …）
 *   6 空格 = 包名
 *   8 空格 = 该包的 `specifier:` / `version:`
 * 返回 Map<段名, Map<包名, specifier>>。
 */
function parsePnpmImporters(text) {
  const out = new Map()
  let inImporters = false
  let importerName = null
  let field = null
  let name = null
  for (const raw of text.split(/\r?\n/)) {
    const body = raw.trim()
    if (body === '' || body.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    if (indent === 0) {
      inImporters = body === 'importers:'
      importerName = null
      field = null
      name = null
      continue
    }
    if (!inImporters) continue
    if (indent === 2) {
      importerName = unquote(body.replace(/:\s*$/, ''))
      field = null
      name = null
      continue
    }
    if (importerName !== '.') continue
    if (indent === 4) {
      const key = unquote(body.replace(/:\s*$/, ''))
      field = DEP_FIELDS.includes(key) ? key : null
      name = null
      continue
    }
    if (field === null) continue
    if (indent === 6) {
      name = unquote(body.replace(/:\s*$/, ''))
      if (!out.has(field)) out.set(field, new Map())
      out.get(field).set(name, null)
      continue
    }
    if (indent === 8 && name !== null && body.startsWith('specifier:')) {
      out.get(field).set(name, unquote(body.slice('specifier:'.length)))
    }
  }
  return out
}

/* ---------- package-lock.json：packages[''] 的直接依赖 ---------- */

/** 返回 Map<段名, Map<包名, specifier>>；缺 `packages['']` 时返回 null（由调用方显式失败）。 */
function parseNpmImporter(lock) {
  const rootPkg = lock.packages?.['']
  if (!rootPkg) return null
  const out = new Map()
  for (const field of DEP_FIELDS) {
    const deps = rootPkg[field]
    if (!deps || typeof deps !== 'object') continue
    const m = new Map()
    for (const [name, spec] of Object.entries(deps)) m.set(name, String(spec))
    out.set(field, m)
  }
  return out
}

/* ---------- 比对 ---------- */

function flatten(fields) {
  const merged = new Map()
  for (const m of fields.values()) for (const [name, spec] of m) merged.set(name, spec)
  return merged
}

function diffDeps(pkgDeps, lockDeps) {
  const missing = []
  const extra = []
  const mismatch = []
  for (const [name, spec] of pkgDeps) {
    if (!lockDeps.has(name)) missing.push(`${name}@${spec}`)
    else if (lockDeps.get(name) !== spec) mismatch.push(`${name}: package.json=${spec} / 锁文件=${lockDeps.get(name)}`)
  }
  for (const [name, spec] of lockDeps) {
    if (!pkgDeps.has(name)) extra.push(`${name}@${spec}`)
  }
  return { missing, extra, mismatch }
}

const total = d => d.missing.length + d.extra.length + d.mismatch.length

/* ---------- 自证 ---------- */

/** 8181b89 事故的真实形态：package.json 有 2 个 peerDependencies，锁文件停在补它们之前。 */
const FIXTURE_PKG = {
  name: 'fixture',
  dependencies: { '@xterm/xterm': '5.5.0', ws: '^8.21.3' },
  peerDependencies: {
    '@deepseek-ai/cordis': '^4.0.2',
    '@deepseek-ai/dsh-host-webserver': '>=0.1.2-rc.1 <0.3.0',
  },
}
const FIXTURE_LOCK_DEP_ENTRIES = [
  "      '@deepseek-ai/cordis':",
  '        specifier: ^4.0.2',
  '        version: 4.0.4',
  "      '@deepseek-ai/dsh-host-webserver':",
  "        specifier: '>=0.1.2-rc.1 <0.3.0'",
  '        version: 0.1.2-rc.1',
]
const fixtureLock = extraEntries => [
  "lockfileVersion: '9.0'",
  '',
  'settings:',
  '  autoInstallPeers: true',
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  "      '@xterm/xterm':",
  '        specifier: 5.5.0',
  '        version: 5.5.0',
  ...extraEntries,
  '      ws:',
  '        specifier: ^8.21.3',
  '        version: 8.21.3',
  '',
  'packages:',
  '',
  "  '@xterm/xterm@5.5.0':",
  '    resolution: {integrity: sha512-fixture}',
  '    dependencies:',
  "      '@xterm/addon-fit':",
  '        specifier: 0.10.0',
  '        version: 0.10.0',
  '',
].join('\n')

function selfTest() {
  const failures = []
  const pkgDeps = pkgDepsOf(FIXTURE_PKG)

  const synced = diffDeps(pkgDeps, flatten(parsePnpmImporters(fixtureLock(FIXTURE_LOCK_DEP_ENTRIES))))
  if (total(synced) !== 0) {
    failures.push(`反例（同步）本应零差异，实得 ${total(synced)} 处：${JSON.stringify(synced)}`)
  }

  const stale = diffDeps(pkgDeps, flatten(parsePnpmImporters(fixtureLock([]))))
  if (stale.missing.length !== 2 || stale.extra.length !== 0 || stale.mismatch.length !== 0) {
    failures.push(`正例（锁文件停在补 peerDependencies 之前）本应报 2 条缺登记，实得：${JSON.stringify(stale)}`)
  }

  // packages 段里带 dependencies（上例 '@xterm/xterm@5.5.0'）—— 若解析器没在 `packages:`
  // 处收手，'@xterm/addon-fit' 会被误当成 importer 的直接依赖 ⇒ 上面的反例就会报 1 条
  // 「多登记」而必须零差异，故该失效形态由第一条断言捕获，此处不另设断言。

  // specifier 不一致必须被抓到（不能只查「在不在」）。
  const drifted = diffDeps(pkgDeps, flatten(parsePnpmImporters(
    fixtureLock(FIXTURE_LOCK_DEP_ENTRIES).replace('specifier: ^8.21.3', 'specifier: ^8.20.0'),
  )))
  if (drifted.mismatch.length !== 1) {
    failures.push(`specifier 漂移本应报 1 条不一致，实得：${JSON.stringify(drifted)}`)
  }

  // npm 侧同判据（结构不同、语义相同）。
  const npmLock = { packages: { '': { dependencies: { '@xterm/xterm': '5.5.0', ws: '^8.21.3' }, peerDependencies: { '@deepseek-ai/cordis': '^4.0.2', '@deepseek-ai/dsh-host-webserver': '>=0.1.2-rc.1 <0.3.0' } } } }
  const npmSynced = diffDeps(pkgDeps, flatten(parseNpmImporter(npmLock)))
  if (total(npmSynced) !== 0) {
    failures.push(`npm 反例（同步）本应零差异，实得：${JSON.stringify(npmSynced)}`)
  }
  const npmStale = diffDeps(pkgDeps, flatten(parseNpmImporter({ packages: { '': { dependencies: { '@xterm/xterm': '5.5.0', ws: '^8.21.3' } } } })))
  if (npmStale.missing.length !== 2) {
    failures.push(`npm 正例本应报 2 条缺登记，实得：${JSON.stringify(npmStale)}`)
  }

  return failures
}

/* ---------- 主流程 ---------- */

const selfTestFailures = selfTest()
if (selfTestFailures.length > 0) {
  console.error('[lock-sync] 失败：自证未通过 —— 解析器或比对逻辑已坏，本闸门的绿灯不可信。')
  for (const f of selfTestFailures) console.error(`  · ${f}`)
  process.exit(1)
}

const lineDirs = readdirSync(ROOT, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith('dsh-miasaki-'))
  .map(entry => entry.name)
  .sort()

const LOCK_KINDS = [['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm']]
const targets = []
for (const line of lineDirs) {
  for (const [file, kind] of LOCK_KINDS) {
    const abs = join(ROOT, line, file)
    if (existsSync(abs)) targets.push({ line, rel: `${line}/${file}`, abs, kind })
  }
}
if (targets.length === 0) {
  console.error(`[lock-sync] 失败：在 ${ROOT} 下未找到任何锁文件 —— 闸门无事可做，属配置错误。`)
  process.exit(1)
}

console.log(`[lock-sync] 自证通过（fixture 正反例 + 漂移 + npm 侧）— 扫描 ${lineDirs.length} 个线目录 / ${targets.length} 个锁文件`)

let bad = 0
let totalDeps = 0
for (const target of targets) {
  const pkgDeps = pkgDepsOf(readJson(join(ROOT, target.line, 'package.json')))
  const lockFields = target.kind === 'pnpm'
    ? parsePnpmImporters(readFileSync(target.abs, 'utf8'))
    : parseNpmImporter(readJson(target.abs))
  if (lockFields === null) {
    console.error(`  ${target.rel}: 锁文件里没有 packages[""] 段（lockfileVersion 1 的旧格式？）`)
    console.error('    本闸门无法校验该形态 —— 请升级锁文件，或在本脚本的 parseNpmImporter 里补该分支。')
    bad++
    continue
  }
  const lockDeps = flatten(lockFields)
  totalDeps += lockDeps.size
  // 「解析不出任何登记、而 package.json 明明有依赖」= 锁文件格式变了，必须报出来，
  // 否则闸门会以「两侧都空」的姿态静默放过。
  if (lockDeps.size === 0 && pkgDeps.size > 0) {
    console.error(`  ${target.rel}: 从锁文件里读不出任何直接依赖登记，而 package.json 有 ${pkgDeps.size} 个 —— 锁文件结构可能已变，本闸门的解析器需要跟进。`)
    bad++
    continue
  }
  const d = diffDeps(pkgDeps, lockDeps)
  if (total(d) === 0) continue
  bad++
  console.error(`  ${target.rel} 与 ${target.line}/package.json 不一致：`)
  for (const x of d.missing) console.error(`      缺登记（package.json 有、锁文件无）: ${x}`)
  for (const x of d.extra) console.error(`      多登记（锁文件有、package.json 无）: ${x}`)
  for (const x of d.mismatch) console.error(`      specifier 不一致: ${x}`)
}

if (bad > 0) {
  console.error(`\n[lock-sync] 失败：${bad}/${targets.length} 个锁文件与 package.json 不一致。`)
  console.error('  CI 会在「安装 XX 线依赖」那一步以 ERR_PNPM_OUTDATED_LOCKFILE（或 npm ci 的同类报错）退出，')
  console.error('  后续步骤（含九线统一回归）全部 skipped —— 看起来像测试挂了，其实一个测试都没跑。')
  console.error('  修法：在对应线目录跑一次 `pnpm install`（desktop 是 `npm install`），把锁文件改动一并提交。')
  process.exit(1)
}
console.log(`[lock-sync] PASS —— ${targets.length} 个锁文件 / ${totalDeps} 条直接依赖登记，与各自 package.json 一致`)
for (const target of targets) console.log(`  ${target.kind.padEnd(4)} ${target.rel}`)
