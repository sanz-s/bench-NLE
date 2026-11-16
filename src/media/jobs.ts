import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  Conversion,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  QUALITY_VERY_LOW,
  StreamTarget,
  type AudioCodec,
  type ConversionAudioOptions,
  type ConversionVideoOptions,
  type EncodedPacket,
  type InputAudioTrack,
  type InputVideoTrack,
  type Quality,
  type QualityLevel,
  type StreamTargetChunk,
  type Target,
  type VideoCodec,
  type Input,
} from 'mediabunny'
import { registerAllExtensions } from './extensions'
import { containerDef, makeOutputFormat } from './formats'
import { openInput } from './probe'
import { VideoReader, containSize } from './videoReader'
import { ClipAudioReader, makeGainFn, packPlanar } from './audioMix'
import { audibleClips, clipEnd, drawFrame, frameRequests, type FrameImage } from './compositor'
import type {
  Asset,
  Clip,
  ConvertJob,
  EncodeSettings,
  EncoderStats,
  ExportJob,
  FixtureJob,
  JobProgress,
  JobResult,
  JobTarget,
  MediaJob,
  Project,
  StageTimings,
} from './types'

export interface JobHooks {
  onProgress?: (p: JobProgress) => void
  signal?: AbortSignal
}

export class JobCanceledError extends Error {
  constructor() {
    super('Job canceled')
  }
}

const now = () => performance.now()
const isWorker = typeof (globalThis as { document?: unknown }).document === 'undefined'

const QUALITY: Record<QualityLevel, Quality> = {
  'very-low': QUALITY_VERY_LOW,
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  'very-high': QUALITY_VERY_HIGH,
}

function heapMB(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return m ? m.usedJSHeapSize / 1048576 : null
}

class HeapTracker {
  peak: number | null = heapMB()
  sample() {
    const h = heapMB()
    if (h !== null) this.peak = Math.max(this.peak ?? 0, h)
  }
}

export function runJob(job: MediaJob, hooks: JobHooks = {}): Promise<JobResult> {
  registerAllExtensions()
  switch (job.kind) {
    case 'export':
      return runExport(job, hooks)
    case 'convert':
      return job.engine === 'conversion' ? runConversion(job, hooks) : runPipelineConvert(job, hooks)
    case 'fixture':
      return runFixture(job)
  }
}

// ------------------------------------------------------------------ targets

interface TargetHandle {
  target: Target
  kind: 'buffer' | 'stream'
  bytes(): number
  finish(): Promise<ArrayBuffer | undefined>
}

async function makeTarget(t: JobTarget): Promise<TargetHandle> {
  if (t.kind === 'buffer') {
    const target = new BufferTarget()
    return {
      target,
      kind: 'buffer',
      bytes: () => target.buffer?.byteLength ?? 0,
      finish: async () => target.buffer ?? undefined,
    }
  }
  const file = await t.handle.createWritable()
  let size = 0
  let closed = false
  const ws = new WritableStream<StreamTargetChunk>({
    write: async (chunk) => {
      size = Math.max(size, chunk.position + chunk.data.byteLength)
      await file.write({ type: 'write', position: chunk.position, data: chunk.data })
    },
    close: async () => {
      closed = true
      await file.close()
    },
    abort: async (reason) => {
      closed = true
      await file.abort(reason)
    },
  })
  return {
    target: new StreamTarget(ws, { chunked: true }),
    kind: 'stream',
    bytes: () => size,
    finish: async () => {
      if (!closed) {
        try {
          await ws.close()
        } catch {
          try {
            await file.close()
          } catch {
            /* already closed */
          }
        }
      }
      return undefined
    },
  }
}

function fileNameFor(base: string, s: EncodeSettings): string {
  const clean = base.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'export'
  return `${clean}${containerDef(s.container).ext}`
}

function videoBitrate(s: EncodeSettings): number | Quality {
  return s.qualityMode === 'bitrate' ? s.videoBitrate : QUALITY[s.quality]
}
function audioBitrate(s: EncodeSettings): number | Quality {
  return s.qualityMode === 'bitrate' ? s.audioBitrate : QUALITY[s.quality]
}

// ------------------------------------------------------------------ encoder instrumentation

