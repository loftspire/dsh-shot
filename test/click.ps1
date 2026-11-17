param([int]$X = 600, [int]$Y = 400, [int]$Settle = 350)

Add-Type -Namespace ClickNative -Name Mouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
'@

[ClickNative.Mouse]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds $Settle
[ClickNative.Mouse]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[ClickNative.Mouse]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 250
Write-Output "click at $X,$Y"