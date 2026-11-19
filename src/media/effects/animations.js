export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

export function ease(e, p) {
  p = clamp01(p)
  switch (e) {
    case 'linear':
      return p
    case 'ease-in':
      return p * p * p
    case 'ease-out':
      return 1 - (1 - p) ** 3
    default:
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2
  }
}

const easeOutBack = (p) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2
}

export const ANIM_IN = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'pop', label: 'Pop' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'slide-up', label: 'Slide up' },
  { id: 'slide-down', label: 'Slide down' },
  { id: 'slide-left', label: 'Slide from right' },
  { id: 'slide-right', label: 'Slide from left' },
]

/** Out animations reuse the In kinds played backwards, so the labels describe the exit direction. */
export const ANIM_OUT = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'pop', label: 'Pop' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'slide-up', label: 'Slide down' },
  { id: 'slide-down', label: 'Slide up' },
  { id: 'slide-left', label: 'Slide to right' },
  { id: 'slide-right', label: 'Slide to left' },
]

export const ANIM_LOOP = [
  { id: 'none', label: 'None' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'bounce', label: 'Bounce' },
  { id: 'float', label: 'Float' },
  { id: 'spin', label: 'Spin' },
  { id: 'wiggle', label: 'Wiggle' },
]

export const TEXT_REVEALS = [
  { id: 'none', label: 'None' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'words', label: 'Word by word' },
  { id: 'rise', label: 'Lines rise' },
]

export function defaultAnim() {
  return { in: 'none', inDur: 0.5, out: 'none', outDur: 0.5, loop: 'none', loopSpeed: 1, reveal: 'none', revealDur: 1.2 }
}

export function hasAnim(a) {
  return !!a && (a.in !== 'none' || a.out !== 'none' || a.loop !== 'none' || a.reveal !== 'none')
}

/** Per-frame modifiers produced by a clip's animation, relative to its base transform. */
const IDENTITY = { dx: 0, dy: 0, scale: 1, rotate: 0, alpha: 1, reveal: 1 }

function applyEdge(kind, p, W, H, s) {
  // p: 0 = fully "off", 1 = fully "on"
  if (kind === 'none' || p >= 1) return
  const q = clamp01(p)
  const e = ease('ease-out', q)
  switch (kind) {
    case 'fade':
      s.alpha *= q
      break
    case 'pop':
      s.scale *= Math.max(0.001, easeOutBack(q))
      s.alpha *= clamp01(q * 3)
      break
    case 'zoom':
      s.scale *= 1.6 - 0.6 * e
      s.alpha *= q
      break
    case 'slide-up':
      s.dy += (1 - e) * H * 0.25
      s.alpha *= clamp01(q * 2)
      break
    case 'slide-down':
      s.dy -= (1 - e) * H * 0.25
      s.alpha *= clamp01(q * 2)
      break
    case 'slide-left':
      s.dx += (1 - e) * W * 0.3
      s.alpha *= clamp01(q * 2)
      break
    case 'slide-right':
      s.dx -= (1 - e) * W * 0.3
      s.alpha *= clamp01(q * 2)
      break
  }
}

/**
 * Time inside the clip's own animation clock. A split half carries `phase` (seconds into the original clip at
 * its start), so loops, Ken Burns, text fx and reveals continue across the cut instead of restarting.
 */
export function clipLocal(c, t) {
  return t - c.start + (c.phase ?? 0)
}

/** Length of the clip's animation clock: the original clip's length for split halves (`span`), else its duration. */
export function clipSpan(c) {
  return c.span ?? (c.phase ?? 0) + c.duration
}

/** Animation modifiers for clip `c` at timeline time `t`. */
export function animState(c, t, W, H) {
  const a = c.anim
  if (!a || !hasAnim(a)) return IDENTITY
  const s = { ...IDENTITY }
  const edge = t - c.start // in/out animations are tied to this clip's own edges
  const local = clipLocal(c, t)
  const remaining = c.start + c.duration - t
  if (a.in !== 'none' && a.inDur > 0) applyEdge(a.in, edge / a.inDur, W, H, s)
  if (a.out !== 'none' && a.outDur > 0) applyEdge(a.out, remaining / a.outDur, W, H, s)
  if (a.loop !== 'none') {
    const w = 2 * Math.PI * (a.loopSpeed || 1)
    switch (a.loop) {
      case 'pulse':
        s.scale *= 1 + 0.06 * Math.sin(local * w)
        break
      case 'bounce':
        s.dy -= Math.abs(Math.sin(local * w * 0.75)) * H * 0.04
        break
      case 'float':
        s.dy += Math.sin(local * w * 0.5) * H * 0.015
        s.dx += Math.cos(local * w * 0.35) * W * 0.006
        break
      case 'spin':
        s.rotate += (local * 180 * (a.loopSpeed || 1)) % 360
        break
      case 'wiggle':
        s.rotate += Math.sin(local * w * 2) * 6
        break
    }
  }
  if (c.kind === 'text' && a.reveal !== 'none' && a.revealDur > 0) s.reveal = clamp01(local / a.revealDur)
  return s
}
