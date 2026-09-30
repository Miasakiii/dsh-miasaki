# final-state.ps1 — 派单终态判定（K4，2026-09-30 引入）
#
# 为什么单独成文件（而不是写在 dispatch-task.ps1 里）：
#   ① 判据需要**可测**——PowerShell 侧的判定过去没有测试，只有人跑一次才知道对不对；
#   ② 判据需要**单点**——status.json 的 state 会被 fleet-monitor 面板与桌宠消费，
#      语义散成两份必然漂移。
#
# 修的是什么（回归矩阵台账 K4 / 内部计划静默失效 #24）：
#   派单器过去把「CLI exit 0」直接当作「健康空闲」：
#       $state = if ($exitCode -eq 0) { 'idle' } else { 'error' }
#   于是**自述受阻**的 worker 被记成「健康空闲」，面板与桌宠照常显示正常 ——
#   失败形态是「一切看起来都好」。
#
# 判据（不引入新约定、不解析 stdout 自由文本）：
#   worker 自述受阻的载体就是**交付契约本身** —— `tasks/<taskId>/result.json`
#   的 `status` 字段（schemas/result.schema.json：completed | blocked | failed）：
#     · status=blocked 且 exit 0  ⇒ state=blocked（CLI 没报错，但 worker 说自己卡住了）
#     · status=failed  且 exit 0  ⇒ state=error
#     · 其余                       ⇒ 沿用 exit code 语义（0 → idle / 非 0 → error）
#
# 用法（**同进程调用**，非子进程，故不受受限沙箱的管道限制）：
#   $final = (& (Join-Path $PSScriptRoot 'final-state.ps1') -ExitCode $exitCode -ResultPath $rp) | ConvertFrom-Json
#   $final.state / $final.reason
#
# stdout 只输出一行 JSON；`-OutFile` 同时落盘同一份 JSON ——
# 后者是给测试用的：受限沙箱下捕获子进程管道会 EPERM，测试改用 stdio:'ignore' + 读文件。

param(
  [Parameter(Mandatory = $true)][int]$ExitCode,
  [string]$ResultPath,
  [string]$OutFile
)

$state = if ($ExitCode -eq 0) { 'idle' } else { 'error' }
$reason = $null
$source = 'exit-code'

if ($ResultPath -and (Test-Path $ResultPath)) {
  $r = $null
  try { $r = Get-Content $ResultPath -Raw | ConvertFrom-Json } catch { $r = $null }
  if ($null -ne $r -and $null -ne $r.status) {
    $blockers = @()
    if ($r.blockers) { $blockers = @($r.blockers | Where-Object { $_ }) }
    $why = if ($blockers.Count -gt 0) { $blockers -join '；' } else { '（交付契约未说明卡在哪）' }
    if ($r.status -eq 'blocked' -and $ExitCode -eq 0) {
      $state = 'blocked'; $reason = $why; $source = 'result.json:blocked'
    } elseif ($r.status -eq 'failed' -and $ExitCode -eq 0) {
      $state = 'error'; $reason = $why; $source = 'result.json:failed'
    } elseif ($r.status -eq 'blocked' -or $r.status -eq 'failed') {
      # CLI 也失败了：exit code 已是 error，但把交付契约里的原因一并带出（更有信息量）
      $state = 'error'; $reason = $why; $source = "exit-code+result.json:$($r.status)"
    }
  }
}

$payload = @{ state = $state; reason = $reason; source = $source } | ConvertTo-Json -Compress
if ($OutFile) { Set-Content -Path $OutFile -Value $payload -Encoding UTF8 }
Write-Output $payload
