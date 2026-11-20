/**
 * Pure parsers for the bench-server's OS probes (no I/O, no state), so every platform format can be unit-tested
 * from fixture text: `node --test bench-server/`. The server (server.mjs) does the spawning and file reads.
 */
import path from 'node:path'

// ------------------------------------------------------------------ browser executables

/**
 * Browser processes are recognised by EXECUTABLE NAME (basename of `ps -o comm`, `/proc/<pid>/stat` comm,
 * or Win32_Process.Name), never by command line: matching whole command lines also caught Spotify/CEF,
 * `searchpartyd` ("se-arc-h"), security agents whose arguments mention chrome-extension://, and so on.
 * Linux `comm` is cut to 15 chars; Firefox's Linux children ("Web Content", …) are found as descendants.
 */
export const BROWSER_EXE_RE = new RegExp(
  '^(?:' +
    [
      'Google Chrome(?: (?:Beta|Dev|Canary|for Testing))?(?: Helper.*)?',
      'Chromium(?: Helper.*)?',
      'Chrome for Testing(?: Helper.*)?',
      'chrome-headless-shell',
      'chrome-headless-s', // Linux comm (15 chars)
      'headless_shell',
      'Microsoft Edge(?: (?:Beta|Dev|Canary))?(?: Helper.*)?',
      'Brave Browser(?: (?:Beta|Nightly))?(?: Helper.*)?',
      'Vivaldi(?: Helper.*)?',
      'Opera(?: (?:GX|Beta|Developer))?(?: Helper.*)?',
      'Arc(?: Helper.*)?',
      'Ulaa(?: Helper.*)?',
      'firefox(?:-bin)?',
      '(?:Firefox|Nightly)(?: GPU Helper| Media Plugin Helper)?', // macOS app helpers (Nightly = Playwright's Firefox)
      'plugin-container',
      'Safari',
      'com\\.apple\\.WebKit\\.(?:WebContent|GPU|Networking)(?:\\.Development)?', // .Development = Playwright's WebKit
      // Playwright's WebKit build: pw_run.sh → Playwright (macOS/Windows UI) or MiniBrowser (Linux) + WebKit*Process
      'Playwright(?:\\.exe)?',
      'MiniBrowser',
      'WebKit(?:Web|Network|GPU)Process(?:\\.exe)?',
      // Linux / Windows executable names
      'chrome',
      'chromium(?:-browse)?',
      'msedge',
      'brave',
      'vivaldi-bin',
      'opera',
      '(?:chrome|msedge|brave|firefox|opera|vivaldi)\\.exe',
    ].join('|') +
    ')$',
  'i',
)
export const isBrowserExe = (exe) => BROWSER_EXE_RE.test(exe ?? '') && !/crashpad/i.test(exe ?? '')
/**
 * macOS VideoToolbox services: browsers hand hardware encode/decode to these launchd XPC processes (not their
 * children). Their CPU/memory is the measurable side of Media Engine work (the engine's own load is not exposed).
 */
export const isMediaService = (exe) => /^(?:VTEncoderXPCService|VTDecoderXPCService)$/.test(exe ?? '')
/** Safari's helpers are XPC services parented by launchd and shared with other WebKit apps (Mail, …). */
export const isWebKitService = (exe) => /^com\.apple\.WebKit\./.test(exe ?? '') && !isPlaywrightWebKitService(exe)
/**
 * Playwright's WebKit on macOS: the same XPC services, built as `com.apple.WebKit.*.Development` and also parented by
 * launchd, so they are never in the browser's process tree. The suffix keeps them apart from Safari's and Mail's.
 */
export const isPlaywrightWebKitService = (exe) => /^com\.apple\.WebKit\.\w+\.Development$/.test(exe ?? '')

// ------------------------------------------------------------------ process tables

/** ps cputime "1-02:03:04.56" | "1:02:03.45" | "02:03.45" | "3.45" → seconds */
export function parseCpuTime(s) {
  let days = 0
  if (s.includes('-')) {
    const [d, rest] = s.split('-')
    days = Number(d)
    s = rest
  }
  let sec = 0
  for (const p of s.split(':').map(Number)) sec = sec * 60 + p
  return sec + days * 86400
}

/** `ps -axww -o pid=,ppid=,time=,rss=,comm=` (macOS / BSD) → [{pid, ppid, cpu (s), rssKB, exe}] */
export function parsePsComm(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: parseCpuTime(m[3]), rssKB: Number(m[4]), exe: path.basename(m[5].trim()) })
  }
  return out
}

