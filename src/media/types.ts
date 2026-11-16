import type { AudioCodec, VideoCodec, QualityLevel } from 'mediabunny'
import type { ContainerId } from './formats'

// ---------------------------------------------------------------- media info

export interface VideoStreamInfo {
  codec: VideoCodec | null
  codecString: string | null
  width: number
  height: number
  rotation: number
  fps: number
  frameRateConstant: boolean
  bitrate: number | null
  canDecode: boolean
  hdr: boolean
}

export interface AudioStreamInfo {
  codec: AudioCodec | null
  codecString: string | null
  channels: number
  sampleRate: number
  bitrate: number | null
  canDecode: boolean
}

export interface MediaInfo {
  kind: 'video' | 'audio' | 'image'
  container: string
  mimeType: string
  size: number
  duration: number
  video: VideoStreamInfo | null
  audio: AudioStreamInfo | null
  /** Extra tracks beyond the primary ones. */
  videoTrackCount: number
  audioTrackCount: number
  /** Image only */
  imageWidth?: number
  imageHeight?: number
  /** Non-fatal problems (e.g. undecodable audio track). */
  warnings: string[]
}

// ---------------------------------------------------------------- project model

export interface Asset {
  id: string
  name: string
  file: File
  info: MediaInfo
  /** Small JPEG data URL. */
  thumb?: string
}

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  hidden: boolean
  locked: boolean
}

/** 'sticker' = built-in vector/emoji graphic; 'adjustment' = applies its filter to everything below it. */
export type ClipKind = 'video' | 'audio' | 'image' | 'text' | 'sticker' | 'adjustment'

export interface ClipTransform {
  x: number // px offset from center, in project pixels
  y: number
  scale: number // 1 = fit (contain) into frame
  opacity: number // 0..1
}

export interface ClipAudio {
  gain: number // linear, 1 = 0 dB
  fadeIn: number // seconds
  fadeOut: number
}

export type TextAlign = 'left' | 'center' | 'right'

export interface ClipText {
  content: string
  size: number // px at project resolution
  color: string
  background: boolean
  bold: boolean
  // --- styling (optional so older projects keep loading; defaults in effects/text.ts)
  font?: string // font id from FONTS
  weight?: number // 300..900 (overrides `bold`)
  align?: TextAlign
  letterSpacing?: number // px
  lineHeight?: number // multiple of size
  outlineColor?: string
  outlineWidth?: number // px, 0 = none
  shadow?: boolean
  glow?: boolean // neon: shadow in the text color
  bgColor?: string
  bgOpacity?: number // 0..1
  bgRadius?: number // multiple of size
  italic?: boolean
  uppercase?: boolean
  /** Animated text effect (see TEXT_FX). Motion Trail lives in the clip's effect stack. */
  fx?: TextFx
  fxDur?: number // seconds the effect's intro takes
  gradient?: { on: boolean; c1: string; c2: string; c3?: string; angle: number; animate: boolean }
}

export type TextFx = 'none' | 'kinetic' | 'tracking' | 'neon-flicker' | 'pop' | 'flip' | 'glitch'

export interface ClipFilter {
  preset: string // FILTER_PRESETS id, 'none'
  intensity: number // 0..100, how strongly the preset applies
  brightness: number // -100..100
  contrast: number // -100..100
  saturation: number // -100..100
  hue: number // -180..180 deg
  temperature: number // -100 (cool) .. 100 (warm)
  blur: number // px at project resolution
  vignette: number // 0..100
  grain: number // 0..100
}

export type AnimIn = 'none' | 'fade' | 'pop' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down' | 'zoom'
export type AnimLoop = 'none' | 'pulse' | 'bounce' | 'float' | 'spin' | 'wiggle'
export type TextReveal = 'none' | 'typewriter' | 'words' | 'rise'

export interface ClipAnim {
  in: AnimIn
  inDur: number
  out: AnimIn
  outDur: number
  loop: AnimLoop
  loopSpeed: number // cycles per second multiplier (1 = default)
  reveal: TextReveal // text only
  revealDur: number
}

/** One entry of a clip's effect stack (see effects/fx/videoEffects.ts for the catalog). */
export interface EffectInstance {
  id: string
  type: string
  on: boolean
  params: Record<string, number | string>
}

export interface ClipSticker {
  id: string // STICKERS id, or 'emoji'
  emoji?: string
  color: string
  color2: string
}

/** Transition id from TRANSITIONS (effects/transitions.ts). */
export type TransitionType = string

export type Easing = 'linear' | 'ease-in-out' | 'ease-in' | 'ease-out'

