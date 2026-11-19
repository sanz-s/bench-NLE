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

/** Sample rates a codec imposes regardless of the request (the encoder resamples): Opus always runs at 48 kHz. */
const FORCED_RATE = { opus: 48000 }
/**
 * Allowed audio-track length error, in samples: the encoder's start delay (priming) plus padding to a whole codec
 * frame. Mediabunny keeps priming in the track's timeline, so an encoded track is up to this much longer.
 *   AAC: 2112 + 2048. Chrome's native (Apple) encoder writes ceil((n + 2112) / 1024) + 1 frames, i.e. up to
 *        2112 priming + 2047 padding samples (measured over a full 1024-sample sweep, 44.1 and 48 kHz; FFmpeg: less)
 *   MP3: 1105 (LAME 576 + decoder 529) + 1152
 *   Opus: 312 + 960 (at 48 kHz) · Vorbis / FLAC / AC-3 / E-AC-3 / DTS: two frames · TrueHD: tiny · PCM: 1 sample
 */
const AUDIO_SLACK = { aac: 2112 + 2048, mp3: 1105 + 1152, opus: 312 + 960, vorbis: 2 * 2048, flac: 2 * 4608, ac3: 2 * 1536, eac3: 2 * 1536, dts: 2 * 512, truehd: 2 * 40 }
/** Allowed audio duration error in seconds (codec slack + 5 ms; PCM: 1 sample + 1 ms). */
export function audioDurationTolerance(codec, rate) {
  const n = AUDIO_SLACK[codec]
  if (!n) return 1 / (rate || 48000) + 0.001
  return n / (codec === 'opus' ? 48000 : rate || 48000) + 0.005
}
/** "video/x-matroska; codecs=…" → "matroska" (subtype without x- prefix), so output-format and probed MIME compare. */
const mimeKind = (m) => ((m ?? '').split(';')[0].split('/')[1] ?? '').toLowerCase().replace(/^x-/, '')

/**
 * Re-opens the output and checks it is what the job was asked to produce:
 *  - it really decodes (head + tail by default; every frame/sample with opts.full: see decodeCheck)
 *  - the tracks the job meant to write are present (expect.tracks from the job result)
 *  - codecs, container (expect.mimeType vs the re-probed MIME), size, frame rate, audio sample rate and channels
 *  - per-track duration: video ±1 frame, audio ± the codec's priming + one frame of padding (PCM ±1 sample)
 *  - full mode: decoded frame count (±1) and decoded audio length against the expected duration
 */