class EncoderProbe {
  private submit = new Map<number, number>()
  private latencies: number[] = []
  private firstSubmit: number | null = null
  private lastPacket: number | null = null
  stats: EncoderStats = {
    videoFramesSubmitted: 0,
    videoPacketsOut: 0,
    audioPacketsOut: 0,
    keyFrames: 0,
    latencyAvg: null,
    latencyP95: null,
    latencyMax: null,
    encoderSpan: null,
  }

  markSubmit(ts: number) {
    const t = now()
    if (this.firstSubmit === null) this.firstSubmit = t
    this.submit.set(Math.round(ts * 1e6), t)
    this.stats.videoFramesSubmitted++
  }

  onVideoPacket = (packet: EncodedPacket) => {
    const t = now()
    this.lastPacket = t
    this.stats.videoPacketsOut++
    if (packet.type === 'key') this.stats.keyFrames++
    const key = Math.round(packet.timestamp * 1e6)
    const s = this.submit.get(key)
    if (s !== undefined) {
      this.latencies.push(t - s)
      this.submit.delete(key)
    }
  }

  onAudioPacket = () => {
    this.lastPacket = now()
    this.stats.audioPacketsOut++
  }

  onVideoConfig = (c: VideoEncoderConfig) => {
    this.stats.videoEncoderConfig = {
      codec: c.codec,
      hardwareAcceleration: c.hardwareAcceleration,
      width: c.width,
      height: c.height,
      bitrate: c.bitrate,
    }
  }

  onAudioConfig = (c: AudioEncoderConfig) => {
    this.stats.audioEncoderConfig = { codec: c.codec, sampleRate: c.sampleRate, numberOfChannels: c.numberOfChannels, bitrate: c.bitrate }
  }

  finish(): EncoderStats {
    const l = [...this.latencies].sort((a, b) => a - b)
    if (l.length) {
      this.stats.latencyAvg = l.reduce((a, b) => a + b, 0) / l.length
      this.stats.latencyP95 = l[Math.min(l.length - 1, Math.floor(l.length * 0.95))]
      this.stats.latencyMax = l[l.length - 1]
    }
    if (this.firstSubmit !== null && this.lastPacket !== null) this.stats.encoderSpan = this.lastPacket - this.firstSubmit
    return this.stats
  }
}

// ------------------------------------------------------------------ timeline export

interface AssetMedia {
  input: Input
  video: InputVideoTrack | null
  audio: InputAudioTrack | null
}

class AssetPool {
  private map = new Map<string, Promise<AssetMedia>>()
  private bitmaps = new Map<string, Promise<ImageBitmap>>()
  private assets: Map<string, Asset>
  constructor(assets: Asset[]) {
    this.assets = new Map(assets.map((a) => [a.id, a]))
  }
  get(id: string): Promise<AssetMedia> {
    let p = this.map.get(id)
    if (!p) {
      const asset = this.assets.get(id)
      if (!asset) throw new Error(`Missing asset ${id}`)
      p = (async () => {
        const input = openInput(asset.file)
        const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
        return { input, video, audio }
      })()
      this.map.set(id, p)
    }
    return p
  }
  bitmap(id: string): Promise<ImageBitmap> {
    let p = this.bitmaps.get(id)
    if (!p) {
      p = createImageBitmap(this.assets.get(id)!.file)
      this.bitmaps.set(id, p)
    }
    return p
  }
  async dispose() {
    for (const p of this.map.values()) (await p).input.dispose()
    for (const p of this.bitmaps.values()) (await p).close()
  }
}

async function runExport(job: ExportJob, hooks: JobHooks): Promise<JobResult> {
  return exportProject(job.project, job.settings, job.range, job.target, job.project.name, hooks)
}

