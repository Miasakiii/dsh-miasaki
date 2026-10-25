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
// 注（2026-10-20）：fail() 的输出先过 logSafe —— 总线数据（台账行字段等）是写入者
// 可控的，直接插进日志会被 `\n`/ESC 伪造日志行 / 注入终端控制序列（CWE-117，
// monkeyscan da827）。转义只影响展示，退出码与真实摘要不变。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TASK_ROW_OPS, TASK_ROW_STATUSES, validateEvent, validateGraph, validateResult, validateVerdict } from './lib/bus-contract.mjs'
import agentFacts from './lib/agent-facts.cjs'
import scheduleLib from './lib/schedule.cjs'
import schemaVersionLib from './lib/schema-version.cjs'
import selectionPolicyLib from './lib/selection-policy.cjs'
import profileLib from './lib/profile.cjs'
// 任务终态折叠口径**单点**：与 task-ready / agent-pick 共用 foldTasks，
// 不在此处再写第二份「重放 tasks.jsonl」的实现（口径漂移是本仓复发形态）。
import { foldTasks } from './lib/task-graph.mjs'
import logSafeModule from './lib/log-safe.cjs'

// 工作区根默认由本文件位置推导（workers/ → fleet/）。BUS_ROOT 可覆盖，
// 与 workers/bus/bus-apply.mjs 同一约定：既便于集成测试，也便于校验其他布局的工作区。
const root = process.env.BUS_ROOT
  ? resolve(process.env.BUS_ROOT)
  : dirname(dirname(fileURLToPath(import.meta.url)))