/**
 * bench-server/native/procstat output (macOS, one line per process, then "END"):
 *   pid \t ppid \t cpu_ns \t phys_footprint_bytes \t resident_bytes \t executable path
 */
export function parseProcstat(text) {
  const out = []
  for (const line of text.split('\n')) {
    const f = line.split('\t')
    if (f.length < 6) continue
    out.push({ pid: Number(f[0]), ppid: Number(f[1]), cpu: Number(f[2]) / 1e9, footprintMB: Number(f[3]) / 1048576, rssKB: Number(f[4]) / 1024, exe: path.basename(f.slice(5).join('\t')) })
  }
  return out
}

/** `ps -ww -o pid=,args= -p …` → Map pid → args */
export function parsePsArgs(text) {
  const out = new Map()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m) out.set(Number(m[1]), m[2])
  }
  return out
}

/**
 * Linux `/proc/<pid>/stat`. comm is in parentheses and may itself contain spaces or ")", so split at the LAST ")".
 * Fields after comm: 3 state, 4 ppid, … 14 utime, 15 stime (clock ticks), … 24 rss (pages).
 */
export function parseProcStat(text, { clkTck = 100, pageSize = 4096 } = {}) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const exe = text.slice(open + 1, close)
  const f = text.slice(close + 2).trim().split(/\s+/) // f[0] = field 3 (state)
  const at = (n) => Number(f[n - 3])
  return { pid, ppid: at(4), exe, cpu: (at(14) + at(15)) / clkTck, rssKB: (at(24) * pageSize) / 1024 }
}

/** Linux `/proc/<pid>/cmdline` (NUL-separated) → "arg0 arg1 …" */
export const parseProcCmdline = (buf) => String(buf).replace(/\0+$/, '').split('\0').join(' ')

/** Linux `/proc/<pid>/smaps_rollup` → PSS in kB (null if absent) */
export function parseSmapsRollupPss(text) {
  const m = /^Pss:\s+(\d+)\s+kB/m.exec(text)
  return m ? Number(m[1]) : null
}

// ------------------------------------------------------------------ memory (macOS phys_footprint via top)

/** "413M" | "12K" | "1.2G" | "512B" | "413M+" | "39M-" → MB */
export function parseTopSize(s) {
  const m = /^([\d.]+)([BKMGT])?[+-]?$/i.exec(String(s).trim())
  if (!m) return null
  const k = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024, T: 1048576 }[(m[2] ?? 'B').toUpperCase()]
  return Number(m[1]) * k
}

/**
 * Streaming `top -l 0 -s 1 -stats pid,mem` output: each sample block starts with a "PID  MEM" header.
 * `top`'s MEM column is the process's physical footprint (the Activity Monitor "Memory" figure; it includes
 * the process's owned graphics/IOSurface memory). Returns the pid → MB map of every COMPLETE block.
 */
export function parseTopBlocks(text) {
  const blocks = text.split(/^\s*PID\s+MEM\s*$/m).slice(1)
  return blocks.map((b) => {
    const m = new Map()
    for (const line of b.split('\n')) {
      const r = /^\s*(\d+)\*?\s+(\S+)\s*$/.exec(line)
      if (r) {
        const mb = parseTopSize(r[2])
        if (mb !== null) m.set(Number(r[1]), mb)
      }
    }
    return m
  })
}

// ------------------------------------------------------------------ GPU

/**
 * `ioreg -r -d 1 -w 0 -c IOAccelerator`: one PerformanceStatistics dict per GPU. Returns the busiest GPU
 * (Macs with integrated + discrete graphics list both) and how many were seen.
 */
export function parseIoregGpu(text) {
  const all = (key) => [...text.matchAll(new RegExp(`"${key}"=(\\d+)`, 'g'))].map((m) => Number(m[1]))
  const dev = all('Device Utilization %')
  if (!dev.length) return null
  const i = dev.indexOf(Math.max(...dev))
  return { device: dev[i], renderer: all('Renderer Utilization %')[i] ?? null, tiler: all('Tiler Utilization %')[i] ?? null, encoder: null, decoder: null, gpus: dev.length }
}

