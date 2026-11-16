import { AudioSampleSink, type AudioSample, type InputAudioTrack } from 'mediabunny'
import type { Clip, Project } from './types'
import { clipEnd, resolveTransitions } from './compositor'

/** Gain at timeline time `t` for a clip, including fades. */
export function clipGainAt(c: Clip, t: number): number {
  const local = t - c.start
  const remaining = c.start + c.duration - t
  let g = c.audio.gain
  if (c.audio.fadeIn > 0 && local < c.audio.fadeIn) g *= Math.max(0, local / c.audio.fadeIn)
  if (c.audio.fadeOut > 0 && remaining < c.audio.fadeOut) g *= Math.max(0, remaining / c.audio.fadeOut)
  return g
}

export type GainFn = (c: Clip, t: number) => number

/**
 * Gain function for a project: clip gain + fades, plus an automatic audio dip on the linked
 * audio of video transitions (outgoing fades out to the cut, incoming fades in from it, equal-power).
 */
export function makeGainFn(p: Project): GainFn {
  const envelopes = new Map<string, Array<{ a: number; b: number; dir: 'in' | 'out' }>>()
  const add = (videoClip: Clip | null, a: number, b: number, dir: 'in' | 'out') => {
    if (!videoClip?.linkId || b <= a) return
    for (const c of p.clips) {
      if (c.kind !== 'audio' || c.linkId !== videoClip.linkId) continue
      const list = envelopes.get(c.id) ?? []
      list.push({ a, b, dir })
      envelopes.set(c.id, list)
    }
  }
  for (const rt of resolveTransitions(p)) {
    if (rt.a && rt.b) {
      const cut = rt.b.start
      add(rt.a, rt.start, cut, 'out')
      add(rt.b, cut, rt.end, 'in')
    } else if (rt.b) add(rt.b, rt.start, rt.end, 'in')
    else if (rt.a) add(rt.a, rt.start, clipEnd(rt.a), 'out')
  }
  return (c, t) => {
    let g = clipGainAt(c, t)
    const env = envelopes.get(c.id)
    if (env) {
      for (const e of env) {
        if (t < e.a || t > e.b) continue
        const q = (t - e.a) / (e.b - e.a)
        g *= e.dir === 'in' ? Math.sin((q * Math.PI) / 2) : Math.cos((q * Math.PI) / 2)
      }
    }
    return g
  }
}

/**
 * Streams one clip's audio as resampled planar float data at the output rate.
 * Decoding happens through Mediabunny's AudioSampleSink (works in workers, unlike AudioBuffer).
 */
export class ClipAudioReader {
  private iter: AsyncGenerator<AudioSample, void, unknown>
  private srcRate = 0
  private srcChannels = 0
  /** Decoded, channel-mapped source audio (outChannels planes). */
  private buf: Float32Array[]
  private bufLen = 0
  /** Source time (s) of buf[0][0]. */
  private bufStart: number
  private done = false

  readonly clip: Clip
  private readonly outRate: number
  private readonly outCh: number

  private readonly gain: GainFn

  constructor(track: InputAudioTrack, clip: Clip, outRate: number, outChannels: number, gain: GainFn = clipGainAt) {
    this.clip = clip
    this.gain = gain
    this.outRate = outRate
    this.outCh = outChannels
    const sink = new AudioSampleSink(track)
    this.iter = sink.samples(clip.in, clip.in + clip.duration + 0.05)
    this.buf = Array.from({ length: outChannels }, () => new Float32Array(0))
    this.bufStart = clip.in
  }

  private mapChannels(planes: Float32Array[]): Float32Array[] {
    const n = planes[0].length
    const out = Array.from({ length: this.outCh }, () => new Float32Array(n))
    const c = planes.length
    if (this.outCh === 1) {
      for (let i = 0; i < n; i++) {
        let s = 0
        for (let k = 0; k < c; k++) s += planes[k][i]
        out[0][i] = s / c
      }
      return out
    }
    // outCh >= 2
    if (c === 1) {
      for (let ch = 0; ch < this.outCh; ch++) out[ch].set(planes[0])
    } else if (c === 6) {
      // L R C LFE SL SR → stereo
      const [L, R, C, , SL, SR] = planes
      const k = Math.SQRT1_2
      for (let i = 0; i < n; i++) {
        out[0][i] = L[i] + k * C[i] + k * SL[i]
        out[1][i] = R[i] + k * C[i] + k * SR[i]
      }
    } else {
      out[0].set(planes[0])
      out[1].set(planes[1])
    }
    return out
  }

