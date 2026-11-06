#!/usr/bin/env node
// scripts/verify-record.mjs — verify-all 的结果落账（--record）与回放（--replay）。
//
// 借鉴来源：字节跳动技术团队《让改进有迹可循：Storage Agent Family Eval 工程实践》（2026-11-03）
// §2.2「沙箱运行与评估打分相互独立，调整评分规则时基于已保存的运行结果重评，无需重跑沙箱」。
// **改形理由（诚实边界）**：文章保存的是可重评的「运行轨迹」；本仓的 Code 评估器**判定即运行** ——
// 每个闸门当场扫当前代码库并当场判退出码（verify-all.mjs 的 run() → code），没有可分离保存的
// 轨迹，对旧状态重放等于把旧代码 checkout 回来，成本远超收益。因此本脚本只做两件确定收益的事：
//   ① 落账：每次全量追加一行 JSONL（分组统计 + 每项 exit code 与耗时）；
//   ② 回放：只读历史记录，输出与当次同构的汇总 + **闸门项名集合对账**（防改名漂移，与
//      doc-versions 互补：后者盯版本号，本机制盯项名集合）+ 逐项重判。
// 设计提案：_refs/internal-plans/article-borrow-2026-11-04-storage-agent-eval.md（规划类，不入库）。
//
// 判据（接线后验收，含反向）：
//   1. --record 全绿后 _refs/regression-log.jsonl 末行是合法 JSON，summary.total 等于实际项数；
//   2. --replay 的 byLine 汇总由逐项 code 重判；集合对账能报出「新增 / 退役」闸门；
//   3. 反向：把历史行某 code 改成 1 ⇒ --replay 必须退出码 1 且在失败项里点名（证明真在读文件，
//      不是打印缓存）；summary/byLine 谎报全绿仍须以逐项 code 重判；从历史行删掉一项 ⇒ 集合对账必须报「退役」；
//   4. 记账不得挡回归：appendRecord 写失败只警告、不影响 verify-all 退出码（返回 {ok:false}，不抛）；
//   5. 无 flag 调用 verify-all 与今天逐字节等价（输出与退出码均不变；byGroup 只在 --record 时打印）。
//
// 自证：node scripts/verify-record.mjs --selftest（正例 + 反例，见 selfTest()）。

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'

/** 落账文件默认位置（归档区，不入库、不进 CI；与 _refs/internal-plans/ 同属约定归档）。 */
export const DEFAULT_RECORD_PATH = '_refs/regression-log.jsonl'

/**
 * 分组规则（按优先级）：repo 线 → governance；name 以 `syntax ` 开头 → syntax；
 * 以 `test ` / `cargo test ` 开头 → test；其余 → contract。
 * 规则刻意宽松：新增闸门忘记归类时落进 contract，不会丢统计 —— 分组是观察项，不是闸门。
 */
export function groupOf(line, name) {
  if (line === 'repo') return 'governance'
  if (name.startsWith('syntax ')) return 'syntax'
  if (name.startsWith('test ') || name.startsWith('cargo test')) return 'test'
  return 'contract'
}

