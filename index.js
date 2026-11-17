/**
 * dsh-shot — host half.
 *
 * Grabs the Windows desktop and serves it as PNG over one guarded web route.
 * The renderer cannot use getDisplayMedia here: the desktop app's session
 * configuration rejects display-capture and clipboard permissions outright
 * (lib/main.js, configureSession), so the pixels have to come from the host.
 *
 * The shot is written to a scratch file and streamed from there instead of
 * travelling through stdout as base64: a 2560x1600 PNG is ~700 KB, and base64
 * over a pipe costs a third more plus a megabyte of string handling.
 *
 * When the caller asks to hide the window, this half also parks the app window
 * (minimise -> capture -> maximise) so the frozen frame does not contain the
 * picker's own window, and remembers the original placement in a scratch file
 * so /dsh-screenshot/window?action=restore can put it back.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, unlink, appendFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const name = 'screenshot'
export const inject = ['webServer', 'connection']

const SCREENSHOT_PATH = '/dsh-screenshot/capture'
const WINDOW_PATH = '/dsh-screenshot/window'
const LOG_PATH = '/dsh-screenshot/log'
const AUTOTEST_PATH = '/dsh-screenshot/autotest'
const OVERLAY_PATH = '/dsh-screenshot/overlay'
// Presence of this file makes the browser half probe the composer intake on
// load and report the outcome; it exists so the attachment path can be tested
// without asking a person to click through the UI.
const AUTOTEST_MARKER = fileURLToPath(new URL('./.autotest', import.meta.url))
const OVERLAY_SCRIPT_PATH = fileURLToPath(new URL('./overlay.ps1', import.meta.url))
const OVERLAY_TIMEOUT_MS = 240000
const CAPTURE_TIMEOUT_MS = 25000
const WINDOW_TIMEOUT_MS = 10000
const MAX_STDOUT_BYTES = 4096
const WINDOW_STATE_PATH = join(tmpdir(), 'dsh-screenshot-window.json')
const CLIENT_LOG_PATH = join(tmpdir(), 'dsh-screenshot-client.log')
const POWERSHELL =
  `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

const WIN32_TYPES = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Dshss {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
}
"@
`

const CAPTURE_SCRIPT =
  String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
` +
  WIN32_TYPES +
  String.raw`
$out = $env:DSHSS_OUT
$hide = $env:DSHSS_HIDE
$owner = $env:DSHSS_OWNER
$state = $env:DSHSS_STATE

# Per-monitor DPI aware, so GetSystemMetrics reports physical pixels and the
# copy is 1:1 with the panel instead of a scaled-down logical desktop.
[void][Dshss]::SetProcessDpiAwarenessContext([IntPtr](-4))

# The hwnd is needed even when the caller does not want the window hidden: the
# picker overlay has to grow to the whole screen afterwards, and only the host
# side can do that.
$hwnd = [IntPtr]::Zero
$proc = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -eq $owner -and $_.MainWindowHandle -ne 0
} | Select-Object -First 1
if ($null -ne $proc) { $hwnd = $proc.MainWindowHandle }

$saved = $null
if ($hwnd -ne [IntPtr]::Zero) {
  $rect = New-Object 'Dshss+RECT'
  [void][Dshss]::GetWindowRect($hwnd, [ref]$rect)
  $saved = [ordered]@{
    hwnd = $hwnd.ToInt64()
    zoomed = [Dshss]::IsZoomed($hwnd)
    left = $rect.Left
    top = $rect.Top
    right = $rect.Right
    bottom = $rect.Bottom
    style = [Dshss]::GetWindowLongPtr($hwnd, -16).ToInt64()
    exStyle = [Dshss]::GetWindowLongPtr($hwnd, -20).ToInt64()
  }
  ($saved | ConvertTo-Json -Compress) | Set-Content -LiteralPath $state -Encoding ASCII

  if ($hide -eq '1') {
    # SW_MINIMIZE for the copy, then SW_RESTORE below. Only the minimise state
    # is touched - no window styles, no maximise, no resize: those are what once
    # left the user with a frameless window.
    [void][Dshss]::ShowWindow($hwnd, 6)
    Start-Sleep -Milliseconds 260
  }
}

$screenLeft = 0
$screenTop = 0
$screenWidth = 0
$screenHeight = 0
$captured = $false
try {
  $screenLeft = [Dshss]::GetSystemMetrics(76)
  $screenTop = [Dshss]::GetSystemMetrics(77)
  $screenWidth = [Dshss]::GetSystemMetrics(78)
  $screenHeight = [Dshss]::GetSystemMetrics(79)
  if ($screenWidth -le 0 -or $screenHeight -le 0) { throw 'the virtual desktop reports no size' }

  $bitmap = New-Object System.Drawing.Bitmap $screenWidth, $screenHeight, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($screenLeft, $screenTop, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  $graphics.Dispose()
  $bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()

  $captured = $true
  [Console]::Out.Write("$screenWidth,$screenHeight,$screenLeft,$screenTop")
}
finally {
  # When the caller defers (DSHSS_DEFER_RESTORE=1) the window stays minimised until
  # the overlay has finished, so the user never sees a minimise/restore double pop
  # and the overlay cannot snap onto our own window.
  if ($hwnd -ne [IntPtr]::Zero -and $hide -eq '1' -and $env:DSHSS_DEFER_RESTORE -ne '1') {
    if ($saved.zoomed) {
      [void][Dshss]::ShowWindow($hwnd, 3)
    }
    else {
      [void][Dshss]::ShowWindow($hwnd, 9)
      [void][Dshss]::SetWindowPos(
        $hwnd, [IntPtr](-2), $saved.left, $saved.top,
        ($saved.right - $saved.left), ($saved.bottom - $saved.top), 0x0034
      )
    }
    [void][Dshss]::SetForegroundWindow($hwnd)
  }
}
`

const RESTORE_SCRIPT =
  String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
` +
  WIN32_TYPES +
  String.raw`
$state = $env:DSHSS_STATE
Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue
# The overlay no longer rearranges the host window, so there is nothing to
# restore. Kept as a route so older clients still get a clean answer.
[Console]::Out.Write('noop')
`

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

function runPowerShell(script, env, timeoutMs) {
  return new Promise((resolve) => {
    // -EncodedCommand, not "-Command -": a multi-line here-string fed through
    // stdin makes powershell.exe exit 0 with no output at all.
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      },
    )

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ ok: false, message: `capture timed out after ${timeoutMs} ms` })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDOUT_BYTES) stderr += chunk
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, message: `could not start powershell: ${error.message}` })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const detail = stderr
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-3)
          .join(' ')
        resolve({ ok: false, message: detail || `powershell exited with code ${code}` })
        return
      }
      resolve({ ok: true, stdout: stdout.trim() })
    })
  })
}

// Restored geometry and the window styles stripped for the picker come back
// through one state file; if the renderer dies while the picker is up, nothing
// would ask for that restore and the window would sit frameless over the whole
// screen, so the host puts it back on its own after a couple of minutes.
const AUTO_RESTORE_MS = 120000
let coverGuard = null

function armCoverGuard() {
  disarmCoverGuard()
  coverGuard = setTimeout(() => {
    coverGuard = null
    void restoreWindow()
  }, AUTO_RESTORE_MS)
  if (typeof coverGuard.unref === 'function') coverGuard.unref()
}

function disarmCoverGuard() {
  if (coverGuard === null) return
  clearTimeout(coverGuard)
  coverGuard = null
}

async function captureScreen(hideWindow) {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'screen capture is only implemented for Windows' }
  }

  const outPath = join(tmpdir(), `dsh-screenshot-${randomUUID()}.png`)
  const started = Date.now()

  try {
    const run = await runPowerShell(
      CAPTURE_SCRIPT,
      {
        DSHSS_OUT: outPath,
        DSHSS_HIDE: hideWindow ? '1' : '0',
        DSHSS_OWNER: 'DeepSeek Harness',
        DSHSS_STATE: WINDOW_STATE_PATH,
      },
      CAPTURE_TIMEOUT_MS,
    )
    if (!run.ok) return run

    const match = /^(\d+),(\d+),(-?\d+),(-?\d+)$/.exec(run.stdout)
    if (match === null) {
      return { ok: false, message: `unexpected capture metadata: ${JSON.stringify(run.stdout.slice(0, 200))}` }
    }

    const png = await readFile(outPath)
    if (png.length === 0) return { ok: false, message: 'the capture produced an empty file' }

    armCoverGuard()
    return {
      ok: true,
      png,
      width: Number(match[1]),
      height: Number(match[2]),
      originX: Number(match[3]),
      originY: Number(match[4]),
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    await unlink(outPath).catch(() => {})
  }
}

async function restoreWindow() {
  if (process.platform !== 'win32') return { ok: true, message: 'unsupported platform' }
  disarmCoverGuard()
  return runPowerShell(RESTORE_SCRIPT, { DSHSS_STATE: WINDOW_STATE_PATH }, WINDOW_TIMEOUT_MS)
}


// The native picker needs one frozen frame of the desktop to paint over. The
// window is minimised for the duration of CopyFromScreen and immediately put
// back the way it was: no restyle, no pave, no geometry juggling.
const FREEZE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ShotFreeze {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[void][ShotFreeze]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Drawing
$out = $env:DSHSS_OUT
$owner = $env:DSHSS_OWNER
$hide = $env:DSHSS_HIDE -eq '1'
$hwnd = [IntPtr]::Zero
if ($owner) {
  $proc = Get-Process -Name $owner -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { $hwnd = $proc.MainWindowHandle }
}
$zoomed = $false
$minimized = $false
$savedRect = New-Object 'ShotFreeze+RECT'
$haveRect = $false
if (($hwnd -ne [IntPtr]::Zero) -and $hide) {
  $zoomed = [ShotFreeze]::IsZoomed($hwnd)
  $haveRect = [ShotFreeze]::GetWindowRect($hwnd, [ref]$savedRect)
  # No temp state file: the restore side asks Windows for the window placement
  # (rcNormalPosition + WPF_RESTORETOMAXIMIZED) instead of trusting a file that can
  # outlive the run and put the window back at an old size.
  [void][ShotFreeze]::ShowWindow($hwnd, 6)
  $minimized = $true
  Start-Sleep -Milliseconds 260
}

function Restore-Owner {
  if (-not $minimized) { return }
  # DSHSS_DEFER_RESTORE=1 keeps the host minimised until the overlay exits, so the
  # window never pops back behind the frozen frame and cannot be a snap target.
  if ($env:DSHSS_DEFER_RESTORE -eq '1') { return }
  if ($zoomed) {
    [void][ShotFreeze]::ShowWindow($hwnd, 3)
  }
  else {
    [void][ShotFreeze]::ShowWindow($hwnd, 9)
    if ($haveRect) {
      [void][ShotFreeze]::SetWindowPos(
        $hwnd, [IntPtr](-2), $savedRect.Left, $savedRect.Top,
        ($savedRect.Right - $savedRect.Left), ($savedRect.Bottom - $savedRect.Top), 0x0034
      )
    }
  }
  [void][ShotFreeze]::SetForegroundWindow($hwnd)
}
try {
$left = [ShotFreeze]::GetSystemMetrics(76)
$top = [ShotFreeze]::GetSystemMetrics(77)
$width = [ShotFreeze]::GetSystemMetrics(78)
$height = [ShotFreeze]::GetSystemMetrics(79)
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
$graphics.Dispose()
$bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Restore-Owner
$zoomFlag = if ($zoomed) { '1' } else { '0' }
Write-Output ("$width,$height,$left,$top|" + [int64]$hwnd + "|" + $zoomFlag)
} catch {
  # Never leave the app minimized just because this failed.
  Restore-Owner
  throw
}
`

// The picker owns the screen; the DSH window stays minimized until it exits, so
// the user never sees it flash back before the dim layer is up.
const SHOW_OWNER_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct ShotRect { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)]
public struct ShotPoint { public int X, Y; }
[StructLayout(LayoutKind.Sequential)]
public struct ShotPlacement {
  public int length;
  public int flags;
  public int showCmd;
  public ShotPoint ptMin;
  public ShotPoint ptMax;
  public ShotRect normal;
}
public class ShotShow {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref ShotPlacement p);
}
"@
$hwnd = [IntPtr][int64]$env:DSHSS_HWND
if ($hwnd -eq [IntPtr]::Zero -or -not [ShotShow]::IsWindow($hwnd)) { Write-Output 'gone'; exit 0 }

# Without this the process is DPI-virtualised at 150% scaling: GetWindowPlacement hands back
# virtual pixels and SetWindowPos then writes them as physical ones, so every screenshot grew
# the window by 1.5x. This is the root cause of the recurring "window got bigger" reports.
[void][ShotShow]::SetProcessDpiAwarenessContext([IntPtr](-4))

# Someone (or the user) already brought the window back: touching it now is what made it
# jump to a stale size, so the only safe action is nothing.
if (-not [ShotShow]::IsIconic($hwnd)) { Write-Output 'visible'; exit 0 }

$placement = New-Object 'ShotPlacement'
$placement.length = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'ShotPlacement')
$placed = [ShotShow]::GetWindowPlacement($hwnd, [ref]$placement)
$wantMax = $false
if ($placed) {
  # WPF_RESTORETOMAXIMIZED: the window was minimised while maximised.
  if (($placement.flags -band 2) -ne 0 -or $placement.showCmd -eq 3) { $wantMax = $true }
}

if ($wantMax) {
  [void][ShotShow]::ShowWindow($hwnd, 3)
  Write-Output 'maximized'
} else {
  [void][ShotShow]::ShowWindow($hwnd, 9)
  if ($placed) {
    $width = $placement.normal.Right - $placement.normal.Left
    $height = $placement.normal.Bottom - $placement.normal.Top
    if ($width -ge 200 -and $height -ge 200) {
      [void][ShotShow]::SetWindowPos(
        $hwnd, [IntPtr](-2), $placement.normal.Left, $placement.normal.Top, $width, $height, 0x0034
      )
    }
  }
  Write-Output 'restored'
}
[void][ShotShow]::SetForegroundWindow($hwnd)
`

function runPowerShellFile(file, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
    )

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ ok: false, message: `the picker did not finish within ${Math.round(timeoutMs / 1000)} s` })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDOUT_BYTES) stderr += chunk
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, message: `could not start the picker: ${error.message}` })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const detail = stderr
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-3)
          .join(' ')
        // Windows PowerShell reports -1 (4294967295) when the overlay is torn down while it is
        // still initialising, e.g. an Esc arriving before the windows exist. From the caller's
        // point of view nothing was selected, so report a cancel rather than a hard failure --
        // but keep the detail so a real crash stays diagnosable in the client log.
        if (/^\s*\{/.test(stdout) === false) {
          resolve({ ok: true, stdout: '', note: detail || `the picker exited with code ${code}` })
          return
        }
        resolve({ ok: false, message: detail || `the picker exited with code ${code}` })
        return
      }
      resolve({ ok: true, stdout: stdout.trim() })
    })
  })
}

// Freeze the desktop, let the native overlay own the screen for the pick, then
// hand back the cropped pixels. The overlay window never touches the DSH host
// window, so nothing resizes while the user is framing.
/**
 * Windows PowerShell decodes a .ps1 that lacks a byte-order mark as ANSI, which
 * turns every Chinese label in the picker overlay into mojibake — the buttons
 * come out as garbage even though the file itself is valid UTF-8. Editors drop
 * the BOM without asking, so hand PowerShell a copy that always carries one.
 */
