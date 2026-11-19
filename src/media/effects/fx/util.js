/**
 * Canvas2D building blocks for effects and transitions (no WebGL). Everything here runs on the
 * main thread and in the export worker (OffscreenCanvas), and is deterministic for a given time
 * so exports are reproducible.
 */

// ------------------------------------------------------------------ layer pool

const free = new Map()
let outstanding = 0

/** Pool diagnostics (test hook): layers currently borrowed and not yet released. */
export function poolStats() {
  return { outstanding }
}

/** Borrow a cleared W×H layer. Always `release()` it in the same frame. */
export function acquire(w, h) {
  outstanding++
  const W = Math.max(1, Math.round(w))
  const H = Math.max(1, Math.round(h))
  const key = `${W}x${H}`
  const list = free.get(key)
  const l = list?.pop()
  if (l) {
    l.ctx.setTransform(1, 0, 0, 1, 0, 0)
    l.ctx.globalAlpha = 1
    l.ctx.globalCompositeOperation = 'source-over'
    l.ctx.filter = 'none'
    l.ctx.clearRect(0, 0, W, H)
    return l
  }
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')
  return { canvas, ctx }
}

export function release(...layers) {
  for (const l of layers) {
    if (!l) continue
    outstanding--
    const key = `${l.canvas.width}x${l.canvas.height}`
    const list = free.get(key) ?? []
    if (list.length < 12) list.push(l)
    free.set(key, list)
  }
}

/** Copy a source into a fresh layer (optionally through a CSS filter). */
export function copyOf(src, filter = 'none') {
  const l = acquire(src.width, src.height)
  l.ctx.filter = filter
  l.ctx.drawImage(src, 0, 0)
  l.ctx.filter = 'none'
  return l
}

// ------------------------------------------------------------------ deterministic noise

export function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}
export const hash2 = (x, y) => hash(x * 57.0 + y * 131.0)

function smooth(t) {
  return t * t * (3 - 2 * t)
}

/** 2D value noise in [0,1]. */
export function vnoise(x, y, seed = 0) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const a = hash2(xi + seed, yi)
  const b = hash2(xi + 1 + seed, yi)
  const c = hash2(xi + seed, yi + 1)
  const d = hash2(xi + 1 + seed, yi + 1)
  const u = smooth(xf)
  const v = smooth(yf)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

export function fbm(x, y, seed = 0, octaves = 4) {
  let sum = 0
  let amp = 0.5
  let f = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += vnoise(x * f, y * f, seed + i * 17) * amp
    norm += amp
    amp *= 0.5
    f *= 2
  }
  return sum / norm
}

/** Smooth 1D noise in [-1, 1] (sum of incommensurate sines), for shakes. */
export function wobble(t, seed) {
  return Math.sin(t * 1.7 + seed) * 0.5 + Math.sin(t * 3.1 + seed * 2.3) * 0.3 + Math.sin(t * 5.3 + seed * 4.1) * 0.2
}

// ------------------------------------------------------------------ masks

const MASK_W = 160
const MASK_H = 90
let maskLayer = null

/**
 * Build a low-res alpha mask from `fn(u, v) → 0..1` (u,v in 0..1) and return it as a layer that
 * can be drawn scaled up (smoothed) over W×H. Cheap: 14 400 samples.
 */
export function proceduralMask(fn) {
  if (!maskLayer) {
    const canvas = new OffscreenCanvas(MASK_W, MASK_H)
    maskLayer = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) }
  }
  const img = maskLayer.ctx.createImageData(MASK_W, MASK_H)
  for (let y = 0; y < MASK_H; y++) {
    for (let x = 0; x < MASK_W; x++) {
      const a = Math.max(0, Math.min(1, fn((x + 0.5) / MASK_W, (y + 0.5) / MASK_H)))
      const i = (y * MASK_W + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = a * 255
    }
  }
  maskLayer.ctx.putImageData(img, 0, 0)
  return maskLayer.canvas
}

/** Keep only the parts of `target` where `mask` is opaque (mask drawn stretched to the layer). */
export function applyMask(target, mask) {
  const { ctx, canvas } = target
  ctx.save()
  ctx.globalCompositeOperation = 'destination-in'
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(mask, 0, 0, canvas.width, canvas.height)
  ctx.restore()
}

/** Restrict `target` to the alpha of `src` (undo blend modes painting into transparent areas). */
export function clipToAlphaOf(target, src) {
  target.ctx.save()
  target.ctx.globalCompositeOperation = 'destination-in'
  target.ctx.drawImage(src, 0, 0)
  target.ctx.restore()
}

let lumaLayer = null
/** Luminance of `src` sampled at low res → callback per cell (u, v, luma 0..1). */
export function sampleLuma(src, cols, rows) {
  if (!lumaLayer || lumaLayer.canvas.width !== cols || lumaLayer.canvas.height !== rows) {
    const canvas = new OffscreenCanvas(cols, rows)
    lumaLayer = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) }
  }
  lumaLayer.ctx.clearRect(0, 0, cols, rows)
  lumaLayer.ctx.drawImage(src, 0, 0, cols, rows)
  const d = lumaLayer.ctx.getImageData(0, 0, cols, rows).data
  const out = new Float32Array(cols * rows * 4) // r,g,b,luma (0..1), alpha folded into luma
  for (let i = 0, j = 0; i < d.length; i += 4, j += 4) {
    const a = d[i + 3] / 255
    out[j] = d[i] / 255
    out[j + 1] = d[i + 1] / 255
    out[j + 2] = d[i + 2] / 255
    out[j + 3] = a > 0 ? (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255 : -1
  }
  return out
}

