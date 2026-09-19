# gen-bubbles.ps1 — 生成桌宠气泡精灵表（预渲染，运行时零 GDI 字体调用）
# 背景：Windows 11 下 GDI 字体在多线程（WebView2 + 桌宠线程）并发使用时存在已知的堆损坏
# 问题，CreateFontW/DrawTextW 会确定性崩溃（gdi32full!CreateFontW+0xA3, 0xC0000005）。
# 因此气泡文本改为构建期用 System.Drawing（GDI+）预渲染成位图精灵表，
# 运行时只做纯像素叠加，彻底绕开 GDI 字体。
#
# 用法: powershell -File scripts/gen-bubbles.ps1
# 输出: ui/pets/bubbles.png （240x56 x 22 帧，横向排布：17 台词 + 5 状态帧）
#       ui/pets/approval.png（240x84，R5 审批气泡：提问 + 「拒绝/允许一次」两按钮）
#
# 注意: 台词池必须与 src/pet_native.rs 的 quote_pool 保持完全一致，
#       修改文案后必须重新运行本脚本生成。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# ---- 与 pet_native.rs quote_pool 一致的台词池（索引=帧序） ----
$quotes = @(
    # whale (0..4)
    '咕噜咕噜…', '（吐泡泡）', '呜~ 我在听', '今天的代码也拜托了', '（摇尾巴）',
    # kurumi (5..10)
    'ふふふ…', '啊啦，你来了呢', '时间，可是很宝贵的哦', '刻刻帝在看着你', '（轻笑）', '今晚的时间也归我哦',
    # inverse (11..16)
    '选好了吗？', '别让我等太久', '（冷笑）', '效率。现在。', '你的时间，归我支配', '（眯起赤瞳）',
    # 状态帧(v2026-08-30,17..19): 桌宠反映总指挥工作动态
    '忙碌中…', '等待审批', '需要你的批准',
    # 状态帧(v3 M2 2026-09-12,20..21): 六态新增 Error/Done
    '出错了', '完成了'
)

# ---- 几何:与 pet_native.rs 原 draw_bubble/draw_text 等像素一致的布局 ----
$frameW = 240   # 帧宽(含边距)
$frameH = 56    # 帧高
$bubbleX = 15   # 气泡矩形在帧内的 x
$bubbleY = 4    # 气泡矩形在帧内的 y
$bubbleW = 210
$bubbleH = 48
$radius = 14
$textX = $bubbleX + 16
$textY = $bubbleY + 4
$textW = $bubbleW - 32
$textH = $bubbleH - 8
$textColor = [System.Drawing.Color]::FromArgb(255, 240, 222, 228)  # 原 SetTextColor(0x00E4DEF0) -> RGB(240,222,228)
$bubbleColor = [System.Drawing.Color]::FromArgb(215, 38, 32, 44)    # 原 0xAARRGGBB = A215 R38 G32 B44
$fontName = 'Microsoft YaHei'

$out = Join-Path $PSScriptRoot '..\ui\pets\bubbles.png'
$sheet = New-Object System.Drawing.Bitmap ($frameW * $quotes.Count), $frameH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.Clear([System.Drawing.Color]::Transparent)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

