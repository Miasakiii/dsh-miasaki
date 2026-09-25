# deploy-local.ps1 — 把 dist 构建产物同步到「非用户目录」的可用安装位置
#
# 为什么需要它:本机对「用户可写目录」(桌面 / 文档 / %LOCALAPPDATA% / 仓库内的 dist)
# 下的 exe 一律降权到 **Low 完整性级别**;低权进程写不了
# %LOCALAPPDATA%\com.miasaki.desktop\EBWebView,WebView2 环境就建不起来
# → 现象是「桌宠出来了、主界面永不出现」+ 原生「Miasaki · 启动失败」弹窗。
# 降权由**路径**触发,换文件名 / 换签名 / 换副本都没用(2026-09-25 实测,见 README §启动失败排查)。
# 因此 dist\Miasaki.exe 在本机只能当构建产物,**不能当入口**;可双击的版本必须在系统目录。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-local.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-local.ps1 -FixShortcuts
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-local.ps1 -Force -FixShortcuts
#
# 参数:
#   -Source  <dir>  构建产物目录,默认 <desktop 线>\dist
#   -Target  <dir>  安装目录,默认 C:\ProgramData\MiasakiApp
#   -Force          自动结束正跑着目标 exe 的实例(否则文件被锁,复制失败)
#   -FixShortcuts   把桌面上仍指向用户目录的 Miasaki 快捷方式改指向 -Target
[CmdletBinding()]
param(
  # 注意：**不要在 param 默认值里用 `$PSScriptRoot`** —— 用 `-File` 调用时该变量在
  # 参数绑定阶段还是空的（2026-09-25 实测：`npm run deploy` 直接报
  # "Cannot bind argument to parameter 'Path' because it is an empty string"，
  # 必须显式传 -Source 才能跑）。改为在脚本体内解析。
  [string]$Source,
  [string]$Target = 'C:\ProgramData\MiasakiApp',
  [switch]$Force,
  [switch]$FixShortcuts
)

$ErrorActionPreference = 'Stop'
if (-not $Source) { $Source = Join-Path $PSScriptRoot '..\dist' }
$pass = 0; $fail = 0

function Check($name, $ok, $detail = '') {
  $suffix = if ($detail) { " -> $detail" } else { '' }
  if ($ok) { $script:pass++; Write-Host "PASS  $name$suffix" }
  else { $script:fail++; Write-Host "FAIL  $name$suffix" }
}

function Note($msg) { Write-Host "      $msg" }

# ---------- 0. 路径归一 ----------
$Source = (Resolve-Path -LiteralPath $Source -ErrorAction Stop).Path
$Target = [System.IO.Path]::GetFullPath($Target)
$srcExe = Join-Path $Source 'Miasaki.exe'
$srcUi = Join-Path $Source 'ui'
$dstExe = Join-Path $Target 'Miasaki.exe'

Write-Host "源(构建产物): $Source"
Write-Host "目标(安装位置): $Target"
Write-Host ""

# ---------- 1. 前置检查 ----------
if (-not (Test-Path -LiteralPath $srcExe)) {
  Write-Host "abort: 未找到 $srcExe(先跑 npm run build / cargo build --release)"
  exit 1
}
Check '构建产物存在' $true 'Miasaki.exe'
Check 'ui 资源存在' (Test-Path (Join-Path $srcUi 'loading.html')) 'ui\loading.html'

# ---------- 2. 目标 exe 是否被运行中的实例占用 ----------
# 判据精准到「跑的就是 $dstExe」:跑在别处的 Miasaki(旧副本/构建目录)不挡路,
# 只有目标位置的那个实例会锁住文件、让覆盖失败。
$running = @(Get-Process -Name 'Miasaki' -ErrorAction SilentlyContinue)
$blocking = @($running | Where-Object {
    $p = try { $_.Path } catch { $null }
    $p -and ([string]::Equals([System.IO.Path]::GetFullPath($p), $dstExe, 'OrdinalIgnoreCase'))
  })