const strict = process.argv.includes('--strict')
let errors = 0
let checked = 0
const { logSafe } = logSafeModule
function fail(where, msg) {
  errors++
  // 唯一汇点统一转义：where 含行号（可信）但 artifact/op/status 等 msg 内容来自总线，
  // 两个都过一遍以防新增调用点漏改（日志注入的修法要按「汇点」而不是「插值点」做）。
  console.error(`[validate] FAIL ${logSafe(where)}: ${logSafe(msg)}`)
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
        if (r.kind !== undefined && !['coding-agent', 'tool-cli', 'unknown'].includes(r.kind)) fail(w, `kind 非法: ${r.kind}`)
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
      const m = agentFacts.readAgentFactsFrom(dir)
      const rawManifest = readJson(mp)
      // observed 是可选兼容窗口：存在才校验（缺席时 readAgentFactsFrom 已回退 manifest）。
      const observedPath = join(dir, 'observed.json')
      const observed = existsSync(observedPath) ? readJson(observedPath) : null
      if (m) {
        const w = mp
        // P2-E（2026-10-21）：档案契约版本 —— future 版本显式拒绝（不猜新字段语义）；
        // legacy（缺席/1）允许读，迁移入口 workers/discovery/migrate-schema.mjs。
        for (const [label, doc] of [['manifest', rawManifest], ['observed', observed]]) {
          if (!doc) continue
          const sv = schemaVersionLib.classifySchema(doc)
          if (sv.status === 'future') fail(doc === rawManifest ? w : observedPath, `${label}.schema_version=${sv.version} 是未来版本（当前 ${schemaVersionLib.CURRENT_SCHEMA_VERSION}），拒绝解释`)
          else if (sv.status === 'invalid') fail(doc === rawManifest ? w : observedPath, `${label}.schema_version 非法：${JSON.stringify(doc.schema_version)}`)
        }
        // P2-B（2026-10-21）：发现事实以 observed.json 为准；readAgentFactsFrom 已做合并
        // （observed 缺席时回退 manifest —— 兼容窗口，不静默丢事实）。下面的语义校验因此
        // 对「新档案（observed）」与「旧档案（manifest legacy）」是同一套判据。
        if (m.id !== id) fail(w, `id 与目录名不一致: ${m.id} vs ${id}`)
        if (!['cli', 'custom'].includes(m.runtime)) fail(w, `runtime 非法: ${m.runtime}`)
        // P0-A（2026-10-21）：类型闸门的证据面 —— kind 与能力边界必须自洽，
        // 否则「是不是 coding agent」会退化成一个没人校验的自由文本字段。
        if (m.kind !== undefined) {
          if (!['coding-agent', 'tool-cli', 'unknown'].includes(m.kind)) fail(w, `kind 非法: ${m.kind}`)
          const loop = m.capability_boundary && m.capability_boundary.tool_loop
          if (m.kind === 'coding-agent' && loop !== 'yes') fail(w, `kind=coding-agent 但 capability_boundary.tool_loop=${loop ?? '缺失'}（应为 yes）`)
          if (m.kind === 'tool-cli' && loop !== 'no') fail(w, `kind=tool-cli 但 capability_boundary.tool_loop=${loop ?? '缺失'}（应为 no）`)
        }
        if (m.capability_boundary !== undefined) {
          const cb = m.capability_boundary
          if (cb === null || typeof cb !== 'object' || Array.isArray(cb)) fail(w, 'capability_boundary 应为 object')
          else for (const k of ['tool_loop', 'workspace_read', 'workspace_write_headless', 'shell_headless', 'network']) {
            if (!['yes', 'no', 'unknown'].includes(cb[k])) fail(w, `capability_boundary.${k} 非法: ${cb[k]}`)
          }
        }
        if (m.model_info !== undefined) {
          const mi = m.model_info
          if (mi === null || typeof mi !== 'object' || Array.isArray(mi)) fail(w, 'model_info 应为 object')
          else {
            if (mi.value !== null && !isStr(mi.value)) fail(w, 'model_info.value 应为 string|null')
            if (mi.provider !== undefined && !isStr(mi.provider)) fail(w, 'model_info.provider 应为 string')
            if (mi.value === 'cli-default') fail(w, 'model_info.value 不得是 cli-default（它不是真实模型；未声明请用 null）')
            if (!['config', 'transcript', 'served', 'unknown'].includes(mi.source)) fail(w, `model_info.source 非法: ${mi.source}`)
            if (!['verified', 'declared', 'unknown'].includes(mi.confidence)) fail(w, `model_info.confidence 非法: ${mi.confidence}`)
            if (mi.evidence !== undefined && !isStr(mi.evidence)) fail(w, 'model_info.evidence 应为 string')
          }
        }
        if (m.invoke_contract !== undefined) {
          const ic = m.invoke_contract
          if (ic === null || typeof ic !== 'object' || Array.isArray(ic)) fail(w, 'invoke_contract 应为 object')
          else {
            if (!['argv', 'stdin', 'unknown'].includes(ic.prompt_transport)) fail(w, `invoke_contract.prompt_transport 非法: ${ic.prompt_transport}`)
            if (!['json', 'text', 'ndjson', 'unknown'].includes(ic.output_format)) fail(w, `invoke_contract.output_format 非法: ${ic.output_format}`)
          }
        }
        if (m.permissions !== undefined) {
          const pm = m.permissions
          if (pm === null || typeof pm !== 'object' || Array.isArray(pm)) fail(w, 'permissions 应为 object')
          else {
            if (!['read-only', 'workspace-write', 'danger-full-access', 'unknown'].includes(pm.mode)) fail(w, `permissions.mode 非法: ${pm.mode}`)
            for (const k of ['tool_allowlist', 'denied_tools', 'approval_required']) {
              if (pm[k] !== undefined && !Array.isArray(pm[k])) fail(w, `permissions.${k} 应为 array`)
            }
            if (pm.headless_allow_delegation !== undefined && typeof pm.headless_allow_delegation !== 'boolean') fail(w, 'permissions.headless_allow_delegation 应为 boolean')
            if (pm.calibration !== undefined && !['verified', 'declared', 'unknown'].includes(pm.calibration)) fail(w, `permissions.calibration 非法: ${pm.calibration}`)
            if (pm.evidence !== undefined && !isStr(pm.evidence)) fail(w, 'permissions.evidence 应为 string')
            // P2-A 权限自洽：写权限声明必须有 headless 写证据；读权限声明不能与「读不可用」并存。
            const cb = m.capability_boundary || {}
            if ((pm.mode === 'workspace-write' || pm.mode === 'danger-full-access') && cb.workspace_write_headless !== 'yes') {
              fail(w, `permissions.mode=${pm.mode} 但 capability_boundary.workspace_write_headless=${cb.workspace_write_headless ?? '缺失'}（未证明的写权不得声明）`)
            }
            if (pm.mode === 'read-only' && cb.workspace_read === 'no') {
              fail(w, 'permissions.mode=read-only 但 capability_boundary.workspace_read=no（连读都无证据）')
            }
          }
        }
        if (m.present !== undefined && typeof m.present !== 'boolean') fail(w, 'present 应为 boolean')
        if (m.capabilities !== undefined && !Array.isArray(m.capabilities)) fail(w, 'capabilities 应为 array')
        for (const k of ['command', 'binPath', 'version', 'invoke']) if (!m.cli || !isStr(m.cli[k])) fail(w, `cli.${k} 缺失（manifest 与 observed 均无）`)
        // observed.json 自身结构（存在时）：agent_id / observed_at / present / kind 是合并视图的锚点。
        if (observed) {
          const ow = join(dir, 'observed.json')
          if (observed.agent_id !== id) fail(ow, `agent_id 与目录名不一致: ${observed.agent_id} vs ${id}`)
          if (!isStr(observed.observed_at)) fail(ow, 'observed_at 缺失或非字符串')
          if (typeof observed.present !== 'boolean') fail(ow, 'present 应为 boolean')
          if (observed.schema_version !== undefined && !Number.isInteger(observed.schema_version)) fail(ow, 'schema_version 应为整数')
        }
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
/** 任务终态（foldTasks 产物），供下方 result.json 的**反向存在性检查**复用。 */
let foldedTasks = new Map()
{
  const p = join(root, 'state', 'tasks.jsonl')
  const rows = readJsonl(p)
  for (const { row, n } of rows) {
    const w = `${p}:${n}`
    if (!TASK_ROW_OPS.includes(row.op)) { fail(w, `op 非法: ${row.op}`); continue }
    if (row.op === 'create') {
      const t = row.task || {}
      if (!isStr(t.id)) fail(w, 'create.task.id 缺失')
      else {
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
      if (row.op === 'update' && row.status && !TASK_ROW_STATUSES.includes(row.status)) fail(w, `status 非法: ${row.status}`)
    }
  }
  foldedTasks = foldTasks(rows.map(({ row }) => row))
  ok(`${p} (${foldedTasks.size} tasks)`)
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

// ---- tasks/<id>/result.json（G0 节点交付契约 + 终态反向存在性）----
//
// 不变式（2026-09-30 落地）：**任何被标记为终态的对象都必须有一条反向存在性检查**。
// 对本处即「台账 done+accepted ⇒ result.json 必须存在」。
// 此前这行是 `if (!existsSync(rp)) continue // 未交付的任务没有 result.json 是正常的`
// ⇒ 静默放行：首跑实测 9 个任务**全部** done+accepted，而 7 个从未产出契约交付物 ——
// 「验收通过」可以是空的（该结论最初由 tasks/t-0003 的交付物给出，本轮落地）。
// 缺失一律 FAIL 并点名，**不留豁免清单**（存量已按契约补记，见 tasks/*/result.json）。
//
// 驱动源是**台账**而非 tasks/ 目录（2026-09-30 用例驱动出的修正）：先前的写法以
// `readdirSync(tasksDir)` 为入口，于是「已验收、但连 tasks/<id>/ 目录都不存在」这一
// 同族形态仍然静默通过 —— 目录不存在同样是「交付物从未产出」。
{
  const tasksDir = join(root, 'tasks')

  // ① 反向存在性：终态（done + accepted）必须有 result.json
  for (const [id, t] of foldedTasks) {
    if (!(t.status === 'done' && t.accepted === true)) continue
    const rp = join(tasksDir, id, 'result.json')
    if (!existsSync(rp)) {
      fail(rp, '终态缺交付物：台账已 done+accepted，但 result.json 不存在（反向存在性检查；契约见 schemas/result.schema.json）')
    }
  }

  // ② 已存在的 result.json 逐个过契约（非终态任务没有它是正常的：在途）
  if (existsSync(tasksDir)) {
    for (const id of readdirSync(tasksDir)) {
      if (!/^t-\d{4}$/.test(id)) continue
      const rp = join(tasksDir, id, 'result.json')
      if (!existsSync(rp)) continue // guard-ok: 终态缺失已由上面 ① 显式 FAIL 覆盖；本行只是「无文件即无契约可校」，不是被略过的校验
      const r = readJson(rp)
      if (r) {
        validateResult(r, rp, fail, id)
        // P1-B（2026-10-21）：deliverables[] 是执行者显式声明的成品清单 —— 逐条核对
        // **存在性与工作区内包含性**（契约里的 path 形态已由 validateResult 校验）。
        if (Array.isArray(r.deliverables)) {
          r.deliverables.forEach((d, i) => {
            if (!d || typeof d.path !== 'string' || d.path === '') return // 契约已报，避免二次刷屏
            const abs = resolve(root, d.path)
            const rel = relative(root, abs)
            const w = `${rp}:deliverables[${i}]`
            if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
              fail(w, `path 越出工作区: ${d.path}`)
            } else if (!existsSync(abs)) {
              fail(w, `交付物不存在: ${d.path}（deliverables 声明的成品必须可核对；与 artifacts 指纹互补）`)
            }
          })
        }
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

// ---- schedules（如存在，P2-D 定时任务契约）----
{
  const sp = join(root, 'state', 'schedules.json')
  if (existsSync(sp)) {
    const doc = readJson(sp)
    if (doc) {
      const v = scheduleLib.validateSchedules(doc)
      for (const p of v.problems) fail(sp + p.where.slice(1), p.message)
      if (v.ok) ok(sp)
    }
  }
}

// ---- selection-policy（如存在，P2-F 选型策略契约）----
{
  const pp = join(root, 'shared', 'selection-policy.json')
  if (existsSync(pp)) {
    const doc = readJson(pp)
    if (doc) {
      const v = selectionPolicyLib.validatePolicy(doc)
      for (const p of v.problems) fail(pp + p.where.slice(1), p.message)
      if (v.ok) ok(pp)
    }
  }
}

// ---- profiles（如存在，P2-G Operator 快照契约）----
{
  const pp = join(root, 'shared', 'profiles.json')
  if (existsSync(pp)) {
    const doc = readJson(pp)
    if (doc) {
      const v = profileLib.validateProfiles(doc)
      for (const p of v.problems) fail(pp + p.where.slice(1), p.message)
      if (v.ok) ok(pp)
    }
  }
}

console.log(`[validate] done: ${checked} 文件通过，${errors} 错误`)
process.exit(errors ? 1 : 0)
