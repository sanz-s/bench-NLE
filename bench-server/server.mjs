#!/usr/bin/env node
/**
 * bench-server: local CPU/GPU/RAM sampler for the Bunny NLE export benchmarks.
 * The NLE itself is fully client-side. This process only MEASURES the machine while jobs run.
 *
 *   node bench-server/server.mjs [--port 5199] [--interval 500] [--powermetrics] [--process-gpu] [--quiet]
 *
 * Sources (parsers in probes.mjs, unit-tested with `node --test bench-server/`):
 *   system CPU    os.cpus() tick deltas (all platforms)
 *   browser CPU   macOS: native procstat helper (proc_pid_rusage; `ps` fallback) · Linux: /proc/<pid>/stat utime+stime (clock-tick resolution)
 *                 Windows: Win32_Process Kernel+UserModeTime from a long-lived PowerShell loop
 *   browser RAM   RSS (all) + real footprint: macOS phys_footprint (procstat helper) · Linux smaps_rollup PSS
 *                 · Windows private bytes (+ GPU process memory)
 *   GPU           macOS `ioreg` IOAccelerator (busiest GPU) · NVIDIA `nvidia-smi` incl. encoder/decoder/power
 *                 · Windows `\GPU Engine(*)` counters (per engine incl. VideoEncode/Decode, per browser PID)
 *                 · Linux AMD sysfs gpu_busy_percent
 *   power         macOS `powermetrics` (sudo, --powermetrics) · NVIDIA power.draw · Linux RAPL energy_uj
 *   attribution   Playwright PID, else the browser behind the request's socket (lsof · /proc/net/tcp · Get-NetTCPConnection)
 */
import http from 'node:http'
import os from 'node:os'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import * as P from './probes.mjs'

const execFileP = promisify(execFile)
let spawnCount = 0 // sampler overhead: child processes started
const run = (...a) => {
  spawnCount++
  return execFileP(...a)
}
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const PORT = Number(opt('port', 5199))
const INTERVAL = Math.max(100, Number(opt('interval', 500)))
const QUIET = flag('quiet')
const USE_POWERMETRICS = flag('powermetrics') || flag('process-gpu')
// --process-gpu: also powermetrics' tasks sampler (--show-process-gpu) for per-process GPU time. Opt-in: the tasks
// sampler costs ~80 ms/s CPU, and on macOS 26 (M3 Pro) every task's "GPU ms/s" read 0.00 — values are only used
// when the ALL_TASKS total is above zero.
const PROCESS_GPU = flag('process-gpu')
const PLATFORM = process.platform
const BIG = { maxBuffer: 32 * 1024 * 1024 }
const { isBrowserExe } = P

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

// ------------------------------------------------------------------ process table snapshots (per platform)

const LINUX = { clkTck: 100, pageSize: 4096 }
if (PLATFORM === 'linux') {
  try {
    LINUX.clkTck = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) || 100
    LINUX.pageSize = Number(execFileSync('getconf', ['PAGESIZE']).toString().trim()) || 4096
  } catch {
    /* defaults */
  }
}

/** pid → { exe, args }: args are only fetched for processes not seen before (one `ps` per sample otherwise). */
const argsCache = new Map()

/** macOS / BSD: one `ps` for the table; a second, small `ps -p` only for NEW browser pids (for Chrome --type=). */
async function snapshotPs() {
  const t0 = performance.now()
  let text
  try {
    text = (await run('ps', ['-axww', '-o', 'pid=,ppid=,time=,rss=,comm='], BIG)).stdout
  } catch {
    return null
  }
  const at = (t0 + performance.now()) / 2 // midpoint: keeps ps's own runtime out of the deltas
  const procs = P.parsePsComm(text)
  const need = procs.filter((p) => isBrowserExe(p.exe) && argsCache.get(p.pid)?.exe !== p.exe)
  if (need.length) {
    try {
      const m = P.parsePsArgs((await run('ps', ['-ww', '-o', 'pid=,args=', '-p', need.map((p) => p.pid).join(',')], BIG)).stdout)
      for (const p of need) argsCache.set(p.pid, { exe: p.exe, args: m.get(p.pid) ?? '' })
    } catch {
      /* the process may already be gone */
    }
  }
  for (const p of procs) p.cmd = argsCache.get(p.pid)?.args ?? ''
  pruneCache(argsCache, procs)
  return { at, procs }
}

/** Linux: /proc/<pid>/stat for every process (clock-tick CPU resolution, not ps's whole seconds). */
async function snapshotProc() {
  const t0 = performance.now()
  let ents
  try {
    ents = (await fsp.readdir('/proc')).filter((e) => /^\d+$/.test(e))
  } catch {
    return null
  }
  const procs = []
  await Promise.all(
    ents.map(async (e) => {
      try {
        const st = P.parseProcStat(await fsp.readFile(`/proc/${e}/stat`, 'utf8'), LINUX)
        if (st) procs.push(st)
      } catch {
        /* exited */
      }
    }),
  )
  const at = (t0 + performance.now()) / 2
  await Promise.all(
    procs
      .filter((p) => argsCache.get(p.pid)?.exe !== p.exe)
      .map(async (p) => {
        try {
          argsCache.set(p.pid, { exe: p.exe, args: P.parseProcCmdline(await fsp.readFile(`/proc/${p.pid}/cmdline`)) })
        } catch {
          argsCache.set(p.pid, { exe: p.exe, args: '' })
        }
      }),
  )
  for (const p of procs) p.cmd = argsCache.get(p.pid)?.args ?? ''
  pruneCache(argsCache, procs)
  return { at, procs }
}

