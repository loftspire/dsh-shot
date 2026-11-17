param([int]$X = 400, [int]$Y = 220, [int]$W = 1400, [int]$H = 900, [switch]$Maximize)
# Put the DSH window in a known state. DPI awareness matters: without it Windows treats the
# numbers as logical pixels and the window lands 1.5x larger than asked.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RgGeom {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
[void][RgGeom]::SetProcessDpiAwarenessContext([IntPtr](-4))
$proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output 'no-window'; exit 1 }
if ($Maximize) {
  [void][RgGeom]::ShowWindow($proc.MainWindowHandle, 3)
} else {
  [void][RgGeom]::ShowWindow($proc.MainWindowHandle, 9)
  Start-Sleep -Milliseconds 250
  [void][RgGeom]::SetWindowPos($proc.MainWindowHandle, [IntPtr](-2), $X, $Y, $W, $H, 0x0034)
}
Start-Sleep -Milliseconds 350
Write-Output 'ok'