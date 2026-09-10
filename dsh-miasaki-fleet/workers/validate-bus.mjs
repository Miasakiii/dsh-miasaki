// validate-bus.mjs — 文件总线 Schema 校验（F1，无第三方依赖）
// 用法：node workers/validate-bus.mjs [--strict]
// 校验：agents/registry.json / agents/<id>/{manifest,control,status}.json
//       state/{tasks,ledger,events}.jsonl / agents/*/usage.jsonl / state/fleet-pulse.json（如存在）
//       G0 新增：tasks.jsonl 的 graph 子对象 + 任务图引用完整性
//                state/graph-events.jsonl（机器事件流 + 超步版本单调性）
//                tasks/<id>/result.json（节点交付契约）
// JSONL 坏行会报错定位行号；archive/ 下标本跳过；缺失的运行时文件（status.json 等被 ignore）跳过。
//
// 注（G0，2026-09-10）：graph / result / event 三类契约的判定规则来自
// workers/lib/bus-contract.cjs —— 与 workers/bus/bus-apply.mjs（写入时拦截）
// 是**同一份可执行定义**，此处不再重写一遍，以免两处口径漂移。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateEvent, validateGraph, validateResult, validateVerdict } from './lib/bus-contract.mjs'

// 工作区根默认由本文件位置推导（workers/ → fleet/）。BUS_ROOT 可覆盖，
// 与 workers/bus/bus-apply.mjs 同一约定：既便于集成测试，也便于校验其他布局的工作区。
const root = process.env.BUS_ROOT
  ? resolve(process.env.BUS_ROOT)
  : dirname(dirname(fileURLToPath(import.meta.url)))
const strict = process.argv.includes('--strict')
let errors = 0
let checked = 0
function fail(where, msg) {
  errors++
  console.error(`[validate] FAIL ${where}: ${msg}`)
}
function ok(where) { checked++ }
function isStr(v) { return typeof v === 'string' && v.length > 0 }
function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s }
function readJson(p) {
  try { return JSON.parse(stripBom(readFileSync(p, 'utf8'))) } catch (e) { fail(p, `JSON 解析失败: ${e.message}`); return null }
}
function readJsonl(p) {
  const rows = []
  let raw
  try { raw = readFileSync(p, 'utf8') } catch (e) { fail(p, `读取失败: ${e.message}`); return rows }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1) // PowerShell 生成的 BOM
  const lines = raw.split(/\r?\n/)
  lines.forEach((ln, i) => {
    if (!ln.trim()) return
    try { rows.push({ row: JSON.parse(ln), n: i + 1 }) } catch (e) { fail(`${p}:${i + 1}`, `JSONL 解析失败: ${e.message}`) }
  })
  return rows
}

// ---- registry ----
{
  const p = join(root, 'agents', 'registry.json')
  const reg = readJson(p)
  if (reg) {
    if (!Array.isArray(reg)) fail(p, '顶层应为 array')
    else {
      const ids = new Set()
      reg.forEach((r, i) => {
        const w = `${p}[${i}]`
        if (!isStr(r.id) || !/^[a-z0-9-]+$/.test(r.id)) fail(w, 'id 非法')
        if (ids.has(r.id)) fail(w, `id 重复: ${r.id}`)
        ids.add(r.id)
        for (const k of ['name', 'invoke', 'bin', 'binPath', 'version']) if (!isStr(r[k])) fail(w, `缺少 ${k}`)
        if (!['json-cost-usd', 'console-usage', 'session', 'unknown'].includes(r.metering)) fail(w, `metering 非法: ${r.metering}`)
      })
      ok(p)
    }
  }
}

