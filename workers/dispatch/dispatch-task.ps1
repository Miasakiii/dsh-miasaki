# dispatch-task.ps1 — M3.5 派单器：按 agent 档案 spawn 本机 CLI 执行任务（§7.0 派单式执行）
# 用法：pwsh -File workers/dispatch/dispatch-task.ps1 -TaskId t-xxxx -Agent <id> [-Workspace <root>]
# 验证模式：-CheckOnly（只跑预算预检）/-ParseOnly（只跑 usage 解析，打印将要写入的 usage.jsonl 行）
# 退出码：0 成功；2 拒绝派单（开关未开/无模板）；3 CLI 执行失败；4 预算熔断拒绝
# 协议：status.json 由派单器代理写；stdout 存 logs/<task>-stdout.log；usage.jsonl 按 metering_source 解析；transcript.md 追加；tasks.jsonl 由 Commander 另写。

param(
  [string]$TaskId,
  [string]$Agent,
  [string]$Workspace = "C:\Users\Asakii\Desktop\dsh-miasaki",
  [switch]$CheckOnly,
  [switch]$ParseOnly
)

$ErrorActionPreference = 'Continue'
$agentDir = Join-Path $Workspace "agents\$Agent"
$today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try { return Get-Content $Path -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-DayCost([string]$AgentDir) {
  # 预算预检：当日 cost = usage.jsonl 中 ts 为今天的 cost 之和（损坏行跳过，§10 容错）
  $usageFile = Join-Path $AgentDir 'usage.jsonl'
  if (-not (Test-Path $usageFile)) { return 0.0 }
  $sum = 0.0
  foreach ($line in Get-Content $usageFile) {
    try {
      $row = $line | ConvertFrom-Json
      $day = $null
      if ($row.ts -is [datetime]) {
        $day = '{0:D4}-{1:D2}-{2:D2}' -f $row.ts.Year, $row.ts.Month, $row.ts.Day
      } else {
        $s = [string]$row.ts
        if ($s.Length -ge 10) { $day = $s.Substring(0, 10) }
      }
      if ($day -eq $today -and $null -ne $row.cost) { $sum += [double]$row.cost }
    } catch { }
  }
  return $sum
}

function Test-Budget([string]$AgentDir, $manifest) {
  $budget = 2.0
  if ($manifest.limits -and $manifest.limits.budget_per_day) { $budget = [double]$manifest.limits.budget_per_day }
  $dayCost = Get-DayCost $AgentDir
  if ($dayCost -ge $budget) {
    Write-Host "[budget] 熔断拒绝：当日 cost $('{0:N4}' -f $dayCost) >= 预算 $budget（§6.3 第 5 条 / §8.4）"
    return $false
  }
  if ($dayCost -ge 0.8 * $budget) {
    Write-Host "[budget] 预警：当日 cost $('{0:N4}' -f $dayCost) 已达预算 ${budget} 的 $('{0:P0}' -f ($dayCost / $budget))，仍放行"
  } else {
    Write-Host "[budget] 预检通过：当日 cost $('{0:N4}' -f $dayCost) / 预算 $budget"
  }
  return $true
}

# usage 解析器注册表：metering_source → 解析函数（输入 stdout 全文，输出 usage.jsonl 行对象或 $null）
function Parse-JsonCostUsd([string]$stdout, [string]$taskId, [string]$agentId) {
  # claude：stdout 最后一行是 {"type":"result","total_cost_usd":...,"usage":{...},"modelUsage":{...}}
  $lines = @($stdout -split "`n")
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $line = $lines[$i].Trim()
    if (-not $line.StartsWith('{')) { continue }
    try {
      $j = $line | ConvertFrom-Json
      if ($null -eq $j.total_cost_usd -and $null -eq $j.usage) { continue }
      $u = $j.usage
      $model = ''
      if ($j.modelUsage) {
        $names = @($j.modelUsage.PSObject.Properties | ForEach-Object { $_.Name })
        $maxCost = -1.0
        foreach ($name in $names) {
          $c = [double]$j.modelUsage.$name.costUSD
          if ($c -gt $maxCost) { $maxCost = $c; $model = $name }
        }
      }
      return @{
        ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        task = $taskId
        model = if ($model) { $model } else { 'claude' }
        input_tokens = [int]$u.input_tokens
        output_tokens = [int]$u.output_tokens
        cache_read_tokens = [int]$u.cache_read_input_tokens
        cache_write_tokens = [int]$u.cache_creation_input_tokens
        step = 1
        takeover = 0
        cost = [double]$j.total_cost_usd
        note = "claude -p json 自动解析（$($j.stop_reason)，turns=$($j.num_turns)）"
      }
    } catch { }
  }
  return $null
}

if ($CheckOnly) {
  $manifest = Read-JsonFile (Join-Path $agentDir 'manifest.json')
  if (-not $manifest) { Write-Host "[budget] agent $Agent 无档案"; exit 2 }
  $ok = Test-Budget $agentDir $manifest
  exit $(if ($ok) { 0 } else { 4 })
}

$manifest = Read-JsonFile (Join-Path $agentDir 'manifest.json')
if (-not $manifest) { Write-Host "[dispatch] agent $Agent 无档案"; exit 2 }
$control = Read-JsonFile (Join-Path $agentDir 'control.json')
if (-not $control -or $control.enabled -ne $true) { Write-Host "[dispatch] agent $Agent 开关未开启，拒绝派单（§7.0 派单许可）"; exit 2 }
if ($manifest.preflight) { Write-Host "[dispatch] preflight 提示：$($manifest.preflight)" }
if (-not (Test-Budget $agentDir $manifest)) { exit 4 }

