// dispatch-state.test.mjs — K4 派单终态判定单测（2026-09-30）
//
// 覆盖 workers/dispatch/final-state.ps1：**「CLI exit 0」不等于「健康空闲」**。
// 修的是矩阵台账 K4 / 内部计划静默失效 #24：
//   派单器过去 `$state = if ($exitCode -eq 0) { 'idle' } else { 'error' }`
//   ⇒ 自述受阻（交付契约 result.json 的 status=blocked）的 worker 被记成
//   「健康空闲」，面板与桌宠照常显示正常 —— 失败形态是「一切看起来都好」。
//
// 做法：spawnSync 调 pwsh **stdio:'ignore'**，结果经 `-OutFile` 回读 ——
// 受限沙箱下捕获子进程管道会 EPERM（本仓已有教训），落盘回读完全绕开这一点。
// pwsh 不存在时整组 skip（不假装通过）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(FLEET_DIR, 'workers', 'dispatch', 'final-state.ps1')

/**
 * 找一个可用的 PowerShell。
 * 顺序：PS7 的已知安装路径（本机 pwsh 常不在 PATH —— dispatch-task.ps1 头部亦记载此事）
 *      → PATH 里的 pwsh → Windows PowerShell 5.1。
 * 一律带 `-ExecutionPolicy Bypass`：默认策略会拒绝执行未签名脚本（实测 SecurityError），
 * 那是机器策略问题，不是脚本问题。
 */
function detectPwsh() {
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    'pwsh',
    'powershell',
  ].filter(Boolean)
  for (const exe of candidates) {
    const r = spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0'], { stdio: 'ignore' })
    if (!r.error && r.status === 0) return exe
  }
  return null
}
const PWSH = detectPwsh()

/**
 * 跑一次判定，返回解析后的 JSON。
 * @param t 测试上下文（用于清理临时目录）
 * @param exitCode CLI 退出码
 * @param result 写进 tasks/<id>/result.json 的对象；undefined = 不写（无交付契约）
 */
function run(t, exitCode, result) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const resultPath = join(dir, 'result.json')
  if (result !== undefined) writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8')
  const outFile = join(dir, 'out.json')
  const r = spawnSync(PWSH, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    '-ExitCode', String(exitCode),
    '-ResultPath', resultPath,
    '-OutFile', outFile,
  ], { stdio: 'ignore' })
  assert.equal(r.status, 0, 'final-state.ps1 应正常退出（判定本身不因坏输入而失败）')
  return JSON.parse(readFileSync(outFile, 'utf8'))
}

/** 一个合法的交付契约骨架。 */
function contract(over) {
  return { task_id: 't-0001', status: 'completed', conclusion: '完成', evidence: [], blockers: [], ...over }
}

test('exit 0 且无交付契约 → idle（原行为不变）', (t) => {
  if (!PWSH) return t.skip('本机无 pwsh / powershell')
  const r = run(t, 0, undefined)
  assert.equal(r.state, 'idle')
  assert.equal(r.source, 'exit-code')
})

test('exit 非 0 且无交付契约 → error（原行为不变）', (t) => {
  if (!PWSH) return t.skip('本机无 pwsh / powershell')
  assert.equal(run(t, 3, undefined).state, 'error')
})

test('exit 0 但契约标 completed → 仍是 idle（正常交付不被误判）', (t) => {
  if (!PWSH) return t.skip('本机无 pwsh / powershell')
  const r = run(t, 0, contract({}))
  assert.equal(r.state, 'idle')
})

test('K4 核心：exit 0 但 worker 自述 blocked → blocked，且原因带出 blockers', (t) => {
  if (!PWSH) return t.skip('本机无 pwsh / powershell')
  const r = run(t, 0, contract({ status: 'blocked', blockers: ['等待人工审批', '缺 DEEPSEEK_API_KEY'] }))
  assert.equal(r.state, 'blocked', 'CLI 没报错不等于没卡住 —— 不能记成健康空闲')
  assert.equal(r.source, 'result.json:blocked')
  assert.match(r.reason, /等待人工审批/)
  assert.match(r.reason, /缺 DEEPSEEK_API_KEY/)
})

test('exit 0 但契约标 failed → error', (t) => {
  if (!PWSH) return t.skip('本机无 pwsh / powershell')
  const r = run(t, 0, contract({ status: 'failed', blockers: ['编译失败'] }))
  assert.equal(r.state, 'error')
  assert.equal(r.source, 'result.json:failed')
})

test('blocked 但 blockers 为空 → 仍判 blocked，原因如实写「未说明卡在哪」', (t) => {
  if (!PWSH) return t.skip('本机无 pwsh / powershell')
  const r = run(t, 0, contract({ status: 'blocked', blockers: [] }))
  assert.equal(r.state, 'blocked')
  assert.match(r.reason, /未说明卡在哪/)
})

test('CLI 也失败 + 契约标 blocked → error，但原因取契约（比 exit code 更有信息量）', (t) => {
  if (!PWSH) return t.skip('本机无 pwsh / powershell')
  const r = run(t, 3, contract({ status: 'blocked', blockers: ['上游不可用'] }))
  assert.equal(r.state, 'error')
  assert.equal(r.source, 'exit-code+result.json:blocked')
  assert.match(r.reason, /上游不可用/)
})

test('契约损坏（非法 JSON）→ 回退 exit code 判定，不抛错', (t) => {
  if (!PWSH) return t.skip('本机无 pwsh / powershell')
  const dir = mkdtempSync(join(tmpdir(), 'fleet-state-bad-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const resultPath = join(dir, 'result.json')
  writeFileSync(resultPath, '{ 这不是 JSON', 'utf8')
  const outFile = join(dir, 'out.json')
  const r = spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ExitCode', '0', '-ResultPath', resultPath, '-OutFile', outFile], { stdio: 'ignore' })
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(readFileSync(outFile, 'utf8')).state, 'idle')
})

test('两个派单脚本都能被解析（语法闸门：PowerShell 侧此前无任何自动化检查）', (t) => {
  if (!PWSH) return t.skip('本机无 pwsh / powershell')
  const targets = [
    join(FLEET_DIR, 'workers', 'dispatch', 'final-state.ps1'),
    join(FLEET_DIR, 'workers', 'dispatch', 'dispatch-task.ps1'),
  ]
  const dir = mkdtempSync(join(tmpdir(), 'fleet-syntax-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const errFile = join(dir, 'errors.txt')
  // 用 PS7 解析：dispatch-task.ps1 头部明示「运行环境 PowerShell 7+（脚本使用 ?? 运算符）」，
  // Windows PowerShell 5.1 的解析器会把 ?? 误报为语法错误 —— 那是解析器旧，不是脚本坏。
  const cmd = [
    '$all = @()',
    `foreach ($f in @(${targets.map((p) => `'${p}'`).join(', ')})) {`,
    '  $e = $null; $t = $null',
    '  [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e) | Out-Null',
    '  if ($e) { $all += $e }',
    '}',
    `if ($all.Count -gt 0) { $all | ForEach-Object { '{0}:{1}: {2}' -f $_.Extent.File, $_.Extent.StartLineNumber, $_.Message } | Set-Content '${errFile}' -Encoding UTF8; exit 1 }`,
    'exit 0',
  ].join('\n')
  const r = spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { stdio: 'ignore' })
  const detail = existsSync(errFile) ? readFileSync(errFile, 'utf8').trim() : '(无详情)'
  assert.equal(r.status, 0, `PowerShell 语法错误：\n${detail}`)
})
