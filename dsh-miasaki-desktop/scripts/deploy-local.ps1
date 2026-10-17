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
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-local.ps1 -ProbeOnly   # 只看判定,不改动
#
# 参数:
#   -Source  <dir>  构建产物目录,默认 <desktop 线>\dist
#   -Target  <dir>  安装目录,默认 C:\ProgramData\MiasakiApp
#   -Force          自动结束正跑着目标 exe 的实例(否则文件被锁,复制失败)
#   -FixShortcuts   把桌面上仍指向用户目录的 Miasaki 快捷方式改指向 -Target
#   -ProbeOnly      只打印「自宿主防护」判定并退出(0=安全 / 1=正从 miasaki 内部运行),
#                   不做任何复制、不结束任何进程;排查部署链时先跑它。
#
# 自宿主防护(2026-10-17,两次「莫名闪退」事故的补丁):
#   `-Force` 会 Stop-Process 结束「正跑着目标 exe 的实例」。如果这条命令是从
#   miasaki 桌面端自己的会话里发出的,那个实例就是**宿主壳本身** —— 壳的
#   KILL_ON_JOB_CLOSE Job 会立刻回收后端与**本脚本自身**,复制永远走不到;
#   用户看到的是「窗口莫名闪退 + 部署未生效」。脚本因此在结束任何进程**之前**
#   探测本进程的祖先链:命中则直接 abort,并指路外部终端。-ProbeOnly 复用同一判据。
[CmdletBinding()]
param(
  # 注意：**不要在 param 默认值里用 `$PSScriptRoot`** —— 用 `-File` 调用时该变量在
  # 参数绑定阶段还是空的（2026-09-25 实测：`npm run deploy` 直接报
  # "Cannot bind argument to parameter 'Path' because it is an empty string"，
  # 必须显式传 -Source 才能跑）。改为在脚本体内解析。
  [string]$Source,
  [string]$Target = 'C:\ProgramData\MiasakiApp',
  [switch]$Force,
  [switch]$FixShortcuts,
  [switch]$ProbeOnly
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

# ---------- 0b. 自宿主防护（2026-10-17 两次「莫名闪退」事故） ----------
# 事故链：agent 在 miasaki 桌面端自己的会话里执行本脚本的 -Force → Stop-Process 杀掉
# 「正跑着目标 exe 的实例」= 宿主壳 → 壳的 KILL_ON_JOB_CLOSE Job 立刻回收后端与
# **本脚本自身** → 复制永远走不到。用户看到两次「窗口莫名闪退」，而安装目录的 exe
# 仍是旧版（部署未生效）。判据：本进程的祖先链里出现 $blocking 的某个 PID ⇒ 必自杀。
# 因此这里把「占用判定」提前：探针模式与真实部署共用同一份判据。
function Get-AncestorPids {
  # 一次拉全表再内存回溯（逐层 Get-CimInstance 会慢一个量级）；WMI 不可用时返回
  # 只含自己的链 —— 调用方按「无法判定 ⇒ 不阻断」处理（外部终端部署是常态场景）。
  $table = @{}
  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
      $table[[int]$_.ProcessId] = [int]$_.ParentProcessId
    }
  } catch {}
  $ids = New-Object System.Collections.Generic.List[int]
  $cur = $PID
  $guard = 0
  while ($cur -gt 0 -and -not $ids.Contains($cur) -and $guard -lt 64) {
    $ids.Add($cur)
    if (-not $table.ContainsKey($cur)) { break }
    $cur = $table[$cur]
    $guard++
  }
  return $ids
}

# 目标 exe 是否被运行中的实例占用。判据精准到「跑的就是 $dstExe」：
# 跑在别处的 Miasaki（旧副本 / 构建目录）不挡路，也不参与自宿主判定。
$running = @(Get-Process -Name 'Miasaki' -ErrorAction SilentlyContinue)
$blocking = @($running | Where-Object {
    $p = try { $_.Path } catch { $null }
    $p -and ([string]::Equals([System.IO.Path]::GetFullPath($p), $dstExe, 'OrdinalIgnoreCase'))
  })
$selfHost = @()
if ($blocking.Count -gt 0) {
  $ancestors = Get-AncestorPids
  $selfHost = @($blocking | Where-Object { $ancestors.Contains($_.Id) })
}