/** `nvidia-smi --query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,power.draw --format=csv,noheader,nounits` (one line per GPU) */
export function parseNvidiaSmi(text) {
  const rows = text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(',').map((x) => Number(x.trim())))
  if (!rows.length) return null
  const ok = (v) => (Number.isFinite(v) ? v : null)
  const max = (k) => rows.reduce((m, r) => (ok(r[k]) === null ? m : Math.max(m ?? 0, r[k])), null)
  const powers = rows.map((r) => ok(r[3])).filter((v) => v !== null)
  return { device: max(0), renderer: null, tiler: null, encoder: max(1), decoder: max(2), powerW: powers.length ? powers.reduce((a, b) => a + b, 0) : null, gpus: rows.length }
}

/** Windows GPU counter instance → {pid, engtype}. "pid_1234_luid_0x0_0xD1E8_phys_0_eng_0_engtype_VideoEncode" */
export function parseGpuEngineInstance(name) {
  const pid = /pid_(\d+)/.exec(name)
  const eng = /engtype_([\w]+)/i.exec(name)
  return { pid: pid ? Number(pid[1]) : null, engtype: eng ? eng[1] : null }
}

/**
 * Windows `\GPU Engine(*)\Utilization Percentage` samples → totals per engine type (like Task Manager:
 * instances of one engine type are summed and capped at 100), plus the same restricted to `pids`.
 * Engine types are compared lower-case (Get-Counter reports instance names lower-cased: "engtype_3d").
 */
export function summarizeGpuEngines(samples, pids) {
  const total = {}
  const mine = {}
  for (const s of samples) {
    const { pid, engtype } = parseGpuEngineInstance(s.n)
    if (!engtype) continue
    const k = engtype.toLowerCase()
    total[k] = (total[k] ?? 0) + s.v
    if (pid !== null && pids?.has(pid)) mine[k] = (mine[k] ?? 0) + s.v
  }
  const cap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.min(100, v)]))
  const t = cap(total)
  const m = cap(mine)
  const vals = Object.values(t)
  return {
    device: vals.length ? Math.max(...vals) : null,
    renderer: t['3d'] ?? null,
    tiler: null,
    encoder: t.videoencode ?? null,
    decoder: t.videodecode ?? null,
    browser3d: pids ? (m['3d'] ?? 0) : null,
    browserEncoder: pids ? (m.videoencode ?? 0) : null,
    byEngine: t,
  }
}

/** Windows `\GPU Process Memory(*)\Dedicated Usage|Shared Usage` samples (bytes) → MB for `pids` */
export function summarizeGpuProcessMemory(samples, pids) {
  let dedicated = 0
  let shared = 0
  for (const s of samples) {
    const { pid } = parseGpuEngineInstance(s.n)
    if (pid === null || !pids.has(pid)) continue
    if (/dedicated/i.test(s.c)) dedicated += s.v
    else if (/shared/i.test(s.c)) shared += s.v
  }
  return { dedicatedMB: dedicated / 1048576, sharedMB: shared / 1048576 }
}

// ------------------------------------------------------------------ Linux DRM fdinfo (per-client GPU engine time)

/**
 * One `/proc/<pid>/fdinfo/<fd>` of a DRM device → { driver, pdev, clientId, engines } or null when it isn't a DRM
 * client with usage stats (kernel "DRM client usage stats": i915 ≥ 5.19, amdgpu ≥ 5.14, xe, msm, panfrost, v3d …).
 * Engines: `drm-engine-<name>: N ns` (busy time) or, on Intel xe, `drm-cycles-<name>` against
 * `drm-total-cycles-<name>` (busy vs elapsed GPU cycles); `drm-engine-capacity-<name>` = engines of that class.
 */
export function parseDrmFdinfo(text) {
  const kv = {}
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(drm-[\w.-]+):\s*(.+?)\s*$/.exec(line)
    if (m) kv[m[1]] = m[2]
  }
  if (!kv['drm-driver'] || kv['drm-client-id'] === undefined) return null
  const engines = {}
  const eng = (name) => (engines[name] ??= { ns: null, cycles: null, totalCycles: null, capacity: 1 })
  for (const [k, v] of Object.entries(kv)) {
    let m
    if ((m = /^drm-engine-capacity-(.+)$/.exec(k))) eng(m[1]).capacity = Math.max(1, Number(v) || 1)
    else if ((m = /^drm-engine-(.+)$/.exec(k)) && /\bns$/.test(v)) eng(m[1]).ns = Number(v.split(/\s+/)[0])
    else if ((m = /^drm-total-cycles-(.+)$/.exec(k))) eng(m[1]).totalCycles = Number(v)
    else if ((m = /^drm-cycles-(.+)$/.exec(k))) eng(m[1]).cycles = Number(v)
  }
  for (const [k, e] of Object.entries(engines)) if (e.ns === null && e.cycles === null) delete engines[k]
  if (!Object.keys(engines).length) return null
  return { driver: kv['drm-driver'], pdev: kv['drm-pdev'] ?? '', clientId: kv['drm-client-id'], engines }
}

