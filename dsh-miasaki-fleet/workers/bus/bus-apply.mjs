#!/usr/bin/env node
// bus-apply.mjs — 文件总线的唯一写入入口（G0，2026-09-10）
//
// 为什么需要它：G0 之前，Commander / 派单器 / 扫描器各自直接写总线文件，
// 只在事后由 validate-bus.mjs 巡检。这留下三类故障：
//   · 格式写坏 —— 事后才发现，坏数据已经进了总线；
//   · 并发覆盖 —— 两个写者读同一份旧值，后写者静默覆盖前者；
//   · 变更不可追溯 —— 文件变了，但没人记录是谁、为什么改的。
//
// 本模块把「写」收敛为一个入口（PatchBoard 的 schema-grounded mutation）：
//   任何角色都不再直接写文件，而是提交补丁
//     { op, path, value, author, reason, expected_version }
//   applier 依次执行：契约校验 → 乐观并发检查 → 确定性排序 → 原子应用
//                   → 追加事件 → 提交超步版本号
//
// 一次调用 = 一个超步（superstep）。超步内的补丁按稳定键排序后落盘，
// 因此同一组补丁无论以什么顺序到达，fold 出来的状态都相同 —— 重放可复现。
//
// 版本号不落独立文件：当前版本 = 事件流中最后一条 superstep.committed 的
// bus_version。多一份状态文件就多一处可能与真相不一致的地方。
//
// 本文件只负责「参数 ↔ 结果」；全部逻辑在 workers/lib/bus-apply-core.cjs，
// 后者不调 process.exit，因此可被测试与其他消费者直接调用。
//
// 用法：
//   node workers/bus/bus-apply.mjs --patch p.json [--patch q.json] [--check]
//   node workers/bus/bus-apply.mjs --stdin < patches.json
//   node workers/bus/bus-apply.mjs --current-version
//   node workers/bus/bus-apply.mjs --emit-event task.started --task t-0012 \
//        --author dispatcher --reason "派单给 scout" [--field exit_code=0]
//
// 退出码：0 成功 / 2 补丁契约非法 / 3 版本冲突 / 4 IO 或环境错误

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import core from '../lib/bus-apply-core.cjs'

// 工作区根默认由本文件位置推导（workers/bus/ → fleet/）。
// BUS_ROOT 可覆盖：既用于端到端测试（指向临时目录），也让 applier 可服务于
// 其他布局的工作区而不必改代码。
const ROOT = process.env.BUS_ROOT
  ? path.resolve(process.env.BUS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const EXIT_CONTRACT = 2
const EXIT_CONFLICT = 3
const EXIT_IO = 4

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    patches: [], stdin: false, check: false, json: false,
    currentVersion: false, listEvents: 0,
    emit: null, task: null, author: null, reason: null, fields: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} 缺少取值`)
      return v
    }
    if (a === '--patch') opts.patches.push(next())
    else if (a === '--stdin') opts.stdin = true
    else if (a === '--check') opts.check = true
    else if (a === '--json') opts.json = true
    else if (a === '--current-version') opts.currentVersion = true
    else if (a === '--list-events') opts.listEvents = parseInt(next(), 10) || 0
    else if (a === '--emit-event') opts.emit = next()
    else if (a === '--task') opts.task = next()
    else if (a === '--author') opts.author = next()
    else if (a === '--reason') opts.reason = next()
    else if (a === '--field') opts.fields.push(next())
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

function printHelp() {
  console.log(`bus-apply — 文件总线唯一写入入口（G0）

用法：
  --patch <file>       补丁文件，可重复；一次调用 = 一个超步
  --stdin              从标准输入读补丁（对象或对象数组）
  --check              只校验不写入（dry-run）
  --current-version    打印当前总线版本后退出
  --list-events <n>    打印最近 n 条机器事件后退出
  --json               以 JSON 输出结果（便于脚本解析）
  --emit-event <type>  便捷模式：直接提交一条事件
                       （配合 --task / --author / --reason / --field k=v）
  --field k=v          附加事件字段，可重复

退出码：0 成功 / 2 补丁契约非法 / 3 版本冲突 / 4 IO 或环境错误

