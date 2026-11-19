import { registerAacEncoder } from '@mediabunny/aac-encoder'
import { registerMp3Encoder } from '@mediabunny/mp3-encoder'
import { registerFlacEncoder } from '@mediabunny/flac-encoder'
import { registerProresDecoder } from '@mediabunny/prores'
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3'
import { registerDtsDecoder, registerDtsEncoder } from '@mediabunny/dts'
import { registerTrueHdDecoder, registerTrueHdEncoder } from '@mediabunny/truehd'

/** Which codecs are provided by extension packages rather than native WebCodecs. */
export const EXTENSION_CODECS = {
  aac: '@mediabunny/aac-encoder (FFmpeg WASM; only when chosen or the browser has no native AAC)',
  mp3: '@mediabunny/mp3-encoder (LAME)',
  flac: '@mediabunny/flac-encoder (libFLAC)',
  prores: '@mediabunny/prores (decode only)',
  ac3: '@mediabunny/ac3',
  eac3: '@mediabunny/ac3',
  dts: '@mediabunny/dts',
  truehd: '@mediabunny/truehd',
}

let registered = false

/**
 * Registers every official Mediabunny extension except the AAC encoder (see prepareAacEncoder). Registration is per
 * JS context, so this must run in the main thread AND in every worker that uses Mediabunny. Safe to call repeatedly.
 */
export function registerAllExtensions() {
  if (registered) return
  registered = true
  const steps = [
    ['mp3-encoder', registerMp3Encoder],
    ['flac-encoder', registerFlacEncoder],
    ['prores-decoder', registerProresDecoder],
    ['ac3-decoder', registerAc3Decoder],
    ['ac3-encoder', registerAc3Encoder],
    ['dts-decoder', registerDtsDecoder],
    ['dts-encoder', registerDtsEncoder],
    ['truehd-decoder', registerTrueHdDecoder],
    ['truehd-encoder', registerTrueHdEncoder],
  ]
  for (const [name, fn] of steps) {
    try {
      fn()
    } catch (err) {
      console.warn(`[mediabunny] failed to register ${name}`, err)
    }
  }
}

// ------------------------------------------------------------------ AAC: native WebCodecs or the WASM extension

/**
 * Mediabunny tries registered custom encoders BEFORE native WebCodecs, and the WASM AAC encoder accepts every AAC
 * config we use. Registering it unconditionally would make every AAC benchmark measure FFmpeg-in-WASM (in its own
 * nested worker) instead of the browser's encoder. So it's registered per context, by mode:
 *   'auto'   — only when the browser has no native AAC encoder (the extension's documented usage; default)
 *   'native' — never (fails if the browser has no AAC encoder)
 *   'wasm'   — always
 * A registration can't be undone, so in a long-lived context (the main thread) a 'wasm' job keeps WASM for later
 * jobs too; the returned state says so. Workers are created per job, so worker jobs always get exactly their mode.
 */
export const AAC_MODES = ['auto', 'native', 'wasm']
let aacRegistered = false
const nativeAac = new Map() // "rate/channels" → Promise<boolean>

/**
 * Whether this browser can encode AAC through WebCodecs for this sample rate / channel count (128 kb/s). Cached per
 * context and config: 48 kHz stereo being supported says nothing about, say, 22.05 kHz mono.
 */
export function nativeAacSupported({ sampleRate = 48000, numberOfChannels = 2 } = {}) {
  const key = `${sampleRate}/${numberOfChannels}`
  if (!nativeAac.has(key))
    nativeAac.set(
      key,
      typeof AudioEncoder === 'undefined'
        ? Promise.resolve(false)
        : AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate: 128000 })
            .then((r) => r.supported === true)
            .catch(() => false),
    )
  return nativeAac.get(key)
}

/**
 * Registers (or not) the WASM AAC encoder for `mode` and returns which implementation AAC jobs here will use.
 * `config` is the job's audio config, so 'auto' falls back to WASM when THAT config has no native encoder.
 */
export async function prepareAacEncoder(mode = 'auto', config = {}) {
  if (!AAC_MODES.includes(mode)) mode = 'auto'
  const native = await nativeAacSupported(config)
  if (!aacRegistered && (mode === 'wasm' || (mode === 'auto' && !native))) {
    try {
      registerAacEncoder()
      aacRegistered = true
    } catch (err) {
      console.warn('[mediabunny] failed to register aac-encoder', err)
    }
  }
  const impl = aacRegistered ? 'wasm-extension' : native ? 'native-webcodecs' : 'unavailable'
  return {
    requested: mode,
    impl,
    nativeAvailable: native,
    note: mode === 'native' && aacRegistered ? 'the WASM encoder was already registered in this JS context by an earlier job (main thread); reload the page to measure native AAC on the main thread' : undefined,
  }
}

/** Which implementation encodes `codec` in this context (after prepareAacEncoder for AAC). */
export function audioEncoderImpl(codec, aac) {
  if (!codec) return null
  if (codec === 'aac') return aac?.impl ?? (aacRegistered ? 'wasm-extension' : 'native-webcodecs')
  if (codec.startsWith('pcm-') || codec === 'ulaw' || codec === 'alaw') return 'mediabunny-pcm'
  if (EXTENSION_CODECS[codec]) return 'wasm-extension'
  return 'native-webcodecs'
}
