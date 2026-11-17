param(
  [Parameter(Mandatory = $true)][string]$Image,
  [string]$Out = ""
)
$ErrorActionPreference = 'Stop'

# Per-monitor-v2 must be declared before WPF loads, otherwise WPF latches the
# process DPI awareness and every coordinate we read is a 150%-scaled DIP.
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ShotNative {
  public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static int[] Monitors() {
    var list = new List<int>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr m, IntPtr hdc, ref RECT r, IntPtr d) {
      list.Add(r.Left); list.Add(r.Top); list.Add(r.Right); list.Add(r.Bottom);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
}
"@
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ShotWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  public static List<IntPtr> TopLevel() {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr p) { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(320); GetWindowTextW(h, sb, 320); return sb.ToString(); }
  public static string ClassName(IntPtr h) { StringBuilder sb = new StringBuilder(320); GetClassNameW(h, sb, 320); return sb.ToString(); }
  public static bool Bounds(IntPtr h, out RECT r) {
    r = new RECT();
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0) {
      if ((r.Right - r.Left) > 0 && (r.Bottom - r.Top) > 0) { return true; }
    }
    if (!GetWindowRect(h, out r)) { return false; }
    return (r.Right - r.Left) > 0 && (r.Bottom - r.Top) > 0;
  }
}
"@
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ShotState {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@

[void][ShotNative]::SetProcessDpiAwarenessContext([IntPtr](-4))

if ($env:OVERLAY_TRACE -eq '1') { Set-PSDebug -Trace 1 }
$script:logPath = Join-Path $env:TEMP 'overlay-v2.log'
function Write-Diag([string] $Text) {
  try {
    $elapsed = 0
    if ($null -ne $script:bootWatch) { $elapsed = $script:bootWatch.ElapsedMilliseconds }
    [System.IO.File]::AppendAllText($script:logPath, ("[+$elapsed ms] " + $Text + [Environment]::NewLine), [System.Text.Encoding]::UTF8)
  } catch { }
}
function Set-PointerCursor($cursor) {
  try { [System.Windows.Input.Mouse]::OverrideCursor = $cursor } catch { }
}

function Reset-PointerCursor() {
  try { [System.Windows.Input.Mouse]::OverrideCursor = $null } catch { }
}

trap {
  Write-Diag ('POS ' + $_.InvocationInfo.PositionMessage)
  $inner = $_.Exception
  while ($null -ne $inner) {
    Write-Diag ('INNER ' + $inner.GetType().FullName + ': ' + $inner.Message)
    $inner = $inner.InnerException
  }
  Write-Diag ('TRAP ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message)
  Write-Diag ([string]$_.ScriptStackTrace)
  Write-Diag ((Get-PSCallStack | ForEach-Object { $_.ToString() }) -join ' | ')
  Reset-PointerCursor
  exit 1
}
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing, System.Windows.Forms
# Windows can hand the fresh overlay a stray pointer event (the window appears under a
# cursor that was already pressed somewhere else). Ignore input for the first moments so
# the overlay never closes itself or jumps into edit mode before the user touches it.
$script:bootWatch = [System.Diagnostics.Stopwatch]::StartNew()

# The host starts this process the moment the user clicks the camera, before the frozen
# screenshot has finished being written, so PowerShell startup and WPF assembly loading
# overlap the capture instead of queueing behind it. Wait for a complete file: the image
# appears as soon as GDI starts writing, so require two stable sizes before reading it.
$imageDeadline = 8000
$lastSize = -1
while ($true) {
  if (Test-Path -LiteralPath $Image) {
    $size = -1
    try { $size = (Get-Item -LiteralPath $Image).Length } catch { $size = -1 }
    if ($size -gt 0 -and $size -eq $lastSize) { break }
    $lastSize = $size
  }
  if ($script:bootWatch.ElapsedMilliseconds -gt $imageDeadline) {
    Write-Output '{"cancelled":true,"reason":"no-image"}'
    exit 0
  }
  Start-Sleep -Milliseconds 25
}

$MARK = [System.Windows.Media.Color]::FromRgb(244, 63, 94)
$MARK_BRUSH = New-Object System.Windows.Media.SolidColorBrush($MARK)
$BG = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(150, 6, 10, 18))
$FONT = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI')

$full = [System.Drawing.Image]::FromFile($Image)
$source = New-Object System.Windows.Media.Imaging.BitmapImage
$source.BeginInit()
$source.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$source.UriSource = New-Object System.Uri($Image)
$source.EndInit()
$full.Dispose()

$monitors = [ShotNative]::Monitors()
$script:snapTargets = New-Object System.Collections.ArrayList
try {
  $selfPid = [uint32]$PID
  $skipCls = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow', 'ForegroundStaging', 'CEF-OSC-WIDGET')
  $skipTitle = @('桌面', 'Program Manager', 'NVIDIA GeForce Overlay', 'Microsoft Text Input Application')
  foreach ($h in [ShotWin]::TopLevel()) {
    try {
      if (-not [ShotWin]::IsWindowVisible($h)) { continue }
      if ($skipCls -contains [ShotWin]::ClassName($h)) { continue }
      $titleText = [ShotWin]::Title($h)
      if ($skipTitle -contains $titleText) { continue }
      if ([ShotState]::IsIconic($h)) { continue }
      $owner = [uint32]0
      [void][ShotWin]::GetWindowThreadProcessId($h, [ref]$owner)
      if ($owner -eq $selfPid) { continue }
      $wr = New-Object ShotWin+RECT
      if (-not [ShotWin]::Bounds($h, [ref]$wr)) { continue }
      $rw = $wr.Right - $wr.Left
      $rh = $wr.Bottom - $wr.Top
      if ($rw -lt 80 -or $rh -lt 60) { continue }
      [void]$script:snapTargets.Add(@{ x = $wr.Left; y = $wr.Top; w = $rw; h = $rh; title = $titleText; cls = [ShotWin]::ClassName($h) })
    } catch { }
  }
} catch { }
Write-Diag ('TARGETS ' + $script:snapTargets.Count)

if ($monitors.Length -eq 0) { Write-Output '{"cancelled":true,"reason":"no-monitor"}'; exit 0 }


function New-T4([object[]] $Parts) {
  if ($null -eq $Parts -or $Parts.Count -lt 4) {
    while ($null -eq $Parts -or $Parts.Count -lt 4) { $Parts = @($Parts) + 0 }
  }
  return (New-Object System.Windows.Thickness -ArgumentList ([double]$Parts[0]), ([double]$Parts[1]), ([double]$Parts[2]), ([double]$Parts[3]))
}
$script:windows = New-Object System.Collections.ArrayList
$script:start = $null
$script:active = $null        # window info hashtable of the monitor being used
$script:phase = 'select'      # select -> edit
$script:tool = 'move'        # 'move' = select/move/resize; nothing armed by default
$script:dragMode = $null     # 'move' | 'resize' while the selection is being dragged
$script:handle = $null       # which of the eight handles is being dragged
$script:p0 = $null
$script:rectStart = $null
$script:items = New-Object System.Collections.ArrayList
$script:draft = $null
$script:cancelled = $false
$script:rect = $null          # DIP rect on the active window
$script:hoverRect = $null     # frame the pointer is hovering over; only a click locks it
$script:hoverLogged = ''

function Close-All {
  Reset-PointerCursor
  foreach ($w in $script:windows) { try { $w.Close() } catch { } }
}

function Round-Dip($v, $step) {
  if ($step -le 0) { return $v }
  return [Math]::Round($v / $step) * $step
}

function Format-Rect($r) {
  if ($null -eq $r) { return 'null' }
  return ('{0},{1},{2}x{3}' -f [int]$r.x, [int]$r.y, [int]$r.w, [int]$r.h)
}

function Sync-View($info) {
  try {
    $g = $info.veil.Parent
    if (($null -ne $g) -and ($g.ActualWidth -gt 1) -and ($g.ActualHeight -gt 1)) {
      $info.viewWidth = $g.ActualWidth
      $info.viewHeight = $g.ActualHeight
      $info.factor = $info.width / $g.ActualWidth
    }
  } catch { }
}

function Update-Shade {
  param($info)
  Sync-View $info
  $sel = $info.rect
  if ($null -eq $sel) {
    $info.shadeAll.Visibility = 'Visible'
    if ($null -ne $info.veil) { $info.veil.Visibility = 'Collapsed' }
    foreach ($s in @($info.shadeTop, $info.shadeBottom, $info.shadeLeft, $info.shadeRight)) { $s.Visibility = 'Collapsed' }
    # The hover preview sets a rect on every mouse move and clears it when the pointer
    # leaves the window. Without collapsing the outline here the dashed border stays
    # painted where it was last drawn (looks like a leftover frame on the desktop).
    $info.sel.Visibility = 'Collapsed'
    $info.annot.Clip = $null
    return
  }
  $info.shadeAll.Visibility = 'Collapsed'
  # Snap the rect to whole device pixels and let the four shades overlap by one DIP:
  # abutting translucent borders otherwise leave a one-pixel bright seam that runs
  # across the whole screen at the top and bottom edge of the selection.
  $step = 1 / $info.factor
  $sel = @{
    x = (Round-Dip $sel.x $step)
    y = (Round-Dip $sel.y $step)
    w = (Round-Dip $sel.w $step)
    h = (Round-Dip $sel.h $step)
  }
  $vw = $info.viewWidth
  $vh = $info.viewHeight

  $vw = $info.viewWidth
  $vh = $info.viewHeight
  if ($vw -le 1) { $vw = $info.width }
  if ($vh -le 1) { $vh = $info.height }

  foreach ($s in @($info.shadeTop, $info.shadeBottom, $info.shadeLeft, $info.shadeRight)) { $s.Visibility = 'Collapsed' }

  $outer = New-Object System.Windows.Media.RectangleGeometry((New-Object System.Windows.Rect(0, 0, $vw, $vh)))
  $hole = New-Object System.Windows.Media.RectangleGeometry((New-Object System.Windows.Rect($sel.x, $sel.y, $sel.w, $sel.h)))
  $info.veil.Data = New-Object System.Windows.Media.CombinedGeometry([System.Windows.Media.GeometryCombineMode]::Exclude, $outer, $hole)
  $info.veil.Visibility = 'Visible'

  $info.sel.Visibility = 'Visible'
  $info.sel.Margin = New-T4 (($sel.x), ($sel.y), (0), (0))
  $info.sel.Width = $sel.w
  $info.sel.Height = $sel.h
  $info.annot.Clip = New-Object System.Windows.Media.RectangleGeometry((New-Object System.Windows.Rect($sel.x, $sel.y, $sel.w, $sel.h)))
}

function Place-Toolbar {
  param($info)
  if ($null -eq $info.rect) { $info.bar.Visibility = 'Collapsed'; return }
  $sel = $info.rect
  $barW = 356
  $x = $sel.x + ($sel.w - $barW) / 2
  if ($x -lt 8) { $x = 8 }
  if ($x + $barW -gt $info.viewWidth - 8) { $x = [Math]::Max(8, $info.viewWidth - $barW - 8) }
  $y = $sel.y + $sel.h + 12
  if ($y + 44 -gt $info.viewHeight - 8) { $y = [Math]::Max(8, $sel.y - 56) }
  $info.bar.HorizontalAlignment = 'Left'
  $info.bar.VerticalAlignment = 'Top'
  $info.bar.Margin = New-T4 (($x), ($y), (0), (0))
  $info.bar.Visibility = 'Visible'
}

function Set-SnapVisual($w, $rect) {
  try {
    if ($null -eq $rect) { $w.snap.Visibility = 'Collapsed'; return }
    $w.snap.Margin = New-T4 (($rect.x), ($rect.y), (0), (0))
    $w.snap.Width = $rect.w
    $w.snap.Height = $rect.h
    $w.snap.Visibility = 'Visible'
  } catch { }
}

function Find-Snap($w, $p) {
  try {
    $px = $w.left + $p.X * $w.factor
    $py = $w.top + $p.Y * $w.factor
    foreach ($t in $script:snapTargets) {
      if (($px -lt $t.x) -or ($px -gt ($t.x + $t.w)) -or ($py -lt $t.y) -or ($py -gt ($t.y + $t.h))) { continue }
      # The Windows desktop itself is an ApplicationFrameWindow that covers the whole monitor.
      # Snapping to it would frame the entire screen whenever the pointer sits on empty desktop,
      # which is never what hovering a window means; every other window stays snappable.
      if (($t.cls -eq 'ApplicationFrameWindow') -and (($t.w * $t.h) -ge (0.9 * $w.width * $w.height))) { continue }
      $sx = [Math]::Max($t.x, $w.left)
      $sy = [Math]::Max($t.y, $w.top)
      $ex = [Math]::Min(($t.x + $t.w), ($w.left + $w.width))
      $ey = [Math]::Min(($t.y + $t.h), ($w.top + $w.height))
      $cw = $ex - $sx
      $ch = $ey - $sy
      if ($cw -lt 8 -or $ch -lt 8) { continue }
      # snapTargets is in Z order (top first), so the first containing window is the one the
      # user actually sees; anything further down is hidden behind it.
      return @{ x = (($sx - $w.left) / $w.factor); y = (($sy - $w.top) / $w.factor); w = ($cw / $w.factor); h = ($ch / $w.factor); title = $t.title }
    }
    return $null
  } catch { }
  return $null
}

# Escape and right click share one cancel path: leave edit mode, then close the whole overlay.
function Invoke-Escape() {
  try {
    $w0 = $script:active
    if ($script:phase -eq 'edit') {
      if ($null -ne $w0) {
        $script:items.Clear()
        $w0.annot.Children.Clear()
        $script:phase = 'select'
        $w0.rect = $null
        $script:rect = $null
        $w0.bar.Visibility = 'Collapsed'
        $w0.label.Visibility = 'Collapsed'
        $w0.hint.Visibility = 'Visible'
        Update-Shade $w0
        Update-Handles $w0
        Write-Diag 'ESC select'
      }
      return
    }
    $script:cancelled = $true
    Write-Diag 'ESC cancel'
    Close-All
  } catch {
    Write-Diag ('ESC ' + $_.Exception.Message)
    $script:cancelled = $true
    Close-All
  }
}

function Update-ArrowHead($head, $x1, $y1, $x2, $y2) {
  try {
    if ($null -eq $head) { return }
    $dx = $x2 - $x1
    $dy = $y2 - $y1
    $len = [Math]::Sqrt($dx * $dx + $dy * $dy)
    if ($len -lt 3) { return }
    $ux = $dx / $len
    $uy = $dy / $len
    $size = 14
    $wing = 8
    $bx = $x2 - $ux * $size
    $by = $y2 - $uy * $size
    $nx = -$uy
    $ny = $ux
    $head.Points.Clear()
    [void]$head.Points.Add((New-Object System.Windows.Point($x2, $y2)))
    [void]$head.Points.Add((New-Object System.Windows.Point(($bx + $nx * $wing), ($by + $ny * $wing))))
    [void]$head.Points.Add((New-Object System.Windows.Point(($bx - $nx * $wing), ($by - $ny * $wing))))
  } catch { }
}

function Get-HandleAt($w, $p) {
  try {
    $r = $w.rect
    if ($null -eq $r) { return $null }
    $t = 12
    if (($p.X -lt ($r.x - $t)) -or ($p.X -gt ($r.x + $r.w + $t)) -or ($p.Y -lt ($r.y - $t)) -or ($p.Y -gt ($r.y + $r.h + $t))) { return $null }
    $nearL = [Math]::Abs($p.X - $r.x) -le $t
    $nearR = [Math]::Abs($p.X - ($r.x + $r.w)) -le $t
    $nearT = [Math]::Abs($p.Y - $r.y) -le $t
    $nearB = [Math]::Abs($p.Y - ($r.y + $r.h)) -le $t
    if ($nearL -and $nearT) { return 'nw' }
    if ($nearR -and $nearT) { return 'ne' }
    if ($nearL -and $nearB) { return 'sw' }
    if ($nearR -and $nearB) { return 'se' }
    if ($nearT) { return 'n' }
    if ($nearB) { return 's' }
    if ($nearL) { return 'w' }
    if ($nearR) { return 'e' }
  } catch { }
  return $null
}

function Update-Handles($w) {
  try {
    if ($null -eq $w.handles) { return }
    $r = $w.rect
    if (($null -eq $r) -or ($script:phase -ne 'edit')) {
      foreach ($k in $w.handles.Keys) { $w.handles[$k].Visibility = 'Collapsed' }
      return
    }
    $half = 4.5
    $cx = $r.x + ($r.w / 2)
    $cy = $r.y + ($r.h / 2)
    $pts = @{
      nw = @($r.x, $r.y); n = @($cx, $r.y); ne = @(($r.x + $r.w), $r.y);
      e = @(($r.x + $r.w), $cy); se = @(($r.x + $r.w), ($r.y + $r.h));
      s = @($cx, ($r.y + $r.h)); sw = @($r.x, ($r.y + $r.h)); w = @($r.x, $cy)
    }
    foreach ($k in $pts.Keys) {
      $el = $w.handles[$k]
      $el.Margin = New-T4 ((($pts[$k][0]) - $half), (($pts[$k][1]) - $half), (0), (0))
      $el.Visibility = 'Visible'
    }
  } catch { }
}


foreach ($i in 0..(($monitors.Length / 4) - 1)) {
  $left = $monitors[$i * 4]
  $top = $monitors[$i * 4 + 1]
  $right = $monitors[$i * 4 + 2]
  $bottom = $monitors[$i * 4 + 3]
  $mw = $right - $left
  $mh = $bottom - $top
  if ($mw -le 0 -or $mh -le 0) { continue }

  $win = New-Object System.Windows.Window
  $win.WindowStyle = 'None'
  $win.ResizeMode = 'NoResize'
  $win.ShowInTaskbar = $false
  $win.Topmost = $true
  $win.Background = [System.Windows.Media.Brushes]::Black
  $win.Left = 0
  $win.Top = 0
  $win.Width = 320
  $win.Height = 240
  $win.Cursor = [System.Windows.Input.Cursors]::Cross

  $grid = New-Object System.Windows.Controls.Grid
  $img = New-Object System.Windows.Controls.Image
  $slice = New-Object System.Windows.Media.Imaging.CroppedBitmap
  $slice.BeginInit()
  $slice.Source = $source
  $slice.SourceRect = New-Object System.Windows.Int32Rect($left, $top, $mw, $mh)
  $slice.EndInit()
  $img.Source = $slice
  $img.Stretch = 'Fill'
  [void]$grid.Children.Add($img)

  $shadeAll = New-Object System.Windows.Controls.Border
  $shadeAll.Background = $BG
  [void]$grid.Children.Add($shadeAll)

  # One filled path with the selection cut out. Four separate translucent borders cannot tile
  # the area around a selection: a gap shows a bright seam, an overlap shows a darker line, and
  # both run all the way to the screen edges (reported as "two thin lines").
  $veil = New-Object System.Windows.Shapes.Path
  $veil.Fill = $BG
  $veil.IsHitTestVisible = $false
  $veil.Visibility = 'Collapsed'
  [void]$grid.Children.Add($veil)

  $shadeTop = New-Object System.Windows.Controls.Border
  $shadeTop.Background = $BG
  $shadeTop.HorizontalAlignment = 'Left'
  $shadeTop.VerticalAlignment = 'Top'
  $shadeTop.Visibility = 'Collapsed'
  $shadeBottom = New-Object System.Windows.Controls.Border
  $shadeBottom.Background = $BG
  $shadeBottom.HorizontalAlignment = 'Left'
  $shadeBottom.VerticalAlignment = 'Top'
  $shadeBottom.Visibility = 'Collapsed'
  $shadeLeft = New-Object System.Windows.Controls.Border
  $shadeLeft.Background = $BG
  $shadeLeft.HorizontalAlignment = 'Left'
  $shadeLeft.VerticalAlignment = 'Top'
  $shadeLeft.Visibility = 'Collapsed'
  $shadeRight = New-Object System.Windows.Controls.Border
  $shadeRight.Background = $BG
  $shadeRight.HorizontalAlignment = 'Left'
  $shadeRight.VerticalAlignment = 'Top'
  $shadeRight.Visibility = 'Collapsed'
  foreach ($s in @($shadeTop, $shadeBottom, $shadeLeft, $shadeRight)) { [void]$grid.Children.Add($s) }
  $snapEl = New-Object System.Windows.Controls.Border
  $snapEl.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 96, 165, 250))
  $snapEl.BorderThickness = New-T4 ((2))
  $snapEl.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(38, 96, 165, 250))
  $snapEl.HorizontalAlignment = 'Left'
  $snapEl.VerticalAlignment = 'Top'
  $snapEl.Visibility = 'Collapsed'
  $snapEl.IsHitTestVisible = $false
  [void]$grid.Children.Add($snapEl)

  $sel = New-Object System.Windows.Shapes.Rectangle
  $sel.Stroke = [System.Windows.Media.Brushes]::White
  $sel.StrokeThickness = 1.5
  $sel.StrokeDashArray = New-Object System.Windows.Media.DoubleCollection(2)
  $sel.StrokeDashArray.Add(6)
  $sel.StrokeDashArray.Add(4)
  $sel.Fill = [System.Windows.Media.Brushes]::Transparent
  $sel.HorizontalAlignment = 'Left'
  $sel.VerticalAlignment = 'Top'
  $sel.Visibility = 'Collapsed'
  [void]$grid.Children.Add($sel)

  # Eight handles sit on the corners and edge midpoints of the selection. They are not
  # hit-testable: the drag target is resolved from coordinates, otherwise a 9px handle
  # would swallow the pointer and start drawing an annotation instead of resizing.
  $handles = @{}
  foreach ($hname in @('nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w')) {
    $hdl = New-Object System.Windows.Shapes.Ellipse
    $hdl.Width = 9
    $hdl.Height = 9
    $hdl.Fill = [System.Windows.Media.Brushes]::White
    $hdl.Stroke = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 96, 165, 250))
    $hdl.StrokeThickness = 1.5
    $hdl.HorizontalAlignment = 'Left'
    $hdl.VerticalAlignment = 'Top'
    $hdl.IsHitTestVisible = $false
    $hdl.Visibility = 'Collapsed'
    $handles[$hname] = $hdl
    [void]$grid.Children.Add($hdl)
  }

  $annot = New-Object System.Windows.Controls.Canvas
  $annot.IsHitTestVisible = $false
  [void]$grid.Children.Add($annot)

  $label = New-Object System.Windows.Controls.Border
  $label.Background = [System.Windows.Media.Brushes]::White
  $label.CornerRadius = New-Object System.Windows.CornerRadius(4)
  $label.Padding = New-T4 ((8), (3), (8), (3))
  $label.Visibility = 'Collapsed'
  $label.HorizontalAlignment = 'Left'
  $label.VerticalAlignment = 'Top'
  $labelText = New-Object System.Windows.Controls.TextBlock
  $labelText.FontFamily = $FONT
  $labelText.FontSize = 12
  $labelText.Foreground = [System.Windows.Media.Brushes]::Black
  $label.Child = $labelText
  $label.Effect = New-Object System.Windows.Media.Effects.DropShadowEffect -Property @{ BlurRadius = 10; ShadowDepth = 2; Direction = 270; Opacity = 0.25; Color = [System.Windows.Media.Colors]::Black }
  [void]$grid.Children.Add($label)

  $hint = New-Object System.Windows.Controls.Border
  $hint.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(220, 12, 16, 24))
  $hint.CornerRadius = New-Object System.Windows.CornerRadius(16)
  $hint.Padding = New-T4 ((14), (7), (14), (7))
  $hint.HorizontalAlignment = 'Center'
  $hint.VerticalAlignment = 'Top'
  $hint.Margin = New-T4 ((0), (24), (0), (0))
  $hintText = New-Object System.Windows.Controls.TextBlock
  $hintText.Text = '拖拽框选 · 鼠标悬停窗口可整窗选中 · Esc 取消'
  $hintText.FontFamily = $FONT
  $hintText.FontSize = 13
  $hintText.Foreground = [System.Windows.Media.Brushes]::White
  $hint.Child = $hintText
  [void]$grid.Children.Add($hint)

  $bar = New-Object System.Windows.Controls.Border
  $bar.Background = [System.Windows.Media.Brushes]::White
  $bar.CornerRadius = New-Object System.Windows.CornerRadius(12)
  $bar.Padding = New-T4 ((8), (6), (8), (6))
  $bar.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 229, 231, 235))
  $bar.BorderThickness = New-T4 ((1), (1), (1), (1))
  $bar.Effect = New-Object System.Windows.Media.Effects.DropShadowEffect -Property @{ BlurRadius = 18; ShadowDepth = 3; Direction = 270; Opacity = 0.18; Color = [System.Windows.Media.Colors]::Black }
  $bar.Visibility = 'Collapsed'
  $bar.HorizontalAlignment = 'Left'
  $bar.VerticalAlignment = 'Top'

  $stack = New-Object System.Windows.Controls.StackPanel
  $stack.Orientation = 'Horizontal'

  $info = @{
    veil = $veil;
    snap = $snapEl;
    handles = $handles
    left = $left; top = $top; width = $mw; height = $mh;
    factor = 1; viewWidth = $mw; viewHeight = $mh;
    shadeAll = $shadeAll; shadeTop = $shadeTop; shadeBottom = $shadeBottom; shadeLeft = $shadeLeft; shadeRight = $shadeRight;
    sel = $sel; annot = $annot; label = $label; labelText = $labelText; hint = $hint; bar = $bar; stack = $stack;
    rect = $null; rid = [Guid]::NewGuid().ToString('N');
  }

  $toolButtons = @{}
  foreach ($toolDef in @(@('move', '移动'), @('rect', '矩形'), @('ellipse', '椭圆'), @('arrow', '箭头'), @('pen', '画笔'))) {
    $b = New-Object System.Windows.Controls.Button
    $b.Content = $toolDef[1]
    $b.FontFamily = $FONT
    $b.FontSize = 12
    $b.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 31, 41, 55))
    $b.Cursor = [System.Windows.Input.Cursors]::Hand
    $b.add_MouseEnter({ param($bs, $be) Set-PointerCursor ([System.Windows.Input.Cursors]::Hand) })
    $b.add_MouseLeave({ param($bs, $be) Set-PointerCursor ([System.Windows.Input.Cursors]::Cross) })
    $b.Padding = New-T4 ((9), (4), (9), (4))
    $b.Margin = New-T4 ((1), (0), (1), (0))
    $b.BorderThickness = New-T4 ((0))
    $b.Background = [System.Windows.Media.Brushes]::Transparent
    $name = $toolDef[0]
    $b.Tag = $name
    $toolButtons[$name] = $b
    $b.add_Click({
        param($s, $e)
  try {
        $picked = [string]$s.Tag
        Write-Diag ('TOOLCLICK ' + $picked)
        $script:tool = $picked
        foreach ($k in $toolButtons.Keys) {
          if ($k -eq $picked) { $toolButtons[$k].Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 226, 235, 250)) }
          else { $toolButtons[$k].Background = [System.Windows.Media.Brushes]::Transparent }
        }
        } catch { Write-Diag ('HANDLER ' + $_.InvocationInfo.ScriptLineNumber + ' :: ' + $_.Exception.Message); Write-Diag ([string]$_.ScriptStackTrace) }
  })
    [void]$stack.Children.Add($b)
  }
  if ($toolButtons.ContainsKey([string]$script:tool)) {
    $toolButtons[[string]$script:tool].Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 226, 235, 250))
  }

  $undo = New-Object System.Windows.Controls.Button
  $undo.Content = '撤销'
  $undo.FontFamily = $FONT
  $undo.FontSize = 12
  $undo.Padding = New-T4 ((9), (4), (9), (4))
  $undo.Margin = New-T4 ((6), (0), (6), (0))
  $undo.BorderThickness = New-T4 ((0))
  $undo.Background = [System.Windows.Media.Brushes]::Transparent
  $undo.add_Click({
      param($s, $e)
  try {
      if ($script:items.Count -eq 0) { return }
      $last = $script:items[$script:items.Count - 1]
      $last = $script:items[$script:items.Count - 1]
      if (($null -ne $last) -and ($null -ne $last.element)) { $script:active.annot.Children.Remove($last.element) }
      if (($null -ne $last) -and ($last.ContainsKey('head')) -and ($null -ne $last.head)) { $script:active.annot.Children.Remove($last.head) }
      $script:items.RemoveAt($script:items.Count - 1)
      try { $last.win.annot.Children.Remove($last.element) } catch { }
      } catch { Write-Diag ('HANDLER ' + $_.InvocationInfo.ScriptLineNumber + ' :: ' + $_.Exception.Message); Write-Diag ([string]$_.ScriptStackTrace) }
  })
  [void]$stack.Children.Add($undo)

  $cancel = New-Object System.Windows.Controls.Button
  $cancel.Content = '取消'
  $cancel.FontFamily = $FONT
  $cancel.FontSize = 12
  $cancel.Padding = New-T4 ((12), (4), (12), (4))
  $cancel.Margin = New-T4 ((2), (0), (2), (0))
  $cancel.BorderThickness = New-T4 ((0))
  $cancel.Background = [System.Windows.Media.Brushes]::Transparent
  $cancel.add_Click({
      param($s, $e)
  try {
      $script:cancelled = $true
      Close-All
      } catch { Write-Diag ('HANDLER ' + $_.InvocationInfo.ScriptLineNumber + ' :: ' + $_.Exception.Message); Write-Diag ([string]$_.ScriptStackTrace) }
  })
  [void]$stack.Children.Add($cancel)

  $confirm = New-Object System.Windows.Controls.Button
  $confirm.Content = '确认'
  $confirm.FontFamily = $FONT
  $confirm.FontSize = 12
  $confirm.Foreground = [System.Windows.Media.Brushes]::White
  $confirm.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 37, 99, 235))
  $confirm.Padding = New-T4 ((16), (4), (16), (4))
  $confirm.Margin = New-T4 ((2), (0), (0), (0))
  $confirm.BorderThickness = New-T4 ((0))
  $confirm.add_Click({
      param($s, $e)
  try {
      $script:confirmed = $true
      Close-All
      } catch { Write-Diag ('HANDLER ' + $_.InvocationInfo.ScriptLineNumber + ' :: ' + $_.Exception.Message); Write-Diag ([string]$_.ScriptStackTrace) }
  })
  [void]$stack.Children.Add($confirm)

  $bar.Child = $stack
  [void]$grid.Children.Add($bar)

  $win.Content = $grid
  $win.Tag = $info
  $grid.Tag = $info

  $grid.add_MouseLeftButtonDown({
      param($s, $e)
  try {
      if ($script:bootWatch.ElapsedMilliseconds -lt 350) { Write-Diag ('DOWN ignored (boot) src=' + $script:phase); return }
      $w = $s.Tag
      $p = $e.GetPosition($s)
      $script:active = $w
      $w.viewWidth = $s.ActualWidth
      $w.viewHeight = $s.ActualHeight
      $w.factor = $w.width / [Math]::Max(1, $s.ActualWidth)

      # The toolbar floats above the shaded area, so a press on a toolbar button used to fall
      # through to the grid, restart the selection and swallow the button's own Click.
      if (($script:phase -eq 'edit') -and $w.bar.IsMouseOver) { return }

      if ($script:phase -eq 'edit') {
        $r = $w.rect
        # A press on a handle counts as inside even when the pointer sits a pixel outside the
        # rectangle (device-pixel rounding put it there), otherwise grabbing a corner started a
        # brand new selection instead of resizing.
        $hndDown = Get-HandleAt $w $p
        $inside = ($null -ne $r) -and (($p.X -ge ($r.x - 4)) -and ($p.X -le ($r.x + $r.w + 4)) -and ($p.Y -ge ($r.y - 4)) -and ($p.Y -le ($r.y + $r.h + 4)))
        if (($null -eq $hndDown) -and (-not $inside)) {
          # Dragging outside the frame starts a fresh selection.
          $script:items.Clear()
          $w.annot.Children.Clear()
          $script:phase = 'select'
          $w.rect = $null
          $script:rect = $null
          $script:dragMode = $null
          $w.bar.Visibility = 'Collapsed'
          $w.hint.Visibility = 'Visible'
          Update-Shade $w
          Update-Handles $w
        } else {
          if ($script:tool -eq 'move') {
            $hnd = $hndDown
            $script:dragMode = 'move'
            if ($null -ne $hnd) { $script:dragMode = 'resize' }
            $script:handle = $hnd
            $script:p0 = $p
            $r0 = $w.rect
            $script:rectStart = @{ x = $r0.x; y = $r0.y; w = $r0.w; h = $r0.h }
            Write-Diag ('GRAB ' + [string]$script:dragMode + ' ' + [string]$hnd)
            return
          }
          $draftElement = $null
          $draftPoints = $null
          switch ($script:tool) {
            'rect' {
              $draftElement = New-Object System.Windows.Shapes.Rectangle
              $draftElement.Stroke = $MARK_BRUSH
              $draftElement.StrokeThickness = 2
              $draftElement.Fill = [System.Windows.Media.Brushes]::Transparent
            }
            'ellipse' {
              $draftElement = New-Object System.Windows.Shapes.Ellipse
              $draftElement.Stroke = $MARK_BRUSH
              $draftElement.StrokeThickness = 2
              $draftElement.Fill = [System.Windows.Media.Brushes]::Transparent
            }
            'arrow' {
              $draftElement = New-Object System.Windows.Shapes.Line
              $draftElement.Stroke = $MARK_BRUSH
              $draftElement.StrokeThickness = 2
              $draftElement.X1 = $p.X
              $draftElement.Y1 = $p.Y
              $draftElement.X2 = $p.X
              $draftElement.Y2 = $p.Y
              $head = New-Object System.Windows.Shapes.Polygon
              $head.Fill = $MARK_BRUSH
              $head.Points = New-Object System.Windows.Media.PointCollection
              $head.IsHitTestVisible = $false
              $script:draftHead = $head
              [void]$w.annot.Children.Add($head)
            }
            'pen' {
              $draftElement = New-Object System.Windows.Shapes.Polyline
              $draftElement.Stroke = $MARK_BRUSH
              $draftElement.StrokeThickness = 2
              $draftPoints = New-Object System.Collections.ArrayList
              [void]$draftPoints.Add((New-Object System.Windows.Point($p.X, $p.Y)))
              $draftElement.Points = New-Object System.Windows.Media.PointCollection
              [void]$draftElement.Points.Add((New-Object System.Windows.Point($p.X, $p.Y)))
            }

          }
          if ($null -ne $draftElement) {
            $draftElement.HorizontalAlignment = 'Left'
            $draftElement.VerticalAlignment = 'Top'
            [void]$w.annot.Children.Add($draftElement)
          }
          $script:draft = @{ x1 = $p.X; y1 = $p.Y; x2 = $p.X; y2 = $p.Y; element = $draftElement; points = $draftPoints }
          return
        }
      }

      $script:start = $p
      $script:snapRect = Find-Snap $w $p
      # Keep the hovered frame on screen while the button is down. Zeroing it here wiped the
      # frame the instant the user pressed, and a stray click then left an empty box behind.
      if ($null -eq $script:hoverRect) {
        $w.rect = @{ x = $p.X; y = $p.Y; w = 0; h = 0 }
        $script:rect = $w.rect
      }
      $w.hint.Visibility = 'Collapsed'
      $w.label.Visibility = 'Visible'
      Update-Shade $w
      } catch { Write-Diag ('HANDLER ' + $_.InvocationInfo.ScriptLineNumber + ' :: ' + $_.Exception.Message); Write-Diag ([string]$_.ScriptStackTrace) }
  })

  $grid.add_MouseMove({
      param($s, $e)
  try {
      $w = $s.Tag
      if (-not [object]::ReferenceEquals($script:active, $w)) {
        # Hover has to be able to claim the active monitor before any click, otherwise the frame
        # only ever appears after the user presses the button ("hover does nothing").
        if (($script:phase -eq 'select') -and ($null -eq $script:start) -and ($null -eq $script:draft) -and ($null -eq $script:dragMode)) {
          $script:active = $w
        } else {
          return
        }
      }
      $p = $e.GetPosition($s)
      # Refresh the DIP scale on hover too, not just on press: the first hover of a session
      # otherwise used factor 1 and drew the frame 1.5x too far right/down.
      $w.viewWidth = $s.ActualWidth
      $w.viewHeight = $s.ActualHeight
      $w.factor = $w.width / [Math]::Max(1, $s.ActualWidth)

      if ($script:phase -eq 'select') {
        if ($null -eq $script:start) {
          $snapNow = Find-Snap $w $p
          if ($null -ne $snapNow) {
            $w.rect = $snapNow
            $script:rect = $snapNow
            $script:hoverRect = $snapNow
            if (('{0},{1},{2}x{3}' -f [int]$snapNow.x, [int]$snapNow.y, [int]$snapNow.w, [int]$snapNow.h) -ne $script:hoverLogged) {
              $script:hoverLogged = ('{0},{1},{2}x{3}' -f [int]$snapNow.x, [int]$snapNow.y, [int]$snapNow.w, [int]$snapNow.h)
              Write-Diag ('SNAP ' + $script:hoverLogged + ' "' + [string]$snapNow.title + '"')
            }
            Update-Shade $w
            $w.labelText.Text = ('{0} * {1}' -f [int][Math]::Round($snapNow.w * $w.factor), [int][Math]::Round($snapNow.h * $w.factor))
            $ly = $snapNow.y - 30
            if ($ly -lt 4) { $ly = $snapNow.y + 8 }
            $w.label.Margin = New-T4 (($snapNow.x), ($ly), (0), (0))
            $w.label.Visibility = 'Visible'
            $w.hint.Visibility = 'Collapsed'
            # Screenshot tools keep the crosshair even over a highlighted window:
            # the pointer is the aiming reticle, not a "clickable" affordance.
            Set-PointerCursor ([System.Windows.Input.Cursors]::Cross)
            return
          }
          $script:hoverRect = $null
          if ($null -ne $w.rect) {
            $w.rect = $null
            $script:rect = $null
            Update-Shade $w
            $w.label.Visibility = 'Collapsed'
          }
          Set-PointerCursor ([System.Windows.Input.Cursors]::Cross)
          $w.hint.Visibility = 'Visible'
          Set-SnapVisual $w $null
          return
        }
        if (([Math]::Abs($p.X - $script:start.X)) -gt 5 -or ([Math]::Abs($p.Y - $script:start.Y)) -gt 5) {
          $script:snapRect = $null
          $script:hoverRect = $null
          Set-SnapVisual $w $null
        }
        $x = [Math]::Min($script:start.X, $p.X)
        $y = [Math]::Min($script:start.Y, $p.Y)
        $ww = [Math]::Abs($p.X - $script:start.X)
        $hh = [Math]::Abs($p.Y - $script:start.Y)
        $w.rect = @{ x = $x; y = $y; w = $ww; h = $hh }
        Update-Shade $w
        $w.labelText.Text = ('{0} * {1}' -f [int][Math]::Round($ww * $w.factor), [int][Math]::Round($hh * $w.factor))
        $ly = $y - 30
        if ($ly -lt 4) { $ly = $y + 8 }
        $w.label.Margin = New-T4 (($x), ($ly), (0), (0))
        return
      }

      if (($null -ne $script:dragMode) -and ($null -ne $script:rectStart)) {
        $r0 = $script:rectStart
        $dx = $p.X - $script:p0.X
        $dy = $p.Y - $script:p0.Y
        $nx = $r0.x
        $ny = $r0.y
        $nw = $r0.w
        $nh = $r0.h
        if ($script:dragMode -eq 'move') {
          $nx = $r0.x + $dx
          $ny = $r0.y + $dy
        } else {
          $hnd = [string]$script:handle
          if ($hnd.Contains('w')) { $nx = $r0.x + $dx; $nw = $r0.w - $dx }
          if ($hnd.Contains('e')) { $nw = $r0.w + $dx }
          if ($hnd.Contains('n')) { $ny = $r0.y + $dy; $nh = $r0.h - $dy }
          if ($hnd.Contains('s')) { $nh = $r0.h + $dy }
        }
        if ($nw -lt 16) { if ($script:dragMode -eq 'move') { $nw = 16 } else { $nw = 16 } }
        if ($nh -lt 16) { $nh = 16 }
        if ($nx -lt 0) { $nx = 0 }
        if ($ny -lt 0) { $ny = 0 }
        if (($nx + $nw) -gt $w.viewWidth) { $nw = $w.viewWidth - $nx }
        if (($ny + $nh) -gt $w.viewHeight) { $nh = $w.viewHeight - $ny }
        $nr = @{ x = $nx; y = $ny; w = $nw; h = $nh }
        $w.rect = $nr
        $script:rect = $nr
        Update-Shade $w
        Update-Handles $w
        Place-Toolbar $w
        $w.labelText.Text = ('{0} * {1}' -f [int][Math]::Round($nw * $w.factor), [int][Math]::Round($nh * $w.factor))
        $ly = $ny - 30
        if ($ly -lt 4) { $ly = $ny + 8 }
        $w.label.Margin = New-T4 (($nx), ($ly), (0), (0))
        $w.label.Visibility = 'Visible'
        return
      }

      if ($script:phase -eq 'edit') {
        if ($script:tool -eq 'move') {
          $hnd = Get-HandleAt $w $p
          $r = $w.rect
          $insideNow = ($null -ne $r) -and ($p.X -ge $r.x) -and ($p.X -le ($r.x + $r.w)) -and ($p.Y -ge $r.y) -and ($p.Y -le ($r.y + $r.h))
          if ($hnd -eq 'nw' -or $hnd -eq 'se') { Set-PointerCursor ([System.Windows.Input.Cursors]::SizeNWSE) }
          elseif ($hnd -eq 'ne' -or $hnd -eq 'sw') { Set-PointerCursor ([System.Windows.Input.Cursors]::SizeNESW) }
          elseif ($hnd -eq 'n' -or $hnd -eq 's') { Set-PointerCursor ([System.Windows.Input.Cursors]::SizeNS) }
          elseif ($hnd -eq 'e' -or $hnd -eq 'w') { Set-PointerCursor ([System.Windows.Input.Cursors]::SizeWE) }
          elseif ($insideNow) { Set-PointerCursor ([System.Windows.Input.Cursors]::SizeAll) }
          else { Set-PointerCursor ([System.Windows.Input.Cursors]::Cross) }
        }
      }

      if ($null -eq $script:draft) { return }
      $script:draft.x2 = $p.X
      $script:draft.y2 = $p.Y
      if ($null -ne $script:draft.element) {
        $el = $script:draft.element
        $dx = [Math]::Min($script:draft.x1, $script:draft.x2)
        $dy = [Math]::Min($script:draft.y1, $script:draft.y2)
        $dw = [Math]::Abs($script:draft.x2 - $script:draft.x1)
        $dh = [Math]::Abs($script:draft.y2 - $script:draft.y1)
        if ($script:tool -eq 'pen') {
          [void]$el.Points.Add((New-Object System.Windows.Point($p.X, $p.Y)))
          [void]$script:draft.points.Add((New-Object System.Windows.Point($p.X, $p.Y)))
        } elseif ($script:tool -eq 'arrow') {
          $el.X2 = $p.X
          $el.Y2 = $p.Y
          Update-ArrowHead $script:draftHead $el.X1 $el.Y1 $el.X2 $el.Y2
        } else {
          $el.Margin = New-T4 (($dx), ($dy), (0), (0))
          $el.Width = $dw
          $el.Height = $dh
        }
      }
      } catch { Write-Diag ('HANDLER ' + $_.InvocationInfo.ScriptLineNumber + ' :: ' + $_.Exception.Message); Write-Diag ([string]$_.ScriptStackTrace) }
  })

  $grid.add_MouseLeftButtonUp({
      param($s, $e)
  try {
      $w = $s.Tag
      if (-not [object]::ReferenceEquals($script:active, $w)) { return }

      if ($script:phase -eq 'select') {
        if ($null -eq $script:start) { return }
        $pUp = $e.GetPosition($s)
        $moved = [Math]::Max([Math]::Abs($pUp.X - $script:start.X), [Math]::Abs($pUp.Y - $script:start.Y))
        $r = $w.rect
        $script:start = $null
        if ($moved -le 5) {
          # A click without a drag locks the frame hover was showing, the way Doubao takes a
          # hovered window on click. With nothing hovered the click only clears the frame.
          $r = $script:snapRect
          if ($null -eq $r) { $r = $script:hoverRect }
          if ($null -eq $r) {
            $w.rect = $null
            $script:rect = $null
            $w.label.Visibility = 'Collapsed'
            $w.hint.Visibility = 'Visible'
            Update-Shade $w
            return
          }
        }
        $script:snapRect = $null
        $script:hoverRect = $null
        Set-SnapVisual $w $null
        $w.rect = $r
        $w.labelText.Text = ('{0} * {1}' -f [int][Math]::Round($r.w * $w.factor), [int][Math]::Round($r.h * $w.factor))
        $w.label.Margin = New-T4 (($r.x), ([Math]::Max(4, ($r.y - 30))), (0), (0))
        Update-Shade $w
        if (($r.w * $w.factor) -lt 6 -or ($r.h * $w.factor) -lt 6) {
          $w.rect = $null
          $w.label.Visibility = 'Collapsed'
          Update-Shade $w
          return
        }
        $script:phase = 'edit'
        $script:rect = $r
        Write-Diag ('LOCK rect=' + (Format-Rect $r) + ' click=' + [int]$moved)
        $w.bar.Visibility = 'Visible'
        Place-Toolbar $w
        Update-Handles $w
        $w.hint.Visibility = 'Collapsed'
        $w.label.Visibility = 'Visible'
        return
      }

      if ($null -ne $script:dragMode) {
        $script:dragMode = $null
        $script:handle = $null
        $script:p0 = $null
        $script:rectStart = $null
        Write-Diag ('GRAB end rect=' + (Format-Rect $w.rect))
        return
      }

      if ($null -eq $script:draft) { return }
      $d = $script:draft
      $script:draft = $null
      $toolName = [string]$script:tool
      Write-Diag ('COMMIT tool=' + $toolName)

      if ($toolName -eq 'arrow') {
        if (($null -eq $d.element)) { return }
        if (([Math]::Abs($d.x2 - $d.x1)) -lt 3 -and ([Math]::Abs($d.y2 - $d.y1)) -lt 3) {
          $w.annot.Children.Remove($d.element)
          if ($null -ne $script:draftHead) { $w.annot.Children.Remove($script:draftHead); $script:draftHead = $null }
          return
        }
        Update-ArrowHead $script:draftHead $d.element.X1 $d.element.Y1 $d.element.X2 $d.element.Y2
        [void]$script:items.Add(@{ type = 'arrow'; x1 = $d.element.X1; y1 = $d.element.Y1; x2 = $d.element.X2; y2 = $d.element.Y2; win = $w; element = $d.element; head = $script:draftHead })
        $script:draftHead = $null
        return
      }
      if ($toolName -eq 'pen') {
        if ($null -eq $d.element -or $null -eq $d.points -or $d.points.Count -lt 2) {
          if ($null -ne $d.element) { $w.annot.Children.Remove($d.element) }
          return
        }
        [void]$script:items.Add(@{ type = 'pen'; points = $d.points; win = $w; element = $d.element })
        return
      }
      $dx2 = [Math]::Min($d.x1, $d.x2)
      $dy2 = [Math]::Min($d.y1, $d.y2)
      $dw2 = [Math]::Abs($d.x2 - $d.x1)
      $dh2 = [Math]::Abs($d.y2 - $d.y1)
      if ($dw2 -lt 3 -or $dh2 -lt 3) { if ($null -ne $d.element) { $w.annot.Children.Remove($d.element) }; return }
      [void]$script:items.Add(@{ type = $toolName; x = $dx2; y = $dy2; w = $dw2; h = $dh2; win = $w; element = $d.element })
      Write-Diag ('STATE phase=' + $script:phase + ' rect=' + (Format-Rect $w.rect) + ' items=' + $script:items.Count)
      } catch { Write-Diag ('HANDLER ' + $_.InvocationInfo.ScriptLineNumber + ' :: ' + $_.Exception.Message); Write-Diag ([string]$_.ScriptStackTrace) }
  })

  # Right click cancels exactly like Escape: leave edit mode first, then close the overlay.
  $grid.add_MouseRightButtonDown({
      param($s, $e)
  try {
      if ($script:bootWatch.ElapsedMilliseconds -lt 700) { Write-Diag 'RIGHTDOWN ignored (boot)'; return }
      if ($e.ChangedButton -ne [System.Windows.Input.MouseButton]::Right) { return }
      $e.Handled = $true
      Write-Diag 'RIGHTDOWN'
      Invoke-Escape
      } catch { Write-Diag ('HANDLER ' + $_.InvocationInfo.ScriptLineNumber + ' :: ' + $_.Exception.Message); Write-Diag ([string]$_.ScriptStackTrace) }
  })

  $win.add_KeyDown({
      param($s, $e)
  try {
      if ($e.Key -eq 'Escape') { Invoke-Escape; return }
      if ($e.Key -eq 'Return' -and $script:phase -eq 'edit') { $script:confirmed = $true; Close-All }
      } catch { Write-Diag ('HANDLER ' + $_.InvocationInfo.ScriptLineNumber + ' :: ' + $_.Exception.Message); Write-Diag ([string]$_.ScriptStackTrace) }
  })
  $win.add_SourceInitialized({
      param($s, $e)
      $helper = New-Object System.Windows.Interop.WindowInteropHelper($win)
      [void][ShotNative]::SetWindowPos($helper.Handle, [IntPtr](-1), $left, $top, $mw, $mh, 0x0040)
      if ($i -eq 0) { [void][ShotNative]::SetForegroundWindow($helper.Handle) }
    })

  [void]$script:windows.Add($win)
}

