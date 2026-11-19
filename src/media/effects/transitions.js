import { FX_TRANSITIONS } from './fx/transitionsFx'

export const TRANSITION_CATS = [
  { id: 'basic', label: 'Basic' },
  { id: 'cinematic', label: 'Smooth & cinematic' },
  { id: 'glitch', label: 'Glitch & trendy' },
  { id: 'creative', label: 'Creative' },
]

const T = (cat, list) => list.map(([id, label]) => ({ id, label, cat }))

export const TRANSITIONS = [
  ...T('basic', [
    ['dissolve', 'Cross dissolve'],
    ['dip-black', 'Dip to black'],
    ['dip-white', 'Dip to white'],
    ['wipe-left', 'Wipe left'],
    ['wipe-right', 'Wipe right'],
    ['wipe-up', 'Wipe up'],
    ['wipe-down', 'Wipe down'],
    ['slide-left', 'Slide left'],
    ['slide-right', 'Slide right'],
    ['push-left', 'Push left'],
    ['push-right', 'Push right'],
    ['zoom-in', 'Zoom in'],
    ['zoom-out', 'Zoom out'],
    ['blur', 'Blur dissolve'],
  ]),
  ...T('cinematic', [
    ['smooth-zoom-in', 'Smooth Zoom In'],
    ['smooth-zoom-out', 'Smooth Zoom Out'],
    ['cross-zoom', 'Cross Zoom'],
    ['whip-pan', 'Whip Pan'],
    ['motion-blur-swipe', 'Motion Blur Swipe'],
    ['directional-blur', 'Directional Blur'],
    ['camera-push', 'Camera Push'],
    ['pull-back', 'Pull Back'],
    ['parallax', 'Parallax'],
    ['3d-flip', '3D Flip'],
    ['spin', 'Spin'],
    ['morph', 'Seamless Morph'],
    ['match-cut', 'Match Cut'],
    ['mask-reveal', 'Mask Reveal'],
    ['luma-fade', 'Luma Fade'],
  ]),
  ...T('glitch', [
    ['rgb-split', 'RGB Split'],
    ['glitch-shake', 'Glitch Shake'],
    ['digital-distortion', 'Digital Distortion'],
    ['pixel-sort', 'Pixel Sorting'],
    ['vhs', 'VHS Glitch'],
    ['datamosh', 'Datamosh'],
    ['chromatic', 'Chromatic Aberration'],
    ['digital-scan', 'Digital Scan'],
    ['flash', 'Flash'],
    ['strobe', 'Strobe'],
  ]),
  ...T('creative', [
    ['liquid-wipe', 'Liquid Wipe'],
    ['ink-drop', 'Ink Drop Reveal'],
    ['smoke', 'Smoke Reveal'],
    ['light-leak', 'Light Leak'],
    ['film-burn', 'Film Burn'],
    ['shatter', 'Shatter'],
    ['paper-tear', 'Paper Tear'],
    ['circle', 'Circular Reveal'],
    ['gradient-wipe', 'Gradient Wipe'],
    ['mosaic', 'Mosaic'],
  ]),
]

export const transitionLabel = (t) => TRANSITIONS.find((x) => x.id === t)?.label ?? t

/** Extra per-draw modifiers a transition applies to one side. */
/** Draws one side (A = outgoing, B = incoming). Returns the side's drawn rect, or null when absent. */
/** Both ways to get a side: draw it in place, or render it into a full-frame layer (released by the caller). */
/**
 * Cross-dissolve: (1 − p)·A + p·B over whatever is below, for any pair of sides.
 * - B opaque and covering A (the common full-frame video cut): draw A, then B at p — exact and cheap.
 * - Both sides present otherwise: A at (1 − p) and B at p are rendered into layers and summed ('lighter'),
 *   then composited once, so there is no dark midpoint and A still fades where B doesn't cover it.
 * - One side only (edge transition): the outgoing side fades out / the incoming side fades in.
 * Without `sides` (legacy callers) `opaqueA` keeps the old behaviour.
 */
