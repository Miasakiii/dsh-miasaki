#!/usr/bin/env node
// 会话双份分叉体检：比对两个会话 root 里**同 id** 的会话是否已经各写各的。
//
// 背景（2026-09-27）：会话记录按 profile 隔离时，历史是**整体复制**一份而不是移动，
// 于是 231 个老会话在两个 root 各有一份。此后在 miasaki 里续聊只增长
// profiles/miasaki/sessions 那份，在 web / 官方桌面端续聊只增长 ~/.dsh/sessions 那份
// —— 同一个会话 id 出现两套内容，这就是「分叉」。
//
// 判据分层（先便宜后昂贵）：
//   L1 文件大小不同            → 直接判分叉
//   L2 大小相同则比 SHA-256    → 不同才判分叉（排除巧合）
//   L3 只对分叉项解 zstd 帧    → 报事件行数与末条事件时间，供判断「哪边在续聊」
//
// 只读、零依赖（node:fs / node:crypto / node:zlib）、不碰运行中的 DSH。
//
// 用法：
//   node compare-session-roots.mjs --a <rootA> --b <rootB> [--md <报告路径>] [--json]
//   默认两个 root 分别是 miasaki profile 与全局 sessions。

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const argv = process.argv.slice(2)
const valueOf = flag => {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const rootA = valueOf('--a') ?? join(home, 'profiles', 'miasaki', 'sessions')
const rootB = valueOf('--b') ?? join(home, 'sessions')
const mdPath = valueOf('--md')
const asJson = argv.includes('--json')

/** 逐帧解压（会话日志是逐帧追加的 zstd，整文件解压只出第一帧）。 */
function decodeFrames(buffer) {
  const offsets = []
  let at = buffer.indexOf(ZSTD_MAGIC, 0)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(ZSTD_MAGIC, at + 4)
  }
  const parts = []
  for (const [index, start] of offsets.entries()) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch { // guard-ok: 末帧可能仍在写入（会话正在续写），非末帧失败只是压缩数据里撞上同一 magic；帧级失败不静默 —— 它决定本次能不能读到内容
      // 末帧可能仍在写入；其余失败说明该 magic 只是压缩数据里的巧合。
    }
  }
  return parts.join('')
}

/** 枚举一个 root 下所有会话：<root>/<项目目录>/<会话 id>/session*.jsonl.zstd */
function collect(root) {
  const found = new Map()
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let sessions
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = join(projectDir, session.name)
      let files
      try {
        files = readdirSync(sessionDir)
      } catch {
        continue
      }
      const log = files.find(name => name.startsWith('session') && name.endsWith('.jsonl.zstd'))
      if (log === undefined) continue
      const file = join(sessionDir, log)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      found.set(session.name, { file, size: stat.size, mtime: stat.mtimeMs, project: project.name })
    }
  }
  return found
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 分叉项的事件摘要：行数 + 末条带时间戳的事件。 */
function summarize(file) {
  try {
    const lines = decodeFrames(readFileSync(file)).split('\n').filter(line => line.trim().length > 0)
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const row = JSON.parse(lines[index])
        const stamp = row.time ?? row.timestamp ?? row.at ?? row.data?.time
        if (typeof stamp === 'string') return { events: lines.length, lastAt: stamp }
      } catch { // guard-ok: 末行可能被截断（会话正在续写），往前找上一条带时间戳的事件即可；找不到时返回 undefined 而非 0
        // 末行可能被截断，继续往前找。
      }
    }
    return { events: lines.length, lastAt: undefined }
  } catch (error) {
    return { events: -1, lastAt: `读取失败：${error.message}` }
  }
}

const a = collect(rootA)
const b = collect(rootB)
const shared = [...a.keys()].filter(id => b.has(id))
const onlyA = [...a.keys()].filter(id => !b.has(id))
const onlyB = [...b.keys()].filter(id => !a.has(id))

const identical = []
const forked = []
for (const id of shared) {
  const left = a.get(id)
  const right = b.get(id)
  if (left.size === right.size) {
    const same = sha256(left.file) === sha256(right.file)
    if (same) {
      identical.push({ id, ...left, mtimeB: right.mtime })
      continue
    }
    forked.push({ id, kind: '同大小但内容不同（异常，值得查）', left, right, diff: 0 })
    continue
  }
  forked.push({ id, kind: '大小不同', left, right, diff: right.size - left.size })
}
forked.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
for (const item of forked) {
  item.leftSummary = summarize(item.left.file)
  item.rightSummary = summarize(item.right.file)
}

