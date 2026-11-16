import type { Clip, Project, Transition } from './types'
import { animState, ease } from './effects/animations'
import { defaultFilter, drawFilterOverlays, hasFilter, resolveFilter } from './effects/filters'
import { drawSticker, stickerBaseSize } from './effects/stickers'
import { drawTextAt, layoutText } from './effects/text'
import { drawTransition, type SideMods, type TransitionSides } from './effects/transitions'
import { activeEffects, effectDef, type FxEnv } from './effects/fx/videoEffects'
import { acquire, release, type Layer } from './effects/fx/util'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface FrameImage {
  image: CanvasImageSource
  width: number
  height: number
}

const EPS = 1e-6

export function clipEnd(c: Clip): number {
  return c.start + c.duration
}

export function isClipActive(c: Clip, t: number): boolean {
  return t >= c.start - EPS && t < clipEnd(c) - EPS
}

/** Timeline length = end of the last clip. */
export function timelineDuration(p: Project): number {
  let end = 0
  for (const c of p.clips) end = Math.max(end, clipEnd(c))
  return end
}

const isVisual = (c: Clip) => c.kind !== 'audio'

/** Visual clips active at t, ordered bottom layer → top layer (adjustment layers excluded). */
export function activeVisualClips(p: Project, t: number): Clip[] {
  const videoTracks = p.tracks.filter((tr) => tr.kind === 'video' && !tr.hidden)
  const out: Clip[] = []
  for (let i = videoTracks.length - 1; i >= 0; i--) {
    for (const c of p.clips) {
      if (c.trackId === videoTracks[i].id && isVisual(c) && c.kind !== 'adjustment' && isClipActive(c, t)) out.push(c)
    }
  }
  return out
}

/** Audio clips that should be heard (track not muted). */
export function audibleClips(p: Project): Clip[] {
  const muted = new Set(p.tracks.filter((t) => t.kind === 'audio' && t.muted).map((t) => t.id))
  const audioTrackIds = new Set(p.tracks.filter((t) => t.kind === 'audio').map((t) => t.id))
  return p.clips.filter((c) => c.kind === 'audio' && audioTrackIds.has(c.trackId) && !muted.has(c.trackId) && c.assetId)
}

/** Source time inside the clip's media for a timeline time. */
export function sourceTime(c: Clip, t: number): number {
  return c.in + (t - c.start)
}

// ------------------------------------------------------------------ transitions → layer items

export interface ResolvedTransition {
  tr: Transition
  a: Clip | null // outgoing
  b: Clip | null // incoming
  start: number
  end: number
}

