import { animState, clipLocal, clipSpan, ease } from './effects/animations'
import { defaultFilter, drawFilterOverlays, hasFilter, hasFilterOverlays, resolveFilter } from './effects/filters'
import { drawSticker, stickerBaseSize } from './effects/stickers'
import { drawTextAt, layoutText } from './effects/text'
import { drawTransition } from './effects/transitions'
import { activeEffects, effectDef } from './effects/fx/videoEffects'
import { acquire, clipToAlphaOf, release } from './effects/fx/util'

const EPS = 1e-6

export function clipEnd(c) {
  return c.start + c.duration
}

export function isClipActive(c, t) {
  return t >= c.start - EPS && t < clipEnd(c) - EPS
}

/** Timeline length = end of the last clip. */
export function timelineDuration(p) {
  let end = 0
  for (const c of p.clips) end = Math.max(end, clipEnd(c))
  return end
}

const isVisual = (c) => c.kind !== 'audio'

/** Visual clips active at t, ordered bottom layer → top layer (adjustment layers excluded). */
export function activeVisualClips(p, t) {
  const videoTracks = p.tracks.filter((tr) => tr.kind === 'video' && !tr.hidden)
  const out = []
  for (let i = videoTracks.length - 1; i >= 0; i--) {
    for (const c of p.clips) {
      if (c.trackId === videoTracks[i].id && isVisual(c) && c.kind !== 'adjustment' && isClipActive(c, t)) out.push(c)
    }
  }
  return out
}

/** Audio clips that should be heard (track not muted). */
export function audibleClips(p) {
  const muted = new Set(p.tracks.filter((t) => t.kind === 'audio' && t.muted).map((t) => t.id))
  const audioTrackIds = new Set(p.tracks.filter((t) => t.kind === 'audio').map((t) => t.id))
  return p.clips.filter((c) => c.kind === 'audio' && audioTrackIds.has(c.trackId) && !muted.has(c.trackId) && c.assetId)
}

/** Source time inside the clip's media for a timeline time. */
export function sourceTime(c, t) {
  return c.in + (t - c.start)
}

// ------------------------------------------------------------------ transitions → layer items

/** Transitions whose clips still exist and (for cuts) still touch. Invalid ones are ignored. */
export function resolveTransitions(p, trackId) {
  const byId = new Map(p.clips.map((c) => [c.id, c]))
  const out = []
  for (const tr of p.transitions ?? []) {
    const a = tr.leftId ? (byId.get(tr.leftId) ?? null) : null
    const b = tr.rightId ? (byId.get(tr.rightId) ?? null) : null
    if ((tr.leftId && !a) || (tr.rightId && !b) || (!a && !b)) continue
    // a transition lives on its clips' track (tr.trackId may be stale after both clips moved together)
    if (a && b && a.trackId !== b.trackId) continue
    if (trackId && (a ?? b).trackId !== trackId) continue
    if (a && b) {
      if (Math.abs(clipEnd(a) - b.start) > 0.02) continue
      const d = Math.min(tr.duration, a.duration, b.duration)
      const cut = b.start
      out.push({ tr, a, b, start: cut - d / 2, end: cut + d / 2 })
    } else if (b) {
      out.push({ tr, a: null, b, start: b.start, end: b.start + Math.min(tr.duration, b.duration) })
    } else if (a) {
      out.push({ tr, a, b: null, start: clipEnd(a) - Math.min(tr.duration, a.duration), end: clipEnd(a) })
    }
  }
  return out
}

/** Everything to draw at time t, bottom → top, with transitions resolved. */
export function layerItemsAt(p, t) {
  const tracks = p.tracks.filter((tr) => tr.kind === 'video' && !tr.hidden)
  const items = []
  for (let i = tracks.length - 1; i >= 0; i--) {
    const tr = tracks[i]
    const busy = new Set()
    const trItems = []
    for (const rt of resolveTransitions(p, tr.id)) {
      if (t < rt.start - EPS || t >= rt.end - EPS) continue
      if ((rt.a && busy.has(rt.a.id)) || (rt.b && busy.has(rt.b.id))) continue
      if (rt.a) busy.add(rt.a.id)
      if (rt.b) busy.add(rt.b.id)
      trItems.push({ kind: 'transition', rt, p: ease(rt.tr.easing, (t - rt.start) / Math.max(EPS, rt.end - rt.start)) })
    }
    for (const c of p.clips) {
      if (c.trackId !== tr.id || !isVisual(c) || busy.has(c.id) || !isClipActive(c, t)) continue
      trItems.push({ kind: 'clip', clip: c })
    }
    trItems.sort((x, y) => itemStart(x) - itemStart(y))
    items.push(...trItems)
  }
  return items
}

