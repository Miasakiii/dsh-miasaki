#!/usr/bin/env node
// publish-pulse.mjs — fleet-pulse.json v2 发布器（X1，A×B 唯一契约写者）
// 聚合语义与 fleet-monitor/server.js aggregateFleet 对齐，BOM 容错。
// 用法：node workers/pulse/publish-pulse.mjs [--interval-ms N]
//   默认单次发布；--interval-ms > 0 则常驻定时发布（800ms 防抖由调用方保证）。
'use strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENTS_DIR = path.join(ROOT, 'agents')
const STATE_DIR = path.join(ROOT, 'state')
const OUT = path.join(STATE_DIR, 'fleet-pulse.json')

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s }
function readJSON(p) {
  try {
    const raw = stripBom(fs.readFileSync(p, 'utf-8')).trim()
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}
function readJSONL(p) {
  try {
    let raw = stripBom(fs.readFileSync(p, 'utf-8'))
    if (!raw.trim()) return []
    return raw.split(/\r?\n/).map((l) => {
      if (!l.trim()) return null
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}
function todayKey() { return new Date().toISOString().slice(0, 10) }
// waiting_approval 启发式：running 态 agent 的 step 含审批关键词（dispatch 侧未来可写结构化标记）
function looksWaiting(step) { return /审批|approve|allow|批准|确认执行/i.test(step || '') }

function buildPulse() {
  const today = todayKey()
  const allTasks = readJSONL(path.join(STATE_DIR, 'tasks.jsonl'))
  const taskMap = {}
  for (const e of allTasks) {
    if (e.task && e.task.id) taskMap[e.task.id] = e.task
    if (e.op === 'update' && e.task_id && taskMap[e.task_id] && e.status) taskMap[e.task_id].status = e.status
  }
  let dirs = []
  try {
    dirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'archive').map((d) => d.name)
  } catch { /* ignore */ }
  const fleet = { online: 0, running: 0, waiting_approval: 0, blocked: 0, error: 0 }
  let todayCost = 0
  let topTask = null
  for (const id of dirs) {
    const dir = path.join(AGENTS_DIR, id)
    const manifest = readJSON(path.join(dir, 'manifest.json'))
    if (!manifest) continue
    const control = readJSON(path.join(dir, 'control.json'))
    const status = readJSON(path.join(dir, 'status.json'))
    const enabled = control ? !!control.enabled : false
    const alive = !!(status && status.state && status.state !== 'stopped')
    if (enabled && alive) fleet.online++
    const st = status ? status.state : null
    if (st === 'running') {
      fleet.running++
      if (looksWaiting(status.step)) fleet.waiting_approval++
      if (!topTask && status.current_task && taskMap[status.current_task]) {
        topTask = taskMap[status.current_task].id
      } else if (!topTask && status.current_task) {
        topTask = status.current_task
      }
    } else if (st === 'blocked') {
      fleet.blocked++
    } else if (st === 'error') {
      fleet.error++
    }
    for (const u of readJSONL(path.join(dir, 'usage.jsonl'))) {
      if (u.ts && u.ts.startsWith(today) && typeof u.cost === 'number') todayCost += u.cost
    }
  }
  return {
    v: 2,
    ts: new Date().toISOString(),
    fleet,
    today_cost: Math.round(todayCost * 1000000) / 1000000,
    top_task: topTask,
  }
}

function publish() {
  const pulse = buildPulse()
  const text = JSON.stringify(pulse)
  const tmp = OUT + '.tmp'
  fs.writeFileSync(tmp, text, 'utf-8')
  fs.renameSync(tmp, OUT) // 原子写：与 pet.json/bootstrap.json 同一铁律
  console.log(`[pulse] ${text}`)
}

const ivArg = process.argv.find((a) => a.startsWith('--interval-ms'))
if (ivArg) {
  const ms = parseInt(ivArg.split('=')[1] || '5000', 10)
  if (!(ms > 0)) { console.error('[pulse] 非法 --interval-ms'); process.exit(2) }
  publish()
  setInterval(publish, ms)
} else {
  publish()
}
