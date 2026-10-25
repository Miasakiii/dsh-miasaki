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

// ---------------------------------------------------------------------------
// 派单执行期间刷新心跳（2026-10-22，外部清单对账挖出的在债 P0）
//
// 根因（t-0010/t-0011 已实测）：判活窗口 = 3 × heartbeat_ms（默认 90s），而 status.json
// 旧行为只在派单开始（running）与终态落账两处各写一次 ⇒ worker 执行超过 90s 后
// 心跳过龄 ⇒ G1 对该 agent 的后续派单**永久硬拒**（running + 过龄心跳的残留要有人跑
// -ResetStatus 才清）—— 能干活的 agent 被自己的上一次派单「僵」住，且不报错。
//
// 修法：Invoke-WorkerProcess 的等待由整段 WaitForExit 改为**轮询切片 + 心跳刷新**。
// 下面两组：① 源码契约（纯文本，防接线退化/回退）；② 功能探针（真跑刷新函数）。
// ---------------------------------------------------------------------------

test('心跳刷新接线：函数、调用点、raw 替换纪律、旧整段等待形态已不在', () => {
  const s = readFileSync(join(FLEET_DIR, 'workers', 'dispatch', 'dispatch-task.ps1'), 'utf8')
  // ① 刷新函数存在，且纪律注释在位（raw 正则替换，不经过 ConvertFrom-Json ——
  //    后者会把 UTC 串转成 Local 且数值不变，读改写会静默损坏心跳）
  // ② 等待循环内调用（只钉函数定义会让「接线悄悄退化」全绿）
  // ③ 调用点传入两个新参数
  for (const [label, needle] of [
    ['刷新函数', 'function Update-DispatchHeartbeat'],
    ['raw 替换纪律', '不经过 ConvertFrom-Json'],
    ['刷新不阻断纪律', '绝不能因为刷不上心跳就把正在执行的 worker 带走'],
    ['循环内调用', 'Update-DispatchHeartbeat $AgentDir'],
    ['调用点传参', '-AgentDir $agentDir -HeartbeatMs $heartbeatMs'],
  ]) {
    assert.ok(s.includes(needle), `心跳刷新接线缺失：${label}`)
  }
  // ④ 反向（防回退）：整段 WaitForExit($TimeoutMs) 的旧形态不应仍在 ——
  //    那正是「执行期间心跳停动、超过判活窗口自己僵住」的根因。
  assert.ok(!s.includes('$p.WaitForExit($TimeoutMs)'), '整段 WaitForExit($TimeoutMs) 旧形态不应仍在（执行期间不刷新心跳的根因）')
})

test('心跳刷新功能：刷新后心跳变新、其他字段一字不变、无 status.json 静默', (t) => {
  if (!PWSH) return t.skip('本机无 pwsh / powershell')
  const dir = mkdtempSync(join(tmpdir(), 'fleet-hb-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const psFile = join(dir, 'probe.ps1')
  const outFile = join(dir, 'probe.json')
  // 探针脚本：AST 提取 Update-DispatchHeartbeat 单函数 eval（不 dot-source 整个派单器），
  // 造过龄心跳夹具 → 刷新 → 结果写 JSON 落盘回读（stdio ignore + 落盘，绕开沙箱 EPERM）。
  // 刻意用普通字符串（非模板字符串）拼 PS 脚本：PS 的反引号转义会终结 JS 模板字符串。
  // 夹具用 ConvertTo-Json 生成，不手写 JSON 字面量（嵌套引号地狱）。
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  const ps = [
    '$ErrorActionPreference = \'Stop\'',
    '$script = ' + q(join(FLEET_DIR, 'workers', 'dispatch', 'dispatch-task.ps1')),
    '$tokens = $null; $parseErrs = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrs)',
    '$fn = $ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq \'Update-DispatchHeartbeat\' }, $true)',
    'if ($fn.Count -ne 1) { @{ ok = $false; why = "function x" + $fn.Count } | ConvertTo-Json | Set-Content ' + q(outFile) + ' -Encoding UTF8; exit 0 }',
    'Invoke-Expression $fn[0].Extent.Text',
    '$tmp = ' + q(dir),
    'New-Item -ItemType Directory -Force -Path $tmp | Out-Null',
    '$old = (Get-Date).ToUniversalTime().AddSeconds(-600).ToString(\'yyyy-MM-ddTHH:mm:ssZ\')',
    '@{ version = 1; state = \'running\'; current_task = \'t-9001\'; heartbeat_at = $old; last_error = $null } | ConvertTo-Json | Set-Content (Join-Path $tmp \'status.json\') -Encoding UTF8',
    'Update-DispatchHeartbeat $tmp',
    '$after = Get-Content (Join-Path $tmp \'status.json\') -Raw',
    '$m = [regex]::Match($after, \'"heartbeat_at"\\s*:\\s*"([^"]+)"\')',
    '$beat = [System.DateTimeOffset]::Parse($m.Groups[1].Value, [System.Globalization.CultureInfo]::InvariantCulture)',
    '$ageSec = ((Get-Date).ToUniversalTime() - $beat.UtcDateTime).TotalSeconds',
    '# 无 status.json 时静默（首跑 agent 场景）',
    'Update-DispatchHeartbeat (Join-Path $tmp \'nonexistent\')',
    '@{ ok = ($ageSec -lt 10) -and ($after -match \'"current_task": "t-9001"\') -and ($after -match \'"state": "running"\'); ageSec = [math]::Round($ageSec, 1); fieldsIntact = ($after -match \'"current_task": "t-9001"\') -and ($after -match \'"state": "running"\'); noStatusSilent = $true } | ConvertTo-Json | Set-Content ' + q(outFile) + ' -Encoding UTF8',
    'exit 0',
  ].join('\n')
  writeFileSync(psFile, ps, 'utf8')
  const r = spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { stdio: 'ignore' })
  assert.equal(r.status, 0, '探针脚本应正常退出')
  const got = JSON.parse(readFileSync(outFile, 'utf8'))
  assert.equal(got.ok, true, `刷新行为不符：ageSec=${got.ageSec} fieldsIntact=${got.fieldsIntact} why=${got.why || ''}`)
  assert.ok(got.ageSec < 10, '刷新后心跳必须是当前时刻（判据：年龄 <10s）')
  assert.equal(got.fieldsIntact, true, 'current_task / state 等其他字段必须一字不变（raw 替换，不读改写）')
  assert.equal(got.noStatusSilent, true, '无 status.json 时必须静默返回（首跑 agent 无档可刷）')
})
