import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input, UnsupportedInputFormatError } from 'mediabunny'

const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif|bmp|svg)$/i
const KNOWN_UNSUPPORTED = /\.(avi|flv|wmv|asf|mpg|mpeg|vob|3gp|rm|rmvb|m2ts|mts|f4v)$/i

export function isImageFile(file) {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name)
}

export class ProbeError extends Error {}

export function openInput(file) {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
}

async function videoInfo(track) {
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
  let bitrate = null
  try {
    bitrate = (await track.getAverageBitrate()) ?? (await track.computePacketStats(200)).averageBitrate
  } catch {
    /* ignore */
  }
  return { codec, codecString, width, height, rotation, fps, frameRateConstant: constant, bitrate, canDecode, hdr }
}

async function audioInfo(track) {
  const [codec, codecString, channels, sampleRate, canDecode] = await Promise.all([
    track.getCodec(),
    track.getCodecParameterString(),
    track.getNumberOfChannels(),
    track.getSampleRate(),
    track.canDecode(),
  ])
  let bitrate = null
  try {
    bitrate = (await track.getAverageBitrate()) ?? (await track.computePacketStats(200)).averageBitrate
  } catch {
    /* ignore */
  }
  return { codec, codecString, channels, sampleRate, bitrate, canDecode }
}

/** Probe a file with Mediabunny (or the browser image decoder for stills). Throws ProbeError with a readable reason. */
export async function probeFile(file) {
  if (isImageFile(file)) {
    try {
      const bmp = await createImageBitmap(file)
      const info = {
        kind: 'image',
        container: file.type || 'image',
        mimeType: file.type,
        size: file.size,
        duration: 5,
        video: null,
        audio: null,
        videoTrackCount: 0,
        audioTrackCount: 0,
        imageWidth: bmp.width,
        imageHeight: bmp.height,
        warnings: [],
      }
      bmp.close()
      return info
    } catch {
      throw new ProbeError(`"${file.name}" looks like an image but the browser could not decode it.`)
    }
  }

  const input = openInput(file)
  try {
    let formatName
    try {
      formatName = (await input.getFormat()).name
    } catch (err) {
      if (err instanceof UnsupportedInputFormatError || KNOWN_UNSUPPORTED.test(file.name)) {
        const ext = file.name.split('.').pop()?.toUpperCase() ?? 'this'
        throw new ProbeError(`${ext} files aren't supported. Mediabunny reads MP4, MOV, MKV, WebM, Ogg, MPEG-TS, MP3, WAV, AAC, FLAC and HLS.`)
      }
      throw err
    }
    const [videoTracks, audioTracks, mimeType] = await Promise.all([input.getVideoTracks(), input.getAudioTracks(), input.getMimeType().catch(() => file.type)])
    const primaryVideo = await input.getPrimaryVideoTrack()
    const primaryAudio = await input.getPrimaryAudioTrack()
    const warnings = []
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
 * Really decodes the output with Mediabunny (a file can probe fine yet fail to decode).
 *  - default ('head+tail'): the first 3 video frames and audio samples, the LAST video frame and the final ~0.25 s
 *    of audio. The tail check catches truncated files whose index still claims the missing frames.
 *  - full: every video frame and audio sample (slow on long files; `--matrix` and opt-in only). Returns the decoded
 *    frame count and audio duration so the caller can compare them with what was expected.
 */
export async function decodeCheck(file, { full = false } = {}) {
  const problems = []
  const out = { depth: full ? 'full' : 'head+tail', videoFrames: null, audioSeconds: null }
  const input = openInput(file)
  try {
    const v = await input.getPrimaryVideoTrack()
    if (v) {
      if (!(await v.canDecode())) problems.push(`video ${v.codec ?? '?'} is not decodable`)
      else {
        const sink = new CanvasSink(v, { width: 64, height: 36, fit: 'fill' })
        let frames = 0
        for await (const _ of sink.canvases()) {
          if (++frames >= 3 && !full) break
        }
        if (!frames) problems.push('no video frame could be decoded')
        if (full) out.videoFrames = frames
        else {
          const end = await v.computeDuration()
          const last = end > 0 ? await sink.getCanvas(Math.max(0, end - 1e-3)) : null
          if (!last) problems.push(`the last video frame (at ${end.toFixed(3)} s) could not be decoded`)
        }
      }
    }
    const a = await input.getPrimaryAudioTrack()
    if (a) {
      if (!(await a.canDecode())) problems.push(`audio ${a.codec ?? '?'} is not decodable`)
      else {
        // Iterate instead of getSample(firstTimestamp): codecs with priming (Opus pre-skip, MP3 delay)
        // may have no output sample at the exact first packet timestamp.
        const sink = new AudioSampleSink(a)
        let samples = 0
        let seconds = 0
        for await (const smp of sink.samples()) {
          seconds += smp.duration
          smp.close()
          if (++samples >= 3 && !full) break
        }
        if (!samples) problems.push('no audio sample could be decoded')
        if (full) out.audioSeconds = seconds
        else {
          const end = await a.computeDuration()
          let tail = 0
          for await (const smp of sink.samples(Math.max(0, end - 0.25), end)) {
            tail++
            smp.close()
          }
          if (end > 0.3 && !tail) problems.push(`the last audio samples (before ${end.toFixed(3)} s) could not be decoded`)
        }
      }
    }
  } catch (err) {
    problems.push(`decode failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    input.dispose()
  }
  return { problems, ...out }
}

/** Small JPEG thumbnail as a data URL (main thread). */
export async function makeThumbnail(file, info) {
  try {
    if (info.kind === 'image') {
      const bmp = await createImageBitmap(file)
      const c = document.createElement('canvas')
      const s = 160 / Math.max(bmp.width, bmp.height)
      c.width = Math.max(1, Math.round(bmp.width * s))
      c.height = Math.max(1, Math.round(bmp.height * s))
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
      bmp.close()
      return c.toDataURL('image/jpeg', 0.7)
    }
    if (info.kind !== 'video') return undefined
    const input = openInput(file)
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track) return undefined
      const sink = new CanvasSink(track, { width: 160, height: Math.round(160 * (info.video.height / info.video.width)), fit: 'fill' })
      const t = Math.min(1, info.duration / 3)
      const wrapped = (await sink.getCanvas(t)) ?? (await sink.getCanvas(0))
      if (!wrapped) return undefined
      const src = wrapped.canvas
      const c = document.createElement('canvas')
      c.width = src.width
      c.height = src.height
      c.getContext('2d').drawImage(src, 0, 0)
      return c.toDataURL('image/jpeg', 0.7)
    } finally {
      input.dispose()
    }
  } catch (err) {
    console.warn('thumbnail failed', err)
    return undefined
  }
}