function overlayScriptWithBom() {
  try {
    const bytes = readFileSync(OVERLAY_SCRIPT_PATH)
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return OVERLAY_SCRIPT_PATH
    }
    const copy = join(tmpdir(), 'dsh-shot-overlay-bom.ps1')
    writeFileSync(copy, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]))
    return copy
  } catch {
    return OVERLAY_SCRIPT_PATH
  }
}

async function pickRegionOverlay(hideWindow) {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'the native picker is only implemented for Windows' }
  }

  const frozen = join(tmpdir(), `dsh-shot-frozen-${randomUUID()}.png`)
  const cropped = join(tmpdir(), `dsh-shot-crop-${randomUUID()}.png`)
  const started = Date.now()

  try {
    // Boot the overlay first: PowerShell start-up plus WPF assembly loading costs about a
    // second, and it can run while GDI is still copying the desktop into `frozen`. The
    // overlay script waits for that file to appear (and to stop growing) before painting.
    const pickPromise = runPowerShellFile(
      overlayScriptWithBom(),
      ['-Image', frozen, '-Out', cropped],
      OVERLAY_TIMEOUT_MS,
    )

    const freeze = await runPowerShell(
      FREEZE_SCRIPT,
      {
        DSHSS_OUT: frozen,
        DSHSS_OWNER: 'DeepSeek Harness',
        DSHSS_HIDE: hideWindow ? '1' : '0',
        DSHSS_DEFER_RESTORE: hideWindow ? '1' : '0',
        DSHSS_STATE: WINDOW_STATE_PATH,
      },
      CAPTURE_TIMEOUT_MS,
    )
    if (!freeze.ok) {
      // The overlay gives up after its own image deadline; collect it so it cannot linger.
      await pickPromise.catch(() => undefined)
      return freeze
    }

    const [geometry, hwndRaw, zoomRaw] = String(freeze.stdout ?? '').trim().split('|')
    const ownerHwnd = Number.parseInt(hwndRaw ?? '0', 10)
    const ownerZoomed = zoomRaw === '1'
    let restored = false
    const showOwner = async () => {
      if (restored) return
      restored = true
      if (!hideWindow || !Number.isFinite(ownerHwnd) || ownerHwnd <= 0) return
      await runPowerShell(
        SHOW_OWNER_SCRIPT,
        { DSHSS_HWND: String(ownerHwnd) },
        WINDOW_TIMEOUT_MS,
      )
    }

    let pick
    try {
      pick = await pickPromise
    } finally {
      await showOwner()
    }
    if (!pick.ok) return pick

    const line = pick.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => item.startsWith('{'))
      .pop()
    if (line === undefined) {
      // No result line at all: the overlay was closed before it could report anything, which is
      // a cancel, not a failure.
      return { ok: true, cancelled: true, reason: pick.note ?? 'no-result', elapsedMs: Date.now() - started }
    }

    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      return { ok: false, message: `unreadable picker result: ${JSON.stringify(line.slice(0, 200))}` }
    }

    if (parsed.cancelled === true) {
      return { ok: true, cancelled: true, reason: parsed.reason ?? null, elapsedMs: Date.now() - started }
    }

    const png = await readFile(cropped)
    if (png.length === 0) return { ok: false, message: 'the picker produced an empty image' }

    return {
      ok: true,
      cancelled: false,
      png,
      width: Number(parsed.w),
      height: Number(parsed.h),
      originX: Number(parsed.x),
      originY: Number(parsed.y),
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    await unlink(frozen).catch(() => {})
    await unlink(cropped).catch(() => {})
  }
}

