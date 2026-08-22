# scan-agents.ps1 — 扫描本机已安装的 agent CLI，生成 agents/<id>/manifest.json + agents/registry.json
# 用法：pwsh -File workers/discovery/scan-agents.ps1 [-Workspace <root>]
# 只创建不覆盖：已存在的 manifest 仅刷新 discovered 元数据，不动 Operator 编辑的字段。

param(
  [string]$Workspace = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)  # 默认=fleet 根（脚本位于 workers/discovery/）
)

$ErrorActionPreference = 'SilentlyContinue'

# 已知 agent CLI 目录（bins 按优先级探测；invoke 为派单模板，{prompt} 替换为任务文本）
$catalog = @(
  @{ id = 'bl';            name = 'Bailian CLI';       bins = @('bl');            invoke = 'bl text chat --message {prompt}';           metering = 'console-usage'; skills = @('bailian-resources','bailian-chat'); preflight = '用量/额度类命令需 console 会话有效（bl auth login --console --console-site domestic）；派单前 bl auth status 检查' },
  @{ id = 'claude';        name = 'Claude Code';       bins = @('claude');        invoke = 'claude -p {prompt} --output-format json';   metering = 'json-cost-usd';   skills = @('analysis','coding','multi-step-tools','json-output'); preflight = '已实测（t-0006）：headless -p 下 Write/Bash 权限自动拒绝，交付物必须由派单器代写' },
  @{ id = 'gemini';        name = 'Gemini CLI';        bins = @('gemini');        invoke = 'gemini -p {prompt}';                        metering = 'unknown';        skills = @('google-chat'); preflight = '派单需 full-access（自重启 spawn）；默认模型 gemini-3.5-flash 区域受限（403），需先换可用模型' },
  @{ id = 'opencode';      name = 'opencode';          bins = @('opencode');      invoke = 'opencode run {prompt}';                     metering = 'unknown';        skills = @('coding','cli-task-runner'); preflight = '已实测可用（默认模型 deepseek-v4-flash）；派单需 full-access（写 ~/.local/share/opencode 日志）' },
  @{ id = 'dsh';           name = 'DSH CLI';           bins = @('dsh');           invoke = 'dsh --profile headless {prompt}';          metering = 'session';        skills = @('headless-orchestration','dsd-native'); preflight = '本机尚无 headless profile，派单前需先建 profile' },
  @{ id = 'pi';            name = 'pi coding agent';   bins = @('pi');            invoke = 'pi -p {prompt}';                            metering = 'unknown';        skills = @('coding'); preflight = '已实测可用（pi -p）；派单需 full-access（写 ~/.pi 配置）' },
  @{ id = 'mimo';          name = 'MiMo CLI';          bins = @('mimo');          invoke = 'mimo {prompt}';                            metering = 'unknown';        skills = @('light-chat'); preflight = 'invoke 语法待校准：位置参数被当作目录（实测报错）；需 mimo --help 后更新模板' },
  @{ id = 'agent-browser'; name = 'agent-browser';     bins = @('agent-browser'); invoke = 'agent-browser {prompt}';                   metering = 'unknown';        skills = @('web-automation','browser'); preflight = '命令型 CLI（agent-browser <command>），非 prompt 型；任务需映射到具体命令（skills get core 起步）' }
)

$agentsDir = Join-Path $Workspace 'agents'
New-Item -ItemType Directory -Force -Path $agentsDir | Out-Null
$registry = @()

foreach ($a in $catalog) {
  $bin = $null
  foreach ($b in $a.bins) {
    $cmd = Get-Command $b -ErrorAction SilentlyContinue
    if ($cmd) { $bin = $b; $binPath = $cmd.Source; break }
  }
  if (-not $bin) { Write-Host ("absent  {0,-14}" -f $a.id); continue }

  $ver = (& $bin --version 2>&1 | Select-Object -First 1) -join ' '
  $manifestPath = Join-Path $agentsDir ($a.id + '\manifest.json')
  $entry = @{
    id          = $a.id
    name        = $a.name
    runtime     = 'cli'
    model       = 'cli-default'
    model_price = $null
    metering    = $false
    metering_source = $a.metering
    skills      = @()
    cli         = @{ command = $bin; binPath = $binPath; version = $ver.Trim(); invoke = $a.invoke }
    persona_prompt = "你是本机 agent CLI「$($a.name)」的档案。总指挥通过你的可执行文件派发任务。"
    limits      = @{ max_tokens_per_task = 50000; max_concurrent_tasks = 1; budget_per_day = 2.0; timeout_ms = 900000; heartbeat_ms = 30000 }
    updated_at  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  }
  $manifestDir = Split-Path $manifestPath
  New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
  if (Test-Path $manifestPath) {
    # 已存在：仅刷新 discovered 元数据（cli 字段）；skills 为空时按目录填充（不覆盖已有编辑）
    $existing = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $existing.cli = $entry.cli
    if (-not $existing.skills -or @($existing.skills).Count -eq 0) { $existing.skills = $a.skills }
    if (-not $existing.preflight) { $existing.preflight = $a.preflight }
    $existing.updated_at = $entry.updated_at
    $existing | ConvertTo-Json -Depth 8 | Set-Content $manifestPath -Encoding UTF8
    Write-Host ("refresh {0,-14} -> {1} {2}" -f $a.id, $binPath, $ver.Trim())
  } else {
    $entry | ConvertTo-Json -Depth 8 | Set-Content $manifestPath -Encoding UTF8
    Write-Host ("created {0,-14} -> {1} {2}" -f $a.id, $binPath, $ver.Trim())
  }
  $registry += @{ id = $a.id; name = $a.name; bin = $bin; binPath = $binPath; version = $ver.Trim(); invoke = $a.invoke; metering = $a.metering }
}

$registry | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $agentsDir 'registry.json') -Encoding UTF8
Write-Host ("`nregistry.json: {0} 个已发现 agent CLI" -f $registry.Count)