export async function verifyOutput(file, job, expectedDuration, expect = {}) {
  try {
    const info = await probeFile(file)
    const full = !!expect.full
    const dec = await decodeCheck(file, { full })
    const problems = [...dec.problems]
    const s = job.settings
    const audioOnlyContainer = /^(mp3|wav|aac|flac|ogg)$/.test(s.container)
    const expectVideo = expect.tracks ? !!expect.tracks.video : !!s.videoCodec && !audioOnlyContainer
    const expectAudio = expect.tracks ? !!expect.tracks.audio : job.kind === 'convert' ? !!s.audioCodec && !!job.asset?.info?.audio : null
    // No exemption for stream-copied video: copy only happens when codec, size AND frame rate already match the
    // request (videoSame in jobs.js), so the requested values are always what the file must have.

    if (expectVideo && !info.video) problems.push('video track is missing')
    if (expectAudio && !info.audio) problems.push('audio track is missing')
    if (expectVideo && info.video && info.video.codec !== s.videoCodec) problems.push(`video codec is ${info.video.codec}, expected ${s.videoCodec}`)
    if (s.audioCodec && info.audio && info.audio.codec !== s.audioCodec) problems.push(`audio codec is ${info.audio.codec}, expected ${s.audioCodec}`)
    if (expect.mimeType && info.mimeType && mimeKind(expect.mimeType) !== mimeKind(info.mimeType)) problems.push(`container is ${info.mimeType}, expected ${expect.mimeType}`)

    if (expectVideo && info.video && (info.video.width !== s.width || info.video.height !== s.height)) problems.push(`size ${info.video.width}×${info.video.height}, expected ${s.width}×${s.height}`)
    // probe fps comes from packet statistics: allow 2 %
    if (expectVideo && info.video?.fps > 0 && s.fps > 0 && Math.abs(info.video.fps - s.fps) / s.fps > 0.02)
      problems.push(`frame rate ${info.video.fps.toFixed(3)}, expected ${s.fps}`)

    if (info.audio && s.audioCodec) {
      const wantRate = FORCED_RATE[s.audioCodec] ?? s.sampleRate
      if (wantRate && info.audio.sampleRate !== wantRate) problems.push(`audio sample rate ${info.audio.sampleRate} Hz, expected ${wantRate} Hz`)
      if (s.audioChannels && info.audio.channels !== s.audioChannels) problems.push(`audio has ${info.audio.channels} channel(s), expected ${s.audioChannels}`)
    }

    // durations per track: video to ±1 frame (output is a whole number of frames), audio to ±2 codec frames
    const vTol = s.fps > 0 ? 1 / s.fps + 0.002 : 0.05
    const aRate = info.audio?.sampleRate ?? s.sampleRate
    const aTol = audioDurationTolerance(info.audio?.codec ?? s.audioCodec, aRate)
    // expected length per track (expect.trackDurations from the job result); the overall duration otherwise
    const wantV = expect.trackDurations?.video ?? expectedDuration
    const wantA = expect.trackDurations?.audio ?? expectedDuration
    const f3 = (x) => x.toFixed(3)
    if (expectVideo && info.video?.duration != null && Math.abs(info.video.duration - wantV) > vTol)
      problems.push(`video lasts ${f3(info.video.duration)} s, expected ${f3(wantV)} s ±1 frame`)
    if (info.audio?.duration != null && (expectAudio ?? true) && Math.abs(info.audio.duration - wantA) > aTol)
      problems.push(`audio lasts ${f3(info.audio.duration)} s, expected ${f3(wantA)} s ±${(aTol * 1000).toFixed(0)} ms`)
    if (info.video?.duration == null && info.audio?.duration == null && Math.abs(info.duration - expectedDuration) > Math.max(vTol, aTol))
      problems.push(`duration ${f3(info.duration)} s vs expected ${f3(expectedDuration)} s`)
    if (full) {
      const wantFrames = Math.round(wantV * s.fps)
      if (dec.videoFrames !== null && Math.abs(dec.videoFrames - wantFrames) > 1) problems.push(`decoded ${dec.videoFrames} video frames, expected ${wantFrames} ±1`)
      if (dec.audioSeconds !== null && Math.abs(dec.audioSeconds - wantA) > aTol) problems.push(`decoded ${f3(dec.audioSeconds)} s of audio, expected ${f3(wantA)} s ±${(aTol * 1000).toFixed(0)} ms`)
    }
    return {
      ok: problems.length === 0,
      problems,
      depth: dec.depth,
      container: info.container,
      mimeType: info.mimeType,
      videoCodec: info.video?.codec ?? null,
      audioCodec: info.audio?.codec ?? null,
      duration: info.duration,
      width: info.video?.width,
      height: info.video?.height,
      fps: info.video?.fps ?? null,
      sampleRate: info.audio?.sampleRate ?? null,
      channels: info.audio?.channels ?? null,
      decodedFrames: dec.videoFrames,
      decodedAudioSeconds: dec.audioSeconds,
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

/**
 * Tab visibility during a job. A hidden tab throttles timers and rAF (and, in main-thread mode, the job itself), so
 * main-thread numbers and the progress stream of such a run are not comparable. Playwright disables backgrounding;
 * editor runs in the user's own Chrome don't.
 */
function startVisibilityWatch() {
  if (typeof document === 'undefined') return () => null
  const t0 = performance.now()
  const startedHidden = document.visibilityState === 'hidden'
  let hiddenSince = startedHidden ? t0 : null
  let hiddenMs = 0
  let changes = 0
  let blurs = 0
  const onVis = () => {
    changes++
    const t = performance.now()
    if (document.visibilityState === 'hidden') hiddenSince ??= t
    else if (hiddenSince !== null) {
      hiddenMs += t - hiddenSince
      hiddenSince = null
    }
  }
  const onBlur = () => blurs++
  document.addEventListener('visibilitychange', onVis)
  window.addEventListener('blur', onBlur)
  const focusedAtStart = document.hasFocus()
  return () => {
    document.removeEventListener('visibilitychange', onVis)
    window.removeEventListener('blur', onBlur)
    const t = performance.now()
    if (hiddenSince !== null) hiddenMs += t - hiddenSince
    return { startedHidden, endedHidden: document.visibilityState === 'hidden', hiddenMs, hiddenPct: t > t0 ? (hiddenMs / (t - t0)) * 100 : 0, changes, focusedAtStart, blurs }
  }
}

/**
 * Playwright hook: bench/run.mjs exposes `__nleBenchGate(name)` and takes its CDP snapshot inside it, so CDP
 * main-thread time covers only the job (not session setup, verification or reporting). A no-op in the editor.
 */
async function gate(name) {
  if (typeof globalThis.__nleBenchGate === 'function') {
    try {
      await globalThis.__nleBenchGate(name)
    } catch {
      /* the runner went away */
    }
  }
}

function readPref(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null /* no storage in this context */
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
  const pageMemPref = readPref('bench.pageMemory') === '1'
  const memProbe = startPageMemoryProbe(opts.pageMemory ?? pageMemPref)
  const stopVisibility = startVisibilityWatch()
  await gate('job-start')
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
  const visibility = stopVisibility()
  const mainThread = stopMain()
  stopStream()
  // The server takes its last CPU/GPU sample now and ignores later ones, so the tail (waiting for the last
  // main-thread bucket, verification, the report) never dilutes the job's averages.
  if (sessionId) await markSession(sessionId, 'job-end')
  await gate('job-end')
  // heap peak: stopped before verification, whose probe + decode would otherwise count as the job's memory
  const memory = await memProbe.stop()
  if (sessionId) await new Promise((r) => setTimeout(r, 150)) // let the final main-thread bucket arrive
  const system = sessionId ? await stopSession(sessionId) : null

  let file = null
  if (result) {
    if (result.buffer) file = new File([result.buffer], result.fileName, { type: result.mimeType })
    else if (job.target.kind === 'stream') file = await job.target.handle.getFile()
  }
  const input = inputSummary(job)
  const fullVerify = opts.fullVerify ?? readPref('bench.fullVerify') === '1'
  const verify = file && result ? await verifyOutput(file, job, result.mediaDuration, { tracks: result.tracks, trackDurations: result.trackDurations, mimeType: result.mimeType, full: fullVerify }) : null
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
    derived: result ? deriveMetrics(result, wallMs) : { conversionMs: wallMs, encodeWaitMs: null, pipelineFps: null, realtimeFactor: null, wallMs },
    frames: result?.frames ?? 0,
    encoder: result?.encoder ?? null,
    audioEncoder: result?.audioEncoder ?? null,
    conversion: result?.conversion,
    mainThread,
    system,
    peakHeapMB: result?.peakHeapMB ?? null,
    memory,
    visibility,
    verify,
    env,
  }
  if (sessionId) await sendReport(sessionId, report)
  return { report, file }
}
