/**
 * Derived numbers. Names say what they measure:
 *  - encodeWaitMs: time the pipeline WAITED on the encoders (awaiting source.add() = queue back-pressure, plus the
 *    finalize flush). It is not encoder busy time: a decode-bound job shows ~0 while the encoder works. For encoder
 *    work use encoder.encoderSpan and encoder.latency*. null for Conversion jobs (pipelined inside Mediabunny).
 *  - pipelineFps: output frames / total job time (end-to-end throughput, not encoder fps). Conversion frame counts
 *    are estimated from duration × fps.
 */
export function deriveMetrics(r, wallMs) {
  const t = r.timings
  const encodeWaitMs =
    t.videoEncodeWait !== undefined || t.audioEncodeWait !== undefined ? (t.videoEncodeWait ?? 0) + (t.audioEncodeWait ?? 0) + (t.finalize ?? 0) : null
  const pipelineFps = r.frames > 0 && t.total > 0 ? r.frames / (t.total / 1000) : null
  return {
    conversionMs: t.total,
    encodeWaitMs,
    pipelineFps,
    realtimeFactor: t.total > 0 ? r.mediaDuration / (t.total / 1000) : null,
    wallMs,
  }
}

/** Flat key → value row for CSV / tables. */
export function flattenReport(r) {
  const row = {
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
    hwPreference: r.settings.hardwareAcceleration, // what was REQUESTED; the browser doesn't say which path ran
    encoderCodec: r.encoder?.videoEncoderConfig?.codec ?? null,
    audioEncoderImpl: r.audioEncoder?.impl ?? null,
    aacRequested: r.audioEncoder?.requested ?? null,
    copyVideo: r.conversion?.copyExpected.video ?? null,
    copyAudio: r.conversion?.copyExpected.audio ?? null,
    frames: r.frames,
    conversionMs: round(r.derived.conversionMs),
    encodeWaitMs: round(r.derived.encodeWaitMs ?? r.derived.encodeMs),
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
    pipelineFps: round(r.derived.pipelineFps ?? r.derived.encodeFps, 1),
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
    // the benchmark browser's own GPU share (Windows per-PID counters, Linux DRM fdinfo; macOS doesn't expose it)
    gpuBrowserAvg: round(r.system?.gpuBrowserPct?.avg, 1),
    gpuPowerAvgW: round(r.system?.gpuPowerW?.avg, 2),
    cpuPowerAvgW: round(r.system?.cpuPowerW?.avg, 2),
    browserRssMaxMB: round(r.system?.browserRssMB?.max),
    tabHiddenMs: round(r.visibility?.hiddenMs),
    sysWindowMs: round(r.system?.sampledMs),
    overlappingJobs: r.system?.overlap?.sessions?.length ?? null,
    verified: r.verify?.ok ?? null,
    verifyProblems: r.verify?.problems.join(' | ') ?? null,
    verifyDecoder: r.verify?.videoDecoder ?? null,
    error: r.error ?? null,
  }
  if (r.cdp) for (const [k, v] of Object.entries(r.cdp)) row[`cdp_${k}`] = typeof v === 'number' ? round(v, 1) : v
  return row
}

function round(v, d = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return null
  const f = 10 ** d
  return Math.round(v * f) / f
}

export function toCSV(reports) {
  const rows = reports.map(flattenReport)
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const esc = (v) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
}

export async function envInfo() {
  let gpu = null
  try {
    const nav = navigator
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
    deviceMemoryGB: navigator.deviceMemory ?? null,
    gpu,
  }
}