$brief = Get-Content (Join-Path $Workspace "tasks\$TaskId\brief.md") -Raw -ErrorAction SilentlyContinue
$context = Get-Content (Join-Path $Workspace "tasks\$TaskId\context.md") -Raw -ErrorAction SilentlyContinue
$prompt = (($brief ?? '') + "`n`n## 上下文`n" + ($context ?? '')).Trim()

$cmdLines = @()
foreach ($line in (($brief ?? '') -split "`n")) {
  if ($line -match '^\s*cmd:\s*(.+)$') { $cmdLines += $Matches[1].Trim() }
}
if ($cmdLines.Count -eq 0) {
  $invoke = $manifest.cli.invoke
  if ($invoke -match '\{prompt\}') {
    $cmdLines += ($invoke -replace '\{prompt\}', ('"' + $prompt + '"'))
  } else {
    Write-Host "[dispatch] invoke 模板无 {prompt} 且 brief 无 cmd: 行，无法派单"; exit 2
  }
}

if ($ParseOnly) {
  $logDir = Join-Path $agentDir 'logs'
  $latest = @(Get-ChildItem $logDir -Filter "$TaskId-stdout*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  if ($latest.Count -eq 0) { Write-Host "[parse] 无日志可解析：$logDir\$TaskId-stdout*.log"; exit 2 }
  $stdout = Get-Content $latest[0].FullName -Raw
  $source = $manifest.metering_source
  $row = $null
  if ($source -eq 'json-cost-usd') { $row = Parse-JsonCostUsd $stdout $TaskId $Agent }
  if ($row) {
    Write-Host "[parse] $source 解析成功（$($latest[0].Name)）："
    $row | ConvertTo-Json -Compress
    exit 0
  }
  Write-Host "[parse] $source 无解析器或解析失败（预期内）；不写 usage.jsonl"
  exit 0
}

# status running（派单器代理写）
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
$status = @{ version = 1; agent_id = $Agent; state = 'running'; current_task = $TaskId; progress = 0.3; step = '派单器执行中'; heartbeat_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); tokens = @{ task = 0; session = 0; day = 0 }; last_error = $null }
$status | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $agentDir 'status.json') -Encoding UTF8

$logDir = Join-Path $agentDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outFile = Join-Path $logDir "$TaskId-stdout.log"
"" | Set-Content $outFile

$exitCode = 0
Push-Location $Workspace
try {
  foreach ($cmd in $cmdLines) {
    "=== $cmd ===" | Tee-Object -FilePath $outFile -Append
    $argv = @(); $buf = ''; $inQ = $false
    foreach ($p in ($cmd -split ' ')) {
      if ($inQ) {
        $buf += ' ' + $p
        if ($p.EndsWith('"')) { $inQ = $false; $argv += $buf.Trim('"'); $buf = '' }
        continue
      }
      if ($p.StartsWith('"') -and -not $p.EndsWith('"')) { $inQ = $true; $buf = $p; continue }
      if ($p -ne '') { $argv += $p }
    }
    $exe = $argv[0]; $args = @($argv[1..($argv.Count - 1)])
    & $exe @args 2>&1 | Tee-Object -FilePath $outFile -Append
    if ($LASTEXITCODE -ne 0) { $exitCode = $LASTEXITCODE }
  }
} finally {
  Pop-Location
}
"`nEXIT:$exitCode" | Tee-Object -FilePath $outFile -Append

# usage 自动解析 → usage.jsonl（按 metering_source）
$usageRow = $null
if ($exitCode -eq 0) {
  $stdout = Get-Content $outFile -Raw
  $source = $manifest.metering_source
  if ($source -eq 'json-cost-usd') { $usageRow = Parse-JsonCostUsd $stdout $TaskId $Agent }
  if ($usageRow) {
    ($usageRow | ConvertTo-Json -Compress) | Add-Content (Join-Path $agentDir 'usage.jsonl')
    Write-Host "[usage] $source 已落盘：in $($usageRow.input_tokens) / out $($usageRow.output_tokens) / cache-read $($usageRow.cache_read_tokens) / cost $('{0:N4}' -f $usageRow.cost)"
  } else {
    Write-Host "[usage] $source 无解析器或解析失败；usage.jsonl 未写入（面板显示无计量）"
  }
}

# status 终态
$state = if ($exitCode -eq 0) { 'idle' } else { 'error' }
$status.state = $state; $status.current_task = $null; $status.progress = 1.0; $status.step = "派单完成（exit $exitCode）"; $status.heartbeat_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
if ($state -eq 'error') { $status.last_error = "CLI exit $exitCode" }
if ($usageRow) {
  $taskTokens = [int]$usageRow.input_tokens + [int]$usageRow.output_tokens
  $prev = Read-JsonFile (Join-Path $agentDir 'status.json')
  $prevTokens = $prev.tokens
  $status.tokens = @{ task = $taskTokens; session = $(if ($prevTokens.session) { $prevTokens.session + $taskTokens } else { $taskTokens }); day = $(if ($prevTokens.day) { $prevTokens.day + $taskTokens } else { $taskTokens }) }
}
$status | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $agentDir 'status.json') -Encoding UTF8

"`n## 任务 $TaskId（$Agent 派单，exit $exitCode）" | Add-Content (Join-Path $agentDir 'transcript.md')
Get-Content $outFile | Add-Content (Join-Path $agentDir 'transcript.md')

Write-Host "[dispatch] $TaskId -> $Agent 完成，exit $exitCode，输出：$outFile"
exit $exitCode
