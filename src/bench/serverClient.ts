/**
 * Client for the OPTIONAL local bench-server (CPU/GPU sampler). The editor never depends on it:
 * every call returns null when the server isn't running.
 */

const BASE = '/bench-api'

export interface ServerHealth {
  ok: boolean
  platform: string
  gpuSource: string | null
  powermetrics: boolean
  intervalMs: number
}

export interface Stat {
  avg: number
  p95: number
  max: number
}

export interface SystemSummary {
  label: string
  durationMs: number
  samples: number
  intervalMs: number
  cpuSystemPct: Stat | null
  /** Browser CPU summed over all its processes, in % of ONE core (can exceed 100). */
  browserCpuPct: Stat | null
  browserCpuByType: Record<string, Stat>
  browserRssMB: Stat | null
  gpuDevicePct: Stat | null
  gpuRendererPct: Stat | null
  gpuTilerPct: Stat | null
  gpuPowerW: Stat | null
  cpuPowerW: Stat | null
  gpuFreqMHz: Stat | null
  processFilter: string
  cores: number
}

export interface LiveSample {
  t: number
  cpuSystemPct: number | null
  browserCpuPct: number | null
  browserRssMB: number | null
  gpuDevicePct: number | null
  gpuPowerW: number | null
}

let rootPid: number | null = null
let automated = false
/** Playwright passes the launched browser PID so the server only counts that process tree. */
export function setServerRootPid(pid: number | null) {
  rootPid = pid
  automated = pid !== null
}
/** Runs started by Playwright are tagged so the dashboard can hide them by default. */
export function setAutomated(v: boolean) {
  automated = v
}

export interface SessionMeta {
  kind: 'export' | 'convert'
  runIn: 'worker' | 'main'
  container: string
  videoCodec: string | null
  audioCodec: string | null
  mediaDuration: number
}

/** One main-thread bucket (default 500 ms) streamed live to the dashboard. */
export interface MainThreadBucket {
  t: number // Date.now() at bucket end
  windowMs: number
  longTasks: number
  blockedMs: number // long-task time inside the bucket
  tbtMs: number // Σ(duration − 50) for long tasks ending in the bucket
  maxTaskMs: number
  maxFrameGapMs: number // worst rAF gap inside the bucket
}

async function call<T>(path: string, init?: RequestInit, timeoutMs = 1500): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, { ...init, signal: ctrl.signal, headers: { 'content-type': 'application/json' } })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function serverHealth(): Promise<ServerHealth | null> {
  return call<ServerHealth>('/health', undefined, 800)
}

export async function startSession(label: string, meta?: SessionMeta): Promise<string | null> {
  const r = await call<{ id: string }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ label, rootPid, source: automated ? 'playwright' : 'editor', ...meta }),
  })
  return r?.id ?? null
}

/** Fire-and-forget live updates (progress, main-thread buckets) for the dashboard. */
export function sendProgress(id: string, progress: number, processedTime: number) {
  void call(`/sessions/${id}/progress`, { method: 'POST', body: JSON.stringify({ progress, processedTime }) }, 1000)
}
export function sendMainThread(id: string, bucket: MainThreadBucket) {
  void call(`/sessions/${id}/mainthread`, { method: 'POST', body: JSON.stringify(bucket) }, 1000)
}
/** Final report: the server merges it with the session's CPU/GPU/main-thread time series and saves it. */
export function sendReport(id: string, report: unknown) {
  return call(`/sessions/${id}/report`, { method: 'POST', body: JSON.stringify(report) }, 4000)
}

export function markSession(id: string, name: string) {
  return call(`/sessions/${id}/mark`, { method: 'POST', body: JSON.stringify({ name }) })
}

export function stopSession(id: string): Promise<SystemSummary | null> {
  return call<SystemSummary>(`/sessions/${id}/stop`, { method: 'POST', body: '{}' }, 4000)
}

export function liveSample(): Promise<LiveSample | null> {
  return call<LiveSample>(`/live${rootPid ? `?rootPid=${rootPid}` : ''}`, undefined, 1000)
}