/**
 * A transition sits on a cut between two adjacent clips on one track (leftId + rightId),
 * or on a lone clip edge: leftId only = transition out (end), rightId only = transition in (start).
 */
export interface Transition {
  id: string
  trackId: string
  leftId?: string
  rightId?: string
  type: TransitionType
  duration: number
  easing: Easing
}

export interface Clip {
  id: string
  trackId: string
  kind: ClipKind
  assetId?: string
  /** Timeline position (s). */
  start: number
  /** Source in-point (s). */
  in: number
  duration: number
  /** Clips sharing a linkId move/trim/delete together (A/V pairs). */
  linkId?: string
  transform: ClipTransform
  audio: ClipAudio
  text?: ClipText
  filter?: ClipFilter
  anim?: ClipAnim
  sticker?: ClipSticker
  /** Stackable video effects, applied in order. */
  effects?: EffectInstance[]
  /** Clockwise degrees (stickers/text/video). */
  rotation?: number
}

export interface Project {
  id: string
  name: string
  width: number
  height: number
  fps: number
  sampleRate: number
  background: string
  assets: Asset[]
  /** Display order, top to bottom. Video tracks render bottom-up (last video track = lowest layer). */
  tracks: Track[]
  clips: Clip[]
  transitions?: Transition[]
}

// ---------------------------------------------------------------- export / jobs

export type HwAccel = 'no-preference' | 'prefer-hardware' | 'prefer-software'

export interface EncodeSettings {
  container: ContainerId
  /** null = no video track */
  videoCodec: VideoCodec | null
  /** null = no audio track */
  audioCodec: AudioCodec | null
  width: number
  height: number
  fps: number
  /** Either a qualitative level or explicit bitrates. */
  qualityMode: 'level' | 'bitrate'
  quality: QualityLevel
  videoBitrate: number // bps
  audioBitrate: number // bps
  keyFrameInterval: number // s
  hardwareAcceleration: HwAccel
  audioChannels: number
  sampleRate: number
}

export type JobTarget =
  | { kind: 'buffer' }
  | { kind: 'stream'; handle: FileSystemFileHandle }

export type ExportJob = {
  kind: 'export'
  project: Project
  settings: EncodeSettings
  range: { start: number; end: number }
  target: JobTarget
}

export type ConvertJob = {
  kind: 'convert'
  engine: 'conversion' | 'pipeline'
  asset: Asset
  settings: EncodeSettings
  /** When true and the codec/size are unchanged, the Conversion engine may copy streams (no re-encode). */
  allowCopy: boolean
  trim: { start: number; end: number }
  target: JobTarget
}

export type FixtureJob = {
  kind: 'fixture'
  spec: FixtureSpec
}

export type MediaJob = ExportJob | ConvertJob | FixtureJob

export interface FixtureSpec {
  container: ContainerId
  videoCodec: VideoCodec | null
  audioCodec: AudioCodec | null
  width: number
  height: number
  fps: number
  duration: number
  name?: string
}

/** Stage timings in milliseconds. Every field is optional because Conversion jobs cannot split stages. */
export interface StageTimings {
  workerSpawn?: number
  setup?: number
  decodeWait?: number
  composite?: number
  videoEncodeWait?: number
  audioDecodeMix?: number
  audioEncodeWait?: number
  finalize?: number
  timeToFirstProgress?: number
  total: number
}

export interface EncoderStats {
  videoFramesSubmitted: number
  videoPacketsOut: number
  audioPacketsOut: number
  keyFrames: number
  /** Submit → encoded packet latency per frame (ms). */
  latencyAvg: number | null
  latencyP95: number | null
  latencyMax: number | null
  /** First submit → last packet (ms): wall time the encoder was busy. */
  encoderSpan: number | null
  /** Encoder configs actually used (codec string, hardware accel). */
  videoEncoderConfig?: { codec: string; hardwareAcceleration?: string; width?: number; height?: number; bitrate?: number }
  audioEncoderConfig?: { codec: string; sampleRate?: number; numberOfChannels?: number; bitrate?: number }
}

export interface JobResult {
  timings: StageTimings
  encoder: EncoderStats | null
  frames: number
  mediaDuration: number
  outputBytes: number
  /** Present for buffer targets. */
  buffer?: ArrayBuffer
  mimeType: string
  fileName: string
  /** Conversion engine only. */
  conversion?: {
    discarded: Array<{ type: string; codec: string | null; reason: string }>
    utilizedTracks: number
    copyExpected: { video: boolean | null; audio: boolean | null }
  }
  peakHeapMB: number | null
  context: 'worker' | 'main'
}

export type JobProgress = { progress: number; processedTime: number }