for ($i = 0; $i -lt $quotes.Count; $i++) {
    $x = $i * $frameW
    # 圆角气泡
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [float]$radius
    $path.AddArc($x + $bubbleX, $bubbleY, $r * 2, $r * 2, 180, 90)
    $path.AddArc($x + $bubbleX + $bubbleW - $r * 2, $bubbleY, $r * 2, $r * 2, 270, 90)
    $path.AddArc($x + $bubbleX + $bubbleW - $r * 2, $bubbleY + $bubbleH - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc($x + $bubbleX, $bubbleY + $bubbleH - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $brush = New-Object System.Drawing.SolidBrush $bubbleColor
    $g.FillPath($brush, $path)
    $brush.Dispose()
    $path.Dispose()

    # 文本:自适应字号(最长不超过气泡内容宽),垂直居中、左对齐
    $size = 17.0
    $text = $quotes[$i]
    $font = New-Object System.Drawing.Font $fontName, $size, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    while ($size -gt 11) {
        $w = $g.MeasureString($text, $font).Width
        if ($w -le $textW) { break }
        $size -= 0.5
        $font.Dispose()
        $font = New-Object System.Drawing.Font $fontName, $size, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    }
    $fmt = [System.Drawing.StringFormat]::GenericTypographic
    $fmt.Alignment = [System.Drawing.StringAlignment]::Near
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $fmt.Trimming = [System.Drawing.StringTrimming]::None
    $fmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
    $rect = New-Object System.Drawing.RectangleF ($x + $textX), ($textY + 2), $textW, ($textH - 6)
    $brush2 = New-Object System.Drawing.SolidBrush $textColor
    $g.DrawString($text, $font, $brush2, $rect, $fmt)
    $brush2.Dispose()
    $font.Dispose()
    $fmt.Dispose()
    Write-Host ("frame {0,2}: '{1}' font={2}" -f $i, $text, $size)
}

$g.Dispose()
$sheet.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose()
Write-Host "saved: $out ($(Get-Item $out).Length bytes)"

# ============================================================================
# R5(2026-09-16, design/pet-reference-benchmark.md R5)：**审批气泡**（含两个按钮）
# 240x84：上半为提问气泡，下半为「拒绝 / 同意」两个按钮。
# 运行时按固定矩形做命中判定（不新增 GDI 对象、不调用任何字体 API），
# 点击后经 eval 派发决策事件给 dsh-pet-panel → 官方 PendingApproval.answer()。
# 注：**工具名不进位图**（运行时排版 = 调 GDI 字体 = 踩 CreateFontW 崩溃区），
#     工具名仍经 hash pettool= 上报，留给未来的组合帧/DirectWrite 方案。
# ============================================================================
$apW = 240; $apH = 84
$btnW = 92; $btnH = 26; $btnY = 54
$denyX = 24; $allowX = 124   # 24+92=116，与 124 之间留 8px 间隙（防误触，roadmap M3.2 红线）
$apOut = Join-Path $PSScriptRoot '..\ui\pets\approval.png'
$ap = New-Object System.Drawing.Bitmap $apW, $apH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$ag = [System.Drawing.Graphics]::FromImage($ap)
$ag.Clear([System.Drawing.Color]::Transparent)
$ag.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$ag.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# —— 提问气泡（与普通气泡同几何：帧内 15,4,210,48）——
$apPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = [float]$radius
$apPath.AddArc($bubbleX, $bubbleY, $r * 2, $r * 2, 180, 90)
$apPath.AddArc($bubbleX + $bubbleW - $r * 2, $bubbleY, $r * 2, $r * 2, 270, 90)
$apPath.AddArc($bubbleX + $bubbleW - $r * 2, $bubbleY + $bubbleH - $r * 2, $r * 2, $r * 2, 0, 90)
$apPath.AddArc($bubbleX, $bubbleY + $bubbleH - $r * 2, $r * 2, $r * 2, 90, 90)
$apPath.CloseFigure()
$apBrush = New-Object System.Drawing.SolidBrush $bubbleColor
$ag.FillPath($apBrush, $apPath)
$apBrush.Dispose()
$apPath.Dispose()

# 文案（居中）
$apText = '允许这次工具调用吗？'
$apFont = New-Object System.Drawing.Font $fontName, 16.0, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$apFmt = [System.Drawing.StringFormat]::GenericTypographic
$apFmt.Alignment = [System.Drawing.StringAlignment]::Center
$apFmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$apFmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
$apTextRect = New-Object System.Drawing.RectangleF ([float]($bubbleX + 8)), ([float]$bubbleY), ([float]($bubbleW - 16)), ([float]$bubbleH)
$apTextBrush = New-Object System.Drawing.SolidBrush $textColor
$ag.DrawString($apText, $apFont, $apTextBrush, $apTextRect, $apFmt)
$apTextBrush.Dispose(); $apFont.Dispose(); $apFmt.Dispose()

# —— 两个按钮（圆角 8；拒绝=暗色描边底，同意=鎏金实心）——
function New-RoundPath([int]$x, [int]$y, [int]$w, [int]$h, [float]$rad) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $rad * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}
$btnFont = New-Object System.Drawing.Font $fontName, 14.0, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$btnFmt = [System.Drawing.StringFormat]::GenericTypographic
$btnFmt.Alignment = [System.Drawing.StringAlignment]::Center
$btnFmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$btnFmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap

$denyFill = [System.Drawing.Color]::FromArgb(235, 62, 56, 70)
$denyText = [System.Drawing.Color]::FromArgb(255, 232, 226, 216)
$allowFill = [System.Drawing.Color]::FromArgb(235, 176, 138, 74)
$allowText = [System.Drawing.Color]::FromArgb(255, 28, 24, 34)

$bp1 = New-RoundPath $denyX $btnY $btnW $btnH 8.0
$bb1 = New-Object System.Drawing.SolidBrush $denyFill
$ag.FillPath($bb1, $bp1); $bb1.Dispose(); $bp1.Dispose()
$bt1 = New-Object System.Drawing.SolidBrush $denyText
$ag.DrawString('拒绝', $btnFont, $bt1, (New-Object System.Drawing.RectangleF ([float]$denyX), ([float]$btnY), ([float]$btnW), ([float]$btnH)), $btnFmt)
$bt1.Dispose()

$bp2 = New-RoundPath $allowX $btnY $btnW $btnH 8.0
$bb2 = New-Object System.Drawing.SolidBrush $allowFill
$ag.FillPath($bb2, $bp2); $bb2.Dispose(); $bp2.Dispose()
$bt2 = New-Object System.Drawing.SolidBrush $allowText
$ag.DrawString('允许一次', $btnFont, $bt2, (New-Object System.Drawing.RectangleF ([float]$allowX), ([float]$btnY), ([float]$btnW), ([float]$btnH)), $btnFmt)
$bt2.Dispose()

$btnFont.Dispose(); $btnFmt.Dispose()
$ag.Dispose()
$ap.Save($apOut, [System.Drawing.Imaging.ImageFormat]::Png)
$ap.Dispose()
Write-Host "saved: $apOut ($(Get-Item $apOut).Length bytes)"
