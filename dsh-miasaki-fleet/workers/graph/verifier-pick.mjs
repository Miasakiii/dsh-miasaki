#!/usr/bin/env node
// verifier-pick.mjs — 验证者选取与验证状态查询（G4，2026-09-10）
//
// 对应主协议 §6.4 第 6 条「不得只信 worker 自测」的可执行化：
//   · --for <producer>   谁适合验证这个产出者（按异构强度排序，拒绝自验）
//   · --brief <taskId>   生成验证任务书（对抗立场 + 独立契约 + verdict 模板）
//   · --status <taskId>  查看某任务的验证结论（最近一条 + 驳回历史）
//   · --check            结构检查（供回归使用）
//
// 判定逻辑全部在 workers/lib/verifier.cjs（纯函数），本文件只负责读总线与呈现。
//
// 用法：
//   node workers/graph/verifier-pick.mjs --for claude
//   node workers/graph/verifier-pick.mjs --brief t-0013 --producer claude --min-level vendor
//   node workers/graph/verifier-pick.mjs --status t-0013
//   node workers/graph/verifier-pick.mjs --json
//
// 退出码：0 有满足条件的验证者（--check 通过）/ 1 无（--check 失败）/ 2 环境错误

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import core from '../lib/bus-apply-core.cjs'
import { validateVerdict } from '../lib/bus-contract.mjs'
import { evaluateLiveness } from '../lib/liveness.mjs'
import { HETERO_LEVELS, buildVerifierBrief, selectVerifiers, summarizeVerdicts } from '../lib/verifier.mjs'

