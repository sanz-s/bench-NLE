#!/usr/bin/env node
/**
 * One-command benchmark per OS: checks the machine, starts the bench-server (CPU/GPU sampler), builds the app,
 * runs the Playwright benchmark (bench/run.mjs), then stops the server it started.
 *
 *   npm run bench:mac   [-- options]
 *   npm run bench:linux [-- options]
 *   npm run bench:win   [-- options]
 *
 * Options (everything else is passed to bench/run.mjs, e.g. --scenario, --runs, --matrix, --trace, --aac):
 *   --check            only run the machine checks, then exit (1 if a check failed)
 *   --power            macOS: start the server with sudo + --powermetrics (CPU/GPU watts, GPU MHz, CPU clusters).
 *                      Linux: start it with sudo so RAPL package power is readable. Asks for your password once.
 *   --bench-port N     bench-server port (default 5199). A server already running there is reused, never stopped.
 *   --no-server        don't start or use a bench-server (CPU/GPU columns stay empty)
 *   --no-build         reuse the existing dist/ instead of running `vite build`
 *   --force            run even if this machine isn't the OS the script is for
 *
 * Results: bench-results/run-<timestamp>.json|csv (from run.mjs) and, through the server,
 * bench-results/exports.jsonl (shown in the dashboard at http://127.0.0.1:<bench-port>/).
 */
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

function chromePaths() {
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
  if (process.platform === 'win32') {
    const rel = 'Google\\Chrome\\Application\\chrome.exe'
    return [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map((d) => path.join(d, rel))
  }
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
}

async function bundledChromium() {
  try {
    const { chromium } = await import('playwright')
    const p = chromium.executablePath()
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

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

  // Node + dependencies
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 18) ok('Node.js', process.versions.node)
  else bad('Node.js', `${process.versions.node}: needs 18 or newer`)
  for (const dep of ['playwright', 'vite', 'mediabunny']) {
    if (!existsSync(path.join(root, 'node_modules', dep, 'package.json'))) bad(`dependency ${dep}`, 'missing: run `npm install`')
  }
  if (own.has('--no-build') && !existsSync(path.join(root, 'dist', 'index.html'))) bad('dist/', '--no-build but dist/ is missing')

  // browser
  const chrome = chromePaths().find((p) => existsSync(p))
  const bundled = await bundledChromium()
  if (passHas('--chromium')) {
    if (bundled) ok('browser', `bundled Chromium (--chromium): ${bundled}`)
    else bad('browser', '--chromium but Playwright Chromium is not installed: run `npx playwright install chromium`')
  } else if (chrome) ok('browser', `Google Chrome: ${chrome}`)
  else if (bundled) warn('browser', `Google Chrome not found, falling back to Playwright Chromium (hardware encoders may differ): ${bundled}`)
  else {
    const fix = process.platform === 'linux' ? 'install Google Chrome, or run `npx playwright install --with-deps chromium`' : 'install Google Chrome, or run `npx playwright install chromium`'
    bad('browser', `neither Google Chrome nor Playwright Chromium found: ${fix}`)
  }

  // headed vs headless
  if (process.platform === 'linux' && !passHas('--headless') && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    pass.push('--headless')
    warn('display', 'no DISPLAY / WAYLAND_DISPLAY: running headless, so GPU and hardware-encoder numbers may be software paths (use a desktop session or xvfb-run for headed)')
  } else if (passHas('--headless')) warn('display', '--headless: GPU and hardware-encoder numbers may be software paths')
  else ok('display', 'headed Chrome (real GPU and hardware encoders)')

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
    if (onPath('nvidia-smi')) ok('GPU %', 'nvidia-smi (NVIDIA, incl. encoder/decoder %)')
    else if (readdirSafe('/sys/class/drm').some((c) => existsSync(`/sys/class/drm/${c}/device/gpu_busy_percent`))) ok('GPU %', 'AMD gpu_busy_percent')
    else warn('GPU %', 'no nvidia-smi or AMD gpu_busy_percent: no GPU numbers (Intel GPUs are not read)')
    const rapl = '/sys/class/powercap/intel-rapl:0/energy_uj'
    if (!existsSync(rapl)) ok('CPU power', 'no RAPL on this machine')
    else if (canRead(rapl) || own.has('--power')) ok('CPU power', own.has('--power') ? 'RAPL via sudo' : 'RAPL readable')
    else ok('CPU power', 'RAPL needs root: add --power to start the server with sudo')
    if (!onPath('ss') && !existsSync('/proc/net/tcp')) warn('attribution', 'no /proc/net/tcp: editor exports fall back to name matching')
  } else if (process.platform === 'win32') {
    if (onPath('powershell.exe')) ok('PowerShell', 'found (process, GPU-engine and battery probes)')
    else bad('PowerShell', 'powershell.exe not on PATH: the bench-server needs it on Windows')
    const ui = sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-UICulture).Name'])
    if (ui && !/^en/i.test(ui)) warn('GPU counters', `Windows display language is ${ui}: the \\GPU Engine counters are read by English name and may be missing`)
    warn('Windows sampler', 'written but not yet verified on real Windows hardware: check the dashboard detail (method) after the first run')
    if (own.has('--power')) warn('power', '--power has no effect on Windows (only NVIDIA power.draw is read)')
  }
  // the results file must be writable, or records stay in memory only
  const records = path.join(process.env.BENCH_RESULTS_DIR ? path.resolve(process.env.BENCH_RESULTS_DIR) : path.join(root, 'bench-results'), 'exports.jsonl')
  if (existsSync(records) && !canWrite(records)) {
    if (own.has('--power')) ok('results file', `${path.relative(root, records)} is not writable now; the sudo server hands it back to you`)
    else warn('results file', `${path.relative(root, records)} is not writable (an earlier sudo run?). Fix: sudo chown $(whoami) ${records}`)
  }
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
  const code = await runNode(runArgs, 'bench/run.mjs', { ...process.env, BENCH_SERVER: serverUrl })
  stopServer()
  log(code === 0 ? 'benchmark finished: all runs verified' : `benchmark finished with failures (exit ${code}); see the summary above`)
  log(`results: the run-*.json|csv named in the "wrote" line above${useServer ? `; per-job records with CPU/GPU charts open in the dashboard (start it with npm run bench:server, then ${SERVER_URL}/)` : ''}`)
  process.exitCode = code
}

main().catch((e) => {
  console.error(e)
  shutdown(1)
})
