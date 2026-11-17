param([int]$Vk = 27)
# Press and release a virtual key (27 = Esc, 13 = Enter) against whatever has focus.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RgKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
[RgKey]::keybd_event([byte]$Vk, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[RgKey]::keybd_event([byte]$Vk, 0, 2, [UIntPtr]::Zero)