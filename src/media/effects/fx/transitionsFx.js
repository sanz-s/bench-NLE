/**
 * Advanced transitions, Canvas2D only (no WebGL). Each function gets eased progress p (0 → A,
 * 1 → B), the frame size in canvas px, and the two sides: draw them directly (with transform
 * mods) or render them into full-frame layers for masking / smearing / pixel tricks.
 */

import { acquire, applyMask, chroma, fbm, hash, proceduralMask, release, rgbSplit, sampleLuma, slices, smear, zoomBlur } from './util'

const bell = (p) => Math.sin(Math.PI * Math.min(1, Math.max(0, p)))
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const k = (H) => H / 1080

function drawLayer(ctx, l, alpha = 1, filter = 'none') {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.filter = filter
  ctx.drawImage(l.canvas, 0, 0)
  ctx.restore()
}

/** Composite of an effect into a temp layer, then onto ctx at alpha. */
function viaTemp(ctx, W, H, alpha, paint) {
  const tmp = acquire(Math.ceil(W), Math.ceil(H))
  paint(tmp.ctx)
  drawLayer(ctx, tmp, alpha)
  release(tmp)
}

const side = (S, p, at = 0.5, m) => (p < at ? S.layerA(m) : S.layerB(m))

export const FX_TRANSITIONS = {
  // ---------------------------------------------------------------- smooth & cinematic
  'smooth-zoom-in': (_c, p, W, _H, S) => {
    S.drawB({ alpha: p, scale: 0.82 + 0.18 * p, blur: (1 - p) * W * 0.008 })
    S.drawA({ alpha: 1 - p, scale: 1 + 0.5 * p, blur: p * W * 0.008 })
  },
  'smooth-zoom-out': (_c, p, W, _H, S) => {
    S.drawB({ alpha: p, scale: 1.3 - 0.3 * p, blur: (1 - p) * W * 0.008 })
    S.drawA({ alpha: 1 - p, scale: 1 - 0.3 * p, blur: p * W * 0.008 })
  },
  'cross-zoom': (ctx, p, W, H, S) => {
    const a = p < 0.5
    const q = a ? p * 2 : (1 - p) * 2
    const l = a ? S.layerA() : S.layerB()
    zoomBlur(ctx, l.canvas, q * 0.9, W / 2, H / 2, 12)
    ctx.save()
    ctx.globalAlpha = q ** 3 * 0.35
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
  },
  'whip-pan': (ctx, p, W, H, S) => {
    viaTemp(ctx, W, H, 1, (tc) => {
      const comb = acquire(Math.ceil(W), Math.ceil(H))
      comb.ctx.drawImage(S.layerA().canvas, -p * W, 0)
      comb.ctx.drawImage(S.layerB().canvas, (1 - p) * W, 0)
      smear(tc, comb.canvas, bell(p) * W * 0.45, 0, 14)
      release(comb)
    })
  },
  'motion-blur-swipe': (ctx, p, W, H, S) => {
    S.drawA()
    const lb = S.layerB()
    ctx.save()
    ctx.translate((1 - p) * W, 0)
    smear(ctx, lb.canvas, bell(p) * W * 0.3, 0, 12)
    ctx.restore()
    void H
  },
  'directional-blur': (ctx, p, W, H, S) => {
    const d = bell(p) * W * 0.09
    viaTemp(ctx, W, H, 1, (tc) => smear(tc, S.layerA().canvas, d, d * 0.15, 10))
    viaTemp(ctx, W, H, p, (tc) => smear(tc, S.layerB().canvas, d, d * 0.15, 10))
  },
  'camera-push': (_c, p, W, _H, S) => {
    S.drawB({ alpha: p, scale: 1.18 - 0.18 * p })
    S.drawA({ alpha: 1 - p * p, scale: 1 + 0.38 * p, blur: p * W * 0.006 })
  },
  'pull-back': (_c, p, W, _H, S) => {
    S.drawB({ alpha: p, scale: 0.86 + 0.14 * p })
    S.drawA({ alpha: 1 - p, scale: 1 - 0.28 * p, blur: p * W * 0.004 })
  },
  parallax: (ctx, p, W, H, S) => {
    S.drawA({ dx: -p * W * 0.35 })
    const x = (1 - p) * W
    S.drawB({ dx: x })
    const g = ctx.createLinearGradient(x - 60 * k(H), 0, x, 0)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0.45)')
    ctx.fillStyle = g
    ctx.fillRect(x - 60 * k(H), 0, 60 * k(H), H)
  },
  '3d-flip': (ctx, p, W, H, S) => {
    const first = p < 0.5
    const sx = Math.abs(Math.cos(p * Math.PI))
    const l = first ? S.layerA() : S.layerB()
    const sy = 1 - 0.1 * (1 - sx)
    const w = W * sx
    const h = H * sy
    ctx.drawImage(l.canvas, (W - w) / 2, (H - h) / 2, w, h)
    ctx.save()
    ctx.globalAlpha = (1 - sx) * 0.55
    ctx.fillStyle = '#000'
    ctx.fillRect((W - w) / 2, (H - h) / 2, w, h)
    ctx.restore()
  },
  spin: (ctx, p, W, H, S) => {
    const b = bell(p)
    const one = (l, ang, alpha) => {
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.filter = b > 0.05 ? `blur(${(b * W * 0.006).toFixed(1)}px)` : 'none'
      ctx.translate(W / 2, H / 2)
      ctx.rotate(ang)
      const s = 1 - 0.35 * b
      ctx.scale(s, s)
      ctx.drawImage(l.canvas, -W / 2, -H / 2)
      ctx.restore()
    }
    one(S.layerA(), p * Math.PI, 1 - p)
    one(S.layerB(), (p - 1) * Math.PI, p)
  },
  morph: (ctx, p, W, H, S) => {
    const b = bell(p)
    S.drawA({ scale: 1 + 0.07 * p, blur: b * W * 0.007 })
    S.drawB({ alpha: p, scale: 1.07 - 0.07 * p, blur: b * W * 0.007 })
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    ctx.globalAlpha = b * 0.12
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
  },
  'match-cut': (ctx, p, W, H, S) => {
    if (p < 0.5) S.drawA({ scale: 1 + 0.05 * p * 2 })
    else S.drawB({ scale: 1.05 - 0.05 * (p - 0.5) * 2 })
    const f = Math.max(0, 1 - Math.abs(p - 0.5) * 7)
    if (f > 0) {
      ctx.save()
      ctx.globalAlpha = f * 0.75
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, W, H)
      ctx.restore()
    }
  },
  'mask-reveal': (ctx, p, W, H, S) => {
    S.drawA()
    const r = p * (W + H) * 0.62
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(W / 2, H / 2 - r)
    ctx.lineTo(W / 2 + r, H / 2)
    ctx.lineTo(W / 2, H / 2 + r)
    ctx.lineTo(W / 2 - r, H / 2)
    ctx.closePath()
    ctx.clip()
    S.drawB()
    ctx.restore()
  },
  'luma-fade': (ctx, p, W, H, S) => {
    const la = S.layerA()
    const L = sampleLuma(la.canvas, 160, 90)
    const th = p * 1.3 - 0.15
    const mask = proceduralMask((u, v) => {
      const x = Math.min(159, Math.floor(u * 160))
      const y = Math.min(89, Math.floor(v * 90))
      const lum = L[(y * 160 + x) * 4 + 3]
      return lum < 0 ? p : smoothstep(lum - 0.12, lum + 0.02, th)
    })
    drawLayer(ctx, la)
    const lb = S.layerB()
    applyMask(lb, mask)
    drawLayer(ctx, lb)
    void W
    void H
  },

  // ---------------------------------------------------------------- glitch & trendy
  'rgb-split': (ctx, p, _W, H, S) => {
    const l = side(S, p)
    const b = bell(p)
    rgbSplit(ctx, l.canvas, b * 70 * k(H), b * 10 * k(H))
  },
  'glitch-shake': (ctx, p, W, H, S, t) => {
    const b = bell(p)
    const step = Math.floor(t * 30)
    const l = side(S, p)
    const tmp = acquire(Math.ceil(W), Math.ceil(H))
    slices(tmp.ctx, l.canvas, step, Math.round(4 + b * 14), W * 0.12 * b)
    ctx.save()
    ctx.translate((hash(step) - 0.5) * W * 0.05 * b, (hash(step + 0.7) - 0.5) * H * 0.04 * b)
    rgbSplit(ctx, tmp.canvas, b * 24 * k(H), 0)
    ctx.restore()
    release(tmp)
  },
  'digital-distortion': (ctx, p, W, H, S, t) => {
    const b = bell(p)
    const step = Math.floor(t * 24)
    const l = side(S, p)
    rgbSplit(ctx, l.canvas, b * 12 * k(H), 0)
    const n = Math.round(6 + b * 28)
    for (let i = 0; i < n; i++) {
      const w = (0.04 + hash(step + i * 3.1) * 0.22) * W
      const h = (0.02 + hash(step + i * 5.3) * 0.08) * H
      const x = hash(step * 1.7 + i) * (W - w)
      const y = hash(step * 2.3 + i * 0.7) * (H - h)
      const dx = (hash(step + i * 9.9) - 0.5) * W * 0.2 * b
      ctx.drawImage(l.canvas, x, y, w, h, x + dx, y, w, h)
    }
    ctx.save()
    ctx.globalCompositeOperation = 'difference'
    ctx.globalAlpha = b * 0.6
    for (let i = 0; i < Math.round(b * 6); i++) {
      ctx.fillStyle = ['#00ffff', '#ff00ff', '#ffff00'][i % 3]
      ctx.fillRect(hash(step + i * 4.4) * W, hash(step + i * 6.6) * H, W * 0.15, H * 0.01 + hash(i + step) * H * 0.03)
    }
    ctx.restore()
  },
  'pixel-sort': (ctx, p, W, H, S) => {
    const b = bell(p)
    const l = side(S, p, 0.55)
    drawLayer(ctx, l)
    const n = Math.round(30 + b * 120)
    for (let i = 0; i < n; i++) {
      const x = hash(i * 1.31) * W
      const w = (2 + hash(i * 2.7) * 14) * k(H)
      const y0 = hash(i * 3.9) * H * (1 - b * 0.6)
      const len = H * b * (0.25 + hash(i * 5.1) * 0.75)
      ctx.drawImage(l.canvas, x, y0, w, 2, x, y0, w, len)
    }
  },
  vhs: (ctx, p, W, H, S, t) => {
    const b = bell(p)
    const l = side(S, p)
    const out = acquire(Math.ceil(W), Math.ceil(H))
    rgbSplit(out.ctx, l.canvas, (4 + b * 16) * k(H), 0)
    const by = ((t * 0.9) % 1) * H
    const bh = H * (0.05 + 0.08 * b)
    out.ctx.drawImage(l.canvas, 0, by, W, bh, W * 0.04 * b, by, W, bh)
    drawLayer(ctx, out)
    release(out)
    ctx.save()
    ctx.globalAlpha = 0.15 + b * 0.35
    ctx.fillStyle = '#fff'
    for (let i = 0; i < 8; i++) ctx.fillRect(0, hash(Math.floor(t * 30) + i) * H, W, 1.5 * k(H))
    ctx.globalAlpha = 0.18
    ctx.fillStyle = '#000'
    for (let y = 0; y < H; y += 4 * k(H)) ctx.fillRect(0, y, W, 1.5 * k(H))
    ctx.restore()
  },
  datamosh: (ctx, p, W, H, S, t) => {
    S.drawB()
    const la = S.layerA()
    const cols = 16
    const rows = 9
    const bw = W / cols
    const bh = H / rows
    const step = Math.floor(t * 12)
    ctx.save()
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const h = hash(x * 7.1 + y * 13.3)
        if (h < p * 1.15) continue
        const flowX = (fbm(x * 0.4, y * 0.4, 3) - 0.5) * W * 0.25 * p + p * W * 0.06
        const flowY = (fbm(x * 0.4 + 9, y * 0.4, 5) - 0.5) * H * 0.15 * p
        ctx.globalAlpha = (1 - p) ** 0.6
        ctx.drawImage(la.canvas, x * bw, y * bh, bw, bh, x * bw + flowX + (hash(step + x) - 0.5) * 4, y * bh + flowY, bw * (1 + p * 0.6), bh)
      }
    }
    ctx.restore()
  },
  chromatic: (ctx, p, W, H, S) => {
    const b = bell(p)
    viaTemp(ctx, W, H, 1 - p, (tc) => chroma(tc, S.layerA().canvas, b * 0.06))
    viaTemp(ctx, W, H, p, (tc) => chroma(tc, S.layerB().canvas, b * 0.06))
  },
  'digital-scan': (ctx, p, W, H, S, t) => {
    S.drawA()
    const y = p * H
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, W, y)
    ctx.clip()
    S.drawB()
    ctx.restore()
    const g = ctx.createLinearGradient(0, y - 40 * k(H), 0, y + 6 * k(H))
    g.addColorStop(0, 'rgba(0,229,255,0)')
    g.addColorStop(0.85, 'rgba(0,229,255,0.55)')
    g.addColorStop(1, 'rgba(255,255,255,0.95)')
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = g
    ctx.fillRect(0, y - 40 * k(H), W, 46 * k(H))
    ctx.fillStyle = 'rgba(0,229,255,0.6)'
    const step = Math.floor(t * 30)
    for (let i = 0; i < 10; i++) ctx.fillRect(hash(step + i) * W, y - hash(i * 3 + step) * 30 * k(H), (10 + hash(i) * 80) * k(H), 3 * k(H))
    ctx.restore()
  },
  flash: (ctx, p, W, H, S) => {
    if (p < 0.5) S.drawA()
    else S.drawB()
    const f = (1 - Math.abs(p - 0.5) * 2) ** 1.5
    ctx.save()
    ctx.globalAlpha = f
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
  },
  strobe: (ctx, p, W, H, S) => {
    const step = Math.floor(p * 9)
    const useB = p > 0.8 || (step % 2 === 1 ? p > 0.25 : p > 0.6)
    if (useB) S.drawB()
    else S.drawA()
    if (step % 2 === 1 && p < 0.85) {
      ctx.save()
      ctx.globalAlpha = 0.55
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, W, H)
      ctx.restore()
    }
  },

  // ---------------------------------------------------------------- creative
  'liquid-wipe': (ctx, p, W, H, S, t) => {
    S.drawA()
    const amp = W * 0.06
    const edge = p * (W + amp * 2) - amp
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(0, 0)
    for (let y = 0; y <= H; y += H / 48)
      ctx.lineTo(edge + Math.sin((y / H) * Math.PI * 3 + t * 4) * amp * 0.6 + Math.sin((y / H) * Math.PI * 7 - t * 3) * amp * 0.25, y)
    ctx.lineTo(0, H)
    ctx.closePath()
    ctx.clip()
    S.drawB()
    ctx.restore()
  },
  'ink-drop': (ctx, p, W, H, S) => {
    const aspect = W / H
    const mask = proceduralMask((u, v) => {
      const d = Math.hypot((u - 0.5) * aspect, v - 0.5)
      const n = fbm(u * 5, (v * 5) / aspect, 3)
      return smoothstep(-0.04, 0.04, p * 1.25 - d - (n - 0.5) * 0.45)
    })
    S.drawA()
    const lb = S.layerB()
    applyMask(lb, mask)
    drawLayer(ctx, lb)
  },
  smoke: (ctx, p, W, H, S, t) => {
    const mask = proceduralMask((u, v) => {
      const n = fbm(u * 3 + t * 0.15, v * 3 - t * 0.25, 11, 5)
      return smoothstep(-0.12, 0.12, p * 1.4 - 0.2 - n + (1 - v) * 0.15)
    })
    S.drawA({ blur: bell(p) * W * 0.003 })
    const lb = S.layerB()
    applyMask(lb, mask)
    drawLayer(ctx, lb)
    void H
  },
  'light-leak': (ctx, p, W, H, S, t) => {
    S.drawA()
    S.drawB({ alpha: p })
    const b = bell(p)
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    const leaks = [
      [0.15 + p * 0.5, 0.3, 0.7, '255,120,40'],
      [0.85 - p * 0.4, 0.6, 0.55, '255,60,90'],
      [0.5 + Math.sin(t) * 0.1, 0.1, 0.5, '255,210,120'],
    ]
    for (const [x, y, r, c] of leaks) {
      const g = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * W)
      g.addColorStop(0, `rgba(${c},${b * 0.9})`)
      g.addColorStop(1, `rgba(${c},0)`)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
    }
    ctx.restore()
  },
  'film-burn': (ctx, p, W, H, S, t) => {
    if (p < 0.5) S.drawA()
    else S.drawB()
    const b = bell(p)
    const mask = proceduralMask((u, v) => smoothstep(0.62 - b * 0.45, 0.72 - b * 0.4, fbm(u * 2.5 + t * 0.2, v * 2.5, 21, 4)))
    const burn = acquire(Math.ceil(W), Math.ceil(H))
    const g = burn.ctx.createLinearGradient(0, H, W, 0)
    g.addColorStop(0, '#ff3d00')
    g.addColorStop(0.5, '#ffab40')
    g.addColorStop(1, '#fff3e0')
    burn.ctx.fillStyle = g
    burn.ctx.fillRect(0, 0, W, H)
    applyMask(burn, mask)
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    ctx.drawImage(burn.canvas, 0, 0)
    ctx.globalAlpha = Math.max(0, 1 - Math.abs(p - 0.5) * 5) * 0.8
    ctx.fillStyle = '#fff6e6'
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
    release(burn)
  },
  shatter: (ctx, p, W, H, S) => {
    S.drawB()
    const la = S.layerA()
    const cols = 7
    const rows = 4
    const cw = W / cols
    const ch = H / rows
    const q = p ** 1.4
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        for (let tri = 0; tri < 2; tri++) {
          const x0 = x * cw
          const y0 = y * ch
          const pts =
            tri === 0
              ? [
                  [x0, y0],
                  [x0 + cw, y0],
                  [x0, y0 + ch],
                ]
              : [
                  [x0 + cw, y0],
                  [x0 + cw, y0 + ch],
                  [x0, y0 + ch],
                ]
          const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3
          const cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3
          const seed = x * 31 + y * 17 + tri * 7
          const vx = (cx - W / 2) / W + (hash(seed) - 0.5) * 0.6
          const vy = (cy - H / 2) / H + (hash(seed + 1) - 0.5) * 0.6 + q * 0.8
          const rot = (hash(seed + 2) - 0.5) * 3 * q
          ctx.save()
          ctx.globalAlpha = 1 - q
          ctx.translate(cx + vx * q * W * 0.9, cy + vy * q * H * 0.9)
          ctx.rotate(rot)
          ctx.translate(-cx, -cy)
          ctx.beginPath()
          ctx.moveTo(pts[0][0], pts[0][1])
          ctx.lineTo(pts[1][0], pts[1][1])
          ctx.lineTo(pts[2][0], pts[2][1])
          ctx.closePath()
          ctx.clip()
          ctx.drawImage(la.canvas, 0, 0)
          ctx.restore()
        }
      }
    }
  },
  'paper-tear': (ctx, p, W, H, S) => {
    S.drawB()
    const la = S.layerA()
    const pts = []
    for (let i = 0; i <= 40; i++) {
      const y = (i / 40) * H
      pts.push([W * 0.5 + (hash(i * 3.3) - 0.5) * W * 0.05 + Math.sin(i * 0.7) * W * 0.02, y])
    }
    const q = p ** 1.3
    const piece = (left) => {
      ctx.save()
      ctx.translate((left ? -1 : 1) * q * W * 0.6, q * H * 0.06)
      ctx.rotate((left ? -1 : 1) * q * 0.07)
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 30 * k(H)
      ctx.beginPath()
      ctx.moveTo(left ? 0 : W, 0)
      for (const [x, y] of pts) ctx.lineTo(x, y)
      ctx.lineTo(left ? 0 : W, H)
      ctx.closePath()
      ctx.fillStyle = '#f4efe6'
      ctx.fill()
      ctx.shadowColor = 'transparent'
      ctx.clip()
      ctx.drawImage(la.canvas, (left ? -1 : 1) * 4 * k(H), 0)
      ctx.restore()
    }
    piece(true)
    piece(false)
  },
  'gradient-wipe': (ctx, p, W, _H, S) => {
    S.drawA()
    const lb = S.layerB()
    const soft = 0.3
    const pos = p * (1 + soft) - soft
    const g = lb.ctx.createLinearGradient(0, 0, W, 0)
    g.addColorStop(0, 'rgba(0,0,0,1)')
    g.addColorStop(clamp01(pos), 'rgba(0,0,0,1)')
    g.addColorStop(clamp01(pos + soft), 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    lb.ctx.save()
    lb.ctx.globalCompositeOperation = 'destination-in'
    lb.ctx.fillStyle = g
    lb.ctx.fillRect(0, 0, lb.canvas.width, lb.canvas.height)
    lb.ctx.restore()
    drawLayer(ctx, lb)
  },
  mosaic: (ctx, p, W, H, S) => {
    const b = bell(p)
    const l = side(S, p)
    const size = 1 + b * 70 * k(H)
    const cols = Math.max(1, Math.round(W / size))
    const rows = Math.max(1, Math.round(H / size))
    const small = acquire(cols, rows)
    small.ctx.drawImage(l.canvas, 0, 0, cols, rows)
    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(small.canvas, 0, 0, W, H)
    ctx.restore()
    release(small)
  },
}
