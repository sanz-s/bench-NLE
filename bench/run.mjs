#!/usr/bin/env node
/**
 * Playwright benchmark runner for Bunny NLE.
 *
 *   npm run bench                                   # build, serve dist/, run all scenarios ×3 in headed Chrome
 *   npm run bench -- --scenario export-h264-worker  # one scenario (comma-separate for several)
 *   npm run bench -- --runs 5 --trace               # 5 runs each, save Chrome traces
 *   npm run bench -- --matrix                       # round-trip each encodable codec (representative pairings)
 *   npm run bench -- --matrix-all                   # …every container × video × audio pairing
 *   npm run bench -- --url http://127.0.0.1:5173    # use an already running dev server
 *   npm run bench -- --browsers chrome,firefox  # which browsers (default all = chrome, firefox, webkit: one per engine;
 *                                                 also edge, chromium). Firefox/WebKit: npx playwright install --with-deps
 *   flags: --headless  --chromium (= --browsers chromium)  --out bench-results
 *          --full-verify (decode every frame/sample of each output; default for --matrix, --quick-verify turns it off)
 *          --fail-on-skip (unsupported scenarios also fail the run)
 *          --aac auto|native|wasm (AAC encoder under test; auto = the browser's own when it has one; recorded per run)
 *          --warmup N (default 1: unrecorded warm-up runs per scenario)  --cooldown S (default 3 s between runs, plus
 *          waiting for system CPU < --idle-cpu % when the bench-server is up)
 *          --report <file.md> (where the Markdown report goes; default bench-report-<os>-<time>.md, or
 *          matrix-report-<os>-<time>.md, in the folder npm was run from)
 * Medians use only runs that finished AND passed output verification. Exit code is 1 if any run failed.
 *
 * What it records per run (merged into one row):
 *   in-app   conversion time, encode time, stage split, encoder latency, fps, output verification
 *   page     main-thread Long Tasks / TBT / longest task / rAF gaps (PerformanceObserver in the page)
 *   CDP      Performance.getMetrics deltas: TaskDuration, ScriptDuration, LayoutDuration, RecalcStyleDuration,
 *            over the job only (snapshots at jobRunner's job-start / job-end gates; cdp_window says which)
 *   server   CPU / GPU / browser-process CPU from `npm run bench:server` (if running), filtered to this browser's PID tree
 */
import * as pw from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURES, SCENARIOS } from './scenarios.mjs'
import { exitCode, summarizeScenario } from './summary.mjs'
import { markdownReport } from './report-md.mjs'
import { BROWSERS, INSTALL_CMD, browserAvailability, requestedBrowsers } from './browsers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const RUNS = Math.max(1, Number(val('runs', 3)))
// warm-up runs per scenario (JIT, encoder and worker-bundle cold start); executed, logged, never counted
const WARMUP = Math.max(0, Number(val('warmup', 1)))
// pause between runs (s), then — with the bench-server up — wait (≤ 20 s) until system CPU is back near idle
const COOLDOWN_S = Math.max(0, Number(val('cooldown', 3)))
const IDLE_CPU_PCT = Number(val('idle-cpu', 25))
const OUT = path.resolve(root, val('out', 'bench-results'))
const ONLY = val('scenario', null)?.split(',')
const TRACE = has('trace')
const HEADLESS = has('headless')
// which browsers (bench/browsers.mjs): --browsers all (chrome, firefox, webkit: one per engine) is the default
const BROWSER_KEYS = requestedBrowsers(argv)
// --matrix: each video codec with one audio codec + each audio codec with the first video codec (~90 cases);
// --matrix-all: every container × video × audio pairing the browser can encode (a few hundred)
const MATRIX_ALL = has('matrix-all')
const MATRIX = has('matrix') || MATRIX_ALL
// full-file decode in the verifier (every frame/sample): on for --matrix, opt-in otherwise (slow on long outputs)
const FULL_VERIFY = has('full-verify') || (MATRIX && !has('quick-verify'))
const SERVER = val('server', 'http://127.0.0.1:5199')
// AAC encoder under test: auto (native when the browser has it) | native (WebCodecs) | wasm (@mediabunny/aac-encoder)
const AAC = val('aac', 'auto')
// the folder the user ran npm from (npm itself switches to the package root)
const CALLER_DIR = process.env.INIT_CWD || process.cwd()
const OS_NAME = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] ?? process.platform
const OS_LABEL = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[process.platform] ?? process.platform
if (!['auto', 'native', 'wasm'].includes(AAC)) throw new Error(`--aac must be auto, native or wasm (got ${AAC})`)