const itemStart = (it) => (it.kind === 'clip' ? it.clip.start : it.rt.start)

function clampedSource(p, c, t) {
  const a = c.assetId ? p.assets.find((x) => x.id === c.assetId) : undefined
  const dur = a?.info.duration ?? Infinity
  const fps = a?.info.video?.fps || 30
  return Math.max(0, Math.min(sourceTime(c, t), dur - 0.5 / fps))
}

/** Media frames the renderer needs at t (video/image clips, including transition partners). */
export function frameRequests(p, t) {
  const out = []
  const push = (c) => {
    if (c && (c.kind === 'video' || c.kind === 'image')) out.push({ clip: c, src: clampedSource(p, c, t) })
  }
  for (const it of layerItemsAt(p, t)) {
    if (it.kind === 'clip') {
      push(it.clip)
      // Motion Trail: each ghost shows the clip as it was i × spacing ago, so it needs that PAST frame. Keyed
      // `<clip id>#g<i>` (callers use `key ?? clip.id`); each ghost gets its own reader, which still moves forward.
      if (it.clip.kind === 'video') for (const [i, tt] of trailGhosts(it.clip, t)) out.push({ clip: it.clip, src: clampedSource(p, it.clip, tt), key: ghostKey(it.clip, i) })
    } else {
      push(it.rt.a)
      push(it.rt.b)
    }
  }
  return out
}

/** Motion Trail ghosts of a clip at t: [index, time] for each ghost that falls inside the clip. */
function trailGhosts(clip, t) {
  const trail = activeEffects(clip.effects).find((f) => f.def.trail)
  if (!trail) return []
  const count = Math.round(Number(trail.p.count))
  const gap = Number(trail.p.spacing) / 1000
  const out = []
  for (let i = 1; i <= count; i++) if (t - i * gap >= clip.start) out.push([i, t - i * gap])
  return out
}
const ghostKey = (clip, i) => `${clip.id}#g${i}`

// ------------------------------------------------------------------ drawing

let measureCtx = null
function measurer() {
  measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d')
  return measureCtx
}
const measure = (font, text) => {
  const m = measurer()
  if (!m) return text.length * 10
  m.font = font
  return m.measureText(text).width
}

/** Size of the clip's content in project px at scale 1 (before transform.scale). */
function contentSize(project, clip, frame) {
  const W = project.width
  const H = project.height
  if (clip.kind === 'text' && clip.text) {
    const m = measurer()
    if (!m) return null
    const L = layoutText(m, clip.text, clip.text.size)
    return { w: L.boxW, h: L.boxH }
  }
  if (clip.kind === 'sticker' && clip.sticker) return stickerBaseSize(clip.sticker, H, measure)
  if (frame && frame.width > 0 && frame.height > 0) {
    const fit = Math.min(W / frame.width, H / frame.height)
    return { w: frame.width * fit, h: frame.height * fit }
  }
  return null
}

function fxEnv(project, clip, t, W, H, scale) {
  return { t, local: clipLocal(clip, t), dur: clipSpan(clip), W, H, k: (project.height * scale) / 1080 }
}

/**
 * Run a layer through an effect chain; returns the final layer (caller releases it; `src` is consumed on
 * success). If an effect throws, every intermediate layer goes back to the pool and `src` stays owned by
 * the caller (which releases it in its own `finally`).
 */
function runChain(src, chain, env) {
  let cur = src
  for (const f of chain) {
    const out = acquire(cur.canvas.width, cur.canvas.height)
    try {
      f.def.process(cur, out, f.p, env)
    } catch (err) {
      release(out)
      if (cur !== src) release(cur)
      throw err
    }
    if (cur !== src) release(cur)
    cur = out
  }
  if (cur !== src) release(src)
  return cur
}

