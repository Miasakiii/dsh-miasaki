# dispatch-task.ps1 — M3.5 派单器：按 agent 档案 spawn 本机 CLI 执行任务（§7.0 派单式执行）
# 用法：pwsh -File workers/dispatch/dispatch-task.ps1 -TaskId t-xxxx -Agent <id> [-Workspace <root>] [-Requires <caps>]
# 可派闸门（G1，2026-09-30）：派单前校验「这个任务现在该不该派」—— 状态 / 依赖 / assignee 一致性。
#   判定复用 workers/graph/task-ready.mjs --explain --json（不重复实现）；台账 assignee 与 -Agent
#   不一致即拒绝（改派必须走 reassign 补丁带 reason，勿用命令行硬塞）。
#   冷启动降级：agent 无 status.json（从未运行过）时，F3 判活的 no-status 降级为告警；
#   `running` 但心跳过龄仍是僵尸，照旧硬拒。
# 能力闸门（G2，2026-09-11）：派单前校验目标 agent 是否为能力图候选。需求能力取 -Requires，
#   否则解析 brief 的 `requires:` 行；两者都缺省时跳过（零行为变更）。判定复用 workers/graph/agent-pick.mjs。
# 验证闸门（G4，2026-09-30）：声明了风险的 brief 必须有**可用的**异构验证者，否则拒绝派单。
#   声明取 -Risk 或 brief 的 `risk:` / `需要验证：` 行；**未声明即跳过**（零行为变更）。
#   值非法（含自验等级 none）即拒绝并要求修正 —— 不猜。判定复用 workers/graph/verifier-pick.mjs。
#   声明了风险时，派单结束后生成 tasks/<id>/verify-brief.md（**不自动派发**验证任务）。
# 事件留痕（G0，2026-09-30）：派单开始与终态各写一条机器事件（task.started / task.completed /
#   failure.detected），经 workers/bus/bus-apply.mjs 唯一入口；事件是审计不是闸门，写失败只告警不阻断。
# 闸门顺序（先廉价后昂贵）：档案 → 开关 → 预算 → G1 可派 → G2 能力。前者拒了就不跑后者。
# 验证模式：-CheckOnly（只跑预检，不派单也不写总线）/-ParseOnly（只跑 usage 解析，打印将要写入的 usage.jsonl 行）
# 运维入口：-ResetStatus（清除崩溃残留的 status.json，见下）
# 退出码：0 成功；2 拒绝派单（开关未开/无模板/无能力候选/选择器不可用/任务不可派）
#         /3 CLI 执行失败；4 预算熔断拒绝；127 CLI 不存在（记在 worker 日志与事件流里）
# 协议：status.json 由派单器代理写；stdout 存 logs/<task>-stdout.log；usage.jsonl 按 metering_source 解析；transcript.md 追加；tasks.jsonl 由 Commander 另写。
# 记忆隔离：spawn worker 进程时注入 OPENVIKING_RECALL_PEER_SCOPE=actor（§12.2 OpenViking 记忆层），进程结束后恢复原值。
# 运行环境：PowerShell 7+（脚本使用 ?? 运算符）；本机 PS7 路径 %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe（可能不在 PATH，where pwsh 找不到）。

param(
  [string]$TaskId,
  [string]$Agent,
  [string]$Workspace = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),  # 默认=fleet 根（脚本位于 workers/dispatch/）
  [string]$Requires,   # G2 能力闸门：显式需求能力（逗号分隔）；缺省则从 brief 的 requires: 行解析
  [string]$Risk,       # G4 验证闸门：显式声明验证等级（high|vendor|model|agent）；缺省则从 brief 的 risk: 行解析
  [switch]$CheckOnly,
  [switch]$ParseOnly,
  # 调试入口（2026-09-30）：打印将要执行的 argv 后退出 —— **不派单、不写总线、不跑 CLI**。
  # 存在理由：命令构造是派单器最容易静默出错的一环（实测：prompt 里的引号曾泄漏成 CLI 参数），
  # 而它此前**没有任何可观测/可测的出口**（-CheckOnly 只跑闸门、-ParseOnly 在命令构造之后找日志）。
  [switch]$ShowCommand,
  # 运维入口（2026-09-30，t-0010 独立复核 F1）：status.json 的唯一写者就是本脚本，脚本被 Ctrl-C /
  # 断电打断时它会**永停 running** ⇒ 90s 后判活判 stale ⇒ G1 闸门**永久硬拒**该 agent，
  # 而此前没有任何重置入口（只能手工改文件）。本开关给出一条留痕的恢复路径。
  [switch]$ResetStatus
)

$ErrorActionPreference = 'Continue'
$agentDir = Join-Path $Workspace "agents\$Agent"
$today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')

# 判定器（task-ready / agent-pick）与写入入口（bus-apply）都支持 BUS_ROOT 覆盖，默认按自身
# 文件位置推导 fleet 根。派单器的 -Workspace 可能指向别处（测试夹具），必须显式对齐 ——
# 否则会出现「派单器读 A 工作区、判定器读 B 工作区」的静默错位。进程级变量，不影响父进程。
$env:BUS_ROOT = $Workspace

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

# --- G1 可派闸门（2026-09-30 接线）-------------------------------------------
# 依据：docs/graph-engineering-fleet-design.md §8「G1：派单器改造待做」；
#       规划 _refs/fleet-dispatch-wiring-plan-2026-09-30.md §2（W1 / W2）。
# 修的是什么：派单器此前只判「档案 / 开关 / 预算 / 能力」，**不判「这个任务现在该不该派」**——
#   状态不是 queued、依赖未满足、assignee 指向别人，三种情况都能一路派下去。
# 判定复用 workers/graph/task-ready.mjs --explain --json（不重复实现，保持口径唯一）。
# 退出码语义（task-ready.mjs）：0 可派 / 1 被挡 / 2 环境错误（任务不存在亦为 2）。