/** 本地时间 ISO 串（带偏移，如 2026-11-04T12:40:00+08:00）—— 台账是人看的，不用 UTC。 */
export function localIso(now = new Date()) {
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return `${stamp}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** git short HEAD；取不到降级 null（归档字段，缺失不影响任何判定 —— 与判据 4 同源）。 */
export function gitShort(root) {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
    return out || null
  } catch {
    return null // guard-ok: git 缺席（沙箱 EPERM / 非 git 树）是已知环境态，降级 null 并继续，不是静默吞错
  }
}

/**
 * 把一次全量的 results 汇总成一条可落账的记录。
 * results: [{ line, name, code, ms }]（cmd/args/cwd 刻意不入账 —— 归档不复制本机路径）。
 */
export function summarize({ results, selected, root }) {
  const items = results.map(result => ({
    line: result.line,
    name: result.name,
    code: result.code,
    ms: result.ms ?? null,
  }))
  const pass = items.filter(item => item.code === 0).length
  const byLine = {}
  for (const line of selected) {
    const own = items.filter(item => item.line === line)
    const ownPass = own.filter(item => item.code === 0).length
    byLine[line] = { pass: ownPass, fail: own.length - ownPass }
  }
  const byGroup = {}
  for (const item of items) {
    const group = groupOf(item.line, item.name)
    byGroup[group] = (byGroup[group] ?? 0) + 1
  }
  return {
    ts: localIso(),
    git: gitShort(root),
    node: process.version,
    selected,
    summary: { total: items.length, pass, fail: items.length - pass },
    byLine,
    byGroup,
    items,
  }
}

/**
 * 追加一行 JSONL。写失败返回 {ok:false, error} 而**不抛** —— 判据 4：记账不得挡回归。
 * 调用方必须对 ok:false 显式警告（check-silent-guards 的 R2：失败必须说出来）。
 */
export function appendRecord(file, record) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/**
 * 读 JSONL。坏行**不静默跳过** —— 返回 badLines（行号 + 原因），调用方显式失败：
 * 判据 3 的反向依赖「改坏历史行必须被读到」，静默跳过会让回放变成假回放。
 */
export function readRecords(file) {
  const text = readFileSync(file, 'utf8')
  const records = []
  const badLines = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      badLines.push(`${index + 1}: ${error.message}`)
    }
  }
  return { records, badLines }
}

/** 项名集合对账：added = 当前有历史无（新增闸门）；retired = 历史有当前无（退役/改名）。 */
export function diffNames(historyNames, currentNames) {
  const history = new Set(historyNames)
  const current = new Set(currentNames)
  return {
    added: [...current].filter(name => !history.has(name)),
    retired: [...history].filter(name => !current.has(name)),
  }
}

/**
 * 回放判据只认逐项 `code`，不信任可能已经损坏/漂移的 `summary` 或 `byLine`。
 * 否则一条 `code=1 / summary.fail=0` 的历史记录会打印失败项却仍返回 0（假绿）。
 */
export function tallyReplay(record) {
  const names = Array.isArray(record.selected) && record.selected.length > 0
    ? [...record.selected]
    : []
  const byLine = Object.fromEntries(names.map(name => [name, { pass: 0, fail: 0 }]))
  const failed = []
  for (const item of record.items ?? []) {
    if (!byLine[item.line]) {
      names.push(item.line)
      byLine[item.line] = { pass: 0, fail: 0 }
    }
    if (item.code === 0) byLine[item.line].pass += 1
    else {
      byLine[item.line].fail += 1
      failed.push(item)
    }
  }
  return { names, byLine, failed }
}

/** 回放报告（人看）。历史里的失败项必须逐条点名 —— 判据 3 的可见面。 */
export function formatReplay(record, diff) {
  const tally = tallyReplay(record)
  const lines = []
  lines.push(`[verify-record] 回放：${record.ts} · git ${record.git ?? '（不可用）'} · node ${record.node ?? '（不可用）'}`)
  for (const name of tally.names) {
    const stat = tally.byLine[name]
    lines.push(`  ${stat.fail === 0 ? 'PASS' : 'FAIL'}  ${name}: ${stat.pass}/${stat.pass + stat.fail}`)
  }
  if (tally.failed.length > 0) {
    lines.push('失败项（历史记录）：')
    for (const item of tally.failed) lines.push(`  [${item.line}] ${item.name} → exit ${item.code}`)
  }
  const mismatch = []
  if (record.summary && (record.summary.total !== (record.items ?? []).length || record.summary.fail !== tally.failed.length)) {
    mismatch.push(`summary=${JSON.stringify(record.summary)}，逐项=${JSON.stringify({ total: (record.items ?? []).length, fail: tally.failed.length })}`)
  }
  if (record.byLine && JSON.stringify(record.byLine) !== JSON.stringify(tally.byLine)) {
    mismatch.push('byLine 与逐项记录不一致')
  }
  if (mismatch.length > 0) lines.push(`  ⚠ 历史汇总字段与逐项记录不一致（${mismatch.join(' / ')}）—— 以逐项重判为准`)
  lines.push('集合对账（当前代码 vs 历史记录）：')
  if (diff.added.length > 0) lines.push(`  新增闸门（当前有、历史无，需补跑一次全量）：${diff.added.join(' / ')}`)
  if (diff.retired.length > 0) lines.push(`  退役闸门（历史有、当前无，改名/退役需登记）：${diff.retired.join(' / ')}`)
  if (diff.added.length === 0 && diff.retired.length === 0) lines.push('  一致')
  return lines.join('\n')
}

/* ---------------------------------- 自证 ---------------------------------- */

function selfTest() {
  const cases = []
  const test = (name, fn) => {
    try {
      fn()
      cases.push({ ok: true, name })
    } catch (error) {
      cases.push({ ok: false, name, message: error.message })
    }
  }
  const eq = (actual, expected, what) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    }
  }
  const tmp = join(tmpdir(), `verify-record-selftest-${process.pid}`)
  mkdirSync(tmp, { recursive: true })

  // 正例：五条分组规则各有命中
  test('groupOf：五分组各归其位', () => {
    eq(groupOf('repo', 'style (文件形态 + 脱敏)'), 'governance', 'repo 线')
    eq(groupOf('desktop', 'syntax plugins/x/index.js'), 'syntax', 'syntax 前缀')
    eq(groupOf('fleet', 'test liveness (F3 心跳判活)'), 'test', 'test 前缀')
    eq(groupOf('desktop', 'cargo test (pulse stale 语义)'), 'test', 'cargo test 前缀')
    eq(groupOf('desktop', 'patch verify (模型设置补丁可重建)'), 'contract', '其余归 contract')
    eq(groupOf('appearance', 'derive-skins --check'), 'contract', '未知形态不丢统计')
  })

  // 正例：汇总计数（含 fail 与 byLine / byGroup）
  test('summarize：计数与分组正确', () => {
    const record = summarize({
      root: tmp,
      selected: ['desktop', 'repo'],
      results: [
        { line: 'desktop', name: 'syntax a.js', code: 0, ms: 5 },
        { line: 'desktop', name: 'test a.test.js', code: 1, ms: 7 },
        { line: 'repo', name: 'style (文件形态 + 脱敏)', code: 0, ms: 3 },
      ],
    })
    eq(record.summary, { total: 3, pass: 2, fail: 1 }, 'summary')
    eq(record.byLine, { desktop: { pass: 1, fail: 1 }, repo: { pass: 1, fail: 0 } }, 'byLine')
    eq(record.byGroup, { syntax: 1, test: 1, governance: 1 }, 'byGroup')
  })

  // 反向：只数 PASS 不数 FAIL 的实现必须在这里转红
  test('summarize·反向：code=1 必须计入 fail 且 byLine 体现', () => {
    const record = summarize({
      root: tmp,
      selected: ['desktop'],
      results: [
        { line: 'desktop', name: 'syntax a.js', code: 0, ms: 5 },
        { line: 'desktop', name: 'syntax b.js', code: 1, ms: 5 },
      ],
    })
    eq(record.summary.fail, 1, 'fail 计数')
    eq(record.byLine.desktop, { pass: 1, fail: 1 }, 'byLine 的 fail')
  })

  // 正例：集合对账识别新增与退役
  test('diffNames：新增与退役各就各位', () => {
    const diff = diffNames(['a', 'b'], ['b', 'c'])
    eq(diff.added, ['c'], 'added')
    eq(diff.retired, ['a'], 'retired')
  })

  // 正例 + 判据 4：写失败返回 ok:false 且不抛（file 指向目录必 EISDIR，与权限无关）
  test('appendRecord：不可写返回 ok:false 不抛（判据 4）', () => {
    const result = appendRecord(tmp, { summary: {} })
    eq(result.ok, false, 'ok')
    if (!result.error) throw new Error('必须带 error 原因（失败要说得出来）')
  })

  // 正例 + 判据 1/3：round-trip，坏行显式报出（不静默跳过）
  test('readRecords：round-trip 一致，坏行显式失败', () => {
    const file = join(tmp, 'good.jsonl')
    const record = summarize({
      root: tmp,
      selected: ['repo'],
      results: [{ line: 'repo', name: 'style (文件形态 + 脱敏)', code: 0, ms: 3 }],
    })
    eq(appendRecord(file, record).ok, true, '追加')
    const first = readRecords(file)
    eq(first.badLines, [], '坏行')
    eq(first.records.length, 1, '行数')
    eq(first.records[0], record, 'round-trip 深度相等')
    writeFileSync(join(tmp, 'bad.jsonl'), '{"ok":true}\nnot-json\n', 'utf8')
    const second = readRecords(join(tmp, 'bad.jsonl'))
    eq(second.records.length, 1, '坏行不静默：好行仍读出')
    if (second.badLines.length !== 1) throw new Error('坏行必须被点名')
  })

  // 判据 3 的可见面：历史失败项必须出现在回放文本里
  test('formatReplay：历史失败项逐条点名', () => {
    const text = formatReplay(
      {
        ts: '2026-11-04T12:40:00+08:00',
        git: 'abc1234',
        node: 'v22.19.0',
        byLine: { desktop: { pass: 1, fail: 1 } },
        items: [
          { line: 'desktop', name: 'syntax a.js', code: 0 },
          { line: 'desktop', name: 'test a.test.js', code: 1 },
        ],
      },
      { added: [], retired: [] },
    )
    if (!text.includes('[desktop] test a.test.js → exit 1')) throw new Error('失败项未点名')
    if (!text.includes('FAIL  desktop: 1/2')) throw new Error('byLine 未体现失败')
  })

  // 判据 3 的退出面：summary/byLine 谎报全绿时，逐项 code 必须重新判为失败
  test('tallyReplay：汇总字段不得压过逐项失败', () => {
    const record = {
      summary: { total: 1, pass: 1, fail: 0 },
      byLine: { canvas: { pass: 1, fail: 0 } },
      items: [{ line: 'canvas', name: 'syntax index.js', code: 1 }],
    }
    const tally = tallyReplay(record)
    eq(tally.failed.length, 1, 'failed')
    eq(tally.byLine.canvas, { pass: 0, fail: 1 }, '重判 byLine')
    const text = formatReplay(record, { added: [], retired: [] })
    if (!text.includes('FAIL  canvas: 0/1')) throw Error(`汇总谎报未纠正：\n${text}`)
    if (!text.includes('以逐项重判为准')) throw Error('未报告汇总字段不一致')
  })

  rmSync(tmp, { recursive: true, force: true })

  const failed = cases.filter(item => !item.ok)
  for (const item of cases) console.log(`${item.ok ? 'ok' : 'not ok'} - ${item.name}${item.ok ? '' : ` — ${item.message}`}`)
  console.log(`\n${cases.length - failed.length}/${cases.length} 通过`)
  if (failed.length > 0) process.exitCode = 1
}

if (process.argv.includes('--selftest')) {
  selfTest()
}
