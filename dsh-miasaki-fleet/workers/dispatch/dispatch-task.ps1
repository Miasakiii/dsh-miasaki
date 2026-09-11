# dispatch-task.ps1 — M3.5 派单器：按 agent 档案 spawn 本机 CLI 执行任务（§7.0 派单式执行）
# 用法：pwsh -File workers/dispatch/dispatch-task.ps1 -TaskId t-xxxx -Agent <id> [-Workspace <root>] [-Requires <caps>]
# 能力闸门（G2，2026-09-11）：派单前校验目标 agent 是否为能力图候选。需求能力取 -Requires，
#   否则解析 brief 的 `requires:` 行；两者都缺省时跳过（零行为变更）。判定复用 workers/graph/agent-pick.mjs。
# 验证模式：-CheckOnly（只跑预算预检）/-ParseOnly（只跑 usage 解析，打印将要写入的 usage.jsonl 行）
# 退出码：0 成功；2 拒绝派单（开关未开/无模板/无能力候选/选择器不可用）；3 CLI 执行失败；4 预算熔断拒绝
# 协议：status.json 由派单器代理写；stdout 存 logs/<task>-stdout.log；usage.jsonl 按 metering_source 解析；transcript.md 追加；tasks.jsonl 由 Commander 另写。
# 记忆隔离：spawn worker 进程时注入 OPENVIKING_RECALL_PEER_SCOPE=actor（§12.2 OpenViking 记忆层），进程结束后恢复原值。
# 运行环境：PowerShell 7+（脚本使用 ?? 运算符）；本机 PS7 路径 %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe（可能不在 PATH，where pwsh 找不到）。

param(
  [string]$TaskId,
  [string]$Agent,
  [string]$Workspace = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),  # 默认=fleet 根（脚本位于 workers/dispatch/）
  [string]$Requires,   # G2 能力闸门：显式需求能力（逗号分隔）；缺省则从 brief 的 requires: 行解析
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

# --- G2 能力闸门（P0 接线，2026-09-11）---------------------------------------
# 依据 docs/agent-teams-collaboration-gap-2026-09-11.md §2.2 / §7：
# 把 Commander 原本只能"手工查询"的 agent-pick 判定，变成派单前必过的闸门。
# 动机（真实样本）：t-0003/t-0004 因 assignee 指向已归档 agent 而积压 24 天，
# 期间没有任何机器判定会报出来——它只表现为两个任务永远躺在 queued 里。

# 需求能力：优先 -Requires 显式传入，其次从 brief.md 解析 `requires:` 行，解析不到即跳过。
function Resolve-RequiredCaps([string]$Brief) {
  if (-not [string]::IsNullOrWhiteSpace($Requires)) { return $Requires.Trim() }
  if ([string]::IsNullOrWhiteSpace($Brief)) { return '' }
  # 注意：必须用 [^\S\r\n]*（行内空白）而非 \s* —— .NET 的 \s 含换行符，
  # `^\s*` 会吃穿换行、锚定到下一行行首，导致永远匹配不到目标行（已实测踩坑）。
  $m = [regex]::Match($Brief, '(?m)^[^\S\r\n]*(?:requires|需要能力)[^\S\r\n]*[:：][^\S\r\n]*(.+?)[^\S\r\n]*$')
  if (-not $m.Success) { return '' }
  $v = $m.Groups[1].Value.Trim()
  if ($v -eq '' -or $v -match '^[（(\[<]') { return '' }   # 占位符（如 `requires: (待补)`）视为未声明
  return $v
}

# 能力闸门本体：目标 agent 必须是能力图的可用候选之一。
# 退出码语义（agent-pick.mjs）：0 有候选 / 1 无候选 / 2 环境错误。
function Test-CapabilityGate([string]$Caps, [string]$AgentId) {
  $picker = Join-Path (Split-Path $PSScriptRoot -Parent) 'graph\agent-pick.mjs'
  if (-not (Test-Path $picker)) {
    Write-Host '[capability] 选择器缺失，无法校验能力（拒绝派单，宁可拒绝也不放行）'
    return $false
  }
  $raw = & node $picker --need $Caps --json 2>$null
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    $parsed = $null
    try { $parsed = ($raw | Out-String).Trim() | ConvertFrom-Json } catch { $parsed = $null }
    if ($null -eq $parsed) {
      Write-Host '[capability] 选择器输出无法解析（拒绝派单）'
      return $false
    }
    # 用 -contains（逐元素比较）而非字符串包含：避免子串误判
    $ids = @($parsed.candidates | ForEach-Object { $_.agentId })
    if ($ids -contains $AgentId) {
      $hit = $parsed.candidates | Where-Object { $_.agentId -eq $AgentId } | Select-Object -First 1
      Write-Host "[capability] 闸门通过：$AgentId 覆盖 $Caps（score=$($hit.score)，候选 $($ids.Count) 个）"
      return $true
    }
    Write-Host "[capability] 拒绝派单：$AgentId 不在能力候选内（需要 $Caps；候选：$($ids -join ', ')）"
    return $false
  }
  if ($code -eq 1) {
    $missing = ''
    try { $missing = (@(($raw | Out-String).Trim() | ConvertFrom-Json).missingCapabilities) -join ', ' } catch { }
    if (-not $missing) { $missing = $Caps }
    Write-Host "[capability] 拒绝派单：无活动 agent 提供 $missing（G2 能力断层；先补档案或改派，勿硬塞）"
    return $false
  }
  Write-Host "[capability] 选择器出错（exit $code），拒绝派单"
  return $false
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