// ---- per-agent ----
{
  const agentsDir = join(root, 'agents')
  const ids = readdirSync(agentsDir).filter((d) => {
    const fp = join(agentsDir, d)
    try { return statSync(fp).isDirectory() && d !== 'archive' } catch { return false }
  })
  for (const id of ids) {
    const dir = join(agentsDir, id)
    const mp = join(dir, 'manifest.json')
    if (existsSync(mp)) {
      const m = readJson(mp)
      if (m) {
        const w = mp
        if (m.id !== id) fail(w, `id 与目录名不一致: ${m.id} vs ${id}`)
        if (!['cli', 'custom'].includes(m.runtime)) fail(w, `runtime 非法: ${m.runtime}`)
        for (const k of ['command', 'binPath', 'version', 'invoke']) if (!m.cli || !isStr(m.cli[k])) fail(w, `cli.${k} 缺失`)
        for (const k of ['budget_per_day', 'timeout_ms', 'heartbeat_ms']) if (!m.limits || typeof m.limits[k] !== 'number' || m.limits[k] <= 0) fail(w, `limits.${k} 非法`)
        if (m.skills !== undefined && !Array.isArray(m.skills)) fail(w, 'skills 应为 array')
        ok(w)
      }
    }
    const cp = join(dir, 'control.json')
    if (existsSync(cp)) {
      const c = readJson(cp)
      if (c) {
        if (typeof c.enabled !== 'boolean') fail(cp, 'enabled 应为 boolean')
        if (typeof c.force_kill !== 'boolean') fail(cp, 'force_kill 应为 boolean')
        ok(cp)
      }
    }
    const sp = join(dir, 'status.json')
    if (existsSync(sp)) {
      const s = readJson(sp)
      if (s) {
        if (s.agent_id !== id) fail(sp, `agent_id 与目录名不一致`)
        if (!['idle', 'running', 'draining', 'blocked', 'error', 'stopped'].includes(s.state)) fail(sp, `state 非法: ${s.state}`)
        if (s.current_task !== null && s.current_task !== undefined && typeof s.current_task !== 'string') fail(sp, 'current_task 非法')
        if (s.progress !== undefined && (typeof s.progress !== 'number' || s.progress < 0 || s.progress > 1)) fail(sp, 'progress 应为 0..1')
        ok(sp)
      }
    }
    const up = join(dir, 'usage.jsonl')
    if (existsSync(up)) {
      for (const { row, n } of readJsonl(up)) {
        if (!isStr(row.ts)) fail(`${up}:${n}`, '缺少 ts')
        if (row.cost !== undefined && typeof row.cost !== 'number') fail(`${up}:${n}`, 'cost 应为 number')
      }
      ok(up)
    }
  }
}

// ---- tasks.jsonl（重放意见领袖：op 枚举 + 终态分布统计 + G0 任务图）----
const taskIds = new Set()
const graphNodes = []
{
  const p = join(root, 'state', 'tasks.jsonl')
  const state = new Map()
  for (const { row, n } of readJsonl(p)) {
    const w = `${p}:${n}`
    if (!['create', 'assign', 'update', 'reopen', 'reassign', 'cancel'].includes(row.op)) { fail(w, `op 非法: ${row.op}`); continue }
    if (row.op === 'create') {
      const t = row.task || {}
      if (!isStr(t.id)) fail(w, 'create.task.id 缺失')
      else {
        state.set(t.id, t.status || 'queued')
        taskIds.add(t.id)
        // G0 任务图：字段缺失即「不入图」，等同现状，不算错误（增量式采用）
        if (t.graph !== undefined) {
          validateGraph(t.graph, `${w} task.graph`, fail)
          graphNodes.push({ taskId: t.id, graph: t.graph, where: `${w} task.graph` })
        }
      }
    } else {
      const tid = row.task_id
      if (!isStr(tid)) fail(w, '缺少 task_id')
      if (row.op === 'update' && row.status && !['queued', 'running', 'blocked', 'failed', 'done', 'cancelled'].includes(row.status)) fail(w, `status 非法: ${row.status}`)
    }
  }
  ok(`${p} (${state.size} tasks)`)
}

// ---- 任务图引用完整性（G0 §3.7）----
{
  const groups = new Map()
  for (const { taskId, graph, where } of graphNodes) {
    for (const c of graph.consumes || []) {
      if (!taskIds.has(c.task)) fail(where, `consumes 引用了不存在的任务: ${c.task}`)
      if (c.task === taskId) fail(where, 'consumes 不能指向自己')
    }
    if (graph.parent !== undefined && !taskIds.has(graph.parent)) {
      fail(where, `parent 引用了不存在的任务: ${graph.parent}`)
    }
    if (graph.parent !== undefined && graph.parent === taskId) {
      fail(where, 'parent 不能指向自己')
    }
    if (graph.group !== undefined) {
      if (!groups.has(graph.group)) groups.set(graph.group, [])
      groups.get(graph.group).push({ taskId, kind: graph.node_kind })
    }
  }
  // 钻石图完整性：同一 group 至多一个汇合点（reduce），多了说明图有歧义
  for (const [g, members] of groups) {
    const reduces = members.filter((m) => m.kind === 'reduce')
    if (reduces.length > 1) {
      fail('state/tasks.jsonl', `group=${g} 出现 ${reduces.length} 个 reduce 节点（至多 1 个汇合点）`)
    }
  }
  if (graphNodes.length > 0) console.log(`[validate] 任务图: ${graphNodes.length} 个入图节点，${groups.size} 个分组`)
}