function Test-DispatchableGate([string]$TaskId, [string]$AgentId, [bool]$LocalEnabled, [bool]$LocalBudgetOk) {
  $cli = Join-Path (Split-Path $PSScriptRoot -Parent) 'graph\task-ready.mjs'
  if (-not (Test-Path $cli)) {
    Write-Host '[gate] 判定器缺失，无法校验可派性（拒绝派单，宁可拒绝也不放行）'
    return $false
  }
  $raw = & node $cli --explain $TaskId --json 2>$null
  $code = $LASTEXITCODE
  if ($code -eq 2) {
    Write-Host "[gate] 拒绝派单：判定器无法给出结论（exit 2 —— 任务 $TaskId 不在台账，或环境错误）"
    return $false
  }
  $parsed = $null
  try { $parsed = ($raw | Out-String).Trim() | ConvertFrom-Json } catch { $parsed = $null }
  if ($null -eq $parsed) {
    Write-Host '[gate] 判定器输出无法解析（拒绝派单）'
    return $false
  }

  # W2：assignee 一致性。G1 判的是**台账 assignee**，而 `-Agent` 是另一个独立输入 ——
  # 二者不等时闸门会「通过」却派给了另一个人。改派必须走 reassign 补丁（带 reason），
  # 这正是 t-0003 / t-0004 的历史做法（见 state/tasks.jsonl 的两条 reassign）。
  if ($parsed.assignee -ne $AgentId) {
    Write-Host "[gate] 拒绝派单：台账 assignee=$($parsed.assignee ?? '未指定')，本次 -Agent=$AgentId"
    Write-Host '[gate] 改派请提交 reassign 补丁（带 reason）经 bus-apply 写入台账，勿用命令行硬塞'
    return $false
  }

  # 口径分歧检测：开关与预算的判定在本地（读 control.json / usage.jsonl）与 G1（task-graph.cjs）
  # 各有一份实现，跨语言无法共享（task-ready.mjs 自己已注明这是唯一需人工维护的一致性点）。
  # 不一致时显式报出来 —— 让漂移可见，而不是静默取其一。
  # 2026-09-30 由 t-0010 独立复核 F5 扩展：此前只比 `enabled`，预算那一对双实现
  # （`Get-DayCost` ↔ `dayCost`）完全没有比对。
  if ($null -ne $parsed.agent) {
    if ([bool]$parsed.agent.enabled -ne $LocalEnabled) {
      Write-Host "[gate] ⚠ 口径分歧：开关本地判定=$LocalEnabled，G1 判定=$($parsed.agent.enabled)（同一事实两套实现，需收敛）"
    }
    if ([bool]$parsed.agent.budgetOk -ne $LocalBudgetOk) {
      Write-Host "[gate] ⚠ 口径分歧：预算本地判定=$LocalBudgetOk，G1 判定=$($parsed.agent.budgetOk)（Get-DayCost ↔ dayCost 两套实现，需收敛）"
    }
  }

  # 台账坏行（F6，2026-09-30）：坏行在读取时被静默跳过，而巡检 `validate-bus` 不在派单路径上 ——
  # 判定可能建立在**残缺台账**上（一条被截断的 `update status=done` 会让任务看起来仍可派）。
  # 有坏行即拒绝：宁可让人先修台账，也不基于不确定的状态派单。
  if ($null -ne $parsed.bus_bad_lines -and [int]$parsed.bus_bad_lines -gt 0) {
    Write-Host "[gate] 拒绝派单：台账有 $($parsed.bus_bad_lines) 行无法解析 —— 判定建立在残缺台账上"
    Write-Host '[gate] 先跑 node workers/validate-bus.mjs 定位坏行并修好，再派单'
    return $false
  }

  $reasons = @($parsed.reasons)

  # 冷启动降级：agent 从未运行过（无 status.json）⇒ F3 的 no-status 不代表僵尸。
  # 判活的本意是「防僵尸」不是「防首跑」（liveness.cjs 的问题陈述）；而 `running` 但心跳
  # 过龄仍是僵尸，照旧硬拒。
  # ⚠️ v1 的诚实边界（2026-09-30 由 t-0010 独立复核 F4 指出，此前注释与实现不符）：
  #   **要不要降级**由结构化字段 `agent.state` 决定（不碰文案）；
  #   但**丢弃哪一条** reason 只能按文案匹配 —— `reasons` 目前是纯字符串数组、没有 code。
  #   因此 `task-graph.cjs` 的该条文案（「判活失败（心跳过龄，F3）」）与本处的匹配式
  #   **必须成对改动**：`scripts/verify-all.mjs` 的 `dispatch 可派闸门接线` 断言把两侧
  #   字面量一起钉住，改任一侧即红。给 reasons 加 code 的结构化改造留作下一批。
  if ($null -ne $parsed.agent -and $parsed.agent.state -eq 'no-status') {
    $dropped = @($reasons | Where-Object { $_ -match '判活失败' })
    if ($dropped.Count -gt 0) {
      $reasons = @($reasons | Where-Object { $_ -notmatch '判活失败' })
      Write-Host "[gate] ⚠ $AgentId 无 status.json（从未运行过），判活按首跑放行（降级为告警）"
    }
  }

  if ($reasons.Count -eq 0) {
    Write-Host "[gate] 闸门通过：$TaskId（$($parsed.status)）图就绪=$($parsed.graph_ready)，assignee=$($parsed.assignee)"
    return $true
  }
  Write-Host "[gate] 拒绝派单：$TaskId 当前不可派（$($reasons.Count) 条原因）"
  foreach ($r in $reasons) { Write-Host "  ✗ $r" }
  # 判活类拒绝最常见的根因是「上一次派单被打断留下的 running 残留」（F1）：给出**可复制**的
  # 恢复命令 —— 否则唯一出路是手工改文件（独立复核实测：全仓此前没有任何重置入口）。
  if (@($reasons | Where-Object { $_ -match '判活失败' }).Count -gt 0) {
    Write-Host '[gate] 若已确认该 agent 无存活进程（崩溃 / 机器重启遗留），用它清残留后重派：'
    Write-Host "[gate]   pwsh -File workers/dispatch/dispatch-task.ps1 -Agent $AgentId -ResetStatus"
  }
  return $false
}

