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
 * Draw a transition at eased progress `p` (0 → all A, 1 → all B) over a W×H canvas area.
 * `opaqueA` = A fully covers what it overlaps (video), so dissolves can keep it at full alpha
 * (prevents a dark midpoint); transparent graphics fade out instead.
 */
export function drawTransition(ctx, type, p, W, H, drawA, drawB, opaqueA, sides, t = 0) {
  const fx = FX_TRANSITIONS[type]
  if (fx && sides) {
    fx(ctx, p, W, H, sides, t)
    return
  }
  switch (type) {
    case 'dissolve':
      drawA({ alpha: opaqueA ? 1 : 1 - p })
      drawB({ alpha: p })
      return
    case 'blur':
      drawA({ alpha: opaqueA ? 1 : 1 - p, blur: p * W * 0.012 })
      drawB({ alpha: p, blur: (1 - p) * W * 0.012 })
      return
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
      drawA({ alpha: opaqueA ? 1 : 1 - p, scale: 1 - 0.35 * p })
      drawB({ alpha: p, scale: 1.35 - 0.35 * p })
      return
    default:
      // unknown id (e.g. from a newer save): fall back to a dissolve
      drawA({ alpha: opaqueA ? 1 : 1 - p })
      drawB({ alpha: p })
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
