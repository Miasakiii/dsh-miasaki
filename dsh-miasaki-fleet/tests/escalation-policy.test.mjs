// escalation-policy.test.mjs — G5 语义分级闸门（2026-11-02）
//
// 覆盖 workers/lib/escalation-policy.cjs（纯函数）与其 CLI：
//   · 七类清单逐类命中（删数据 / 停服 / 花钱 / 对外发消息 / 改产品方向 / 密钥 / 权限）；
//   · **误报控制**：技术讨论（「权限不足」「密钥管理」「数据迁移」）不得命中 ——
//     误报会训练 Operator 忽略告警，比漏报贵（漏报可追认）；
//   · 空 / null / 非字符串输入安全返回未命中；
//   · 每类至多一条 evidence；
//   · CLI：--stdin --json / --list / 用法错误 exit 2 / --file 读取失败 exit 1。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import policy from '../workers/lib/escalation-policy.cjs'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(FLEET_DIR, 'workers', 'lib', 'escalation-policy.cjs')

function runCli(args, stdinText) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input: stdinText ?? '',
    encoding: 'utf8',
  })
}

// ---- 纯函数：七类逐类命中 -----------------------------------------------

test('七类清单逐类命中（每类一个正例）', () => {
  const cases = [
    ['本任务要删除数据库中的历史数据', 'delete_data'],
    ['需要停服十分钟做维护', 'stop_service'],
    ['去购买一台新服务器', 'spend_money'],
    ['给所有用户群发通知', 'external_message'],
    ['这次要调整产品方向', 'product_direction'],
    ['申请创建新密钥并轮换凭证', 'key_rotation'],
    ['修改该 agent 的权限配置', 'permissions'],
  ]
  for (const [text, category] of cases) {
    const r = policy.classifyEscalation(text)
    assert.equal(r.escalate, true, `应命中: ${text}`)
    assert.ok(r.hits.some((h) => h.category === category), `应命中 ${category}: ${text} → ${JSON.stringify(r.hits)}`)
  }
})

test('同一段文本命中多类时全部列出（不短路）', () => {
  const r = policy.classifyEscalation('删除数据并停服，顺便群发公告')
  assert.equal(r.escalate, true)
  const cats = r.hits.map((h) => h.category)
  for (const c of ['delete_data', 'stop_service', 'external_message']) {
    assert.ok(cats.includes(c), `应含 ${c}: ${cats}`)
  }
})

test('每类至多一条 evidence（同类重复命中只报首个）', () => {
  const r = policy.classifyEscalation('删除数据，再删除一遍数据')
  assert.equal(r.escalate, true)
  assert.equal(r.hits.filter((h) => h.category === 'delete_data').length, 1)
})

// ---- 纯函数：误报控制（比漏报贵，逐条钉死） -------------------------------

test('误报控制：技术讨论不命中七类清单', () => {
  const clean = [
    '该 agent 权限不足，只能只读执行',             // permissions：裸「权限」是技术陈述
    '密钥管理文档需要补充存放位置说明',             // key_rotation：无动作词的「密钥」是文档话题
    '设计数据迁移方案并评估风险',                   // delete_data：「迁移」不是删除
    '把这一行文案改短一点',                         // 普通改动
    '修复 verify-all 报的三个红灯',                 // 日常维护
    '补充 README 的回归清单说明',                   // 文档
  ]
  for (const text of clean) {
    const r = policy.classifyEscalation(text)
    assert.equal(r.escalate, false, `不应命中: ${text} → ${JSON.stringify(r.hits)}`)
  }
})

test('空 / null / 非字符串输入安全返回未命中（不抛）', () => {
  for (const v of ['', '   ', null, undefined, 42, {}, []]) {
    const r = policy.classifyEscalation(v)
    assert.equal(r.escalate, false)
    assert.deepEqual(r.hits, [])
  }
})

test('evidence 截断到 40 字（事件单行 <4096 字节的上游约束）', () => {
  const long = `删除数据${'说明'.repeat(60)}`
  const r = policy.classifyEscalation(long)
  assert.equal(r.escalate, true)
  assert.ok(r.hits[0].evidence.length <= 41, `evidence 应被截断: ${r.hits[0].evidence.length}`)
})

test('listCategories 返回七类（CLI --list 与单测共用一份清单）', () => {
  const list = policy.listCategories()
  assert.equal(list.length, 7)
  assert.deepEqual(list.map((c) => c.category), [
    'delete_data', 'stop_service', 'spend_money', 'external_message',
    'product_direction', 'key_rotation', 'permissions',
  ])
})

// ---- CLI：输入输出与退出码 ------------------------------------------------

test('CLI：--stdin --json 输出单行 JSON 且 exit 0', () => {
  const r = runCli(['--stdin', '--json'], '本任务删除数据')
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split(/\r?\n/)
  assert.equal(lines.length, 1, 'stdout 应恰一行 JSON')
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.escalate, true)
  assert.equal(parsed.hits[0].category, 'delete_data')
})

test('CLI：未命中时 escalate=false 且 exit 0', () => {
  const r = runCli(['--stdin', '--json'], '改一行文案')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout.trim()).escalate, false)
})

test('CLI：--list 输出七类且 exit 0', () => {
  const r = runCli(['--list'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout.trim()).length, 7)
})

test('CLI：无输入源 = 用法错误 exit 2（不猜默认输入）', () => {
  const r = runCli(['--json'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /用法/)
})

test('CLI：--file 读取失败 exit 1（显式失败，不静默当未命中）', () => {
  const r = runCli(['--file', join(tmpdir(), 'fleet-escalation-不存在的文件-xyz.md')])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /读取文件失败/)
})

test('CLI：--file 正常读取并判定', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-escalation-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const f = join(dir, 'brief.md')
  writeFileSync(f, '对外发消息给全部用户\n', 'utf8')
  const r = runCli(['--file', f, '--json'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout.trim()).hits[0].category, 'external_message')
})
