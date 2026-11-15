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
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const name = 'screenshot'
export const inject = ['webServer', 'connection']

const SCREENSHOT_PATH = '/dsh-screenshot/capture'
const WINDOW_PATH = '/dsh-screenshot/window'
const LOG_PATH = '/dsh-screenshot/log'
const AUTOTEST_PATH = '/dsh-screenshot/autotest'
// Presence of this file makes the browser half probe the composer intake on
// load and report the outcome; it exists so the attachment path can be tested
// without asking a person to click through the UI.
const AUTOTEST_MARKER = fileURLToPath(new URL('./.autotest', import.meta.url))
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

$hwnd = [IntPtr]::Zero
if ($hide -eq '1') {
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -eq $owner -and $_.MainWindowHandle -ne 0
  } | Select-Object -First 1
  if ($null -ne $proc) { $hwnd = $proc.MainWindowHandle }
}

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
  }
  ($saved | ConvertTo-Json -Compress) | Set-Content -LiteralPath $state -Encoding ASCII

  # SW_MINIMIZE: get our own window out of the frame before copying pixels.
  [void][Dshss]::ShowWindow($hwnd, 6)
  Start-Sleep -Milliseconds 340
}

$captured = $false
try {
  $left = [Dshss]::GetSystemMetrics(76)
  $top = [Dshss]::GetSystemMetrics(77)
  $width = [Dshss]::GetSystemMetrics(78)
  $height = [Dshss]::GetSystemMetrics(79)
  if ($width -le 0 -or $height -le 0) { throw 'the virtual desktop reports no size' }

  $bitmap = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  $graphics.Dispose()
  $bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()

  $captured = $true
  [Console]::Out.Write("$width,$height,$left,$top")
}
finally {
  if ($hwnd -ne [IntPtr]::Zero) {
    if ($captured) {
      # Maximise so the picker overlay covers the whole screen. Topmost is set
      # only long enough to win the z-order fight, then dropped again.
      [void][Dshss]::ShowWindow($hwnd, 3)
      [void][Dshss]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0013)
      [void][Dshss]::BringWindowToTop($hwnd)
      [void][Dshss]::SetForegroundWindow($hwnd)
      [void][Dshss]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0013)
    }
    else {
      # Capture failed: leave the window exactly as it was.
      if ($saved.zoomed) { [void][Dshss]::ShowWindow($hwnd, 3) }
      else {
        [void][Dshss]::ShowWindow($hwnd, 9)
        [void][Dshss]::SetWindowPos(
          $hwnd, [IntPtr](-2), $saved.left, $saved.top,
          ($saved.right - $saved.left), ($saved.bottom - $saved.top), 0x0014
        )
      }
      [void][Dshss]::SetForegroundWindow($hwnd)
    }
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
if (-not (Test-Path -LiteralPath $state)) { [Console]::Out.Write('noop'); exit 0 }

# Same DPI context as the capture: the saved rect is in physical pixels, and a
# process that is not per-monitor aware has its SetWindowPos numbers scaled by
# the display factor (150% here), which lands the window 1.5x too big.
[void][Dshss]::SetProcessDpiAwarenessContext([IntPtr](-4))

$saved = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json
Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue

$hwnd = [IntPtr]::new([int64]$saved.hwnd)
if (-not [Dshss]::IsWindow($hwnd)) { [Console]::Out.Write('gone'); exit 0 }

if ($saved.zoomed) {
  [void][Dshss]::ShowWindow($hwnd, 3)
  [void][Dshss]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0013)
  [void][Dshss]::SetForegroundWindow($hwnd)
  [Console]::Out.Write('maximized')
}
else {
  $width = $saved.right - $saved.left
  $height = $saved.bottom - $saved.top
  # A truncated state file, or a rect written by a process that was not DPI
  # aware, must not be applied: it would leave the window at a random size.
  $screenWidth = [Dshss]::GetSystemMetrics(78)
  $screenHeight = [Dshss]::GetSystemMetrics(79)
  if ($width -lt 200 -or $height -lt 200 -or
      ($screenWidth -gt 0 -and $width -gt ($screenWidth * 2)) -or
      ($screenHeight -gt 0 -and $height -gt ($screenHeight * 2))) {
    # A truncated state file must not leave the window at a random size.
    [void][Dshss]::ShowWindow($hwnd, 9)
    [Console]::Out.Write('invalid-state')
    exit 0
  }
  [void][Dshss]::ShowWindow($hwnd, 9)
  # The capture parked the window maximized; SW_RESTORE leaves a maximized
  # window maximized, and SetWindowPos cannot resize one. SW_SHOWNORMAL drops
  # it back to the restore rect before we place it exactly.
  if ([Dshss]::IsZoomed($hwnd)) { [void][Dshss]::ShowWindow($hwnd, 1) }
  # SWP_NOZORDER | SWP_NOACTIVATE
  [void][Dshss]::SetWindowPos($hwnd, [IntPtr](-2), $saved.left, $saved.top, $width, $height, 0x0014)

  # A window manager that ignores the first request would leave the user with a
  # window that is not the size they had, so check and insist once.
  $rect = New-Object 'Dshss+RECT'
  [void][Dshss]::GetWindowRect($hwnd, [ref]$rect)
  $placed = ($rect.Left -eq $saved.left) -and ($rect.Top -eq $saved.top) -and
            (($rect.Right - $rect.Left) -eq $width) -and (($rect.Bottom - $rect.Top) -eq $height)
  if (-not $placed) {
    [void][Dshss]::ShowWindow($hwnd, 1)
    Start-Sleep -Milliseconds 120
    [void][Dshss]::SetWindowPos($hwnd, [IntPtr](-2), $saved.left, $saved.top, $width, $height, 0x0014)
    $placed = $true
  }
  [void][Dshss]::SetForegroundWindow($hwnd)
  if ($placed) { [Console]::Out.Write('restored') } else { [Console]::Out.Write('restored-unverified') }
}
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
  return runPowerShell(RESTORE_SCRIPT, { DSHSS_STATE: WINDOW_STATE_PATH }, WINDOW_TIMEOUT_MS)
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
    () => ctx.webServer.register({ kind: 'exact', path: AUTOTEST_PATH, handler: autotestHandler }),
    'screenshot: GET /dsh-screenshot/autotest',
  )
}