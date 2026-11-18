#!/usr/bin/env node
/**
 * Playwright benchmark runner for Bunny NLE.
 *
 *   npm run bench                                   # build, serve dist/, run all scenarios ×3 in headed Chrome
 *   npm run bench -- --scenario export-h264-worker  # one scenario (comma-separate for several)
 *   npm run bench -- --runs 5 --trace               # 5 runs each, save Chrome traces
 *   npm run bench -- --matrix                       # round-trip every encodable container/codec pair
 *   npm run bench -- --url http://localhost:5173    # use an already running dev server
 *   flags: --headless  --chromium (bundled Chromium instead of installed Chrome)  --out bench-results
 *          --full-verify (decode every frame/sample of each output; default for --matrix, --quick-verify turns it off)
 *          --fail-on-skip (unsupported scenarios also fail the run)
 *          --aac auto|native|wasm (AAC encoder under test; auto = the browser's own when it has one; recorded per run)
 * Medians use only runs that finished AND passed output verification. Exit code is 1 if any run failed.
 *
 * What it records per run (merged into one row):
 *   in-app   conversion time, encode time, stage split, encoder latency, fps, output verification
 *   page     main-thread Long Tasks / TBT / longest task / rAF gaps (PerformanceObserver in the page)
 *   CDP      Performance.getMetrics deltas: TaskDuration, ScriptDuration, LayoutDuration, RecalcStyleDuration,
 *            over the job only (snapshots at jobRunner's job-start / job-end gates; cdp_window says which)
 *   server   CPU / GPU / browser-process CPU from `npm run bench:server` (if running), filtered to this browser's PID tree
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURES, SCENARIOS } from './scenarios.mjs'
import { exitCode, summarizeScenario } from './summary.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const RUNS = Math.max(1, Number(val('runs', 3)))
const OUT = path.resolve(root, val('out', 'bench-results'))
const ONLY = val('scenario', null)?.split(',')
const TRACE = has('trace')
const HEADLESS = has('headless')
const BUNDLED = has('chromium')
const MATRIX = has('matrix')
// full-file decode in the verifier (every frame/sample): on for --matrix, opt-in otherwise (slow on long outputs)
const FULL_VERIFY = has('full-verify') || (MATRIX && !has('quick-verify'))
const SERVER = val('server', 'http://127.0.0.1:5199')
// AAC encoder under test: auto (native when the browser has it) | native (WebCodecs) | wasm (@mediabunny/aac-encoder)
const AAC = val('aac', 'auto')
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

function supported(caps, s) {
  const c = caps.find((x) => x.id === s.container)
  if (!c || !c.available) return `${s.container} not available`
  if (s.videoCodec && !c.video.find((v) => v.codec === s.videoCodec)?.available) return `${s.videoCodec} not encodable in this browser`
  if (s.audioCodec && !c.audio.find((a) => a.codec === s.audioCodec)?.available) return `${s.audioCodec} not encodable in this browser`
  return null
}

// ------------------------------------------------------------------ main
async function main() {
  const appUrl = await ensureApp()
  let serverOk = false
  try {
    serverOk = (await fetch(`${SERVER}/health`)).ok
  } catch {
    /* not running */
  }
  log(serverOk ? `bench-server online at ${SERVER}: CPU/GPU will be recorded` : 'bench-server offline: CPU/GPU columns will be empty (start it with `npm run bench:server`)')

  const launchOpts = {
    headless: HEADLESS,
    args: ['--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  }
  if (!BUNDLED) launchOpts.channel = 'chrome'
  let server
  try {
    server = await chromium.launchServer(launchOpts)
  } catch (err) {
    if (BUNDLED) throw err
    log(`could not launch installed Chrome (${err.message.split('\n')[0]}); falling back to bundled Chromium`)
    delete launchOpts.channel
    server = await chromium.launchServer(launchOpts)
  }
  const browserPid = server.process().pid
  const browser = await chromium.connect(server.wsEndpoint())
  log(`browser ${browser.version()} pid ${browserPid}${HEADLESS ? ' (headless: GPU numbers may be software)' : ''}`)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: false })
  const page = await context.newPage()
  page.on('console', (m) => m.type() === 'error' && console.error(`[page] ${m.text()}`))
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`))
  await page.goto(`${appUrl}/?bench=1`)
  await page.waitForFunction(() => window.__nleBench?.ready === true, null, { timeout: 30000 })
  const isolated = await page.evaluate(() => crossOriginIsolated)
  if (!isolated) log('WARNING: page is not cross-origin isolated; extension WASM will use slower threading')
  await page.evaluate((pid) => window.__nleBench.setRootPid(pid), browserPid)
  await page.evaluate((on) => (on ? localStorage.setItem('bench.fullVerify', '1') : localStorage.removeItem('bench.fullVerify')), FULL_VERIFY)
  await page.evaluate((m) => localStorage.setItem('bench.aacEncoder', m), AAC)
  log(`output verification: ${FULL_VERIFY ? 'full decode (every frame and sample)' : 'head + tail decode'}`)
  const selfTest = await page.evaluate(() => window.__nleBench.selfTestMainThread())
  log(`main-thread probe self-test (3 × 120 ms injected): ${selfTest.longTasks} long tasks, TBT ${Math.round(selfTest.tbtMs)} ms, longest ${Math.round(selfTest.longestTaskMs)} ms${selfTest.longTaskSupported ? '' : ' (Long Tasks API unsupported!)'}`)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable', { timeDomain: 'timeTicks' })
  // jobRunner calls this right before and right after the job; the page waits while we snapshot
  let gateSnaps = {}
  await page.exposeFunction('__nleBenchGate', async (name) => {
    gateSnaps[name] = await cdpMetrics(cdp)
  })

  const caps = await page.evaluate(() => window.__nleBench.capabilities())
  mkdirSync(OUT, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  // fixtures (generated once)
  const fixtureIds = {}
  async function fixture(key) {
    if (fixtureIds[key]) return fixtureIds[key]
    if (key.startsWith('file:')) {
      const file = path.join(root, 'bench', 'fixtures', key.slice(5))
      const before = await page.evaluate(() => window.__nleBench.assets().length)
      await page.setInputFiles('#file-import', file)
      await page.waitForFunction((n) => window.__nleBench.assets().length > n, before, { timeout: 60000 })
      fixtureIds[key] = await page.evaluate(() => window.__nleBench.assets().at(-1).id)
    } else {
      log(`generating fixture ${key} with Mediabunny…`)
      fixtureIds[key] = await page.evaluate((spec) => window.__nleBench.generateFixture(spec), FIXTURES[key])
    }
    return fixtureIds[key]
  }

  const allReports = []
  const rows = []
  const summary = []

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
    const before = await cdpMetrics(cdp)
    gateSnaps = {}
    if (TRACE) {
      mkdirSync(path.join(OUT, 'traces'), { recursive: true })
      await browser.startTracing(page, { path: path.join(OUT, 'traces', `${stamp}_${sc.id}_${runIndex}.json`), categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'toplevel', 'v8', 'blink', 'gpu', 'media'] })
    }
    const label = `${sc.id} #${runIndex + 1}`
    const report = await page.evaluate(
      async ([sc, assetId, label]) => {
        const b = window.__nleBench
        return sc.type === 'export'
          ? b.exportTimeline(sc.settings, { runIn: sc.runIn ?? 'worker', label })
          : b.convert(assetId, sc.settings, { engine: sc.engine, allowCopy: sc.allowCopy ?? true, runIn: sc.runIn ?? 'worker', label })
      },
      [sc, assetId, label],
    )
    if (TRACE) await browser.stopTracing()
    const after = await cdpMetrics(cdp)
    // job-only window when the page reached both gates (jobRunner.gate); else the whole evaluate (incl. verification)
    const job = gateSnaps['job-start'] && gateSnaps['job-end']
    report.cdp = { ...(job ? cdpDelta(gateSnaps['job-start'], gateSnaps['job-end']) : cdpDelta(before, after)), window: job ? 'job' : 'whole-run', wholeRunTaskMs: cdpDelta(before, after).mainTaskMs }
    const row = await page.evaluate((r) => window.__nleBench.flatten(r), report)
    return { report, row: { scenario: sc.id, run: runIndex + 1, ...row } }
  }

  if (MATRIX) {
    const key = 'matrix_small'
    await fixture(key)
    const combos = []
    for (const c of caps.filter((x) => x.available)) {
      const vids = c.video.filter((x) => x.available).map((x) => x.codec)
      const auds = c.audio.filter((x) => x.available).map((x) => x.codec)
      if (c.audioOnly) for (const a of auds) combos.push({ container: c.id, videoCodec: null, audioCodec: a })
      else {
        for (const vc of vids) combos.push({ container: c.id, videoCodec: vc, audioCodec: auds.includes('aac') ? 'aac' : auds.includes('opus') ? 'opus' : (auds[0] ?? null) })
        for (const a of auds) if (vids[0]) combos.push({ container: c.id, videoCodec: vids[0], audioCodec: a })
      }
    }
    const seen = new Set()
    log(`matrix: ${combos.length} combinations`)
    for (const s of combos) {
      const k = `${s.container}/${s.videoCodec}/${s.audioCodec}`
      if (seen.has(k)) continue
      seen.add(k)
      const sc = { id: `matrix-${s.container}-${s.videoCodec ?? 'none'}-${s.audioCodec ?? 'none'}`, type: 'convert', fixture: key, engine: 'conversion', allowCopy: false, settings: s }
      const { report, row } = await runOne(sc, 0)
      allReports.push(report)
      rows.push(row)
      summary.push({ combo: k, status: report.status, verified: report.verify?.ok ?? null, ms: Math.round(report.derived.conversionMs), problem: report.error ?? report.verify?.problems?.[0] ?? '' })
    }
    console.table(summary)
  } else {
    const list = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.id))
    if (!list.length) throw new Error(`no scenario matches ${ONLY}. Available: ${SCENARIOS.map((s) => s.id).join(', ')}`)
    for (const sc of list) {
      const why = supported(caps, sc.settings)
      if (why) {
        log(`skip ${sc.id}: ${why}`)
        summary.push({ scenario: sc.id, status: `skipped (${why})` })
        continue
      }
      const scRows = []
      for (let i = 0; i < RUNS; i++) {
        const { report, row } = await runOne(sc, i)
        allReports.push(report)
        rows.push(row)
        scRows.push(row)
        log(
          `${sc.id} #${i + 1}: ${report.status} conv ${Math.round(report.derived.conversionMs)} ms · enc ${report.derived.encodeMs === null ? 'pipelined' : Math.round(report.derived.encodeMs) + ' ms'} · ${row.realtimeX ?? '—'}× · TBT ${row.mtTbtMs ?? '—'} ms · CPU ${row.sysCpuAvg ?? '—'}% · GPU ${row.gpuAvg ?? '—'}%${report.error ? ` · ${report.error}` : ''}`,
        )
      }
      // medians only from runs that finished AND passed output verification
      const sum = summarizeScenario(scRows)
      if (sum.failed) log(`${sc.id}: ${sum.failed}/${sum.runs} run(s) failed — ${sum.firstFailure}`)
      if (sum.median) {
        const m = sum.median
        rows.push(m)
        summary.push({
          scenario: sc.id,
          'passed/runs': `${sum.passed}/${sum.runs}`,
          runIn: m.runIn,
          audioEnc: m.audioEncoderImpl,
          convMs: m.conversionMs,
          encMs: m.encodeMs,
          'x realtime': m.realtimeX,
          fps: m.encodeFps,
          tbtMs: m.mtTbtMs,
          longestMs: m.mtLongestMs,
          cdpMainMs: m.cdp_mainTaskMs,
          'cpu%': m.sysCpuAvg,
          'browser%': m.browserCpuAvg,
          'gpu%': m.gpuAvg,
          MB: m.outBytes ? +(m.outBytes / 1048576).toFixed(2) : null,
          verified: m.verified,
        })
      } else summary.push({ scenario: sc.id, 'passed/runs': `0/${sum.runs}`, status: 'FAILED', error: sum.firstFailure })
    }
    console.table(summary)
  }

  const base = path.join(OUT, `${MATRIX ? 'matrix' : 'run'}-${stamp}`)
  writeFileSync(`${base}.json`, JSON.stringify({ createdAt: new Date().toISOString(), browser: browser.version(), headless: HEADLESS, isolated, serverOk, runs: RUNS, summary, reports: allReports }, null, 2))
  writeFileSync(`${base}.csv`, csv(rows))
  log(`wrote ${path.relative(root, base)}.json and .csv${TRACE ? ` (+ traces in ${path.relative(root, OUT)}/traces)` : ''}`)

  await browser.close()
  await server.close()
  previewProc?.kill()

  // Non-zero exit when any run errored or its output failed verification (so CI can't accept bad results).
  const runRows = rows.filter((r) => r.run !== 'median')
  const skipped = summary.filter((x) => String(x.status ?? '').startsWith('skipped')).length
  const failedRuns = runRows.filter((r) => !(r.status === 'done' && r.verified === true))
  if (skipped) log(`${skipped} scenario(s) skipped (not supported here); listed above`)
  if (failedRuns.length) log(`FAILED: ${failedRuns.length}/${runRows.length} run(s) errored or failed output verification`)
  process.exitCode = exitCode(runRows, { skipped, failOnSkip: has('fail-on-skip') })
}

main().catch((err) => {
  console.error(err)
  previewProc?.kill()
  process.exit(1)
})

