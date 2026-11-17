param(
  [int]$Delay = 1500,
  [int]$X1 = 600,
  [int]$Y1 = 400,
  [int]$X2 = 1500,
  [int]$Y2 = 1000
)

Add-Type -Namespace DragNative -Name Mouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
'@

Start-Sleep -Milliseconds $Delay
$DOWN = 0x0002
$UP = 0x0004

[DragNative.Mouse]::SetCursorPos($X1, $Y1) | Out-Null
Start-Sleep -Milliseconds 120
[DragNative.Mouse]::mouse_event($DOWN, 0, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 80

$steps = 12
for ($i = 1; $i -le $steps; $i++) {
  $x = [int]($X1 + (($X2 - $X1) * $i / $steps))
  $y = [int]($Y1 + (($Y2 - $Y1) * $i / $steps))
  [DragNative.Mouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 25
}

Start-Sleep -Milliseconds 80
[DragNative.Mouse]::mouse_event($UP, 0, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
Write-Output "drag done"