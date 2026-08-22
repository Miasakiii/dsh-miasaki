# gen-bubbles.ps1 — 生成桌宠气泡精灵表（预渲染，运行时零 GDI 字体调用）
# 背景：Windows 11 下 GDI 字体在多线程（WebView2 + 桌宠线程）并发使用时存在已知的堆损坏
# 问题，CreateFontW/DrawTextW 会确定性崩溃（gdi32full!CreateFontW+0xA3, 0xC0000005）。
# 因此气泡文本改为构建期用 System.Drawing（GDI+）预渲染成位图精灵表，
# 运行时只做纯像素叠加，彻底绕开 GDI 字体。
#
# 用法: powershell -File scripts/gen-bubbles.ps1
# 输出: ui/pets/bubbles.png （240x56 x 17 帧，横向排布）
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
    '选好了吗？', '别让我等太久', '（冷笑）', '效率。现在。', '你的时间，归我支配', '（眯起赤瞳）'
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
