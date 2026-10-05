#!/usr/bin/env node
// check-pulse-contract.mjs — fleet-pulse 生产/消费契约闸门（T6，2026-10-05，repo 段第 7 项）
//
// ── 为什么需要 ─────────────────────────────────────────────────────────────
// 桌宠的 fleet 指示读 fleet 侧 publish-pulse.mjs 写的 state/fleet-pulse.json，消费端在
// dsh-miasaki-desktop/src-tauri/src/main.rs 的 parse_pulse_flag —— 跨线契约此前没有
// 任何自动断言：把生产端的 `running` 改名成 `active`，两侧回归**全绿**，消费端却读不到
// 该字段（原先 unwrap_or(0) 静默按 0）⇒ 桌宠「该亮不亮」，没有任何红灯。
// 案例与设计：dsh-miasaki-shared-docs/cross/desktop-adaptation-plan-2026-09-27.md §3.1
// （该计划的 T6，2026-10-05 落地）。
//
// ── 判据 ──────────────────────────────────────────────────────────────────
//   消费集 ⊆ 生产集；协议字段 v / ts 两侧同现；消费端版本期望 == 生产端 v 值。
//   · **生产集**：闸门自己跑一次 `node workers/pulse/publish-pulse.mjs`，解析其 stdout
//     的 `[pulse] {…}` 行，递归收集键路径（容器名与叶子都算）。
//     **刻意不复用已 publish 的那份文件** —— `state/fleet-pulse.json` 是未跟踪产物，
//     依赖它就犯了 2026-10-05 intro-clips 事故的同族错误（闸门依赖本地事实 ⇒ 本机假绿 /
//     CI 恒红）。跑**入库代码本身**、解析其输出，才是入库事实；干净 checkout 必然可跑 ——
//     publish-pulse 所有读取都带降级，无 agents 状态时输出字段集完整、计数全 0，
//     对本闸门（只比字段名，不比值）恰好无损。
//   · **消费集**：锚定 `fn parse_pulse_flag` 函数体（花括号配平，不写死行号 —— 行号会漂移，
//     函数名就是锚），抽两类字面量：
//       ① `.get("X")` → 顶层字段 X（v / ts / fleet）；
//       ② 计数闭包绑定 `let N = |k: &str| f.get(k)` 之后的 `N("X")` 调用 → fleet.X。
//     **任何一类抽不到 ⇒ exit 1**（抽取正则失效后的假绿比红更危险，设计稿 §3.1 硬要求），
//     消费集不足硬下限 7 项同样 exit 1。
//
// ── 边界（别把绿灯当全面保证）────────────────────────────────────────────
//   · 只对账 main.rs 的 parse_pulse_flag **一个**消费者。fleet-pulse.json 的其他读者
//     （web 面板等）要守契约需另立项 —— 本闸门不假装覆盖它们。
//   · 只比「字段名集合 + 协议版本值」，不比字段类型 / 取值范围 —— 那是 schema 校验的事；
//     设计稿 §3.1 明确不引 ajv，schemas/pulse.schema.json 维持无消费者。
//   · 消费端抽取正则按 2026-10-05 的代码形态写；Rust 侧重构（改函数名 / 闭包形态）会让
//     抽取失败 —— 那是**有意的**：exit 1 并提示同步本闸门，而不是静默放行。

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FLEET_ROOT = path.join(ROOT, 'dsh-miasaki-fleet')
const PUBLISHER = path.join(FLEET_ROOT, 'workers', 'pulse', 'publish-pulse.mjs')
const MAIN_RS = path.join(ROOT, 'dsh-miasaki-desktop', 'src-tauri', 'src', 'main.rs')

function fail(msg) {
  console.error(`[pulse-contract] ✗ ${msg}`)
  process.exit(1)
}

/** 递归收集键路径：容器名与叶子路径都算（消费端 v.get("fleet") 消费的是容器名本身）。 */
function keyPaths(obj, prefix = '', out = new Set()) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return out
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    out.add(p)
    keyPaths(v, p, out)
  }
  return out
}

/**
 * 消费端字段抽取。返回 { names, expectV } 或 { error }。
 * 任何抽取失败都返回 error（调用方 exit 1），绝不静默降级为「抽到几个算几个」。
 */
export function extractConsumer(src) {
  const start = src.indexOf('fn parse_pulse_flag')
  if (start < 0) {
    return { error: '锚点 fn parse_pulse_flag 不存在 —— Rust 侧函数已改名？同步本闸门的锚点' }
  }
  const open = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return { error: 'parse_pulse_flag 函数体花括号不配平 —— 抽取区域残缺' }
  const body = src.slice(start, end + 1)

  const names = new Set()
  // ① 顶层字段：v.get("v") / v.get("ts") / v.get("fleet") 等字面量 .get 调用
  for (const m of body.matchAll(/\.get\("([^"]+)"\)/g)) names.add(m[1])
  // ② 计数闭包：先抓绑定形态再抓调用点（闭包名可变，绑定形态才是稳定锚）
  const binding = body.match(/let\s+(\w+)\s*=\s*\|k: &str\|\s*f\.get\(k\)/)
  if (!binding) {
    return { error: '计数闭包绑定形态（let N = |k: &str| f.get(k)）抽不到 —— 消费端形态变化，同步本闸门' }
  }
  const callRe = new RegExp(`\\b${binding[1]}\\("([^"]+)"\\)`, 'g')
  let fleetCalls = 0
  for (const m of body.matchAll(callRe)) {
    names.add(`fleet.${m[1]}`)
    fleetCalls++
  }
  if (fleetCalls === 0) {
    return { error: `闭包 ${binding[1]}("…") 的调用抽不到 —— 消费端形态变化，同步本闸门` }
  }
  // ③ 版本期望：v.get("v").and_then(|x| x.as_u64()) != Some(2)
  const ver = body.match(/as_u64\(\)\)\s*!=\s*Some\((\d+)\)/)
  if (!ver) {
    return { error: '版本期望（as_u64()) != Some(N)）抽不到 —— 消费端形态变化，同步本闸门' }
  }
  return { names, expectV: Number(ver[1]) }
}