const log = (...a) => console.log('[bench]', ...a)

// ------------------------------------------------------------------ serve the app
async function waitFor(url, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

let previewProc = null
async function ensureApp() {
  const given = val('url', null)
  if (given) return given.replace(/\/$/, '')
  const port = Number(val('port', 4180))
  const url = `http://127.0.0.1:${port}`
  if (!existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('dist/ missing: run `npm run build` first (npm run bench does this for you)')
  previewProc = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  previewProc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
  if (!(await waitFor(url))) throw new Error(`vite preview did not start on ${url}`)
  log(`serving dist/ at ${url}`)
  return url
}

// ------------------------------------------------------------------ helpers
/** `file` relative to `dir` when it is inside it, else absolute (no ../../.. chains). */
function shortPath(file, dir) {
  const rel = path.relative(dir, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file
}

function csv(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
}

async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
}

function cdpDelta(a, b) {
  const d = (k) => ((b[k] ?? 0) - (a[k] ?? 0)) * 1000
  return {
    mainTaskMs: d('TaskDuration'),
    mainScriptMs: d('ScriptDuration'),
    mainLayoutMs: d('LayoutDuration'),
    mainStyleMs: d('RecalcStyleDuration'),
    jsHeapUsedMB: (b.JSHeapUsedSize ?? 0) / 1048576,
  }
}

/** Sleep COOLDOWN_S, then (server up) wait until system CPU is below IDLE_CPU_PCT, at most 20 s. Returns ms waited. */
async function cooldown(serverOk) {
  const t0 = Date.now()
  await new Promise((r) => setTimeout(r, COOLDOWN_S * 1000))
  if (!serverOk) return Date.now() - t0
  const until = Date.now() + 20000
  while (Date.now() < until) {
    try {
      const live = await (await fetch(`${SERVER}/live`)).json()
      if (live.cpuSystemPct != null && live.cpuSystemPct < IDLE_CPU_PCT) break
    } catch {
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return Date.now() - t0
}

function supported(caps, s) {
  const c = caps.find((x) => x.id === s.container)
  if (!c || !c.available) return `${s.container} not available`
  if (s.videoCodec && !c.video.find((v) => v.codec === s.videoCodec)?.available) return `${s.videoCodec} not encodable in this browser`
  if (s.audioCodec && !c.audio.find((a) => a.codec === s.audioCodec)?.available) return `${s.audioCodec} not encodable in this browser`
  return null
}

// ------------------------------------------------------------------ main
/** Launch options per engine. Chromium-only switches stay off Firefox and WebKit (they'd be ignored or rejected). */
function launchOptions(spec) {
  const o = {
    // Playwright's control socket. Without a host it listens on the NAME "localhost", which fails with
    // EADDRNOTAVAIL ("address not available") where localhost resolves to an address that isn't up (e.g. ::1 with
    // IPv6 disabled). The IPv4 loopback is always there, and it's what vite preview and the bench-server use too.
    host: '127.0.0.1',
    headless: HEADLESS,
  }
  if (spec.type === 'chromium') {
    o.args = ['--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
    if (spec.channel) o.channel = spec.channel
  }
  if (spec.type === 'firefox') o.firefoxUserPrefs = { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 }
  return o
}

async function main() {
  const appUrl = await ensureApp()
  let serverOk = false
  try {
    serverOk = (await fetch(`${SERVER}/health`)).ok
  } catch {
    /* not running */
  }
  log(serverOk ? `bench-server online at ${SERVER}: CPU/GPU will be recorded` : 'bench-server offline: CPU/GPU columns will be empty (start it with `npm run bench:server`)')
  log(`browsers: ${BROWSER_KEYS.map((k) => BROWSERS[k].name).join(', ')}`)
  log(`output verification: ${FULL_VERIFY ? 'full decode (every frame and sample)' : 'head + tail decode'}`)

  mkdirSync(OUT, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const allReports = []
  const rows = []
  const summary = []
  const browsersRun = [] // { key, name, engine, status: ran | skipped | failed, version, isolated, pid, note }
  // Each generated fixture is made ONCE (in the first browser that needs it) and the same file is imported into the
  // others, so every engine converts identical input bytes (each browser's own encoder would make a different file).
  const fixtureDir = path.join(OUT, `.fixtures-${stamp}`)
  const fixtureFiles = {} // key → { path, madeIn }

  for (const key of BROWSER_KEYS) {
    const spec = { key, ...BROWSERS[key] }
    const info = { key, name: spec.name, engine: spec.engine, status: 'ran', version: null, isolated: null, pid: null, note: '' }
    browsersRun.push(info)
    const avail = browserAvailability(key, pw)
    if (!avail.ok) {
      info.status = 'skipped'
      info.platformSkip = !!avail.platformSkip
      info.note = avail.platformSkip ? avail.fix : `not installed: ${avail.fix}`
      log(`skip ${spec.name}: ${info.note}`)
      continue
    }
    if (avail.fallback) {
      spec.name = 'Chromium (Playwright build)'
      delete spec.channel
      info.name = spec.name
      info.note = avail.fallback
      log(avail.fallback)
    }
    try {
      await runBrowser(spec, info, { appUrl, serverOk, stamp, allReports, rows, summary, fixtureDir, fixtureFiles })
    } catch (err) {
      info.status = 'failed'
      info.note = err.message.split('\n')[0]
      log(`${spec.name} FAILED: ${info.note}`)
    }
  }

  rmSync(fixtureDir, { recursive: true, force: true })
  const base = path.join(OUT, `${MATRIX ? 'matrix' : 'run'}-${stamp}`)
  writeFileSync(`${base}.json`, JSON.stringify({ createdAt: new Date().toISOString(), browsers: browsersRun, fixtures: fixtureFiles, headless: HEADLESS, serverOk, runs: RUNS, summary, reports: allReports }, null, 2))
  writeFileSync(`${base}.csv`, csv(rows))
  log(`wrote ${shortPath(base, root)}.json and .csv${TRACE ? ` (+ traces in ${shortPath(OUT, root)}/traces)` : ''}`)

  // the results go to a Markdown file, not a console table (wide tables wrap and misalign in a terminal)
  const firstReport = allReports.find((r) => !r.warmup) ?? allReports[0]
  const cond = firstReport?.system?.conditions
  const env = {
    Date: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    OS: `${OS_LABEL} ${os.release()} (${os.arch()})`,
    CPU: `${os.cpus()[0]?.model?.trim() ?? 'unknown'} × ${os.cpus().length} threads`,
    RAM: `${Math.round(os.totalmem() / 1073741824)} GB`,
    Node: process.version,
    'Browser mode': HEADLESS ? 'headless (GPU numbers may be software)' : 'headed (real GPU and hardware encoders)',
    'Bench-server (CPU/GPU)': serverOk ? `online at ${SERVER}` : 'offline: CPU/GPU columns are empty',
    // where the GPU numbers come from, or why there are none (from the bench-server's method notes)
    'GPU source': serverOk ? (firstReport?.system?.method?.gpu ?? 'unknown (no job reached the bench-server)') : null,
    'Browser GPU source': serverOk ? (firstReport?.system?.method?.processGpu ?? null) : null,
    'Power source': cond ? [cond.powerSource, cond.batteryPct != null ? `${cond.batteryPct}%` : null, cond.lowPowerMode ? 'Low Power Mode ON' : null].filter(Boolean).join(', ') || null : null,
    Thermal: cond ? [cond.thermalWarning != null && cond.thermalWarning !== 'none' && `thermal warning level ${cond.thermalWarning}`, cond.performanceWarning != null && cond.performanceWarning !== 'none' && `performance warning level ${cond.performanceWarning}`, cond.cpuSpeedLimitPct != null && cond.cpuSpeedLimitPct < 100 && `CPU limited to ${cond.cpuSpeedLimitPct}%`, cond.maxTempC != null && `max ${Math.round(cond.maxTempC)} °C`].filter(Boolean).join(', ') || 'no warnings' : null,
    ...(MATRIX ? {} : { 'Runs per scenario': `${RUNS} (+ ${WARMUP} warm-up, not counted)`, 'Cool-down': `${COOLDOWN_S} s${serverOk ? `, then wait for CPU < ${IDLE_CPU_PCT}%` : ''}` }),
    'Test clips': Object.keys(fixtureFiles).length
      ? Object.entries(fixtureFiles).map(([k, f]) => `${k} made in ${f.madeIn}`).join(', ') + (browsersRun.filter((b) => b.status === 'ran').length > 1 ? '; the same files were imported into every browser' : '')
      : null,
    'AAC encoder': AAC,
    'Output check': FULL_VERIFY ? 'full decode (every frame and sample)' : 'first frames + last frame + audio tail',
  }
  let checks = []
  try {
    checks = JSON.parse(process.env.BENCH_MACHINE_CHECKS || '[]')
  } catch {
    /* not from bench-os */
  }
  const reportFile = path.resolve(CALLER_DIR, val('report', `${MATRIX ? 'matrix' : 'bench'}-report-${OS_NAME}-${stamp}.md`))
  mkdirSync(path.dirname(reportFile), { recursive: true })
  writeFileSync(
    reportFile,
    markdownReport({
      title: `${MATRIX ? 'Format matrix' : 'Benchmark'} report: ${OS_LABEL}`,
      env,
      browsers: browsersRun,
      mode: MATRIX ? 'matrix' : 'scenarios',
      summary,
      rows,
      checks,
      command: `node bench/run.mjs ${argv.join(' ')}`.trim(),
      files: [`${base}.json`, `${base}.csv`].map((f) => shortPath(f, path.dirname(reportFile))),
    }),
  )
  log(`results written to ${reportFile}`)
  previewProc?.kill()

  // Non-zero exit when any run errored or its output failed verification, or a browser crashed (so CI can't accept
  // bad results). A browser that isn't installed counts as skipped.
  const runRows = rows.filter((r) => r.run !== 'median')
  // WebKit on Linux/Windows is skipped by design (Safari is macOS-only), so it never counts for --fail-on-skip
  const skipped = summary.filter((x) => x.skipped).length + browsersRun.filter((b) => b.status === 'skipped' && !b.platformSkip).length
  const failedRuns = runRows.filter((r) => !(r.status === 'done' && r.verified === true))
  const failedBrowsers = browsersRun.filter((b) => b.status === 'failed')
  if (skipped) log(`${skipped} scenario(s) or browser(s) skipped (not supported or not installed here); listed in the report`)
  if (failedRuns.length) log(`FAILED: ${failedRuns.length}/${runRows.length} run(s) errored or failed output verification`)
  if (failedBrowsers.length) log(`FAILED: ${failedBrowsers.map((b) => b.name).join(', ')} could not run`)
  if (!browsersRun.some((b) => b.status === 'ran')) log(`no browser ran. Install them with: ${INSTALL_CMD}`)
  process.exitCode = failedBrowsers.length || !browsersRun.some((b) => b.status === 'ran') ? 1 : exitCode(runRows, { skipped, failOnSkip: has('fail-on-skip') })
}

/** Everything for one browser: launch, open the app, fixtures, scenarios (or the matrix), close. */
async function runBrowser(spec, info, { appUrl, serverOk, stamp, allReports, rows, summary, fixtureDir, fixtureFiles }) {
  const type = pw[spec.type]
  const isChromium = spec.type === 'chromium'
  const tag = spec.key
  const blog = (...a) => console.log(`[bench ${tag}]`, ...a)
  const launchOpts = launchOptions(spec)
  let server
  try {
    server = await type.launchServer(launchOpts)
  } catch (err) {
    // installed Chrome failed to start: try Playwright's Chromium (not for socket errors: another browser won't help)
    if (spec.key !== 'chrome' || /EADDR|listen/i.test(err.message) || !browserAvailability('chromium', pw).ok) throw err
    blog(`could not launch installed Chrome (${err.message.split('\n')[0]}); falling back to Playwright Chromium`)
    delete launchOpts.channel
    spec.name = info.name = 'Chromium (Playwright build)'
    info.note = 'Google Chrome failed to start: Playwright Chromium was used instead'
    server = await type.launchServer(launchOpts)
  }
  const browserPid = server.process().pid
  const browser = await type.connect(server.wsEndpoint())
  try {
    info.version = browser.version()
    info.pid = browserPid
    blog(`${spec.name} ${browser.version()} pid ${browserPid}${HEADLESS ? ' (headless: GPU numbers may be software)' : ''}`)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: false })
    const page = await context.newPage()
    page.on('console', (m) => m.type() === 'error' && console.error(`[page ${tag}] ${m.text()}`))
    page.on('pageerror', (e) => console.error(`[page error ${tag}] ${e.message}`))
    await page.goto(`${appUrl}/?bench=1`)
    try {
      await page.waitForFunction(() => window.__nleBench?.ready === true, null, { timeout: 30000 })
    } catch {
      // one reload: a transient bad first load (seen once: an HTTP 429 challenge page from outside this project)
      blog('app not ready after 30 s; reloading once')
      await page.reload()
      await page.waitForFunction(() => window.__nleBench?.ready === true, null, { timeout: 30000 })
    }
    const isolated = await page.evaluate(() => crossOriginIsolated)
    info.isolated = isolated
    if (!isolated) blog('WARNING: page is not cross-origin isolated; extension WASM will use slower threading')
    await page.evaluate((pid) => window.__nleBench.setRootPid(pid), browserPid)
    await page.evaluate((on) => (on ? localStorage.setItem('bench.fullVerify', '1') : localStorage.removeItem('bench.fullVerify')), FULL_VERIFY)
    await page.evaluate((m) => localStorage.setItem('bench.aacEncoder', m), AAC)
    const selfTest = await page.evaluate(() => window.__nleBench.selfTestMainThread())
    blog(
      selfTest.longTaskSupported
        ? `main-thread probe self-test (3 × 120 ms injected): ${selfTest.longTasks} long tasks, TBT ${Math.round(selfTest.tbtMs)} ms, longest ${Math.round(selfTest.longestTaskMs)} ms`
        : 'no Long Tasks API in this browser: TBT and longest task are not measured (frame gaps are)',
    )
    // CDP (main-thread task time) and Chrome tracing exist only in Chromium
    const cdp = isChromium ? await context.newCDPSession(page) : null
    if (cdp) await cdp.send('Performance.enable', { timeDomain: 'timeTicks' })
    if (TRACE && !isChromium) blog('--trace is Chromium-only: no trace for this browser')
    // jobRunner calls this right before and right after the job; the page waits while we snapshot
    let gateSnaps = {}
    await page.exposeFunction('__nleBenchGate', async (name) => {
      if (cdp) gateSnaps[name] = await cdpMetrics(cdp)
    })

    const caps = await page.evaluate(() => window.__nleBench.capabilities())

    // fixtures: real files from bench/fixtures/, or generated once (first browser) and shared with the others
    const fixtureIds = {}
    async function importFile(file) {
      const before = await page.evaluate(() => window.__nleBench.assets().length)
      await page.setInputFiles('#file-import', file)
      await page.waitForFunction((n) => window.__nleBench.assets().length > n, before, { timeout: 60000 })
      return page.evaluate(() => window.__nleBench.assets().at(-1).id)
    }
    async function fixture(key) {
      if (fixtureIds[key]) return fixtureIds[key]
      if (key.startsWith('file:')) fixtureIds[key] = await importFile(path.join(root, 'bench', 'fixtures', key.slice(5)))
      else if (fixtureFiles[key]) {
        blog(`importing fixture ${key} (made in ${fixtureFiles[key].madeIn})`)
        fixtureIds[key] = await importFile(fixtureFiles[key].path)
      } else {
        blog(`generating fixture ${key} with Mediabunny…`)
        fixtureIds[key] = await page.evaluate((spec) => window.__nleBench.generateFixture(spec), FIXTURES[key])
        const f = await page.evaluate((id) => window.__nleBench.assetBase64(id), fixtureIds[key])
        mkdirSync(fixtureDir, { recursive: true })
        const file = path.join(fixtureDir, `${key}${path.extname(f.name) || '.mp4'}`)
        writeFileSync(file, Buffer.from(f.b64, 'base64'))
        fixtureFiles[key] = { path: file, madeIn: spec.name, bytes: Buffer.byteLength(f.b64, 'base64') }
      }
      return fixtureIds[key]
    }

    const who = { browser: spec.key, engine: spec.engine }
    async function runOne(sc, runIndex) {
      const assetId = await fixture(sc.fixture)
      if (sc.type === 'export') {
        const [w, h] = sc.projectSize ?? [1920, 1080]
        await page.evaluate(([w, h, id, kind]) => {
          window.__nleBench.reset(w, h, 30)
          if (kind === 'effects') window.__nleBench.buildEffectsTimeline(id)
          else window.__nleBench.buildTestTimeline(id)
        }, [w, h, assetId, sc.timeline ?? 'basic'])
      }
      const before = cdp ? await cdpMetrics(cdp) : null
      gateSnaps = {}
      const tracing = TRACE && isChromium
      if (tracing) {
        mkdirSync(path.join(OUT, 'traces'), { recursive: true })
        await browser.startTracing(page, { path: path.join(OUT, 'traces', `${stamp}_${tag}_${sc.id}_${runIndex}.json`), categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'toplevel', 'v8', 'blink', 'gpu', 'media'] })
      }
      const label = `${tag} · ${sc.id} #${runIndex + 1}`
      const report = await page.evaluate(
        async ([sc, assetId, label]) => {
          const b = window.__nleBench
          return sc.type === 'export'
            ? b.exportTimeline(sc.settings, { runIn: sc.runIn ?? 'worker', label })
            : b.convert(assetId, sc.settings, { engine: sc.engine, allowCopy: sc.allowCopy ?? true, runIn: sc.runIn ?? 'worker', label })
        },
        [sc, assetId, label],
      )
      if (tracing) await browser.stopTracing()
      if (cdp) {
        const after = await cdpMetrics(cdp)
        // job-only window when the page reached both gates (jobRunner.gate); else the whole evaluate (incl. verification)
        const job = gateSnaps['job-start'] && gateSnaps['job-end']
        report.cdp = { ...(job ? cdpDelta(gateSnaps['job-start'], gateSnaps['job-end']) : cdpDelta(before, after)), window: job ? 'job' : 'whole-run', wholeRunTaskMs: cdpDelta(before, after).mainTaskMs }
      }
      report.browser = { key: spec.key, name: spec.name, engine: spec.engine, version: info.version }
      const row = await page.evaluate((r) => window.__nleBench.flatten(r), report)
      return { report, row: { ...who, scenario: sc.id, run: runIndex + 1, ...row } }
    }

    if (MATRIX) {
      const key = 'matrix_small'
      await fixture(key)
      const combos = []
      for (const c of caps.filter((x) => x.available)) {
        const vids = c.video.filter((x) => x.available).map((x) => x.codec)
        const auds = c.audio.filter((x) => x.available).map((x) => x.codec)
        if (c.audioOnly) for (const a of auds) combos.push({ container: c.id, videoCodec: null, audioCodec: a })
        else if (MATRIX_ALL) for (const vc of vids) for (const a of auds.length ? auds : [null]) combos.push({ container: c.id, videoCodec: vc, audioCodec: a })
        else {
          for (const vc of vids) combos.push({ container: c.id, videoCodec: vc, audioCodec: auds.includes('aac') ? 'aac' : auds.includes('opus') ? 'opus' : (auds[0] ?? null) })
          for (const a of auds) if (vids[0]) combos.push({ container: c.id, videoCodec: vids[0], audioCodec: a })
        }
      }
      const seen = new Set()
      blog(`matrix${MATRIX_ALL ? ' (all pairings)' : ' (representative pairings; --matrix-all for every one)'}: ${combos.length} candidates`)
      for (const s of combos) {
        const k = `${s.container}/${s.videoCodec}/${s.audioCodec}`
        if (seen.has(k)) continue
        seen.add(k)
        const sc = { id: `matrix-${s.container}-${s.videoCodec ?? 'none'}-${s.audioCodec ?? 'none'}`, type: 'convert', fixture: key, engine: 'conversion', allowCopy: false, settings: s }
        let report, row
        try {
          ;({ report, row } = await runOne(sc, 0))
        } catch (err) {
          const msg = err.message.split('\n')[0]
          rows.push({ ...who, scenario: sc.id, run: 1, status: 'error', verified: null, error: msg })
          summary.push({ ...who, combo: k, status: 'error', verified: null, ms: null, problem: msg })
          blog(`${k}: error · ${msg}`)
          continue
        }
        allReports.push(report)
        rows.push(row)
        const entry = { ...who, combo: k, status: report.status, verified: report.verify?.ok ?? null, ms: Math.round(report.derived.conversionMs), problem: report.error ?? report.verify?.problems?.[0] ?? '' }
        summary.push(entry)
        blog(`${k}: ${entry.status}${entry.verified === true ? ', verified' : entry.verified === false ? ', NOT verified' : ''} · ${entry.ms} ms${entry.problem ? ` · ${entry.problem}` : ''}`)
      }
      return
    }

    const list = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.id))
    if (!list.length) throw new Error(`no scenario matches ${ONLY}. Available: ${SCENARIOS.map((s) => s.id).join(', ')}`)
    for (const sc of list) {
      // capabilities at THIS scenario's output size (a 4K encode may be unsupported where 1080p works)
      const [w, h] = [sc.settings.width ?? sc.projectSize?.[0] ?? 1920, sc.settings.height ?? sc.projectSize?.[1] ?? 1080]
      const scCaps = await page.evaluate((q) => window.__nleBench.capabilities(q), { width: w, height: h, fps: sc.settings.fps ?? 30 })
      let why = supported(scCaps, sc.settings)
      // a hardware preference narrows it further: no hardware encoder (Linux, Firefox) means skip, not fail
      if (!why && sc.settings.videoCodec && sc.settings.hardwareAcceleration && sc.settings.hardwareAcceleration !== 'no-preference') {
        const ok = await page.evaluate(({ patch, q }) => window.__nleBench.canEncodeVideoAs(patch, q), { patch: sc.settings, q: { width: w, height: h, fps: sc.settings.fps ?? 30 } }).catch(() => true)
        if (!ok) why = `no ${sc.settings.hardwareAcceleration === 'prefer-hardware' ? 'hardware' : 'software'} ${sc.settings.videoCodec} encoder at ${w}×${h} in this browser`
      }
      if (why) {
        blog(`skip ${sc.id}: ${why}`)
        summary.push({ ...who, scenario: sc.id, status: `skipped (${why})`, skipped: true, reason: why })
        continue
      }
      const scRows = []
      try {
        for (let i = 0; i < WARMUP; i++) {
          const { report } = await runOne(sc, -1 - i)
          allReports.push({ ...report, warmup: true })
          blog(`${sc.id} warm-up ${i + 1}/${WARMUP}: ${report.status} ${Math.round(report.derived.conversionMs)} ms (not counted)`)
          await cooldown(serverOk)
        }
        for (let i = 0; i < RUNS; i++) {
          if (i > 0) await cooldown(serverOk)
          const { report, row } = await runOne(sc, i)
          allReports.push(report)
          rows.push(row)
          scRows.push(row)
          blog(
            `${sc.id} #${i + 1}: ${report.status} conv ${Math.round(report.derived.conversionMs)} ms · enc wait ${report.derived.encodeWaitMs === null ? 'pipelined' : Math.round(report.derived.encodeWaitMs) + ' ms'} · ${row.realtimeX ?? '—'}× · TBT ${row.mtTbtMs ?? '—'} ms · CPU ${row.sysCpuAvg ?? '—'}% · GPU ${row.gpuAvg ?? '—'}%${report.error ? ` · ${report.error}` : ''}`,
          )
        }
      } catch (err) {
        // one scenario that throws (import timeout, page error) fails that scenario, not the whole browser
        const msg = err.message.split('\n')[0]
        blog(`${sc.id}: ${msg}`)
        const row = { ...who, scenario: sc.id, run: scRows.length + 1, status: 'error', verified: null, error: msg }
        rows.push(row)
        scRows.push(row)
      }
      // medians only from runs that finished AND passed output verification
      const sum = summarizeScenario(scRows)
      if (sum.failed) blog(`${sc.id}: ${sum.failed}/${sum.runs} run(s) failed — ${sum.firstFailure}`)
      if (sum.median) {
        const m = sum.median
        rows.push(m)
        summary.push({ ...who, scenario: sc.id, status: sum.failed ? 'some runs failed' : 'passed', passedRuns: `${sum.passed}/${sum.runs}`, medianOfRun: m.medianOfRun, median: m })
      } else summary.push({ ...who, scenario: sc.id, status: 'FAILED', failedAll: true, passedRuns: `0/${sum.runs}`, error: sum.firstFailure })
    }
    // the next browser starts on an idle machine
    await cooldown(serverOk)
  } finally {
    await browser.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error(err)
  previewProc?.kill()
  process.exit(1)
})