async function exportProject(
  project: Project,
  s: EncodeSettings,
  range: { start: number; end: number },
  jobTarget: JobTarget,
  baseName: string,
  hooks: JobHooks,
): Promise<JobResult> {
  const t0 = now()
  const timings: StageTimings = { setup: 0, decodeWait: 0, composite: 0, videoEncodeWait: 0, audioDecodeMix: 0, audioEncodeWait: 0, finalize: 0, total: 0 }
  const heap = new HeapTracker()
  const probe = new EncoderProbe()
  const duration = Math.max(0, range.end - range.start)
  if (duration <= 0) throw new Error('Nothing to export: the range is empty.')

  const handle = await makeTarget(jobTarget)
  const format = makeOutputFormat(s.container, handle.kind)
  const output = new Output({ format, target: handle.target })
  const pool = new AssetPool(project.assets)

  const wantVideo = !!s.videoCodec && format.getSupportedVideoCodecs().length > 0
  const audioClips = audibleClips(project).filter((c) => c.start < range.end && clipEnd(c) > range.start)
  const wantAudio = !!s.audioCodec && audioClips.length > 0
  if (!wantVideo && !wantAudio) throw new Error('Nothing to encode: no video codec selected and the range has no audible audio.')

  const W = s.width
  const H = s.height
  let canvas: OffscreenCanvas | null = null
  let ctx: OffscreenCanvasRenderingContext2D | null = null
  let videoSource: CanvasSource | null = null
  if (wantVideo) {
    canvas = new OffscreenCanvas(W, H)
    ctx = canvas.getContext('2d', { alpha: false })!
    videoSource = new CanvasSource(canvas, {
      codec: s.videoCodec as VideoCodec,
      bitrate: videoBitrate(s),
      keyFrameInterval: s.keyFrameInterval,
      hardwareAcceleration: s.hardwareAcceleration,
      latencyMode: 'quality',
      onEncodedPacket: probe.onVideoPacket,
      onEncoderConfig: probe.onVideoConfig,
    })
    output.addVideoTrack(videoSource, { frameRate: s.fps })
  }
  let audioSource: AudioSampleSource | null = null
  if (wantAudio) {
    audioSource = new AudioSampleSource({
      codec: s.audioCodec as AudioCodec,
      bitrate: audioBitrate(s),
      onEncodedPacket: probe.onAudioPacket,
      onEncoderConfig: probe.onAudioConfig,
    })
    output.addAudioTrack(audioSource)
  }

  const abortIfNeeded = async () => {
    if (hooks.signal?.aborted) {
      await output.cancel().catch(() => {})
      await pool.dispose().catch(() => {})
      throw new JobCanceledError()
    }
  }

  await output.start()
  timings.setup = now() - t0

  // Audio readers, created lazily.
  const rate = s.sampleRate
  const channels = s.audioChannels
  const audioReaders = new Map<string, ClipAudioReader>()
  const gainFn = makeGainFn(project)
  let audioTime = 0 // relative to range.start
  const AUDIO_CHUNK = Math.round(rate * 0.1)

  const pushAudioUntil = async (until: number) => {
    if (!audioSource) return
    while (audioTime < until && audioTime < duration - 1e-9) {
      const frames = Math.min(AUDIO_CHUNK, Math.round((duration - audioTime) * rate))
      if (frames <= 0) break
      const tm = now()
      const planes = Array.from({ length: channels }, () => new Float32Array(frames))
      const absT = range.start + audioTime
      const absEnd = absT + frames / rate
      for (const c of audioClips) {
        if (clipEnd(c) <= absT || c.start >= absEnd) continue
        let r = audioReaders.get(c.id)
        if (!r) {
          const m = await pool.get(c.assetId!)
          if (!m.audio || !(await m.audio.canDecode())) continue
          r = new ClipAudioReader(m.audio, c, rate, channels, gainFn)
          audioReaders.set(c.id, r)
        }
        await r.mixInto(planes, absT, frames)
      }
      for (const [id, r] of audioReaders) {
        if (clipEnd(r.clip) < absT) {
          await r.dispose()
          audioReaders.delete(id)
        }
      }
      const sample = new AudioSample({ data: packPlanar(planes), format: 'f32-planar', numberOfChannels: channels, sampleRate: rate, timestamp: audioTime })
      timings.audioDecodeMix! += now() - tm
      const te = now()
      await audioSource.add(sample)
      timings.audioEncodeWait! += now() - te
      sample.close()
      audioTime += frames / rate
    }
  }

  // Video readers, keyed by clip id.
  const videoReaders = new Map<string, VideoReader>()
  const frameCount = wantVideo ? Math.max(1, Math.round(duration * s.fps)) : 0
  const projScale = Math.min(W / project.width, H / project.height)
  const offX = (W - project.width * projScale) / 2
  const offY = (H - project.height * projScale) / 2
  let lastProgress = 0

  const report = (processed: number) => {
    const t = now()
    if (t - lastProgress > 100) {
      lastProgress = t
      heap.sample()
      hooks.onProgress?.({ progress: Math.min(1, processed / duration), processedTime: processed })
    }
  }

  for (let i = 0; i < frameCount; i++) {
    await abortIfNeeded()
    const rel = i / s.fps
    const abs = range.start + rel
    const requests = frameRequests(project, abs)
    const frames = new Map<string, FrameImage | null>()

    const td = now()
    await Promise.all(
      requests.map(async ({ clip: c, src }) => {
        if (c.kind === 'image') {
          const bmp = await pool.bitmap(c.assetId!)
          frames.set(c.id, { image: bmp, width: bmp.width, height: bmp.height })
          return
        }
        let r = videoReaders.get(c.id)
        if (!r) {
          const m = await pool.get(c.assetId!)
          if (!m.video) return
          const [dw, dh] = await Promise.all([m.video.getDisplayWidth(), m.video.getDisplayHeight()])
          const size = containSize(dw, dh, W, H)
          r = new VideoReader(m.video, size.w, size.h, 3)
          videoReaders.set(c.id, r)
        }
        const f = await r.frameAt(src)
        if (f) frames.set(c.id, { image: f.canvas, width: f.canvas.width, height: f.canvas.height })
      }),
    )
    timings.decodeWait! += now() - td

    const tc = now()
    if (offX > 0.5 || offY > 0.5) {
      ctx!.fillStyle = '#000'
      ctx!.fillRect(0, 0, W, H)
    }
    ctx!.save()
    ctx!.translate(offX, offY)
    drawFrame(ctx!, project, abs, frames, projScale)
    ctx!.restore()
    timings.composite! += now() - tc

    const te = now()
    probe.markSubmit(rel)
    await videoSource!.add(rel, 1 / s.fps)
    timings.videoEncodeWait! += now() - te

    // Free readers for clips that are well past their end (transitions can read a little beyond it).
    for (const [id, r] of videoReaders) {
      const c = project.clips.find((x) => x.id === id)
      if (!c || clipEnd(c) + 3 <= abs) {
        await r.dispose()
        videoReaders.delete(id)
      }
    }

    await pushAudioUntil(rel + 1 / s.fps + 0.1)
    report(rel)
  }

  // Audio-only exports (or remaining audio tail).
  while (audioSource && audioTime < duration - 1e-9) {
    await abortIfNeeded()
    await pushAudioUntil(audioTime + 1)
    report(audioTime)
  }

  for (const r of videoReaders.values()) await r.dispose()
  for (const r of audioReaders.values()) await r.dispose()

  const tf = now()
  await output.finalize()
  timings.finalize = now() - tf
  const buffer = await handle.finish()
  await pool.dispose()
  heap.sample()
  timings.total = now() - t0
  hooks.onProgress?.({ progress: 1, processedTime: duration })

  return {
    timings,
    encoder: probe.finish(),
    frames: frameCount,
    mediaDuration: duration,
    outputBytes: buffer?.byteLength ?? handle.bytes(),
    buffer,
    mimeType: format.mimeType,
    fileName: fileNameFor(baseName, s),
    peakHeapMB: heap.peak,
    context: isWorker ? 'worker' : 'main',
  }
}