// ------------------------------------------------------------------ image operations

/** Average of `n` copies shifted along (dx, dy): directional / motion blur. */
export function smear(dst, src, dx, dy, n = 8) {
  if (Math.hypot(dx, dy) < 0.5) {
    dst.drawImage(src, 0, 0)
    return
  }
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0 : i / (n - 1) - 0.5
    dst.globalAlpha = 1 / (i + 1)
    dst.drawImage(src, dx * k, dy * k)
  }
  dst.globalAlpha = 1
}

/** Average of `n` copies scaled around (cx, cy): zoom blur. */
export function zoomBlur(dst, src, amount, cx, cy, n = 8) {
  if (amount < 0.002) {
    dst.drawImage(src, 0, 0)
    return
  }
  for (let i = 0; i < n; i++) {
    const s = 1 + amount * (i / (n - 1))
    dst.globalAlpha = 1 / (i + 1)
    dst.drawImage(src, cx - cx * s, cy - cy * s, src.width * s, src.height * s)
  }
  dst.globalAlpha = 1
}

/** One colour channel of `src` (r, g or b) as its own layer. */
export function channel(src, which) {
  const l = copyOf(src)
  l.ctx.globalCompositeOperation = 'multiply'
  l.ctx.fillStyle = which === 'r' ? '#ff0000' : which === 'g' ? '#00ff00' : '#0000ff'
  l.ctx.fillRect(0, 0, l.canvas.width, l.canvas.height)
  l.ctx.globalCompositeOperation = 'source-over'
  clipToAlphaOf(l, src)
  return l
}

/** RGB split: red and blue channels offset in opposite directions (additive recombine). */
export function rgbSplit(dst, src, ox, oy) {
  if (Math.hypot(ox, oy) < 0.5) {
    dst.drawImage(src, 0, 0)
    return
  }
  const r = channel(src, 'r')
  const g = channel(src, 'g')
  const b = channel(src, 'b')
  const prev = dst.globalCompositeOperation
  dst.globalCompositeOperation = 'lighter'
  dst.drawImage(r.canvas, ox, oy)
  dst.drawImage(g.canvas, 0, 0)
  dst.drawImage(b.canvas, -ox, -oy)
  dst.globalCompositeOperation = prev
  release(r, g, b)
}

/** Radial chromatic aberration: red scaled up, blue scaled down around the centre. */
export function chroma(dst, src, amount) {
  const W = src.width
  const H = src.height
  const r = channel(src, 'r')
  const g = channel(src, 'g')
  const b = channel(src, 'b')
  const prev = dst.globalCompositeOperation
  dst.globalCompositeOperation = 'lighter'
  const draw = (l, s) => dst.drawImage(l.canvas, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s)
  draw(r, 1 + amount)
  draw(g, 1)
  draw(b, 1 - amount)
  dst.globalCompositeOperation = prev
  release(r, g, b)
}

/** Glitch slices: horizontal bands displaced sideways (seeded per `step`). */
export function slices(dst, src, step, count, maxShift) {
  const W = src.width
  const H = src.height
  dst.drawImage(src, 0, 0)
  for (let i = 0; i < count; i++) {
    const r = hash(step * 13.1 + i * 7.7)
    const y = Math.floor(hash(step * 3.3 + i * 1.9) * H)
    const h = Math.max(2, Math.floor((0.01 + r * 0.08) * H))
    const shift = (hash(step * 5.7 + i * 2.1) - 0.5) * 2 * maxShift
    dst.clearRect(0, y, W, h)
    dst.drawImage(src, 0, y, W, h, shift, y, W, h)
  }
}

/** Fill a blend-mode tint over `target`, keeping its alpha. */
export function tint(target, color, op, alpha) {
  if (alpha <= 0) return
  const { ctx, canvas } = target
  const keep = copyOf(canvas)
  ctx.save()
  ctx.globalCompositeOperation = op
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.restore()
  clipToAlphaOf(target, keep.canvas)
  release(keep)
}

let grain = null
export function grainTile() {
  if (grain) return grain
  grain = new OffscreenCanvas(256, 256)
  const g = grain.getContext('2d')
  const img = g.createImageData(256, 256)
  let seed = 9876543
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const v = seed & 255
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const c = seed & 255
    img.data[i] = v
    img.data[i + 1] = (v + c) >> 1
    img.data[i + 2] = c
    img.data[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return grain
}

/** Overlay animated noise on `target` (restricted to its alpha). */
export function noise(target, amount, t, color, op = 'overlay') {
  if (amount <= 0) return
  const { ctx, canvas } = target
  const keep = copyOf(canvas)
  const tile = grainTile()
  const step = Math.floor(t * 24)
  ctx.save()
  ctx.globalCompositeOperation = op
  ctx.globalAlpha = Math.min(1, amount)
  if (!color) ctx.filter = 'grayscale(1)'
  const pat = ctx.createPattern(tile, 'repeat')
  const ox = Math.floor(hash(step) * 256)
  const oy = Math.floor(hash(step + 0.5) * 256)
  ctx.translate(-ox, -oy)
  ctx.fillStyle = pat
  ctx.fillRect(ox, oy, canvas.width, canvas.height)
  ctx.restore()
  clipToAlphaOf(target, keep.canvas)
  release(keep)
}
