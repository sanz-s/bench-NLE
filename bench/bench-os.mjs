#!/usr/bin/env node
/**
 * One-command benchmark per OS: checks the machine, starts the bench-server (CPU/GPU sampler), builds the app,
 * runs the Playwright benchmark (bench/run.mjs), then stops the server it started.
 *
 *   npm run bench:mac   [-- options]
 *   npm run bench:linux [-- options]
 *   npm run bench:win   [-- options]
 *
 * Runs every major browser engine by default: Chrome (Blink), Firefox (Gecko) and WebKit, one after another
 * (`--browsers chrome,firefox,webkit,edge,chromium` picks others). Install Playwright's Firefox and WebKit first with
 *   npx playwright install --with-deps
 *
 * Options (everything else is passed to bench/run.mjs, e.g. --browsers, --scenario, --runs, --matrix, --trace, --aac):
 *   --check            only run the machine checks, then exit (1 if a check failed)
 *   --power            macOS: start the server with sudo + --powermetrics (CPU/GPU watts, GPU MHz, CPU clusters).
 *                      Linux: start it with sudo so RAPL package power is readable. Asks for your password once.
 *   --bench-port N     bench-server port (default 5199). A server already running there is reused, never stopped.
 *   --no-server        don't start or use a bench-server (CPU/GPU columns stay empty)
 *   --no-build         reuse the existing dist/ instead of running `vite build`
 *   --force            run even if this machine isn't the OS the script is for
 *
 * Results: a Markdown report, bench-report-<os>-<time>.md, in the folder you ran it from;
 * raw data in bench-results/run-<timestamp>.json|csv (from run.mjs) and, through the server,
 * bench-results/exports.jsonl (shown in the dashboard at http://127.0.0.1:<bench-port>/).
 */
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { lookup as dnsLookup } from 'node:dns/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSERS, INSTALL_CMD, browserAvailability, requestedBrowsers } from './browsers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = { mac: 'darwin', linux: 'linux', win: 'win32' }
const NAMES = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2)
const target = argv.shift()
const OWN_FLAGS = new Set(['--check', '--power', '--no-server', '--no-build', '--force', '--help', '-h'])
const own = new Set()
const pass = []
let benchPort = 5199
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--bench-port') benchPort = Number(argv[++i])
  else if (OWN_FLAGS.has(a)) own.add(a)
  else pass.push(a)
}
if (!TARGETS[target] || own.has('--help') || own.has('-h')) {
  const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]
  console.log(head.replace(/^#!.*\n\/\*\*?\n?/, '').replace(/^ \* ?/gm, ''))
  process.exit(TARGETS[target] ? 0 : 1)
}
if (!Number.isInteger(benchPort) || benchPort < 1 || benchPort > 65535) fail('--bench-port needs a port number')
const PLATFORM = TARGETS[target]
const passHas = (f) => pass.includes(f)
// a --server given to run.mjs means "use that server": we neither start nor check one
const externalServer = passHas('--server')
const useServer = !own.has('--no-server') && !externalServer
const SERVER_URL = `http://127.0.0.1:${benchPort}`

const log = (...a) => console.log(`[bench:${target}]`, ...a)
function fail(msg) {
  console.error(`[bench:${target ?? '?'}] ✗ ${msg}`)
  process.exit(1)
}

// ------------------------------------------------------------------ machine checks
const checks = [] // { level: 'ok' | 'warn' | 'fail', what, detail }
const ok = (what, detail = '') => checks.push({ level: 'ok', what, detail })
const warn = (what, detail = '') => checks.push({ level: 'warn', what, detail })
const bad = (what, detail = '') => checks.push({ level: 'fail', what, detail })

/** Run a command quietly; returns trimmed stdout, or null if it can't run or fails. */
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, ...opts })
  return r.status === 0 ? (r.stdout ?? '').trim() : null
}
const onPath = (cmd) => (process.platform === 'win32' ? sh('where.exe', [cmd]) : sh('/bin/sh', ['-c', `command -v ${cmd}`])) !== null

/** True on a laptop running on battery (numbers vary with power state); null if unknown. */
function onBattery() {
  if (process.platform === 'darwin') {
    const out = sh('pmset', ['-g', 'batt'])
    return out === null ? null : out.includes("'Battery Power'")
  }
  if (process.platform === 'linux') {
    try {
      const dir = '/sys/class/power_supply'
      const mains = readdirSync(dir).filter((n) => readFileSync(path.join(dir, n, 'type'), 'utf8').trim() === 'Mains')
      if (!mains.length) return null
      return mains.every((n) => readFileSync(path.join(dir, n, 'online'), 'utf8').trim() === '0')
    } catch {
      return null
    }
  }
  const out = sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus'])
  if (!out) return null // desktop: no battery
  return out.trim() === '1' // 1 = discharging, 2 = on AC
}

