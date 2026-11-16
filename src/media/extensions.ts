import { registerAacEncoder } from '@mediabunny/aac-encoder'
import { registerMp3Encoder } from '@mediabunny/mp3-encoder'
import { registerFlacEncoder } from '@mediabunny/flac-encoder'
import { registerProresDecoder } from '@mediabunny/prores'
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3'
import { registerDtsDecoder, registerDtsEncoder } from '@mediabunny/dts'
import { registerTrueHdDecoder, registerTrueHdEncoder } from '@mediabunny/truehd'

/** Which codecs are provided by extension packages rather than native WebCodecs. */
export const EXTENSION_CODECS: Record<string, string> = {
  aac: '@mediabunny/aac-encoder (encode polyfill)',
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
 * Registers every official Mediabunny extension. Registration is per JS context,
 * so this must run in the main thread AND in every worker that uses Mediabunny.
 * Safe to call repeatedly.
 */
export function registerAllExtensions(): void {
  if (registered) return
  registered = true
  const steps: Array<[string, () => void]> = [
    ['aac-encoder', registerAacEncoder],
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
