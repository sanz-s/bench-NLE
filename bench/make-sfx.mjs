#!/usr/bin/env node
/**
 * Synthesizes a small, license-free sound-effect kit as 48 kHz stereo 16-bit WAV files in bench/sfx/
 * (whoosh, impact, glitch, riser, pop, shimmer, burn, swoosh-reverse). Deterministic (seeded noise).
 *   node bench/make-sfx.mjs
 * The showcase (bench/showcase.mjs) imports them and lays them on A2/A3; buildShowcase() places any
 * asset named sfx-<name>.wav.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sfx')
mkdirSync(dir, { recursive: true })
const SR = 48000
const TAU = Math.PI * 2

let seed = 1234567
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t

/** RBJ band-pass biquad whose centre frequency can change every sample. */
function bandpass() {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  return (x, f, q) => {
    const w = (TAU * clamp(f, 20, SR / 2.2)) / SR
    const al = Math.sin(w) / (2 * q)
    const a0 = 1 + al
    const b0 = al / a0, b2 = -al / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - al) / a0
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    return y
  }
}
function lowpass() {
  let y = 0
  return (x, f) => (y += (1 - Math.exp((-TAU * f) / SR)) * (x - y))
}

/** fn(t, i, dur) → [l, r] */
function render(name, dur, fn) {
  const n = Math.round(dur * SR)
  const L = new Float32Array(n), R = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const [l, r] = fn(i / SR, i, dur)
    L[i] = l; R[i] = r
  }
  // normalize to -1 dBFS, 5 ms fade at both ends (no clicks)
  let peak = 1e-9
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
  const g = 0.89 / peak
  const fade = Math.round(0.005 * SR)
  const buf = Buffer.alloc(44 + n * 4)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40)
  for (let i = 0; i < n; i++) {
    const e = Math.min(1, i / fade, (n - 1 - i) / fade)
    buf.writeInt16LE(Math.round(clamp(L[i] * g * e, -1, 1) * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(clamp(R[i] * g * e, -1, 1) * 32767), 46 + i * 4)
  }
  const file = path.join(dir, `sfx-${name}.wav`)
  writeFileSync(file, buf)
  console.log(`  ${path.basename(file)}  ${dur.toFixed(2)} s`)
}

const pan = (v, p) => [v * Math.cos((p + 1) * Math.PI / 4), v * Math.sin((p + 1) * Math.PI / 4)]

console.log(`writing ${dir}`)

// whoosh: band-passed noise sweeping up then down, loudest in the middle, panning L → R
{
  const bl = bandpass(), br = bandpass()
  render('whoosh', 0.8, (t, _i, d) => {
    const u = t / d
    const env = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.8)), 2)
    const f = 300 + 2600 * Math.sin(Math.PI * u)
    const [pl, pr] = pan(1, lerp(-0.8, 0.8, u))
    return [bl(rnd(), f, 1.4) * env * pl, br(rnd(), f * 1.05, 1.4) * env * pr]
  })
}
// reverse swoosh: rises into the cut and stops dead
{
  const b = bandpass()
  render('swoosh-in', 0.6, (t, _i, d) => {
    const u = t / d
    const env = Math.pow(u, 2.2)
    const v = b(rnd(), 400 + 4000 * u * u, 1.1) * env
    return pan(v, lerp(0.6, -0.2, u))
  })
}
// impact: sub-boom pitch drop + noise transient + short tail
{
  const lp = lowpass(), lp2 = lowpass()
  let ph = 0
  render('impact', 1.6, (t) => {
    const f = 38 + 110 * Math.exp(-t * 9)
    ph += (TAU * f) / SR
    const boom = Math.sin(ph) * Math.exp(-t * 2.4)
    const click = lp(rnd(), 3500) * Math.exp(-t * 60) * 1.4
    const tail = lp2(rnd(), 900) * Math.exp(-t * 3.5) * 0.35
    const v = Math.tanh((boom * 1.2 + click + tail) * 1.6)
    return [v, v]
  })
}
// glitch: stuttering bit-crushed square bursts at random pitches
{
  const slots = Array.from({ length: 14 }, () => ({ f: 120 + Math.abs(rnd()) * 1800, on: rnd() > -0.35, crush: 3 + Math.floor(Math.abs(rnd()) * 6), p: rnd() }))
  render('glitch', 0.7, (t, i, d) => {
    const s = slots[Math.min(slots.length - 1, Math.floor((t / d) * slots.length))]
    if (!s.on) return [0, 0]
    const sq = Math.sign(Math.sin(TAU * s.f * t)) * 0.6 + rnd() * 0.25
    const q = Math.round(sq * s.crush) / s.crush
    const held = i % 6 < 3 ? q : q * 0.6 // sample-hold grit
    return pan(held * 0.8, s.p)
  })
}
// riser: detuned saws + noise climbing an octave and a half, crescendo
{
  const b = bandpass()
  const ph = [0, 0, 0]
  render('riser', 2.2, (t, _i, d) => {
    const u = t / d
    const f = 110 * Math.pow(2, 1.6 * u * u)
    let s = 0
    ;[0.995, 1, 1.006].forEach((k, j) => {
      ph[j] = (ph[j] + (f * k) / SR) % 1
      s += ph[j] * 2 - 1
    })
    const noise = b(rnd(), 800 + 7000 * u, 0.9)
    const env = Math.pow(u, 1.8)
    const trem = 1 - 0.3 * (0.5 + 0.5 * Math.sin(TAU * (4 + 18 * u) * t))
    const v = (s * 0.22 + noise * 0.9) * env * trem
    return [v * (1 - 0.15 * Math.sin(TAU * 0.7 * t)), v * (1 + 0.15 * Math.sin(TAU * 0.7 * t))]
  })
}
// pop: short pitched-up bubble
{
  let ph = 0
  render('pop', 0.18, (t) => {
    const f = 380 + 900 * (1 - Math.exp(-t * 40))
    ph += (TAU * f) / SR
    const v = Math.sin(ph) * Math.exp(-t * 28) + rnd() * Math.exp(-t * 400) * 0.3
    return [v, v]
  })
}
// shimmer: bell arpeggio with ringing partials and a little stereo delay
{
  const notes = [1568, 2093, 2637, 3136, 4186]
  render('shimmer', 1.4, (t) => {
    let l = 0, r = 0
    notes.forEach((f, k) => {
      const t0 = k * 0.07
      const tt = t - t0
      if (tt < 0) return
      const e = Math.exp(-tt * 3.2)
      const v = (Math.sin(TAU * f * tt) + 0.35 * Math.sin(TAU * f * 2.76 * tt) * Math.exp(-tt * 6)) * e
      const p = k % 2 ? 0.5 : -0.5
      l += v * (1 - p) * 0.5
      r += v * (1 + p) * 0.5
    })
    return [l * 0.6, r * 0.6]
  })
}
// burn: film-projector crackle bed with a warm low rumble swelling in and out
{
  const lp = lowpass(), lp2 = lowpass()
  render('burn', 1.4, (t, _i, d) => {
    const u = t / d
    const env = Math.sin(Math.PI * u)
    const crackle = Math.abs(rnd()) > 0.985 ? rnd() * 1.4 : 0
    const hiss = lp(rnd(), 5000) * 0.18
    const rumble = lp2(rnd(), 160) * 1.6
    const v = (crackle + hiss + rumble) * env
    return [v, v * 0.92 + crackle * 0.1]
  })
}