# --- G0 事件留痕（2026-09-30 接线）-------------------------------------------
# 派单过程此前**零机器事件** —— state/events.jsonl 长期全是人工里程碑（调研结论）。
# 每次派单只写两条：task.started 与终态（task.completed / failure.detected）。
# 刻意不写心跳事件（status.json 高频更新，每次都落事件会让事件流膨胀）。
# 事件是审计不是闸门：applier 报错（如并发超步冲突 exit 3）只告警，绝不阻断派单。
function Write-BusEvent([string]$Type, [string]$TaskId, [string]$Reason, $Fields) {
  $applier = Join-Path (Split-Path $PSScriptRoot -Parent) 'bus\bus-apply.mjs'
  if (-not (Test-Path $applier)) {
    Write-Host "[event] applier 缺失，跳过事件 $Type（审计缺口，不影响派单）"
    return
  }
  # --emit-event 用 expected_version:-1 占位，applier 自动填当前版本 —— 调用方不必先查版本
  $evArgs = @($applier, '--emit-event', $Type, '--author', 'dispatcher')
  # `--task` 可选：并非所有事件都挂在任务上（如 `agent.status.reset` 是 agent 级状态迁移）
  if (-not [string]::IsNullOrWhiteSpace($TaskId)) { $evArgs += @('--task', $TaskId) }
  if (-not [string]::IsNullOrWhiteSpace($Reason)) { $evArgs += @('--reason', $Reason) }
  # 附加字段（2026-09-30 补）：`failure.detected` 此前**不带 state** ⇒ 事件流里
  # 「worker 自述受阻（blocked）」与「真失败（error）」**不可分**（由 t-0011 独立复核指出）。
  if ($null -ne $Fields) {
    foreach ($k in $Fields.Keys) { $evArgs += @('--field', "$k=$($Fields[$k])") }
  }
  $out = & node @evArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[event] ⚠ $Type 未入流（bus-apply exit $($LASTEXITCODE)）：$(($out | Out-String).Trim())"
  } else {
    Write-Host "[event] $Type 已入流"
  }
}

# --- 计量落盘（B5 写入收敛，2026-09-30）--------------------------------------
# usage.jsonl 是**计量原始来源**（主协议 §9 明示「成本唯一原始来源」），不是派生态 ——
# 故经唯一入口落盘（白名单已登记 `agents/<id>/usage.jsonl` 的 append）。
# **失败语义：不丢数据优先于治理形式** —— applier 失败时回退直写并显式告警。
# 理由：计量丢了就是成本账的缺口（不可再生），而「这次没走唯一入口」是可追认的治理缺口。
# 两者不对称，故选择保住数据；但绝不静默 —— 告警里明写「本次未经唯一入口」。
# 回退/异常路径的**持久**记录（2026-09-30，t-0011 复核指出）：
# 此前告警只走 `Write-Host` —— 控制台一关就没了，「可追认」于是成了空头承诺
# （复核实测：t-0010 的 22KB 派单日志里查不到任何 `[usage]` 行）。
# 现在落 `agents/<id>/logs/dispatch.log`，可 `grep -r usage-bypass agents/*/logs/dispatch.log` 检索。
function Add-UsageBypassLog([string]$Message) {
  try {
    $logDir = Join-Path $agentDir 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    "$stamp [usage-bypass] $Message" | Add-Content (Join-Path $logDir 'dispatch.log')
  } catch {
    Write-Host "[usage] ⚠ 旁路日志写入失败：$($_.Exception.Message)"
  }
}