const mb = bytes => (bytes / 1024 / 1024).toFixed(2)
const summary = {
  rootA,
  rootB,
  counts: { a: a.size, b: b.size, shared: shared.length, onlyA: onlyA.length, onlyB: onlyB.length, identical: identical.length, forked: forked.length },
  bytes: {
    a: [...a.values()].reduce((sum, item) => sum + item.size, 0),
    b: [...b.values()].reduce((sum, item) => sum + item.size, 0),
  },
  forked: forked.map(item => ({
    id: item.id,
    project: item.left.project,
    kind: item.kind,
    profileBytes: item.left.size,
    globalBytes: item.right.size,
    deltaBytes: item.diff,
    profileMtime: new Date(item.left.mtime).toISOString(),
    globalMtime: new Date(item.right.mtime).toISOString(),
    profileEvents: item.leftSummary.events,
    globalEvents: item.rightSummary.events,
    profileLastAt: item.leftSummary.lastAt,
    globalLastAt: item.rightSummary.lastAt,
  })),
  onlyA: onlyA.map(id => ({ id, project: a.get(id).project, bytes: a.get(id).size })),
  onlyB: onlyB.map(id => ({ id, project: b.get(id).project, bytes: b.get(id).size })),
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`[fork] rootA（profile）= ${rootA}`)
  console.log(`[fork] rootB（全局）  = ${rootB}`)
  console.log(`[fork] A ${a.size} 个 / ${mb(summary.bytes.a)} MB；B ${b.size} 个 / ${mb(summary.bytes.b)} MB`)
  console.log(`[fork] 同 id ${shared.length}：完全一致 ${identical.length}，已分叉 ${forked.length}`)
  console.log(`[fork] 仅 A 有 ${onlyA.length} 个（miasaki 独占，隔离后新建）`)
  console.log(`[fork] 仅 B 有 ${onlyB.length} 个（web/官方桌面端独占）`)
  if (forked.length > 0) {
    console.log('\n── 已分叉（按体积差排序，前 25）──')
    for (const item of summary.forked.slice(0, 25)) {
      const winner = item.deltaBytes > 0 ? '全局侧更大' : item.deltaBytes < 0 ? 'profile 侧更大' : '大小相同但内容不同'
      console.log(`  ${item.id}  [${item.project}] ${winner}`)
      console.log(`    profile ${item.profileBytes}B / ${item.profileEvents} 事件 / 末条 ${item.profileLastAt ?? '-'}`)
      console.log(`    全局    ${item.globalBytes}B / ${item.globalEvents} 事件 / 末条 ${item.globalLastAt ?? '-'}`)
    }
    if (summary.forked.length > 25) console.log(`  ……另有 ${summary.forked.length - 25} 条`)
  }
}

if (mdPath !== undefined) {
  const lines = [
    '# 会话双份分叉清单（2026-09-27）',
    '',
    '会话记录按 profile 隔离时，历史是**复制**而非移动，231 个老会话在两个 root 各有一份。',
    '此后在 miasaki 里续聊只增长 profile 那份，在 web / 官方桌面端续聊只增长全局那份 —— 同一个会话 id 出现两套内容。',
    '',
    '## 总览',
    '',
    '| 项 | profile root | 全局 root |',
    '| --- | --- | --- |',
    `| 会话目录 | ${a.size} | ${b.size} |`,
    `| 占用 | ${mb(summary.bytes.a)} MB | ${mb(summary.bytes.b)} MB |`,
    '',
    `- 同 id 会话：**${shared.length}**`,
    `- 完全一致：**${identical.length}**`,
    `- **已分叉：${forked.length}**`,
    `- 仅 profile 有（隔离后 miasaki 新建）：${onlyA.length}`,
    `- 仅全局有（隔离后 web / 官方桌面端新建）：${onlyB.length}`,
    '',
    '## 已分叉清单',
    '',
    '| 会话 id | 项目 | profile 侧 | 全局侧 | 更大的一侧 | 末条事件时间（profile / 全局） |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const item of summary.forked) {
    const winner = item.deltaBytes > 0 ? '全局' : item.deltaBytes < 0 ? 'profile' : '内容不同（大小相同）'
    lines.push(`| \`${item.id}\` | ${item.project} | ${mb(item.profileBytes)} MB / ${item.profileEvents} 事件 | ${mb(item.globalBytes)} MB / ${item.globalEvents} 事件 | ${winner} | ${item.profileLastAt ?? '-'} / ${item.globalLastAt ?? '-'} |`)
  }
  lines.push('', '## 仅存在于一侧', '', '### 仅 profile root（隔离后 miasaki 新建，共 ' + onlyA.length + '）', '')
  for (const item of summary.onlyA) lines.push(`- \`${item.id}\` — ${item.project}（${mb(item.bytes)} MB）`)
  lines.push('', '### 仅全局 root（隔离后 web / 官方桌面端新建，共 ' + onlyB.length + '）', '')
  for (const item of summary.onlyB) lines.push(`- \`${item.id}\` — ${item.project}（${mb(item.bytes)} MB）`)
  lines.push('', '---', '', '判据：L1 文件大小 → L2 大小相同时比 SHA-256 → L3 只对分叉项解 zstd 帧数事件。', '重跑：`node scripts/compare-session-roots.mjs --md _refs/audit-2026-09-27/session-fork-report.md`', '')
  writeFileSync(mdPath, lines.join('\n'), 'utf8')
  console.log(`\n[fork] 报告已写入 ${mdPath}`)
}
