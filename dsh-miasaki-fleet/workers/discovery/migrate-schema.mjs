#!/usr/bin/env node
// migrate-schema.mjs — P2-E（2026-10-21）：把 manifest / observed 标到当前 schema 版本
//
// 只做「标注版本」，不改字段内容（字段迁移是扫描器的职责，见 P2-B）。
// 经 bus-apply 唯一入口写；一次超步提交（要么全部生效要么全部不动）。
//
// 用法：
//   node workers/discovery/migrate-schema.mjs            # 迁移（写总线）
//   node workers/discovery/migrate-schema.mjs --check    # 只报告，不写
//   node workers/discovery/migrate-schema.mjs --json
//
// 退出码：0 成功（含无需迁移）/ 1 存在 future/invalid 版本或写入失败 / 2 环境错误

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import schema from '../lib/schema-version.cjs'
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
    else if (a === '--help' || a === '-h') {
      console.log('migrate-schema — 把 manifest/observed 标到当前 schema 版本（--check 只报告；--json JSON 输出）')
      process.exit(0)
    } else { console.error(`[schema] 未知参数: ${a}`); process.exit(2) }
  }
  return opts
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

function listAgentDirs() {
  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`[schema] agents 目录不存在：${AGENTS_DIR}（BUS_ROOT=${ROOT}）`)
    return null
  }
  return fs.readdirSync(AGENTS_DIR)
    .filter((d) => d !== 'archive')
    .map((d) => ({ id: d, dir: path.join(AGENTS_DIR, d) }))
    .filter((x) => { try { return fs.statSync(x.dir).isDirectory() } catch { return false } })
    .sort((a, b) => a.id.localeCompare(b.id))
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const dirs = listAgentDirs()
  if (dirs === null) return 2

  const rows = []
  const patches = []
  let problems = 0
  for (const { id, dir } of dirs) {
    for (const [file, label] of [['manifest.json', 'manifest'], ['observed.json', 'observed']]) {
      const p = path.join(dir, file)
      if (!fs.existsSync(p)) {
        if (file === 'manifest.json') { problems++; rows.push({ agent_id: id, file: label, status: 'missing-file', from: null, detail: 'manifest.json 不存在' }) }
        continue
      }
      const doc = readJson(p)
      const m = schema.migrateSchema(doc)
      const c = m.from || { status: 'invalid', version: null }
      if (c.status === 'future' || c.status === 'invalid' || !doc) {
        problems++
        rows.push({ agent_id: id, file: label, status: c.status === 'future' ? 'future' : 'invalid', from: c.version, detail: m.reason })
        continue
      }
      rows.push({ agent_id: id, file: label, status: c.status, from: c.version, detail: m.reason })
      if (m.changed && !opts.check) {
        patches.push({
          op: 'set',
          path: `agents/${id}/${file}`,
          value: m.doc,
          author: 'scanner',
          reason: `P2-E schema_version 迁移：${m.reason}`,
          expected_version: -1,
        })
      }
    }
  }

  const summary = {
    current: schema.CURRENT_SCHEMA_VERSION,
    agents: dirs.length,
    changed: patches.length,
    problems,
    rows,
  }

  if (opts.check) {
    console.log(`[schema] 预检：${dirs.length} 个 agent；当前版本 v${schema.CURRENT_SCHEMA_VERSION}；待迁移 ${rows.filter((r) => r.status === 'missing' || r.status === 'legacy').length} 处；问题 ${problems} 处（未写盘）`)
    for (const r of rows) if (r.status !== 'current') console.log(`  ${r.status.padEnd(12)} ${r.agent_id.padEnd(14)} ${r.file.padEnd(9)} ${r.detail}`)
    if (opts.json) console.log(JSON.stringify(summary))
    return problems === 0 ? 0 : 1
  }

  if (patches.length === 0) {
    console.log(`[schema] 无需迁移：${dirs.length} 个 agent 均为 v${schema.CURRENT_SCHEMA_VERSION}`)
    if (opts.json) console.log(JSON.stringify(summary))
    return problems === 0 ? 0 : 1
  }

  const r = spawnSync(process.execPath, [APPLIER, '--stdin'], {
    input: JSON.stringify(patches),
    encoding: 'utf8',
    env: { ...process.env, BUS_ROOT: ROOT },
    timeout: 30000,
  })
  if (r.status !== 0) {
    console.error(`[schema] ✗ bus-apply exit ${r.status}`)
    const detail = String(r.stdout || '') + String(r.stderr || '')
    if (detail.trim()) console.error(detail.trim())
    console.error('[schema] 未写盘（一次超步原子提交）；修复后重跑即可')
    return 1
  }
  console.log(`[schema] 经唯一入口落盘：${patches.length} 个补丁一次超步提交（→ v${schema.CURRENT_SCHEMA_VERSION}）`)
  for (const row of rows) if (row.status === 'missing' || row.status === 'legacy') console.log(`  ${row.agent_id.padEnd(14)} ${row.file.padEnd(9)} ${row.detail}`)
  if (opts.json) console.log(JSON.stringify(summary))
  return problems === 0 ? 0 : 1
}

process.exit(main())
