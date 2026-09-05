// validate-bus.mjs — 文件总线 Schema 校验（F1，无第三方依赖）
// 用法：node workers/validate-bus.mjs [--strict]
// 校验：agents/registry.json / agents/<id>/{manifest,control,status}.json
//       state/{tasks,ledger,events}.jsonl / agents/*/usage.jsonl / state/fleet-pulse.json（如存在）
// JSONL 坏行会报错定位行号；archive/ 下标本跳过；缺失的运行时文件（status.json 等被 ignore）跳过。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
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

// ---- tasks.jsonl（重放意见领袖：op 枚举 + 终态分布统计）----
{
  const p = join(root, 'state', 'tasks.jsonl')
  const state = new Map()
  for (const { row, n } of readJsonl(p)) {
    const w = `${p}:${n}`
    if (!['create', 'assign', 'update', 'reopen', 'reassign', 'cancel'].includes(row.op)) { fail(w, `op 非法: ${row.op}`); continue }
    if (row.op === 'create') {
      const t = row.task || {}
      if (!isStr(t.id)) fail(w, 'create.task.id 缺失')
      else state.set(t.id, t.status || 'queued')
    } else {
      const tid = row.task_id
      if (!isStr(tid)) fail(w, '缺少 task_id')
      if (row.op === 'update' && row.status && !['queued', 'running', 'blocked', 'failed', 'done', 'cancelled'].includes(row.status)) fail(w, `status 非法: ${row.status}`)
    }
  }
  ok(`${p} (${state.size} tasks)`)
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
