import { defaultAnim } from './animations'

/** System fonts only: they work in the export worker too (web fonts would need loading there). */
export const FONTS = [
  { id: 'system', label: 'System (SF / Segoe)', css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'helvetica', label: 'Helvetica', css: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: 'avenir', label: 'Avenir', css: '"Avenir Next", Avenir, "Segoe UI", sans-serif' },
  { id: 'futura', label: 'Futura', css: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif' },
  { id: 'rounded', label: 'Rounded', css: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", system-ui, sans-serif' },
  { id: 'impact', label: 'Impact', css: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif' },
  { id: 'arial-black', label: 'Arial Black', css: '"Arial Black", "Arial Bold", Gadget, sans-serif' },
  { id: 'georgia', label: 'Georgia', css: 'Georgia, "Times New Roman", serif' },
  { id: 'times', label: 'Times', css: '"Times New Roman", Times, serif' },
  { id: 'typewriter', label: 'Typewriter', css: '"American Typewriter", "Courier New", Courier, monospace' },
  { id: 'courier', label: 'Courier', css: '"Courier New", Courier, monospace' },
  { id: 'marker', label: 'Marker', css: '"Marker Felt", "Comic Sans MS", "Chalkboard SE", cursive' },
  { id: 'mono', label: 'Mono', css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
]

/** Fill defaults (projects saved before the styling fields existed keep their look). */
export function textStyle(t) {
  return {
    fontCss: FONTS.find((f) => f.id === t.font)?.css ?? FONTS[0].css,
    weight: t.weight ?? (t.bold ? 700 : 500),
    italic: !!t.italic,
    align: t.align ?? 'center',
    letterSpacing: t.letterSpacing ?? 0,
    lineHeight: t.lineHeight ?? 1.2,
    color: t.color,
    outlineColor: t.outlineColor ?? '#000000',
    outlineWidth: t.outlineWidth ?? 0,
    shadow: !!t.shadow,
    glow: !!t.glow,
    background: t.background,
    bgColor: t.bgColor ?? '#000000',
    bgOpacity: t.bgOpacity ?? 0.6,
    bgRadius: t.bgRadius ?? 0.25,
    uppercase: !!t.uppercase,
  }
}

export function fontString(st, size) {
  return `${st.italic ? 'italic ' : ''}${st.weight} ${size}px ${st.fontCss}`
}

function setSpacing(ctx, px) {
  ctx.letterSpacing = `${px}px`
}

/** Measure text at `size` (canvas px). The box is sized for the FULL text so reveals don't make it jump. */
export function layoutText(ctx, t, size) {
  const st = textStyle(t)
  ctx.font = fontString(st, size)
  setSpacing(ctx, st.letterSpacing * (size / Math.max(1, t.size)))
  const content = st.uppercase ? t.content.toUpperCase() : t.content
  const lines = content.split('\n')
  const widths = lines.map((l) => ctx.measureText(l).width)
  const maxW = Math.max(1, ...widths)
  const lineH = size * st.lineHeight
  const totalH = lineH * lines.length
  const padX = st.background ? size * 0.45 : 0
  const padY = st.background ? size * 0.22 : 0
  setSpacing(ctx, 0)
  return { lines, widths, maxW, lineH, totalH, padX, padY, boxW: maxW + padX * 2 + st.outlineWidth * 2, boxH: totalH + padY * 2 + st.outlineWidth * 2 }
}

export const TEXT_FX = [
  { id: 'none', label: 'None' },
  { id: 'kinetic', label: 'Kinetic Typography' },
  { id: 'tracking', label: 'Tracking Animation' },
  { id: 'neon-flicker', label: 'Neon Flicker' },
  { id: 'pop', label: 'Text Pop (per letter)' },
  { id: 'flip', label: '3D Text Flip' },
  { id: 'glitch', label: 'Text Glitch' },
]

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeOut = (x) => 1 - (1 - clamp01(x)) ** 3
const easeOutBack = (x) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  const q = clamp01(x)
  return 1 + c3 * (q - 1) ** 3 + c1 * (q - 1) ** 2
}
const flick = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Fill style: plain colour or a (possibly animated) gradient across the text box. */
function fillFor(ctx, t, st, w, h, local) {
  const g = t.gradient
  if (!g?.on) return st.color
  const ang = (g.angle * Math.PI) / 180
  const r = Math.hypot(w, h) / 2
  const shift = g.animate ? ((local * 0.35) % 1) * 2 * r : 0
  const dx = Math.cos(ang) * r
  const dy = Math.sin(ang) * r
  const grad = ctx.createLinearGradient(-dx - shift, -dy, dx - shift, dy)
  const colors = [g.c1, g.c2, g.c3].filter(Boolean)
  // repeat the colour sequence so the animated shift loops seamlessly
  const seq = g.animate ? [...colors, ...colors, colors[0]] : colors
  seq.forEach((c, i) => grad.addColorStop(i / Math.max(1, seq.length - 1), c))
  return grad
}

/**
 * Draw text centred at the current origin. `size` is the final font size in canvas px,
 * `reveal` 0..1 for typewriter / words / rise, `local`/`dur` = time inside the clip for text effects.
 */
export function drawTextAt(ctx, t, size, reveal, revealMode, unit, local = 10, dur = 10) {
  const st = textStyle(t)
  const L = layoutText(ctx, t, size)
  const ow = st.outlineWidth * unit
  const fx = t.fx ?? 'none'
  const fxDur = Math.max(0.1, Math.min(t.fxDur ?? 1, dur))
  if (st.background) {
    ctx.save()
    ctx.globalAlpha *= st.bgOpacity
    ctx.fillStyle = st.bgColor
    const w = L.maxW + L.padX * 2
    const h = L.totalH + L.padY * 2
    ctx.beginPath()
    ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(h / 2, st.bgRadius * size))
    ctx.fill()
    ctx.restore()
  }
  let spacing = st.letterSpacing * (size / Math.max(1, t.size))
  if (fx === 'tracking') spacing += (1 - easeOut(local / fxDur)) * size * 0.6
  let alphaMul = 1
  let glow = st.glow
  if (fx === 'neon-flicker') {
    glow = true
    const n = Math.floor(local * 18)
    alphaMul = flick(n) < 0.08 || (flick(n * 0.37) < 0.04 && local < 1.5) ? 0.25 : 0.88 + 0.12 * Math.sin(local * 9)
  }
  ctx.font = fontString(st, size)
  setSpacing(ctx, spacing)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.lineJoin = 'round'
  const fill = fillFor(ctx, t, st, L.maxW, L.totalH, local)

  /** Paint one run of text with outline / shadow / glow at (x, y). */
  const paintRun = (text, x, y) => {
    if (glow) {
      ctx.shadowColor = st.color
      ctx.shadowBlur = size * 0.45
      ctx.fillStyle = fill
      ctx.fillText(text, x, y)
      ctx.shadowBlur = size * 0.18
    } else if (st.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur = size * 0.16
      ctx.shadowOffsetY = size * 0.05
    }
    if (ow > 0) {
      ctx.lineWidth = ow * 2
      ctx.strokeStyle = st.outlineColor
      ctx.strokeText(text, x, y)
      if (!glow) ctx.shadowColor = 'transparent'
    }
    ctx.fillStyle = fill
    ctx.fillText(text, x, y)
  }

  const lineX = (i) => {
    const full = ctx.measureText(L.lines[i]).width
    return st.align === 'left' ? -L.maxW / 2 : st.align === 'right' ? L.maxW / 2 - full : -full / 2
  }
  const lineY = (i) => -L.totalH / 2 + L.lineH * (i + 0.5)

  // ---- per-glyph / per-word effects
  if (fx === 'pop' || fx === 'flip' || fx === 'kinetic') {
    const totalChars = Math.max(
      1,
      L.lines.reduce((a, l) => a + l.length, 0),
    )
    const totalWords = Math.max(
      1,
      L.lines.reduce((a, l) => a + l.split(/\s+/).filter(Boolean).length, 0),
    )
    let gi = 0
    let wi = 0
    L.lines.forEach((line, li) => {
      const x0 = lineX(li)
      const y = lineY(li)
      if (fx === 'kinetic') {
        const parts = line.split(/(\s+)/)
        let x = x0
        for (const part of parts) {
          const w = ctx.measureText(part).width
          if (part.trim()) {
            const start = (wi / totalWords) * fxDur * 0.8
            const q = (local - start) / 0.28
            if (q > 0) {
              const punch = 1 + 0.6 * (1 - easeOut(q))
              const beat = 1 + 0.03 * Math.sin(local * Math.PI * 4 + wi)
              const rot = (wi % 2 ? 1 : -1) * 0.07 * (1 - easeOut(q))
              ctx.save()
              ctx.globalAlpha *= alphaMul * clamp01(q * 3)
              ctx.translate(x + w / 2, y)
              ctx.rotate(rot)
              ctx.scale(punch * beat, punch * beat)
              paintRun(part, -w / 2, 0)
              ctx.restore()
            }
            wi++
          }
          x += w
        }
        return
      }
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci]
        const before = ctx.measureText(line.slice(0, ci)).width
        const w = ctx.measureText(ch).width
        const start = (gi / totalChars) * fxDur * 0.6
        const q = (local - start) / (fxDur * 0.4)
        gi++
        if (q <= 0 || !ch.trim()) continue
        ctx.save()
        ctx.globalAlpha *= alphaMul * clamp01(q * 2.5)
        ctx.translate(x0 + before + w / 2, y)
        if (fx === 'pop') {
          const sc = Math.max(0.001, easeOutBack(q))
          ctx.scale(sc, sc)
        } else {
          // card-flip around the horizontal axis: squash Y, slight lift
          const ang = (1 - easeOutBack(q)) * (Math.PI / 2)
          ctx.translate(0, -Math.sin(ang) * size * 0.15)
          ctx.scale(1, Math.max(0.02, Math.cos(ang)))
        }
        paintRun(ch, -w / 2, 0)
        ctx.restore()
      }
    })
    setSpacing(ctx, 0)
    return
  }

  // ---- whole-line drawing (with typewriter / words / rise reveals)
  const total = L.lines.reduce((a, l) => a + l.length, 0)
  const words = L.lines.map((l) => l.split(/(\s+)/))
  const totalWords = words.reduce((a, w) => a + w.filter((x) => x.trim()).length, 0)
  let charsLeft = revealMode === 'typewriter' ? Math.floor(total * reveal + 1e-6) : Infinity
  let wordsLeft = revealMode === 'words' ? Math.ceil(totalWords * reveal - 1e-6) : Infinity
  L.lines.forEach((line, i) => {
    const x0 = lineX(i)
    let y = lineY(i)
    let text = line
    let alpha = alphaMul
    if (revealMode === 'typewriter') {
      text = line.slice(0, Math.max(0, Math.min(line.length, charsLeft)))
      charsLeft -= line.length
    } else if (revealMode === 'words') {
      let out = ''
      for (const part of words[i]) {
        if (!part.trim()) {
          if (wordsLeft > 0) out += part
          continue
        }
        if (wordsLeft <= 0) break
        out += part
        wordsLeft--
      }
      text = out
    } else if (revealMode === 'rise') {
      const n = L.lines.length
      const q = Math.max(0, Math.min(1, reveal * n - i))
      alpha *= q
      y += (1 - q) * size * 0.6
    }
    if (!text || alpha <= 0) return
    ctx.save()
    ctx.globalAlpha *= alpha
    paintRun(text, x0, y)
    ctx.restore()
  })
  setSpacing(ctx, 0)
}

