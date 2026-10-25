#!/usr/bin/env node
// scan-models.mjs — P0-B（2026-10-21）：把 coding agent 的真实模型写进 manifest.model_info
//
// 输入：shared/agent-adapters.json（只读适配器表）＋ 本机各 CLI 配置文件（只读）
// 输出：agents/<id>/manifest.json 的 `model_info`（经 bus-apply 唯一入口，一次超步）
//
// 纪律（与 config-drift.cjs 同款）：
//   · 只读用户配置；写盘只写总线文件，且**只经 bus-apply**（失败 exit 1，不回退直写）；
//   · 读不到 = `value:null + source:"unknown"`，**绝不**写 `cli-default` 冒充模型；
//   · 没有适配器的 agent 不改档案，只在输出里报「缺适配器」（agent-drift --check 会拦）。
//
// 用法：
//   node workers/discovery/scan-models.mjs            # 探测 + 写入（有变化才提交超步）
//   node workers/discovery/scan-models.mjs --check    # 只读探测，不写总线（预检）
//   node workers/discovery/scan-models.mjs --json     # JSON 输出（配合 --check 纯只读）
//
// 退出码：0 成功（含「无变化」）；1 写入失败；2 用法/环境错误

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import drift from '../lib/config-drift.cjs'
import agentFacts from '../lib/agent-facts.cjs'

