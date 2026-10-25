// config-drift.test.mjs — P0-B（2026-10-21）：模型来源探测与配置漂移判定单测
//
// 覆盖 workers/lib/config-drift.cjs（纯函数）与 workers/discovery/agent-drift.mjs（只读 CLI）：
//   · 适配器表加载：缺文件 / 坏 JSON / 单条非法 都显式报问题（不静默回退）
//   · 三种格式：json / jsonc（去注释）/ yaml-regex（标量抓取）
//   · 漂移五态：match / replaced / missing / parse-error / unknown
//   · **只读纪律**：探测前后配置文件字节不变（含 CLI 路径）
//   · CLI：--check 在适配器覆盖完整时 exit 0、缺适配器时 exit 1；--json 带漂移结果仍 exit 0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import drift from '../workers/lib/config-drift.cjs'
import agentFacts from '../workers/lib/agent-facts.cjs'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRIFT_CLI = join(FLEET_DIR, 'workers', 'discovery', 'agent-drift.mjs')

function makeRoot(t, adapters, agents) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-drift-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'shared'), { recursive: true })
  mkdirSync(join(root, 'agents'), { recursive: true })
  if (adapters !== null) {
    writeFileSync(join(root, 'shared', 'agent-adapters.json'), JSON.stringify(adapters, null, 2) + '\n', 'utf8')
  }
  for (const [id, manifest] of Object.entries(agents || {})) {
    mkdirSync(join(root, 'agents', id), { recursive: true })
    writeFileSync(join(root, 'agents', id, 'manifest.json'), JSON.stringify({
      id, name: id, runtime: 'cli', kind: 'coding-agent',
      capability_boundary: { tool_loop: 'yes' },
      cli: { command: id, binPath: '%USERPROFILE%\\x.exe', version: '1.0.0', invoke: `${id} -p {prompt}` },
      limits: { budget_per_day: 2, timeout_ms: 60000, heartbeat_ms: 30000 },
      metering_source: 'unknown',
      ...manifest,
    }, null, 2) + '\n', 'utf8')
  }
  return root
}

function writeText(p, text) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text, 'utf8')
  return p
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('expandPath：%VAR% 与 ~ 展开；未定义变量原样保留（不猜）', () => {
  assert.equal(drift.expandPath('%USERPROFILE%/.claude/settings.json', { USERPROFILE: 'C:/workspace/demo' }, 'C:/workspace/home'), 'C:/workspace/demo/.claude/settings.json')
  assert.equal(drift.expandPath('~/.pi/settings.json', {}, 'C:/workspace/demo'), 'C:/workspace/demo/.pi/settings.json')
  assert.equal(drift.expandPath('%UNKNOWN_VAR%/x', {}, 'C:/workspace/h'), '%UNKNOWN_VAR%/x', '变量未定义时保留占位，不静默变空串')
})

test('displayPath：仓库外 home 路径脱敏为 %USERPROFILE%（evidence 会写入公开仓 manifest）', () => {
  assert.equal(
    drift.displayPath('C:/workspace/repo', 'C:\\Users\\<demo>/.claude/settings.json', 'C:\\Users\\<demo>'),
    '%USERPROFILE%/.claude/settings.json',
    '混合分隔符也必须命中 home 前缀（2026-10-21 实测踩坑）',
  )
})

test('stripJsonComments：去行注释与块注释，字符串里的 // 不误伤', () => {
  const src = [
    '{',
    '  // 行注释',
    '  "url": "https://example.test/a//b", /* 块注释 */',
    '  "model": "m1"',
    '}',
  ].join('\n')
  const parsed = JSON.parse(drift.stripJsonComments(src))
  assert.equal(parsed.model, 'm1')
  assert.equal(parsed.url, 'https://example.test/a//b', '字符串内的 // 必须保留')
})

test('getPath：嵌套对象与数组下标', () => {
  const obj = { recent: [{ modelID: 'm-1' }], env: { ANTHROPIC_MODEL: 'step-5-preview[1M]' } }
  assert.equal(drift.getPath(obj, ['recent', 0, 'modelID']), 'm-1')
  assert.equal(drift.getPath(obj, ['env', 'ANTHROPIC_MODEL']), 'step-5-preview[1M]')
  assert.equal(drift.getPath(obj, ['nope', 0]), undefined)
})