// ------------------------------------------------------------------ single-file conversion (Mediabunny Conversion API)

async function runConversion(job: ConvertJob, hooks: JobHooks): Promise<JobResult> {
  const t0 = now()
  const s = job.settings
  const heap = new HeapTracker()
  const handle = await makeTarget(job.target)
  const format = makeOutputFormat(s.container, handle.kind)
  const input = openInput(job.asset.file)
  const output = new Output({ format, target: handle.target })
  const src = job.asset.info
  const wantVideo = !!s.videoCodec && format.getSupportedVideoCodecs().length > 0 && !!src.video
  const wantAudio = !!s.audioCodec && !!src.audio

  const videoSame =
    wantVideo &&
    job.allowCopy &&
    src.video!.codec === s.videoCodec &&
    src.video!.width === s.width &&
    src.video!.height === s.height &&
    Math.abs(src.video!.fps - s.fps) < 0.01
  const audioSame = wantAudio && job.allowCopy && src.audio!.codec === s.audioCodec

  const video: ConversionVideoOptions = !wantVideo
    ? { discard: true }
    : videoSame
      ? { codec: s.videoCodec! }
      : {
          codec: s.videoCodec!,
          width: s.width,
          height: s.height,
          fit: 'contain',
          frameRate: s.fps,
          bitrate: videoBitrate(s),
          keyFrameInterval: s.keyFrameInterval,
          hardwareAcceleration: s.hardwareAcceleration,
          forceTranscode: true,
        }
  const audio: ConversionAudioOptions = !wantAudio
    ? { discard: true }
    : audioSame
      ? { codec: s.audioCodec! }
      : {
          codec: s.audioCodec!,
          numberOfChannels: s.audioChannels,
          sampleRate: s.sampleRate,
          bitrate: audioBitrate(s),
          forceTranscode: true,
        }

  const trimEnd = Math.min(job.trim.end, src.duration)
  const conversion = await Conversion.init({
    input,
    output,
    video,
    audio,
    trim: { start: job.trim.start, end: trimEnd },
    showWarnings: false,
  })
  const discarded = conversion.discardedTracks.map((d) => ({
    type: d.track.type,
    codec: d.track.codec,
    reason: d.reason,
  }))
  if (!conversion.isValid) {
    input.dispose()
    throw new Error(`Conversion is not possible: ${discarded.map((d) => `${d.type} ${d.codec ?? '?'} → ${d.reason}`).join('; ') || 'unknown reason'}`)
  }
  const setup = now() - t0
  let firstProgress: number | undefined
  let lastP = 0
  conversion.onProgress = (progress, processedTime) => {
    const t = now()
    if (firstProgress === undefined && progress > 0) firstProgress = t - t0
    if (t - lastP > 100) {
      lastP = t
      heap.sample()
      hooks.onProgress?.({ progress, processedTime })
    }
  }
  const onAbort = () => {
    void conversion.cancel()
  }
  hooks.signal?.addEventListener('abort', onAbort)
  try {
    await conversion.execute()
  } catch (err) {
    if (hooks.signal?.aborted) throw new JobCanceledError()
    throw err
  } finally {
    hooks.signal?.removeEventListener('abort', onAbort)
  }
  const buffer = await handle.finish()
  input.dispose()
  heap.sample()
  const mediaDuration = trimEnd - job.trim.start
  const total = now() - t0
  hooks.onProgress?.({ progress: 1, processedTime: mediaDuration })
  return {
    timings: { setup, timeToFirstProgress: firstProgress, total },
    encoder: null,
    frames: wantVideo ? Math.round(mediaDuration * (videoSame ? src.video!.fps : s.fps)) : 0,
    mediaDuration,
    outputBytes: buffer?.byteLength ?? handle.bytes(),
    buffer,
    mimeType: format.mimeType,
    fileName: fileNameFor(job.asset.name, s),
    conversion: {
      discarded,
      utilizedTracks: conversion.utilizedTracks.length,
      copyExpected: { video: wantVideo ? videoSame : null, audio: wantAudio ? audioSame : null },
    },
    peakHeapMB: heap.peak,
    context: isWorker ? 'worker' : 'main',
  }
}