环境变量：BUS_ROOT 覆盖工作区根（默认由本文件位置推导）`)
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8') } catch { return '' }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s
}

function loadPatches(opts) {
  const out = []
  for (const f of opts.patches) {
    const abs = path.isAbsolute(f) ? f : path.resolve(process.cwd(), f)
    const raw = core.readJsonOrNull(abs)
    if (raw === null) throw new Error(`补丁文件不存在或不是合法 JSON: ${f}`)
    if (Array.isArray(raw)) out.push(...raw)
    else out.push(raw)
  }
  if (opts.stdin) {
    const text = stripBom(readStdin()).trim()
    if (text) {
      let parsed
      try { parsed = JSON.parse(text) } catch (e) { throw new Error(`stdin JSON 解析失败: ${e.message}`) }
      if (Array.isArray(parsed)) out.push(...parsed)
      else out.push(parsed)
    }
  }
  if (opts.emit) out.push(buildEventPatch(opts))
  return out
}

/** 便捷模式：让 PowerShell 派单器不必手写 JSON 就能提交一条事件。 */
function buildEventPatch(opts) {
  const fields = {}
  for (const kv of opts.fields) {
    const eq = kv.indexOf('=')
    if (eq < 0) throw new Error(`--field 应为 k=v 形式: ${kv}`)
    const k = kv.slice(0, eq)
    const v = kv.slice(eq + 1)
    if (v === 'true') fields[k] = true
    else if (v === 'false') fields[k] = false
    else if (v !== '' && Number.isFinite(Number(v))) fields[k] = Number(v)
    else fields[k] = v
  }
  return {
    op: 'append',
    path: 'state/graph-events.jsonl',
    value: {
      event: opts.emit,
      ...(opts.task ? { task_id: opts.task } : {}),
      ...(opts.author ? { author: opts.author } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...fields,
    },
    author: opts.author || 'applier',
    // 占位：applier 会用当前版本填充（调用方不必先查版本）
    expected_version: -1,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function emitResult(opts, result, message) {
  if (opts.json) console.log(JSON.stringify(result))
  else console.log(message)
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`[bus-apply] ${e.message}`)
    return EXIT_CONTRACT
  }

  // ---- 只读模式 ----
  if (opts.currentVersion) {
    const v = core.readCurrentVersion(ROOT)
    emitResult(opts, { version: v }, String(v))
    return 0
  }
  if (opts.listEvents > 0) {
    const tail = core.readEvents(ROOT).slice(-opts.listEvents)
    if (opts.json) console.log(JSON.stringify(tail))
    else for (const e of tail) console.log(JSON.stringify(e))
    return 0
  }

  // ---- 装载补丁 ----
  let patches
  try {
    patches = loadPatches(opts)
  } catch (e) {
    console.error(`[bus-apply] ${e.message}`)
    return EXIT_IO
  }

  // 便捷模式的占位版本号换成真实当前版本
  if (patches.some((p) => p.expected_version === -1)) {
    const v = core.readCurrentVersion(ROOT)
    for (const p of patches) if (p.expected_version === -1) p.expected_version = v
  }

  // ---- 一个超步 ----
  const r = core.applyPatches(ROOT, patches, { check: opts.check })

  if (!r.ok) {
    if (r.conflict) {
      console.error(`[bus-apply] ${r.error}。请重读后再提交（拒绝盲目覆盖）。`)
      if (opts.json) console.log(JSON.stringify({ ok: false, conflict: true, current_version: r.currentVersion }))
      return EXIT_CONFLICT
    }
    if (r.partial) {
      console.error(`[bus-apply] 应用失败 → ${r.error}`)
      console.error('[bus-apply] 注意：本超步未提交版本号，状态可能部分写入，请重读后重试。')
      if (opts.json) console.log(JSON.stringify({ ok: false, partial: true, error: r.error }))
      return r.code
    }
    console.error(`[bus-apply] 契约校验失败 → ${r.error}`)
    if (opts.json) console.log(JSON.stringify({ ok: false, error: r.error }))
    return r.code
  }

  for (const w of r.duplicateWarnings || []) console.warn(`[bus-apply] 警告：${w}`)

  if (r.check) {
    emitResult(
      opts,
      { ok: true, check: true, patches: r.patchCount, paths: r.paths, current_version: r.currentVersion },
      `[bus-apply] --check 通过：${r.patchCount} 个补丁，路径 ${r.paths.join(', ')}；`
      + `当前版本 ${r.previousVersion} → 将变为 ${r.currentVersion}`,
    )
    return 0
  }

  emitResult(
    opts,
    { ok: true, patches: r.patchCount, bytes: r.bytes, previous_version: r.previousVersion, current_version: r.currentVersion },
    `[bus-apply] 提交成功：${r.patchCount} 个补丁，版本 ${r.previousVersion} → ${r.currentVersion}，${r.bytes} 字节`,
  )
  return 0
}

process.exit(main())
