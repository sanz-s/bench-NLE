import { AudioSampleSink } from 'mediabunny'
import { clipEnd, resolveTransitions } from './compositor'

/** Gain at timeline time `t` for a clip, including fades. */
export function clipGainAt(c, t) {
  const local = t - c.start
  const remaining = c.start + c.duration - t
  let g = c.audio.gain
  if (c.audio.fadeIn > 0 && local < c.audio.fadeIn) g *= Math.max(0, local / c.audio.fadeIn)
  if (c.audio.fadeOut > 0 && remaining < c.audio.fadeOut) g *= Math.max(0, remaining / c.audio.fadeOut)
  return g
}

/**
 * Gain function for a project: clip gain + fades, plus an automatic audio dip on the linked
 * audio of video transitions (outgoing fades out to the cut, incoming fades in from it, equal-power).
 */
export function makeGainFn(p) {
  const envelopes = new Map()
  const add = (videoClip, a, b, dir) => {
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
  iter
  srcRate = 0
  srcChannels = 0
  /** Decoded, channel-mapped source audio (outChannels planes). */
  buf
  bufLen = 0
  /** Source time (s) of buf[0][0]. */
  bufStart
  done = false

  clip
  outRate
  outCh

  gain

  constructor(track, clip, outRate, outChannels, gain = clipGainAt) {
    this.clip = clip
    this.gain = gain
    this.outRate = outRate
    this.outCh = outChannels
    const sink = new AudioSampleSink(track)
    this.iter = sink.samples(clip.in, clip.in + clip.duration + 0.05)
    this.buf = Array.from({ length: outChannels }, () => new Float32Array(0))
    this.bufStart = clip.in
  }

  /**
   * Map decoded source planes to the output layout. Same-count layouts pass through; otherwise channels are
   * down-mixed with the Web Audio / ITU coefficients, assuming the standard orders: 3 = L R C, 4 = L R SL SR
   * (quad), 5 = L R C SL SR, 6 = L R C LFE SL SR (5.1), 8 = L R C LFE BL BR SL SR (7.1). LFE is dropped.
   */
  mapChannels(planes) {
    const n = planes[0].length
    const c = planes.length
    const outCh = this.outCh
    const out = Array.from({ length: outCh }, () => new Float32Array(n))
    if (c === outCh) {
      for (let ch = 0; ch < outCh; ch++) out[ch].set(planes[ch])
      return out
    }
    if (c === 1) {
      // mono → front left/right (centre-less layouts) like Web Audio's up-mix
      if (outCh === 1) out[0].set(planes[0])
      else {
        out[0].set(planes[0])
        out[1].set(planes[0])
      }
      return out
    }
    const k = Math.SQRT1_2
    // fold everything to L/R first
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    const add = (dst, src, g) => {
      for (let i = 0; i < n; i++) dst[i] += src[i] * g
    }
    if (c === 2) {
      L.set(planes[0])
      R.set(planes[1])
    } else if (c === 3) {
      add(L, planes[0], 1)
      add(R, planes[1], 1)
      add(L, planes[2], k)
      add(R, planes[2], k)
    } else if (c === 4) {
      add(L, planes[0], 0.5)
      add(R, planes[1], 0.5)
      add(L, planes[2], 0.5)
      add(R, planes[3], 0.5)
    } else if (c === 5 || c === 6) {
      const [l, r, C] = planes
      const SL = planes[c === 6 ? 4 : 3]
      const SR = planes[c === 6 ? 5 : 4]
      add(L, l, 1)
      add(R, r, 1)
      add(L, C, k)
      add(R, C, k)
      add(L, SL, k)
      add(R, SR, k)
    } else if (c === 8) {
      const [l, r, C, , BL, BR, SL, SR] = planes
      add(L, l, 1)
      add(R, r, 1)
      add(L, C, k)
      add(R, C, k)
      add(L, SL, k)
      add(R, SR, k)
      add(L, BL, k)
      add(R, BR, k)
    } else {
      // unknown layout: average even channels to L, odd to R
      for (let ch = 0; ch < c; ch++) add(ch % 2 ? R : L, planes[ch], 2 / c)
    }
    if (outCh === 1) {
      for (let i = 0; i < n; i++) out[0][i] = (L[i] + R[i]) / 2
    } else {
      out[0].set(L)
      out[1].set(R)
    }
    return out
  }

  /** Append decoded planes. The buffer grows by doubling (amortized O(1) per sample, not a full copy per packet). */
  append(planes, sampleTime) {
    const expectedTime = this.bufStart + this.bufLen / this.srcRate
    const gapFrames = Math.round((sampleTime - expectedTime) * this.srcRate)
    let data = planes
    let pad = 0
    if (gapFrames > 0) pad = gapFrames
    else if (gapFrames < 0) data = planes.map((p) => p.subarray(Math.min(p.length, -gapFrames)))
    const addLen = pad + data[0].length
    const newLen = this.bufLen + addLen
    for (let ch = 0; ch < this.outCh; ch++) {
      let b = this.buf[ch]
      if (b.length < newLen) {
        const nb = new Float32Array(Math.max(newLen, b.length * 2, 4096))
        nb.set(b.subarray(0, this.bufLen))
        b = nb
        this.buf[ch] = b
      }
      if (pad) b.fill(0, this.bufLen, this.bufLen + pad)
      b.set(data[ch], this.bufLen + pad)
    }
    this.bufLen = newLen
  }

  /** Ensure decoded source audio exists up to source time `s`. */
  async ensure(s) {
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
        const planes = []
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
  trimBefore(s) {
    if (!this.srcRate) return
    const drop = Math.floor((s - this.bufStart) * this.srcRate) - 4
    if (drop > this.srcRate) {
      for (let ch = 0; ch < this.outCh; ch++) this.buf[ch].copyWithin(0, drop, this.bufLen)
      this.bufLen -= drop
      this.bufStart += drop / this.srcRate
    }
  }

  /** Mix this clip into `out` (planar, outCh × frames) for timeline window starting at t0. */
  async mixInto(out, t0, frames) {
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
export function packPlanar(planes) {
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
