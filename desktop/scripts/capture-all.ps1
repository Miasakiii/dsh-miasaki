# capture-all.ps1 — 枚举 miasaki 进程全部顶层窗口并分别截图(DPI 感知修正版)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Win32All {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
}
"@
[Win32All]::SetProcessDPIAware() | Out-Null

$targetPid = (Get-Process miasaki -ErrorAction SilentlyContinue | Select-Object -First 1).Id
if (-not $targetPid) { Write-Error 'miasaki not running'; exit 1 }

$found = [System.Collections.Generic.List[object]]::new()
$cb = [Win32All+EnumWindowsProc]{
  param($h, $lp)
  $winPid = 0
  [Win32All]::GetWindowThreadProcessId($h, [ref]$winPid) | Out-Null
  if ($winPid -eq $targetPid) {
    $sb = New-Object System.Text.StringBuilder 256
    [Win32All]::GetWindowTextW($h, $sb, 256) | Out-Null
    $csb = New-Object System.Text.StringBuilder 256
    [Win32All]::GetClassNameW($h, $csb, 256) | Out-Null
    $r = New-Object Win32All+RECT
    [Win32All]::GetWindowRect($h, [ref]$r) | Out-Null
    $vis = [Win32All]::IsWindowVisible($h)
    $found.Add([pscustomobject]@{ Hwnd=$h; Title=$sb.ToString(); Class=$csb.ToString(); X=$r.Left; Y=$r.Top; W=$($r.Right-$r.Left); H=$($r.Bottom-$r.Top); Visible=$vis })
  }
  return $true
}
[Win32All]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

$outDir = 'C:\Users\Asakii\Desktop\dsh-miasaki\desktop\scripts\diag'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
foreach ($w in $found) {
  Write-Host ("HWND={0} title='{1}' class={2} rect=({3},{4}) {5}x{6} visible={7}" -f $w.Hwnd,$w.Title,$w.Class,$w.X,$w.Y,$w.W,$w.H,$w.Visible)
  if ($w.W -le 0 -or $w.H -le 0 -or -not $w.Visible) { continue }
  $bmp = New-Object System.Drawing.Bitmap($w.W, $w.H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($w.X, $w.Y, 0, 0, (New-Object System.Drawing.Size($w.W, $w.H)))
  $safe = ($w.Title -replace '[^a-zA-Z0-9_-]', '_')
  $name = "{0}_{1}_{2}x{3}.png" -f $w.Class, $safe, $w.W, $w.H
  $bmp.Save((Join-Path $outDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "  -> $name"
}