/** Engine names across drivers → renderer (3D) / video (encode + decode) groups. */
const DRM_RENDER = /^(?:render|gfx|rcs|3d|fragment|vertex-tiler|gpu)$/i
const DRM_VIDEO = /^(?:video|video-enhance|enc|dec|enc_\d+|dec_\d+|vcs|vecs|vcn|jpeg)$/i

/**
 * Two fdinfo snapshots → GPU utilisation per engine, for all clients and per client.
 * `prev`/`cur`: Map "<pdev>|<client-id>" → { pids: Set, engines } (one client can be open in several fds and
 * forked processes: keyed once, so it isn't counted twice). `dtNs` = wall time between the snapshots.
 * Returns { byEngine, device, renderer, video, clients: Map key → { pids, byEngine } } (percent, capped at 100).
 */
export function drmUtilization(prev, cur, dtNs) {
  const byEngine = {}
  const clients = new Map()
  for (const [key, c] of cur) {
    const p = prev?.get(key)
    if (!p) continue // a client needs two readings
    const mine = {}
    for (const [name, e] of Object.entries(c.engines)) {
      const q = p.engines[name]
      if (!q) continue
      let pct = null
      if (e.ns !== null && q.ns !== null && dtNs > 0) pct = ((e.ns - q.ns) / dtNs / e.capacity) * 100
      else if (e.cycles !== null && q.cycles !== null && e.totalCycles !== null && q.totalCycles !== null && e.totalCycles > q.totalCycles)
        pct = ((e.cycles - q.cycles) / (e.totalCycles - q.totalCycles) / e.capacity) * 100
      if (pct === null || !Number.isFinite(pct) || pct < 0) continue
      mine[name] = Math.min(100, pct)
      byEngine[name] = Math.min(100, (byEngine[name] ?? 0) + mine[name])
    }
    clients.set(key, { pids: c.pids, byEngine: mine })
  }
  return { ...drmGroups(byEngine), clients }
}

function drmGroups(byEngine) {
  const vals = Object.values(byEngine)
  const max = (re) => {
    const v = Object.entries(byEngine).filter(([k]) => re.test(k)).map(([, x]) => x)
    return v.length ? Math.max(...v) : null
  }
  return { byEngine, device: vals.length ? Math.max(...vals) : null, renderer: max(DRM_RENDER), video: max(DRM_VIDEO) }
}

/** The same utilisation restricted to clients opened by any of `pids` (the benchmark browser's processes). */
export function drmUtilizationFor(util, pids) {
  if (!util || !pids) return null
  const byEngine = {}
  for (const c of util.clients.values()) {
    if (![...c.pids].some((p) => pids.has(p))) continue
    for (const [k, v] of Object.entries(c.byEngine)) byEngine[k] = Math.min(100, (byEngine[k] ?? 0) + v)
  }
  return drmGroups(byEngine)
}

/** Intel RC6 / gt-idle residency (ms idle) → whole-GPU busy % between two readings (null if it went backwards). */
export function rc6BusyPct(prevMs, curMs, dtMs) {
  if (prevMs === null || curMs === null || !(dtMs > 0) || curMs < prevMs) return null
  return Math.max(0, Math.min(100, (1 - (curMs - prevMs) / dtMs) * 100))
}

// ------------------------------------------------------------------ attribution (which process owns a socket)

/**
 * `lsof -nP -a -iTCP:<port> -sTCP:ESTABLISHED -Fpn` → pids holding the browser end.
 * peer mode: the browser's local port is peerPort. page mode: the browser's remote port is pagePort.
 */
export function parseLsofOwners(text, { peerPort, pagePort, selfPid }) {
  const pids = new Set()
  let pid = null
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid && pid !== selfPid) {
      const m = /:(\d+)->.*:(\d+)$/.exec(line.slice(1))
      if (!m) continue
      const [local, remote] = [Number(m[1]), Number(m[2])]
      if (peerPort ? local === peerPort : remote === pagePort) pids.add(pid)
    }
  }
  return pids
}