const ROOT = process.env.BUS_ROOT
  ? path.resolve(process.env.BUS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------------------
// 上下文组装
// ---------------------------------------------------------------------------

/** 读全部 agent（活动 + 归档），组成 verifier 需要的 Map 与查询函数。 */
function loadAgents() {
  const agents = new Map()
  const meta = new Map()

  const scan = (dir, archived) => {
    if (!fs.existsSync(dir)) return
    for (const id of fs.readdirSync(dir)) {
      if (!archived && id === 'archive') continue
      const agentDir = path.join(dir, id)
      try { if (!fs.statSync(agentDir).isDirectory()) continue } catch { continue }
      const manifest = core.readJsonOrNull(path.join(agentDir, 'manifest.json'))
      if (!manifest) continue
      const control = core.readJsonOrNull(path.join(agentDir, 'control.json'))
      const status = core.readJsonOrNull(path.join(agentDir, 'status.json'))
      const live = archived ? { alive: false } : evaluateLiveness(status, manifest, Date.now())

      agents.set(id, { model: manifest.model ?? null })
      meta.set(id, {
        archived,
        enabled: archived ? false : (control ? control.enabled === true : false),
        alive: live.alive,
        state: status ? status.state : null,
      })
    }
  }

  scan(path.join(ROOT, 'agents'), false)
  scan(path.join(ROOT, 'agents', 'archive'), true)
  return { agents, meta }
}

/** 可选的外部厂商表：shared/agent-vendors.json。 */
function loadVendors() {
  const v = core.readJsonOrNull(path.join(ROOT, 'shared', 'agent-vendors.json'))
  return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined
}

/** 读全部 verdict.json（供 --status 与汇总）。 */
function loadVerdicts() {
  const out = []
  const tasksDir = path.join(ROOT, 'tasks')
  if (!fs.existsSync(tasksDir)) return out
  for (const id of fs.readdirSync(tasksDir)) {
    if (!/^t-\d{4}$/.test(id)) continue
    const v = core.readJsonOrNull(path.join(tasksDir, id, 'verdict.json'))
    if (v) out.push(v)
  }
  return out.sort((a, b) => String(a.checked_at || '').localeCompare(String(b.checked_at || '')))
}

// ---------------------------------------------------------------------------
// 参数与呈现
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { for: null, brief: null, producer: null, status: null, check: false, json: false, minLevel: 'agent', all: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (!v) throw new Error(`${a} 需要取值`)
      return v
    }
    if (a === '--for') opts.for = val()
    else if (a === '--brief') opts.brief = val()
    else if (a === '--producer') opts.producer = val()
    else if (a === '--status') opts.status = val()
    else if (a === '--min-level') {
      opts.minLevel = val()
      if (!HETERO_LEVELS.includes(opts.minLevel)) throw new Error(`--min-level 非法: ${opts.minLevel}（应为 ${HETERO_LEVELS.join('|')}）`)
    } else if (a === '--check') opts.check = true
    else if (a === '--all') opts.all = true
    else if (a === '--json') opts.json = true
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

function printHelp() {
  console.log(`verifier-pick — 验证者选取与验证状态（G4）

  --for <producer>       为某产出者挑验证者（自验被排除，按异构强度排序）
  --brief <taskId>       生成验证任务书（需配合 --producer）
  --producer <id>        --brief 的产出者
  --status <taskId>      查看某任务的验证结论
  --min-level <l>        异构下限：none|agent|model|vendor（默认 agent）
  --all                  连归档与未开启的 agent 一并纳入候选
  --check                结构检查（供回归使用）
  --json                 以 JSON 输出

异构等级：none(自验，禁止) < agent(不同 agent) < model(不同模型) < vendor(不同厂商)

环境变量：BUS_ROOT 覆盖工作区根；shared/agent-vendors.json 可覆盖厂商归属

退出码：0 有满足条件的验证者（或 --check 通过）/ 1 无 / 2 环境错误`)
}

const LEVEL_LABEL = { none: '自验', agent: 'agent', model: 'model', vendor: 'vendor' }

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`[verifier-pick] ${e.message}`)
    return 2
  }

  let loaded
  try {
    loaded = loadAgents()
  } catch (e) {
    console.error(`[verifier-pick] 读取档案失败：${e.message}`)
    return 2
  }

  const ctx = {
    agents: loaded.agents,
    vendors: loadVendors(),
    getAgent: (id) => loaded.meta.get(id) || null,
  }

  // ---- --status：某任务的验证结论 ----
  if (opts.status) {
    const verdicts = loadVerdicts()
    const s = summarizeVerdicts(verdicts, opts.status)
    if (opts.json) {
      console.log(JSON.stringify(s))
    } else if (!s.verified) {
      console.log(`[verifier-pick] ${opts.status}：尚无验证结论（未挂验证器）`)
    } else {
      console.log(`[verifier-pick] ${opts.status}：${s.verdict}（验证者 ${s.latest.verifier}，共 ${s.total} 次，其中驳回 ${s.rejectCount} 次）`)
      for (const f of s.latest.findings || []) {
        console.log(`  [${f.severity}] ${f.claim}`)
      }
    }
    return s.verified && s.verdict === 'pass' ? 0 : 1
  }

  // ---- --brief：生成验证任务书 ----
  if (opts.brief) {
    if (!opts.producer) {
      console.error('[verifier-pick] --brief 需要 --producer <产出者 id>')
      return 2
    }
    const taskDir = path.join(ROOT, 'tasks', opts.brief)
    const briefPath = path.join(taskDir, 'brief.md')
    const acceptance = []
    if (fs.existsSync(briefPath)) {
      const text = fs.readFileSync(briefPath, 'utf8')
      // 从「## 验收标准」小节里抓编号项 —— 只做最朴素的解析，抓不到就让验证者自己读
      const m = text.match(/##\s*验收标准\s*\n([\s\S]*?)(?=\n##\s|\s*$)/)
      if (m) {
        for (const line of m[1].split(/\r?\n/)) {
          const t = line.replace(/^\s*\d+[.、)]\s*/, '').trim()
          if (t) acceptance.push(t)
        }
      }
    }
    const artifacts = []
    for (const cand of ['result.json', 'result/result-' + opts.brief + '.md']) {
      if (fs.existsSync(path.join(taskDir, cand))) artifacts.push(`tasks/${opts.brief}/${cand}`)
    }

    const text = buildVerifierBrief(opts.brief, opts.producer, { artifacts, acceptance })
    if (opts.json) console.log(JSON.stringify({ task_id: opts.brief, producer: opts.producer, brief: text }))
    else console.log(text)
    return 0
  }

  // ---- --check / --for：验证者选取 ----
  const producer = opts.for
  if (!producer) {
    if (opts.check) {
      // 校验现存 verdict.json 的契约符合度（当前无文件时即为通过）。
      const verdicts = loadVerdicts()
      const problems = []
      for (const v of verdicts) {
        const id = v && v.task_id ? v.task_id : '(无 task_id)'
        validateVerdict(v, `verdict(${id})`, (where, msg) => problems.push(`${where}: ${msg}`))
      }
      const withModel = [...loaded.agents.values()].filter((a) => a.model && a.model !== 'cli-default').length
      if (opts.json) {
        console.log(JSON.stringify({
          ok: problems.length === 0,
          agents: loaded.agents.size,
          agents_with_explicit_model: withModel,
          verdicts: verdicts.length,
          problems,
        }))
      } else {
        for (const p of problems) console.error(`[verifier-pick] FAIL ${p}`)
        if (problems.length > 0) console.error(`[verifier-pick] --check 失败：${problems.length} 个契约问题`)
        else console.log(`[verifier-pick] --check 通过：${loaded.agents.size} 个 agent 可参与验证者选取（其中 ${withModel} 个声明了真实模型），现存 verdict ${verdicts.length} 份`)
      }
      return problems.length === 0 ? 0 : 1
    }
    printHelp()
    return 2
  }

  if (!loaded.agents.has(producer)) {
    console.error(`[verifier-pick] agent 不存在: ${producer}`)
    return 2
  }

  const r = selectVerifiers(producer, ctx, {
    minLevel: opts.minLevel,
    includeUnavailable: opts.all,
  })

  if (opts.json) {
    console.log(JSON.stringify(r))
  } else {
    console.log(`[verifier-pick] 为 ${producer} 选验证者（异构下限 ${opts.minLevel}）：`)
    if (r.candidates.length === 0) console.log('  无候选')
    for (const c of r.candidates) {
      const flags = [`异构 ${LEVEL_LABEL[c.level]}`, c.available ? '可用' : `不可用（${c.unavailableReason}）`]
      console.log(`  ${c.available ? '●' : '○'} ${c.agentId.padEnd(16)} ${flags.join(' · ')}`)
    }
    for (const w of r.warnings) console.log(`  ⚠ ${w}`)
    // 异构性不足时把原因摊开 —— 这是使用者最需要看到的
    const top = r.candidates[0]
    if (top && top.level !== 'vendor' && top.notes && top.notes.length > 0) {
      console.log(`  说明（以 ${top.agentId} 为例）：${top.notes.join('；')}`)
    }
  }
  return r.candidates.length > 0 ? 0 : 1
}

process.exit(main())