if ($blocking.Count -gt 0) {
  if ($Force) {
    $blocking | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    $left = @(Get-Process -Name 'Miasaki' -ErrorAction SilentlyContinue | Where-Object {
        $p = try { $_.Path } catch { $null }
        $p -and ([string]::Equals([System.IO.Path]::GetFullPath($p), $dstExe, 'OrdinalIgnoreCase'))
      })
    Check '结束占用实例(-Force)' ($left.Count -eq 0) $(if ($left.Count -eq 0) { "已结束 PID $($blocking.Id -join ',')" } else { "仍存活 PID $($left.Id -join ',')" })
  } else {
    Check '目标 exe 未被占用' $false "PID $($blocking.Id -join ',') 正跑着 $dstExe —— 加 -Force 自动结束,或先关掉应用再跑"
    Write-Host ""
    Write-Host "abort: exe 被占用,复制会失败"
    exit 1
  }
} else {
  $elsewhere = @($running | Where-Object { $_.Path } | ForEach-Object { $_.Path }) -join '; '
  Check '目标 exe 未被占用' $true $(if ($elsewhere) { "另有实例跑在别处(不影响): $elsewhere" } else { '' })
}

# ---------- 3. 建目标目录 ----------
if (-not (Test-Path -LiteralPath $Target)) {
  try {
    New-Item -ItemType Directory -Path $Target -Force -ErrorAction Stop | Out-Null
  } catch {
    Check '目标目录可写' $false "$Target 建不出来: $($_.Exception.Message.Split('.')[0])"
    Write-Host ""
    Write-Host "abort: 无法创建安装目录(需要管理员权限?或改用 -Target 指向可写目录)"
    exit 1
  }
}
Check '目标目录可写' (Test-Path -LiteralPath $Target)

# ---------- 4. 复制(exe 覆盖 + ui 镜像) ----------
try {
  Copy-Item -LiteralPath $srcExe -Destination $dstExe -Force -ErrorAction Stop
  Check 'Miasaki.exe 已覆盖' $true
} catch {
  Check 'Miasaki.exe 已覆盖' $false $_.Exception.Message.Split('.')[0]
  Write-Host ""
  Write-Host "abort: 复制失败(exe 被其它进程占用?磁盘空间不足?)"
  exit 1
}
# ui 用 robocopy /MIR:旧帧/旧图标不会残留在安装目录(退出码 0-7 视为成功)
$null = robocopy $srcUi (Join-Path $Target 'ui') /MIR /R:1 /W:1 /NJH /NJS /NDL /NP
$rcRobo = $LASTEXITCODE          # 0-7 视为成功(1=有文件被复制,0=无变化);>=8 才是错误
$global:LASTEXITCODE = 0         # robocopy 的码不能漏成整个脚本的退出码
Check 'ui 资源镜像(robocopy)' ($rcRobo -lt 8) "robocopy 退出码 $rcRobo"

# ---------- 5. 校验 ----------
$srcHash = (Get-FileHash -LiteralPath $srcExe -Algorithm SHA256).Hash
$dstHash = (Get-FileHash -LiteralPath $dstExe -Algorithm SHA256).Hash
Check 'exe 哈希一致' ($srcHash -eq $dstHash) $dstHash.Substring(0, 16)
Check '安装目录 loading.html 就位' (Test-Path (Join-Path $Target 'ui\loading.html'))

# ---------- 6. 桌面快捷方式修复(可选) ----------
if ($FixShortcuts) {
  $shell = New-Object -ComObject WScript.Shell
  $desktops = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory')) |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
  $fixed = 0
  foreach ($d in $desktops) {
    foreach ($lnk in (Get-ChildItem -LiteralPath $d -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
      if ($lnk.Name -notmatch 'miasaki') { continue }
      try {
        $sc = $shell.CreateShortcut($lnk.FullName)
        $tp = $sc.TargetPath
        if ($tp -and $tp -match 'Miasaki\.exe$' -and $tp -ne $dstExe) {
          $sc.TargetPath = $dstExe
          $sc.WorkingDirectory = $Target
          $sc.Save()
          $fixed++
          Note "改指向: $($lnk.Name)  $tp -> $dstExe"
        }
      } catch { Note "跳过 $($lnk.Name): $($_.Exception.Message)" }
    }
  }
  Check '快捷方式已在系统目录' $true "修正 $fixed 个"
}

# ---------- 7. 结果 ----------
Write-Host ""
Write-Host "== 部署结果:$pass 通过 / $fail 失败 =="
if ($fail -eq 0) {
  Write-Host "下一步:双击桌面「Miasaki 桌面端」快捷方式验证(它应指向 $dstExe)。"
  Write-Host "提醒:不要直接双击 $srcExe —— 用户可写目录下的 exe 在本机必被降权,主界面起不来。"
  if (-not $FixShortcuts) { Write-Host "如需一并修正桌面旧快捷方式:加 -FixShortcuts 重跑。" }
}
if ($fail -gt 0) { exit 1 }
exit 0
