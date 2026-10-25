#!/usr/bin/env node
// apply-profile.mjs — P2-G（2026-10-21）：把声明式 profile 应用到 fleet（Operator 快照）
//
// 只写 Operator 字段：
//   · `agents/<id>/control.json` 的 enabled（经 bus-apply）
//   · `agents/<id>/manifest.json` 的 limits.budget_per_day（经 bus-apply）
// 发现事实（observed.json）一律不碰。
//
// 用法：
//   node workers/profile/apply-profile.mjs --list
//   node workers/profile/apply-profile.mjs --profile lean --check
//   node workers/profile/apply-profile.mjs --profile lean
//   node workers/profile/apply-profile.mjs --profile review --json
//
// 退出码：0 成功（含无需变更）/ 1 校验失败或 profile 引用未知 agent / 2 用法或文件缺失

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import profileLib from '../lib/profile.cjs'
import agentFacts from '../lib/agent-facts.cjs'

const ROOT = process.env.BUS_ROOT
  ? path.resolve(process.env.BUS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROFILES_PATH = path.join(ROOT, 'shared', 'profiles.json')
const AGENTS_DIR = path.join(ROOT, 'agents')
const APPLIER = path.join(ROOT, 'workers', 'bus', 'bus-apply.mjs')

function parseArgs(argv) {
  const opts = { profile: null, check: false, json: false, list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile') {
      opts.profile = (argv[++i] || '').trim()
      if (!opts.profile) throw new Error('--profile 需要 profile id（见 --list）')
    } else if (a === '--check') opts.check = true
    else if (a === '--json') opts.json = true
    else if (a === '--list') opts.list = true
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`未知参数: ${a}`)
  }
  if (!opts.list && !opts.profile) throw new Error('需要 --profile <id> 或 --list')
  return opts
}