// ------------------------------------------------------------------ presets

const T = (x = 0, y = 0) => ({ x, y, scale: 1, opacity: 1 })
const A = (patch) => ({ ...defaultAnim(), ...patch })

export const TEXT_PRESETS = [
  {
    id: 'title',
    label: 'Title',
    make: (_W, H) => ({
      text: { content: 'Big Title', size: Math.round(H * 0.12), color: '#ffffff', background: false, bold: true, weight: 800, shadow: true },
      transform: T(),
      anim: A({ in: 'pop', inDur: 0.5, out: 'fade' }),
    }),
  },
  {
    id: 'subtitle',
    label: 'Subtitle',
    make: (_W, H) => ({
      text: {
        content: 'Subtitle text goes here',
        size: Math.round(H * 0.045),
        color: '#ffffff',
        background: true,
        bold: false,
        weight: 600,
        bgColor: '#000000',
        bgOpacity: 0.6,
        bgRadius: 0.3,
      },
      transform: T(0, Math.round(H * 0.37)),
      anim: A({ in: 'fade', inDur: 0.25, out: 'fade', outDur: 0.25 }),
    }),
  },
  {
    id: 'lower-third',
    label: 'Lower third',
    make: (W, H) => ({
      text: {
        content: 'Jane Cooper\nProducer',
        size: Math.round(H * 0.048),
        color: '#ffffff',
        background: true,
        bold: true,
        weight: 700,
        align: 'left',
        bgColor: '#3d6fe8',
        bgOpacity: 0.95,
        bgRadius: 0.12,
        lineHeight: 1.3,
      },
      transform: T(-Math.round(W * 0.28), Math.round(H * 0.3)),
      anim: A({ in: 'slide-right', inDur: 0.6, out: 'fade' }),
      duration: 5,
    }),
  },
  {
    id: 'callout',
    label: 'Callout',
    make: (_W, H) => ({
      text: {
        content: 'Look here!',
        size: Math.round(H * 0.06),
        color: '#111111',
        background: true,
        bold: true,
        weight: 800,
        font: 'rounded',
        bgColor: '#ffd23f',
        bgOpacity: 1,
        bgRadius: 0.6,
      },
      transform: T(0, -Math.round(H * 0.2)),
      anim: A({ in: 'pop', loop: 'pulse', out: 'pop' }),
    }),
  },
  {
    id: 'quote',
    label: 'Quote',
    make: (_W, H) => ({
      text: {
        content: '“Make something\npeople love.”',
        size: Math.round(H * 0.07),
        color: '#ffffff',
        background: false,
        bold: false,
        weight: 500,
        font: 'georgia',
        italic: true,
        shadow: true,
      },
      transform: T(),
      anim: A({ reveal: 'words', revealDur: 1.6, out: 'fade' }),
      duration: 5,
    }),
  },
  {
    id: 'caption-bar',
    label: 'Caption bar',
    make: (_W, H) => ({
      text: {
        content: 'Breaking: caption bar style',
        size: Math.round(H * 0.04),
        color: '#ffffff',
        background: true,
        bold: true,
        weight: 800,
        uppercase: true,
        letterSpacing: 2,
        bgColor: '#e60023',
        bgOpacity: 1,
        bgRadius: 0,
      },
      transform: T(0, Math.round(H * 0.4)),
      anim: A({ in: 'slide-up', inDur: 0.4, out: 'slide-down', outDur: 0.4 }),
    }),
  },
  {
    id: 'neon',
    label: 'Neon',
    make: (_W, H) => ({
      text: {
        content: 'NEON',
        size: Math.round(H * 0.15),
        color: '#ff4dd8',
        background: false,
        bold: true,
        weight: 800,
        font: 'futura',
        glow: true,
        letterSpacing: 8,
      },
      transform: T(),
      anim: A({ in: 'fade', loop: 'pulse', loopSpeed: 0.8 }),
    }),
  },
  {
    id: 'outline',
    label: 'Outline',
    make: (_W, H) => ({
      text: {
        content: 'OUTLINE',
        size: Math.round(H * 0.14),
        color: 'rgba(255,255,255,0)',
        background: false,
        bold: true,
        weight: 900,
        font: 'arial-black',
        outlineColor: '#ffffff',
        outlineWidth: 3,
      },
      transform: T(),
      anim: A({ in: 'zoom' }),
    }),
  },
  {
    id: 'big-bold',
    label: 'Big & bold',
    make: (_W, H) => ({
      text: {
        content: 'BIG & BOLD',
        size: Math.round(H * 0.16),
        color: '#ffd23f',
        background: false,
        bold: true,
        weight: 900,
        font: 'impact',
        outlineColor: '#111111',
        outlineWidth: 6,
        uppercase: true,
      },
      transform: T(),
      anim: A({ in: 'zoom', loop: 'wiggle', loopSpeed: 0.6 }),
    }),
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    make: (_W, H) => ({
      text: {
        content: 'Once upon a time…',
        size: Math.round(H * 0.065),
        color: '#ffffff',
        background: false,
        bold: false,
        weight: 500,
        font: 'typewriter',
        shadow: true,
      },
      transform: T(),
      anim: A({ reveal: 'typewriter', revealDur: 1.8 }),
      duration: 5,
    }),
  },
]
