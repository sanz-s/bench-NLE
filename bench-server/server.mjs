#!/usr/bin/env node
/**
 * bench-server: local CPU/GPU sampler for the Bunny NLE export benchmarks.
 * The NLE itself is fully client-side. This process only MEASURES the machine while jobs run.
 *
 *   node bench-server/server.mjs [--port 5199] [--interval 500] [--powermetrics] [--quiet]
 *
 * Sources (macOS):
 *   system CPU   os.cpus() tick deltas
 *   browser CPU  `ps -axo pid,ppid,time,rss,args` cputime deltas, grouped by Chrome --type=
 *   GPU          `ioreg -r -d 1 -w 0 -c IOAccelerator` "Device/Renderer/Tiler Utilization %" (no sudo)
 *   power        `powermetrics --samplers cpu_power,gpu_power` (needs sudo, opt-in with --powermetrics)
 * On Linux: /proc-based CPU via os.cpus(), GPU via nvidia-smi when present.
 */
import http from 'node:http'
import os from 'node:os'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const PORT = Number(opt('port', 5199))
const INTERVAL = Math.max(100, Number(opt('interval', 500)))
const QUIET = flag('quiet')
const USE_POWERMETRICS = flag('powermetrics')
const BROWSER_RE = /(Google Chrome|Chromium|Chrome for Testing|chrome|Microsoft Edge|Brave Browser|Arc|Vivaldi|Opera)/i

// ------------------------------------------------------------------ system CPU

let lastCpu = os.cpus()
function systemCpuPct() {
  const now = os.cpus()
  let idle = 0
  let total = 0
  now.forEach((c, i) => {
    const p = lastCpu[i]?.times
    if (!p) return
    const t = c.times
    const dIdle = t.idle - p.idle
    const dTotal = t.user - p.user + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + dIdle
    idle += dIdle
    total += dTotal
  })
  lastCpu = now
  return total > 0 ? ((total - idle) / total) * 100 : null
}

// ------------------------------------------------------------------ browser processes

/** "1:02:03.45" | "02:03.45" | "3.45" → seconds */
function parseCpuTime(s) {
  let days = 0
  if (s.includes('-')) {
    const [d, rest] = s.split('-')
    days = Number(d)
    s = rest
  }
  const parts = s.split(':').map(Number)
  let sec = 0
  for (const p of parts) sec = sec * 60 + p
  return sec + days * 86400
}

function procType(cmd) {
  const m = /--type=([\w-]+)/.exec(cmd)
  if (!m) return 'browser'
  if (m[1] === 'utility') {
    const sub = /--utility-sub-type=([\w.]+)/.exec(cmd)
    if (sub) {
      if (/audio/i.test(sub[1])) return 'utility-audio'
      if (/network/i.test(sub[1])) return 'utility-network'
      if (/video|media/i.test(sub[1])) return 'utility-media'
    }
    return 'utility'
  }
  return m[1]
}

