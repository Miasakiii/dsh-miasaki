// profile.test.mjs — P2-G（2026-10-21）：fleet profiles（Operator 快照）
//
// 覆盖：
//   · profiles 文档校验 / getProfile / listProfileIds；
//   · diffProfile：control 方向 + budget 差分 + 未知 agent 显式报出；
//   · CLI：--check 不写盘；apply 经 bus-apply 落 control/manifest；重复 apply 无需变更；
//     未知 profile exit 2；profile 引用未知 agent exit 1（不静默忽略）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import profileLib from '../workers/lib/profile.cjs'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(FLEET_DIR, 'workers', 'profile', 'apply-profile.mjs')

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(join(FLEET_DIR, 'workers'), join(root, 'workers'), { recursive: true })
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(root, 'shared'), { recursive: true })
  mkdirSync(join(root, 'agents'), { recursive: true })
  writeFileSync(join(root, 'state', 'graph-events.jsonl'), '', 'utf8')
  return root
}

function writeAgent(root, id, { enabled = false, budget = 2 } = {}) {
  const dir = join(root, 'agents', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    schema_version: 2, id, name: id.toUpperCase(), runtime: 'cli', model: 'cli-default', model_price: null,
    metering: false, metering_source: 'unknown', skills: ['coding'], persona_prompt: 'x',
    limits: { max_tokens_per_task: 50000, max_concurrent_tasks: 1, budget_per_day: budget, timeout_ms: 60000, heartbeat_ms: 30000 },
    updated_at: '2026-10-21T00:00:00Z',
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(dir, 'observed.json'), JSON.stringify({
    schema_version: 2, agent_id: id, observed_at: '2026-10-21T00:00:00Z', present: true, runtime_kind: 'fake', kind: 'coding-agent',
    cli: { command: id, binPath: '%USERPROFILE%\\x.exe', version: '1', invoke: id + ' -p {prompt}' },
    capabilities: ['coding'], capability_boundary: { tool_loop: 'yes', workspace_read: 'yes', workspace_write_headless: 'no', shell_headless: 'no', network: 'yes' },
    model_info: { value: null, source: 'unknown', confidence: 'unknown' },
    permissions: { mode: 'unknown', calibration: 'unknown' },
    preflight: 'ok',
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(dir, 'control.json'), JSON.stringify({ enabled, force_kill: false }, null, 2) + '\n', 'utf8')
}

function writeProfiles(root, profiles) {
  writeFileSync(join(root, 'shared', 'profiles.json'), JSON.stringify({ version: 1, profiles }, null, 2) + '\n', 'utf8')
}

function runCli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: FLEET_DIR,
    env: { ...process.env, BUS_ROOT: root },
    encoding: 'utf8',
  })
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

function readControl(root, id) {
  return JSON.parse(readFileSync(join(root, 'agents', id, 'control.json'), 'utf8'))
}

function readBudget(root, id) {
  return JSON.parse(readFileSync(join(root, 'agents', id, 'manifest.json'), 'utf8')).limits.budget_per_day
}

const AGENTS = [
  { id: 'alpha', enabled: false, budget_per_day: 2 },
  { id: 'beta', enabled: true, budget_per_day: 2 },
]

test('validateProfiles：合法通过；enabled 非数组 / 未知预算键 / 重复 id ⇒ 报问题', () => {
  assert.equal(profileLib.validateProfiles({ version: 1, profiles: { lean: { enabled: ['alpha'] } } }).ok, true)

  const bad = profileLib.validateProfiles({
    version: 1,
    profiles: {
      lean: { enabled: 'alpha' },
      'Bad_Id': { enabled: ['alpha', 'alpha'] },
      ok: { enabled: ['alpha'], budgets: { alpha: -1 } },
    },
  })
  assert.equal(bad.ok, false)
  const msgs = bad.problems.map((p) => p.where + ':' + p.message).join('|')
  assert.match(msgs, /enabled 应为 array/)
  assert.match(msgs, /profile id 非法/)
  assert.match(msgs, /agent id 重复/)
  assert.match(msgs, /budget 应为非负数/)
})

test('diffProfile：同时算 control 方向与 budget 差分；未知 agent 显式返回', () => {
  const doc = { version: 1, profiles: { lean: { enabled: ['alpha'], budgets: { alpha: 5 } } } }
  const p = profileLib.getProfile(doc, 'lean')
  const d = profileLib.diffProfile(p, AGENTS)
  assert.deepEqual(d.unknownAgents, [])
  assert.deepEqual(d.changes, [
    { agent_id: 'alpha', kind: 'control', from: false, to: true },
    { agent_id: 'alpha', kind: 'budget', from: 2, to: 5 },
    { agent_id: 'beta', kind: 'control', from: true, to: false },
  ])

  const d2 = profileLib.diffProfile({ enabled: ['ghost'] }, AGENTS)
  assert.deepEqual(d2.unknownAgents, ['ghost'])
})

test('CLI：--list / --check 不写盘；apply 落 control + budget；重复 apply 无需变更', (t) => {
  const root = makeRoot(t)
  writeAgent(root, 'alpha', { enabled: false, budget: 2 })
  writeAgent(root, 'beta', { enabled: true, budget: 2 })
  writeProfiles(root, { lean: { description: '省预算', enabled: ['alpha'], budgets: { alpha: 5 } } })

  assert.equal(runCli(root, ['--list']).status, 0)
  assert.equal(runCli(root, ['--profile', 'lean', '--check']).status, 0)
  assert.equal(readControl(root, 'beta').enabled, true, '--check 不得写盘')
  assert.equal(readBudget(root, 'alpha'), 2, '--check 不得写盘')

  assert.equal(runCli(root, ['--profile', 'lean']).status, 0)
  assert.equal(readControl(root, 'alpha').enabled, true, 'alpha 应被启用')
  assert.equal(readControl(root, 'beta').enabled, false, '未列出的 beta 应被关闭（快照语义）')
  assert.equal(readBudget(root, 'alpha'), 5, '预算应落 manifest.limits')

  const again = runCli(root, ['--profile', 'lean'])
  assert.equal(again.status, 0)
  assert.match(again.stdout, /无需变更/)
})

test('CLI：未知 profile ⇒ exit 2；引用未知 agent ⇒ exit 1 且不写盘', (t) => {
  const root = makeRoot(t)
  writeAgent(root, 'alpha', { enabled: true, budget: 2 })
  writeProfiles(root, { typo: { enabled: ['ghost'] } })

  assert.equal(runCli(root, ['--profile', 'nope']).status, 2)
  const r = runCli(root, ['--profile', 'typo'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /未知 agent/)
  assert.equal(readControl(root, 'alpha').enabled, true, '校验失败不得改 control')
})