test('loadAdapters：缺文件 / 坏 JSON / 单条非法都显式报 problem', (t) => {
  const missing = makeRoot(t, null, {})
  const r1 = drift.loadAdapters(missing)
  assert.equal(r1.problems.length, 1)
  assert.match(r1.problems[0].message, /不存在/)

  const bad = makeRoot(t, {}, {})
  writeFileSync(join(bad, 'shared', 'agent-adapters.json'), '{ not json', 'utf8')
  const r2 = drift.loadAdapters(bad)
  assert.match(r2.problems[0].message, /JSON 解析失败/)

  const invalid = makeRoot(t, { a: { format: 'toml', paths: ['x'] } }, {})
  const r3 = drift.loadAdapters(invalid)
  assert.equal(r3.problems.length, 1)
  assert.match(r3.problems[0].message, /format 非法/)
})

test('loadAdapters：合法条目按 agent 收口，$ 元数据键跳过', (t) => {
  const root = makeRoot(t, {
    $schema_version: 1,
    a: { format: 'json', paths: ['/x/a.json'], model_path: ['model'] },
  }, {})
  const r = drift.loadAdapters(root)
  assert.deepEqual(Object.keys(r.adapters), ['a'])
  assert.equal(r.problems.length, 0)
})

// ---------------------------------------------------------------------------
// 探测：三种格式 + 四种失败形态
// ---------------------------------------------------------------------------

test('probeAgent：JSON 路径读到模型与 provider', () => {
  const adapter = { format: 'json', paths: [join(tmpdir(), 'drift-json-fixture.json')], model_path: ['env', 'MODEL'], provider_path: ['provider'] }
  writeText(adapter.paths[0], JSON.stringify({ env: { MODEL: 'step-5-preview[1M]' }, provider: 'stepfun' }))
  const p = drift.probeAgent(adapter, { root: tmpdir() })
  assert.equal(p.status, 'ok')
  assert.equal(p.model, 'step-5-preview[1M]')
  assert.equal(p.provider, 'stepfun')
  rmSync(adapter.paths[0], { force: true })
})

test('probeAgent：JSONC 去注释后可读；yaml-regex 抓标量', () => {
  const jsonc = writeText(join(tmpdir(), 'drift-jsonc-fixture.jsonc'), '{\n // c\n "model": "m2"\n}\n')
  const p1 = drift.probeAgent({ format: 'jsonc', paths: [jsonc], model_path: ['model'] }, { root: tmpdir() })
  assert.equal(p1.status, 'ok')
  assert.equal(p1.model, 'm2')

  const yaml = writeText(join(tmpdir(), 'drift-yaml-fixture.yml'), [
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek',
    '    model: deepseek-flash',
  ].join('\n') + '\n')
  const p2 = drift.probeAgent({
    format: 'yaml-regex',
    paths: [yaml],
    model_regex: 'id:\\s*agent-default-model[\\s\\S]{0,240}?\\bmodel:\\s*([^\\s#]+)',
    provider_regex: 'id:\\s*agent-default-model[\\s\\S]{0,240}?\\bprovider:\\s*([^\\s#]+)',
  }, { root: tmpdir() })
  assert.equal(p2.status, 'ok')
  assert.equal(p2.model, 'deepseek-flash')
  assert.equal(p2.provider, 'deepseek')
  rmSync(jsonc, { force: true })
  rmSync(yaml, { force: true })
})

test('probeAgent：missing / parse-error / unknown 三态各自可区分（不猜）', () => {
  const missing = drift.probeAgent({ format: 'json', paths: [join(tmpdir(), 'drift-does-not-exist.json')], model_path: ['model'] }, { root: tmpdir() })
  assert.equal(missing.status, 'missing')
  assert.match(missing.detail, /不存在/)

  const bad = writeText(join(tmpdir(), 'drift-bad.json'), '{ "model": ')
  const parseErr = drift.probeAgent({ format: 'json', paths: [bad], model_path: ['model'] }, { root: tmpdir() })
  assert.equal(parseErr.status, 'parse-error')

  const noModel = writeText(join(tmpdir(), 'drift-no-model.json'), JSON.stringify({ provider: 'x' }))
  const unknown = drift.probeAgent({ format: 'json', paths: [noModel], model_path: ['model'] }, { root: tmpdir() })
  assert.equal(unknown.status, 'unknown')
  assert.match(unknown.detail, /未找到模型字段/)

  rmSync(bad, { force: true })
  rmSync(noModel, { force: true })
})

