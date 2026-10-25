# scan-agents.ps1 — 扫描本机已安装的 agent CLI，生成 agents/<id>/manifest.json + agents/registry.json
# 用法：pwsh -File workers/discovery/scan-agents.ps1 [-Workspace <root>]
# 只创建不覆盖：已存在的 manifest 仅刷新 discovered 元数据，不动 Operator 编辑的字段。
#
# P0-A（2026-10-21）：类型判定与能力边界成为**机器可读字段**（kind / capabilities /
# capability_boundary / invoke_contract / permissions / model_info），落实设计文档
# design/2026-10-20-fleet-agent-taxonomy-and-borrowed-designs.md §7.1。
#   · kind 由本目录决定（scanner 是判定生产者），派单器按它拒绝非 coding-agent；
#   · 能力边界一律三态（yes/no/unknown）——不知道就写 unknown，**不猜**；
#   · 缺失的 CLI 在 manifest 里标 present=false（不再让 registry 的旧快照冒充当前事实）。

param(
  [string]$Workspace = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)  # 默认=fleet 根（脚本位于 workers/discovery/）
)

$ErrorActionPreference = 'SilentlyContinue'

# 判定辅助：只补缺失字段（保留 Operator 编辑）／覆盖 discovered 事实字段。
function Add-MissingField($obj, [string]$name, $value) {
  if (-not $obj.PSObject.Properties[$name]) {
    $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value
  }
}
function Set-DiscoveredField($obj, [string]$name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

# 已知 agent CLI 目录（bins 按优先级探测；invoke 为派单模板，{prompt} 替换为任务文本）
#
# kind 判定口径（详见设计文档 §2）：
#   · coding-agent = 自主工具循环 + 代码仓交付 + headless 单次入口（可作 worker）
#   · tool-cli     = 单命令工具（浏览器自动化 / 云资源管理），**不可**作 worker
# capability_boundary 三态取自本机实测与校准记录；无证据一律 unknown。
$catalog = @(
  @{ id = 'bl';            name = 'Bailian CLI';       kind = 'tool-cli';     runtimeKind = 'bailian';
     bins = @('bl');            invoke = 'bl text chat --message {prompt}';           metering = 'console-usage';
     skills = @('bailian-resources','bailian-chat'); capabilities = @('bailian-resources','bailian-chat');
     boundary = @{ tool_loop = 'no'; workspace_read = 'no'; workspace_write_headless = 'no'; shell_headless = 'no'; network = 'yes' };
     invokeContract = @{ prompt_transport = 'argv'; output_format = 'unknown'; exit_code_semantics = @{}; permission_flags = @{} };
     permissions = @{ mode = 'unknown'; tool_allowlist = @(); denied_tools = @(); approval_required = @(); headless_allow_delegation = $false };
     preflight = '工具型 CLI（云资源/平台命令），不是 coding agent；P0-A 起 kind=tool-cli，派单器拒绝作为 worker' },
  @{ id = 'claude';        name = 'Claude Code';       kind = 'coding-agent'; runtimeKind = 'claude-code';
     bins = @('claude');        invoke = 'claude -p {prompt} --output-format json';   metering = 'json-cost-usd';
     skills = @('analysis','coding','multi-step-tools','json-output'); capabilities = @('analysis','coding','multi-step-tools','json-output');
     boundary = @{ tool_loop = 'yes'; workspace_read = 'yes'; workspace_write_headless = 'no'; shell_headless = 'no'; network = 'yes' };
     invokeContract = @{ prompt_transport = 'argv'; output_format = 'json'; exit_code_semantics = @{ '0' = 'success'; 'non-zero' = 'failure' }; permission_flags = @{ readonly = @('--permission-mode','plan') } };
     permissions = @{ mode = 'read-only'; tool_allowlist = @('Read','Glob','Grep'); denied_tools = @('Edit','Write','Bash'); approval_required = @(); headless_allow_delegation = $false };
     preflight = '已实测（t-0006）：headless -p 下 Write/Bash 权限自动拒绝，交付物必须由派单器代写' },
  @{ id = 'gemini';        name = 'Gemini CLI';        kind = 'coding-agent'; runtimeKind = 'gemini-cli';
     bins = @('gemini');        invoke = 'gemini -p {prompt}';                        metering = 'unknown';
     skills = @('google-chat'); capabilities = @('coding','google-chat');
     boundary = @{ tool_loop = 'yes'; workspace_read = 'unknown'; workspace_write_headless = 'unknown'; shell_headless = 'unknown'; network = 'yes' };
     invokeContract = @{ prompt_transport = 'argv'; output_format = 'text'; exit_code_semantics = @{ '0' = 'success'; 'non-zero' = 'failure' }; permission_flags = @{} };
     permissions = @{ mode = 'unknown'; tool_allowlist = @(); denied_tools = @(); approval_required = @(); headless_allow_delegation = $false };
     preflight = '派单需 full-access（自重启 spawn）；默认模型 gemini-3.5-flash 区域受限（403），需先换可用模型' },
  @{ id = 'opencode';      name = 'opencode';          kind = 'coding-agent'; runtimeKind = 'opencode';
     bins = @('opencode');      invoke = 'opencode run {prompt}';                     metering = 'unknown';
     skills = @('coding','cli-task-runner'); capabilities = @('coding','cli-task-runner');
     boundary = @{ tool_loop = 'yes'; workspace_read = 'unknown'; workspace_write_headless = 'unknown'; shell_headless = 'unknown'; network = 'yes' };
     invokeContract = @{ prompt_transport = 'argv'; output_format = 'text'; exit_code_semantics = @{ '0' = 'success'; 'non-zero' = 'failure' }; permission_flags = @{} };
     permissions = @{ mode = 'unknown'; tool_allowlist = @(); denied_tools = @(); approval_required = @(); headless_allow_delegation = $false };
     preflight = '已实测可用（默认模型 deepseek-v4-flash）；派单需 full-access（写 ~/.local/share/opencode 日志）' },
  @{ id = 'dsh';           name = 'DSH CLI';           kind = 'coding-agent'; runtimeKind = 'dsh';
     bins = @('dsh');           invoke = 'dsh --profile headless {prompt}';          metering = 'session';
     skills = @('headless-orchestration','dsd-native'); capabilities = @('coding','headless-orchestration','dsd-native');
     boundary = @{ tool_loop = 'yes'; workspace_read = 'unknown'; workspace_write_headless = 'unknown'; shell_headless = 'unknown'; network = 'yes' };
     invokeContract = @{ prompt_transport = 'argv'; output_format = 'text'; exit_code_semantics = @{ '0' = 'success'; 'non-zero' = 'failure' }; permission_flags = @{} };
     permissions = @{ mode = 'unknown'; tool_allowlist = @(); denied_tools = @(); approval_required = @(); headless_allow_delegation = $false };
     preflight = '本机尚无 headless profile，派单前需先建 profile' },
  @{ id = 'pi';            name = 'pi coding agent';   kind = 'coding-agent'; runtimeKind = 'pi';
     bins = @('pi');            invoke = 'pi -p {prompt}';                           metering = 'unknown';
     skills = @('coding'); capabilities = @('coding','multi-step-tools');
     boundary = @{ tool_loop = 'yes'; workspace_read = 'unknown'; workspace_write_headless = 'unknown'; shell_headless = 'unknown'; network = 'yes' };
     invokeContract = @{ prompt_transport = 'argv'; output_format = 'text'; exit_code_semantics = @{ '0' = 'success'; 'non-zero' = 'failure' }; permission_flags = @{} };
     permissions = @{ mode = 'unknown'; tool_allowlist = @(); denied_tools = @(); approval_required = @(); headless_allow_delegation = $false };
     preflight = '已实测可用（pi -p）；派单需 full-access（写 ~/.pi 配置）' },
  @{ id = 'mimo';          name = 'MiMo Code (mimocode)'; kind = 'coding-agent'; runtimeKind = 'mimocode';
     bins = @('mimo');          invoke = 'mimo run {prompt}';                        metering = 'unknown';
     skills = @('coding','multi-step-tools'); capabilities = @('coding','multi-step-tools');
     boundary = @{ tool_loop = 'yes'; workspace_read = 'unknown'; workspace_write_headless = 'unknown'; shell_headless = 'unknown'; network = 'yes' };
     invokeContract = @{ prompt_transport = 'argv'; output_format = 'text'; exit_code_semantics = @{ '0' = 'success'; 'non-zero' = 'failure' }; permission_flags = @{} };
     permissions = @{ mode = 'unknown'; tool_allowlist = @(); denied_tools = @(); approval_required = @(); headless_allow_delegation = $false };
     preflight = '0.1.14 实测为 mimocode（ACP/MCP/run/serve）；非交互入口是 mimo run {prompt}；旧模板 mimo {prompt} 会进 TUI' },
  @{ id = 'agent-browser'; name = 'agent-browser';     kind = 'tool-cli';     runtimeKind = 'agent-browser';
     bins = @('agent-browser'); invoke = 'agent-browser {prompt}';                   metering = 'unknown';
     skills = @('web-automation','browser'); capabilities = @('web-automation','browser');
     boundary = @{ tool_loop = 'no'; workspace_read = 'no'; workspace_write_headless = 'no'; shell_headless = 'no'; network = 'yes' };
     invokeContract = @{ prompt_transport = 'unknown'; output_format = 'unknown'; exit_code_semantics = @{}; permission_flags = @{} };
     permissions = @{ mode = 'unknown'; tool_allowlist = @(); denied_tools = @(); approval_required = @(); headless_allow_delegation = $false };
     preflight = '命令型 CLI（agent-browser <command>），非 prompt 型；P0-A 起 kind=tool-cli，派单器拒绝作为 worker' }
)

$agentsDir = Join-Path $Workspace 'agents'
$registry = @()
$patches = @()
$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

# P2-B（2026-10-21）：manifest 只留 Operator 字段；发现事实（cli/kind/能力边界/权限/model_info/preflight）
# 落 agents/<id>/observed.json。消费方经 workers/lib/agent-facts.cjs（JS）或 Read-AgentFacts（PS）读合并视图。
$discoveredKeys = @('present','runtime_kind','kind','cli','capabilities','capability_boundary','invoke_contract','permissions','model_info','preflight')

function Read-JsonOrNull([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try { return (Get-Content $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

# 只保留 Operator 字段（未知键也不丢）；发现字段由 observed.json 承载。
function Split-OperatorFields($obj) {
  $out = @{}
  if ($null -eq $obj) { return $out }
  foreach ($p in $obj.PSObject.Properties) {
    if ($discoveredKeys -notcontains $p.Name) { $out[$p.Name] = $p.Value }
  }
  return $out
}

foreach ($a in $catalog) {
  $manifestPath = Join-Path $agentsDir ($a.id + '\manifest.json')
  $observedPath = Join-Path $agentsDir ($a.id + '\observed.json')
  $existing = Read-JsonOrNull $manifestPath
  $existingObserved = Read-JsonOrNull $observedPath

  # 兼容窗口：observed 缺席时从 manifest 的发现字段派生（一次性迁移；随后 manifest 会去掉这些键）。
  $legacy = @{}
  if (-not $existingObserved -and $existing) {
    foreach ($k in $discoveredKeys) { if ($existing.PSObject.Properties[$k]) { $legacy[$k] = $existing.$k } }
  }
  $prevModelInfo = if ($existingObserved -and $existingObserved.model_info) { $existingObserved.model_info }
    elseif ($legacy['model_info']) { $legacy['model_info'] } else { $null }
  $prevCli = if ($existingObserved -and $existingObserved.cli) { $existingObserved.cli }
    elseif ($legacy['cli']) { $legacy['cli'] } else { $null }
  $prevPreflight = if ($existingObserved -and $existingObserved.preflight) { $existingObserved.preflight }
    elseif ($legacy['preflight']) { $legacy['preflight'] } else { $a.preflight }

  # P2-A 权限校准：只有 claude 有 headless 权限实测证据（t-0006：Write/Bash 被权限栈拒绝）；
  # 其余一律 unknown —— 闸门按只读降级，**不授未证明的写权**。工具型 CLI 不参与 worker 权限模型。
  if ($a.id -eq 'claude') {
    $permCalibration = 'verified'
    $permEvidence = 't-0006：headless -p 下 Write/Bash 被权限栈拒绝，交付物由派单器代写'
  } elseif ($a.kind -eq 'tool-cli') {
    $permCalibration = 'unknown'
    $permEvidence = '工具型 CLI，不参与 worker 权限模型（kind=tool-cli 已禁止派单）'
  } else {
    $permCalibration = 'unknown'
    $permEvidence = '未校准（无 headless 权限实测）；P2-A 按只读降级，不授未证明的写权'
  }
  $permissions = @{}
  foreach ($k in $a.permissions.Keys) { $permissions[$k] = $a.permissions[$k] }
  $permissions['calibration'] = $permCalibration
  $permissions['evidence'] = $permEvidence

  $bin = $null
  foreach ($b in $a.bins) {
    $cmd = Get-Command $b -ErrorAction SilentlyContinue
    if ($cmd) { $bin = $b; $binPath = $cmd.Source; break }
  }

  if (-not $bin) {
    Write-Host ("absent  {0,-14}" -f $a.id)
    # 缺失的 CLI：若已有档案，显式标 present=false（不再让旧快照冒充当前事实）；
    # observed 仍由扫描器补全（kind/能力边界/权限），manifest 只保留 Operator 字段。
    if ($existing) {
      $modelInfoAbsent = if ($prevModelInfo) { $prevModelInfo } else { @{ value = $null; source = 'unknown'; confidence = 'unknown'; evidence = 'CLI 未安装；由 scan-models 按适配器补探测结论' } }
      $observed = @{
        schema_version = 2; agent_id = $a.id; observed_at = $now; present = $false
        runtime_kind = $a.runtimeKind; kind = $a.kind; cli = $prevCli
        capabilities = $a.capabilities; capability_boundary = $a.boundary
        invoke_contract = $a.invokeContract; permissions = $permissions
        model_info = $modelInfoAbsent; preflight = $prevPreflight
      }
      $operator = Split-OperatorFields $existing
      $operator['schema_version'] = 2
      $operator['updated_at'] = $now
      $patches += @{ op = 'set'; path = "agents/$($a.id)/observed.json"; value = $observed; author = 'scanner'; reason = 'discovery absent（observed present=false）'; expected_version = -1 }
      $patches += @{ op = 'set'; path = "agents/$($a.id)/manifest.json"; value = $operator; author = 'scanner'; reason = 'P2-B 派生分离（manifest 只留 Operator 字段）'; expected_version = -1 }
      Write-Host ("         {0,-14} -> present=false（kind={1}）" -f $a.id, $a.kind)
    }
    continue
  }

  # binPath 是机器相关路径（Get-Command 的 Source），直接入库会把维护者用户名带进公开仓库。
  # 写盘前脱敏成 %USERPROFILE% 占位：它只被 schemas/*.json 与 validate-bus.mjs 校验
  # 「是非空字符串」，而派单走的是 cli.invoke 模板（按命令名走 PATH，见 dispatch-task.ps1），
  # 从不读 binPath ⇒ 脱敏零功能影响。控制台输出仍打真实路径，排查不受影响。
  $binPathStored = if ($binPath -and $env:USERPROFILE) {
    $binPath -replace [regex]::Escape($env:USERPROFILE), '%USERPROFILE%'
  } else { $binPath }

  $ver = (& $bin --version 2>&1 | Select-Object -First 1) -join ' '
  $modelInfo = if ($prevModelInfo) { $prevModelInfo } else { @{ value = $null; source = 'unknown'; confidence = 'unknown'; evidence = 'P0-A 未接入配置读取（P0-B 落地）' } }
  $cli = @{ command = $bin; binPath = $binPathStored; version = $ver.Trim(); invoke = $a.invoke }
  $observed = @{
    schema_version = 2; agent_id = $a.id; observed_at = $now; present = $true
    runtime_kind = $a.runtimeKind; kind = $a.kind; cli = $cli
    capabilities = $a.capabilities; capability_boundary = $a.boundary
    invoke_contract = $a.invokeContract; permissions = $permissions
    model_info = $modelInfo; preflight = $prevPreflight
  }
  $manifestDir = Split-Path $manifestPath
  New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
  if ($existing) {
    # 已存在：Operator 字段原样保留（只刷新 updated_at；skills 为空时按目录补，不覆盖编辑）。
    $operator = Split-OperatorFields $existing
    if (-not $operator['skills'] -or @($operator['skills']).Count -eq 0) { $operator['skills'] = $a.skills }
    $operator['updated_at'] = $now
    $patches += @{ op = 'set'; path = "agents/$($a.id)/observed.json"; value = $observed; author = 'scanner'; reason = 'discovery refresh（刷新 observed 事实）'; expected_version = -1 }
    $patches += @{ op = 'set'; path = "agents/$($a.id)/manifest.json"; value = $operator; author = 'scanner'; reason = 'P2-B 派生分离（manifest 只留 Operator 字段）'; expected_version = -1 }
    Write-Host ("refresh {0,-14} -> {1} {2}" -f $a.id, $binPath, $ver.Trim())
  } else {
    $operatorEntry = @{
      id = $a.id; name = $a.name; runtime = 'cli'; model = 'cli-default'; model_price = $null
      metering = $false; metering_source = $a.metering; skills = $a.skills
      persona_prompt = "你是本机 agent CLI「$($a.name)」的档案。总指挥通过你的可执行文件派发任务。"
      limits = @{ max_tokens_per_task = 50000; max_concurrent_tasks = 1; budget_per_day = 2.0; timeout_ms = 900000; heartbeat_ms = 30000 }
      schema_version = 2; updated_at = $now
    }
    $patches += @{ op = 'set'; path = "agents/$($a.id)/observed.json"; value = $observed; author = 'scanner'; reason = 'discovery create（observed 事实）'; expected_version = -1 }
    $patches += @{ op = 'set'; path = "agents/$($a.id)/manifest.json"; value = $operatorEntry; author = 'scanner'; reason = 'discovery create（Operator 字段）'; expected_version = -1 }
    Write-Host ("created {0,-14} -> {1} {2}" -f $a.id, $binPath, $ver.Trim())
  }
  $registry += @{ id = $a.id; name = $a.name; kind = $a.kind; runtime_kind = $a.runtimeKind; bin = $bin; binPath = $binPathStored; version = $ver.Trim(); invoke = $a.invoke; metering = $a.metering }
}

# ── 写入收敛（2026-10-05；P2-B 扩到 observed）：manifest/observed/registry 经 bus-apply 唯一入口，一次超步提交 ──
# 二者是能力闸门的实际输入（agent-pick 读 skills/capabilities、派单器读 metering_source），属
# 「输入类」真相 ⇒ 必须经唯一入口（bus-contract.cjs 白名单，2026-10-05 第二批收敛）。N+1 个 set
# 补丁**同批提交**（原子：要么全部生效要么全部不动）；失败 exit 1 **不回退直写** —— discovery
# 是显式运维动作，重跑即重试；回退等于复活静默绕行。expected_version=-1 是占位，applier
# 的 CLI 层自动填当前版本。顺带修掉 Set-Content -Encoding UTF8 在 Windows PowerShell 5.1
# 下写 BOM 的隐性缺陷（applier 落盘恒为无 BOM UTF-8 + 末行换行）。
$patches += @{ op = 'set'; path = 'agents/registry.json'; value = $registry; author = 'scanner'; reason = "discovery registry（{0} 个已发现）" -f $registry.Count; expected_version = -1 }
$applier = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'workers\bus\bus-apply.mjs'
# BUS_ROOT 与 -Workspace 对齐：applier 默认按自身位置推导根，与 -Workspace 不一致会
# 「扫 A 工作区、写 B 工作区」的静默错位（dispatch-task.ps1 同款教训）。
$env:BUS_ROOT = $Workspace
# ⚠️ 必须用 **-InputObject 形态**，不能管道也不能手工包方括号：
#   · 管道形态 `$patches | ConvertTo-Json` 对多元素数组**本来就输出 [...]**（PS 5.1 实测），
#     再手工包一层就是 [[...]] ⇒ applier 报「补丁[0]: 补丁应为 object」；
#   · 手工包 brackets 只对「单元素出裸对象」的形态成立（dispatch-task.ps1 记的是单元素管道坑，
#     同族不同根）—— -InputObject 把整个数组当**一个**输入序列化，单/多元素都稳定出 JSON 数组。
$payload = ConvertTo-Json -InputObject $patches -Depth 12 -Compress
# ⚠️ --json 让 bus-apply 把契约错误打到 **stdout**：本脚本头部 $ErrorActionPreference='SilentlyContinue'
# 会把 2>&1 合并进来的 stderr ErrorRecord **静默吞掉**（实测：exit 2 的具体原因一行都看不见，
# 排查白花一轮）—— stdout 的 Information 记录不受影响。失败时 $out 里必有人话错误。
$out = $payload | & node $applier --stdin --json 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host ("[discovery] ✗ bus-apply exit {0}：{1}" -f $LASTEXITCODE, (($out | Out-String).Trim()))
  Write-Host '[discovery] 上面打印的 created/refresh 只是扫描结果 —— 本轮**未落盘**（一次超步原子提交）。修复后重跑本脚本即可。'
  exit 1
}
Write-Host ("`n[discovery] 经唯一入口落盘：{0} 个补丁一次超步提交（bus-apply exit 0）" -f $patches.Count)
Write-Host ("registry.json: {0} 个已发现 agent CLI（其中 tool-cli {1} 个不可作 worker）" -f $registry.Count, @($registry | Where-Object { $_.kind -eq 'tool-cli' }).Count)
