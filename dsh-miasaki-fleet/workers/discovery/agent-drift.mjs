#!/usr/bin/env node
// agent-drift.mjs — P0-B（2026-10-21）：只读配置漂移巡检
//
// 回答的问题：manifest 声明的模型（model_info.value）与**当前**各 CLI 配置文件里的模型是否一致？
//   match       档案与配置一致
//   replaced    配置被改过（档案落后）
//   missing     配置文件不存在（如 dsh 的 headless profile 未建、CLI 已卸载）
//   parse-error 配置存在但解析失败
//   unknown     配置存在但读不到模型字段 / 档案未声明模型
//
// **只读**：本 CLI 不写任何文件（包括用户配置与总线文件）；漂移是**事实**不是错误，
// 因此 `--json` 带漂移结果仍 exit 0；只有「适配器表本身坏了 / coding-agent 缺适配器」才让
// `--check` exit 1（那是配置缺口，会静默漏检）。
//
// 用法：
//   node workers/discovery/agent-drift.mjs            # 人类可读
//   node workers/discovery/agent-drift.mjs --json     # JSON（fleet-monitor /api/drift 消费）
//   node workers/discovery/agent-drift.mjs --check    # 适配器覆盖与结构检查（回归用）
//
// 退出码：0 成功 / 1 --check 发现问题 / 2 用法或环境错误

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import drift from '../lib/config-drift.cjs'
import agentFacts from '../lib/agent-facts.cjs'

const ROOT = process.env.BUS_ROOT
  ? path.resolve(process.env.BUS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const AGENTS_DIR = path.join(ROOT, 'agents')

function parseArgs(argv) {
  const opts = { json: false, check: false }
  for (const a of argv) {
    if (a === '--json') opts.json = true
    else if (a === '--check') opts.check = true
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

function printHelp() {
  console.log(`agent-drift — 只读配置漂移巡检（P0-B）

  --json    以 JSON 输出（fleet-monitor /api/drift 消费）
  --check   适配器覆盖与结构检查（回归用；有缺口 exit 1）

环境变量：BUS_ROOT 覆盖工作区根
漂移状态：match / replaced / missing / parse-error / unknown（漂移本身不改变退出码）
退出码：0 成功 / 1 --check 发现问题 / 2 用法或环境错误`)
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

function listAgents() {
  const out = []
  for (const id of fs.readdirSync(AGENTS_DIR)) {
    if (id === 'archive') continue
    const dir = path.join(AGENTS_DIR, id)
    try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
    // P2-B：kind 在 observed.json（合并视图）；manifest 只有 Operator 字段。
    const facts = agentFacts.readAgentFactsFrom(dir)
    if (facts) out.push({ id, manifest: facts })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (e) { console.error(`[agent-drift] ${e.message}`); return 2 }

  // 工作区不合法是环境错误，必须显式失败（静默返回空列表会让「没扫到」冒充「已干净」）。
  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`[agent-drift] agents 目录不存在：${AGENTS_DIR}（BUS_ROOT=${ROOT}）`)
    return 2
  }

  const loaded = drift.loadAdapters(ROOT, (m) => console.error(m))
  const agents = listAgents().filter(({ manifest }) => manifest.kind === 'coding-agent')
  const rows = []
  const missingAdapters = []
  const summary = { match: 0, replaced: 0, missing: 0, 'parse-error': 0, unknown: 0 }

  for (const { id, manifest } of agents) {
    const adapter = loaded.adapters[id]
    if (!adapter) {
      missingAdapters.push(id)
      rows.push({
        agent_id: id, declared: manifest.model_info?.value ?? null, actual: null,
        status: 'no-adapter', detail: 'shared/agent-adapters.json 缺少该 coding agent 的适配器',
      })
      continue
    }
    const probe = drift.probeAgent(adapter, { root: ROOT })
    const declared = manifest.model_info?.value ?? null
    const verdict = drift.classifyDrift(declared, probe)
    if (Object.prototype.hasOwnProperty.call(summary, verdict.status)) summary[verdict.status] += 1
    rows.push({
      agent_id: id,
      declared,
      actual: probe.model,
      provider: probe.provider,
      status: verdict.status,
      config_path: probe.config_path,
      detail: verdict.detail,
    })
  }

  const ok = loaded.problems.length === 0 && missingAdapters.length === 0
  const payload = {
    ok,
    generated_at: new Date().toISOString(),
    adapters: Object.keys(loaded.adapters).length,
    agents_scanned: agents.length,
    summary,
    missing_adapters: missingAdapters,
    adapter_problems: loaded.problems,
    agents: rows,
  }

  if (opts.json) {
    console.log(JSON.stringify(payload))
  } else {
    console.log(`[agent-drift] ${rows.length} 个 coding-agent；适配器 ${Object.keys(loaded.adapters).length} 个`)
    for (const r of rows) {
      const mark = r.status === 'match' ? '●' : r.status === 'no-adapter' ? '✗' : '○'
      console.log(`  ${mark} ${r.agent_id.padEnd(14)} ${r.status.padEnd(12)} 档案=${r.declared ?? '—'} 配置=${r.actual ?? '—'}  ${r.detail}`)
    }
    console.log(`  汇总：match ${summary.match} / replaced ${summary.replaced} / missing ${summary.missing} / parse-error ${summary['parse-error']} / unknown ${summary.unknown}`)
    if (loaded.problems.length > 0) for (const p of loaded.problems) console.error(`  ✗ 适配器问题 ${p.where}: ${p.message}`)
    if (missingAdapters.length > 0) console.error(`  ✗ 缺适配器：${missingAdapters.join(', ')}`)
    if (opts.check) console.log(ok ? '[agent-drift] --check 通过：适配器覆盖完整' : '[agent-drift] --check 失败：存在适配器缺口')
  }

  if (opts.check) return ok ? 0 : 1
  return 0
}

process.exit(main())