/** Linux /proc/net/tcp(6) → socket inodes of ESTABLISHED (st 01) connections matching the port rule */
export function parseProcNetTcp(text, { peerPort, pagePort }) {
  const inodes = new Set()
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || f[3] !== '01') continue
    const local = parseInt(f[1].split(':').pop(), 16)
    const remote = parseInt(f[2].split(':').pop(), 16)
    if (peerPort ? local === peerPort : remote === pagePort) inodes.add(f[9])
  }
  return inodes
}

// ------------------------------------------------------------------ run conditions

/** macOS `pmset -g batt` → {source: 'ac'|'battery', batteryPct} */
export function parsePmsetBatt(text) {
  const src = /drawing from '([^']+)'/i.exec(text)?.[1] ?? ''
  const pct = /(\d+)%/.exec(text)
  return { source: /ac/i.test(src) ? 'ac' : /batt/i.test(src) ? 'battery' : null, batteryPct: pct ? Number(pct[1]) : null }
}
/** macOS `pmset -g` → lowpowermode on/off */
export function parsePmsetLowPower(text) {
  const m = /lowpowermode\s+(\d)/i.exec(text)
  return m ? m[1] === '1' : null
}
/** macOS `pmset -g therm` → {thermalWarning, performanceWarning, cpuSpeedLimit} ("No … recorded" = none) */
export function parsePmsetTherm(text) {
  const level = (what) => {
    if (new RegExp(`No ${what} warning level has been recorded`, 'i').test(text)) return 'none'
    const m = new RegExp(`${what} warning level[^\\d]*(\\d+)`, 'i').exec(text)
    return m ? Number(m[1]) : null
  }
  const lim = /CPU_Speed_Limit\s*=\s*(\d+)/i.exec(text)
  return { thermalWarning: level('thermal'), performanceWarning: level('performance'), cpuSpeedLimitPct: lim ? Number(lim[1]) : null }
}

// ------------------------------------------------------------------ powermetrics (text output)

/**
 * One `powermetrics --samplers cpu_power,gpu_power` line → partial update {gpuW|cpuW|gpuMHz|gpuActive}, or a CPU
 * cluster reading {cluster: 'E'|'P'|'P0'…, mhz|activePct} ("E-Cluster HW active frequency: 1754 MHz").
 */
export function parsePowermetricsLine(line) {
  let m
  if ((m = /^(\w+)-Cluster HW active frequency:\s*([\d.]+)\s*MHz/i.exec(line))) return { cluster: m[1], mhz: Number(m[2]) }
  if ((m = /^(\w+)-Cluster HW active residency:\s*([\d.]+)%/i.exec(line))) return { cluster: m[1], activePct: Number(m[2]) }
  if ((m = /^GPU Power:\s*([\d.]+)\s*mW/i.exec(line))) return { gpuW: Number(m[1]) / 1000 }
  if ((m = /^CPU Power:\s*([\d.]+)\s*mW/i.exec(line))) return { cpuW: Number(m[1]) / 1000 }
  if ((m = /^GPU (?:HW )?active frequency:\s*([\d.]+)\s*MHz/i.exec(line))) return { gpuMHz: Number(m[1]) }
  if ((m = /^GPU (?:HW )?active residency:\s*([\d.]+)%/i.exec(line))) return { gpuActive: Number(m[1]) }
  return null
}

/**
 * One row of powermetrics' "Running tasks" table (tasks sampler, --show-process-gpu). Names are cut to 32 chars and
 * may contain spaces, so columns are read from the right:
 *   Name  ID  CPU ms/s  User%  Deadlines(<2ms, 2-5ms)  Wakeups(Intr, Pkg idle)  GPU ms/s
 * Returns {pid, name, cpuMsPerS, gpuMsPerS} or null (header / non-row). ALL_TASKS has pid -2.
 */
export function parsePowermetricsTaskRow(line) {
  const t = line.trim().split(/\s+/)
  if (t.length < 9) return null
  const nums = t.slice(-8)
  if (!/^-?\d+$/.test(nums[0]) || nums.slice(1).some((x) => !/^-?[\d.]+$/.test(x))) return null
  return { pid: Number(nums[0]), name: t.slice(0, -8).join(' '), cpuMsPerS: Number(nums[1]), gpuMsPerS: Number(nums[7]) }
}