function Parse-Unmetered([string]$source, [string]$taskId, [string]$agentId, [string]$reason) {
  # F2：无机器可读计量时的显式审计行（cost 0 + metered=false），替代静默"无计量"。
  # 预算不受影响（0 cost），但面板/台账可区分"跑过未计量"与"没跑过"。
  return @{
    ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    task = $taskId
    model = 'cli-default'
    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_write_tokens = 0
    step = 1
    takeover = 0
    cost = 0.0
    metered = $false
    note = "$agentId/$source 未计量运行：$reason"
  }
}

function Parse-SessionUsage([string]$stdout, [string]$taskId, [string]$agentId) {
  # dsh：会话级计量，无 stdout 机器格式 → 显式未计量行，需 dsh usage 查询后手工回填 ledger
  return Parse-Unmetered 'session' $taskId $agentId 'dsh 会话级计量，需 dsh usage 手工回填'
}

function Parse-ConsoleUsage([string]$stdout, [string]$taskId, [string]$agentId) {
  # bl：用量在 console 侧，需 bl auth status 有效会话 → 显式未计量行
  return Parse-Unmetered 'console-usage' $taskId $agentId 'bl console 侧计量，需 Operator 对账'
}

function Get-UsageRow([string]$source, [string]$stdout, [string]$taskId, [string]$agentId) {
  # F2：metering_source → 解析器注册表（全源覆盖，无静默缺口）
  switch ($source) {
    'json-cost-usd' { return Parse-JsonCostUsd $stdout $taskId $agentId }
    'session' { return Parse-SessionUsage $stdout $taskId $agentId }
    'console-usage' { return Parse-ConsoleUsage $stdout $taskId $agentId }
    default {
      if ([string]::IsNullOrEmpty($source) -or $source -eq 'unknown') {
        return Parse-Unmetered 'unknown' $taskId $agentId '该 CLI 尚无计量解析器，见 cli-calibration 待校清单'
      }
      return $null
    }
  }
}

if ($CheckOnly) {
  $manifest = Read-JsonFile (Join-Path $agentDir 'manifest.json')
  if (-not $manifest) { Write-Host "[budget] agent $Agent 无档案"; exit 2 }
  $ok = Test-Budget $agentDir $manifest
  if (-not $ok) { exit 4 }
  # 能力闸门也纳入预检：让 -CheckOnly 成为"能不能派"的完整判定
  $briefText = Get-Content (Join-Path $Workspace "tasks\$TaskId\brief.md") -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  $reqCaps = Resolve-RequiredCaps $briefText
  if ($reqCaps) {
    if (-not (Test-CapabilityGate $reqCaps $Agent)) { exit 2 }
  } else {
    Write-Host '[capability] brief 未声明 requires（或为占位符），跳过能力闸门（零行为变更）'
  }
  exit 0
}

$manifest = Read-JsonFile (Join-Path $agentDir 'manifest.json')
if (-not $manifest) { Write-Host "[dispatch] agent $Agent 无档案"; exit 2 }
$control = Read-JsonFile (Join-Path $agentDir 'control.json')
if (-not $control -or $control.enabled -ne $true) { Write-Host "[dispatch] agent $Agent 开关未开启，拒绝派单（§7.0 派单许可）"; exit 2 }
if ($manifest.preflight) { Write-Host "[dispatch] preflight 提示：$($manifest.preflight)" }
if (-not (Test-Budget $agentDir $manifest)) { exit 4 }

# 闸门 2：能力候选（G2 agent-pick）。brief 未声明 requires 时零行为变更。
$briefForCaps = Get-Content (Join-Path $Workspace "tasks\$TaskId\brief.md") -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
$reqCaps = Resolve-RequiredCaps $briefForCaps
if ($reqCaps) {
  if (-not (Test-CapabilityGate $reqCaps $Agent)) { Write-Host "[dispatch] 能力闸门未通过，拒绝派单"; exit 2 }
} else {
  Write-Host '[capability] brief 未声明 requires（或为占位符），跳过能力闸门（零行为变更）'
}

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
  $row = Get-UsageRow $source $stdout $TaskId $Agent
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
# OpenViking 记忆隔离（§12.2，2026-08-24）：worker 会话按 cwd 派生 actor peer 作用域（actor =
# 仅检索本 workspace 记忆），防止多项目/多 worker 并存时记忆串味；同一 workspace 内各任务共享
# 经验记忆（跨任务复用收益）。无 OpenViking 集成的 CLI 不读此变量，注入无害。
$ovScopeBackup = $env:OPENVIKING_RECALL_PEER_SCOPE
$env:OPENVIKING_RECALL_PEER_SCOPE = 'actor'
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
  if ($null -eq $ovScopeBackup) { Remove-Item Env:OPENVIKING_RECALL_PEER_SCOPE -ErrorAction SilentlyContinue }
  else { $env:OPENVIKING_RECALL_PEER_SCOPE = $ovScopeBackup }
}
"`nEXIT:$exitCode" | Tee-Object -FilePath $outFile -Append

# usage 自动解析 → usage.jsonl（按 metering_source）
$usageRow = $null
if ($exitCode -eq 0) {
  $stdout = Get-Content $outFile -Raw
  $source = $manifest.metering_source
  $usageRow = Get-UsageRow $source $stdout $TaskId $Agent
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
