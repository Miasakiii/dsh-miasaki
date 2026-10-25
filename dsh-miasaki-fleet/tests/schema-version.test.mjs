// schema-version.test.mjs — P2-E（2026-10-21）：manifest / observed 的 schema 版本与迁移
//
// 覆盖：
//   · classifySchema：missing / legacy / current / future / invalid 五态；
//   · migrateSchema：只标注版本、字段原样保留；future 拒绝降级；
//   · CLI migrate-schema：--check 不写盘；迁移经 bus-apply 一次超步；future 显式失败。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import schema from '../workers/lib/schema-version.cjs'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(FLEET_DIR, 'workers', 'discovery', 'migrate-schema.mjs')

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-schema-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(join(FLEET_DIR, 'workers'), join(root, 'workers'), { recursive: true })
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(join(root, 'state', 'graph-events.jsonl'), '', 'utf8')
  return root
}

function writeAgent(root, id, manifest, observed) {
  const dir = join(root, 'agents', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  if (observed !== undefined) writeFileSync(join(dir, 'observed.json'), JSON.stringify(observed, null, 2) + '\n', 'utf8')
}

function readManifest(root, id) {
  return JSON.parse(readFileSync(join(root, 'agents', id, 'manifest.json'), 'utf8'))
}

function runCli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: FLEET_DIR,
    env: { ...process.env, BUS_ROOT: root },
    stdio: 'ignore',
  })
  return r.status
}

const MANIFEST = { id: 'alpha', name: 'Alpha', runtime: 'cli', limits: { budget_per_day: 2, timeout_ms: 1000, heartbeat_ms: 1000 } }
const OBSERVED = { agent_id: 'alpha', observed_at: '2026-10-21T00:00:00Z', present: true, kind: 'coding-agent', cli: { command: 'alpha', binPath: '%USERPROFILE%\\alpha.exe', version: '1', invoke: 'alpha -p {prompt}' } }

test('classifySchema：missing=legacy / 1=legacy / 2=current / 3=future / 非整数=invalid', () => {
  assert.equal(schema.CURRENT_SCHEMA_VERSION, 2)
  assert.equal(schema.classifySchema({}).status, 'missing')
  assert.equal(schema.classifySchema({ schema_version: 1 }).status, 'legacy')
  assert.equal(schema.classifySchema({ schema_version: 2 }).status, 'current')
  assert.equal(schema.classifySchema({ schema_version: 3 }).status, 'future')
  assert.equal(schema.classifySchema({ schema_version: '2' }).status, 'invalid')
  assert.equal(schema.classifySchema(null).status, 'invalid')
})

test('migrateSchema：只标注版本、其余字段原样保留；future 拒绝降级', () => {
  const src = { id: 'a', limits: { budget_per_day: 2 } }
  const r = schema.migrateSchema(src)
  assert.equal(r.changed, true)
  assert.equal(r.doc.schema_version, 2)
  assert.deepEqual(r.doc.limits, { budget_per_day: 2 })
  assert.equal(src.schema_version, undefined, '纯函数不得修改入参')

  const future = schema.migrateSchema({ schema_version: 3 })
  assert.equal(future.changed, false)
  assert.equal(future.doc.schema_version, 3, '未来版本不降级')
  assert.match(future.reason, /未来版本/)
})

test('CLI：--check 不写盘；迁移把 manifest/observed 标到 v2；重复跑无变化', (t) => {
  const root = makeRoot(t)
  writeAgent(root, 'alpha', MANIFEST, OBSERVED)
  writeAgent(root, 'beta', { ...MANIFEST, id: 'beta', schema_version: 1 }, { ...OBSERVED, agent_id: 'beta', schema_version: 2 })

  assert.equal(runCli(root, ['--check']), 0)
  assert.equal(readManifest(root, 'alpha').schema_version, undefined, '--check 不得写盘')

  assert.equal(runCli(root, []), 0)
  assert.equal(readManifest(root, 'alpha').schema_version, 2)
  assert.equal(JSON.parse(readFileSync(join(root, 'agents', 'alpha', 'observed.json'), 'utf8')).schema_version, 2)
  assert.equal(readManifest(root, 'beta').schema_version, 2)

  assert.equal(runCli(root, ['--check']), 0, '迁移后预检应通过（无需迁移）')
})

test('CLI：future 版本 ⇒ 显式失败（exit 1），不写盘', (t) => {
  const root = makeRoot(t)
  writeAgent(root, 'gamma', { ...MANIFEST, id: 'gamma', schema_version: 3 }, OBSERVED)
  assert.equal(runCli(root, ['--check']), 1)
  assert.equal(readManifest(root, 'gamma').schema_version, 3, '未来版本档案不被改写')
})