// ------------------------------------------------------------------ which processes are "the browser"

/** The given roots and all their descendants. */
export function withDescendants(procs, roots) {
  const children = new Map()
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid).push(p)
  }
  const seen = new Set()
  const out = []
  const stack = [...roots]
  while (stack.length) {
    const p = stack.pop()
    if (seen.has(p.pid)) continue
    seen.add(p.pid)
    out.push(p)
    for (const c of children.get(p.pid) ?? []) stack.push(c)
  }
  return out
}

/** Topmost ancestor of `pid` (inclusive) whose executable is a browser: the browser's main process. */
export function browserRootOf(procs, pid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  let p = byPid.get(pid)
  if (!p || !isBrowserExe(p.exe)) return null
  for (let parent = byPid.get(p.ppid); parent && parent.pid > 1 && isBrowserExe(parent.exe); parent = byPid.get(parent.ppid)) p = parent
  return p
}

/**
 * The processes counted as "the browser" for one sample.
 *  - rootPid given → that process tree (+ Playwright WebKit's launchd services on macOS). A WebKit service root means Safari: Safari + every com.apple.WebKit.* service
 *    (they are launchd children shared with other WebKit apps, so this is a name group, not a tree).
 *  - no rootPid → name match: every browser main process (parent isn't a browser) plus its descendants.
 * Non-browser children (extension native-messaging hosts, crash reporters) are dropped; a given root is always kept.
 * On Linux, Firefox renames its children ("Web Content", …), so non-browser names are kept there unless they are
 * extension hosts. `selfPid`'s own children (ps, top, …) never count.
 */
export function selectBrowserProcs(procs, { rootPid = null, platform = process.platform, selfPid = null } = {}) {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const root = rootPid ? byPid.get(rootPid) : null
  let selected
  let mode
  if (root && isWebKitService(root.exe)) {
    mode = 'safari-webkit'
    selected = procs.filter((p) => p.exe === 'Safari' || isWebKitService(p.exe))
  } else if (root) {
    mode = 'tree'
    selected = withDescendants(procs, [root])
    // Playwright's WebKit on macOS: page, GPU and network work runs in launchd-parented services outside the tree.
    // Several Playwright WebKits running at once would share these (they can't be told apart).
    if (platform === 'darwin' && selected.some((p) => p.exe === 'Playwright')) {
      mode = 'tree+playwright-webkit'
      const have = new Set(selected.map((p) => p.pid))
      selected = [...selected, ...procs.filter((p) => isPlaywrightWebKitService(p.exe) && !have.has(p.pid))]
    }
  } else {
    mode = 'name-match'
    selected = withDescendants(
      procs,
      procs.filter((p) => isBrowserExe(p.exe) && !isBrowserExe(byPid.get(p.ppid)?.exe ?? '')),
    )
  }
  const keep = (p) =>
    p.pid === rootPid ||
    (p.ppid !== selfPid &&
      !/crashpad/i.test(p.exe) &&
      (isBrowserExe(p.exe) || (platform === 'linux' && !/\schrome-extension:\/\/|\smoz-extension:\/\//.test(p.cmd ?? ''))))
  return { selected: selected.filter(keep), mode }
}

// ------------------------------------------------------------------ Chrome process types

export function procType(cmd, exe = '') {
  // WebKit (Safari, Playwright's WebKit) names its roles in the executable
  if (/WebContent|WebKitWebProces/.test(exe)) return 'renderer'
  if (/^com\.apple\.WebKit\.GPU|WebKitGPUProces/.test(exe)) return 'gpu-process'
  if (/^com\.apple\.WebKit\.Networking|WebKitNetworkPr/.test(exe)) return 'utility-network'
  const m = /--type=([\w-]+)/.exec(cmd ?? '')
  if (!m) {
    // Firefox children name their role as the last argument: "… <parent pid> <ipc pipe> tab"
    const ff = /(?:plugin-container|GPU Helper)\S*\s.*\s(tab|gpu|rdd|socket|utility|gmplugin|forkserver)\s*$/.exec(cmd ?? '')
    if (ff) return { tab: 'renderer', gpu: 'gpu-process', rdd: 'utility-media', socket: 'utility-network', utility: 'utility', gmplugin: 'utility-media', forkserver: 'utility' }[ff[1]]
    return 'browser'
  }
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
