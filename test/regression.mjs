// Regression suite for dsh-shot. Every change to index.js / overlay.ps1 / client.js must pass
// this before it is handed over; the point is that fixing one behaviour must not quietly break
// another one that already worked.
//
//   node test/regression.mjs                 # window-preservation checks only (safe, no input)
//   node test/regression.mjs --interactions  # also drives the overlay with real mouse/key
//
// Exit code 0 = all checks passed. The window is put back the way it was found.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = dirname(here)
const wantInteractions = process.argv.includes('--interactions')
const LOG = join(process.env.LOCALAPPDATA ?? '', 'Temp', 'overlay-v2.log')

const ps = (file, extra = []) =>
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, file), ...extra], {
    encoding: 'utf8',
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const logSize = () => {
  try {
    return readFileSync(LOG, 'utf8').length
  } catch {
    return 0
  }
}

const logSince = (from) => {
  try {
    return readFileSync(LOG, 'utf8').slice(from)
  } catch {
    return ''
  }
}

async function waitForLog(mark, pattern, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pattern.test(logSince(mark))) return true
    await sleep(200)
  }
  return false
}

function killLeftovers() {
  spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*overlay.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ])
}

function probe() {
  const text = String(ps('probe-style.ps1').stdout ?? '')
  const rect = /rect=(-?\d+),(-?\d+) (\d+)x(\d+)/.exec(text)
  const style = /style=(0x[0-9a-f]+)/i.exec(text)?.[1] ?? '0x0'
  return {
    iconic: /iconic=(\w+)/.exec(text)?.[1] === 'True',
    zoomed: /zoomed=(\w+)/.exec(text)?.[1] === 'True',
    rect: rect === null ? '?' : `${rect[1]},${rect[2]} ${rect[3]}x${rect[4]}`,
    style: Number.parseInt(style, 16),
  }
}

const mod = await import(`file:///${join(pluginDir, 'index.js').replace(/\\/g, '/')}`)
const routes = []
const ctx = {
  effect(factory) { factory() },
  webServer: { register(route) { routes.push(route); return () => {} } },
  connection: { requestRejection() { return undefined } },
}
for (const plugin of Array.isArray(mod.apply) ? mod.apply : [mod]) {
  if (typeof plugin?.apply === 'function') plugin.apply(ctx)
}

const overlayRoute = routes.find((r) => r.path === '/dsh-screenshot/overlay')

async function shot({ hide, drive }) {
  killLeftovers()
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(x) { if (x) chunks.push(Buffer.from(x)) },
  }
  const req = {
    method: 'GET',
    url: `/dsh-screenshot/overlay?hideWindow=${hide ? 1 : 0}`,
    headers: { host: '127.0.0.1:64601' },
  }
  const mark = logSize()
  let settled = false
  const pending = Promise.resolve(overlayRoute.handler(req, res))
    .catch(() => undefined)
    .finally(() => { settled = true })

  if (drive) await drive({ mark, isSettled: () => settled })

  // A cancelled overlay must always settle; if it did not, press Esc a few times and finally
  // reap the process so the next check does not inherit a half-open overlay.
  for (let i = 0; i < 3 && !settled; i += 1) {
    ps('key.ps1', ['-Vk', '27'])
    await sleep(700)
  }
  await Promise.race([pending, sleep(12000)])
  if (!settled) killLeftovers()
  await sleep(900)
  const body = Buffer.concat(chunks).toString('utf8')
  return { status: res.statusCode, bytes: Buffer.byteLength(body), body, log: logSince(mark), settled }
}