# Show every monitor window, then pump until the user finishes.
$shown = 0
foreach ($w in $script:windows) {
  $w.Show()
  $shown++
  if ($shown -eq 1) { $w.Activate() | Out-Null }
}
if ($shown -eq 0) { Write-Output '{"cancelled":true,"reason":"no-window"}'; exit 0 }

# A crosshair everywhere in screenshot mode, even over elements that would
# otherwise inherit the arrow cursor.
Set-PointerCursor ([System.Windows.Input.Cursors]::Cross)

$app = [System.Windows.Application]::Current
if ($null -eq $app) { $app = New-Object System.Windows.Application }
$app.Run() | Out-Null

# Whatever path brought us here, the desktop must not keep the crosshair.
Reset-PointerCursor

if ($script:cancelled -or $null -eq $script:rect) {
  Write-Output '{"cancelled":true}'
  exit 0
}

$w2 = $script:active
foreach ($it in $script:items) { Write-Diag ('COMPOSE item type=' + $it.type + ' x=' + $it.x + ' y=' + $it.y + ' w=' + $it.w + ' h=' + $it.h) }
$r = $script:rect
$factor = $w2.factor
$x = $w2.left + [int][Math]::Round($r.x * $factor)
$y = $w2.top + [int][Math]::Round($r.y * $factor)
$cw = [int][Math]::Round($r.w * $factor)
$ch = [int][Math]::Round($r.h * $factor)
if ($cw -lt 4 -or $ch -lt 4) { Write-Output '{"cancelled":true,"reason":"too-small"}'; exit 0 }

