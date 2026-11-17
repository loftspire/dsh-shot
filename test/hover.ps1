param([int]$X = 600, [int]$Y = 400)
# Move the real pointer to a physical pixel so the overlay's hover-snap can be exercised.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RgHover {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
[void][RgHover]::SetProcessDpiAwarenessContext([IntPtr](-4))
[void][RgHover]::SetCursorPos($X, $Y)