// ------------------------------------------------------------------ single-file conversion via the manual pipeline

function singleClipProject(asset: Asset, s: EncodeSettings, trim: { start: number; end: number }): Project {
  const dur = Math.max(0, Math.min(trim.end, asset.info.duration) - trim.start)
  const base = {
    start: 0,
    in: trim.start,
    duration: dur,
    assetId: asset.id,
    transform: { x: 0, y: 0, scale: 1, opacity: 1 },
    audio: { gain: 1, fadeIn: 0, fadeOut: 0 },
  }
  const clips: Clip[] = []
  if (asset.info.video?.canDecode || asset.info.kind === 'image') clips.push({ ...base, id: 'v', trackId: 'V1', kind: asset.info.kind === 'image' ? 'image' : 'video' })
  if (asset.info.audio?.canDecode) clips.push({ ...base, id: 'a', trackId: 'A1', kind: 'audio' })
  return {
    id: 'convert',
    name: asset.name,
    width: s.width,
    height: s.height,
    fps: s.fps,
    sampleRate: s.sampleRate,
    background: '#000000',
    assets: [asset],
    tracks: [
      { id: 'V1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
      { id: 'A1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false },
    ],
    clips,
  }
}

async function runPipelineConvert(job: ConvertJob, hooks: JobHooks): Promise<JobResult> {
  const project = singleClipProject(job.asset, job.settings, job.trim)
  const dur = project.clips[0]?.duration ?? 0
  return exportProject(project, job.settings, { start: 0, end: dur }, job.target, job.asset.name, hooks)
}

// ------------------------------------------------------------------ synthetic fixtures (test media generated with Mediabunny)

async function runFixture(job: FixtureJob): Promise<JobResult> {
  const t0 = now()
  const sp = job.spec
  const target = new BufferTarget()
  const format = makeOutputFormat(sp.container, 'buffer')
  const output = new Output({ format, target })
  const canvas = new OffscreenCanvas(sp.width, sp.height)
  const ctx = canvas.getContext('2d', { alpha: false })!
  let vs: CanvasSource | null = null
  let as: AudioSampleSource | null = null
  if (sp.videoCodec) {
    vs = new CanvasSource(canvas, { codec: sp.videoCodec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 })
    output.addVideoTrack(vs, { frameRate: sp.fps })
  }
  if (sp.audioCodec) {
    as = new AudioSampleSource({ codec: sp.audioCodec, bitrate: QUALITY_HIGH })
    output.addAudioTrack(as)
  }
  await output.start()
  const rate = 48000
  const frames = sp.videoCodec ? Math.round(sp.duration * sp.fps) : 0
  let audioT = 0
  const pushAudio = async (until: number) => {
    if (!as) return
    while (audioT < until && audioT < sp.duration) {
      const n = Math.min(Math.round(rate * 0.1), Math.round((sp.duration - audioT) * rate))
      if (n <= 0) break
      const data = new Float32Array(n * 2)
      for (let i = 0; i < n; i++) {
        const t = audioT + i / rate
        const sec = t % 1
        const click = sec < 0.03 ? Math.sin(2 * Math.PI * 1760 * t) * 0.5 : 0
        const tone = Math.sin(2 * Math.PI * (220 + 220 * (t / sp.duration)) * t) * 0.25
        data[i] = tone + click
        data[n + i] = tone * 0.8 + click
      }
      const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: rate, timestamp: audioT })
      await as.add(sample)
      sample.close()
      audioT += n / rate
    }
  }
  for (let i = 0; i < frames; i++) {
    const t = i / sp.fps
    drawFixtureFrame(ctx, sp.width, sp.height, t, i, sp.duration)
    await vs!.add(t, 1 / sp.fps)
    await pushAudio(t + 0.2)
  }
  await pushAudio(sp.duration)
  await output.finalize()
  const buffer = target.buffer!
  const name = sp.name ?? `test_${sp.width}x${sp.height}_${sp.fps}fps_${sp.duration}s_${sp.videoCodec ?? 'novideo'}_${sp.audioCodec ?? 'noaudio'}`
  return {
    timings: { total: now() - t0 },
    encoder: null,
    frames,
    mediaDuration: sp.duration,
    outputBytes: buffer.byteLength,
    buffer,
    mimeType: format.mimeType,
    fileName: `${name}${containerDef(sp.container).ext}`,
    peakHeapMB: null,
    context: isWorker ? 'worker' : 'main',
  }
}

function drawFixtureFrame(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, t: number, frame: number, dur: number) {
  const hue = (t / dur) * 300
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, `hsl(${hue}, 70%, 35%)`)
  g.addColorStop(1, `hsl(${(hue + 60) % 360}, 70%, 15%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  // moving detail so the encoder has real work to do
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = Math.max(1, w / 960)
  const step = w / 16
  const shift = (t * step) % step
  for (let x = -step + shift; x < w; x += step) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  for (let i = 0; i < 6; i++) {
    const a = t * (0.6 + i * 0.2) + i
    const r = h * (0.05 + 0.02 * i)
    ctx.fillStyle = `hsla(${(hue + i * 50) % 360}, 90%, 60%, 0.85)`
    ctx.beginPath()
    ctx.arc(w / 2 + Math.cos(a) * w * 0.3, h / 2 + Math.sin(a * 1.3) * h * 0.3, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#fff'
  ctx.font = `700 ${Math.round(h / 8)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${t.toFixed(2)}s`, w / 2, h / 2)
  ctx.font = `500 ${Math.round(h / 24)}px ui-monospace, monospace`
  ctx.fillText(`frame ${frame}`, w / 2, h / 2 + h / 9)
}
