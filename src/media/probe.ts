import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  CanvasSink,
  Input,
  UnsupportedInputFormatError,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny'
import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from './types'

const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif|bmp|svg)$/i
const KNOWN_UNSUPPORTED = /\.(avi|flv|wmv|asf|mpg|mpeg|vob|3gp|rm|rmvb|m2ts|mts|f4v)$/i

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name)
}

export class ProbeError extends Error {}

export function openInput(file: Blob): Input {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
}

async function videoInfo(track: InputVideoTrack): Promise<VideoStreamInfo> {
  const [codec, codecString, width, height, rotation, canDecode, hdr] = await Promise.all([
    track.getCodec(),
    track.getCodecParameterString(),
    track.getDisplayWidth(),
    track.getDisplayHeight(),
    track.getRotation(),
    track.canDecode(),
    track.hasHighDynamicRange().catch(() => false),
  ])
  let fps = 0
  let constant = true
  try {
    const m = await track.computeFrameRateMetrics({ targetPacketCount: 120 })
    fps = m.bestGuessFrameRate
    constant = m.frameRateIsConstant
  } catch {
    try {
      fps = (await track.computePacketStats(120)).averagePacketRate
    } catch {
      /* ignore */
    }
  }
  let bitrate: number | null = null
  try {
    bitrate = (await track.getAverageBitrate()) ?? (await track.computePacketStats(200)).averageBitrate
  } catch {
    /* ignore */
  }
  return { codec, codecString, width, height, rotation, fps, frameRateConstant: constant, bitrate, canDecode, hdr }
}

async function audioInfo(track: InputAudioTrack): Promise<AudioStreamInfo> {
  const [codec, codecString, channels, sampleRate, canDecode] = await Promise.all([
    track.getCodec(),
    track.getCodecParameterString(),
    track.getNumberOfChannels(),
    track.getSampleRate(),
    track.canDecode(),
  ])
  let bitrate: number | null = null
  try {
    bitrate = (await track.getAverageBitrate()) ?? (await track.computePacketStats(200)).averageBitrate
  } catch {
    /* ignore */
  }
  return { codec, codecString, channels, sampleRate, bitrate, canDecode }
}

/** Probe a file with Mediabunny (or the browser image decoder for stills). Throws ProbeError with a readable reason. */
export async function probeFile(file: File): Promise<MediaInfo> {
  if (isImageFile(file)) {
    try {
      const bmp = await createImageBitmap(file)
      const info: MediaInfo = {
        kind: 'image', container: file.type || 'image', mimeType: file.type, size: file.size, duration: 5,
        video: null, audio: null, videoTrackCount: 0, audioTrackCount: 0,
        imageWidth: bmp.width, imageHeight: bmp.height, warnings: [],
      }
      bmp.close()
      return info
    } catch {
      throw new ProbeError(`"${file.name}" looks like an image but the browser could not decode it.`)
    }
  }

  const input = openInput(file)
  try {
    let formatName: string
    try {
      formatName = (await input.getFormat()).name
    } catch (err) {
      if (err instanceof UnsupportedInputFormatError || KNOWN_UNSUPPORTED.test(file.name)) {
        const ext = file.name.split('.').pop()?.toUpperCase() ?? 'this'
        throw new ProbeError(
          `${ext} files aren't supported. Mediabunny reads MP4, MOV, MKV, WebM, Ogg, MPEG-TS, MP3, WAV, AAC, FLAC and HLS.`,
        )
      }
      throw err
    }
    const [videoTracks, audioTracks, mimeType] = await Promise.all([
      input.getVideoTracks(),
      input.getAudioTracks(),
      input.getMimeType().catch(() => file.type),
    ])
    const primaryVideo = await input.getPrimaryVideoTrack()
    const primaryAudio = await input.getPrimaryAudioTrack()
    const warnings: string[] = []
    const video = primaryVideo ? await videoInfo(primaryVideo) : null
    const audio = primaryAudio ? await audioInfo(primaryAudio) : null
    if (video && !video.canDecode) warnings.push(`Video codec ${video.codec ?? 'unknown'} can't be decoded in this browser.`)
    if (audio && !audio.canDecode) warnings.push(`Audio codec ${audio.codec ?? 'unknown'} can't be decoded in this browser.`)
    if (video && !video.frameRateConstant) warnings.push('Variable frame rate source.')
    if (!video && !audio) throw new ProbeError(`"${file.name}" has no audio or video tracks.`)
    if ((!video || !video.canDecode) && (!audio || !audio.canDecode)) {
      throw new ProbeError(warnings.join(' ') || 'No decodable tracks.')
    }
    const duration = await input.computeDuration()
    return {
      kind: video && video.canDecode ? 'video' : 'audio',
      container: formatName,
      mimeType,
      size: file.size,
      duration,
      video,
      audio,
      videoTrackCount: videoTracks.length,
      audioTrackCount: audioTracks.length,
      warnings,
    }
  } finally {
    input.dispose()
  }
}

/**
 * Actually decodes the first video frame and first audio sample with Mediabunny.
 * Used to verify exports: a file can probe fine yet fail to decode.
 */
export async function decodeCheck(file: Blob): Promise<string[]> {
  const problems: string[] = []
  const input = openInput(file)
  try {
    const v = await input.getPrimaryVideoTrack()
    if (v) {
      if (!(await v.canDecode())) problems.push(`video ${v.codec ?? '?'} is not decodable`)
      else {
        let frames = 0
        for await (const _ of new CanvasSink(v, { width: 64, height: 36, fit: 'fill' }).canvases()) {
          if (++frames >= 3) break
        }
        if (!frames) problems.push('no video frame could be decoded')
      }
    }
    const a = await input.getPrimaryAudioTrack()
    if (a) {
      if (!(await a.canDecode())) problems.push(`audio ${a.codec ?? '?'} is not decodable`)
      else {
        // Iterate instead of getSample(firstTimestamp): codecs with priming (Opus pre-skip, MP3 delay)
        // may have no output sample at the exact first packet timestamp.
        let samples = 0
        for await (const smp of new AudioSampleSink(a).samples()) {
          smp.close()
          if (++samples >= 3) break
        }
        if (!samples) problems.push('no audio sample could be decoded')
      }
    }
  } catch (err) {
    problems.push(`decode failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    input.dispose()
  }
  return problems
}

/** Small JPEG thumbnail as a data URL (main thread). */
export async function makeThumbnail(file: File, info: MediaInfo): Promise<string | undefined> {
  try {
    if (info.kind === 'image') {
      const bmp = await createImageBitmap(file)
      const c = document.createElement('canvas')
      const s = 160 / Math.max(bmp.width, bmp.height)
      c.width = Math.max(1, Math.round(bmp.width * s))
      c.height = Math.max(1, Math.round(bmp.height * s))
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
      bmp.close()
      return c.toDataURL('image/jpeg', 0.7)
    }
    if (info.kind !== 'video') return undefined
    const input = openInput(file)
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track) return undefined
      const sink = new CanvasSink(track, { width: 160, height: Math.round(160 * (info.video!.height / info.video!.width)), fit: 'fill' })
      const t = Math.min(1, info.duration / 3)
      const wrapped = (await sink.getCanvas(t)) ?? (await sink.getCanvas(0))
      if (!wrapped) return undefined
      const src = wrapped.canvas
      const c = document.createElement('canvas')
      c.width = src.width
      c.height = src.height
      c.getContext('2d')!.drawImage(src, 0, 0)
      return c.toDataURL('image/jpeg', 0.7)
    } finally {
      input.dispose()
    }
  } catch (err) {
    console.warn('thumbnail failed', err)
    return undefined
  }
}
