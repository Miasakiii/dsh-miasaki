#!/usr/bin/env node
// agent-pick.mjs — 能力图查询：选型 / 替代 / 缺口（G2，2026-09-10）
//
// 对应主协议 §6.2（分配流程）与 §6.3（分配决策表）的**可执行化**：
//   · --need     某个任务需要哪些能力 → 谁最合适（替代人工决策表的打分）
//   · --substitute  某个 agent 归档/关闭后谁能顶上（§6.2④ 暂存前的第一问）
//   · --gaps     系统级能力缺口与词表问题（哪些能力一关就断）
//
// 判定逻辑全部在 workers/lib/capability-graph.cjs（纯函数），本文件只负责
// 「读档案与台账 → 组装记录 → 呈现」。
//
// 用法：
//   node workers/graph/agent-pick.mjs --need coding,zh-report
//   node workers/graph/agent-pick.mjs --substitute coder
//   node workers/graph/agent-pick.mjs --gaps
//   node workers/graph/agent-pick.mjs --check      # 结构检查（纳入回归）
//   node workers/graph/agent-pick.mjs --json
//
// 退出码：0 有可用候选（--check 通过）/ 1 无候选（--check 失败）/ 2 环境错误

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import core from '../lib/bus-apply-core.cjs'
import { evaluateLiveness } from '../lib/liveness.mjs'
import {
  buildCapabilityGraph,
  capabilityGaps,
  findSubstitutes,
  selectAgents,
} from '../lib/capability-graph.mjs'
import { foldTasks } from '../lib/task-graph.mjs'

const ROOT = process.env.BUS_ROOT
  ? path.resolve(process.env.BUS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------------------
// 从档案与台账组装 agent 记录
// ---------------------------------------------------------------------------

/** 从 tasks.jsonl 聚合某 agent 的历史成败（confidence 的输入）。 */
function deriveHistory(tasks, agentId) {
  let accepted = 0
  let reopened = 0
  let failed = 0
  for (const t of tasks.values()) {
    if (t.assignee !== agentId) continue
    if (t.status === 'done' && t.accepted) accepted++
    else if (t.status === 'cancelled') { /* 主动取消不算失败 */ }
    else if (t.status === 'failed') failed++
    if (t.retries > 0) reopened += t.retries
  }
  return { accepted, reopened, failed }
}

function readAgentDir(dir, id, opts) {
  const manifest = core.readJsonOrNull(path.join(dir, 'manifest.json'))
  if (!manifest) return null
  const control = core.readJsonOrNull(path.join(dir, 'control.json'))
  const status = core.readJsonOrNull(path.join(dir, 'status.json'))
  const live = opts.archived ? { alive: false } : evaluateLiveness(status, manifest, Date.now())

  return {
    id,
    skills: Array.isArray(manifest.skills) ? manifest.skills : [],
    model: manifest.model ?? null,
    modelPrice: manifest.model_price ?? null,
    metering: manifest.metering_source ?? null,
    archived: opts.archived === true,
    enabled: opts.archived ? false : (control ? control.enabled === true : false),
    alive: live.alive,
    state: status ? status.state : null,
    ...opts.history,
  }
}

function loadAgents(tasks) {
  const agents = []
  const activeDir = path.join(ROOT, 'agents')
  if (fs.existsSync(activeDir)) {
    for (const id of fs.readdirSync(activeDir)) {
      if (id === 'archive') continue
      const dir = path.join(activeDir, id)
      try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
      const rec = readAgentDir(dir, id, { archived: false, history: deriveHistory(tasks, id) })
      if (rec) agents.push(rec)
    }
  }
  const archiveDir = path.join(activeDir, 'archive')
  if (fs.existsSync(archiveDir)) {
    for (const id of fs.readdirSync(archiveDir)) {
      const dir = path.join(archiveDir, id)
      try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
      const rec = readAgentDir(dir, id, { archived: true, history: deriveHistory(tasks, id) })
      if (rec) agents.push(rec)
    }
  }
  return agents
}

/** 可选的外部词表：shared/capability-vocab.json（缺省用内置表）。 */
function loadVocab() {
  const p = path.join(ROOT, 'shared', 'capability-vocab.json')
  const v = core.readJsonOrNull(p)
  if (v && typeof v === 'object' && v.aliases && typeof v.aliases === 'object') return { aliases: v.aliases }
  return undefined
}

function buildGraph() {
  const tasks = foldTasks(core.readJsonl(path.join(ROOT, 'state', 'tasks.jsonl')))
  const agents = loadAgents(tasks)
  return buildCapabilityGraph(agents, { vocab: loadVocab() })
}

// ---------------------------------------------------------------------------
// 参数与呈现
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { need: null, substitute: null, gaps: false, check: false, json: false, all: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--need') {
      opts.need = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)
      if (opts.need.length === 0) throw new Error('--need 需要能力列表，如 coding,zh-report')
    } else if (a === '--substitute') {
      opts.substitute = argv[++i]
      if (!opts.substitute) throw new Error('--substitute 需要 agent id')
    } else if (a === '--gaps') opts.gaps = true
    else if (a === '--check') opts.check = true
    else if (a === '--all') opts.all = true
    else if (a === '--json') opts.json = true
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

