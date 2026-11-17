import { runJob, JobCanceledError } from '../media/jobs'
import { decodeCheck, probeFile } from '../media/probe'
import { deriveMetrics, envInfo } from './metrics'
import { startMainThreadStream, startMainThreadWindow } from './mainThread'
import { markSession, sendMainThread, sendProgress, sendReport, startSession, stopSession } from './serverClient'

/** Run any media job in a fresh worker (or on the main thread), measuring worker spawn separately. */
export function executeJob(job, opts) {
  if (opts.runIn === 'main') return runJob(job, { onProgress: opts.onProgress, signal: opts.signal })
  return new Promise((resolve, reject) => {
    const spawnStart = performance.now()
    let spawnMs = 0
    const worker = new Worker(new URL('../workers/media.worker.js', import.meta.url), { type: 'module', name: 'media-job' })
    const post = (m) => worker.postMessage(m)
    const onAbort = () => post({ type: 'cancel' })
    opts.signal?.addEventListener('abort', onAbort)
    const cleanup = () => {
      opts.signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    worker.onerror = (e) => {
      cleanup()
      reject(new Error(`Worker failed: ${e.message}`))
    }
    worker.onmessage = (e) => {
      const m = e.data
      if (m.type === 'ready') {
        spawnMs = performance.now() - spawnStart
        post({ type: 'run', job })
      } else if (m.type === 'progress') {
        opts.onProgress?.({ progress: m.progress, processedTime: m.processedTime })
      } else if (m.type === 'done') {
        cleanup()
        m.result.timings.workerSpawn = spawnMs
        resolve(m.result)
      } else if (m.type === 'error') {
        cleanup()
        reject(m.canceled ? new JobCanceledError() : new Error(m.message))
      }
    }
  })
}

function inputSummary(job) {
  if (job.kind === 'convert') {
    const i = job.asset.info
    return {
      name: job.asset.name,
      container: i.container,
      videoCodec: i.video?.codec ?? null,
      audioCodec: i.audio?.codec ?? null,
      width: i.video?.width ?? i.imageWidth ?? null,
      height: i.video?.height ?? i.imageHeight ?? null,
      fps: i.video?.fps ?? null,
      duration: Math.min(job.trim.end, i.duration) - job.trim.start,
      bytes: i.size,
    }
  }
  return {
    name: `Timeline "${job.project.name}"`,
    container: null,
    videoCodec: null,
    audioCodec: null,
    width: job.project.width,
    height: job.project.height,
    fps: job.project.fps,
    duration: job.range.end - job.range.start,
    bytes: null,
    clips: job.project.clips.length,
  }
}

async function verifyOutput(file, job, expectedDuration) {
  try {
    const info = await probeFile(file)
    const problems = await decodeCheck(file)
    const s = job.settings
    const expectVideo = !!s.videoCodec && !!info && !/^(mp3|wav|aac|flac|ogg)$/.test(s.container)
    if (expectVideo && info.video?.codec !== s.videoCodec) problems.push(`video codec is ${info.video?.codec ?? 'missing'}, expected ${s.videoCodec}`)
    if (s.audioCodec && info.audio && info.audio.codec !== s.audioCodec) problems.push(`audio codec is ${info.audio.codec}, expected ${s.audioCodec}`)
    const tol = Math.max(0.15, 2 / s.fps)
    if (Math.abs(info.duration - expectedDuration) > tol) problems.push(`duration ${info.duration.toFixed(3)}s vs expected ${expectedDuration.toFixed(3)}s`)
    if (expectVideo && info.video && (info.video.width !== s.width || info.video.height !== s.height)) {
      // Conversion with stream copy keeps the source size; only flag when we re-encoded.
      const copied = job.kind === 'convert' && job.engine === 'conversion' && job.allowCopy && job.asset.info.video?.codec === s.videoCodec
      if (!copied) problems.push(`size ${info.video.width}×${info.video.height}, expected ${s.width}×${s.height}`)
    }
    return {
      ok: problems.length === 0,
      problems,
      container: info.container,
      videoCodec: info.video?.codec ?? null,
      audioCodec: info.audio?.codec ?? null,
      duration: info.duration,
      width: info.video?.width,
      height: info.video?.height,
    }
  } catch (err) {
    return { ok: false, problems: [`output could not be re-opened: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

let counter = 0

/**
 * Page memory during a job (Chrome only; other browsers report nulls):
 *  - mainHeapPeakMB: peak `performance.memory.usedJSHeapSize` of the MAIN thread (sampled every 500 ms; not workers)
 *  - pageTotalMB (OPT-IN: opts.pageMemory or localStorage['bench.pageMemory'] = '1'):
 *    `performance.measureUserAgentSpecificMemory()` for the page AND its workers (needs cross-origin isolation).
 *    Chrome answers at a garbage collection it may trigger itself (13 s in testing, up to ~20 s), which could land a
 *    GC pause inside the timed export — so it's off by default. When on, it's started at job start and waited for
 *    at most 1.5 s after the job; short jobs often get null.
 */
function startPageMemoryProbe(wantPageTotal) {
  const used = () => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null)
  let peak = used()
  const timer = setInterval(() => {
    const v = used()
    if (v !== null) peak = Math.max(peak ?? 0, v)
  }, 500)
  let ua = null
  let uaPending = null
  if (wantPageTotal && globalThis.crossOriginIsolated && typeof performance.measureUserAgentSpecificMemory === 'function') {
    uaPending = performance
      .measureUserAgentSpecificMemory()
      .then((m) => {
        const byScope = {}
        for (const b of m.breakdown ?? []) {
          const kind = b.attribution?.[0]?.scope ?? (b.types?.join('+') || 'other') // "Window", "DedicatedWorker", or a type like "DOM"
          byScope[kind] = (byScope[kind] ?? 0) + b.bytes / 1048576
        }
        ua = { totalMB: m.bytes / 1048576, byScope }
      })
      .catch(() => null)
  }
  return {
    async stop() {
      clearInterval(timer)
      const v = used()
      if (v !== null) peak = Math.max(peak ?? 0, v)
      if (uaPending) await Promise.race([uaPending, new Promise((r) => setTimeout(r, 1500))])
      return {
        mainHeapPeakMB: peak,
        pageTotalMB: ua?.totalMB ?? null,
        pageByScopeMB: ua?.byScope ?? null,
        method: {
          mainHeap: performance.memory ? 'performance.memory.usedJSHeapSize (main thread only)' : 'unavailable in this browser',
          pageTotal: !wantPageTotal
            ? 'off (opt-in: may trigger a GC during the job)'
            : uaPending
              ? ua
                ? 'measureUserAgentSpecificMemory (page + workers)'
                : 'measureUserAgentSpecificMemory did not resolve within the job + 1.5 s'
              : 'unavailable (needs cross-origin isolation + Chromium)',
        },
      }
    },
  }
}

/** Full benchmark run: system session → job → main-thread stats → verification → report. */
export async function runAndReport(job, opts) {
  const id = `${Date.now().toString(36)}-${(counter++).toString(36)}`
  const label =
    opts.label ??
    (job.kind === 'export'
      ? `Export → ${job.settings.container.toUpperCase()} ${job.settings.videoCodec ?? ''}/${job.settings.audioCodec ?? ''}`
      : `${job.engine === 'conversion' ? 'Convert' : 'Pipeline'} ${job.asset.name} → ${job.settings.container.toUpperCase()} ${job.settings.videoCodec ?? ''}/${job.settings.audioCodec ?? ''}`)
  const env = await envInfo()
  const sessionId = await startSession(`${label} [${opts.runIn}]`, {
    kind: job.kind,
    runIn: opts.runIn,
    container: job.settings.container,
    videoCodec: job.settings.videoCodec,
    audioCodec: job.settings.audioCodec,
    mediaDuration: job.kind === 'export' ? job.range.end - job.range.start : Math.min(job.trim.end, job.asset.info.duration) - job.trim.start,
  })
  const stopMain = startMainThreadWindow()
  const stopStream = sessionId ? startMainThreadStream((b) => sendMainThread(sessionId, b)) : () => {}
  let lastSent = 0
  const userProgress = opts.onProgress
  opts = {
    ...opts,
    onProgress: (p) => {
      userProgress?.(p)
      const t = performance.now()
      if (sessionId && (t - lastSent > 400 || p.progress >= 1)) {
        lastSent = t
        sendProgress(sessionId, p.progress, p.processedTime)
      }
    },
  }
  let pageMemPref = false
  try {
    pageMemPref = localStorage.getItem('bench.pageMemory') === '1'
  } catch {
    /* no storage in this context */
  }
  const memProbe = startPageMemoryProbe(opts.pageMemory ?? pageMemPref)
  const wallStart = performance.now()
  let result = null
  let error
  let status = 'done'
  try {
    if (sessionId) void markSession(sessionId, 'job-start')
    result = await executeJob(job, opts)
  } catch (err) {
    status = err instanceof JobCanceledError ? 'canceled' : 'error'
    error = err instanceof Error ? err.message : String(err)
  }
  const wallMs = performance.now() - wallStart
  const mainThread = stopMain()
  stopStream()
  if (sessionId) await new Promise((r) => setTimeout(r, 150)) // let the final main-thread bucket arrive
  const system = sessionId ? await stopSession(sessionId) : null

  let file = null
  if (result) {
    if (result.buffer) file = new File([result.buffer], result.fileName, { type: result.mimeType })
    else if (job.target.kind === 'stream') file = await job.target.handle.getFile()
  }
  const input = inputSummary(job)
  const verify = file && result ? await verifyOutput(file, job, result.mediaDuration) : null
  const memory = await memProbe.stop() // after wallMs/timings, so waiting for it never inflates them
  const bytes = result?.outputBytes ?? 0
  const report = {
    id,
    label,
    createdAt: new Date().toISOString(),
    kind: job.kind,
    engine: job.kind === 'export' ? 'timeline' : job.engine,
    runIn: opts.runIn,
    target: job.target.kind,
    status,
    error,
    input,
    settings: { ...job.settings },
    output: {
      fileName: result?.fileName ?? '',
      mimeType: result?.mimeType ?? '',
      bytes,
      bitrateKbps: result && result.mediaDuration > 0 ? (bytes * 8) / result.mediaDuration / 1000 : null,
    },
    timings: result?.timings ?? { total: wallMs },
    derived: result ? deriveMetrics(result, wallMs) : { conversionMs: wallMs, encodeMs: null, encodeFps: null, realtimeFactor: null, wallMs },
    frames: result?.frames ?? 0,
    encoder: result?.encoder ?? null,
    conversion: result?.conversion,
    mainThread,
    system,
    peakHeapMB: result?.peakHeapMB ?? null,
    memory,
    verify,
    env,
  }
  if (sessionId) await sendReport(sessionId, report)
  return { report, file }
}
