import { getEncodableAudioCodecs, getEncodableVideoCodecs, type AudioCodec, type VideoCodec } from 'mediabunny'
import { CONTAINERS, VIDEO_CODEC_LABELS, audioCodecLabel, type ContainerId } from './formats'
import { EXTENSION_CODECS, registerAllExtensions } from './extensions'

export interface CodecOption<C extends string> {
  codec: C
  label: string
  available: boolean
  reason?: string
  viaExtension?: string
}

export interface ContainerCaps {
  id: ContainerId
  label: string
  ext: string
  available: boolean
  reason?: string
  audioOnly: boolean
  video: CodecOption<VideoCodec>[]
  audio: CodecOption<AudioCodec>[]
}

export interface CapabilityQuery {
  width: number
  height: number
  fps: number
  channels: number
  sampleRate: number
}

const cache = new Map<string, Promise<ContainerCaps[]>>()

/**
 * Format matrix: for every container, which codecs Mediabunny can mux AND this browser
 * (+ registered extensions) can encode at the requested size/sample rate.
 */
export function getCapabilities(q: CapabilityQuery): Promise<ContainerCaps[]> {
  const key = `${q.width}x${q.height}@${q.fps}/${q.channels}ch/${q.sampleRate}`
  let p = cache.get(key)
  if (!p) {
    p = computeCapabilities(q)
    cache.set(key, p)
  }
  return p
}

async function computeCapabilities(q: CapabilityQuery): Promise<ContainerCaps[]> {
  registerAllExtensions()
  const result: ContainerCaps[] = []
  for (const def of CONTAINERS) {
    if (!def.make) {
      result.push({ id: def.id, label: def.label, ext: def.ext, available: false, reason: def.disabledReason, audioOnly: false, video: [], audio: [] })
      continue
    }
    const fmt = def.make('buffer')
    const vCodecs = fmt.getSupportedVideoCodecs()
    const aCodecs = fmt.getSupportedAudioCodecs()
    const [vOk, aOk] = await Promise.all([
      vCodecs.length ? getEncodableVideoCodecs(vCodecs, { width: q.width, height: q.height, frameRate: q.fps }) : Promise.resolve([]),
      aCodecs.length ? getEncodableAudioCodecs(aCodecs, { numberOfChannels: q.channels, sampleRate: q.sampleRate }) : Promise.resolve([]),
    ])
    const video = vCodecs.map<CodecOption<VideoCodec>>((codec) => {
      const available = vOk.includes(codec)
      return {
        codec,
        label: VIDEO_CODEC_LABELS[codec],
        available,
        viaExtension: EXTENSION_CODECS[codec],
        reason: available
          ? undefined
          : codec === 'prores'
            ? 'ProRes can be imported (decoded) but not encoded in the browser.'
            : `This browser can't encode ${VIDEO_CODEC_LABELS[codec]} at ${q.width}×${q.height}.`,
      }
    })
    const audio = aCodecs.map<CodecOption<AudioCodec>>((codec) => {
      const available = aOk.includes(codec)
      return {
        codec,
        label: audioCodecLabel(codec),
        available,
        viaExtension: EXTENSION_CODECS[codec],
        reason: available ? undefined : `This browser can't encode ${audioCodecLabel(codec)} (${q.channels} ch, ${q.sampleRate} Hz).`,
      }
    })
    const anyAvailable = video.some((v) => v.available) || audio.some((a) => a.available)
    result.push({
      id: def.id,
      label: def.label,
      ext: def.ext,
      available: anyAvailable,
      reason: anyAvailable ? undefined : 'No codec for this container can be encoded in this browser.',
      audioOnly: vCodecs.length === 0,
      video,
      audio,
    })
  }
  return result
}