/** Transitions whose clips still exist and (for cuts) still touch. Invalid ones are ignored. */
export function resolveTransitions(p: Project, trackId?: string): ResolvedTransition[] {
  const byId = new Map(p.clips.map((c) => [c.id, c]))
  const out: ResolvedTransition[] = []
  for (const tr of p.transitions ?? []) {
    if (trackId && tr.trackId !== trackId) continue
    const a = tr.leftId ? byId.get(tr.leftId) ?? null : null
    const b = tr.rightId ? byId.get(tr.rightId) ?? null : null
    if ((tr.leftId && !a) || (tr.rightId && !b) || (!a && !b)) continue
    if (a && a.trackId !== tr.trackId) continue
    if (b && b.trackId !== tr.trackId) continue
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

export type LayerItem = { kind: 'clip'; clip: Clip } | { kind: 'transition'; rt: ResolvedTransition; p: number }

/** Everything to draw at time t, bottom → top, with transitions resolved. */
export function layerItemsAt(p: Project, t: number): LayerItem[] {
  const tracks = p.tracks.filter((tr) => tr.kind === 'video' && !tr.hidden)
  const items: LayerItem[] = []
  for (let i = tracks.length - 1; i >= 0; i--) {
    const tr = tracks[i]
    const busy = new Set<string>()
    const trItems: LayerItem[] = []
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

const itemStart = (it: LayerItem) => (it.kind === 'clip' ? it.clip.start : it.rt.start)

function clampedSource(p: Project, c: Clip, t: number): number {
  const a = c.assetId ? p.assets.find((x) => x.id === c.assetId) : undefined
  const dur = a?.info.duration ?? Infinity
  const fps = a?.info.video?.fps || 30
  return Math.max(0, Math.min(sourceTime(c, t), dur - 0.5 / fps))
}

/** Media frames the renderer needs at t (video/image clips, including transition partners). */
export function frameRequests(p: Project, t: number): Array<{ clip: Clip; src: number }> {
  const out: Array<{ clip: Clip; src: number }> = []
  const push = (c: Clip | null) => {
    if (c && (c.kind === 'video' || c.kind === 'image')) out.push({ clip: c, src: clampedSource(p, c, t) })
  }
  for (const it of layerItemsAt(p, t)) {
    if (it.kind === 'clip') push(it.clip)
    else {
      push(it.rt.a)
      push(it.rt.b)
    }
  }
  return out
}

// ------------------------------------------------------------------ drawing

let measureCtx: OffscreenCanvasRenderingContext2D | null = null
function measurer(): OffscreenCanvasRenderingContext2D | null {
  measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d')
  return measureCtx
}
const measure = (font: string, text: string) => {
  const m = measurer()
  if (!m) return text.length * 10
  m.font = font
  return m.measureText(text).width
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Size of the clip's content in project px at scale 1 (before transform.scale). */
function contentSize(project: Project, clip: Clip, frame: FrameImage | null | undefined): { w: number; h: number } | null {
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

type FxList = ReturnType<typeof activeEffects>

function fxEnv(project: Project, clip: Clip, t: number, W: number, H: number, scale: number): FxEnv {
  return { t, local: t - clip.start, dur: clip.duration, W, H, k: (project.height * scale) / 1080 }
}

/** Run a layer through an effect chain; returns the final layer (caller releases it). */
function runChain(src: Layer, chain: FxList, env: FxEnv): Layer {
  let cur = src
  for (const f of chain) {
    const out = acquire(cur.canvas.width, cur.canvas.height)
    f.def.process!(cur, out, f.p, env)
    release(cur)
    cur = out
  }
  return cur
}

/** Draw one clip (with its effect stack); returns its (unrotated) rect in canvas px, or null. */
function drawClip(ctx: Ctx2D, project: Project, clip: Clip, t: number, frames: Map<string, FrameImage | null>, scale: number, mods: SideMods = {}): Rect | null {
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
      drawClipBody(ctx, project, clip, tt, frames, scale, { ...mods, alpha: (mods.alpha ?? 1) * fade ** i * 0.9 }, motion, layerFx, W, H)
    }
  }
  return drawClipBody(ctx, project, clip, t, frames, scale, mods, motion, layerFx, W, H)
}

function drawClipBody(ctx: Ctx2D, project: Project, clip: Clip, t: number, frames: Map<string, FrameImage | null>, scale: number, mods: SideMods, motion: FxList, layerFx: FxList, W: number, H: number): Rect | null {
  const anim = animState(clip, t, project.width, project.height)
  let mdx = 0
  let mdy = 0
  let mscale = 1
  let mrot = 0
  for (const m of motion) {
    const o = m.def.motion!(m.p, t - clip.start, clip.duration, project.width, project.height)
    mdx += o.dx ?? 0
    mdy += o.dy ?? 0
    mscale *= o.scale ?? 1
    mrot += o.rotate ?? 0
  }
  const alpha = Math.max(0, Math.min(1, clip.transform.opacity * anim.alpha * (mods.alpha ?? 1)))

  const frame = frames.get(clip.id)
  const size = contentSize(project, clip, frame)
  if (!size) return null
  const s = clip.transform.scale * anim.scale * mscale * (mods.scale ?? 1)
  const dw = size.w * s * scale
  const dh = size.h * s * scale
  const cx = W / 2 + (clip.transform.x + anim.dx + mdx) * scale + (mods.dx ?? 0)
  const cy = H / 2 + (clip.transform.y + anim.dy + mdy) * scale + (mods.dy ?? 0)
  const rect = { x: cx - dw / 2, y: cy - dh / 2, w: dw, h: dh }
  if (alpha <= 0 || dw < 0.5 || dh < 0.5) return rect

  const f = hasFilter(clip.filter) ? resolveFilter(clip.filter!, scale) : null
  const css = f && f.css !== 'none' ? f.css : ''
  const rot = ((clip.rotation ?? 0) + anim.rotate + mrot) * (Math.PI / 180)
  const blur = mods.blur && mods.blur > 0.05 ? `blur(${mods.blur.toFixed(2)}px)` : ''

  const paint = (c: Ctx2D, a: number, extraFilter: string) => {
    c.save()
    c.globalAlpha = a
    c.translate(cx, cy)
    if (rot) c.rotate(rot)
    const filt = [css, extraFilter].filter(Boolean).join(' ')
    if (filt) c.filter = filt
    if (clip.kind === 'text' && clip.text) {
      drawTextAt(c, clip.text, clip.text.size * s * scale, anim.reveal, clip.anim?.reveal ?? 'none', s * scale, t - clip.start, clip.duration)
    } else if (clip.kind === 'sticker' && clip.sticker) {
      drawSticker(c, clip.sticker, dw, dh)
    } else if (frame) {
      c.drawImage(frame.image, -dw / 2, -dh / 2, dw, dh)
    }
    if (filt) c.filter = 'none'
    if (f) drawFilterOverlays(c, f, { x: -dw / 2, y: -dh / 2, w: dw, h: dh }, t)
    c.restore()
  }

  if (!layerFx.length) {
    paint(ctx, alpha, blur)
    return rect
  }
  // effect stack: render the clip alone into a full-frame layer, process it, composite the result
  const layer = acquire(Math.ceil(W), Math.ceil(H))
  paint(layer.ctx, 1, '')
  const out = runChain(layer, layerFx, fxEnv(project, clip, t, layer.canvas.width, layer.canvas.height, scale))
  ctx.save()
  ctx.globalAlpha = alpha
  if (blur) ctx.filter = blur
  ctx.drawImage(out.canvas, 0, 0)
  ctx.restore()
  release(out)
  return rect
}

/** Adjustment layer: filter + effects applied to everything already drawn below. */
function drawAdjustment(ctx: Ctx2D, project: Project, clip: Clip, t: number, scale: number, mods: SideMods, layerFx: FxList): Rect {
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
    snap.ctx.filter = css
    snap.ctx.drawImage(ctx.canvas, 0, 0)
    snap.ctx.filter = 'none'
    if (layerFx.length) snap = runChain(snap, layerFx, fxEnv(project, clip, t, cw, ch, scale * (ch / Math.max(1, H))))
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = alpha
    ctx.drawImage(snap.canvas, 0, 0)
    ctx.restore()
    release(snap)
  }
  ctx.save()
  ctx.globalAlpha = alpha
  drawFilterOverlays(ctx, f, { x: 0, y: 0, w: W, h: H }, t)
  ctx.restore()
  return { x: 0, y: 0, w: W, h: H }
}

function textGlitchFx(): FxList[number] {
  const def = effectDef('glitch')!
  return { inst: { id: 'text-glitch', type: 'glitch', on: true, params: {} }, def, p: { amount: 65, speed: 70 } }
}

/**
 * Draw one instant of the timeline. `scale` = canvas pixels per project pixel
 * (1 for export, <1 for a downscaled preview). Used by preview, export and thumbnails.
 */
export function drawFrame(ctx: Ctx2D, project: Project, t: number, frames: Map<string, FrameImage | null>, scale: number): void {
  const W = project.width * scale
  const H = project.height * scale
  ctx.save()
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
    drawTransition(ctx, tr.type, it.p, W, H, sides.drawA, sides.drawB, a?.kind === 'video' || a?.kind === 'image', sides, t)
    sides.releaseAll()
  }
  ctx.restore()
}

/** Transition sides: draw straight onto ctx, or render into a full-frame layer for pixel tricks. */
function makeSides(ctx: Ctx2D, project: Project, t: number, frames: Map<string, FrameImage | null>, scale: number, a: Clip | null, b: Clip | null, W: number, H: number): TransitionSides {
  const borrowed: Layer[] = []
  const drawSide = (clip: Clip | null) => (m?: SideMods) => (clip ? drawClip(ctx, project, clip, t, frames, scale, m) : null)
  const layerSide = (clip: Clip | null) => (m?: SideMods) => {
    const l = acquire(Math.ceil(W), Math.ceil(H))
    borrowed.push(l)
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
    releaseAll: () => release(...borrowed.splice(0)),
  }
}

// ------------------------------------------------------------------ geometry (for on-canvas transform)

export interface Bounds {
  /** Top-left corner and size, in project pixels. */
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where a visual clip is drawn (base transform, no animation), in project pixels.
 * `source` is the media's display size (video/image).
 */
export function clipBounds(project: Project, clip: Clip, source: { width: number; height: number } | null): Bounds | null {
  if (clip.kind === 'adjustment' || clip.kind === 'audio') return null
  const size = contentSize(project, clip, source ? { image: null as unknown as CanvasImageSource, width: source.width, height: source.height } : null)
  if (!size) return null
  const w = size.w * clip.transform.scale
  const h = size.h * clip.transform.scale
  const cx = project.width / 2 + clip.transform.x
  const cy = project.height / 2 + clip.transform.y
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}