const cancelDrive = async ({ mark }) => {
  await waitForLog(mark, /TARGETS /)
  await sleep(500)
  ps('key.ps1', ['-Vk', '27'])
  await sleep(700)
  ps('key.ps1', ['-Vk', '27'])
  await sleep(500)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ShowWindow/SetWindowPos can race a just-minimised window, so retry until the probe agrees.
async function makeNormal(x, y, w, h) {
  for (let i = 0; i < 6; i += 1) {
    ps('set-geometry.ps1', ['-X', String(x), '-Y', String(y), '-W', String(w), '-H', String(h)])
    await sleep(500)
    const p = probe()
    if (!p.iconic && !p.zoomed && p.rect !== '?') return p
  }
  return probe()
}

check('overlay route registered', overlayRoute !== undefined)

if (overlayRoute !== undefined) {
  const initial = probe()

  // --- window preservation: normal size, twice in a row to catch accumulating drift ---
  const base = await makeNormal(500, 300, 1200, 800)
  check('window starts normal', base.zoomed === false && base.iconic === false, `${base.rect} iconic=${base.iconic}`)

  const first = await shot({ hide: true, drive: cancelDrive })
  const afterFirst = probe()
  check('hide: cancelled cleanly', first.settled && first.status === 204 && first.bytes === 0, `status=${first.status} bytes=${first.bytes} body=${first.body.slice(0, 160)}`)
  check('hide: same geometry', afterFirst.rect === base.rect, `${base.rect} -> ${afterFirst.rect}`)
  check('hide: caption buttons kept', (afterFirst.style & 0x00c00000) === 0x00c00000, afterFirst.style.toString(16))

  const second = await shot({ hide: true, drive: cancelDrive })
  const afterSecond = probe()
  check('hide: no drift on 2nd shot', second.settled && afterSecond.rect === base.rect, `${base.rect} -> ${afterSecond.rect}`)

  // --- a maximized window must come back maximized, not resized ---
  ps('set-geometry.ps1', ['-Maximize'])
  await sleep(700)
  const maxBefore = probe()
  const third = await shot({ hide: true, drive: cancelDrive })
  const maxAfter = probe()
  check('hide: maximized stays maximized', third.settled && maxBefore.zoomed && maxAfter.zoomed, `${maxBefore.rect} -> ${maxAfter.rect}`)
  check('hide: maximized geometry unchanged', maxAfter.rect === maxBefore.rect, `${maxBefore.rect} -> ${maxAfter.rect}`)

  // --- interactions: hover snap, click lock, drag move, handle resize, Enter confirm ---
  // The host window has to stay visible here: with hideWindow=1 there is nothing to snap onto
  // underneath it, so the snap check would fail for the wrong reason.
  if (wantInteractions) {
    ps('set-geometry.ps1', ['-Maximize'])
    await sleep(900)
    const view = probe()
    const [, vx, vy, vw, vh] = /(-?\d+),(-?\d+) (\d+)x(\d+)/.exec(view.rect) ?? []
    const cx = String(Number(vx) + Math.round(Number(vw) * 0.45))
    const cy = String(Number(vy) + Math.round(Number(vh) * 0.35))
    const drive = async ({ mark }) => {
      await waitForLog(mark, /TARGETS /)
      await sleep(600)
      ps('hover.ps1', ['-X', cx, '-Y', cy])
      await sleep(1000)
      ps('click.ps1', ['-X', cx, '-Y', cy])
      await sleep(800)
      ps('drag.ps1', ['-X1', cx, '-Y1', cy, '-X2', String(Number(cx) + 120), '-Y2', String(Number(cy) + 90)])
      await sleep(800)
      // Grab the bottom-right handle of whatever the move left behind; the log carries the rect
      // in physical pixels, which is exactly what drag.ps1 wants.
      const moved = [...logSince(mark).matchAll(/GRAB end rect=(-?\d+),(-?\d+),(\d+)x(\d+)/g)].pop()
      if (moved !== undefined) {
        // Grab the top-left handle: after the move the bottom-right corner can sit off-screen,
        // where SetCursorPos silently fails and the resize never starts.
        // drag.ps1 is DPI-virtualised, so its arguments are DIP -- the same unit as the log rect.
        const scale = 1
        const hx = String(Math.round((Number(moved[1]) + 2) * scale))
        const hy = String(Math.round((Number(moved[2]) + 2) * scale))
        console.log(`      · resize grab at ${hx},${hy} (box ${moved[1]},${moved[2]} ${moved[3]}x${moved[4]})`)
        ps('drag.ps1', ['-X1', hx, '-Y1', hy, '-X2', String(Number(hx) - 135), '-Y2', String(Number(hy) - 105)])
        await sleep(800)
      } else {
        console.log('      · no GRAB end rect in log, skipping resize drive')
      }
      ps('key.ps1', ['-Vk', '13'])
    }
    const run = await shot({ hide: false, drive })
    check('interaction: hover snapped a window', /SNAP /.test(run.log), (run.log.match(/SNAP [^\n]*/) ?? ['none'])[0])
    check('interaction: click locked a selection', /LOCK /.test(run.log))
    check('interaction: drag moved the box', /GRAB move/.test(run.log))
    check('interaction: handle resized the box', /GRAB resize/.test(run.log))
    check('interaction: Enter produced a PNG', run.status === 200 && run.bytes > 1000, `status=${run.status} bytes=${run.bytes}`)
  }

  // --- put the window back the way it was found ---
  killLeftovers()
  if (initial.zoomed) {
    ps('set-geometry.ps1', ['-Maximize'])
  } else {
    const [, x, y, w, h] = /(-?\d+),(-?\d+) (\d+)x(\d+)/.exec(initial.rect) ?? []
    if (x !== undefined) ps('set-geometry.ps1', ['-X', x, '-Y', y, '-W', w, '-H', h])
  }
  await sleep(500)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)