function crossDissolve(ctx, p, drawA, drawB, opaqueA, sides, mA = {}, mB = {}) {
  if (sides) {
    if (sides.hasA && sides.hasB && sides.bCoversA()) {
      drawA(mA)
      drawB({ ...mB, alpha: p })
      return
    }
    if (sides.mixable) {
      const la = sides.layerA({ ...mA, alpha: 1 - p })
      const lb = sides.layerB({ ...mB, alpha: p })
      la.ctx.save()
      la.ctx.setTransform(1, 0, 0, 1, 0, 0)
      la.ctx.globalAlpha = 1
      la.ctx.globalCompositeOperation = 'lighter'
      la.ctx.drawImage(lb.canvas, 0, 0)
      la.ctx.restore()
      ctx.save()
      ctx.globalAlpha = 1
      ctx.drawImage(la.canvas, 0, 0)
      ctx.restore()
      return
    }
    drawA({ ...mA, alpha: 1 - p })
    drawB({ ...mB, alpha: p })
    return
  }
  drawA({ ...mA, alpha: opaqueA ? 1 : 1 - p })
  drawB({ ...mB, alpha: p })
}

/**
 * Draw a transition at eased progress `p` (0 → all A, 1 → all B) over a W×H canvas area.
 * `opaqueA` (used only without `sides`) = A fully covers what B overlaps, so dissolves keep it at full alpha.
 */
export function drawTransition(ctx, type, p, W, H, drawA, drawB, opaqueA, sides, t = 0) {
  const fx = FX_TRANSITIONS[type]
  if (fx && sides) {
    fx(ctx, p, W, H, sides, t)
    return
  }
  switch (type) {
    case 'dissolve':
      crossDissolve(ctx, p, drawA, drawB, opaqueA, sides)
      return
    case 'blur': {
      // a blurred B has soft edges, so it never "covers" A: always mix
      const noCover = sides ? { ...sides, bCoversA: () => false } : sides
      crossDissolve(ctx, p, drawA, drawB, opaqueA, noCover, { blur: p * W * 0.012 }, { blur: (1 - p) * W * 0.012 })
      return
    }
    case 'dip-black':
    case 'dip-white': {
      const color = type === 'dip-black' ? '#000000' : '#ffffff'
      const half = p < 0.5
      const r = half ? drawA() : drawB()
      const a = half ? p * 2 : (1 - p) * 2
      if (r && a > 0) {
        ctx.save()
        ctx.globalAlpha = a
        ctx.fillStyle = color
        ctx.fillRect(r.x, r.y, r.w, r.h)
        ctx.restore()
      }
      return
    }
    case 'wipe-left':
    case 'wipe-right':
    case 'wipe-up':
    case 'wipe-down': {
      drawA()
      ctx.save()
      ctx.beginPath()
      if (type === 'wipe-left') ctx.rect(W * (1 - p), 0, W * p, H)
      else if (type === 'wipe-right') ctx.rect(0, 0, W * p, H)
      else if (type === 'wipe-up') ctx.rect(0, H * (1 - p), W, H * p)
      else ctx.rect(0, 0, W, H * p)
      ctx.clip()
      drawB()
      ctx.restore()
      return
    }
    case 'slide-left':
      drawA()
      drawB({ dx: (1 - p) * W })
      return
    case 'slide-right':
      drawA()
      drawB({ dx: -(1 - p) * W })
      return
    case 'push-left':
      drawA({ dx: -p * W })
      drawB({ dx: (1 - p) * W })
      return
    case 'push-right':
      drawA({ dx: p * W })
      drawB({ dx: -(1 - p) * W })
      return
    case 'zoom-in':
      drawB({ alpha: p, scale: 0.85 + 0.15 * p })
      drawA({ alpha: 1 - p, scale: 1 + 0.6 * p })
      return
    case 'zoom-out':
      // B only grows (≥ 1) and A only shrinks (≤ 1), so "B covers A" at rest still holds
      crossDissolve(ctx, p, drawA, drawB, opaqueA, sides, { scale: 1 - 0.35 * p }, { scale: 1.35 - 0.35 * p })
      return
    default:
      // unknown id (e.g. from a newer save): fall back to a dissolve
      crossDissolve(ctx, p, drawA, drawB, opaqueA, sides)
      return
    case 'circle': {
      drawA()
      ctx.save()
      ctx.beginPath()
      ctx.arc(W / 2, H / 2, (p * Math.hypot(W, H)) / 2, 0, Math.PI * 2)
      ctx.clip()
      drawB()
      ctx.restore()
      return
    }
  }
}