// ---- ledger / events ----
{
  const lp = join(root, 'state', 'ledger.jsonl')
  for (const { row, n } of readJsonl(lp)) {
    if (!isStr(row.ts) || !isStr(row.task)) fail(`${lp}:${n}`, '缺少 ts/task')
    if (row.cost !== undefined && typeof row.cost !== 'number') fail(`${lp}:${n}`, 'cost 非法')
  }
  ok(lp)
  const ep = join(root, 'state', 'events.jsonl')
  for (const { row, n } of readJsonl(ep)) {
    if (!isStr(row.ts) || !isStr(row.event)) fail(`${ep}:${n}`, '缺少 ts/event')
  }
  ok(ep)
}

// ---- graph-events.jsonl（G0 机器事件流）----
//
// 这是「事件流为唯一真相」的落地文件：只追加、由 applier 代写、
// 版本号 superstep.committed 从中派生（无独立 bus-version.json）。
// 缺失即事件流尚未启用，跳过（与 status.json 等运行时文件同口径）。
{
  const p = join(root, 'state', 'graph-events.jsonl')
  if (existsSync(p)) {
    const evs = []
    for (const { row, n } of readJsonl(p)) {
      validateEvent(row, `${p}:${n}`, fail)
      evs.push({ row, n })
    }
    // 超步版本必须严格递增：版本定义了 fold 的边界，回退或重复意味着提交序列被破坏
    let last = 0
    for (const { row, n } of evs) {
      if (row.event !== 'superstep.committed') continue
      if (!(row.bus_version > last)) {
        fail(`${p}:${n}`, `superstep.committed 版本未严格递增: ${row.bus_version} ≤ ${last}`)
      }
      last = row.bus_version
    }
    ok(`${p} (${evs.length} 事件, bus_version=${last})`)
  }
}

// ---- tasks/<id>/result.json（G0 节点交付契约）----
{
  const tasksDir = join(root, 'tasks')
  if (existsSync(tasksDir)) {
    for (const id of readdirSync(tasksDir)) {
      if (!/^t-\d{4}$/.test(id)) continue
      const rp = join(tasksDir, id, 'result.json')
      if (!existsSync(rp)) continue // 未交付的任务没有 result.json 是正常的
      const r = readJson(rp)
      if (r) {
        validateResult(r, rp, fail, id)
        ok(rp)
      }
    }
  }
}

// ---- tasks/<id>/verdict.json（G4 验证器结论）----
{
  const tasksDir = join(root, 'tasks')
  if (existsSync(tasksDir)) {
    for (const id of readdirSync(tasksDir)) {
      if (!/^t-\d{4}$/.test(id)) continue
      const vp = join(tasksDir, id, 'verdict.json')
      if (!existsSync(vp)) continue // 未挂验证器的任务没有 verdict.json 是正常的
      const v = readJson(vp)
      if (v) {
        validateVerdict(v, vp, fail, id)
        ok(vp)
      }
    }
  }
}

// ---- pulse（如存在，X1 契约）----
{
  const pp = join(root, 'state', 'fleet-pulse.json')
  if (existsSync(pp)) {
    const v = readJson(pp)
    if (v) {
      if (v.v !== 2) fail(pp, `v 应为 2，实为 ${v.v}`)
      if (!isStr(v.ts)) fail(pp, '缺少 ts')
      for (const k of ['online', 'running', 'waiting_approval', 'blocked', 'error']) {
        if (!Number.isInteger(v.fleet?.[k]) || v.fleet[k] < 0) fail(pp, `fleet.${k} 非法`)
      }
      ok(pp)
    }
  } else if (strict) {
    fail(pp, 'strict 模式要求存在（X1 未落地）')
  }
}

console.log(`[validate] done: ${checked} 文件通过，${errors} 错误`)
process.exit(errors ? 1 : 0)