function pruneCache(cache, procs) {
  if (cache.size < procs.length * 2) return
  const alive = new Set(procs.map((p) => p.pid))
  for (const pid of cache.keys()) if (!alive.has(pid)) cache.delete(pid)
}

// Windows: two long-lived PowerShell loops (spawning one per sample would cost ~0.3 s CPU each time).
// UNTESTED on real Windows: written from the documented Win32_Process / Get-Counter formats.
const win = { procs: null, at: 0, gpu: null, gpuAt: 0, started: false, error: null }
function startWindowsProbes() {
  if (win.started) return
  win.started = true
  // Both loops exit on their own once the server process is gone (Ctrl+C never runs process.on('exit') handlers).
  const procScript = `$ErrorActionPreference='SilentlyContinue'
$sw=[Diagnostics.Stopwatch]::StartNew()
while($true){
  if(-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)){ exit }
  $rows=foreach($p in Get-CimInstance Win32_Process){
    $c=$null; if($p.Name -match '^(chrome|msedge|brave|firefox|opera|vivaldi)\\.exe$'){ $c=$p.CommandLine }
    [pscustomobject]@{i=$p.ProcessId;pp=$p.ParentProcessId;n=$p.Name;c=$c;t=[double]$p.KernelModeTime+[double]$p.UserModeTime;w=[double]$p.WorkingSetSize;v=[double]$p.PrivatePageCount}
  }
  [Console]::Out.WriteLine((@{k='p';at=$sw.Elapsed.TotalMilliseconds;p=@($rows)}|ConvertTo-Json -Compress -Depth 3)); [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${INTERVAL}
}`
  const gpuScript = `$ErrorActionPreference='SilentlyContinue'
$paths='\\GPU Engine(*)\\Utilization Percentage','\\GPU Process Memory(*)\\Dedicated Usage','\\GPU Process Memory(*)\\Shared Usage'
Get-Counter -Counter $paths -SampleInterval 1 -Continuous | ForEach-Object {
  if(-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)){ exit }
  $s=foreach($x in $_.CounterSamples){ [pscustomobject]@{c=$x.Path.Split('\\')[-1];n=$x.InstanceName;v=[double]$x.CookedValue} }
  [Console]::Out.WriteLine((@{k='g';s=@($s)}|ConvertTo-Json -Compress -Depth 3)); [Console]::Out.Flush()
}`
  const launch = (script) => {
    const enc = Buffer.from(script, 'utf16le').toString('base64')
    spawnCount++
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let buf = ''
    ps.stdout.setEncoding('utf8')
    ps.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          const j = JSON.parse(line)
          if (j.k === 'p') {
            win.at = j.at
            win.procs = (j.p ?? []).map((r) => ({ pid: r.i, ppid: r.pp, exe: r.n, cmd: r.c ?? '', cpu: r.t / 1e7, rssKB: r.w / 1024, privateKB: r.v / 1024 }))
          } else if (j.k === 'g') {
            win.gpu = (j.s ?? []).map((x) => ({ c: x.c, n: x.n, v: x.v }))
            win.gpuAt = Date.now()
          }
        } catch {
          /* partial line */
        }
      }
    })
    ps.on('error', (e) => (win.error = e.message))
    process.on('exit', () => ps.kill())
  }
  launch(procScript)
  launch(gpuScript)
}
async function snapshotWin() {
  startWindowsProbes()
  if (!win.procs) return null
  return { at: win.at, procs: win.procs }
}

/**
 * macOS: bench-server/native/procstat, a long-lived helper using proc_pid_rusage (ns CPU, phys_footprint) —
 * about 20 ms CPU per sample, vs ~50 ms per `ps`. Compiled on first start with clang; without a compiler the
 * server falls back to `ps` (CPU, RSS) and reports no footprint.
 */