let lastProc = new Map() // pid -> { cpu, at }
let lastFilter = undefined
async function sampleProcesses(rootPid) {
  if (rootPid !== lastFilter) {
    // A different process filter needs a fresh baseline for the cputime deltas.
    lastProc = new Map()
    lastFilter = rootPid
  }
  let out = ''
  try {
    out = (await run('ps', ['-axww', '-o', 'pid=,ppid=,time=,rss=,args='], { maxBuffer: 32 * 1024 * 1024 })).stdout
  } catch {
    return null
  }
  const at = performance.now()
  const procs = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: parseCpuTime(m[3]), rssKB: Number(m[4]), cmd: m[5] })
  }
  if (rootPid && !procs.some((p) => p.pid === rootPid)) {
    // That browser has exited: fall back to matching browser processes by name.
    rootPid = null
    lastFilter = null
    lastProc = new Map()
  }
  let selected
  if (rootPid) {
    const children = new Map()
    for (const p of procs) {
      if (!children.has(p.ppid)) children.set(p.ppid, [])
      children.get(p.ppid).push(p)
    }
    selected = []
    const root = procs.find((p) => p.pid === rootPid)
    const stack = root ? [root] : []
    while (stack.length) {
      const p = stack.pop()
      selected.push(p)
      for (const c of children.get(p.pid) ?? []) stack.push(c)
    }
  } else {
    selected = procs.filter((p) => BROWSER_RE.test(p.cmd) && !/crashpad|bench-server/i.test(p.cmd))
  }
  const byType = {}
  let total = 0
  let rss = 0
  const next = new Map()
  for (const p of selected) {
    next.set(p.pid, { cpu: p.cpu, at })
    rss += p.rssKB
    const prev = lastProc.get(p.pid)
    if (!prev) continue
    const dt = (at - prev.at) / 1000
    if (dt <= 0) continue
    const pct = Math.max(0, ((p.cpu - prev.cpu) / dt) * 100)
    total += pct
    const type = procType(p.cmd)
    byType[type] = (byType[type] ?? 0) + pct
  }
  const hadPrev = lastProc.size > 0
  lastProc = next
  return { total: hadPrev ? total : null, byType: hadPrev ? byType : {}, rssMB: rss / 1024, count: selected.length }
}

// ------------------------------------------------------------------ GPU

let gpuSource = null
async function sampleGpu() {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { maxBuffer: 8 * 1024 * 1024 })
      const num = (key) => {
        const m = new RegExp(`"${key}"=(\\d+)`).exec(stdout)
        return m ? Number(m[1]) : null
      }
      const device = num('Device Utilization %')
      if (device !== null) gpuSource = 'ioreg IOAccelerator'
      return { device, renderer: num('Renderer Utilization %'), tiler: num('Tiler Utilization %') }
    } catch {
      return null
    }
  }
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'])
    gpuSource = 'nvidia-smi'
    return { device: Number(stdout.trim().split('\n')[0]), renderer: null, tiler: null }
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ powermetrics (optional, sudo)

const power = { gpuW: null, cpuW: null, gpuMHz: null, gpuActive: null, ok: false }
function startPowermetrics() {
  const pm = spawn('powermetrics', ['--samplers', 'cpu_power,gpu_power', '-i', String(INTERVAL)], { stdio: ['ignore', 'pipe', 'pipe'] })
  pm.stdout.setEncoding('utf8')
  pm.stdout.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      let m
      if ((m = /^GPU Power:\s*([\d.]+)\s*mW/i.exec(line))) power.gpuW = Number(m[1]) / 1000
      else if ((m = /^CPU Power:\s*([\d.]+)\s*mW/i.exec(line))) power.cpuW = Number(m[1]) / 1000
      else if ((m = /^GPU (?:HW )?active frequency:\s*([\d.]+)\s*MHz/i.exec(line))) power.gpuMHz = Number(m[1])
      else if ((m = /^GPU (?:HW )?active residency:\s*([\d.]+)%/i.exec(line))) power.gpuActive = Number(m[1])
      power.ok = true
    }
  })
  pm.stderr.on('data', (d) => console.error(`[powermetrics] ${String(d).trim()}`))
  pm.on('exit', (code) => {
    if (code) console.error(`[powermetrics] exited with ${code}: run with sudo for power metrics`)
    power.ok = false
  })
  process.on('exit', () => pm.kill())
}
if (USE_POWERMETRICS) startPowermetrics()

// ------------------------------------------------------------------ sampling loop

const sessions = new Map() // id -> { label, rootPid, start, samples: [], marks: [] }
let latest = null
let inflight = null
let sampleCount = 0

/** Serialized: a call made while a sample is running waits for it, then takes a fresh one. */
async function sample() {
  while (inflight) await inflight
  inflight = takeSample()
  try {
    await inflight
  } finally {
    inflight = null
  }
}