function Write-UsageRow($Row, [string]$AgentId) {
  $applier = Join-Path (Split-Path $PSScriptRoot -Parent) 'bus\bus-apply.mjs'
  $target = Join-Path $agentDir 'usage.jsonl'
  $summary = "in $($Row.input_tokens) / out $($Row.output_tokens) / cache-read $($Row.cache_read_tokens) / cost $('{0:N4}' -f $Row.cost)"
  if (Test-Path $applier) {
    # expected_version = -1 是占位：applier 会自动填当前版本（调用方不必先查版本）
    $patchObj = @{
      op = 'append'
      path = "agents/$AgentId/usage.jsonl"
      value = $Row
      author = 'dispatcher'
      reason = '派单器按 metering_source 解析出的计量行'
      expected_version = -1
    }
    # ⚠️ **手工包方括号，不用 `-AsArray`** —— 实测两个坑：
    #   ① PS7 的 `-AsArray` 对「单元素数组」会**多包一层**（输出 `[[{…}]]`），applier 随即报
    #      「补丁应为 object」——本轮实测踩到；又因为下面那行把 stderr 一并吞了，现场只看到
    #      `exit 2` 而不知原因，定位白花一轮；
    #   ② `-AsArray` 是 PS7 专有参数，手工组装不依赖它。
    $payload = '[' + (ConvertTo-Json $patchObj -Depth 6 -Compress) + ']'
    $out = $payload | & node $applier --stdin 2>&1
    $outText = ($out | Out-String).Trim()
    if ($LASTEXITCODE -eq 0) {
      Write-Host "[usage] 经唯一入口落盘：$summary"
      return
    }
    # 错误必须带出来：吞掉它就是「失败了但说不清为什么」——`exit 2` 单独一个数字帮不了任何人
    Write-Host "[usage] ⚠ 经唯一入口写入失败（bus-apply exit $($LASTEXITCODE)）：$outText"
    # ⚠️ **partial 失败不回退**（2026-09-30 由 t-0011 独立复核指出，比审计缺口更重）：
    # applier 的 partial 语义是「补丁可能已落盘、但超步未提交」⇒ 再直写一遍就是**同一行两遍**，
    # 造成**重复计量、成本双计**。故按「已写待重读」处理：不回退、只告警 + 落盘。
    if ($outText -match '部分写入|partial') {
      Write-Host '[usage] 判定为 partial（补丁可能已落盘）—— **不回退**，避免同一行写两遍'
      Write-Host '[usage] 复核：核对 usage.jsonl 行数与 node workers/bus/bus-apply.mjs --current-version'
      Add-UsageBypassLog "partial-failure task=$($Row.task) agent=$AgentId 未回退（补丁可能已落盘）"
      return
    }
    Write-Host '[usage] 回退直写以保住计量数据'
  } else {
    Write-Host '[usage] ⚠ applier 缺失 —— 回退直写'
  }
  # 回退路径必须**自带可检索标记**（t-0011 复核建议）：否则「可追认」是空头承诺 ——
  # 事后没人能从账里看出哪几行没走唯一入口。标记写进行内（`note` 是既有字段，不动 schema）。
  if ($null -ne $Row.note) { $Row.note = "$($Row.note) [BUS_BYPASS]" } else { $Row.note = '[BUS_BYPASS]' }
  ($Row | ConvertTo-Json -Compress) | Add-Content $target
  Add-UsageBypassLog "direct-write task=$($Row.task) agent=$AgentId $summary（未经唯一入口）"
  Write-Host "[usage] 已直写 usage.jsonl（$summary）—— ⚠ 本次**未经唯一入口**（行内已标记 BUS_BYPASS）"
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

# --- G4 验证闸门（2026-09-30 接线）-------------------------------------------
# 依据：docs/graph-engineering-fleet-design.md §8「G4：派单挂载待做」；
#       规划 _refs/fleet-dispatch-wiring-plan-2026-09-30.md §11。
# 修的是什么：G4 的异构验证者选取此前只是 Commander「可查询」，派单流程**不强制挂载** ——
#   高风险任务应挂而未挂时**没有任何告警**（这正是判定层落地时自陈的边界）。
# 纪律与 G1 闸门同构：未声明即跳过（零行为变更）；值非法即拒绝，**不猜**。

# 验证等级：优先 -Risk 显式传入，其次从 brief.md 解析 `risk:` / `需要验证：` 行，解析不到即跳过。
function Resolve-VerifyLevel([string]$Brief) {
  if (-not [string]::IsNullOrWhiteSpace($Risk)) { return $Risk.Trim() }
  if ([string]::IsNullOrWhiteSpace($Brief)) { return '' }
  # 与 Resolve-RequiredCaps 同样的行内空白类（.NET 的 \s 含换行，^\s* 会吃穿换行）
  $m = [regex]::Match($Brief, '(?m)^[^\S\r\n]*(?:risk|需要验证)[^\S\r\n]*[:：][^\S\r\n]*(.+?)[^\S\r\n]*$')
  if (-not $m.Success) { return '' }
  $v = $m.Groups[1].Value.Trim()
  if ($v -eq '' -or $v -match '^[（(\[<]') { return '' }   # 占位符（如 `risk: (待定)`）视为未声明
  return $v
}

# 等级词 → verifier-pick 的 --min-level。返回 $null 表示**无法识别**（调用方必须拒绝，不得默认放行）。
# 注意 `none`（同一 agent = 自验）在 §6.2 是**禁止**项，刻意与「无法识别」同样处理 ——
# 声明自验不是「不用验证」，而是声明了一个不被允许的选项。
function ConvertTo-MinLevel([string]$Raw) {
  switch ($Raw.Trim().ToLower()) {
    'high' { return 'vendor' }      # high ⇒ 最强异构
    'vendor' { return 'vendor' }
    'model' { return 'model' }
    'agent' { return 'agent' }
    default { return $null }
  }
}

# 验证闸门本体：声明了风险，就必须有**可用**的异构验证者。
function Test-VerifierGate([string]$Producer, [string]$MinLevel) {
  $picker = Join-Path (Split-Path $PSScriptRoot -Parent) 'graph\verifier-pick.mjs'
  if (-not (Test-Path $picker)) {
    Write-Host '[verifier] 选择器缺失，无法校验验证者（拒绝派单，宁可拒绝也不放行）'
    return $false
  }
  $raw = & node $picker --for $Producer --min-level $MinLevel --json 2>$null
  $code = $LASTEXITCODE
  if ($code -eq 2) {
    Write-Host "[verifier] 拒绝派单：选择器无法给出结论（exit 2 —— 产出者 $Producer 无档案，或环境错误）"
    return $false
  }
  $parsed = $null
  try { $parsed = ($raw | Out-String).Trim() | ConvertFrom-Json } catch { $parsed = $null }
  if ($null -eq $parsed) {
    Write-Host '[verifier] 选择器输出无法解析（拒绝派单）'
    return $false
  }
  # 判据是**可用候选数**而不是退出码：默认路径下 verifier.cjs 确实已把不可用者滤掉
  # （`requireAvailable`），退出码也基于 `candidates.length` —— 但在 `--all`（includeUnavailable）
  # 语义下候选可能全是 `available=false`。显式看 `available` 字段，
  # 不依赖「过滤器恰好把不可用者滤掉了」这个隐含前提。
  $avail = @($parsed.candidates | Where-Object { $_.available })
  if ($avail.Count -eq 0) {
    $total = @($parsed.candidates).Count
    Write-Host "[verifier] 拒绝派单：无**可用**验证者（声明最低异构 $MinLevel；候选 $total 个，可用 0 个）"
    foreach ($w in @($parsed.warnings)) { Write-Host "  ⚠ $w" }
    Write-Host '[verifier] 要么让某个异构 agent 可用（开关 / 档案），要么在 brief 里撤回风险声明'
    return $false
  }
  $top = $avail | Select-Object -First 1
  Write-Host "[verifier] 闸门通过：$Producer 的可用验证者 $($avail.Count) 个（最低异构 $MinLevel；首选 $($top.agentId)/$($top.level)）"
  return $true
}

# 生成验证任务书 —— **只准备材料，不自动派发**：自动创建/派发验证任务会引入新的任务生命周期
# （验证任务的身份、台账 op、成本归属），属独立议题。
# 时序诚实标注：派单刚结束时交付契约通常还没落盘（由 Commander 事后代写），故任务书里的产物引用
# 可能为空 —— 明确提示可重新生成，而不是假装它已经完整。
function Write-VerifyBrief([string]$TaskId, [string]$Producer, [string]$MinLevel) {
  $picker = Join-Path (Split-Path $PSScriptRoot -Parent) 'graph\verifier-pick.mjs'
  if (-not (Test-Path $picker)) { Write-Host '[verifier] 选择器缺失，跳过验证任务书生成'; return }
  $raw = & node $picker --brief $TaskId --producer $Producer --json 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[verifier] 验证任务书生成失败（verifier-pick exit $($LASTEXITCODE)）—— 材料缺失，需人工补"
    return
  }
  $parsed = $null
  try { $parsed = ($raw | Out-String).Trim() | ConvertFrom-Json } catch { $parsed = $null }
  if ($null -eq $parsed -or [string]::IsNullOrWhiteSpace($parsed.brief)) {
    Write-Host '[verifier] 验证任务书输出无法解析 —— 材料缺失，需人工补'
    return
  }
  $vf = Join-Path $Workspace "tasks\$TaskId\verify-brief.md"
  # 形态契约（2026-09-30 由仓库级 `repo/style` 闸门在**提交后**当场抓到，见下）：
  # `tasks/<id>/verify-brief.md` 是**入库**文本 ⇒ 必须 LF + 无 BOM + 末行换行。
  # 此前用 `($parsed.brief + "`n") | Set-Content -Encoding UTF8`：`-Encoding UTF8` 在 PS7 是 no-BOM
  # （这点没问题），但 **PowerShell 会为它写出的那一行补平台换行 `\r\n`**，而内容里其余换行是
  # `verifier-pick` 给的 LF ⇒ 产物成了「47 个 LF + 1 个 CRLF」的混合行尾（实测即此形态）。
  # 改为按字节写：换行只用 LF，并显式补末行换行（不依赖任何 cmdlet 的隐式行为）。
  # 注：`usage.jsonl` 的回退直写仍走 `Add-Content`（同为 CRLF）—— 那是**运行时产物**（`.gitignore` 挡在
  # 入库之外、JSONL 解析容忍行尾 `\r`），不在本形态契约范围内。
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($vf, ($parsed.brief.TrimEnd("`r", "`n") + "`n"), $utf8NoBom)
  Write-Host "[verifier] 验证任务书已生成：$vf"
  Write-Host '[verifier] ⚠ 未自动派发 —— 交付契约落盘后可用 verifier-pick --brief 重新生成（那时的产物引用才完整）'
  Write-Host "[verifier] 派发方式：把该任务书作为新任务的 brief，投给上面选出的验证者（最低异构 $MinLevel）"
}