/**
 * 契约对账（纯函数，自证直接打它）。通过返回 null，失败返回一句人话。
 * @param {Set<string>} producerSet 生产端键路径集合
 * @param {Set<string>} consumerSet 消费端键路径集合
 * @param {number} expectV          消费端期望的协议版本
 * @param {number} producerV        生产端实际写的 v
 */
export function assertContract(producerSet, consumerSet, expectV, producerV) {
  const missing = [...consumerSet].filter((k) => !producerSet.has(k))
  if (missing.length) return `消费了但没人生产：${missing.join(' / ')}`
  for (const k of ['v', 'ts']) {
    if (!producerSet.has(k)) return `生产集缺协议字段 ${k}`
    if (!consumerSet.has(k)) return `消费端没有消费协议字段 ${k}（两侧必须同现）`
  }
  if (producerV !== expectV) return `协议版本漂移：生产端 v=${producerV}，消费端期望 v=${expectV}`
  return null
}

/** 自证：比较逻辑每次运行都自检（闸门最坏的失效形态是永远绿）。 */
function selfTest() {
  const prod = new Set(['v', 'ts', 'fleet', 'fleet.running', 'fleet.waiting_approval', 'fleet.blocked', 'fleet.error', 'today_cost'])
  const cons = new Set(['v', 'ts', 'fleet', 'fleet.running', 'fleet.waiting_approval', 'fleet.blocked', 'fleet.error'])
  const cases = [
    { p: prod, c: cons, ev: 2, pv: 2, want: null },
    { p: new Set([...prod].filter((k) => k !== 'fleet.running')), c: cons, ev: 2, pv: 2, want: 'fleet.running' },
    { p: new Set([...prod].filter((k) => k !== 'ts')), c: cons, ev: 2, pv: 2, want: 'ts' },
    { p: prod, c: cons, ev: 2, pv: 3, want: '版本漂移' },
    { p: prod, c: new Set([...cons, 'fleet.zombie']), ev: 2, pv: 2, want: 'fleet.zombie' },
  ]
  for (const [i, tc] of cases.entries()) {
    const got = assertContract(tc.p, tc.c, tc.ev, tc.pv)
    const ok = tc.want === null ? got === null : got !== null && got.includes(tc.want)
    if (!ok) {
      console.error(`[pulse-contract] 失败：自证用例 #${i} 未按预期${tc.want === null ? '通过' : `报「${tc.want}」`} —— 实际：${got}`)
      console.error('[pulse-contract] 自证失败 —— 比较逻辑坏了，闸门结果不可信。')
      process.exit(1)
    }
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
selfTest()

// 生产集：跑入库的发布器（依赖的是代码本身，不是任何未跟踪产物）
const pub = spawnSync(process.execPath, [PUBLISHER], { cwd: FLEET_ROOT, encoding: 'utf-8' })
if (pub.error) fail(`无法执行发布器：${pub.error.message}`)
if (pub.status !== 0) fail(`发布器 exit ${pub.status}：${((pub.stderr || '') + (pub.stdout || '')).trim().slice(0, 400)}`)
const pulseLine = (pub.stdout || '').split(/\r?\n/).find((l) => l.startsWith('[pulse] {'))
if (!pulseLine) fail('发布器 stdout 里没有 `[pulse] {…}` 行 —— 发布器输出形态变化，同步本闸门')
let pulse
try {
  pulse = JSON.parse(pulseLine.slice('[pulse] '.length))
} catch (e) {
  fail(`[pulse] 行不是合法 JSON：${e.message}`)
}
const producerSet = keyPaths(pulse)

// 消费集：从 main.rs 抽取
let rs
try {
  rs = fs.readFileSync(MAIN_RS, 'utf-8')
} catch (e) {
  fail(`读不到 main.rs（${MAIN_RS}）：${e.message}`)
}
const consumer = extractConsumer(rs)
if (consumer.error) fail(consumer.error)
// 硬下限：今日消费集 = v/ts/fleet + fleet 四计数 = 7 项。少于它说明抽取漏了。
if (consumer.names.size < 7) {
  fail(`消费集仅 ${consumer.names.size} 项（下限 7）—— 抽取不完整，同步本闸门`)
}

const problem = assertContract(producerSet, consumer.names, consumer.expectV, pulse.v)
if (problem) fail(problem)

console.log(
  `[pulse-contract] 契约成立：消费集 ${consumer.names.size} 项 ⊆ 生产集 ${producerSet.size} 项，` +
  `协议 v=${pulse.v}（消费端期望 ${consumer.expectV}）`
)
console.log(`[pulse-contract] 消费集：${[...consumer.names].sort().join(' / ')}`)