async function takeSample() {
  {
    const active = [...sessions.values()].filter((s) => !s.end)
    // Sticky filter: keep the last PID tree between sessions so per-process baselines survive.
    const rootPid = active.find((s) => s.rootPid)?.rootPid ?? lastFilter ?? null
    const [proc, gpu] = await Promise.all([sampleProcesses(rootPid), sampleGpu()])
    const s = {
      t: Date.now(),
      cpuSystemPct: systemCpuPct(),
      browserCpuPct: proc?.total ?? null,
      browserCpuByType: proc?.byType ?? {},
      browserRssMB: proc?.rssMB ?? null,
      browserProcs: proc?.count ?? 0,
      gpuDevicePct: gpu?.device ?? null,
      gpuRendererPct: gpu?.renderer ?? null,
      gpuTilerPct: gpu?.tiler ?? null,
      gpuPowerW: power.ok ? power.gpuW : null,
      cpuPowerW: power.ok ? power.cpuW : null,
      gpuFreqMHz: power.ok ? power.gpuMHz : null,
    }
    latest = s
    for (const sess of active) sess.samples.push(s)
    sampleCount++
    if (!QUIET && active.length && sampleCount % Math.max(1, Math.round(1000 / INTERVAL)) === 0) {
      const f = (v, suf = '%') => (v === null || v === undefined ? '  —' : `${v.toFixed(0).padStart(3)}${suf}`)
      const types = Object.entries(s.browserCpuByType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k} ${v.toFixed(0)}%`)
        .join(' ')
      const pw = s.gpuPowerW !== null ? ` | GPU ${s.gpuPowerW.toFixed(1)}W CPU ${s.cpuPowerW?.toFixed(1)}W` : ''
      console.log(
        `[${active[0].label.slice(0, 40).padEnd(40)}] CPU sys ${f(s.cpuSystemPct)} | browser ${f(s.browserCpuPct)} (${types}) | GPU ${f(s.gpuDevicePct)}${pw} | RSS ${s.browserRssMB ? (s.browserRssMB / 1024).toFixed(2) : '—'} GB`,
      )
    }
  }
}
setInterval(() => {
  if (!inflight) void sample()
}, INTERVAL)
void sample()

// ------------------------------------------------------------------ summaries

function stat(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x))
  if (!v.length) return null
  const sorted = [...v].sort((a, b) => a - b)
  return {
    avg: v.reduce((a, b) => a + b, 0) / v.length,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted[sorted.length - 1],
  }
}

function summarize(sess) {
  const s = sess.samples
  const types = new Set(s.flatMap((x) => Object.keys(x.browserCpuByType)))
  const byType = {}
  for (const t of types) byType[t] = stat(s.map((x) => x.browserCpuByType[t] ?? 0))
  return {
    label: sess.label,
    durationMs: (sess.end ?? Date.now()) - sess.start,
    samples: s.length,
    intervalMs: INTERVAL,
    cpuSystemPct: stat(s.map((x) => x.cpuSystemPct)),
    browserCpuPct: stat(s.map((x) => x.browserCpuPct)),
    browserCpuByType: byType,
    browserRssMB: stat(s.map((x) => x.browserRssMB)),
    gpuDevicePct: stat(s.map((x) => x.gpuDevicePct)),
    gpuRendererPct: stat(s.map((x) => x.gpuRendererPct)),
    gpuTilerPct: stat(s.map((x) => x.gpuTilerPct)),
    gpuPowerW: stat(s.map((x) => x.gpuPowerW)),
    cpuPowerW: stat(s.map((x) => x.cpuPowerW)),
    gpuFreqMHz: stat(s.map((x) => x.gpuFreqMHz)),
    processFilter: sess.rootPid ? `process tree of pid ${sess.rootPid}` : 'all browser processes (name match)',
    cores: os.cpus().length,
    marks: sess.marks,
    raw: s.map((x) => ({ t: x.t - sess.start, cpu: x.cpuSystemPct, browser: x.browserCpuPct, gpu: x.gpuDevicePct, rss: x.browserRssMB })),
  }
}

// ------------------------------------------------------------------ export records (persisted)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS_DIR = path.join(ROOT, 'bench-results')
const RECORDS_FILE = path.join(RESULTS_DIR, 'exports.jsonl')
const DASHBOARD_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html')
mkdirSync(RESULTS_DIR, { recursive: true })

/** @type {Map<string, any>} id → { id, savedAt, source, meta, report, series } */
const records = new Map()
if (existsSync(RECORDS_FILE)) {
  for (const line of readFileSync(RECORDS_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.deleted) records.delete(r.id)
      else records.set(r.id, r)
    } catch {
      /* skip corrupt line */
    }
  }
}
function persistAll() {
  writeFileSync(RECORDS_FILE, [...records.values()].map((r) => JSON.stringify(r)).join('\n') + (records.size ? '\n' : ''))
}

/** Time series of one job, relative to its start (ms). Chrome CPU is also given as % of the whole machine. */
function seriesOf(sess) {
  const cores = os.cpus().length
  return {
    samples: sess.samples.map((x) => ({
      t: x.t - sess.start,
      cpu: x.cpuSystemPct,
      chrome: x.browserCpuPct === null ? null : x.browserCpuPct / cores,
      chromeCores: x.browserCpuPct,
      byType: x.browserCpuByType,
      gpu: x.gpuDevicePct,
      gpuRenderer: x.gpuRendererPct,
      rssMB: x.browserRssMB,
      gpuW: x.gpuPowerW,
      cpuW: x.cpuPowerW,
    })),
    mainThread: sess.mainThread.map((b) => ({ ...b, t: b.t - sess.start })),
    progress: sess.progress.map((p) => ({ ...p, t: p.t - sess.start })),
  }
}

function recordSummary(r) {
  const { series, ...rest } = r
  return { ...rest, samples: series?.samples?.length ?? 0 }
}

// ------------------------------------------------------------------ HTTP API

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    // Allow use under COEP: require-corp if a page calls us directly instead of via the Vite bridge.
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': 'no-store',
  })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const finished = new Map() // id → stopped session waiting for its final report
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const [id, s] of finished) if (s.end < cutoff) finished.delete(id)
}, 60_000)

function activeJobs() {
  return [...sessions.entries()]
    .filter(([, s]) => !s.end)
    .map(([id, s]) => ({
      id,
      label: s.label,
      kind: s.meta.kind ?? null,
      runIn: s.meta.runIn ?? null,
      container: s.meta.container ?? null,
      videoCodec: s.meta.videoCodec ?? null,
      audioCodec: s.meta.audioCodec ?? null,
      mediaDuration: s.meta.mediaDuration ?? null,
      source: s.meta.source ?? 'editor',
      startedAt: s.start,
      elapsedMs: Date.now() - s.start,
      progress: s.progress.at(-1)?.progress ?? 0,
    }))
}

let nextId = Date.now() % 100000
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.pathname
  if (req.method === 'OPTIONS') return send(res, 204, {})

  // dashboard page
  if (req.method === 'GET' && (p === '/' || p === '/dashboard')) {
    try {
      return send(res, 200, readFileSync(DASHBOARD_FILE, 'utf8'), 'text/html; charset=utf-8')
    } catch {
      return send(res, 500, 'dashboard.html missing', 'text/plain')
    }
  }
  if (req.method === 'GET' && p === '/health') {
    return send(res, 200, { ok: true, platform: process.platform, gpuSource, powermetrics: power.ok, intervalMs: INTERVAL, cores: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? '', totalMemGB: os.totalmem() / 1073741824 })
  }
  if (req.method === 'GET' && p === '/live') return send(res, 200, latest ?? {})

  // live monitor: the running job(s) with their series so far
  if (req.method === 'GET' && p === '/monitor') {
    const jobs = activeJobs()
    const focus = jobs[0] ? sessions.get(jobs[0].id) : null
    return send(res, 200, { now: Date.now(), jobs, series: focus ? seriesOf(focus) : null })
  }

  // saved results
  if (req.method === 'GET' && p === '/records') {
    return send(res, 200, [...records.values()].map(recordSummary).sort((a, b) => b.savedAt - a.savedAt))
  }
  let m = /^\/records\/([\w-]+)$/.exec(p)
  if (m && req.method === 'GET') {
    const r = records.get(m[1])
    return r ? send(res, 200, r) : send(res, 404, { error: 'no such record' })
  }
  if (m && req.method === 'DELETE') {
    records.delete(m[1])
    persistAll()
    return send(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && p === '/records') {
    const source = url.searchParams.get('source')
    for (const [id, r] of records) if (!source || r.source === source) records.delete(id)
    persistAll()
    return send(res, 200, { ok: true, left: records.size })
  }

  // session lifecycle (called by the editor's job runner)
  if (req.method === 'POST' && p === '/sessions') {
    const body = await readBody(req)
    const id = String(nextId++)
    const rootPid = Number(body.rootPid) || null
    const { label, rootPid: _r, ...meta } = body
    sessions.set(id, { label: String(label ?? `job ${id}`), rootPid, meta, start: Date.now(), samples: [], marks: [], mainThread: [], progress: [] })
    if (!QUIET) console.log(`▶ ${meta.kind ?? 'job'} ${id} start: ${label ?? ''}${rootPid ? ` (pid ${rootPid})` : ''}`)
    await sample()
    return send(res, 200, { id })
  }
  m = /^\/sessions\/(\w+)\/(mark|stop|progress|mainthread|report)$/.exec(p)
  if (req.method === 'POST' && m) {
    const id = m[1]
    const sess = sessions.get(id) ?? finished.get(id)
    if (!sess) return send(res, 404, { error: 'no such session' })
    const body = await readBody(req)
    switch (m[2]) {
      case 'mark':
        sess.marks.push({ name: String(body.name ?? ''), t: Date.now() - sess.start })
        return send(res, 200, { ok: true })
      case 'progress':
        sess.progress.push({ t: Date.now(), progress: Number(body.progress) || 0, processedTime: Number(body.processedTime) || 0 })
        return send(res, 200, { ok: true })
      case 'mainthread':
        sess.mainThread.push(body)
        return send(res, 200, { ok: true })
      case 'stop': {
        if (!sess.end) {
          await sample()
          sess.end = Date.now()
          sessions.delete(id)
          finished.set(id, sess)
        }
        const summary = summarize(sess)
        if (!QUIET) {
          const f = (st) => (st ? `${st.avg.toFixed(0)}% avg / ${st.max.toFixed(0)}% max` : '—')
          console.log(`■ ${sess.meta.kind ?? 'job'} ${id} done in ${(summary.durationMs / 1000).toFixed(2)}s · CPU ${f(summary.cpuSystemPct)} · browser ${f(summary.browserCpuPct)} · GPU ${f(summary.gpuDevicePct)}`)
        }
        return send(res, 200, summary)
      }
      case 'report': {
        const record = {
          id: `${new Date(sess.start).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${id}`,
          savedAt: Date.now(),
          source: sess.meta.source ?? 'editor',
          meta: { ...sess.meta, label: sess.label, startedAt: sess.start, endedAt: sess.end ?? Date.now() },
          report: body,
          series: seriesOf(sess),
        }
        records.set(record.id, record)
        appendFileSync(RECORDS_FILE, JSON.stringify(record) + '\n')
        finished.delete(id)
        if (!QUIET) console.log(`✓ saved ${record.meta.kind ?? 'job'} result ${record.id}  →  http://127.0.0.1:${PORT}/`)
        return send(res, 200, { ok: true, id: record.id })
      }
    }
  }
  send(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`bench-server listening on http://127.0.0.1:${PORT}  (interval ${INTERVAL} ms, ${os.cpus().length} cores, ${process.platform})`)
  console.log(`Export dashboard:  http://127.0.0.1:${PORT}/   (${records.size} saved results in ${path.relative(ROOT, RECORDS_FILE)})`)
  console.log(`GPU source: ${gpuSource ?? 'probing…'} · powermetrics: ${USE_POWERMETRICS ? 'starting (needs sudo)' : 'off (use --powermetrics with sudo)'}`)
  console.log('The NLE stays fully client-side; this server only measures CPU/GPU while exports run.')
})
