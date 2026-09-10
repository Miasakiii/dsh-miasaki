# apply-presets.ps1 — 从 agent.base.cordis.yml 模板生成三个 agent preset。
#
# 做法：把模板里的 __PERSONA__ 占位符替换为各自的 <id>.persona.txt，
# 写入 ~/.dsh/.agent-presets/<id>/agent.cordis.yml，并重写同目录 preset.yml。
# 维护材料与脚本同居本目录：改 *.persona.txt / *.preset.yml 后重跑即可。
#
# ── 2026-09-10 重写（DSH 0.1.5-rc.1）────────────────────────────────────────
# 旧脚本在"已安装的旧底座"上做 persona 文本锚点替换。0.1.5 把 persona 拆成
# prefix + suffix（`prefix` 变必填、旧 `text` 字段已不存在），锚点必然失配 ——
# 三个 preset 会直接加载失败。现改为**从模板整体生成**：
#   * 幂等，不依赖底座措辞，不再有"锚点找不到"的失败模式；
#   * 底座升级时：用新版
#     node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml
#     覆盖本目录的 agent.base.cordis.yml，再把本仓库自定义合并回去
#     （模板内已就地注释标注自定义项：agentOptions ×2、tool-web fetch）。
#   * 用户侧 ~/.dsh/.agent-presets/<id>/ 从此是**生成产物，不要再手改** ——
#     手改会在下次重跑时丢失。
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$root = Join-Path $env:USERPROFILE '.dsh\.agent-presets'
$ids = @('whale', 'kurumi', 'inverse')
$utf8 = [System.Text.UTF8Encoding]::new($false)

$templatePath = Join-Path $src 'agent.base.cordis.yml'
if (-not (Test-Path $templatePath)) { throw "template not found: $templatePath" }
$template = [System.IO.File]::ReadAllText($templatePath) -replace "`r`n", "`n"

# 占位符连缩进一起匹配，替换为同样带 6 空格缩进的人设正文（YAML 块标量）。
$anchor = '      __PERSONA__'
if (-not $template.Contains($anchor)) { throw "persona placeholder not found in $templatePath" }

foreach ($id in $ids) {
  $personaPath = Join-Path $src "$id.persona.txt"
  if (-not (Test-Path $personaPath)) { throw "persona not found: $personaPath" }
  $persona = ([System.IO.File]::ReadAllText($personaPath) -replace "`r`n", "`n").TrimEnd("`n")
  $indented = ($persona -split "`n" | ForEach-Object { if ($_.Length -eq 0) { '' } else { '      ' + $_ } }) -join "`n"

  $dir = Join-Path $root $id
  New-Item -ItemType Directory -Force $dir | Out-Null

  $agentPath = Join-Path $dir 'agent.cordis.yml'
  # 覆盖前留一份 .bak：用户侧从此是生成产物，但万一有手改可据此找回。
  if (Test-Path $agentPath) { Copy-Item $agentPath "$agentPath.bak" -Force }
  [System.IO.File]::WriteAllText($agentPath, $template.Replace($anchor, $indented), $utf8)

  $presetSrc = Join-Path $src "$id.preset.yml"
  if (-not (Test-Path $presetSrc)) { throw "preset.yml not found: $presetSrc" }
  [System.IO.File]::WriteAllText(
    (Join-Path $dir 'preset.yml'),
    [System.IO.File]::ReadAllText($presetSrc), $utf8)

  Write-Host ("[{0}] agent.cordis.yml {1} bytes; preset.yml written" -f $id, (Get-Item $agentPath).Length)
}
Write-Host 'apply-presets.ps1 done — 三个 preset 已从模板重建'