/** Draw one clip (with its effect stack); returns its (unrotated) rect in canvas px, or null. */
function drawClip(ctx, project, clip, t, frames, scale, mods = {}) {
  const W = project.width * scale
  const H = project.height * scale
  const fx = activeEffects(clip.effects)
  const layerFx = fx.filter((f) => f.def.process)
  if (clip.kind === 'text' && clip.text?.fx === 'glitch') layerFx.push(textGlitchFx())

  if (clip.kind === 'adjustment') return drawAdjustment(ctx, project, clip, t, scale, mods, layerFx)

  const motion = fx.filter((f) => f.def.motion)
  const trail = fx.find((f) => f.def.trail)
  if (trail) {
    const count = Math.round(Number(trail.p.count))
    const gap = Number(trail.p.spacing) / 1000
    const fade = Number(trail.p.fade) / 100
    for (let i = count; i >= 1; i--) {
      const tt = t - i * gap
      if (tt < clip.start) continue
      // the ghost's own past frame when the caller fetched it (frameRequests), else the current one
      drawClipBody(ctx, project, clip, tt, frames, scale, { ...mods, alpha: (mods.alpha ?? 1) * fade ** i * 0.9, frameKey: ghostKey(clip, i) }, motion, layerFx, W, H)
    }
  }
  return drawClipBody(ctx, project, clip, t, frames, scale, mods, motion, layerFx, W, H)
}

/** Where and how a (non-adjustment) clip is drawn at t: geometry in canvas px, alpha and rotation. */
function clipGeometry(project, clip, t, frames, scale, mods, motion, W, H) {
  const anim = animState(clip, t, project.width, project.height)
  let mdx = 0
  let mdy = 0
  let mscale = 1
  let mrot = 0
  const local = clipLocal(clip, t)
  const span = clipSpan(clip)
  for (const m of motion) {
    const o = m.def.motion(m.p, local, span, project.width, project.height)
    mdx += o.dx ?? 0
    mdy += o.dy ?? 0
    mscale *= o.scale ?? 1
    mrot += o.rotate ?? 0
  }
  const alpha = Math.max(0, Math.min(1, clip.transform.opacity * anim.alpha * (mods.alpha ?? 1)))
  const frame = (mods.frameKey && frames.get(mods.frameKey)) || frames.get(clip.id)
  const size = contentSize(project, clip, frame)
  if (!size) return null
  const s = clip.transform.scale * anim.scale * mscale * (mods.scale ?? 1)
  const dw = size.w * s * scale
  const dh = size.h * s * scale
  const cx = W / 2 + (clip.transform.x + anim.dx + mdx) * scale + (mods.dx ?? 0)
  const cy = H / 2 + (clip.transform.y + anim.dy + mdy) * scale + (mods.dy ?? 0)
  const rot = ((clip.rotation ?? 0) + anim.rotate + mrot) * (Math.PI / 180)
  return { anim, alpha, frame, s, dw, dh, cx, cy, rot, rect: { x: cx - dw / 2, y: cy - dh / 2, w: dw, h: dh } }
}