async function runChecks() {
  // OS
  if (process.platform === PLATFORM) ok('operating system', `${NAMES[PLATFORM]} ${os.release()} (${os.arch()})`)
  else if (own.has('--force')) warn('operating system', `this is ${NAMES[process.platform] ?? process.platform}, not ${NAMES[PLATFORM]} (--force)`)
  else bad('operating system', `this is ${NAMES[process.platform] ?? process.platform}; use npm run bench:${Object.keys(TARGETS).find((k) => TARGETS[k] === process.platform) ?? '<os>'}`)

  // the name localhost must mean this machine (Vite, Playwright and browsers rely on it)
  try {
    const addrs = (await dnsLookup('localhost', { all: true })).map((a) => a.address)
    const outside = addrs.filter((a) => !/^127\.|^::1$|^::ffff:127\./.test(a))
    if (outside.length) warn('localhost', `resolves to ${outside.join(', ')}, not only this machine (127.0.0.1). The scripts use 127.0.0.1, but other tools may break: fix /etc/hosts (Windows: C:\\Windows\\System32\\drivers\\etc\\hosts) so it has "127.0.0.1 localhost"`)
    else ok('localhost', addrs.join(', '))
  } catch (e) {
    warn('localhost', `could not resolve the name localhost (${e.code ?? e.message}); the scripts use 127.0.0.1`)
  }

  // Node + dependencies
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 18) ok('Node.js', process.versions.node)
  else bad('Node.js', `${process.versions.node}: needs 18 or newer`)
  for (const dep of ['playwright', 'vite', 'mediabunny']) {
    if (!existsSync(path.join(root, 'node_modules', dep, 'package.json'))) bad(`dependency ${dep}`, 'missing: run `npm install`')
  }
  if (own.has('--no-build') && !existsSync(path.join(root, 'dist', 'index.html'))) bad('dist/', '--no-build but dist/ is missing')

  // browsers: one per engine by default (--browsers picks others); a missing one is skipped by run.mjs
  let wanted = []
  try {
    wanted = requestedBrowsers(pass)
  } catch (e) {
    bad('browsers', e.message)
  }
  let playwright = null
  try {
    playwright = await import('playwright')
  } catch {
    /* reported as a missing dependency above */
  }
  const missing = []
  for (const key of wanted) {
    const a = browserAvailability(key, playwright)
    if (!a.ok && !a.platformSkip) missing.push(key)
    if (a.platformSkip) ok(`browser ${key}`, `skipped: ${a.fix}`)
    else if (a.ok && a.fallback) warn(`browser ${key}`, `${a.fallback}: ${a.path}`)
    else if (a.ok) ok(`browser ${key}`, `${BROWSERS[key].name} (${BROWSERS[key].engine}): ${a.path}`)
    else warn(`browser ${key}`, `${BROWSERS[key].name} not installed, will be skipped: ${a.fix}`)
  }
  if (wanted.length && wanted.every((k) => missing.includes(k) || browserAvailability(k, playwright).platformSkip)) bad('browsers', `none of ${wanted.join(', ')} can run here: run \`${INSTALL_CMD}\` (and install Google Chrome)`)
  if (process.platform === 'linux' && wanted.some((k) => ['firefox', 'chromium'].includes(k)))
    ok('browser libraries', `Playwright's Firefox/WebKit need system libraries; if one fails to start, run \`${INSTALL_CMD}\` (uses sudo apt)`)

  // headed vs headless
  if (process.platform === 'linux' && !passHas('--headless') && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    pass.push('--headless')
    warn('display', 'no DISPLAY / WAYLAND_DISPLAY: running headless, so GPU and hardware-encoder numbers may be software paths (use a desktop session or xvfb-run for headed)')
  } else if (passHas('--headless')) warn('display', '--headless: GPU and hardware-encoder numbers may be software paths')
  else ok('display', 'headed browsers (real GPU and hardware encoders)')

  // power state
  const batt = onBattery()
  if (batt === true) warn('power', 'running on battery: plug in, results vary with power state')
  else if (batt === false) ok('power', 'on AC power')
  if (process.platform === 'darwin' && /lowpowermode\s+1/.test(sh('pmset', ['-g']) ?? '')) warn('power', 'Low Power Mode is on: it throttles CPU and GPU')

  if (useServer) platformServerChecks()
}