if ($Out -ne "") {
  $src = [System.Drawing.Image]::FromFile($Image)
  $bmp = New-Object System.Drawing.Bitmap($cw, $ch)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), (New-Object System.Drawing.Rectangle($x, $y, $cw, $ch)), [System.Drawing.GraphicsUnit]::Pixel)

  $penColor = [System.Drawing.Color]::FromArgb(255, 244, 63, 94)
  foreach ($item in $script:items) {
    $iw = $item.win
    $f = $iw.factor
    $ox = $x
    $oy = $y
    $pen = New-Object System.Drawing.Pen($penColor, 3)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    switch ($item.type) {
      'rect' {
        $g.DrawRectangle($pen, [single](($iw.left + $item.x * $f) - $ox), [single](($iw.top + $item.y * $f) - $oy), [single]($item.w * $f), [single]($item.h * $f))
      }
      'ellipse' {
        $g.DrawEllipse($pen, [single](($iw.left + $item.x * $f) - $ox), [single](($iw.top + $item.y * $f) - $oy), [single]($item.w * $f), [single]($item.h * $f))
      }
      'arrow' {
        $x1 = ($iw.left + $item.x1 * $f) - $ox
        $y1 = ($iw.top + $item.y1 * $f) - $oy
        $x2 = ($iw.left + $item.x2 * $f) - $ox
        $y2 = ($iw.top + $item.y2 * $f) - $oy
        $g.DrawLine($pen, [single]$x1, [single]$y1, [single]$x2, [single]$y2)
        $dx = $x2 - $x1
        $dy = $y2 - $y1
        $len = [Math]::Sqrt(($dx * $dx) + ($dy * $dy))
        if ($len -gt 2) {
          $ux = $dx / $len
          $uy = $dy / $len
          $size = 18 * $f
          $wing = 9 * $f
          $bx = $x2 - $ux * $size
          $by = $y2 - $uy * $size
          $nx = -$uy
          $ny = $ux
          $points = @(
            (New-Object System.Drawing.PointF([single]$x2, [single]$y2)),
            (New-Object System.Drawing.PointF([single]($bx + $nx * $wing), [single]($by + $ny * $wing))),
            (New-Object System.Drawing.PointF([single]($bx - $nx * $wing), [single]($by - $ny * $wing)))
          )
          $headBrush = New-Object System.Drawing.SolidBrush($penColor)
          $g.FillPolygon($headBrush, [System.Drawing.PointF[]]$points)
          $g.DrawPolygon($pen, [System.Drawing.PointF[]]$points)
          $headBrush.Dispose()
        }
      }
      'pen' {
        $pts = @()
        foreach ($pt in $item.points) {
          $pts += New-Object System.Drawing.PointF([single](($iw.left + $pt.X * $f) - $ox), [single](($iw.top + $pt.Y * $f) - $oy))
        }
        if ($pts.Count -ge 2) { $g.DrawLines($pen, [System.Drawing.PointF[]]$pts) }
      }

    }
    $pen.Dispose()
  }

  $g.Dispose()
  $src.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$result = '{"cancelled":false,"x":' + $x + ',"y":' + $y + ',"w":' + $cw + ',"h":' + $ch + '}'
Write-Output $result