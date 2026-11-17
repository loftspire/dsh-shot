param([int]$X = 900, [int]$Y = 700, [int]$Settle = 220)
# Right-click at a physical pixel: the overlay treats it as Esc (step back, then cancel).
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RgRClick {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
[void][RgRClick]::SetProcessDpiAwarenessContext([IntPtr](-4))
[void][RgRClick]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 120
[RgRClick]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[RgRClick]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds $Settle