function reject(req, res, ctx) {
  const rejection = connectionOf(ctx).requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

function sendError(res, status, message) {
  const body = JSON.stringify({ code: 'screenshot/failed', message })
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function searchParams(req, fallbackPath) {
  try {
    return new URL(req.url ?? fallbackPath, 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

export function apply(ctx) {
  const captureHandler = async (req, res) => {
    if (reject(req, res, ctx)) return

    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }

    const hideWindow = searchParams(req, SCREENSHOT_PATH).get('hideWindow') === '1'
    const shot = await captureScreen(hideWindow)
    if (!shot.ok) {
      sendError(res, 500, shot.message)
      return
    }

    res.statusCode = 200
    res.setHeader('content-type', 'image/png')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-dsh-screen-width', String(shot.width))
    res.setHeader('x-dsh-screen-height', String(shot.height))
    res.setHeader('x-dsh-screen-origin-x', String(shot.originX))
    res.setHeader('x-dsh-screen-origin-y', String(shot.originY))
    res.setHeader('x-dsh-capture-ms', String(shot.elapsedMs))
    res.end(shot.png)
  }

  const windowHandler = async (req, res) => {
    if (reject(req, res, ctx)) return

    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }

    const action = searchParams(req, WINDOW_PATH).get('action') ?? ''
    if (action !== 'restore') {
      sendError(res, 400, `unknown window action: ${JSON.stringify(action)}`)
      return
    }

    const outcome = await restoreWindow()
    if (!outcome.ok) {
      sendError(res, 500, outcome.message)
      return
    }

    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ action, result: outcome.stdout }))
  }

  // The browser half cannot write files, so it reports what it observed and this
  // route appends it to a plain text log. Reading that file is the only way to
  // see why the composer refused an attachment without asking the user to
  // open devtools. GET with query parameters is the primary form: a plain
  // cross-origin GET is the request shape the page already proves it can send,
  // while a POST body depends on the desktop protocol forwarding it intact.
  const overlayHandler = async (req, res) => {
    if (reject(req, res, ctx)) return

    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }

    const hideWindow = searchParams(req, OVERLAY_PATH).get('hideWindow') !== '0'
    const pick = await pickRegionOverlay(hideWindow)
    if (!pick.ok) {
      sendError(res, 500, pick.message)
      return
    }

    if (pick.cancelled) {
      res.statusCode = 204
      res.setHeader('cache-control', 'no-store')
      res.end()
      return
    }

    res.statusCode = 200
    res.setHeader('content-type', 'image/png')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-dsh-shot-width', String(pick.width))
    res.setHeader('x-dsh-shot-height', String(pick.height))
    res.setHeader('x-dsh-shot-origin-x', String(pick.originX))
    res.setHeader('x-dsh-shot-origin-y', String(pick.originY))
    res.setHeader('x-dsh-shot-ms', String(pick.elapsedMs))
    res.end(pick.png)
  }

  const logHandler = async (req, res) => {
    if (reject(req, res, ctx)) return

    let line = ''
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const label = url.searchParams.get('label') ?? 'note'
      const detail = url.searchParams.get('detail') ?? ''
      line = JSON.stringify({ at: new Date().toISOString(), label, detail: detail.slice(0, 4000) })
    } else if (req.method === 'POST') {
      const chunks = []
      let total = 0
      for await (const chunk of req) {
        total += chunk.length
        if (total > 262144) break
        chunks.push(chunk)
      }
      line = Buffer.concat(chunks).toString('utf8').trim()
    } else {
      res.statusCode = 405
      res.setHeader('allow', 'GET, POST')
      res.end()
      return
    }

    if (line !== '') {
      try {
        await appendFile(CLIENT_LOG_PATH, `${line}\n`, 'utf8')
      } catch {
        /* logging is best effort; never fail the request over it */
      }
    }

    res.statusCode = 204
    res.end()
  }

  const autotestHandler = (req, res) => {
    if (reject(req, res, ctx)) return

    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }

    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ run: existsSync(AUTOTEST_MARKER) }))
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: SCREENSHOT_PATH, handler: captureHandler }),
    'screenshot: GET /dsh-screenshot/capture',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: WINDOW_PATH, handler: windowHandler }),
    'screenshot: GET /dsh-screenshot/window',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: LOG_PATH, handler: logHandler }),
    'screenshot: POST /dsh-screenshot/log',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: OVERLAY_PATH, handler: overlayHandler }),
    'screenshot: GET /dsh-screenshot/overlay',
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: AUTOTEST_PATH, handler: autotestHandler }),
    'screenshot: GET /dsh-screenshot/autotest',
  )
}