if ($ProbeOnly) {
  Write-Host "=== 部署自宿主探针（-ProbeOnly：只判定，不做任何改动）==="
  Write-Host "目标安装位置 : $dstExe"
  if ($selfHost.Count -gt 0) {
    Write-Host "判定         : SELF-HOST（本进程运行在目标 Miasaki 实例自己的会话里）"
    Write-Host "自宿主 PID   : $($selfHost.Id -join ', ')"
    Write-Host "结论         : -Force 会杀掉宿主并连带杀死本脚本，部署必然中断。"
    Write-Host "               请改在【外部终端】运行，或先托盘退出 Miasaki。"
    exit 1
  }
  if ($blocking.Count -gt 0) {
    Write-Host "判定         : SAFE（目标实例在跑，但不在本进程的祖先链里）"
    Write-Host "目标实例 PID : $($blocking.Id -join ', ')"
    Write-Host "结论         : 从外部终端 -Force 部署安全；结束该实例是预期行为。"
    exit 0
  }
  Write-Host "判定         : SAFE（没有正在运行的目标实例）"
  exit 0
}

if ($selfHost.Count -gt 0) {
  Write-Host ""
  Write-Host "abort: 检测到本次部署运行在 Miasaki 桌面端自己的会话里（宿主机 PID $($selfHost.Id -join ', ')）。"
  Write-Host "       -Force 会先结束这个宿主，然后本脚本随壳的 Job 一起被回收 —— 复制永远无法完成。"
  Write-Host "       2026-10-17 连续两次「窗口莫名闪退、部署却未生效」正是这条路径。"
  Write-Host ""
  Write-Host "       改在【外部终端】执行（Windows Terminal / VSCode / 官方 DSH 桌面端），"
  Write-Host "       或先在托盘退出 Miasaki 后重跑。自检：加 -ProbeOnly 只打印判定、不改动任何东西。"
  Write-Host ""
  exit 1
}

# ---------- 1. 前置检查 ----------
if (-not (Test-Path -LiteralPath $srcExe)) {
  Write-Host "abort: 未找到 $srcExe(先跑 npm run build / cargo build --release)"
  exit 1
}
Check '构建产物存在' $true 'Miasaki.exe'
Check 'ui 资源存在' (Test-Path (Join-Path $srcUi 'loading.html')) 'ui\loading.html'

# ---------- 1b. 启动片头素材（2026-10-05，design/2026-10-04-boot-intro-video.md §4）----------
# 为什么必须显式检查：片头缺失**不会报错**——壳侧 boot_intro 判据是「配置里 intro 的枚举值」，
# 素材在不在要到浏览器发 Range 请求才暴露。缺失时的真实表现是「静默退化成 S4a 纹章层」：
# 启动照常、动画照旧、只是片头不播 ⇒ 用户只会以为「设置没生效」。
# 因此素材缺在**部署这一步**就必须拦住，而不是留给实机目检。
$introDir = Join-Path $srcUi 'intro'
$introClips = @('brand', 'cyberpunk', 'awakening', 'startup', 'dreamsea', 'lagoon', 'bubbles')
$introMissing = @($introClips | Where-Object { -not (Test-Path (Join-Path $introDir "intro-$_.mp4")) })
if ($introMissing.Count -gt 0) {
  Write-Host "abort: 启动片头素材缺失 $($introMissing -join ', ')（ui\intro\）。"
  Write-Host '       跑 node scripts\extract-intro-clips.mjs 重新入库；若确认不再启用片头，'
  Write-Host '       把外观设置「启动片头」设为「关闭」并重启 dsh web。'
  exit 1
}
Check '启动片头素材齐备(7 段)' $true 'ui\intro\intro-{brand,cyberpunk,awakening,startup,dreamsea,lagoon,bubbles}.mp4'

# ---------- 2. 目标 exe 是否被运行中的实例占用 ----------
# 占用判定已提前到 0b（自宿主防护复用同一份 $running/$blocking）。
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
# 部署后**再验一次**素材到位：/MIR 只保证「不残留旧文件」，不保证「新文件被带上」
# （源目录缺 ⇒ 目标目录照样绿，这正是片头会静默消失的那条缝）。
$dstIntroMissing = @($introClips | Where-Object { -not (Test-Path (Join-Path $Target "ui\intro\intro-$_.mp4")) })
Check '安装目录片头素材就位' ($dstIntroMissing.Count -eq 0) `
  $(if ($dstIntroMissing.Count -eq 0) { '7 段' } else { "缺 $($dstIntroMissing -join ',')" })

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
