/**
 * Main-thread blocking measurement (in page). Playwright reads the same numbers through
 * window.__nleBench, and adds CDP Performance.getMetrics deltas on top.
 */

const longTasks = []
const loafs = []
let installed = false

export function installMainThreadObservers() {
  if (installed || typeof PerformanceObserver === 'undefined') return
  installed = true
  const types = PerformanceObserver.supportedEntryTypes ?? []
  if (types.includes('longtask')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration })
      if (longTasks.length > 20000) longTasks.splice(0, 10000)
    }).observe({ type: 'longtask', buffered: true })
  }
  if (types.includes('long-animation-frame')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const blocking = e.blockingDuration ?? 0
        loafs.push({ start: e.startTime, duration: e.duration, blocking })
      }
      if (loafs.length > 20000) loafs.splice(0, 10000)
    }).observe({ type: 'long-animation-frame', buffered: true })
  }
}

function inWindow(list, a, b) {
  return list.filter((t) => t.start + t.duration > a && t.start < b)
}

/** Starts tracking; call the returned function when the job ends. */
export function startMainThreadWindow() {
  installMainThreadObservers()
  const start = performance.now()
  const deltas = []
  let last = start
  let running = true
  const tick = (t) => {
    if (!running) return
    deltas.push(t - last)
    last = t
    requestAnimationFrame(tick)
  }
  const raf = typeof requestAnimationFrame === 'function'
  if (raf) requestAnimationFrame(tick)

  return () => {
    running = false
    const end = performance.now()
    const lt = inWindow(longTasks, start, end)
    const total = lt.reduce((s, t) => s + t.duration, 0)
    const tbt = lt.reduce((s, t) => s + Math.max(0, t.duration - 50), 0)
    const lf = inWindow(loafs, start, end)
    const sorted = [...deltas].sort((a, b) => a - b)
    const supported = (PerformanceObserver.supportedEntryTypes ?? []).includes('longtask')
    // Without the Long Tasks API (Firefox, WebKit) these are unknown, not 0: report null so nothing reads "TBT 0"
    const lt0 = (v) => (supported ? v : null)
    return {
      windowMs: end - start,
      longTaskSupported: supported,
      longTasks: lt0(lt.length),
      longestTaskMs: lt0(lt.reduce((m, t) => Math.max(m, t.duration), 0)),
      longTaskTotalMs: lt0(total),
      tbtMs: lt0(tbt),
      blockedPct: lt0(end > start ? (Math.min(total, end - start) / (end - start)) * 100 : 0),
      loafCount: (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame') ? lf.length : null,
      loafBlockingMs: (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame') ? lf.reduce((s, t) => s + (t.blocking ?? 0), 0) : null,
      rafFrames: deltas.length,
      rafGapsOver50ms: deltas.filter((d) => d > 50).length,
      rafP95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
      rafMaxMs: sorted.length ? sorted[sorted.length - 1] : null,
    }
  }
}

/**
 * Streams main-thread blocking in fixed buckets (for the live dashboard).
 * Long-task entries arrive slightly after the task ends, so each bucket is reported
 * one interval late to let the observer catch up.
 */
export function startMainThreadStream(onBucket, intervalMs = 500) {
  installMainThreadObservers()
  let bucketStart = performance.now()
  let maxGap = 0
  let last = performance.now()
  let running = true
  const tick = (t) => {
    if (!running) return
    maxGap = Math.max(maxGap, t - last)
    last = t
    requestAnimationFrame(tick)
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick)
  const flush = (end) => {
    const a = bucketStart
    let blocked = 0
    let tbt = 0
    let count = 0
    let max = 0
    for (const lt of longTasks) {
      const s = lt.start
      const e = lt.start + lt.duration
      if (e <= a || s >= end) continue
      blocked += Math.min(e, end) - Math.max(s, a)
      if (e > a && e <= end) {
        count++
        tbt += Math.max(0, lt.duration - 50)
        max = Math.max(max, lt.duration)
      }
    }
    // no Long Tasks API (Firefox, WebKit): long-task numbers are unknown, not 0; frame gaps still count
    const lt = (PerformanceObserver.supportedEntryTypes ?? []).includes('longtask')
    onBucket({ t: Date.now(), windowMs: end - a, longTasks: lt ? count : null, blockedMs: lt ? blocked : null, tbtMs: lt ? tbt : null, maxTaskMs: lt ? max : null, maxFrameGapMs: maxGap })
    bucketStart = end
    maxGap = 0
  }
  const timer = setInterval(() => flush(performance.now() - 60), intervalMs)
  return () => {
    running = false
    clearInterval(timer)
    // final bucket after a short delay so trailing long-task entries are delivered
    setTimeout(() => flush(performance.now()), 120)
  }
}