function drawClipBody(ctx, project, clip, t, frames, scale, mods, motion, layerFx, W, H) {
  const g = clipGeometry(project, clip, t, frames, scale, mods, motion, W, H)
  if (!g) return null
  const { anim, alpha, frame, s, dw, dh, cx, cy, rot, rect } = g
  if (alpha <= 0 || dw < 0.5 || dh < 0.5) return rect

  const f = hasFilter(clip.filter) ? resolveFilter(clip.filter, scale) : null
  const css = f && f.css !== 'none' ? f.css : ''
  const overlays = !!f && hasFilterOverlays(f)
  const blur = mods.blur && mods.blur > 0.05 ? `blur(${mods.blur.toFixed(2)}px)` : ''

  /** The clip's pixels (CSS filter applied), at alpha `a`, onto `c`. */
  const paintContent = (c, a, extraFilter) => {
    c.save()
    c.globalAlpha = a
    c.translate(cx, cy)
    if (rot) c.rotate(rot)
    const filt = [css, extraFilter].filter(Boolean).join(' ')
    if (filt) c.filter = filt
    if (clip.kind === 'text' && clip.text) {
      drawTextAt(c, clip.text, clip.text.size * s * scale, anim.reveal, clip.anim?.reveal ?? 'none', s * scale, clipLocal(clip, t), clipSpan(clip))
    } else if (clip.kind === 'sticker' && clip.sticker) {
      drawSticker(c, clip.sticker, dw, dh)
    } else if (frame) {
      c.drawImage(frame.image, -dw / 2, -dh / 2, dw, dh)
    }
    c.restore()
  }
  const paintOverlays = (c) => {
    c.save()
    c.translate(cx, cy)
    if (rot) c.rotate(rot)
    drawFilterOverlays(c, f, { x: -dw / 2, y: -dh / 2, w: dw, h: dh }, t)
    c.restore()
  }

  // Opaque video at full alpha: overlays can be blended in place — identical to the isolated path below.
  const opaque = clip.kind === 'video' && !!frame && !/blur\(/.test(css)
  if (!layerFx.length && (!overlays || (opaque && alpha >= 1 - 1e-6 && !blur))) {
    paintContent(ctx, alpha, blur)
    if (overlays) paintOverlays(ctx)
    return rect
  }

  // Isolated: render the clip alone (alpha 1) into a full-frame layer, add the filter overlays limited to the
  // clip's own shape, run the effect stack, then composite once at the clip's alpha. The overlay result is
  // therefore the same with or without layer effects, and the clip/fade alpha applies to the overlays too.
  let layer = acquire(Math.ceil(W), Math.ceil(H))
  try {
    paintContent(layer.ctx, 1, '')
    if (overlays) {
      if (opaque) paintOverlays(layer.ctx)
      else {
        const shape = acquire(layer.canvas.width, layer.canvas.height)
        shape.ctx.drawImage(layer.canvas, 0, 0)
        paintOverlays(layer.ctx)
        clipToAlphaOf(layer, shape.canvas)
        release(shape)
      }
    }
    if (layerFx.length) layer = runChain(layer, layerFx, fxEnv(project, clip, t, layer.canvas.width, layer.canvas.height, scale))
    ctx.save()
    ctx.globalAlpha = alpha
    if (blur) ctx.filter = blur
    ctx.drawImage(layer.canvas, 0, 0)
    ctx.restore()
  } finally {
    release(layer)
  }
  return rect
}

/** Adjustment layer: filter + effects applied to everything already drawn below. */
function drawAdjustment(ctx, project, clip, t, scale, mods, layerFx) {
  const W = project.width * scale
  const H = project.height * scale
  const anim = animState(clip, t, project.width, project.height)
  const alpha = Math.max(0, Math.min(1, clip.transform.opacity * anim.alpha * (mods.alpha ?? 1)))
  const f = resolveFilter(clip.filter ?? defaultFilter(), scale)
  const blur = mods.blur ? ` blur(${mods.blur.toFixed(2)}px)` : ''
  const css = f.css === 'none' ? (blur ? blur.trim() : 'none') : f.css + blur
  if (alpha <= 0) return { x: 0, y: 0, w: W, h: H }
  const cw = ctx.canvas.width
  const ch = ctx.canvas.height
  if (css !== 'none' || layerFx.length) {
    // snapshot what's below (device pixels), process, draw back over it
    let snap = acquire(cw, ch)
    try {
      snap.ctx.filter = css
      snap.ctx.drawImage(ctx.canvas, 0, 0)
      snap.ctx.filter = 'none'
      if (layerFx.length) snap = runChain(snap, layerFx, fxEnv(project, clip, t, cw, ch, scale * (ch / Math.max(1, H))))
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = alpha
      ctx.drawImage(snap.canvas, 0, 0)
      ctx.restore()
    } finally {
      release(snap)
    }
  }
  ctx.save()
  ctx.globalAlpha = alpha
  drawFilterOverlays(ctx, f, { x: 0, y: 0, w: W, h: H }, t)
  ctx.restore()
  return { x: 0, y: 0, w: W, h: H }
}

function textGlitchFx() {
  const def = effectDef('glitch')
  return { inst: { id: 'text-glitch', type: 'glitch', on: true, params: {} }, def, p: { amount: 65, speed: 70 } }
}

/**
 * Draw one instant of the timeline. `scale` = canvas pixels per project pixel
 * (1 for export, <1 for a downscaled preview). Used by preview, export and thumbnails.
 * Drawing is clipped to the project rect, so a letterboxed export matches the preview (nothing — slides,
 * pushes, off-frame clips, adjustment snapshots — reaches the bars).
 */
export function drawFrame(ctx, project, t, frames, scale) {
  const W = project.width * scale
  const H = project.height * scale
  ctx.save()
  try {
    ctx.beginPath()
    ctx.rect(0, 0, W, H)
    ctx.clip()
    ctx.globalAlpha = 1
    ctx.fillStyle = project.background
    ctx.fillRect(0, 0, W, H)
    for (const it of layerItemsAt(project, t)) {
      if (it.kind === 'clip') {
        drawClip(ctx, project, it.clip, t, frames, scale)
        continue
      }
      const { a, b, tr } = it.rt
      const sides = makeSides(ctx, project, t, frames, scale, a, b, W, H)
      try {
        drawTransition(ctx, tr.type, it.p, W, H, sides.drawA, sides.drawB, (a?.kind === 'video' || a?.kind === 'image') && !!b, sides, t)
      } finally {
        sides.releaseAll()
      }
    }
  } finally {
    ctx.restore()
  }
}

/** Copy what has been drawn on `ctx` so far into layer `l` (in drawFrame coordinates). */
function copyBelow(ctx, l) {
  l.ctx.save()
  l.ctx.setTransform(ctx.getTransform().inverse())
  l.ctx.drawImage(ctx.canvas, 0, 0)
  l.ctx.restore()
}

/** Transition sides: draw straight onto ctx, or render into a full-frame layer for pixel tricks. */
function makeSides(ctx, project, t, frames, scale, a, b, W, H) {
  const borrowed = []
  const drawSide = (clip) => (m) => (clip ? drawClip(ctx, project, clip, t, frames, scale, m) : null)
  const layerSide = (clip) => (m) => {
    const l = acquire(Math.ceil(W), Math.ceil(H))
    borrowed.push(l)
    // an adjustment layer filters what is below it, so its side is "the picture below, adjusted"
    if (clip?.kind === 'adjustment') copyBelow(ctx, l)
    if (clip) drawClip(l.ctx, project, clip, t, frames, scale, m)
    return l
  }
  return {
    drawA: drawSide(a),
    drawB: drawSide(b),
    layerA: layerSide(a),
    layerB: layerSide(b),
    hasA: !!a,
    hasB: !!b,
    /** Sides can be cross-mixed as layers (adjustment layers mix in place instead). */
    mixable: !!a && !!b && a.kind !== 'adjustment' && b.kind !== 'adjustment',
    /** B is an opaque, unrotated, full-alpha picture covering A's whole rect (cheap in-place dissolve is exact). */
    bCoversA: () => coversOpaque(project, b, a, t, frames, scale, W, H),
    releaseAll: () => release(...borrowed.splice(0)),
  }
}

function coversOpaque(project, b, a, t, frames, scale, W, H) {
  if (!a || !b || b.kind !== 'video' || a.kind === 'adjustment') return false
  const fxB = activeEffects(b.effects)
  if (fxB.some((f) => f.def.process || f.def.trail)) return false
  if (hasFilter(b.filter) && /blur\(/.test(resolveFilter(b.filter, scale).css)) return false
  const gb = clipGeometry(
    project,
    b,
    t,
    frames,
    scale,
    {},
    fxB.filter((f) => f.def.motion),
    W,
    H,
  )
  if (!gb || !gb.frame || gb.rot || gb.alpha < 1 - 1e-6) return false
  const fxA = activeEffects(a.effects)
  // A with pixel effects may draw anywhere: B must cover the whole frame
  if (fxA.some((f) => f.def.process || f.def.trail)) return rectCovers(gb.rect, { x: 0, y: 0, w: W, h: H })
  const ga = clipGeometry(
    project,
    a,
    t,
    frames,
    scale,
    {},
    fxA.filter((f) => f.def.motion),
    W,
    H,
  )
  if (!ga) return true // A draws nothing
  const r = ga.rot ? rotatedBounds(ga.rect, ga.rot) : ga.rect
  // the visible part of A is inside the frame: B only has to cover that
  return rectCovers(gb.rect, intersect(r, { x: 0, y: 0, w: W, h: H }))
}

const rectCovers = (o, i) => !i || (o.x <= i.x + 0.5 && o.y <= i.y + 0.5 && o.x + o.w >= i.x + i.w - 0.5 && o.y + o.h >= i.y + i.h - 0.5)
function intersect(r, f) {
  const x = Math.max(r.x, f.x)
  const y = Math.max(r.y, f.y)
  const x2 = Math.min(r.x + r.w, f.x + f.w)
  const y2 = Math.min(r.y + r.h, f.y + f.h)
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null
}
function rotatedBounds(r, rot) {
  const c = Math.abs(Math.cos(rot))
  const s = Math.abs(Math.sin(rot))
  const w = r.w * c + r.h * s
  const h = r.w * s + r.h * c
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }
}

// ------------------------------------------------------------------ geometry (for on-canvas transform)

/**
 * Where a visual clip is drawn (base transform, no animation), in project pixels.
 * `source` is the media's display size (video/image).
 */
export function clipBounds(project, clip, source) {
  if (clip.kind === 'adjustment' || clip.kind === 'audio') return null
  const size = contentSize(project, clip, source ? { image: null, width: source.width, height: source.height } : null)
  if (!size) return null
  const w = size.w * clip.transform.scale
  const h = size.h * clip.transform.scale
  const cx = project.width / 2 + clip.transform.x
  const cy = project.height / 2 + clip.transform.y
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}