function printHelp() {
  console.log(`agent-pick — 能力图查询（G2）

  --need <a,b,...>      按能力需求选型（技能名会被规范化，code 等价于 coding）
  --substitute <id>     找某 agent 的替代者（含部分覆盖与缺口清单）
  --gaps                系统级诊断：无人提供的能力 / 只有归档提供的能力 / 疑似同义未归一
  --check               结构检查（供回归使用：无问题 0，有问题 1）
  --all                 连归档与未开启的 agent 一并纳入候选
  --json                以 JSON 输出

环境变量：BUS_ROOT 覆盖工作区根

退出码：0 有可用候选（或 --check 通过）/ 1 无候选（或 --check 失败）/ 2 环境错误`)
}

function fmtCandidate(c, opts) {
  const parts = [
    `覆盖 ${c.covered.length}/${c.covered.length + c.missing.length}`,
    `confidence ${c.confidence}`,
    `分 ${c.score}`,
  ]
  if (!c.available) parts.push(`不可用（${c.unavailableReason || '未知'}）`)
  if (c.missing.length > 0) parts.push(`缺 ${c.missing.map((m) => m.replace('cap:', '')).join(',')}`)
  return `  ${c.available ? '●' : '○'} ${c.agentId.padEnd(16)} ${parts.join(' · ')}`
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`[agent-pick] ${e.message}`)
    return 2
  }

  let graph
  try {
    graph = buildGraph()
  } catch (e) {
    console.error(`[agent-pick] 读取档案失败：${e.message}`)
    return 2
  }

  const optsForQuery = { includeArchived: opts.all, includeUnavailable: opts.all }

  // ---- --need：选型 ----
  if (opts.need) {
    const r = selectAgents(opts.need, graph, optsForQuery)
    if (opts.json) {
      console.log(JSON.stringify(r))
    } else {
      console.log(`[agent-pick] 需求：${r.required.map((c) => c.replace('cap:', '')).join(' + ')}`)
      if (r.missingCapabilities.length > 0) {
        console.log(`  ⚠ 无人提供：${r.missingCapabilities.map((c) => c.replace('cap:', '')).join(',')}（含"只有归档 agent 提供"）`)
      }
      if (r.candidates.length === 0) console.log('  没有候选 agent')
      else for (const c of r.candidates) console.log(fmtCandidate(c, opts))
    }
    const usable = r.candidates.filter((c) => c.available)
    return usable.length > 0 ? 0 : 1
  }

  // ---- --substitute：替代查找 ----
  if (opts.substitute) {
    const r = findSubstitutes(opts.substitute, graph, optsForQuery)
    if (opts.json) {
      console.log(JSON.stringify(r))
    } else {
      console.log(`[agent-pick] ${r.agentId} 需要：${(r.required || []).map((c) => c.replace('cap:', '')).join(' + ') || '（无）'}`)
      if (r.full.length > 0) {
        console.log('  完全替代者：')
        for (const c of r.full) console.log(`    ● ${c.agentId.padEnd(16)} coverage ${c.coverage} · confidence ${c.confidence}`)
      } else {
        console.log('  完全替代者：无')
      }
      if (r.partial.length > 0) {
        console.log('  部分覆盖：')
        for (const c of r.partial.slice(0, 6)) {
          console.log(`    ○ ${c.agentId.padEnd(16)} coverage ${c.coverage} · 缺 ${c.missing.map((m) => m.replace('cap:', '')).join(',')}`)
        }
      }
      if (r.reason) console.log(`  ${r.reason}`)
    }
    return r.full.length > 0 ? 0 : 1
  }

  // ---- --check：结构检查（供回归使用，与 --gaps 的展示分离）----
  const gaps = capabilityGaps(graph)
  if (opts.check) {
    // 只有**活动档案**的严重问题才让检查失败：
    //   · duplicate_after_canonicalize —— 两个技能规范后撞成同一能力（档案冗余）
    //   · no_capabilities             —— 没有任何技能，选型时永远匹配不上
    // 归档档案是历史标本，与 validate-bus 跳过 agents/archive/ 同口径，不计失败；
    // model 缺失（no_explicit_model）是当前普遍现象，属数据质量，归 --gaps 呈现。
    const problems = gaps.issues.filter((i) => {
      const a = graph.agents.get(i.agentId)
      if (!a || a.archived) return false
      return i.kind === 'duplicate_after_canonicalize' || i.kind === 'no_capabilities'
    })
    const archivedNoise = gaps.issues.filter((i) => {
      const a = graph.agents.get(i.agentId)
      return a && a.archived && i.kind === 'duplicate_after_canonicalize'
    })

    if (opts.json) {
      console.log(JSON.stringify({
        ok: problems.length === 0,
        agents: graph.agents.size,
        capabilities: graph.capabilities.size,
        problems,
        archived_notes: archivedNoise,
      }))
    } else {
      for (const i of problems) console.error(`[agent-pick] FAIL ${i.agentId}: ${i.kind} — ${i.detail}`)
      // 归档冗余走 stdout：它是「提示」不是「失败」，而 stderr 在 PowerShell 管道里
      // 会被当成 NativeCommandError，让回归输出看起来像出错。
      for (const i of archivedNoise) {
        console.log(`[agent-pick] 提示（归档，不计失败）：${i.agentId} 的 ${i.skill} 与 ${i.canonical} 规范后撞成同一能力`)
      }
      if (problems.length > 0) console.error(`[agent-pick] --check 失败：${problems.length} 个结构问题`)
      else console.log(`[agent-pick] --check 通过：${graph.agents.size} 个 agent，${graph.capabilities.size} 项能力，无结构问题`)
    }
    return problems.length === 0 ? 0 : 1
  }

  // ---- --json：完整数据 ----
  if (opts.json) {
    console.log(JSON.stringify({
      gaps,
      capabilities: [...graph.capabilities.entries()].map(([id, n]) => ({
        id, active: n.agents, archived: n.archivedAgents,
      })),
      issues: graph.issues,
    }))
    return 0
  }

  // ---- 默认 / --gaps：呈现 ----
  console.log(`[agent-pick] 能力图：${graph.agents.size} 个 agent，${graph.capabilities.size} 项能力`)
  if (!opts.gaps) {
    console.log('  （用 --gaps 看能力缺口，--need 做选型，--substitute 找替代者）')
    return 0
  }

  console.log('\n能力提供者分布：')
  for (const id of [...graph.capabilities.keys()].sort()) {
    const n = graph.capabilities.get(id)
    const flag = n.agents.length === 0 ? '  ⚠ 无活动提供者' : ''
    console.log(`  ${id.replace('cap:', '').padEnd(24)} ${n.agents.length} 活动 / ${n.archivedAgents.length} 归档${flag}`)
  }
  if (gaps.archivedOnly.length > 0) {
    console.log('\n⚠ 只有归档 agent 提供（一关就断）：')
    for (const x of gaps.archivedOnly) {
      console.log(`  ${x.capability.replace('cap:', '')} ← ${x.archivedAgents.join(', ')}`)
    }
  }
  if (gaps.suspectedSynonyms.length > 0) {
    console.log('\n疑似同义但未归一（需人工确认，本工具不自动合并）：')
    for (const s of gaps.suspectedSynonyms) {
      console.log(`  ${s.a.replace('cap:', '')} ⊂ ${s.b.replace('cap:', '')}`)
    }
  }
  if (gaps.issues.length > 0) {
    console.log('\n档案问题：')
    for (const i of gaps.issues.slice(0, 12)) console.log(`  ${i.agentId}: ${i.kind} — ${i.detail}`)
    if (gaps.issues.length > 12) console.log(`  …另有 ${gaps.issues.length - 12} 条`)
  }
  return 0
}

process.exit(main())