const ROOT = process.env.BUS_ROOT
  ? path.resolve(process.env.BUS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const AGENTS_DIR = path.join(ROOT, 'agents')
const APPLIER = path.join(ROOT, 'workers', 'bus', 'bus-apply.mjs')

function parseArgs(argv) {
  const opts = { check: false, json: false }
  for (const a of argv) {
    if (a === '--check') opts.check = true
    else if (a === '--json') opts.json = true
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

function printHelp() {
  console.log(`scan-models — 探测 coding agent 的真实模型并写入 manifest.model_info（P0-B）

  --check   只读探测，不写总线（预检）
  --json    JSON 输出（与 --check 搭配即纯只读）

环境变量：BUS_ROOT 覆盖工作区根
退出码：0 成功 / 1 写入失败 / 2 用法或环境错误`)
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

/** 只遍历活动 agent 目录（archive 是历史标本，不参与）。 */
function listAgents() {
  const out = []
  for (const id of fs.readdirSync(AGENTS_DIR)) {
    if (id === 'archive') continue
    const dir = path.join(AGENTS_DIR, id)
    try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
    const facts = agentFacts.readAgentFactsFrom(dir)
    if (!facts) continue
    out.push({ id, dir, facts, observed: agentFacts.readObserved(ROOT, id) })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function modelInfoFor(probe, adapter) {
  if (probe.status === 'ok') {
    return {
      value: probe.model,
      source: 'config',
      confidence: 'declared',
      evidence: `${probe.config_path} → ${adapter.model_path ? adapter.model_path.join('.') : adapter.model_regex}`,
      ...(probe.provider ? { provider: probe.provider } : {}),
    }
  }
  return {
    value: null,
    source: 'unknown',
    confidence: 'unknown',
    evidence: probe.detail,
  }
}

function sameModelInfo(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null)
}

function applyPatches(patches) {
  // stdin 传 JSON 数组（bus-apply 的既有入口）；失败时把 applier 的 stdout/stderr 带出来。
  const r = spawnSync(process.execPath, [APPLIER, '--stdin'], {
    input: JSON.stringify(patches),
    encoding: 'utf8',
    env: { ...process.env, BUS_ROOT: ROOT },
    timeout: 30000,
  })
  return {
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    error: r.error ? String(r.error.message) : null,
  }
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`[scan-models] ${e.message}`)
    return 2
  }

  // 工作区不合法是环境错误，必须显式失败（静默当空工作区会让「没扫到」冒充「无变化」）。
  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`[scan-models] agents 目录不存在：${AGENTS_DIR}（BUS_ROOT=${ROOT}）`)
    return 2
  }

  const loaded = drift.loadAdapters(ROOT, (m) => console.error(m))
  const agents = listAgents()
  const rows = []
  const patches = []
  const missingAdapters = []
  const observedMissing = []

  for (const { id, facts, observed } of agents) {
    const kind = facts.kind ?? 'unknown'
    if (kind !== 'coding-agent') {
      rows.push({ agent_id: id, kind, status: 'skip', model: null, detail: '非 coding-agent，不参与模型探测' })
      continue
    }
    const adapter = loaded.adapters[id]
    if (!adapter) {
      missingAdapters.push(id)
      rows.push({ agent_id: id, kind: 'coding-agent', status: 'no-adapter', model: null, detail: 'shared/agent-adapters.json 缺少该 agent 的适配器' })
      continue
    }
    // P2-B：model_info 属于发现事实，写 observed.json（manifest 只留 Operator 字段）。
    if (!observed) {
      observedMissing.push(id)
      rows.push({ agent_id: id, kind: 'coding-agent', status: 'no-observed', model: null, detail: '缺 agents/<id>/observed.json —— 先跑 workers/discovery/scan-agents.ps1（P2-B 迁移）' })
      continue
    }
    const probe = drift.probeAgent(adapter, { root: ROOT })
    const next = modelInfoFor(probe, adapter)
    rows.push({ agent_id: id, kind: 'coding-agent', status: probe.status, model: probe.model, provider: probe.provider, config_path: probe.config_path, detail: probe.detail })
    if (!sameModelInfo(facts.model_info, next)) {
      patches.push({
        op: 'set',
        path: `agents/${id}/observed.json`,
        value: { ...observed, model_info: next },
        author: 'scan-models',
        reason: `P0-B 模型来源探测：${probe.status}${probe.model ? ` → ${probe.model}` : ''}`,
        expected_version: -1,
      })
    }
  }

  const summary = {
    adapters: Object.keys(loaded.adapters).length,
    agents_scanned: rows.filter((r) => r.kind === 'coding-agent').length,
    changed: patches.length,
    missing_adapters: missingAdapters,
    observed_missing: observedMissing,
    adapter_problems: loaded.problems,
    rows,
  }

  if (opts.check) {
    if (opts.json) console.log(JSON.stringify(summary))
    else {
      console.log(`[scan-models] 预检：${summary.agents_scanned} 个 coding-agent，${summary.changed} 处待更新（未写盘）`)
      for (const r of rows) console.log(`  ${r.status.padEnd(12)} ${r.agent_id.padEnd(14)} ${r.model ?? '—'}  ${r.detail}`)
    }
    // 预检发现适配器问题 / 缺适配器 / 缺 observed ⇒ 1（普通「有变化」不算失败）
    return (loaded.problems.length === 0 && missingAdapters.length === 0 && observedMissing.length === 0) ? 0 : 1
  }

  if (patches.length === 0) {
    console.log(`[scan-models] 无变化：${summary.agents_scanned} 个 coding-agent 的 model_info 均为最新`)
    if (opts.json) console.log(JSON.stringify(summary))
    return loaded.problems.length === 0 && missingAdapters.length === 0 && observedMissing.length === 0 ? 0 : 1
  }

  const result = applyPatches(patches)
  if (result.status !== 0) {
    console.error(`[scan-models] ✗ bus-apply exit ${result.status}${result.error ? `（${result.error}）` : ''}`)
    const detail = (result.stdout + '\n' + result.stderr).trim()
    if (detail) console.error(detail)
    console.error('[scan-models] 未写盘（一次超步原子提交）；修复后重跑即可')
    return 1
  }

  console.log(`[scan-models] 经唯一入口落盘：${patches.length} 个补丁一次超步提交`)
  for (const r of rows) {
    if (r.status === 'skip') continue
    console.log(`  ${r.status.padEnd(12)} ${r.agent_id.padEnd(14)} ${r.model ?? '—'}  ${r.detail}`)
  }
  if (opts.json) console.log(JSON.stringify(summary))
  return loaded.problems.length === 0 && missingAdapters.length === 0 && observedMissing.length === 0 ? 0 : 1
}

process.exit(main())
