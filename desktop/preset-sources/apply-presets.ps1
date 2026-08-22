# apply-presets.ps1 — 将三份 persona 注入 ~/.dsh/.agent-presets/<id>/agent.cordis.yml,并重写 preset.yml
# 维护材料与脚本同居本目录:改 *.persona.txt / *.preset.yml 后重跑即可(标准底座升级时先在
# 已安装预设目录做一次 standard diff,避免覆盖用户侧后续修改)。
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$root = Join-Path $env:USERPROFILE '.dsh\.agent-presets'
$ids = @('whale', 'kurumi', 'inverse')
$oldText = "text: >-`n      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}."
$utf8 = [System.Text.UTF8Encoding]::new($false)

foreach ($id in $ids) {
  # —— persona 注入 ——
  $agent = Join-Path $root "$id\agent.cordis.yml"
  $t = [System.IO.File]::ReadAllText($agent) -replace "`r`n", "`n"
  if (-not $t.Contains($oldText)) { throw "persona anchor not found in $agent" }
  $persona = [System.IO.File]::ReadAllText((Join-Path $src "$id.persona.txt")) -replace "`r`n", "`n"
  $indented = ($persona -split "`n" | ForEach-Object { if ($_.Length -eq 0) { '' } else { '      ' + $_ } }) -join "`n"
  $newText = "text: >-" + "`n" + $indented
  $t = $t.Replace($oldText, $newText)
  [System.IO.File]::WriteAllText($agent, $t, $utf8)

  # —— preset.yml 重写 ——
  $preset = Join-Path $root "$id\preset.yml"
  $p = [System.IO.File]::ReadAllText((Join-Path $src "$id.preset.yml"))
  [System.IO.File]::WriteAllText($preset, $p, $utf8)
  Write-Host "[$id] injected persona ($((Get-Item $agent).Length) bytes); preset.yml written"
}
Write-Host 'apply.ps1 done'
