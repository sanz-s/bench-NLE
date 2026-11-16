import type { EncodeSettings, EncoderStats, JobResult, StageTimings } from '../media/types'
import type { MainThreadStats } from './mainThread'
import type { SystemSummary } from './serverClient'

export interface VerifyResult {
  ok: boolean
  problems: string[]
  container?: string
  videoCodec?: string | null
  audioCodec?: string | null
  duration?: number
  width?: number
  height?: number
}

export interface EnvInfo {
  userAgent: string
  cores: number
  crossOriginIsolated: boolean
  deviceMemoryGB: number | null
  gpu: string | null
}

export interface JobReport {
  id: string
  label: string
  createdAt: string
  kind: 'export' | 'convert'
  engine: 'timeline' | 'conversion' | 'pipeline'
  runIn: 'worker' | 'main'
  target: 'buffer' | 'stream'
  status: 'done' | 'error' | 'canceled'
  error?: string
  input: {
    name: string
    container: string | null
    videoCodec: string | null
    audioCodec: string | null
    width: number | null
    height: number | null
    fps: number | null
    duration: number
    bytes: number | null
    clips?: number
  }
  settings: EncodeSettings
  output: { fileName: string; mimeType: string; bytes: number; bitrateKbps: number | null }
  timings: StageTimings
  derived: {
    /** Total conversion time (ms): job start → file finalized. Worker spawn excluded. */
    conversionMs: number
    /** Encode time (ms): awaiting encoder submissions + finalize flush. Null for the Conversion engine. */
    encodeMs: number | null
    encodeFps: number | null
    realtimeFactor: number | null
    wallMs: number
  }
  frames: number
  encoder: EncoderStats | null
  conversion?: JobResult['conversion']
  mainThread: MainThreadStats | null
  system: SystemSummary | null
  peakHeapMB: number | null
  verify: VerifyResult | null
  env: EnvInfo
  /** Filled in by the Playwright runner. */
  cdp?: Record<string, number>
}

export function deriveMetrics(r: JobResult, wallMs: number): JobReport['derived'] {
  const t = r.timings
  const encodeMs =
    t.videoEncodeWait !== undefined || t.audioEncodeWait !== undefined
      ? (t.videoEncodeWait ?? 0) + (t.audioEncodeWait ?? 0) + (t.finalize ?? 0)
      : null
  return {
    conversionMs: t.total,
    encodeMs,
    encodeFps: r.frames > 0 && t.total > 0 ? r.frames / (t.total / 1000) : null,
    realtimeFactor: t.total > 0 ? r.mediaDuration / (t.total / 1000) : null,
    wallMs,
  }
}

/** Flat key → value row for CSV / tables. */
export function flattenReport(r: JobReport): Record<string, string | number | boolean | null> {
  const row: Record<string, string | number | boolean | null> = {
    id: r.id,
    label: r.label,
    createdAt: r.createdAt,
    status: r.status,
    kind: r.kind,
    engine: r.engine,
    runIn: r.runIn,
    target: r.target,
    input: r.input.name,
    inContainer: r.input.container,
    inVideo: r.input.videoCodec,
    inAudio: r.input.audioCodec,
    inRes: r.input.width ? `${r.input.width}x${r.input.height}` : null,
    mediaSec: round(r.input.duration, 3),
    outContainer: r.settings.container,
    outVideo: r.settings.videoCodec,
    outAudio: r.settings.audioCodec,
    outRes: `${r.settings.width}x${r.settings.height}`,
    outFps: r.settings.fps,
    quality: r.settings.qualityMode === 'level' ? r.settings.quality : `${Math.round(r.settings.videoBitrate / 1000)}k`,
    hwAccel: r.settings.hardwareAcceleration,
    encoderCodec: r.encoder?.videoEncoderConfig?.codec ?? null,
    encoderHw: r.encoder?.videoEncoderConfig?.hardwareAcceleration ?? null,
    copyVideo: r.conversion?.copyExpected.video ?? null,
    copyAudio: r.conversion?.copyExpected.audio ?? null,
    frames: r.frames,
    conversionMs: round(r.derived.conversionMs),
    encodeMs: round(r.derived.encodeMs),
    wallMs: round(r.derived.wallMs),
    workerSpawnMs: round(r.timings.workerSpawn),
    setupMs: round(r.timings.setup),
    decodeWaitMs: round(r.timings.decodeWait),
    compositeMs: round(r.timings.composite),
    videoEncodeWaitMs: round(r.timings.videoEncodeWait),
    audioDecodeMixMs: round(r.timings.audioDecodeMix),
    audioEncodeWaitMs: round(r.timings.audioEncodeWait),
    finalizeMs: round(r.timings.finalize),
    firstProgressMs: round(r.timings.timeToFirstProgress),
    encodeFps: round(r.derived.encodeFps, 1),
    realtimeX: round(r.derived.realtimeFactor, 2),
    encLatencyAvgMs: round(r.encoder?.latencyAvg),
    encLatencyP95Ms: round(r.encoder?.latencyP95),
    encoderSpanMs: round(r.encoder?.encoderSpan),
    outBytes: r.output.bytes,
    outKbps: round(r.output.bitrateKbps),
    peakHeapMB: round(r.peakHeapMB, 1),
    mtLongTasks: r.mainThread?.longTasks ?? null,
    mtLongestMs: round(r.mainThread?.longestTaskMs),
    mtTbtMs: round(r.mainThread?.tbtMs),
    mtBlockedPct: round(r.mainThread?.blockedPct, 1),
    mtLoafBlockingMs: round(r.mainThread?.loafBlockingMs),
    mtRafGaps50: r.mainThread?.rafGapsOver50ms ?? null,
    mtRafP95Ms: round(r.mainThread?.rafP95Ms, 1),
    sysCpuAvg: round(r.system?.cpuSystemPct?.avg, 1),
    sysCpuMax: round(r.system?.cpuSystemPct?.max, 1),
    browserCpuAvg: round(r.system?.browserCpuPct?.avg, 1),
    browserCpuMax: round(r.system?.browserCpuPct?.max, 1),
    gpuProcCpuAvg: round(r.system?.browserCpuByType?.['gpu-process']?.avg, 1),
    rendererCpuAvg: round(r.system?.browserCpuByType?.renderer?.avg, 1),
    gpuAvg: round(r.system?.gpuDevicePct?.avg, 1),
    gpuMax: round(r.system?.gpuDevicePct?.max, 1),
    gpuPowerAvgW: round(r.system?.gpuPowerW?.avg, 2),
    cpuPowerAvgW: round(r.system?.cpuPowerW?.avg, 2),
    browserRssMaxMB: round(r.system?.browserRssMB?.max),
    verified: r.verify?.ok ?? null,
    verifyProblems: r.verify?.problems.join(' | ') ?? null,
    error: r.error ?? null,
  }
  if (r.cdp) for (const [k, v] of Object.entries(r.cdp)) row[`cdp_${k}`] = round(v, 1)
  return row
}

function round(v: number | null | undefined, d = 0): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null
  const f = 10 ** d
  return Math.round(v * f) / f
}

export function toCSV(reports: JobReport[]): string {
  const rows = reports.map(flattenReport)
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
}

export async function envInfo(): Promise<EnvInfo> {
  let gpu: string | null = null
  try {
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }
    const adapter = await nav.gpu?.requestAdapter()
    const info = adapter?.info
    if (info) gpu = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || null
  } catch {
    /* ignore */
  }
  return {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    crossOriginIsolated: globalThis.crossOriginIsolated ?? false,
    deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    gpu,
  }
}
