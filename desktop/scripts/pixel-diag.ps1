# 像素诊断：采样主窗口背景色 + 宠物窗口角落透明度
param([string]$Out = 'diag.png')
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinEnum4 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
$targets = Get-Process miasaki -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }
$wins = New-Object System.Collections.Generic.List[object]
$cb = { param($h, $l)
  $pid2 = 0; [WinEnum4]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($targets -contains $pid2 -and [WinEnum4]::IsWindowVisible($h)) {
    $r = New-Object WinEnum4+RECT; [WinEnum4]::GetWindowRect($h, [ref]$r) | Out-Null
    if (($r.R-$r.L) -gt 50) { $wins.Add(@{ h=$h; r=$r; w=($r.R-$r.L); hh=($r.B-$r.T) }) }
  }
  return $true
}
[WinEnum4]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

function Sample($x, $y, $bmp) {
  $c = $bmp.GetPixel($x, $y)
  return '({0},{1},{2})' -f $c.R, $c.G, $c.B
}

foreach ($w in $wins) {
  $bmp = New-Object System.Drawing.Bitmap($w.w, $w.hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($w.r.L, $w.r.T, 0, 0, (New-Object System.Drawing.Size($w.w, $w.hh)))
  if ($w.w -gt 1000) {
    Write-Host "=== MAIN ${($w.w)}x$($w.hh) ==="
    Write-Host ("  bg(300,300)=" + (Sample 300 300 $bmp) + " bg(600,60)=" + (Sample 600 60 $bmp) + " bg(60,500)=" + (Sample 60 500 $bmp))
    Write-Host ("  corner(20,20)=" + (Sample 20 20 $bmp) + " corner(1100,700)=" + (Sample 1100 700 $bmp))
  } else {
    Write-Host "=== PET ${($w.w)}x$($w.hh) ==="
    Write-Host ("  corner(5,5)=" + (Sample 5 5 $bmp) + " corner(235,5)=" + (Sample 235 5 $bmp) + " corner(5,345)=" + (Sample 5 345 $bmp) + " corner(235,345)=" + (Sample 235 345 $bmp))
    Write-Host ("  center(120,150)=" + (Sample 120 150 $bmp) + " sprite(120,300)=" + (Sample 120 300 $bmp))
  }
  $g.Dispose(); $bmp.Dispose()
}
