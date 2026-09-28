# install.ps1 — 把 @miasaki/dsh-computer-use 装进某个 dsh profile（幂等）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile cu-test
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile miasaki
#
# 做两件事：
#   ① junction：profile/node_modules/@miasaki/dsh-computer-use → 本插件目录（link 安装）
#   ② junction：bundle 的 bare import 依赖（@deepseek-ai/dsh-llm|tools|attachment|brand、zod、koffi）
#      直链全局 dsh 树（%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules）——
#      **同物理文件 = 单实例**，避开 pnpm 副本与 host 双实例。
#      schemastery/cosmokit 若 profile 已有 pnpm 副本则跳过（现役插件在用，保持现状）。
#
# 回滚：删掉这些 junction 即可（本脚本不写 profile 的 cordis.patch.yml；装载本体另走 --patch 或并入）。

param(
    [Parameter(Mandatory = $true)][string]$Profile
)

$ErrorActionPreference = 'Stop'
$pluginRoot = $PSScriptRoot
$globalDsh = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules'
$profileNm = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules"

if (-not (Test-Path $globalDsh)) { throw "全局 dsh 树不存在：$globalDsh（先确认 @deepseek-ai/dsh 已安装）" }
New-Item -ItemType Directory -Force -Path $profileNm | Out-Null

function Link-Junction([string]$LinkPath, [string]$TargetDir) {
    if (-not (Test-Path $TargetDir)) { Write-Warning "跳过（目标不存在）：$TargetDir"; return }
    if (Test-Path $LinkPath) {
        $item = Get-Item $LinkPath -Force
        if ($item.LinkType -eq 'Junction') { Write-Host "已存在 junction：$LinkPath"; return }
        throw "已存在非 junction 条目：$LinkPath（请先人工确认）"
    }
    $parent = Split-Path $LinkPath -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    New-Item -ItemType Junction -Path $LinkPath -Target $TargetDir | Out-Null
    Write-Host "已创建 junction：$LinkPath -> $TargetDir"
}

# ① 插件自身（link 安装）
Link-Junction (Join-Path $profileNm '@miasaki\dsh-computer-use') $pluginRoot

# ② bundle 的 bare import 从**插件 lib 的 realpath**（本目录）向上解析（ESM 解析基点，probe 实证：
#    junction 回购 profile 不解决——load 后 realpath 落在仓内，profile 的 node_modules 不在链上）。
#    故依赖 junction 建在插件自身 node_modules 下：同物理文件 = 单实例，避开 pnpm 副本双实例。
#    （profile 侧 junctions 一并保留：loader 的 internal.import(name, baseUrl) 以 profile 为 parent，
#     两条解析路径都覆盖。）
$pluginNm = Join-Path $pluginRoot 'node_modules'
New-Item -ItemType Directory -Force -Path $pluginNm | Out-Null
foreach ($p in 'dsh-llm', 'dsh-tools', 'dsh-attachment', 'dsh-brand', 'schemastery', 'cosmokit') {
    Link-Junction (Join-Path $pluginNm "@deepseek-ai\$p") (Join-Path $globalDsh "@deepseek-ai\$p")
}
foreach ($p in 'zod', 'koffi') {
    Link-Junction (Join-Path $pluginNm $p) (Join-Path $globalDsh $p)
}

# ③ profile 侧 junctions（loader internal.import 的 baseUrl parent 路径；与 ② 同目标）
foreach ($p in 'dsh-llm', 'dsh-tools', 'dsh-attachment', 'dsh-brand') {
    Link-Junction (Join-Path $profileNm "@deepseek-ai\$p") (Join-Path $globalDsh "@deepseek-ai\$p")
}
foreach ($p in 'zod', 'koffi') {
    Link-Junction (Join-Path $profileNm $p) (Join-Path $globalDsh $p)
}

# ④ schemastery/cosmokit：profile 已有（pnpm 副本）则跳过；插件侧 ② 已直链（保 import 链单实例优先）
foreach ($p in 'schemastery', 'cosmokit') {
    $existing = Join-Path $profileNm "@deepseek-ai\$p"
    if (Test-Path $existing) { Write-Host "跳过（profile 已有）：$p" }
    else { Link-Junction $existing (Join-Path $globalDsh "@deepseek-ai\$p") }
}

Write-Host "完成。验证：dsh --profile $Profile --patch $pluginRoot\cordis.patch.yml"