/** What the bench-server can measure on this OS. Warnings only: the benchmark still runs without them. */
function platformServerChecks() {
  if (process.platform === 'darwin') {
    if (onPath('clang')) ok('procstat helper', 'clang found: per-process CPU + memory footprint (cheap sampler)')
    else warn('procstat helper', 'clang missing (xcode-select --install): falls back to ps, no memory footprint')
    if (onPath('ioreg')) ok('GPU %', 'ioreg (whole GPU, no sudo)')
    else warn('GPU %', 'ioreg not found: no GPU numbers')
    if (own.has('--power')) ok('power', 'powermetrics via sudo (watts, GPU MHz, CPU clusters)')
    else ok('power', 'off (add --power for watts via sudo powermetrics)')
  } else if (process.platform === 'linux') {
    if (existsSync('/proc/self/stat')) ok('CPU / memory', '/proc (per process, PSS memory)')
    else bad('CPU / memory', '/proc missing')
    linuxGpuChecks()
    const rapl = '/sys/class/powercap/intel-rapl:0/energy_uj'
    if (!existsSync(rapl)) ok('CPU power', 'no RAPL on this machine')
    else if (canRead(rapl) || own.has('--power')) ok('CPU power', own.has('--power') ? 'RAPL via sudo' : 'RAPL readable')
    else ok('CPU power', 'RAPL needs root: add --power to start the server with sudo')
    if (!onPath('ss') && !existsSync('/proc/net/tcp')) warn('attribution', 'no /proc/net/tcp: editor exports fall back to name matching')
  } else if (process.platform === 'win32') {
    if (onPath('powershell.exe')) ok('PowerShell', 'found (process, GPU-engine and battery probes)')
    else bad('PowerShell', 'powershell.exe not on PATH: the bench-server needs it on Windows')
    windowsGpuCheck()
    if (own.has('--power')) warn('power', '--power has no effect on Windows (only NVIDIA power.draw is read)')
  }
  // the results file must be writable, or records stay in memory only
  const records = path.join(process.env.BENCH_RESULTS_DIR ? path.resolve(process.env.BENCH_RESULTS_DIR) : path.join(root, 'bench-results'), 'exports.jsonl')
  if (existsSync(records) && !canWrite(records)) {
    if (own.has('--power')) ok('results file', `${path.relative(root, records)} is not writable now; the sudo server hands it back to you`)
    else warn('results file', `${path.relative(root, records)} is not writable (an earlier sudo run?). Fix: sudo chown $(whoami) ${records}`)
  }
}
/** Linux: every GPU source the bench-server can read here (it uses the first whole-GPU one, and fdinfo per process). */
function linuxGpuChecks() {
  const cards = readdirSafe('/sys/class/drm').filter((c) => /^card\d+$/.test(c))
  const drivers = cards.map((c) => path.basename(readlinkSafe(`/sys/class/drm/${c}/device/driver`) ?? '')).filter(Boolean)
  const whole = []
  if (onPath('nvidia-smi')) whole.push('nvidia-smi (NVIDIA, incl. encoder/decoder %)')
  if (cards.some((c) => existsSync(`/sys/class/drm/${c}/device/gpu_busy_percent`))) whole.push('AMD gpu_busy_percent')
  const rc6 = cards.some((c) => existsSync(`/sys/class/drm/${c}/power/rc6_residency_ms`) || readdirSafe(`/sys/class/drm/${c}/gt`).some((g) => existsSync(`/sys/class/drm/${c}/gt/${g}/rc6_residency_ms`)) || readdirSafe(`/sys/class/drm/${c}/device`).some((t) => /^tile\d+$/.test(t) && existsSync(`/sys/class/drm/${c}/device/${t}/gt0/gtidle/idle_residency_ms`)))
  if (rc6) whole.push('Intel RC6 residency (whole GPU)')
  const fd = drmFdinfoSample()
  const fdinfo = fd ? `DRM fdinfo per process (${fd.driver}${fd.cycles ? ', cycles' : ''})` : null
  const gpus = drivers.length ? `GPU driver${drivers.length > 1 ? 's' : ''}: ${[...new Set(drivers)].join(', ')}` : 'no /sys/class/drm GPU'
  if (whole.length || fdinfo) ok('GPU %', `${[...whole, fdinfo].filter(Boolean).join(' + ')} · ${gpus}`)
  else warn('GPU %', `nothing readable: no nvidia-smi, AMD gpu_busy_percent, Intel RC6 or DRM fdinfo usage stats (fdinfo needs kernel ≥ 5.19 for i915; this is ${os.release()}) · ${gpus}`)
  if (!fdinfo && whole.length) warn('browser GPU %', `no DRM fdinfo usage stats (kernel ${os.release()}; ≥ 5.19 for i915): only whole-GPU numbers`)
}
const readlinkSafe = (p) => {
  try {
    return readlinkSync(p)
  } catch {
    return null
  }
}
/** First DRM client with usage stats among your processes (bounded scan), or null. */
function drmFdinfoSample() {
  let budget = 4000
  for (const pid of readdirSafe('/proc').filter((e) => /^\d+$/.test(e))) {
    for (const fd of readdirSafe(`/proc/${pid}/fd`)) {
      if (--budget < 0) return null
      if (!(readlinkSafe(`/proc/${pid}/fd/${fd}`) ?? '').startsWith('/dev/dri/')) continue
      let text = ''
      try {
        text = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8')
      } catch {
        continue
      }
      const driver = /^drm-driver:\s*(\S+)/m.exec(text)?.[1]
      if (driver && /^drm-(?:engine|cycles)-/m.test(text)) return { driver, cycles: /^drm-cycles-/m.test(text) }
    }
  }
  return null
}
/** Windows: one reading through Get-Counter and one through CIM, with instance counts and timings. */
function windowsGpuCheck() {
  const script =
    "$sw=[Diagnostics.Stopwatch]::StartNew(); $a=@((Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples).Count; $t1=$sw.ElapsedMilliseconds; $sw.Restart(); " +
    "$b=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue).Count; $t2=$sw.ElapsedMilliseconds; \"$a $t1 $b $t2 $((Get-UICulture).Name)\""
  // -EncodedCommand (UTF-16LE base64), like the server's loops: no command-line quoting to get wrong
  const out = sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 30000 })
  const m = /(\d+) (\d+) (\d+) (\d+) (\S*)/.exec(out ?? '')
  if (!m) return warn('GPU %', 'could not read the GPU counters through PowerShell (no output)')
  const [counter, counterMs, cim, cimMs, ui] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), m[5]]
  const detail = `Get-Counter: ${counter} GPU engine instances in ${counterMs} ms · CIM: ${cim} in ${cimMs} ms · display language ${ui || '?'}`
  if (counter > 0) ok('GPU %', `${detail} (the server uses Get-Counter)`)
  else if (cim > 0) ok('GPU %', `${detail} (Get-Counter gives nothing here, so the server switches to CIM)`)
  else warn('GPU %', `${detail}: no GPU engine counters at all (needs a WDDM 2.x GPU driver; Remote Desktop and some VMs have none)`)
}
const readdirSafe = (d) => {
  try {
    return readdirSync(d)
  } catch {
    return []
  }
}
const canRead = (f) => {
  try {
    accessSync(f, constants.R_OK)
    readFileSync(f)
    return true
  } catch {
    return false
  }
}
const canWrite = (f) => {
  try {
    accessSync(f, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function printChecks() {
  const icon = { ok: '✓', warn: '⚠', fail: '✗' }
  log(`machine checks (${NAMES[PLATFORM]} benchmark):`)
  for (const c of checks) console.log(`  ${icon[c.level]} ${c.what.padEnd(17)} ${c.detail}`)
  return !checks.some((c) => c.level === 'fail')
}

// ------------------------------------------------------------------ bench-server
async function health() {
  try {
    const r = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

/** The newest change to the server's code, so a server started before it can be flagged. */
function serverSourceMtime() {
  return Math.max(...['server.mjs', 'probes.mjs', 'stats.mjs'].map((f) => statSync(path.join(root, 'bench-server', f)).mtimeMs))
}

let serverProc = null
async function ensureServer() {
  const running = await health()
  if (running) {
    log(`reusing the bench-server already running at ${SERVER_URL} (${running.platform}); it is left running afterwards`)
    if (!running.startedAt) log('⚠ that server predates this code (no startedAt in /health): restart it to get the current measurement fixes')
    else if (running.startedAt < serverSourceMtime()) log('⚠ that server was started before bench-server/ last changed: restart it to get the current code')
    if (own.has('--power') && !running.powermetrics && process.platform === 'darwin') log('⚠ --power ignored: the running server has no powermetrics (restart it with sudo … --powermetrics)')
    return
  }
  const script = path.join(root, 'bench-server', 'server.mjs')
  const serverArgs = [script, '--port', String(benchPort), '--quiet']
  let cmd = process.execPath
  let args = serverArgs
  if (own.has('--power') && process.platform !== 'win32') {
    if (process.platform === 'darwin') serverArgs.push('--powermetrics')
    log('--power: the bench-server runs with sudo (password prompt below if needed)')
    const v = spawnSync('sudo', ['-v'], { stdio: 'inherit' })
    if (v.status !== 0) fail('sudo was refused: run without --power, or check your sudo rights')
    // sudo resets the environment; keep BENCH_RESULTS_DIR. SUDO_UID lets the server hand its files back to you.
    const env = process.env.BENCH_RESULTS_DIR ? ['env', `BENCH_RESULTS_DIR=${process.env.BENCH_RESULTS_DIR}`] : []
    cmd = 'sudo'
    args = ['-n', ...env, process.execPath, ...serverArgs]
  }
  serverProc = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const prefix = (stream, out) => {
    let buf = ''
    stream.setEncoding('utf8')
    stream.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        out.write(`[server] ${buf.slice(0, i)}\n`)
        buf = buf.slice(i + 1)
      }
    })
  }
  prefix(serverProc.stdout, process.stdout)
  prefix(serverProc.stderr, process.stderr)
  let exited = null
  serverProc.on('exit', (code) => {
    exited = code
    serverProc = null
  })
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    if (exited !== null) fail(`the bench-server exited (code ${exited}) before it was ready; see [server] lines above`)
    const h = await health()
    if (h) {
      log(`bench-server started at ${SERVER_URL} (GPU: ${h.gpuSource ?? 'none'}${h.powermetrics ? ', powermetrics on' : ''}); dashboard: ${SERVER_URL}/`)
      return
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  fail(`the bench-server did not answer on ${SERVER_URL} within 20 s`)
}

function stopServer() {
  if (!serverProc) return
  // sudo forwards SIGTERM to the server; on Windows kill() terminates it and its PowerShell loops exit on their own
  serverProc.kill('SIGTERM')
  serverProc = null
}

// ------------------------------------------------------------------ build + run
function runNode(args, label, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
    current = child
    child.on('exit', (code, signal) => {
      current = null
      resolve(code ?? (signal ? 1 : 0))
    })
    child.on('error', (e) => {
      console.error(`[bench:${target}] ${label} failed to start: ${e.message}`)
      resolve(1)
    })
  })
}
let current = null

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  current?.kill('SIGINT')
  stopServer()
  process.exit(code)
}
process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))

