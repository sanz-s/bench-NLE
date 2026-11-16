import { clipEnd } from '../media/compositor'

export const uid = (p = '') => `${p}${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`

export function newTrack(kind, name) {
  return { id: uid('t'), kind, name, muted: false, hidden: false, locked: false }
}

export function defaultProject() {
  return {
    id: uid('p'),
    name: 'Untitled project',
    width: 1920,
    height: 1080,
    fps: 30,
    sampleRate: 48000,
    background: '#000000',
    assets: [],
    tracks: [newTrack('video', 'V2'), newTrack('video', 'V1'), newTrack('audio', 'A1'), newTrack('audio', 'A2')],
    clips: [],
  }
}

export function makeClip(kind, trackId, start, duration, extra = {}) {
  return {
    id: uid('c'),
    trackId,
    kind,
    start,
    in: 0,
    duration,
    transform: { x: 0, y: 0, scale: 1, opacity: 1 },
    audio: { gain: 1, fadeIn: 0, fadeOut: 0 },
    ...extra,
  }
}

export function trackEnd(p, trackId) {
  return p.clips.filter((c) => c.trackId === trackId).reduce((m, c) => Math.max(m, clipEnd(c)), 0)
}

export function videoTracks(p) {
  return p.tracks.filter((t) => t.kind === 'video')
}
export function audioTracks(p) {
  return p.tracks.filter((t) => t.kind === 'audio')
}

/** Bottom-most video track (V1) — tracks are stored top→bottom. */
export function baseVideoTrack(p) {
  const v = videoTracks(p)
  return v[v.length - 1]
}

export function nextTrackName(p, kind) {
  const prefix = kind === 'video' ? 'V' : 'A'
  const n = p.tracks.filter((t) => t.kind === kind).length + 1
  return `${prefix}${n}`
}

/** Clips that would be created when placing an asset on the timeline (linked A/V pair for video with audio). */
export function clipsForAsset(p, asset, start, videoTrackId, audioTrackId) {
  const info = asset.info
  const dur = info.duration
  const out = []
  const linkId = info.kind === 'video' && info.audio?.canDecode ? uid('l') : undefined
  if (info.kind === 'video' || info.kind === 'image') {
    const vt = videoTrackId ?? baseVideoTrack(p)?.id
    if (vt) out.push(makeClip(info.kind, vt, start, dur, { assetId: asset.id, linkId }))
  }
  if ((info.kind === 'video' && info.audio?.canDecode) || info.kind === 'audio') {
    const at = audioTrackId ?? audioTracks(p)[0]?.id
    if (at) out.push(makeClip('audio', at, start, dur, { assetId: asset.id, linkId }))
  }
  return out
}

export function defaultEncodeSettings(p) {
  return {
    container: 'mp4',
    videoCodec: 'avc',
    audioCodec: 'aac',
    width: p.width,
    height: p.height,
    fps: p.fps,
    qualityMode: 'level',
    quality: 'high',
    videoBitrate: 8_000_000,
    audioBitrate: 192_000,
    keyFrameInterval: 2,
    hardwareAcceleration: 'no-preference',
    audioChannels: 2,
    sampleRate: 48000,
  }
}

export function formatTimecode(t, fps) {
  const sign = t < 0 ? '-' : ''
  t = Math.abs(t)
  const totalFrames = Math.round(t * fps)
  const f = totalFrames % Math.round(fps)
  const s = Math.floor(totalFrames / Math.round(fps))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(f)}`
}

/** Parses "1:23:10", "83.5", "+2s", "-10f", "00:00:05:12" relative to `current`. */
export function parseTimecode(input, fps, current) {
  const s = input.trim()
  const rel = /^([+-])\s*(\d+(?:\.\d+)?)\s*(s|f)?$/i.exec(s)
  if (rel) {
    const v = parseFloat(rel[2]) / (rel[3]?.toLowerCase() === 'f' ? fps : 1)
    return current + (rel[1] === '-' ? -v : v)
  }
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s)
  const parts = s.split(':').map((x) => parseFloat(x))
  if (parts.some((x) => Number.isNaN(x))) return null
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / fps
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / fps
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return null
}

export function formatBytes(b) {
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`
  return `${(b / 1073741824).toFixed(2)} GB`
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(2)}s`
}