const NATIVE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native')
const helper = { proc: null, ok: false, buf: '', waiters: [], error: null }
function startProcstat() {
  if (PLATFORM !== 'darwin') return
  if (process.env.BENCH_NO_NATIVE) {
    helper.error = 'procstat disabled (BENCH_NO_NATIVE); using ps (no footprint)'
    return
  }
  const src = path.join(NATIVE_DIR, 'procstat.c')
  // (without it: ps for CPU/RSS and no footprint; `top` would cost ~20-40 % of a core and buffers its output)
  const bin = path.join(NATIVE_DIR, 'procstat')
  try {
    const stale = !existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs
    if (stale) execFileSync('clang', ['-O2', '-o', bin, src], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    helper.error = `procstat build failed (${String(e.stderr ?? e.message).split('\n')[0]}); using ps (no footprint)`
    return
  }
  helper.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] })
  helper.proc.stdout.setEncoding('utf8')
  helper.proc.stdout.on('data', (d) => {
    helper.buf += d
    let i
    while ((i = helper.buf.indexOf('END\n')) >= 0) {
      const block = helper.buf.slice(0, i)
      helper.buf = helper.buf.slice(i + 4)
      helper.waiters.shift()?.(block)
    }
  })
  helper.proc.on('exit', () => {
    helper.ok = false
    helper.proc = null
    for (const w of helper.waiters.splice(0)) w(null)
  })
  helper.ok = true
  process.on('exit', () => helper.proc?.kill())
}
async function snapshotHelper() {
  const t0 = performance.now()
  const block = await new Promise((resolve) => {
    helper.waiters.push(resolve)
    helper.proc.stdin.write('\n')
  })
  if (block === null) return snapshotPs()
  const at = (t0 + performance.now()) / 2
  const procs = P.parseProcstat(block)
  const need = procs.filter((p) => isBrowserExe(p.exe) && argsCache.get(p.pid)?.exe !== p.exe)
  if (need.length) {
    try {
      const m = P.parsePsArgs((await run('ps', ['-ww', '-o', 'pid=,args=', '-p', need.map((p) => p.pid).join(',')], BIG)).stdout)
      for (const p of need) argsCache.set(p.pid, { exe: p.exe, args: m.get(p.pid) ?? '' })
    } catch {
      /* gone */
    }
  }
  for (const p of procs) p.cmd = argsCache.get(p.pid)?.args ?? ''
  pruneCache(argsCache, procs)
  return { at, procs }
}
startProcstat()

const snapshot = PLATFORM === 'win32' ? snapshotWin : PLATFORM === 'linux' ? snapshotProc : () => (helper.ok ? snapshotHelper() : snapshotPs())

// ------------------------------------------------------------------ attribution (which browser made the request)

/**
 * Editor-mode attribution: the Vite bench-api bridge forwards the browser socket's source port (x-bench-peer-port).
 * We find the process holding that end (Chrome's network-service helper, Firefox's main process, Safari's
 * WebKit.Networking …) and walk up to its browser main process. Without the bridge headers: every browser
 * connected to the page's port (x-bench-page-port / body.pagePort), flagged ambiguous if there is more than one.
 */