async function main() {
  await runChecks()
  const passed = printChecks()
  if (!passed) fail('fix the ✗ items above, then run again')
  if (own.has('--check')) {
    log('checks done (--check: nothing was run)')
    return
  }
  if (useServer) await ensureServer()
  else log(externalServer ? 'using the --server given to run.mjs' : '--no-server: CPU/GPU columns will be empty')

  if (!own.has('--no-build')) {
    log('building the app (vite build)…')
    const code = await runNode([path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], 'vite build')
    if (code !== 0) {
      stopServer()
      fail(`vite build failed (exit ${code})`)
    }
  }

  // run.mjs asks --server for health/idle checks; the page reaches the server through vite preview's /bench-api
  // bridge, which reads BENCH_SERVER. Both must point at the same server.
  const runArgs = [path.join(root, 'bench', 'run.mjs'), ...pass]
  let serverUrl = SERVER_URL
  if (externalServer) serverUrl = pass[pass.indexOf('--server') + 1]
  else if (own.has('--no-server')) serverUrl = 'http://127.0.0.1:9' // nothing listens there: no CPU/GPU is recorded
  if (!externalServer && serverUrl !== 'http://127.0.0.1:5199') runArgs.push('--server', serverUrl)
  log(`running: node bench/run.mjs ${runArgs.slice(1).join(' ')}`)
  // the machine checks go into run.mjs's Markdown report
  const code = await runNode(runArgs, 'bench/run.mjs', { ...process.env, BENCH_SERVER: serverUrl, BENCH_MACHINE_CHECKS: JSON.stringify(checks) })
  stopServer()
  log(code === 0 ? 'benchmark finished: all runs verified' : `benchmark finished with failures (exit ${code}); see the report`)
  log(`results: the .md report named in the "results written to" line above (raw data in the run-*.json|csv)${useServer ? `; per-job records with CPU/GPU charts open in the dashboard (start it with npm run bench:server, then ${SERVER_URL}/)` : ''}`)
  process.exitCode = code
}

main().catch((e) => {
  console.error(e)
  shutdown(1)
})
