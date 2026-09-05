# smoke-test.ps1 — Miasaki 冒烟测试(用户机执行)
# 校验:进程启动 / 桌宠窗口存在 / 素材加载(帧) / 主窗口依赖(WebView2/3080)
# 用法:powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
$ErrorActionPreference = 'Stop'
$dist = Join-Path $PSScriptRoot '..\..\dist'
$exe = Join-Path $dist 'Miasaki.exe'
$pass = 0; $fail = 0

function Check($name, $ok, $detail = '') {
  $suffix = if ($detail) { " -> $detail" } else { '' }
  if ($ok) { $script:pass++; Write-Host "PASS  $name$suffix" }
  else { $script:fail++; Write-Host "FAIL  $name$suffix" }
}

# ---------- 0. 前置检查 ----------
Check '交付物存在' (Test-Path $exe)
Check 'ui 打包完整' (Test-Path (Join-Path $dist 'ui\loading.html'))
Check 'pets 素材完整' (
  (Test-Path (Join-Path $dist 'ui\pets\frames.json')) -and
  (Test-Path (Join-Path $dist 'ui\pets\bubbles.png')) -and
  (Test-Path (Join-Path $dist 'ui\pets\kurumi\frames')) -and
  (Test-Path (Join-Path $dist 'ui\pets\whale\states\idle-00.png')) -and  # v2:idle 帧序列
  (Test-Path (Join-Path $dist 'ui\pets\inverse\states\idle.png'))
)
Check 'DSH 3080 端口' ((Test-NetConnection -ComputerName 127.0.0.1 -Port 3080 -WarningAction SilentlyContinue -InformationLevel Quiet))

# ---------- 0b. 启动失败三用例预检(TODO P1,WARN 不计入 fail:环境相关,仅提示) ----------
function Warn($name, $ok, $detail = '') {
  $suffix = if ($detail) { " -> $detail" } else { '' }
  if ($ok) { Write-Host "WARN  $name$suffix" }
  else { Write-Host "OK    $name(无异常)$suffix" }
}
function Test-PortTcp([string]$HostName, [int]$port, [int]$ms = 800) {
  # 跨平台 TCP 探针(.NET Sockets,Windows/Linux pwsh 通用;替代 Test-NetConnection)
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $r = $c.BeginConnect($HostName, $port, $null, $null)
    return $r.AsyncWaitHandle.WaitOne($ms)
  } catch { return $false } finally { $c.Close() }
}
# 用例A:dsh 未安装(恢复页"检查 dsh"同口径)
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
$dshVer = if ($dshCmd) { try { (dsh --version 2>$null | Out-String).Trim().Split("`n")[0] } catch { '版本探测失败' } } else { $null }
Warn '用例A:dsh 未安装' (-not $dshCmd) $dshVer
# 用例B:端口被占用(TCP 通但 HTTP 非 DSH 指纹 → 恢复页"端口被占用"分支)
$tcpOpen = Test-PortTcp '127.0.0.1' 3080
$httpHint = ''
if ($tcpOpen) {
  try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    $httpHint = "HTTP $($resp.StatusCode)"
  } catch { $httpHint = "TCP 通但 HTTP 异常($($_.Exception.Message.Split('.')[0]))" }
}
Warn '用例B:3080 被非 DSH 占用' ($tcpOpen -and $httpHint -notmatch '^HTTP 200') $httpHint
# 用例C:单实例冲突(已有 Miasaki.exe 在跑 → 二次启动被接管,属预期行为,提示即可)
$dupes = @(Get-Process -Name 'Miasaki', 'miasaki' -ErrorAction SilentlyContinue)
Warn '用例C:已有实例在运行' ($dupes.Count -gt 0) $(if ($dupes.Count -gt 0) { "PID $($dupes.Id -join ',')" } else { '' })

# ---------- 1. 启动冒烟 ----------
if (-not (Test-Path $exe)) {
  Write-Host "abort: $exe 不存在"
  exit 1
}
$before = if (Test-Path "$env:LOCALAPPDATA\miasaki\pet.log") { (Get-Content "$env:LOCALAPPDATA\miasaki\pet.log").Count } else { 0 }
$proc = Start-Process $exe -PassThru
Start-Sleep -Seconds 12

$alive = -not $proc.HasExited
Check '进程存活(12s)' $alive
if (-not $alive) {
  Write-Host "abort: 应用启动即退出(闪退或环境依赖失败)"
  exit 1
}

# 桌宠窗口(类名 MiasakiPetWin)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SmokeEnum {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
}
"@
$petFound = $false; $petRect = $null
$cb = [SmokeEnum+EnumWindowsProc]{
  param($h, $lp)
  $winPid = 0
  [SmokeEnum]::GetWindowThreadProcessId($h, [ref]$winPid) | Out-Null
  if ($winPid -eq $proc.Id) {
    $csb = New-Object System.Text.StringBuilder 128
    [SmokeEnum]::GetClassName($h, $csb, 128) | Out-Null
    if ($csb.ToString() -eq 'MiasakiPetWin') {
      $r = New-Object SmokeEnum+RECT
      [SmokeEnum]::GetWindowRect($h, [ref]$r) | Out-Null
      $script:petFound = $true
      $script:petRect = "$($r.Right-$r.Left)x$($r.Bottom-$r.Top)"
    }
  }
  return $true
}
[SmokeEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
Check '桌宠窗口存在' $petFound $petRect

# 桌宠帧加载(pet.log 新增 tick0 / set_mode 记录)
Start-Sleep -Seconds 2
$pl = "$env:LOCALAPPDATA\miasaki\pet.log"
if (Test-Path $pl) {
  $after = (Get-Content $pl).Count
  $newLines = Get-Content $pl | Select-Object -Skip $before
  Check 'pet.log 有启动记录' ($after -gt $before)
  Check '素材加载(帧计数>0)' ($newLines -join "`n" -match 'buf_nonzero=[1-9]')
} else {
  Check 'pet.log 有启动记录' $false '未找到日志'
}

# ---------- 2. 清理 ----------
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "== 冒烟结果:$pass 通过 / $fail 失败 =="
if ($fail -gt 0) { exit 1 }