test('classifyDrift：match / replaced / missing / parse-error / unknown 五态', () => {
  assert.equal(drift.classifyDrift('m1', { status: 'ok', model: 'm1' }).status, 'match')
  assert.equal(drift.classifyDrift('m1', { status: 'ok', model: 'm2' }).status, 'replaced')
  assert.equal(drift.classifyDrift('m1', { status: 'missing' }).status, 'missing')
  assert.equal(drift.classifyDrift('m1', { status: 'parse-error' }).status, 'parse-error')
  assert.equal(drift.classifyDrift(null, { status: 'ok', model: 'm1' }).status, 'unknown', '档案未声明不算 match')
  assert.equal(drift.classifyDrift('m1', { status: 'unknown' }).status, 'unknown')
})

// ---------------------------------------------------------------------------
// 只读纪律 + CLI
// ---------------------------------------------------------------------------

test('只读：探测前后配置文件字节不变（agent-drift 的硬约束）', (t) => {
  const cfg = writeText(join(tmpdir(), 'drift-ro-fixture.json'), JSON.stringify({ model: 'm-keep' }))
  const before = readFileSync(cfg)
  const root = makeRoot(t, { a: { format: 'json', paths: [cfg], model_path: ['model'] } }, { a: { model_info: { value: 'm-keep', source: 'config' } } })
  drift.probeAgent({ format: 'json', paths: [cfg], model_path: ['model'] }, { root })
  assert.deepEqual(readFileSync(cfg), before, '只读探测不得改用户配置')
  rmSync(cfg, { force: true })
})

function runDrift(root, args) {
  // stdio: 'ignore' —— 受限沙箱下捕获子进程管道会 EPERM（本仓既有教训）；断言只看退出码。
  const r = spawnSync(process.execPath, [DRIFT_CLI, ...args], {
    cwd: FLEET_DIR,
    env: { ...process.env, BUS_ROOT: root },
    stdio: 'ignore',
  })
  return r.status
}

test('CLI：适配器覆盖完整 ⇒ --check exit 0；缺适配器 ⇒ exit 1', (t) => {
  const cfg = writeText(join(tmpdir(), 'drift-cli-fixture.json'), JSON.stringify({ model: 'm1' }))
  const adapters = { a: { format: 'json', paths: [cfg], model_path: ['model'] } }
  const okRoot = makeRoot(t, adapters, { a: { model_info: { value: 'm1', source: 'config' } } })
  assert.equal(runDrift(okRoot, ['--check']), 0)

  const gapRoot = makeRoot(t, adapters, { b: { model_info: { value: null, source: 'unknown' } } })
  assert.equal(runDrift(gapRoot, ['--check']), 1, 'coding-agent 缺适配器必须让 --check 失败（否则静默漏检）')
  rmSync(cfg, { force: true })
})

test('CLI：--json 带漂移结果（missing）仍 exit 0 —— 漂移是事实不是错误', (t) => {
  const adapters = { a: { format: 'json', paths: [join(tmpdir(), 'drift-cli-missing.json')], model_path: ['model'] } }
  const root = makeRoot(t, adapters, { a: { model_info: { value: 'm1', source: 'config' } } })
  assert.equal(runDrift(root, ['--json']), 0)
})

test('真实 fleet：适配器覆盖所有活动 coding-agent（否则 --check 会静默漏检）', () => {
  const loaded = drift.loadAdapters(FLEET_DIR)
  assert.equal(loaded.problems.length, 0, JSON.stringify(loaded.problems))
  const agentsDir = join(FLEET_DIR, 'agents')
  const codingAgents = readdirSync(agentsDir)
    .filter((d) => d !== 'archive')
    .filter((d) => {
      try { return agentFacts.readAgentFactsFrom(join(agentsDir, d)).kind === 'coding-agent' } catch { return false }
    })
  assert.ok(codingAgents.length >= 5, `真实 fleet 应有 ≥5 个 coding-agent（实得 ${codingAgents.length}）`)
  for (const id of codingAgents) {
    assert.ok(loaded.adapters[id], `shared/agent-adapters.json 缺 ${id} 的适配器`)
  }
})
