/**
 * Main-thread blocking measurement (in page). Playwright reads the same numbers through
 * window.__nleBench, and adds CDP Performance.getMetrics deltas on top.
 */

interface TaskEntry {
  start: number
  duration: number
  blocking?: number
}

const longTasks: TaskEntry[] = []
const loafs: TaskEntry[] = []
let installed = false

export function installMainThreadObservers(): void {
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
        const blocking = (e as PerformanceEntry & { blockingDuration?: number }).blockingDuration ?? 0
        loafs.push({ start: e.startTime, duration: e.duration, blocking })
      }
      if (loafs.length > 20000) loafs.splice(0, 10000)
    }).observe({ type: 'long-animation-frame', buffered: true })
  }
}

export interface MainThreadStats {
  windowMs: number
  longTaskSupported: boolean
  longTasks: number
  longestTaskMs: number
  longTaskTotalMs: number
  /** Total Blocking Time: Σ max(0, duration − 50 ms) over long tasks in the window. */
  tbtMs: number
  /** Share of the window the main thread was inside a long task. */
  blockedPct: number
  /** Long Animation Frames (Chrome 123+). */
  loafCount: number | null
  loafBlockingMs: number | null
  /** rAF cadence while the job ran. */
  rafFrames: number
  rafGapsOver50ms: number
  rafP95Ms: number | null
  rafMaxMs: number | null
}

function inWindow(list: TaskEntry[], a: number, b: number) {
  return list.filter((t) => t.start + t.duration > a && t.start < b)
}

/** Starts tracking; call the returned function when the job ends. */
export function startMainThreadWindow(): () => MainThreadStats {
  installMainThreadObservers()
  const start = performance.now()
  const deltas: number[] = []
  let last = start
  let running = true
  const tick = (t: number) => {
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
    return {
      windowMs: end - start,
      longTaskSupported: supported,
      longTasks: lt.length,
      longestTaskMs: lt.reduce((m, t) => Math.max(m, t.duration), 0),
      longTaskTotalMs: total,
      tbtMs: tbt,
      blockedPct: end > start ? (Math.min(total, end - start) / (end - start)) * 100 : 0,
      loafCount: (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame') ? lf.length : null,
      loafBlockingMs: (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame')
        ? lf.reduce((s, t) => s + (t.blocking ?? 0), 0)
        : null,
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
export function startMainThreadStream(
  onBucket: (b: { t: number; windowMs: number; longTasks: number; blockedMs: number; tbtMs: number; maxTaskMs: number; maxFrameGapMs: number }) => void,
  intervalMs = 500,
): () => void {
  installMainThreadObservers()
  let bucketStart = performance.now()
  let maxGap = 0
  let last = performance.now()
  let running = true
  const tick = (t: number) => {
    if (!running) return
    maxGap = Math.max(maxGap, t - last)
    last = t
    requestAnimationFrame(tick)
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick)
  const flush = (end: number) => {
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
    onBucket({ t: Date.now(), windowMs: end - a, longTasks: count, blockedMs: blocked, tbtMs: tbt, maxTaskMs: max, maxFrameGapMs: maxGap })
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