function printHelp() {
  console.log(`apply-profile — 应用 fleet profile（Operator 快照）

  --list                列出可用 profile
  --profile <id>        要应用的 profile
  --check               只显示差分，不写盘
  --json                JSON 输出

环境变量：BUS_ROOT 覆盖工作区根
退出码：0 成功（含无需变更）/ 1 校验失败或引用未知 agent / 2 用法/文件缺失`)
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

function listAgents() {
  // guard-ok: 返回 null 由 main 显式报错并 exit 2（不是静默当成空 fleet）
  if (!fs.existsSync(AGENTS_DIR)) return null
  const out = []
  for (const id of fs.readdirSync(AGENTS_DIR)) {
    if (id === 'archive') continue
    const dir = path.join(AGENTS_DIR, id)
    try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
    const facts = agentFacts.readAgentFactsFrom(dir)
    if (!facts) continue
    const control = readJson(path.join(dir, 'control.json'))
    out.push({
      id,
      dir,
      enabled: !!(control && control.enabled === true),
      force_kill: !!(control && control.force_kill === true),
      budget_per_day: facts.limits ? facts.limits.budget_per_day : null,
      manifest: agentFacts.readManifest(ROOT, id),
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function runApplier(patches) {
  const r = spawnSync(process.execPath, [APPLIER, '--stdin'], {
    input: JSON.stringify(patches),
    encoding: 'utf8',
    env: { ...process.env, BUS_ROOT: ROOT },
    timeout: 30000,
  })
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (e) { console.error(`[profile] ${e.message}`); return 2 }

  if (!fs.existsSync(PROFILES_PATH)) {
    console.error(`[profile] 未找到 ${path.relative(ROOT, PROFILES_PATH)}（先创建 shared/profiles.json）`)
    return 2
  }
  const doc = readJson(PROFILES_PATH)
  if (!doc) { console.error('[profile] shared/profiles.json 解析失败'); return 1 }
  const validated = profileLib.validateProfiles(doc)
  if (!validated.ok) {
    console.error(`[profile] profiles 校验失败 ${validated.problems.length} 处：`)
    for (const p of validated.problems) console.error(`  ${p.where}: ${p.message}`)
    return 1
  }

  if (opts.list) {
    const rows = profileLib.listProfileIds(doc).map((id) => {
      const p = profileLib.getProfile(doc, id)
      return { id, description: p.description || '', enabled: p.enabled.length, budgets: p.budgets ? Object.keys(p.budgets).length : 0 }
    })
    if (opts.json) console.log(JSON.stringify({ profiles: rows }))
    else {
      console.log(`[profile] 可用 profile（${rows.length}）：`)
      for (const r of rows) console.log(`  ${r.id.padEnd(10)} ${r.description}（启用 ${r.enabled} · 预算 ${r.budgets}）`)
    }
    return 0
  }

  const profile = profileLib.getProfile(doc, opts.profile)
  if (!profile) {
    console.error(`[profile] 未知 profile: ${opts.profile}（可用：${profileLib.listProfileIds(doc).join('/')}）`)
    return 2
  }
  const agents = listAgents()
  if (agents === null) { console.error(`[profile] agents 目录不存在：${AGENTS_DIR}`); return 2 }

  const diff = profileLib.diffProfile(profile, agents)
  if (diff.unknownAgents.length > 0) {
    console.error(`[profile] profile "${opts.profile}" 引用了未知 agent：${diff.unknownAgents.join(', ')}（打错字比少配更危险，显式失败）`)
    return 1
  }

  const summary = { profile: opts.profile, changes: diff.changes, applied: false }
  if (diff.changes.length === 0) {
    console.log(`[profile] profile "${opts.profile}" 已是最新（无需变更）`)
    if (opts.json) console.log(JSON.stringify(summary))
    return 0
  }

  if (opts.check) {
    console.log(`[profile] 预检：profile "${opts.profile}" 将变更 ${diff.changes.length} 项（未写盘）：`)
    for (const c of diff.changes) console.log(`  ${c.agent_id.padEnd(14)} ${c.kind.padEnd(8)} ${String(c.from)} → ${String(c.to)}`)
    if (opts.json) console.log(JSON.stringify(summary))
    return 0
  }

  const now = new Date().toISOString()
  const patches = []
  for (const c of diff.changes) {
    const a = agents.find((x) => x.id === c.agent_id)
    if (!a) continue
    if (c.kind === 'control') {
      patches.push({
        op: 'set',
        path: `agents/${c.agent_id}/control.json`,
        value: { enabled: c.to, force_kill: a.force_kill },
        author: 'operator',
        reason: `P2-G profile "${opts.profile}"：enabled ${c.from} → ${c.to}`,
        expected_version: -1,
      })
    } else {
      const manifest = Object.assign({}, a.manifest, {
        limits: Object.assign({}, a.manifest.limits, { budget_per_day: c.to }),
        updated_at: now,
      })
      patches.push({
        op: 'set',
        path: `agents/${c.agent_id}/manifest.json`,
        value: manifest,
        author: 'operator',
        reason: `P2-G profile "${opts.profile}"：budget_per_day ${c.from} → ${c.to}`,
        expected_version: -1,
      })
    }
  }
  const result = runApplier(patches)
  if (result.status !== 0) {
    console.error(`[profile] ✗ bus-apply exit ${result.status}`)
    const detail = (result.stdout + '\n' + result.stderr).trim()
    if (detail) console.error(detail)
    console.error('[profile] 未写盘（一次超步原子提交）；修复后重跑即可')
    return 1
  }
  summary.applied = true
  console.log(`[profile] 已应用 "${opts.profile}"：${patches.length} 个补丁一次超步提交`)
  for (const c of diff.changes) console.log(`  ${c.agent_id.padEnd(14)} ${c.kind.padEnd(8)} ${String(c.from)} → ${String(c.to)}`)
  if (opts.json) console.log(JSON.stringify(summary))
  return 0
}

process.exit(main())