# 命令构造的唯一实现（2026-09-30 从主循环抽出，使 -ShowCommand 与真实执行**共用同一条路径** ——
# 各写一份必然漂移，那正是本仓反复吃亏的形态）。
# · `invoke` 模板：按空白切**模板**，`{prompt}` 那一格替换为真实 prompt（**单个 argv 元素**，
#   永不被切分）⇒ prompt 里的引号 / 空格 / 换行都不影响参数边界；
# · `cmd:` 行：显式命令行，沿用简单的空格+引号切分。
function Resolve-Argv($Cmd, [string]$Prompt) {
  $argv = @()
  if ($Cmd.kind -eq 'invoke') {
    foreach ($part in ($Cmd.text -split '\s+')) {
      if ($part -eq '') { continue }
      if ($part -eq '{prompt}') { $argv += $Prompt }
      elseif ($part.Contains('{prompt}')) { $argv += ($part -replace '\{prompt\}', $Prompt) }
      else { $argv += $part }
    }
  } else {
    $buf = ''; $inQ = $false
    foreach ($p in ($Cmd.text -split ' ')) {
      if ($inQ) {
        $buf += ' ' + $p
        if ($p.EndsWith('"')) { $inQ = $false; $argv += $buf.Trim('"'); $buf = '' }
        continue
      }
      # 首尾**成对**引号的 token：剥掉外层引号再入 argv。
      # 缺这一步的后果是静默的（实测 2026-09-30）：`cmd: node -e "process.exit(3)"` 会把
      # 字面量 `"process.exit(3)"` 传给 node —— 它在 JS 里是**合法的字符串表达式**，
      # 于是命令静默 exit 0，而派单器把它记成**成功**（本该 exit 3）。
      if ($p.Length -ge 2 -and $p.StartsWith('"') -and $p.EndsWith('"')) {
        $argv += $p.Substring(1, $p.Length - 2)
        continue
      }
      if ($p.StartsWith('"')) { $inQ = $true; $buf = $p; continue }
      if ($p -ne '') { $argv += $p }
    }
  }
  # `,$argv` 而非 `$argv`：PowerShell 会把单元素数组**展开**成标量，加逗号才保得住数组
  return , $argv
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

# --- 运维入口：清除崩溃残留的 status.json（F1 收口，2026-09-30）----------------
# 为什么是**删除**而不是写 `stopped`：判活对 `stopped` 同样给 `alive=false`（liveness.cjs），
# 删掉才会走「从未运行」（no-status）路径，被闸门按首跑降级放行。
# 为什么只在**残留形态**下允许：真在跑的 agent 心跳是新鲜的 —— 此时拒绝，让人先确认进程，
# 避免把正在干活的 agent 的档案抹掉（崩溃残留最多等一个 `heartbeat_ms×3` 窗口即转为过龄）。
if ($ResetStatus) {
  $statusPath = Join-Path $agentDir 'status.json'
  if (-not (Test-Path $statusPath)) {
    Write-Host "[reset] $Agent 无 status.json —— 本就按「首跑」判定，无需清除"
    exit 0
  }
  $prevStatus = Read-JsonFile $statusPath
  $prevState = if ($prevStatus) { [string]$prevStatus.state } else { '(不可解析)' }
  $manifestForReset = Read-JsonFile (Join-Path $agentDir 'manifest.json')
  $periodMs = 30000
  if ($manifestForReset -and $manifestForReset.limits -and $manifestForReset.limits.heartbeat_ms) {
    $periodMs = [int]$manifestForReset.limits.heartbeat_ms
  }

  # 只清**会挡住派单的形态**：判活对 `running`/`draining` 看心跳新鲜度、对 `stopped` 恒给 false；
  # 其余状态（idle / error / blocked …）判活一律放行，且它们的 `last_error` / `tokens` 是
  # 「上次为什么失败」的线索 —— 清掉只会丢信息。
  # （本开关的第一版**没有**这条限制，真机实测当场把 claude 的 `error` 档案清掉了 —— 故收窄。）
  $blocking = $false
  $why = ''
  if ($prevState -eq 'stopped') {
    $blocking = $true; $why = 'state=stopped（判活恒为 false）'
  } elseif ($prevState -eq 'running' -or $prevState -eq 'draining') {
    # ⚠️ 时间戳形态陷阱（实测踩到）：PS7 的 `ConvertFrom-Json` 会把 ISO-8601 字符串**自动转成
    # `[datetime]`** —— 再 `[string]` 转换后 `[datetime]::Parse` 会按当前文化解析该字符串表示，
    # 失败或被解析成错误时刻（本机 zh-CN 下实测：新鲜心跳被判成「不新鲜」，于是误删了档案）。
    # 两条分支各取正确口径：已是 DateTime 直接转 UTC；字符串则用 RoundtripKind 按 ISO 解析。
    $rawBeat = $prevStatus.heartbeat_at
    $beat = $null
    if ($rawBeat -is [datetime]) {
      $beat = ([datetime]$rawBeat).ToUniversalTime()
    } else {
      try {
        $beat = [datetime]::Parse(
          [string]$rawBeat,
          [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::RoundtripKind
        ).ToUniversalTime()
      } catch { $beat = $null }
    }
    if ($beat -and ((Get-Date).ToUniversalTime() - $beat).TotalMilliseconds -le (3 * $periodMs)) {
      $limitSec = [int](3 * $periodMs / 1000)
      Write-Host "[reset] 拒绝：$Agent 心跳新鲜（state=$prevState，心跳 $($prevStatus.heartbeat_at)，上限 ${limitSec}s）"
      Write-Host '[reset] 该 agent 可能**真在跑** —— 确认无存活进程后重试（崩溃残留最多等一个心跳窗口即转为过龄）'
      exit 2
    }
    $blocking = $true; $why = "state=$prevState 但心跳过龄（判活已降级为 unknown ⇒ alive=false）"
  }

  if (-not $blocking) {
    Write-Host "[reset] 无需清除：$Agent 当前 state=$prevState **不影响派单**（判活放行），且档案里的 last_error / tokens 是线索"
    Write-Host '[reset] 要重派就直接派单；确实要抹掉记录请手工删除该文件'
    exit 0
  }

  Remove-Item $statusPath -Force
  Write-Host "[reset] 已清除 status.json（原 $why，current_task=$($prevStatus.current_task)）"
  Write-Host "[reset] $Agent 下次派单按「首跑」判定（无 status.json ⇒ 判活降级为告警放行）"
  # 状态迁移必须留痕（2026-09-30 补）：删 status.json **是一次状态迁移**，此前零事件 ——
  # 那正是「事件流完整覆盖状态迁移」的反例（由 t-0011 独立复核指出）。
  Write-BusEvent 'agent.status.reset' '' "clear stale status.json: $why（原 current_task=$($prevStatus.current_task)）"
  exit 0
}

if ($CheckOnly) {
  $manifest = Read-JsonFile (Join-Path $agentDir 'manifest.json')
  if (-not $manifest) { Write-Host "[budget] agent $Agent 无档案"; exit 2 }
  $ok = Test-Budget $agentDir $manifest
  if (-not $ok) { exit 4 }
  # 闸门顺序与派单路径一致：G1 可派（这个任务该不该派）→ G2 能力（派给谁合适）。
  # 两者都纳入 -CheckOnly，使之成为「能不能派」的完整判定（2026-09-11 的能力闸门同理）。
  $controlForGate = Read-JsonFile (Join-Path $agentDir 'control.json')
  $localEnabled = [bool]($controlForGate -and $controlForGate.enabled -eq $true)
  # 走到这里说明预算已过（否则上面已 exit 4）⇒ LocalBudgetOk = $true
  if (-not (Test-DispatchableGate $TaskId $Agent $localEnabled $true)) { exit 2 }
  # 能力闸门也纳入预检：让 -CheckOnly 成为"能不能派"的完整判定
  $briefText = Get-Content (Join-Path $Workspace "tasks\$TaskId\brief.md") -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  $reqCaps = Resolve-RequiredCaps $briefText
  if ($reqCaps) {
    if (-not (Test-CapabilityGate $reqCaps $Agent)) { exit 2 }
  } else {
    Write-Host '[capability] brief 未声明 requires（或为占位符），跳过能力闸门（零行为变更）'
  }
  # G4 验证闸门（2026-09-30）：声明了风险就必须有可用验证者；未声明即跳过
  $verifyRaw = Resolve-VerifyLevel $briefText
  if ($verifyRaw) {
    $minLevel = ConvertTo-MinLevel $verifyRaw
    if ($null -eq $minLevel) {
      Write-Host "[verifier] 拒绝派单：无法识别的验证等级 '$verifyRaw'（应为 high|vendor|model|agent；none 属禁止项）"
      exit 2
    }
    if (-not (Test-VerifierGate $Agent $minLevel)) { exit 2 }
  } else {
    Write-Host '[verifier] brief 未声明 risk / 需要验证，跳过验证闸门（零行为变更）'
  }
  exit 0
}

$manifest = Read-JsonFile (Join-Path $agentDir 'manifest.json')
if (-not $manifest) { Write-Host "[dispatch] agent $Agent 无档案"; exit 2 }
$control = Read-JsonFile (Join-Path $agentDir 'control.json')
if (-not $control -or $control.enabled -ne $true) { Write-Host "[dispatch] agent $Agent 开关未开启，拒绝派单（§7.0 派单许可）"; exit 2 }
if ($manifest.preflight) { Write-Host "[dispatch] preflight 提示：$($manifest.preflight)" }
if (-not (Test-Budget $agentDir $manifest)) { exit 4 }

# 闸门 1：可派性（G1 task-ready）—— 任务状态 / 依赖满足 / assignee 一致性。
# 到这里开关与预算都已确认通过，故 LocalEnabled / LocalBudgetOk 均为 $true（与 G1 判定做口径分歧检测）。
if (-not (Test-DispatchableGate $TaskId $Agent $true $true)) { Write-Host "[dispatch] 可派闸门未通过，拒绝派单"; exit 2 }

# 闸门 2：能力候选（G2 agent-pick）。brief 未声明 requires 时零行为变更。
$briefForCaps = Get-Content (Join-Path $Workspace "tasks\$TaskId\brief.md") -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
$reqCaps = Resolve-RequiredCaps $briefForCaps
if ($reqCaps) {
  if (-not (Test-CapabilityGate $reqCaps $Agent)) { Write-Host "[dispatch] 能力闸门未通过，拒绝派单"; exit 2 }
} else {
  Write-Host '[capability] brief 未声明 requires（或为占位符），跳过能力闸门（零行为变更）'
}

# 闸门 3：验证者（G4 verifier-pick，2026-09-30 接线）。声明了风险就必须有**可用**验证者；
# 未声明即跳过（零行为变更）。值非法即拒绝 —— 不猜。$verifyLevel 供派单后生成任务书复用。
$verifyLevel = ''
$verifyMinLevel = $null
$verifyRaw = Resolve-VerifyLevel $briefForCaps
if ($verifyRaw) {
  $verifyMinLevel = ConvertTo-MinLevel $verifyRaw
  if ($null -eq $verifyMinLevel) {
    Write-Host "[verifier] 拒绝派单：无法识别的验证等级 '$verifyRaw'（应为 high|vendor|model|agent；none 属禁止项）"
    exit 2
  }
  if (-not (Test-VerifierGate $Agent $verifyMinLevel)) { Write-Host "[dispatch] 验证闸门未通过，拒绝派单"; exit 2 }
  $verifyLevel = $verifyRaw
} else {
  Write-Host '[verifier] brief 未声明 risk / 需要验证，跳过验证闸门（零行为变更）'
}

$brief = Get-Content (Join-Path $Workspace "tasks\$TaskId\brief.md") -Raw -ErrorAction SilentlyContinue
$context = Get-Content (Join-Path $Workspace "tasks\$TaskId\context.md") -Raw -ErrorAction SilentlyContinue
$prompt = (($brief ?? '') + "`n`n## 上下文`n" + ($context ?? '')).Trim()

# 命令构造分两条路径，**刻意不共用切分逻辑**（2026-09-30 实测踩坑后拆开）：
#   · `cmd:` 行 = 显式命令行（命令型任务），沿用简单的空格/引号切分；
#   · `invoke` 模板 = **按占位符切参数**，prompt 作为**单个 argv 元素**传入。
#
# 为什么必须拆：旧实现把 invoke 模板与 prompt **字符串拼成一个命令行再切分**，于是
# prompt 里的引号会被当成**参数边界** —— 实测：context 里写了 `grep -n "X" -A 20`，
# 切分时那个 `"X"` 提前闭合了引号模式，`-A` / `20` 泄漏成 CLI 的参数，
# pi 直接报 `Unknown option: -A` 退出（且**没有任何地方提示「prompt 里有引号」**）。
# 新做法从根上避免：prompt 永不被切分。
$cmdLines = @()
foreach ($line in (($brief ?? '') -split "`n")) {
  if ($line -match '^\s*cmd:\s*(.+)$') { $cmdLines += @{ kind = 'raw'; text = $Matches[1].Trim() } }
}
if ($cmdLines.Count -eq 0) {
  $invoke = $manifest.cli.invoke
  if ($invoke -match '\{prompt\}') {
    $cmdLines += @{ kind = 'invoke'; text = $invoke }
  } else {
    Write-Host "[dispatch] invoke 模板无 {prompt} 且 brief 无 cmd: 行，无法派单"; exit 2
  }
}

# -ShowCommand：打印解析结果后退出。与真实执行**共用 Resolve-Argv** ⇒ 看到的就是将要执行的。
if ($ShowCommand) {
  foreach ($cmd in $cmdLines) {
    $argv = Resolve-Argv $cmd $prompt
    Write-Host "[cmd] 模板：$($cmd.text)"
    Write-Host "[cmd] exe=$($argv[0]) argc=$($argv.Count)"
    for ($i = 0; $i -lt $argv.Count; $i++) {
      if ($argv[$i] -eq $prompt) {
        Write-Host "  [$i] <prompt：$($prompt.Length) 字符，作为单个参数传入>"
      } else {
        Write-Host "  [$i] $($argv[$i])"
      }
    }
  }
  exit 0
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

# 事件留痕（G0）：派单开始。刻意放在 CLI 启动**之前** —— worker 崩了也留下痕迹
# （此前 events.jsonl 长期只有人工里程碑，机器过程零留痕）。
Write-BusEvent 'task.started' $TaskId "派单给 $Agent"

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
    # argv 构造走**唯一实现**（Resolve-Argv），与 -ShowCommand 共用 —— 两侧各写一份必然漂移
    $argv = Resolve-Argv $cmd $prompt
    if ($cmd.kind -eq 'invoke') {
      # 日志刻意只回显模板（不回显整段 prompt）：既能证明走的是本条路径，又不让 outFile 被 prompt 淹没。
      "=== $($cmd.text)（prompt 作为单个参数，$($prompt.Length) 字符）===" | Tee-Object -FilePath $outFile -Append
    } else {
      "=== $($cmd.text) ===" | Tee-Object -FilePath $outFile -Append
    }
    # 只有一个元素时 `$argv[1..0]` 会**反向取两个**（PowerShell 区间语义），故显式判空
    $exe = $argv[0]
    $args = if ($argv.Count -gt 1) { @($argv[1..($argv.Count - 1)]) } else { @() }
    # CLI 存在性预检（2026-09-30，依据 t-0010 独立复核 F2）：
    # pwsh 对「命令不存在」只吐一条 CommandNotFoundException 到流里，**不改 $LASTEXITCODE**
    # （实测 pwsh 7.6.6：该值保持上一次调用留下的 0）⇒ 下面的 `if ($LASTEXITCODE -ne 0)`
    # 不会触发 ⇒ exit 0 + idle + **task.completed 写进唯一真相流**（G0 接线后，
    # 「假成功」不再只是 status.json 的事，而会污染事件流）。预检把它堵在源头。
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
      "[dispatch] CLI 不存在或不在 PATH：$exe（记 127；不把「没跑起来」当成功）" | Tee-Object -FilePath $outFile -Append
      if ($exitCode -eq 0) { $exitCode = 127 }
      continue
    }
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
#
# ⚠️ 2026-09-30 修（**阻断级**，由 t-0011 独立复核指出）：此前整段包在 `if ($exitCode -eq 0)` 里
# ⇒ **失败轮的成本零痕迹**。而失败轮**同样可能已经花钱**（agent 跑了若干回合才失败；
# 实测 claude 首派的 404 轮就是 1 回合即退，但真实失败往往在若干回合之后）。
# 这与主协议 §9「usage.jsonl 是成本**唯一**原始来源」直接冲突：账目不完整比账目难看严重得多。
#
# 新语义（四条分支都有痕迹）：
#   exit 0  + 解析出计量   → 真实计量行
#   exit 0  + 解析不出     → **显式未计量行**（原逻辑是「不写」，也是缺口）
#   exit≠0  + 解析出计量   → **真实计量行**（失败轮的成本入账）
#   exit≠0  + 解析不出     → **显式未计量行**（并注明失败退出码）
$usageRow = $null
$stdout = Get-Content $outFile -Raw
$source = $manifest.metering_source
$usageRow = Get-UsageRow $source $stdout $TaskId $Agent
if ($null -eq $usageRow) {
  # `Get-UsageRow` 对已知源解析失败会返回 $null；对 unknown/未登记源它已返回显式未计量行。
  # 这里兜住前一种：失败轮也要能在账上被看见，否则「跑过但没记账」永远查不出来。
  $why = if ($exitCode -eq 0) { "$source 解析不出计量（该源可能无机器可读输出）" } else { "exit $exitCode 且 $source 解析不出计量" }
  $usageRow = Parse-Unmetered $source $TaskId $Agent $why
  Write-Host "[usage] $source 未解析出计量 —— 写**显式未计量行**（$why）"
}
Write-UsageRow $usageRow $Agent

# status 终态（K4，2026-09-30）：判据单点在 workers/dispatch/final-state.ps1 ——
# 「CLI exit 0」不等于「健康空闲」：worker 自述受阻的载体是交付契约
# tasks/<id>/result.json 的 status（blocked/failed），过去被一律记成 idle，
# 于是受阻的 worker 在面板与桌宠上照常显示正常（静默失效 #24）。
# 退出码语义不动（§7.0 的 0/3/4），此处只改 status.json 的落账。
$taskResultPath = Join-Path $Workspace "tasks\$TaskId\result.json"
$final = $null
$finalFailed = $false
try {
  $final = (& (Join-Path $PSScriptRoot 'final-state.ps1') -ExitCode $exitCode -ResultPath $taskResultPath) | ConvertFrom-Json
} catch {
  # 判定器调用失败（同进程调用，概率极低）——**不得静默回退成 idle**：那会把一份
  # `status=blocked` 的交付契约记成「健康空闲 + task.completed」，正是 K4 刚关掉的静默失效。
  # 2026-09-30 由 t-0010 独立复核在 Q3 附带指出。保守记 error（判定失败本身就是要人看的异常）；
  # 刻意**不在这里复制一份判定逻辑**（保持 final-state.ps1 是单点）。
  $finalFailed = $true
  Write-Host "[state] final-state.ps1 调用失败（$($_.Exception.Message)）—— 终态未判定，保守记 error"
}
$state = if ($finalFailed) { 'error' } elseif ($final -and $final.state) { $final.state } elseif ($exitCode -eq 0) { 'idle' } else { 'error' }
$stepText = if ($finalFailed) { "派单完成（exit $exitCode）：终态判定器调用失败，未判定" }
  elseif ($final -and $final.reason) { "派单完成（exit $exitCode，$($final.source)）：$($final.reason)" }
  else { "派单完成（exit $exitCode）" }
$status.state = $state; $status.current_task = $null; $status.progress = 1.0; $status.step = $stepText; $status.heartbeat_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
if ($state -ne 'idle') {
  $status.last_error = if ($finalFailed) { 'final-state.ps1 调用失败，终态未判定（保守记 error）' }
    elseif ($final -and $final.reason) { $final.reason }
    elseif ($state -eq 'blocked') { 'worker 自述受阻（result.json status=blocked）' }
    else { "CLI exit $exitCode" }
}
if ($usageRow) {
  $taskTokens = [int]$usageRow.input_tokens + [int]$usageRow.output_tokens
  $prev = Read-JsonFile (Join-Path $agentDir 'status.json')
  $prevTokens = $prev.tokens
  $status.tokens = @{ task = $taskTokens; session = $(if ($prevTokens.session) { $prevTokens.session + $taskTokens } else { $taskTokens }); day = $(if ($prevTokens.day) { $prevTokens.day + $taskTokens } else { $taskTokens }) }
}
$status | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $agentDir 'status.json') -Encoding UTF8

# 事件留痕（G0）：终态。completed = 健康交付；failure.detected = 失败**或自述受阻**。
# 判据与 status.json 同源（$state / $final），不另立一套口径 —— 否则又是两处真相。
if ($state -eq 'idle') {
  Write-BusEvent 'task.completed' $TaskId "exit $exitCode" @{ state = $state }
} else {
  $evReason = if ($status.last_error) { $status.last_error } else { "派单失败（exit $exitCode，state=$state）" }
  # 带 `state` 字段：否则事件流里 blocked（自述受阻）与 error（真失败）**不可分**
  Write-BusEvent 'failure.detected' $TaskId $evReason @{ state = $state }
}

# G4：声明了风险 → 生成验证任务书（**只准备材料，不自动派发**）。
# 它是后续动作而非闸门（「无可用验证者」已在派单前挡掉），故失败只打印、不改派单结果。
if ($verifyLevel -and $verifyMinLevel) {
  Write-VerifyBrief $TaskId $Agent $verifyMinLevel
}

"`n## 任务 $TaskId（$Agent 派单，exit $exitCode）" | Add-Content (Join-Path $agentDir 'transcript.md')
# 脱敏（公开仓库纪律，2026-09-29 起；2026-09-30 补上这道口子）：
# worker stdout 里**经常**带本机绝对路径（例如它自报的 `child session: C:\Users\<名>\…\sessions\<id>`），
# 直接追加就把维护者目录结构写进了**入库文件** —— 归档 transcript 里实测漏了 3 处。
# 在**落盘前**统一把 $env:USERPROFILE 换成 %USERPROFILE% 占位（正反斜杠两种形态都收），
# 否则下次派单一跑就会把真实路径写回来（与 scan-agents.ps1 的 binPath 脱敏同一教训）。
$userHome = $env:USERPROFILE
$scrub = {
  param($line)
  if ([string]::IsNullOrEmpty($userHome)) { return $line }
  $out = $line -replace [regex]::Escape($userHome), '%USERPROFILE%'
  return $out -replace [regex]::Escape($userHome.Replace('\', '/')), '%USERPROFILE%'
}
Get-Content $outFile | ForEach-Object { & $scrub $_ } | Add-Content (Join-Path $agentDir 'transcript.md')

Write-Host "[dispatch] $TaskId -> $Agent 完成，exit $exitCode，输出：$outFile"
exit $exitCode
