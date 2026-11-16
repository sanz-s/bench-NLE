import { acquire, chroma, clipToAlphaOf, copyOf, hash, noise, release, rgbSplit, sampleLuma, slices, smear, tint, wobble } from './util'

const num = (p, k) => Number(p[k])
const str = (p, k) => String(p[k])
const N = (key, label, min, max, def, unit, step) => ({ key, label, type: 'number', min, max, def, unit, step })
const C = (key, label, def) => ({ key, label, type: 'color', def })
const S = (key, label, options, def) => ({ key, label, type: 'select', options: options.map(([id, l]) => ({ id, label: l })), def })

const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2)
const elasticOut = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1)

function drawSrc(dst, src, filter = 'none') {
  dst.ctx.filter = filter
  dst.ctx.drawImage(src.canvas, 0, 0)
  dst.ctx.filter = 'none'
}

/** Paint on top of `dst` only where it already has pixels. */
function atop(dst, paint, op = 'source-atop', alpha = 1) {
  dst.ctx.save()
  dst.ctx.globalCompositeOperation = op
  dst.ctx.globalAlpha = alpha
  paint(dst.ctx)
  dst.ctx.restore()
}

export const EFFECTS = [
  // ---------------------------------------------------------------- cinematic
  {
    id: 'color-grade',
    label: 'Color Grading',
    cat: 'cinematic',
    params: [
      C('shadows', 'Shadows', '#1d6f8c'),
      C('highlights', 'Highlights', '#ffb36b'),
      N('amount', 'Amount', 0, 100, 55, '%'),
      N('contrast', 'Contrast', -50, 80, 15),
      N('saturation', 'Saturation', -100, 100, -5),
    ],
    process: (src, dst, p) => {
      drawSrc(dst, src, `contrast(${1 + num(p, 'contrast') / 100}) saturate(${1 + num(p, 'saturation') / 100})`)
      const a = num(p, 'amount') / 100
      tint(dst, str(p, 'shadows'), 'soft-light', a * 0.75)
      tint(dst, str(p, 'highlights'), 'soft-light', a * 0.45)
    },
  },
  {
    id: 'film-grain',
    label: 'Film Grain',
    cat: 'cinematic',
    params: [
      N('amount', 'Amount', 0, 100, 40, '%'),
      S(
        'mode',
        'Grain',
        [
          ['mono', 'Mono'],
          ['color', 'Color'],
        ],
        'mono',
      ),
    ],
    process: (src, dst, p, e) => {
      drawSrc(dst, src)
      noise(dst, (num(p, 'amount') / 100) * 0.55, e.t, str(p, 'mode') === 'color')
    },
  },
  {
    id: 'vignette',
    label: 'Vignette',
    cat: 'cinematic',
    params: [N('amount', 'Amount', 0, 100, 55, '%'), N('size', 'Size', 0, 100, 45, '%'), C('color', 'Color', '#000000')],
    process: (src, dst, p, e) => {
      drawSrc(dst, src)
      const r = Math.hypot(e.W, e.H) / 2
      const inner = r * (0.15 + 0.6 * (num(p, 'size') / 100))
      const g = dst.ctx.createRadialGradient(e.W / 2, e.H / 2, inner, e.W / 2, e.H / 2, r)
      const c = str(p, 'color')
      g.addColorStop(0, `${c}00`)
      g.addColorStop(1, c)
      atop(
        dst,
        (ctx) => {
          ctx.fillStyle = g
          ctx.fillRect(0, 0, e.W, e.H)
        },
        'source-atop',
        Math.min(1, (num(p, 'amount') / 100) * 0.95),
      )
    },
  },
  {
    id: 'bloom',
    label: 'Bloom',
    cat: 'cinematic',
    params: [N('intensity', 'Intensity', 0, 100, 60, '%'), N('radius', 'Radius', 2, 80, 28, 'px'), N('threshold', 'Threshold', 0, 100, 55, '%')],
    process: (src, dst, p, e) => {
      drawSrc(dst, src)
      const th = num(p, 'threshold') / 100
      const glow = copyOf(src.canvas, `brightness(${1.1 - th * 0.5}) contrast(${1 + th * 4}) saturate(1.2) blur(${num(p, 'radius') * e.k}px)`)
      atop(dst, (ctx) => ctx.drawImage(glow.canvas, 0, 0), 'screen', num(p, 'intensity') / 100)
      release(glow)
    },
  },
  {
    id: 'lens-flare',
    label: 'Lens Flare',
    cat: 'cinematic',
    params: [
      N('x', 'Position X', 0, 100, 72, '%'),
      N('y', 'Position Y', 0, 100, 22, '%'),
      N('intensity', 'Intensity', 0, 100, 75, '%'),
      C('color', 'Color', '#ffcf8a'),
    ],
    process: (src, dst, p, e) => {
      drawSrc(dst, src)
      const x = (num(p, 'x') / 100) * e.W
      const y = (num(p, 'y') / 100) * e.H
      const a = (num(p, 'intensity') / 100) * (0.92 + 0.08 * Math.sin(e.t * 7))
      const c = str(p, 'color')
      atop(
        dst,
        (ctx) => {
          const orb = ctx.createRadialGradient(x, y, 0, x, y, e.H * 0.45)
          orb.addColorStop(0, `rgba(255,255,255,${a})`)
          orb.addColorStop(0.08, `${c}cc`)
          orb.addColorStop(0.35, `${c}33`)
          orb.addColorStop(1, `${c}00`)
          ctx.fillStyle = orb
          ctx.fillRect(0, 0, e.W, e.H)
          // horizontal streak
          ctx.save()
          ctx.translate(x, y)
          ctx.scale(1, 0.018)
          const st = ctx.createRadialGradient(0, 0, 0, 0, 0, e.W * 0.6)
          st.addColorStop(0, `rgba(255,255,255,${a * 0.9})`)
          st.addColorStop(1, 'rgba(255,255,255,0)')
          ctx.fillStyle = st
          ctx.beginPath()
          ctx.arc(0, 0, e.W * 0.6, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
          // ghosts along the line through the centre
          const cx = e.W / 2
          const cy = e.H / 2
          const ghosts = [
            [0.5, 0.05, '#9fd3ff'],
            [1.25, 0.03, '#ffd27f'],
            [1.6, 0.08, '#b9a6ff'],
            [2.1, 0.045, '#8affc2'],
          ]
          for (const [f, rr, gc] of ghosts) {
            const gx = x + (cx - x) * f
            const gy = y + (cy - y) * f
            const R = e.H * rr * 2
            const g = ctx.createRadialGradient(gx, gy, R * 0.5, gx, gy, R)
            g.addColorStop(0, `${gc}00`)
            g.addColorStop(
              0.85,
              `${gc}${Math.round(a * 90)
                .toString(16)
                .padStart(2, '0')}`,
            )
            g.addColorStop(1, `${gc}00`)
            ctx.fillStyle = g
            ctx.beginPath()
            ctx.arc(gx, gy, R, 0, Math.PI * 2)
            ctx.fill()
          }
        },
        'screen',
      )
    },
  },
  {
    id: 'soft-glow',
    label: 'Soft Glow',
    cat: 'cinematic',
    params: [N('amount', 'Amount', 0, 100, 50, '%'), N('radius', 'Radius', 2, 60, 18, 'px')],
    process: (src, dst, p, e) => {
      drawSrc(dst, src)
      const glow = copyOf(src.canvas, `blur(${num(p, 'radius') * e.k}px) brightness(1.15)`)
      atop(dst, (ctx) => ctx.drawImage(glow.canvas, 0, 0), 'screen', (num(p, 'amount') / 100) * 0.75)
      release(glow)
    },
  },
  {
    id: 'anamorphic',
    label: 'Anamorphic Lens',
    cat: 'cinematic',
    params: [
      N('streak', 'Streaks', 0, 100, 65, '%'),
      N('length', 'Streak length', 0, 100, 60, '%'),
      C('tint', 'Streak tint', '#5aa9ff'),
      S(
        'bars',
        'Bars',
        [
          ['on', '2.39:1 bars'],
          ['off', 'Off'],
        ],
        'on',
      ),
    ],
    process: (src, dst, p, e) => {
      drawSrc(dst, src)
      // highlights squeezed horizontally then stretched back → long horizontal streaks
      const cols = Math.max(2, Math.round(e.W / (8 + num(p, 'length') * 0.6)))
      const small = acquire(cols, e.H)
      small.ctx.filter = 'brightness(0.9) contrast(4) saturate(0)'
      small.ctx.drawImage(src.canvas, 0, 0, cols, e.H)
      const streak = acquire(e.W, e.H)
      streak.ctx.imageSmoothingQuality = 'high'
      streak.ctx.filter = `blur(${2 * e.k}px)`
      streak.ctx.drawImage(small.canvas, 0, 0, e.W, e.H)
      streak.ctx.filter = 'none'
      streak.ctx.globalCompositeOperation = 'multiply'
      streak.ctx.fillStyle = str(p, 'tint')
      streak.ctx.fillRect(0, 0, e.W, e.H)
      atop(dst, (ctx) => ctx.drawImage(streak.canvas, 0, 0), 'screen', num(p, 'streak') / 100)
      release(small, streak)
      if (str(p, 'bars') === 'on') {
        const bar = Math.max(0, (e.H - e.W / 2.39) / 2)
        dst.ctx.fillStyle = '#000'
        dst.ctx.fillRect(0, 0, e.W, bar)
        dst.ctx.fillRect(0, e.H - bar, e.W, bar)
      }
    },
  },
  {
    id: 'depth-of-field',
    label: 'Depth of Field',
    cat: 'cinematic',
    params: [
      N('focus', 'Focus position', 0, 100, 55, '%'),
      N('range', 'Sharp area', 2, 80, 22, '%'),
      N('blur', 'Blur', 1, 40, 12, 'px'),
      S(
        'dir',
        'Direction',
        [
          ['h', 'Horizontal band'],
          ['v', 'Vertical band'],
        ],
        'h',
      ),
    ],
    process: (src, dst, p, e) => {
      drawSrc(dst, src)
      const blurred = copyOf(src.canvas, `blur(${num(p, 'blur') * e.k}px)`)
      const vertical = str(p, 'dir') === 'v'
      const len = vertical ? e.W : e.H
      const f = num(p, 'focus') / 100
      const r = num(p, 'range') / 200
      const g = vertical ? blurred.ctx.createLinearGradient(0, 0, len, 0) : blurred.ctx.createLinearGradient(0, 0, 0, len)
      const stop = (v) => Math.min(1, Math.max(0, v))
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(stop(f - r * 2), 'rgba(0,0,0,0)')
      g.addColorStop(stop(f - r), 'rgba(0,0,0,1)')
      g.addColorStop(stop(f + r), 'rgba(0,0,0,1)')
      g.addColorStop(stop(f + r * 2), 'rgba(0,0,0,0)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      blurred.ctx.globalCompositeOperation = 'destination-out'
      blurred.ctx.fillStyle = g
      blurred.ctx.fillRect(0, 0, e.W, e.H)
      dst.ctx.drawImage(blurred.canvas, 0, 0)
      release(blurred)
    },
  },
  {
    id: 'motion-blur',
    label: 'Motion Blur',
    cat: 'cinematic',
    params: [N('amount', 'Amount', 0, 100, 35, '%'), N('angle', 'Angle', -180, 180, 0, '°')],
    process: (src, dst, p, e) => {
      const len = (num(p, 'amount') / 100) * e.W * 0.06
      const a = (num(p, 'angle') * Math.PI) / 180
      smear(dst.ctx, src.canvas, Math.cos(a) * len, Math.sin(a) * len, 10)
    },
  },
  {
    id: 'cinematic-bars',
    label: 'Cinematic Bars',
    cat: 'cinematic',
    params: [
      S(
        'ratio',
        'Aspect',
        [
          ['2.39', '2.39 : 1 (scope)'],
          ['2', '2 : 1'],
          ['1.85', '1.85 : 1'],
          ['1.33', '4 : 3 pillar'],
        ],
        '2.39',
      ),
      C('color', 'Color', '#000000'),
    ],
    process: (src, dst, p, e) => {
      drawSrc(dst, src)
      const ratio = Number(str(p, 'ratio'))
      dst.ctx.fillStyle = str(p, 'color')
      if (e.W / e.H < ratio) {
        const bar = Math.max(0, (e.H - e.W / ratio) / 2)
        dst.ctx.fillRect(0, 0, e.W, bar)
        dst.ctx.fillRect(0, e.H - bar, e.W, bar)
      } else {
        const bar = Math.max(0, (e.W - e.H * ratio) / 2)
        dst.ctx.fillRect(0, 0, bar, e.H)
        dst.ctx.fillRect(e.W - bar, 0, bar, e.H)
      }
    },
  },

  // ---------------------------------------------------------------- motion
  {
    id: 'ken-burns',
    label: 'Ken Burns',
    cat: 'motion',
    params: [
      N('from', 'Start zoom', 50, 300, 100, '%'),
      N('to', 'End zoom', 50, 300, 125, '%'),
      N('panX', 'Pan X', -50, 50, 6, '%'),
      N('panY', 'Pan Y', -50, 50, -4, '%'),
    ],
    motion: (p, local, dur, W, H) => {
      const q = easeInOut(Math.min(1, Math.max(0, local / Math.max(0.01, dur))))
      const z = (num(p, 'from') + (num(p, 'to') - num(p, 'from')) * q) / 100
      return { scale: z, dx: (num(p, 'panX') / 100) * W * q, dy: (num(p, 'panY') / 100) * H * q }
    },
  },
  {
    id: 'camera-shake',
    label: 'Camera Shake',
    cat: 'motion',
    params: [N('amount', 'Amount', 0, 100, 35, '%'), N('speed', 'Speed', 1, 100, 60, '%')],
    motion: (p, local, _d, W) => {
      const a = num(p, 'amount') / 100
      const s = local * (2 + num(p, 'speed') * 0.25)
      return { dx: wobble(s, 1.3) * W * 0.018 * a, dy: wobble(s, 7.9) * W * 0.012 * a, rotate: wobble(s, 3.7) * 1.2 * a, scale: 1 + 0.05 * a }
    },
  },
  {
    id: 'handheld',
    label: 'Handheld Camera',
    cat: 'motion',
    params: [N('amount', 'Amount', 0, 100, 45, '%')],
    motion: (p, local, _d, W) => {
      const a = num(p, 'amount') / 100
      const s = local * 0.9
      return { dx: wobble(s, 11.1) * W * 0.012 * a, dy: wobble(s * 1.3, 4.4) * W * 0.009 * a, rotate: wobble(s * 0.7, 9.2) * 1.6 * a, scale: 1 + 0.045 * a }
    },
  },
  {
    id: 'bounce',
    label: 'Bounce',
    cat: 'motion',
    params: [N('height', 'Height', 0, 100, 40, '%'), N('speed', 'Speed', 5, 100, 45, '%')],
    motion: (p, local, _d, _W, H) => {
      const ph = local * (0.5 + num(p, 'speed') / 25) * Math.PI
      const up = Math.abs(Math.sin(ph))
      return { dy: -up * H * 0.08 * (num(p, 'height') / 100), scale: 1 + (1 - up) ** 8 * 0.04 * (num(p, 'height') / 100) }
    },
  },
  {
    id: 'elastic-scale',
    label: 'Elastic Scale',
    cat: 'motion',
    params: [N('amount', 'Wobble', 0, 100, 40, '%'), N('intro', 'Intro length', 0.1, 3, 0.9, 's', 0.1)],
    motion: (p, local) => {
      const intro = elasticOut(Math.min(1, local / Math.max(0.05, num(p, 'intro'))))
      const breathe = 1 + Math.sin(local * 4) * 0.012 * (num(p, 'amount') / 100)
      return { scale: Math.max(0.001, intro) * breathe }
    },
  },
  {
    id: 'wave',
    label: 'Wave Distortion',
    cat: 'motion',
    params: [
      N('amplitude', 'Amplitude', 0, 100, 25, 'px'),
      N('frequency', 'Waves', 1, 20, 4),
      N('speed', 'Speed', 0, 100, 40, '%'),
      S(
        'dir',
        'Direction',
        [
          ['h', 'Horizontal'],
          ['v', 'Vertical'],
        ],
        'h',
      ),
    ],
    process: (src, dst, p, e) => {
      const amp = num(p, 'amplitude') * e.k
      const freq = num(p, 'frequency')
      const ph = e.t * num(p, 'speed') * 0.12
      const strip = Math.max(2, Math.round(3 * e.k))
      if (str(p, 'dir') === 'h') {
        for (let y = 0; y < e.H; y += strip) {
          const off = Math.sin((y / e.H) * freq * Math.PI * 2 + ph) * amp
          dst.ctx.drawImage(src.canvas, 0, y, e.W, strip, off, y, e.W, strip)
        }
      } else {
        for (let x = 0; x < e.W; x += strip) {
          const off = Math.sin((x / e.W) * freq * Math.PI * 2 + ph) * amp
          dst.ctx.drawImage(src.canvas, x, 0, strip, e.H, x, off, strip, e.H)
        }
      }
    },
  },
  {
    id: 'trail',
    label: 'Motion Trail',
    cat: 'motion',
    params: [N('count', 'Ghosts', 1, 12, 5), N('spacing', 'Spacing', 10, 300, 60, 'ms'), N('fade', 'Fade', 10, 95, 55, '%')],
    trail: true,
  },

  // ---------------------------------------------------------------- social / modern
  {
    id: 'rgb-split',
    label: 'RGB Split',
    cat: 'social',
    params: [
      N('amount', 'Amount', 0, 80, 14, 'px'),
      N('angle', 'Angle', -180, 180, 0, '°'),
      S(
        'anim',
        'Animate',
        [
          ['static', 'Static'],
          ['pulse', 'Pulse'],
          ['jitter', 'Jitter'],
        ],
        'static',
      ),
    ],
    process: (src, dst, p, e) => {
      let amt = num(p, 'amount') * e.k
      const mode = str(p, 'anim')
      if (mode === 'pulse') amt *= 0.5 + 0.5 * Math.sin(e.t * 6)
      if (mode === 'jitter') amt *= hash(Math.floor(e.t * 15)) * 1.5
      const a = (num(p, 'angle') * Math.PI) / 180
      rgbSplit(dst.ctx, src.canvas, Math.cos(a) * amt, Math.sin(a) * amt)
    },
  },
  {
    id: 'glitch',
    label: 'Glitch',
    cat: 'social',
    params: [N('amount', 'Amount', 0, 100, 55, '%'), N('speed', 'Speed', 1, 100, 55, '%')],
    process: (src, dst, p, e) => {
      const a = num(p, 'amount') / 100
      const step = Math.floor(e.t * (2 + num(p, 'speed') * 0.25))
      const active = hash(step * 1.37) < 0.25 + a * 0.6
      if (!active) return drawSrc(dst, src)
      const tmp = acquire(e.W, e.H)
      slices(tmp.ctx, src.canvas, step, Math.round(3 + a * 12), e.W * 0.08 * a)
      rgbSplit(dst.ctx, tmp.canvas, (hash(step + 0.3) - 0.5) * 30 * a * e.k, 0)
      // a few blocky colour bursts
      const n = Math.round(a * 6)
      atop(
        dst,
        (ctx) => {
          for (let i = 0; i < n; i++) {
            const x = hash(step * 2.1 + i) * e.W
            const y = hash(step * 3.7 + i) * e.H
            const w = (0.03 + hash(step + i * 9.1) * 0.15) * e.W
            const h = (0.005 + hash(step + i * 4.3) * 0.03) * e.H
            ctx.fillStyle = ['#ff00e6', '#00f0ff', '#ffffff', '#00ff66'][i % 4]
            ctx.fillRect(x, y, w, h)
          }
        },
        'source-atop',
        0.55,
      )
      release(tmp)
    },
  },
  {
    id: 'pixelate',
    label: 'Pixelate',
    cat: 'social',
    params: [N('size', 'Pixel size', 2, 120, 18, 'px')],
    process: (src, dst, p, e) => {
      const s = Math.max(1, num(p, 'size') * e.k)
      const cols = Math.max(1, Math.round(e.W / s))
      const rows = Math.max(1, Math.round(e.H / s))
      const small = acquire(cols, rows)
      small.ctx.imageSmoothingQuality = 'medium'
      small.ctx.drawImage(src.canvas, 0, 0, cols, rows)
      dst.ctx.imageSmoothingEnabled = false
      dst.ctx.drawImage(small.canvas, 0, 0, e.W, e.H)
      dst.ctx.imageSmoothingEnabled = true
      release(small)
    },
  },
  {
    id: 'duotone',
    label: 'Duotone',
    cat: 'social',
    params: [C('dark', 'Shadows', '#1b1464'), C('light', 'Highlights', '#ff7ab6'), N('contrast', 'Contrast', -50, 100, 15)],
    process: (src, dst, p) => {
      drawSrc(dst, src, `grayscale(1) contrast(${1 + num(p, 'contrast') / 100})`)
      tint(dst, str(p, 'light'), 'multiply', 1)
      tint(dst, str(p, 'dark'), 'screen', 1)
    },
  },
  {
    id: 'invert',
    label: 'Color Invert',
    cat: 'social',
    params: [N('amount', 'Amount', 0, 100, 100, '%')],
    process: (src, dst, p) => drawSrc(dst, src, `invert(${num(p, 'amount') / 100})`),
  },
  {
    id: 'scanlines',
    label: 'Scanlines',
    cat: 'social',
    params: [N('spacing', 'Spacing', 2, 20, 4, 'px'), N('opacity', 'Opacity', 0, 100, 30, '%'), N('speed', 'Roll speed', 0, 100, 15, '%')],
    process: (src, dst, p, e) => {
      drawSrc(dst, src)
      const sp = Math.max(2, num(p, 'spacing') * e.k)
      const off = (e.t * num(p, 'speed') * 2 * e.k) % sp
      atop(
        dst,
        (ctx) => {
          ctx.fillStyle = '#000'
          for (let y = -sp + off; y < e.H; y += sp) ctx.fillRect(0, y, e.W, sp / 2)
        },
        'source-atop',
        num(p, 'opacity') / 100,
      )
    },
  },
  {
    id: 'halftone',
    label: 'Halftone',
    cat: 'social',
    params: [
      N('size', 'Dot size', 4, 60, 12, 'px'),
      S(
        'mode',
        'Style',
        [
          ['mono', 'Newsprint'],
          ['color', 'Color dots'],
        ],
        'mono',
      ),
      C('paper', 'Paper', '#f3eee2'),
    ],
    process: (src, dst, p, e) => {
      const s = Math.max(3, num(p, 'size') * e.k)
      const cols = Math.max(1, Math.ceil(e.W / s))
      const rows = Math.max(1, Math.ceil(e.H / s))
      const L = sampleLuma(src.canvas, cols, rows)
      const mono = str(p, 'mode') === 'mono'
      const ctx = dst.ctx
      ctx.fillStyle = mono ? str(p, 'paper') : '#0b0b0f'
      ctx.fillRect(0, 0, e.W, e.H)
      ctx.fillStyle = '#16161a'
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const j = (y * cols + x) * 4
          const lum = L[j + 3]
          if (lum < 0) continue
          const r = mono ? (s / 2) * Math.sqrt(1 - lum) * 1.15 : (s / 2) * Math.sqrt(0.25 + lum * 0.75)
          if (r < 0.4) continue
          if (!mono) ctx.fillStyle = `rgb(${Math.round(L[j] * 255)},${Math.round(L[j + 1] * 255)},${Math.round(L[j + 2] * 255)})`
          ctx.beginPath()
          ctx.arc(x * s + s / 2, y * s + s / 2, r, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      clipToAlphaOf(dst, src.canvas)
    },
  },
  {
    id: 'noise',
    label: 'Noise',
    cat: 'social',
    params: [
      N('amount', 'Amount', 0, 100, 30, '%'),
      S(
        'mode',
        'Noise',
        [
          ['mono', 'Mono'],
          ['color', 'Color'],
        ],
        'color',
      ),
    ],
    process: (src, dst, p, e) => {
      drawSrc(dst, src)
      noise(dst, num(p, 'amount') / 100, e.t, str(p, 'mode') === 'color', 'overlay')
    },
  },
  {
    id: 'neon-glow',
    label: 'Neon Glow',
    cat: 'social',
    params: [C('color', 'Glow color', '#ff2fd6'), N('intensity', 'Intensity', 0, 100, 70, '%'), N('radius', 'Radius', 2, 60, 18, 'px')],
    process: (src, dst, p, e) => {
      drawSrc(dst, src, 'saturate(1.5) contrast(1.1)')
      const glow = copyOf(src.canvas, `saturate(2.2) brightness(1.25) blur(${num(p, 'radius') * e.k}px)`)
      tint(glow, str(p, 'color'), 'overlay', 0.6)
      dst.ctx.save()
      dst.ctx.globalCompositeOperation = 'screen'
      dst.ctx.globalAlpha = num(p, 'intensity') / 100
      dst.ctx.drawImage(glow.canvas, 0, 0)
      // edge glow for graphics with transparency (text, stickers, PNGs)
      dst.ctx.globalCompositeOperation = 'destination-over'
      dst.ctx.shadowColor = str(p, 'color')
      dst.ctx.shadowBlur = num(p, 'radius') * e.k * 1.6
      dst.ctx.drawImage(src.canvas, 0, 0)
      dst.ctx.restore()
      release(glow)
    },
  },
  {
    id: 'outline-glow',
    label: 'Outline Glow',
    cat: 'social',
    params: [C('color', 'Outline color', '#00e5ff'), N('width', 'Width', 1, 30, 6, 'px'), N('glow', 'Glow', 0, 80, 22, 'px')],
    process: (src, dst, p, e) => {
      const w = num(p, 'width') * e.k
      const sil = acquire(e.W, e.H)
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2
        sil.ctx.drawImage(src.canvas, Math.cos(a) * w, Math.sin(a) * w)
      }
      sil.ctx.globalCompositeOperation = 'source-in'
      sil.ctx.fillStyle = str(p, 'color')
      sil.ctx.fillRect(0, 0, e.W, e.H)
      dst.ctx.save()
      dst.ctx.shadowColor = str(p, 'color')
      dst.ctx.shadowBlur = num(p, 'glow') * e.k
      dst.ctx.drawImage(sil.canvas, 0, 0)
      dst.ctx.restore()
      dst.ctx.drawImage(src.canvas, 0, 0)
      release(sil)
    },
  },
  {
    id: 'chromatic',
    label: 'Chromatic Aberration',
    cat: 'social',
    params: [N('amount', 'Amount', 0, 100, 30, '%')],
    process: (src, dst, p) => chroma(dst.ctx, src.canvas, (num(p, 'amount') / 100) * 0.025),
  },
]

export const effectDef = (id) => EFFECTS.find((e) => e.id === id)

export function defaultParams(def) {
  const p = {}
  for (const d of def.params) p[d.key] = d.def
  return p
}

export function newEffect(type) {
  const def = effectDef(type)
  return { id: `fx${Math.random().toString(36).slice(2, 8)}`, type, on: true, params: def ? defaultParams(def) : {} }
}

/** Merge stored params over defaults (older saves / new params). */
export function paramsOf(inst) {
  const def = effectDef(inst.type)
  return def ? { ...defaultParams(def), ...inst.params } : inst.params
}

export function activeEffects(list) {
  if (!list?.length) return []
  const out = []
  for (const inst of list) {
    if (!inst.on) continue
    const def = effectDef(inst.type)
    if (def) out.push({ inst, def, p: paramsOf(inst) })
  }
  return out
}

export const FX_CATEGORIES = [
  { id: 'cinematic', label: 'Cinematic' },
  { id: 'motion', label: 'Motion' },
  { id: 'social', label: 'Modern / Social' },
]
