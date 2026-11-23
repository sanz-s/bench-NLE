/**
 * Client for the OPTIONAL local bench-server (CPU/GPU sampler). The editor never depends on it:
 * every call returns null when the server isn't running.
 */

const BASE = '/bench-api'

let rootPid = null
let automated = false
/** Playwright passes the launched browser PID so the server only counts that process tree. */
export function setServerRootPid(pid) {
  rootPid = pid
  automated = pid !== null
}
/** Runs started by Playwright are tagged so the dashboard can hide them by default. */
export function setAutomated(v) {
  automated = v
}

/** One main-thread bucket (default 500 ms) streamed live to the dashboard. */
async function call(path, init, timeoutMs = 1500) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, { ...init, signal: ctrl.signal, headers: { 'content-type': 'application/json' } })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function serverHealth() {
  return call('/health', undefined, 800)
}

export async function startSession(label, meta) {
  // pagePort: fallback for finding this browser's processes when the request doesn't come through the Vite bridge.
  // Longer timeout: the server looks the browser up (lsof / Get-NetTCPConnection) and takes a baseline sample before
  // answering, which took > 5 s on a loaded Windows laptop. If we give up anyway, the server drops the unused session
  // after 15 s (a "phantom") so it can't be counted as an overlapping job.
  const r = await call(
    '/sessions',
    { method: 'POST', body: JSON.stringify({ label, rootPid, pagePort: Number(location.port) || null, source: automated ? 'playwright' : 'editor', ...meta }) },
    15000,
  )
  return r?.id ?? null
}

/** Fire-and-forget live updates (progress, main-thread buckets) for the dashboard. */
export function sendProgress(id, progress, processedTime) {
  void call(`/sessions/${id}/progress`, { method: 'POST', body: JSON.stringify({ progress, processedTime }) }, 1000)
}
export function sendMainThread(id, bucket) {
  void call(`/sessions/${id}/mainthread`, { method: 'POST', body: JSON.stringify(bucket) }, 1000)
}
/** Final report: the server merges it with the session's CPU/GPU/main-thread time series and saves it. */
export function sendReport(id, report) {
  return call(`/sessions/${id}/report`, { method: 'POST', body: JSON.stringify(report) }, 4000)
}

export function markSession(id, name) {
  return call(`/sessions/${id}/mark`, { method: 'POST', body: JSON.stringify({ name }) })
}

export function stopSession(id) {
  return call(`/sessions/${id}/stop`, { method: 'POST', body: '{}' }, 4000)
}

export function liveSample() {
  return call(`/live${rootPid ? `?rootPid=${rootPid}` : ''}`, undefined, 1000)
}