  private append(planes: Float32Array[], sampleTime: number) {
    const expectedTime = this.bufStart + this.bufLen / this.srcRate
    const gapFrames = Math.round((sampleTime - expectedTime) * this.srcRate)
    let data = planes
    let pad = 0
    if (gapFrames > 0) pad = gapFrames
    else if (gapFrames < 0) data = planes.map((p) => p.subarray(Math.min(p.length, -gapFrames)))
    const addLen = pad + data[0].length
    const newLen = this.bufLen + addLen
    for (let ch = 0; ch < this.outCh; ch++) {
      const nb = new Float32Array(newLen)
      nb.set(this.buf[ch].subarray(0, this.bufLen))
      nb.set(data[ch], this.bufLen + pad)
      this.buf[ch] = nb
    }
    this.bufLen = newLen
  }

  /** Ensure decoded source audio exists up to source time `s`. */
  private async ensure(s: number) {
    while (!this.done && (this.srcRate === 0 || this.bufStart + this.bufLen / this.srcRate < s)) {
      const r = await this.iter.next()
      if (r.done) {
        this.done = true
        break
      }
      const sample = r.value
      try {
        if (this.srcRate === 0) {
          this.srcRate = sample.sampleRate
          this.srcChannels = sample.numberOfChannels
        }
        const planes: Float32Array[] = []
        for (let ch = 0; ch < this.srcChannels; ch++) {
          const p = new Float32Array(sample.numberOfFrames)
          sample.copyTo(p, { planeIndex: ch, format: 'f32-planar' })
          planes.push(p)
        }
        this.append(this.mapChannels(planes), sample.timestamp)
      } finally {
        sample.close()
      }
    }
  }

  /** Drop decoded data before source time `s` to bound memory. */
  private trimBefore(s: number) {
    if (!this.srcRate) return
    const drop = Math.floor((s - this.bufStart) * this.srcRate) - 4
    if (drop > this.srcRate) {
      for (let ch = 0; ch < this.outCh; ch++) this.buf[ch] = this.buf[ch].slice(drop, this.bufLen)
      this.bufLen -= drop
      this.bufStart += drop / this.srcRate
    }
  }

  /** Mix this clip into `out` (planar, outCh × frames) for timeline window starting at t0. */
  async mixInto(out: Float32Array[], t0: number, frames: number) {
    const c = this.clip
    const t1 = t0 + frames / this.outRate
    const a = Math.max(t0, c.start)
    const b = Math.min(t1, c.start + c.duration)
    if (b <= a) return
    const srcA = c.in + (a - c.start)
    const srcB = c.in + (b - c.start)
    await this.ensure(srcB + 2 / Math.max(1, this.srcRate || this.outRate))
    if (!this.srcRate || this.bufLen === 0) return
    const iStart = Math.max(0, Math.round((a - t0) * this.outRate))
    const iEnd = Math.min(frames, Math.round((b - t0) * this.outRate))
    const ratio = this.srcRate / this.outRate
    const base = (srcA - this.bufStart) * this.srcRate
    for (let i = iStart; i < iEnd; i++) {
      const t = t0 + i / this.outRate
      const g = this.gain(c, t)
      if (g === 0) continue
      const pos = base + (i - iStart) * ratio
      const i0 = Math.floor(pos)
      if (i0 < 0 || i0 >= this.bufLen) continue
      const frac = pos - i0
      const i1 = Math.min(i0 + 1, this.bufLen - 1)
      for (let ch = 0; ch < this.outCh; ch++) {
        const p = this.buf[ch]
        out[ch][i] += (p[i0] + (p[i1] - p[i0]) * frac) * g
      }
    }
    this.trimBefore(srcB)
  }

  async dispose() {
    await this.iter.return(undefined)
  }
}

/** Clamp and pack planar channels into one Float32Array ('f32-planar' layout). */
export function packPlanar(planes: Float32Array[]): Float32Array {
  const n = planes[0].length
  const out = new Float32Array(n * planes.length)
  planes.forEach((p, ch) => {
    for (let i = 0; i < n; i++) {
      const v = p[i]
      out[ch * n + i] = v > 1 ? 1 : v < -1 ? -1 : v
    }
  })
  return out
}