async function socketOwners({ peerPort, pagePort }) {
  const port = peerPort || pagePort
  if (!port) return new Set()
  if (PLATFORM === 'win32') {
    const filter = peerPort ? `-LocalPort ${peerPort}` : `-RemotePort ${pagePort}`
    try {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-NetTCPConnection -State Established ${filter} | Select-Object -ExpandProperty OwningProcess`], { timeout: 4000, windowsHide: true })
      return new Set(stdout.split(/\s+/).filter(Boolean).map(Number).filter((p) => p !== process.pid))
    } catch {
      return new Set()
    }
  }
  if (PLATFORM === 'linux') {
    // /proc/net/tcp(6) → socket inodes → the pid whose /proc/<pid>/fd links to one (no lsof needed)
    let inodes = new Set()
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      try {
        for (const i of P.parseProcNetTcp(await fsp.readFile(f, 'utf8'), { peerPort, pagePort })) inodes.add(i)
      } catch {
        /* no ipv6 */
      }
    }
    const owners = new Set()
    if (!inodes.size) return owners
    for (const e of (await fsp.readdir('/proc')).filter((x) => /^\d+$/.test(x))) {
      const pid = Number(e)
      if (pid === process.pid) continue
      try {
        for (const fd of await fsp.readdir(`/proc/${e}/fd`)) {
          const l = await fsp.readlink(`/proc/${e}/fd/${fd}`).catch(() => '')
          const m = /^socket:\[(\d+)\]$/.exec(l)
          if (m && inodes.has(m[1])) owners.add(pid)
        }
      } catch {
        /* not ours to read */
      }
    }
    return owners
  }
  let out = ''
  try {
    out = (await run('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpn'], { timeout: 2500 })).stdout
  } catch (e) {
    out = e.stdout ?? '' // lsof exits 1 when nothing matches
  }
  return P.parseLsofOwners(out, { peerPort, pagePort, selfPid: process.pid })
}

async function resolveBrowserRoot({ peerPort, pagePort }) {
  const port = peerPort || pagePort
  if (!port) return null
  const pids = await socketOwners({ peerPort, pagePort })
  if (!pids.size) return null
  const table = await snapshot()
  if (!table) return null
  const roots = new Map()
  for (const p of pids) {
    const r = P.browserRootOf(table.procs, p)
    if (r) roots.set(r.pid, r)
  }
  if (!roots.size) return { rootPid: null, via: `port ${port}: connection held by a non-browser process (pid ${[...pids].join(', ')})` }
  const list = [...roots.values()]
  const safari = P.isWebKitService(list[0].exe)
  return {
    rootPid: list[0].pid,
    browser: safari ? 'Safari (WebKit services)' : list[0].exe,
    ambiguous: list.length > 1,
    safari,
    via: peerPort ? `socket :${peerPort} → ${list[0].exe} (pid ${list[0].pid})` : `page port ${pagePort} → ${list.map((r) => `${r.exe} (pid ${r.pid})`).join(', ')}`,
  }
}

// ------------------------------------------------------------------ browser CPU / RAM for one sample

/**
 * cputime baseline for EVERY process (pid → {cpu, at, exe}), never reset when the filter changes, so the first
 * sample of a job already has a value (it's measured against the idle sample taken ≤ INTERVAL earlier).
 */
let lastProc = new Map()
let lastFilter = null
/** pid → footprint (MB) for platforms that measure it separately (Linux PSS) */
let footprint = new Map()

async function sampleProcesses(rootPid) {
  const table = await snapshot()
  if (!table) return null
  const { at, procs } = table
  if (rootPid && !procs.some((p) => p.pid === rootPid)) rootPid = null // that browser has exited
  lastFilter = rootPid
  const { selected, mode } = P.selectBrowserProcs(procs, { rootPid, platform: PLATFORM, selfPid: process.pid })
  const sel = new Set(selected.map((p) => p.pid))

  const next = new Map()
  const others = []
  let total = 0
  let any = false
  let samplerChildCpu = 0
  const media = { encoderCpu: null, decoderCpu: null, footprintMB: 0, any: false }
  const byType = {}
  for (const p of procs) {
    next.set(p.pid, { cpu: p.cpu, at, exe: p.exe })
    const prev = lastProc.get(p.pid)
    if (!prev || prev.exe !== p.exe) continue // new process, or a reused pid
    const dt = (at - prev.at) / 1000
    if (dt <= 0) continue
    const pct = Math.max(0, ((p.cpu - prev.cpu) / dt) * 100)
    if (P.isMediaService(p.exe)) {
      media.any = true
      if (p.exe === 'VTEncoderXPCService') media.encoderCpu = (media.encoderCpu ?? 0) + pct
      else media.decoderCpu = (media.decoderCpu ?? 0) + pct
      media.footprintMB += p.footprintMB ?? 0
    } else if (sel.has(p.pid)) {
      any = true
      total += pct
      const type = P.procType(p.cmd)
      byType[type] = (byType[type] ?? 0) + pct
    } else if (p.ppid === process.pid || p.pid === process.pid) {
      if (p.ppid === process.pid) samplerChildCpu += pct // long-lived probes: procstat, PowerShell, powermetrics
    } else if (pct >= 1 && !isBrowserExe(p.exe)) others.push({ exe: p.exe, pid: p.pid, pct })
  }
  lastProc = next

  let rss = 0
  let fp = 0
  let fpCount = 0
  let priv = 0
  for (const p of selected) {
    rss += p.rssKB
    if (p.privateKB !== undefined) priv += p.privateKB
    const f = p.footprintMB ?? footprint.get(p.pid)
    if (f !== undefined) {
      fp += f
      fpCount++
    }
  }
  // Linux: PSS every 4th sample (smaps_rollup walks page tables), Windows: private bytes
  if (PLATFORM === 'linux' && sampleCount % 4 === 0) void refreshPss(selected)
  const footprintMB = PLATFORM === 'win32' ? priv / 1024 : fpCount ? fp : null
  others.sort((a, b) => b.pct - a.pct)
  return {
    total: any ? total : null,
    byType,
    rssMB: rss / 1024,
    footprintMB,
    footprintCoverage: PLATFORM === 'win32' ? 1 : selected.length ? fpCount / selected.length : null,
    count: selected.length,
    mode,
    pids: sel,
    others: others.slice(0, 5),
    samplerChildCpu,
    media,
  }
}

async function refreshPss(selected) {
  const m = new Map()
  await Promise.all(
    selected.map(async (p) => {
      try {
        const kb = P.parseSmapsRollupPss(await fsp.readFile(`/proc/${p.pid}/smaps_rollup`, 'utf8'))
        if (kb !== null) m.set(p.pid, kb / 1024)
      } catch {
        /* other user's process or old kernel */
      }
    }),
  )
  footprint = m
}

// ------------------------------------------------------------------ GPU

let gpuSource = null
let nvidiaOk = PLATFORM === 'darwin' ? false : null // null = not probed yet
let amdCards = null
async function sampleGpu(pids) {
  if (PLATFORM === 'darwin') {
    try {
      const { stdout } = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { maxBuffer: 8 * 1024 * 1024 })
      const g = P.parseIoregGpu(stdout)
      if (g) gpuSource = `ioreg IOAccelerator (busiest of ${g.gpus} GPU${g.gpus > 1 ? 's' : ''}; whole GPU, excludes Media Engine)`
      return g
    } catch {
      return null
    }
  }
  let g = null
  if (PLATFORM === 'win32' && win.gpu && Date.now() - win.gpuAt < 5000) {
    g = P.summarizeGpuEngines(win.gpu, pids)
    const mem = P.summarizeGpuProcessMemory(win.gpu, pids ?? new Set())
    g.browserGpuMemMB = mem.dedicatedMB + mem.sharedMB
    gpuSource = 'Windows GPU Engine counters (all engines; per-process; English counter names only)'
  }
  if (nvidiaOk !== false) {
    try {
      const { stdout } = await run('nvidia-smi', ['--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,power.draw', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true })
      const n = P.parseNvidiaSmi(stdout)
      nvidiaOk = true
      if (n && !g) {
        g = n
        gpuSource = `nvidia-smi (busiest of ${n.gpus} GPU${n.gpus > 1 ? 's' : ''}; encoder/decoder separate)`
      } else if (n && g) g.powerW = n.powerW
    } catch {
      nvidiaOk = false // don't spawn it every sample when it isn't installed
    }
  }
  if (!g && PLATFORM === 'linux') {
    if (amdCards === null) {
      amdCards = []
      try {
        for (const c of await fsp.readdir('/sys/class/drm')) if (/^card\d+$/.test(c) && existsSync(`/sys/class/drm/${c}/device/gpu_busy_percent`)) amdCards.push(c)
      } catch {
        /* no drm */
      }
    }
    if (amdCards.length) {
      const v = await Promise.all(amdCards.map((c) => fsp.readFile(`/sys/class/drm/${c}/device/gpu_busy_percent`, 'utf8').then(Number, () => null)))
      const ok = v.filter((x) => Number.isFinite(x))
      if (ok.length) {
        g = { device: Math.max(...ok), renderer: null, tiler: null, encoder: null, decoder: null, gpus: ok.length }
        gpuSource = 'amdgpu sysfs gpu_busy_percent (whole GPU; no encoder split)'
      }
    }
  }
  return g
}

// ------------------------------------------------------------------ power

const power = { gpuW: null, cpuW: null, gpuMHz: null, gpuActive: null, ok: false, source: null, clusters: {}, taskGpu: null, allTasksGpuMsPerS: null }
function startPowermetrics() {
  spawnCount++
  const samplers = PROCESS_GPU ? ['tasks', 'cpu_power', 'gpu_power'] : ['cpu_power', 'gpu_power']
  const pm = spawn('powermetrics', ['--samplers', samplers.join(','), '-i', String(INTERVAL), ...(PROCESS_GPU ? ['--show-process-gpu'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] })
  pm.stdout.setEncoding('utf8')
  let buf = ''
  let tasks = null // Map pid → GPU ms/s while inside a "Running tasks" table
  pm.stdout.on('data', (chunk) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() // keep a partial last line for the next chunk
    for (const line of lines) {
      if (tasks) {
        const r = P.parsePowermetricsTaskRow(line)
        if (r?.pid === -2) {
          power.allTasksGpuMsPerS = r.gpuMsPerS
          power.taskGpu = tasks
          tasks = null
        } else if (r) tasks.set(r.pid, r.gpuMsPerS)
        else if (!line.trim()) tasks = null
        continue
      }
      if (/^Name\s+ID\s+CPU ms\/s/.test(line)) {
        tasks = new Map()
        continue
      }
      const u = P.parsePowermetricsLine(line)
      if (!u) continue
      if (u.cluster) power.clusters[u.cluster] = { ...power.clusters[u.cluster], ...(u.mhz !== undefined ? { mhz: u.mhz } : { activePct: u.activePct }) }
      else Object.assign(power, u)
      power.ok = true
      power.source = 'powermetrics'
    }
  })
  pm.stderr.on('data', (d) => console.error(`[powermetrics] ${String(d).trim()}`))
  pm.on('exit', (code) => {
    if (code) console.error(`[powermetrics] exited with ${code}: run with sudo for power metrics`)
    power.ok = false
  })
  process.on('exit', () => pm.kill())
}
/** Browser GPU time from powermetrics' tasks table, as % of one GPU (ms/s ÷ 10); null unless macOS reports it. */
function powermetricsBrowserGpu(pids) {
  if (!power.taskGpu || !(power.allTasksGpuMsPerS > 0) || !pids) return null
  let ms = 0
  for (const [pid, v] of power.taskGpu) if (pids.has(pid)) ms += v
  return ms / 10
}
if (USE_POWERMETRICS) startPowermetrics()

// Linux: CPU package power from RAPL energy counters (readable by root on recent kernels).
let rapl = null
async function sampleRapl() {
  if (PLATFORM !== 'linux') return null
  const f = '/sys/class/powercap/intel-rapl:0/energy_uj'
  try {
    const uj = Number(await fsp.readFile(f, 'utf8'))
    const t = performance.now()
    const prev = rapl
    rapl = { uj, t }
    if (!prev || uj < prev.uj) return null
    return (uj - prev.uj) / 1e6 / ((t - prev.t) / 1000)
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ run conditions (power source, thermal state)

async function runConditions() {
  const c = { platform: PLATFORM, powerSource: null, batteryPct: null, lowPowerMode: null, thermalWarning: null, performanceWarning: null, cpuSpeedLimitPct: null, maxTempC: null }
  try {
    if (PLATFORM === 'darwin') {
      const [b, g, t] = await Promise.all([run('pmset', ['-g', 'batt']), run('pmset', ['-g']), run('pmset', ['-g', 'therm'])].map((p) => p.then((r) => r.stdout, () => '')))
      const batt = P.parsePmsetBatt(b)
      Object.assign(c, { powerSource: batt.source, batteryPct: batt.batteryPct, lowPowerMode: P.parsePmsetLowPower(g) }, P.parsePmsetTherm(t))
    } else if (PLATFORM === 'linux') {
      for (const d of await fsp.readdir('/sys/class/power_supply').catch(() => [])) {
        const read = (f) => fsp.readFile(`/sys/class/power_supply/${d}/${f}`, 'utf8').then((s) => s.trim(), () => null)
        const type = await read('type')
        if (type === 'Mains') c.powerSource = (await read('online')) === '1' ? 'ac' : (c.powerSource ?? 'battery')
        if (type === 'Battery') c.batteryPct = Number(await read('capacity')) || null
      }
      const temps = []
      for (const z of await fsp.readdir('/sys/class/thermal').catch(() => [])) {
        if (!z.startsWith('thermal_zone')) continue
        const v = Number(await fsp.readFile(`/sys/class/thermal/${z}/temp`, 'utf8').catch(() => 'x'))
        if (Number.isFinite(v)) temps.push(v / 1000)
      }
      if (temps.length) c.maxTempC = Math.max(...temps)
    } else if (PLATFORM === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Battery | Select-Object BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress'], { timeout: 4000, windowsHide: true })
      const j = stdout.trim() ? JSON.parse(stdout) : null
      const b = Array.isArray(j) ? j[0] : j
      if (b) Object.assign(c, { powerSource: b.BatteryStatus === 2 ? 'ac' : 'battery', batteryPct: b.EstimatedChargeRemaining ?? null })
      else c.powerSource = 'ac (no battery)'
    }
  } catch {
    /* best effort */
  }
  return c
}

// ------------------------------------------------------------------ sampling loop

const sessions = new Map() // id -> { label, rootPid, start, samples: [], marks: [] }
let latest = null
/** The sampler runs all the time, so the last ~2 s before a job starts is a free idle baseline. */
const BASELINE_SAMPLES = Math.max(2, Math.round(2000 / INTERVAL))
const recent = []
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
  const active = [...sessions.values()].filter((s) => !s.end)
  // Between jobs keep the last tree (so `recent` is comparable); during jobs, exactly what the session says.
  const rootPid = active.find((s) => s.rootPid)?.rootPid ?? (active.length ? null : lastFilter)
  const proc = await sampleProcesses(rootPid)
  const [gpu, raplW] = await Promise.all([sampleGpu(proc?.pids), sampleRapl()])
  const s = {
    t: Date.now(),
    cpuSystemPct: systemCpuPct(),
    browserCpuPct: proc?.total ?? null,
    browserCpuByType: proc?.byType ?? {},
    browserRssMB: proc?.rssMB ?? null,
    browserFootprintMB: proc?.footprintMB ?? null,
    browserProcs: proc?.count ?? 0,
    selectMode: proc?.mode ?? null,
    others: proc?.others ?? [],
    samplerChildCpu: proc?.samplerChildCpu ?? 0,
    // VideoToolbox encode/decode services (all clients: not attributable to one browser)
    mediaEncoderCpuPct: proc?.media?.encoderCpu ?? null,
    mediaDecoderCpuPct: proc?.media?.decoderCpu ?? null,
    mediaServiceFootprintMB: proc?.media?.any && proc.media.footprintMB ? proc.media.footprintMB : null,
    gpuDevicePct: gpu?.device ?? null,
    gpuRendererPct: gpu?.renderer ?? null,
    gpuTilerPct: gpu?.tiler ?? null,
    gpuEncoderPct: gpu?.encoder ?? null,
    gpuDecoderPct: gpu?.decoder ?? null,
    gpuBrowserPct: gpu?.browser3d ?? (PROCESS_GPU ? powermetricsBrowserGpu(proc?.pids) : null),
    gpuBrowserEncoderPct: gpu?.browserEncoder ?? null,
    browserGpuMemMB: gpu?.browserGpuMemMB ?? null,
    gpuCount: gpu?.gpus ?? null,
    gpuPowerW: power.ok ? power.gpuW : (gpu?.powerW ?? null),
    cpuPowerW: power.ok ? power.cpuW : raplW,
    gpuFreqMHz: power.ok ? power.gpuMHz : null,
    // Apple Silicon CPU clusters from powermetrics: {E: {mhz, activePct}, P: {...}} (P0/P1 on Max chips)
    cpuClusters: power.ok && Object.keys(power.clusters).length ? structuredClone(power.clusters) : null,
  }
  latest = s
  recent.push(s)
  if (recent.length > BASELINE_SAMPLES) recent.shift()
  for (const sess of active) sess.samples.push(s)
  sampleCount++
  if (!QUIET && active.length && sampleCount % Math.max(1, Math.round(1000 / INTERVAL)) === 0) {
    const f = (v, suf = '%') => (v === null || v === undefined ? '  —' : `${v.toFixed(0).padStart(3)}${suf}`)
    const types = Object.entries(s.browserCpuByType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} ${v.toFixed(0)}%`)
      .join(' ')
    const pw = s.gpuPowerW !== null ? ` | GPU ${s.gpuPowerW.toFixed(1)}W CPU ${s.cpuPowerW?.toFixed(1) ?? '—'}W` : ''
    const mem = s.browserFootprintMB !== null ? `footprint ${(s.browserFootprintMB / 1024).toFixed(2)} GB` : `RSS ${s.browserRssMB ? (s.browserRssMB / 1024).toFixed(2) : '—'} GB`
    console.log(`[${active[0].label.slice(0, 40).padEnd(40)}] CPU sys ${f(s.cpuSystemPct)} | browser ${f(s.browserCpuPct)} (${types}) | GPU ${f(s.gpuDevicePct)}${pw} | ${mem}`)
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

/** Per-cluster stats of active frequency (MHz) and active residency (%) over a job's samples. */
function clusterStats(samples) {
  const names = new Set(samples.flatMap((x) => Object.keys(x.cpuClusters ?? {})))
  if (!names.size) return null
  const out = {}
  for (const n of names) out[n] = { mhz: stat(samples.map((x) => x.cpuClusters?.[n]?.mhz)), activePct: stat(samples.map((x) => x.cpuClusters?.[n]?.activePct)) }
  return out
}

/** Average CPU of the busiest non-browser processes over some samples ("what else was running"). */
function backgroundLoad(samples, n = 3) {
  const acc = new Map()
  for (const s of samples) for (const o of s.others ?? []) acc.set(o.exe, (acc.get(o.exe) ?? 0) + o.pct)
  return [...acc.entries()]
    .map(([exe, sum]) => ({ exe, cpuPct: sum / Math.max(1, samples.length) }))
    .sort((a, b) => b.cpuPct - a.cpuPct)
    .slice(0, n)
}

function memoryMethod() {
  if (PLATFORM === 'darwin')
    return helper.ok
      ? 'footprint: phys_footprint via proc_pid_rusage (procstat helper; includes owned graphics/IOSurface memory); RSS kept for comparison (over-counts shared memory)'
      : 'RSS only (over-counts shared memory): footprint needs the procstat helper (clang)'
  if (PLATFORM === 'linux') return 'footprint: smaps_rollup PSS (shared pages split between processes; own-user processes only); RSS kept for comparison'
  if (PLATFORM === 'win32') return 'footprint: private bytes (Win32_Process.PrivatePageCount) + GPU process memory counters; UNTESTED'
  return 'RSS'
}

function summarize(sess) {
  const s = sess.samples
  const types = new Set(s.flatMap((x) => Object.keys(x.browserCpuByType)))
  const byType = {}
  for (const t of types) byType[t] = stat(s.map((x) => x.browserCpuByType[t] ?? 0))
  const durationMs = (sess.end ?? Date.now()) - sess.start
  const cpu = sess.cpuEnd ?? process.cpuUsage(sess.cpuStart)
  const serverCpuPct = durationMs > 0 ? ((cpu.user + cpu.system) / 1000 / durationMs) * 100 : null
  const childCpu = stat(s.map((x) => x.samplerChildCpu))
  return {
    label: sess.label,
    durationMs,
    samples: s.length,
    intervalMs: INTERVAL,
    cpuSystemPct: stat(s.map((x) => x.cpuSystemPct)),
    browserCpuPct: stat(s.map((x) => x.browserCpuPct)),
    browserCpuByType: byType,
    browserRssMB: stat(s.map((x) => x.browserRssMB)),
    browserFootprintMB: stat(s.map((x) => x.browserFootprintMB)),
    browserGpuMemMB: stat(s.map((x) => x.browserGpuMemMB)),
    mediaEncoderCpuPct: stat(s.map((x) => x.mediaEncoderCpuPct)),
    mediaDecoderCpuPct: stat(s.map((x) => x.mediaDecoderCpuPct)),
    mediaServiceFootprintMB: stat(s.map((x) => x.mediaServiceFootprintMB)),
    gpuDevicePct: stat(s.map((x) => x.gpuDevicePct)),
    gpuRendererPct: stat(s.map((x) => x.gpuRendererPct)),
    gpuTilerPct: stat(s.map((x) => x.gpuTilerPct)),
    gpuEncoderPct: stat(s.map((x) => x.gpuEncoderPct)),
    gpuDecoderPct: stat(s.map((x) => x.gpuDecoderPct)),
    gpuBrowserPct: stat(s.map((x) => x.gpuBrowserPct)),
    gpuBrowserEncoderPct: stat(s.map((x) => x.gpuBrowserEncoderPct)),
    gpuCount: s.find((x) => x.gpuCount)?.gpuCount ?? null,
    gpuPowerW: stat(s.map((x) => x.gpuPowerW)),
    cpuPowerW: stat(s.map((x) => x.cpuPowerW)),
    gpuFreqMHz: stat(s.map((x) => x.gpuFreqMHz)),
    cpuClusters: clusterStats(s),
    processFilter: sess.rootPid ? `process tree of pid ${sess.rootPid}` : 'all browser processes (name match)',
    // how each number was obtained, so weak runs can be filtered out
    method: {
      attribution: sess.attribution,
      browserCpu:
        PLATFORM === 'win32'
          ? 'Win32_Process Kernel+UserModeTime deltas (UNTESTED)'
          : PLATFORM === 'linux'
            ? `/proc/<pid>/stat utime+stime (1/${LINUX.clkTck} s resolution)`
            : helper.ok
              ? 'proc_pid_rusage user+system time (ns resolution, procstat helper); % of ONE core, summed over processes'
              : `ps cputime deltas (10 ms resolution)${helper.error ? '; ' + helper.error : ''}; % of ONE core, summed over processes`,
      browserRam: memoryMethod(),
      gpu: gpuSource ?? 'none',
      processGpu: PLATFORM === 'win32' ? 'GPU Engine counters per PID (UNTESTED)' : PROCESS_GPU ? (power.allTasksGpuMsPerS > 0 ? 'powermetrics tasks GPU ms/s' : 'powermetrics tasks: macOS reported 0 GPU ms/s for every task (not available)') : null,
      power: power.ok ? 'powermetrics (+ CPU cluster frequency/residency)' : s.some((x) => x.gpuPowerW !== null) ? 'nvidia-smi power.draw' : s.some((x) => x.cpuPowerW !== null) ? 'RAPL package energy' : null,
      cores: { logical: os.cpus().length, ...coreTypes },
    },
    baseline: sess.baseline,
    conditions: sess.conditions ?? null,
    samplerOverhead: {
      serverCpuPct, // the bench-server's own JS
      probeCpuPct: childCpu?.avg ?? null, // long-lived probes it started (procstat / PowerShell / powermetrics)
      spawnsPerSample: s.length ? (spawnCount - sess.spawnStart) / s.length : null,
    },
    cores: os.cpus().length,
    marks: sess.marks,
    raw: s.map((x) => ({ t: x.t - sess.start, cpu: x.cpuSystemPct, browser: x.browserCpuPct, gpu: x.gpuDevicePct, rss: x.browserRssMB, footprint: x.browserFootprintMB })),
  }
}

/** Apple Silicon / Intel hybrid core counts (performance vs efficiency), when the OS reports them. */
const coreTypes = {}
if (PLATFORM === 'darwin') {
  try {
    const out = execFileSync('sysctl', ['-n', 'hw.nperflevels', 'hw.perflevel0.logicalcpu', 'hw.perflevel0.name', 'hw.perflevel1.logicalcpu', 'hw.perflevel1.name'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')
    if (Number(out[0]) >= 2) Object.assign(coreTypes, { [out[2].toLowerCase()]: Number(out[1]), [out[4].toLowerCase()]: Number(out[3]) })
  } catch {
    /* Intel Mac: single core type */
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
/** A failed write (e.g. the file was created by a `sudo` run and this one isn't root) must not kill the server. */
function persistError(e) {
  console.error(`⚠ could not write ${path.relative(ROOT, RECORDS_FILE)} (${e.code ?? e.message}). Results stay in memory only. If an earlier sudo run created it: sudo chown $(whoami) ${RECORDS_FILE}`)
}
function persistAll() {
  try {
    writeFileSync(RECORDS_FILE, [...records.values()].map((r) => JSON.stringify(r)).join('\n') + (records.size ? '\n' : ''))
  } catch (e) {
    persistError(e)
  }
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
      footprintMB: x.browserFootprintMB,
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
    const { label, rootPid: _r, pagePort: _pp, ...meta } = body
    // Which processes are "the browser": Playwright passes its PID; otherwise find the browser behind this
    // request's socket (forwarded by the Vite bridge), and only then fall back to the executable-name list.
    let rootPid = Number(body.rootPid) || null
    let attribution
    if (rootPid) attribution = { method: 'playwright-pid', rootPid, via: `pid ${rootPid} passed by Playwright` }
    else {
      const r = await resolveBrowserRoot({ peerPort: Number(req.headers['x-bench-peer-port']) || null, pagePort: Number(req.headers['x-bench-page-port'] || body.pagePort) || null })
      if (r?.rootPid) {
        rootPid = r.rootPid
        attribution = { method: r.safari ? 'safari-webkit' : r.ambiguous ? 'page-port-ambiguous' : 'socket', rootPid, browser: r.browser, via: r.via }
      } else attribution = { method: 'name-match', rootPid: null, via: r?.via ?? 'no connection found: all processes whose executable is a known browser' }
    }
    const base = (k) => stat(recent.map((x) => x[k]))?.avg ?? null
    const baseline = {
      samples: recent.length,
      cpuSystemPct: base('cpuSystemPct'),
      gpuDevicePct: base('gpuDevicePct'),
      gpuPowerW: base('gpuPowerW'),
      cpuPowerW: base('cpuPowerW'),
      backgroundLoad: backgroundLoad(recent), // busiest non-browser processes just before the job
    }
    const sess = { label: String(label ?? `job ${id}`), rootPid, attribution, baseline, meta, start: Date.now(), samples: [], marks: [], mainThread: [], progress: [], cpuStart: process.cpuUsage(), spawnStart: spawnCount }
    // power source / thermal state: read in the background so the job doesn't wait for it
    sess.conditionsP = runConditions().then((c) => (sess.conditions = c))
    sessions.set(id, sess)
    if (!QUIET) console.log(`▶ ${meta.kind ?? 'job'} ${id} start: ${label ?? ''} · browser: ${attribution.via}`)
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
          sess.cpuEnd = process.cpuUsage(sess.cpuStart)
          sessions.delete(id)
          finished.set(id, sess)
          await Promise.race([sess.conditionsP, new Promise((r) => setTimeout(r, 2000))])
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
        try {
          appendFileSync(RECORDS_FILE, JSON.stringify(record) + '\n')
        } catch (e) {
          persistError(e)
        }
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
