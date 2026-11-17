$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
}
"@

[void][WinProbe]::SetProcessDpiAwarenessContext([IntPtr](-4))
$proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output 'no DSH window'; exit 0 }
$hwnd = $proc.MainWindowHandle
$style = [int64][WinProbe]::GetWindowLongPtr($hwnd, -16)
$ex = [int64][WinProbe]::GetWindowLongPtr($hwnd, -20)
$r = New-Object WinProbe+RECT
[void][WinProbe]::GetWindowRect($hwnd, [ref]$r)
Write-Output ("hwnd={0} title={1}" -f $hwnd, [WinProbe]::Title($hwnd))
Write-Output ("rect={0},{1} {2}x{3} zoomed={4} iconic={5}" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top), [WinProbe]::IsZoomed($hwnd), [WinProbe]::IsIconic($hwnd))
Write-Output ("style=0x{0:x8} exstyle=0x{1:x8}" -f $style, $ex)
$flags = @(
  @{ name = 'WS_CAPTION'; value = 0x00C00000 },
  @{ name = 'WS_SYSMENU'; value = 0x00080000 },
  @{ name = 'WS_MINIMIZEBOX'; value = 0x00020000 },
  @{ name = 'WS_MAXIMIZEBOX'; value = 0x00010000 },
  @{ name = 'WS_THICKFRAME'; value = 0x00040000 },
  @{ name = 'WS_BORDER'; value = 0x00800000 }
)
foreach ($f in $flags) {
  $on = (($style -band $f.value) -eq $f.value)
  Write-Output ("  {0} = {1}" -f $f.name, $on)
}
Write-Output ("screen={0}x{1}" -f [WinProbe]::GetSystemMetrics(0), [WinProbe]::GetSystemMetrics(1))