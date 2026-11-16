import {
  AdtsOutputFormat,
  FlacOutputFormat,
  MkvOutputFormat,
  MovOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  MpegTsOutputFormat,
  OggOutputFormat,
  WavOutputFormat,
  WebMOutputFormat,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny'

export type ContainerId =
  | 'mp4' | 'mov' | 'webm' | 'mkv' | 'ts' | 'ogg'
  | 'mp3' | 'wav' | 'aac' | 'flac' | 'hls'

export type TargetKind = 'buffer' | 'stream'

export interface ContainerDef {
  id: ContainerId
  label: string
  ext: string
  /** Factory for the Mediabunny output format. `null` = not offered in this MVP. */
  make: ((target: TargetKind) => OutputFormat) | null
  disabledReason?: string
}

export const CONTAINERS: ContainerDef[] = [
  {
    id: 'mp4', label: 'MP4', ext: '.mp4',
    // Fast start in memory gives the best playback compatibility but buffers the file; streaming writes moov at the end.
    make: (t) => new Mp4OutputFormat({ fastStart: t === 'buffer' ? 'in-memory' : false }),
  },
  { id: 'mov', label: 'QuickTime MOV', ext: '.mov', make: (t) => new MovOutputFormat({ fastStart: t === 'buffer' ? 'in-memory' : false }) },
  { id: 'webm', label: 'WebM', ext: '.webm', make: () => new WebMOutputFormat() },
  { id: 'mkv', label: 'Matroska MKV', ext: '.mkv', make: () => new MkvOutputFormat() },
  { id: 'ts', label: 'MPEG-TS', ext: '.ts', make: () => new MpegTsOutputFormat() },
  { id: 'ogg', label: 'Ogg', ext: '.ogg', make: () => new OggOutputFormat() },
  { id: 'mp3', label: 'MP3 (audio)', ext: '.mp3', make: () => new Mp3OutputFormat() },
  { id: 'wav', label: 'WAV (audio)', ext: '.wav', make: () => new WavOutputFormat() },
  { id: 'aac', label: 'AAC / ADTS (audio)', ext: '.aac', make: () => new AdtsOutputFormat() },
  { id: 'flac', label: 'FLAC (audio)', ext: '.flac', make: () => new FlacOutputFormat() },
  {
    id: 'hls', label: 'HLS (.m3u8)', ext: '.m3u8', make: null,
    disabledReason: 'HLS writes a playlist plus many segment files; multi-file browser output is not in this MVP.',
  },
]

export function containerDef(id: ContainerId): ContainerDef {
  const def = CONTAINERS.find((c) => c.id === id)
  if (!def) throw new Error(`Unknown container ${id}`)
  return def
}

export function makeOutputFormat(id: ContainerId, target: TargetKind): OutputFormat {
  const def = containerDef(id)
  if (!def.make) throw new Error(def.disabledReason ?? `${def.label} output is not available`)
  return def.make(target)
}

export const VIDEO_CODEC_LABELS: Record<VideoCodec, string> = {
  avc: 'H.264 / AVC',
  hevc: 'H.265 / HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'Apple ProRes',
}

export function audioCodecLabel(c: AudioCodec): string {
  const map: Partial<Record<AudioCodec, string>> = {
    aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC',
    ac3: 'AC-3 (Dolby Digital)', eac3: 'E-AC-3 (Dolby Digital Plus)', dts: 'DTS', truehd: 'Dolby TrueHD',
    ulaw: 'μ-law', alaw: 'A-law',
  }
  return map[c] ?? c.toUpperCase().replace('PCM-', 'PCM ')
}
