import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clipEnd, resolveTransitions, timelineDuration } from '../../media/compositor'
import { FILTER_PRESETS, hasFilter } from '../../media/effects/filters'
import { hasAnim } from '../../media/effects/animations'
import { stickerDef } from '../../media/effects/stickers'
import { TEXT_PRESETS } from '../../media/effects/text'
import { transitionLabel } from '../../media/effects/transitions'
import { importFiles } from '../actions'
import { preview } from '../playback'
import {
  addAdjustmentLayer,
  addSticker,
  addTextPreset,
  addTrack,
  addTransition,
  addEffect,
  applyFilterPreset,
  applyTextFx,
  beginGesture,
  deleteSelection,
  endGesture,
  getState,
  linkedIds,
  placeAsset,
  removeTrack,
  overlapsOnTrack,
  placeWithoutOverlap,
  setState,
  splitAtPlayhead,
  transitionTargetAt,
  updateGesture,
  updateTrack,
  useStore,
} from '../store'
import { audioTracks, baseVideoTrack, formatDuration } from '../model'
import { ASSET_MIME, EFFECT_MIME, dragState } from './dragState'
import { Icon, IconButton } from './ui'
import { renderTransitionThumb } from './fxThumbs'
import { Thumb } from './Thumb'

const HEADER_W = 136
const RULER_H = 26
const TRACK_H = { video: 58, audio: 46 }
const SNAP_PX = 8
export const MIN_ZOOM = 4
export const MAX_ZOOM = 800

/** How far a trim may extend before hitting the nearest neighbour on each clip's own track. */
function trimLimits(p, ids) {
  const set = new Set(ids)
  let minStartDelta = -Infinity
  let maxEndDelta = Infinity
  for (const id of ids) {
    const c = p.clips.find((x) => x.id === id)
    if (!c) continue
    for (const o of p.clips) {
      if (o.trackId !== c.trackId || set.has(o.id)) continue
      if (clipEnd(o) <= c.start + 1e-6) minStartDelta = Math.max(minStartDelta, clipEnd(o) - c.start)
      if (o.start >= clipEnd(c) - 1e-6) maxEndDelta = Math.min(maxEndDelta, o.start - clipEnd(c))
    }
  }
  return { minStartDelta, maxEndDelta }
}

/** "+1.20s" / "−5.00s" (formatDuration only handles non-negative values). */
const signed = (v) => `${v < 0 ? '−' : '+'}${formatDuration(Math.abs(v))}`

function snapCandidates(p, exclude, time) {
  const t = [0, time]
  for (const c of p.clips) {
    if (exclude.has(c.id)) continue
    t.push(c.start, clipEnd(c))
  }
  return t
}

function snapValue(v, targets, threshold) {
  let best = null
  let bestD = threshold
  for (const t of targets) {
    const d = Math.abs(t - v)
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return best === null ? { v, snapped: null } : { v: best, snapped: best }
}

function tickStep(zoom, fps) {
  const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  return steps.find((s) => s * zoom >= 70) ?? 600
}

function tickLabel(t, step, fps) {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  if (step < 1) {
    const f = Math.round((t - Math.floor(t)) * fps)
    return `${m}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

export function Timeline() {
  const project = useStore((s) => s.project)
  const zoom = useStore((s) => s.zoom)
  const time = useStore((s) => s.time)
  const selection = useStore((s) => s.selection)
  const snapping = useStore((s) => s.snapping)
  const playing = useStore((s) => s.playing)
  const scrollRef = useRef(null)
  const [scrollX, setScrollX] = useState(0)
  const [viewW, setViewW] = useState(800)
  const [snapLine, setSnapLine] = useState(null)
  const [ghost, setGhost] = useState(null)
  const [dropMark, setDropMark] = useState(null)
  const [dropClip, setDropClip] = useState(null)
  /** Rubber-band selection box, in tl-content coordinates. */
  const [marquee, setMarquee] = useState(null)
  const contentRef = useRef(null)
  const selectedTransitionId = useStore((s) => s.selectedTransitionId)
  const [trimTip, setTrimTip] = useState(null)
  const drag = useRef(null)
  const handlers = useRef({ move: () => {}, up: () => {} })
  const scrubbing = useRef(false)
  const pendingZoomAnchor = useRef(null)

  const duration = timelineDuration(project)
  const contentW = Math.max(duration + 30, (viewW - HEADER_W) / zoom) * zoom
  const assetById = useMemo(() => new Map(project.assets.map((a) => [a.id, a])), [project.assets])
  const selected = useMemo(() => new Set(selection), [selection])

  // ---------------------------------------------------------------- layout & scroll
  useEffect(() => {
    const el = scrollRef.current
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    const onScroll = () => setScrollX(el.scrollLeft)
    el.addEventListener('scroll', onScroll, { passive: true })
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left - HEADER_W
      const z = getState().zoom
      const t = (el.scrollLeft + px) / z
      const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * Math.exp(-e.deltaY * 0.003)))
      pendingZoomAnchor.current = { t, px }
      setState({ zoom: nz })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
    }
  }, [])

  // Keep the time under the mouse fixed while zooming.
  useLayoutEffect(() => {
    const a = pendingZoomAnchor.current
    const el = scrollRef.current
    if (a && el) {
      el.scrollLeft = Math.max(0, a.t * zoom - a.px)
      pendingZoomAnchor.current = null
    }
  }, [zoom])

  // Follow the playhead during playback (page-style), unless the user is scrubbing.
  useEffect(() => {
    if (!playing) return
    const el = scrollRef.current
    if (!el) return
    const x = time * zoom
    const visible = el.clientWidth - HEADER_W
    if (x < el.scrollLeft || x > el.scrollLeft + visible - 30) el.scrollLeft = Math.max(0, x - 40)
  }, [time, zoom, playing])

  const fit = () => {
    const el = scrollRef.current
    if (!el) return
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (el.clientWidth - HEADER_W - 40) / Math.max(duration, 5)))
    setState({ zoom: z })
    el.scrollLeft = 0
  }
  useEffect(() => {
    const h = () => fit()
    window.addEventListener('nle:fit-timeline', h)
    return () => window.removeEventListener('nle:fit-timeline', h)
  })

  const zoomBy = (f) => {
    const el = scrollRef.current
    const px = (el?.clientWidth ?? 800) / 2 - HEADER_W
    pendingZoomAnchor.current = { t: ((el?.scrollLeft ?? 0) + px) / zoom, px }
    setState({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * f)) })
  }

  const timeAtClientX = (clientX) => {
    const el = scrollRef.current
    const rect = el.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left - HEADER_W + el.scrollLeft) / zoom)
  }

  // ---------------------------------------------------------------- ruler scrub
  const onRulerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubbing.current = true
    seekFromPointer(e)
  }
  const seekFromPointer = (e) => {
    let t = timeAtClientX(e.clientX)
    if (snapping !== e.shiftKey) {
      const st = getState()
      t = snapValue(
        t,
        snapCandidates(st.project, new Set(), -1).filter((x) => x >= 0),
        SNAP_PX / zoom,
      ).v
    }
    preview.seek(t)
  }

  // ---------------------------------------------------------------- clip drag / trim
  const onClipDown = (e, clip, mode) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const st = getState()
    const track = st.project.tracks.find((t) => t.id === clip.trackId)
    let sel = st.selection
    if (e.shiftKey || e.metaKey) sel = sel.includes(clip.id) ? sel.filter((x) => x !== clip.id) : [...sel, clip.id]
    else if (!sel.includes(clip.id)) sel = [clip.id]
    setState({ selection: sel, sideTab: 'inspector', selectedTransitionId: null })
    if (track?.locked) return
    const lockedTracks = new Set(st.project.tracks.filter((t) => t.locked).map((t) => t.id))
    const ids = (mode === 'move' ? linkedIds(st.project, sel.includes(clip.id) ? sel : [clip.id]) : linkedIds(st.project, [clip.id])).filter((id) => {
      const c = st.project.clips.find((x) => x.id === id)
      return c && !lockedTracks.has(c.trackId)
    })
    const orig = new Map(
      st.project.clips
        .filter((c) => ids.includes(c.id))
        .map((c) => [c.id, { start: c.start, in: c.in, duration: c.duration, trackId: c.trackId, kind: c.kind }]),
    )
    // Listen on window, not via pointer capture: moving a clip to another track re-mounts its element
    // under a different lane, which would drop the capture and lose the release (leaving an overlap).
    const move = (ev) => handlers.current.move(ev)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
      handlers.current.up()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
    drag.current = {
      mode,
      x0: e.clientX,
      y0: e.clientY,
      primary: clip,
      ids,
      orig,
      targets: snapCandidates(st.project, new Set(ids), st.time),
      ...trimLimits(st.project, ids),
      moved: false,
      apply: null,
    }
    beginGesture()
  }

  const onClipMove = (e) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3 && Math.abs(e.clientY - d.y0) < 3) return
    d.moved = true
    const p0 = getState().project
    const dx = (e.clientX - d.x0) / zoom
    const snapOn = snapping !== e.shiftKey
    const thr = SNAP_PX / zoom
    const fps = p0.fps
    const minDur = 1 / fps
    const o = d.orig.get(d.primary.id)
    let snapped = null

    if (d.mode === 'move') {
      let delta = dx
      if (snapOn) {
        let best = thr
        for (const oc of d.orig.values()) {
          for (const edge of [oc.start, oc.start + oc.duration]) {
            for (const t of d.targets) {
              const diff = t - (edge + delta)
              if (Math.abs(diff) < Math.abs(best)) {
                best = diff
                snapped = t
              }
            }
          }
        }
        if (snapped !== null) delta += best
      }
      const minStart = Math.min(...[...d.orig.values()].map((x) => x.start))
      if (minStart + delta < 0) {
        delta = -minStart
        snapped = null
      }
      // Vertical move between tracks of the same kind.
      const kindTracks = p0.tracks.filter((t) => t.kind === p0.tracks.find((x) => x.id === o.trackId)?.kind)
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-track-id]')
      const hitIdx = hit ? kindTracks.findIndex((t) => t.id === hit.dataset.trackId) : -1
      const shift = hitIdx >= 0 ? hitIdx - kindTracks.findIndex((t) => t.id === o.trackId) : 0
      const primaryKind = kindTracks[0]?.kind
      d.apply = (p) => {
        for (const c of p.clips) {
          const oc = d.orig.get(c.id)
          if (!oc) continue
          c.start = Math.max(0, oc.start + delta)
          const trKind = p.tracks.find((t) => t.id === oc.trackId)?.kind
          if (shift !== 0 && trKind === primaryKind) {
            const idx = kindTracks.findIndex((t) => t.id === oc.trackId) + shift
            const dest = kindTracks[idx]
            if (dest && !dest.locked) c.trackId = dest.id
          }
        }
      }
      setTrimTip({ x: e.clientX, y: e.clientY, text: `${signed(delta)}` })
    } else {
      const asset = d.primary.assetId ? assetById.get(d.primary.assetId) : undefined
      const media = d.primary.kind === 'video' || d.primary.kind === 'audio'
      const srcDur = asset?.info.duration ?? Infinity
      if (d.mode === 'trim-start') {
        let ns = o.start + dx
        if (snapOn) {
          const r = snapValue(ns, d.targets, thr)
          ns = r.v
          snapped = r.snapped
        }
        ns = Math.min(ns, o.start + o.duration - minDur)
        if (media) ns = Math.max(ns, o.start - o.in)
        ns = Math.max(0, ns, o.start + d.minStartDelta)
        const delta = ns - o.start
        d.apply = (p) => {
          for (const c of p.clips) {
            const oc = d.orig.get(c.id)
            if (!oc) continue
            c.start = oc.start + delta
            c.in = Math.max(0, oc.in + delta)
            c.duration = oc.duration - delta
          }
        }
        setTrimTip({ x: e.clientX, y: e.clientY, text: `${signed(delta)} · ${formatDuration(o.duration - delta)}` })
      } else {
        let ne = o.start + o.duration + dx
        if (snapOn) {
          const r = snapValue(ne, d.targets, thr)
          ne = r.v
          snapped = r.snapped
        }
        ne = Math.max(ne, o.start + minDur)
        if (media) ne = Math.min(ne, o.start + srcDur - o.in)
        ne = Math.min(ne, o.start + o.duration + d.maxEndDelta)
        const delta = ne - (o.start + o.duration)
        d.apply = (p) => {
          for (const c of p.clips) {
            const oc = d.orig.get(c.id)
            if (!oc) continue
            c.duration = Math.max(minDur, oc.duration + delta)
          }
        }
        setTrimTip({ x: e.clientX, y: e.clientY, text: `${signed(delta)} · ${formatDuration(o.duration + delta)}` })
      }
    }
    setSnapLine(snapped)
    updateGesture(d.apply)
    if (d.mode === 'move') {
      const p1 = getState().project
      const c = p1.clips.find((x) => x.id === d.primary.id)
      if (c && overlapsOnTrack(p1, c.trackId, c.start, c.start + c.duration, new Set(d.ids))) {
        setTrimTip((tip) => (tip ? { ...tip, text: `${tip.text} · → new track` } : tip))
      }
    }
  }

  const onClipUp = () => {
    const d = drag.current
    drag.current = null
    setSnapLine(null)
    setTrimTip(null)
    if (!d) return
    if (d.moved && d.apply) {
      updateGesture((p) => {
        d.apply(p)
        if (d.mode !== 'move') return
        // No overwrite: a moved clip that lands on another clip goes to a free/new track instead.
        // Moving clips that haven't been settled yet aren't obstacles; settled ones are.
        const pending = new Set(d.ids)
        for (const id of [d.primary.id, ...d.ids.filter((x) => x !== d.primary.id)]) {
          pending.delete(id)
          const c = p.clips.find((x) => x.id === id)
          if (c) placeWithoutOverlap(p, c, pending)
        }
      })
      endGesture(d.mode === 'move' ? (d.ids.length > 1 ? `Move ${d.ids.length} clips` : 'Move clip') : 'Trim clip')
    } else endGesture('')
  }

  useLayoutEffect(() => {
    handlers.current = { move: onClipMove, up: onClipUp }
  })

  // ---------------------------------------------------------------- empty-space click = seek, drag = box select
  const onLanePointerDown = (e) => {
    if (e.button !== 0) return
    const x0 = e.clientX
    const y0 = e.clientY
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    const base = additive ? getState().selection : []
    let dragging = false
    const scroller = scrollRef.current
    const sx0 = scroller.scrollLeft
    const sy0 = scroller.scrollTop
    let last = { x: x0, y: y0 }
    let raf = 0
    const select = () => {
      // box in client coords, compensating for any auto-scroll since the drag began
      const dx = scroller.scrollLeft - sx0
      const dy = scroller.scrollTop - sy0
      const bx0 = Math.min(x0 - dx, last.x)
      const bx1 = Math.max(x0 - dx, last.x)
      const by0 = Math.min(y0 - dy, last.y)
      const by1 = Math.max(y0 - dy, last.y)
      const cr = contentRef.current.getBoundingClientRect()
      setMarquee({ left: bx0 - cr.left, top: by0 - cr.top, width: bx1 - bx0, height: by1 - by0 })
      const hit = []
      scroller.querySelectorAll('.clip[data-clip-id]').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.right > bx0 && r.left < bx1 && r.bottom > by0 && r.top < by1) hit.push(el.dataset.clipId)
      })
      setState({ selection: [...new Set([...base, ...hit])], selectedTransitionId: null, sideTab: 'inspector' })
    }
    const autoScroll = () => {
      // drag near the scroller's edges scrolls the timeline
      const r = scroller.getBoundingClientRect()
      const edge = 30
      let vx = 0
      let vy = 0
      if (last.x < r.left + HEADER_W + edge) vx = -12
      else if (last.x > r.right - edge) vx = 12
      if (last.y < r.top + RULER_H + edge) vy = -8
      else if (last.y > r.bottom - edge) vy = 8
      if (vx || vy) {
        scroller.scrollLeft += vx
        scroller.scrollTop += vy
        select()
      }
      raf = requestAnimationFrame(autoScroll)
    }
    const move = (ev) => {
      last = { x: ev.clientX, y: ev.clientY }
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      if (!dragging) {
        dragging = true
        raf = requestAnimationFrame(autoScroll)
      }
      select()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      cancelAnimationFrame(raf)
      setMarquee(null)
      if (!dragging) {
        // plain click on empty space: move the playhead and clear the selection
        if (!additive) setState({ selection: [], selectedTransitionId: null })
        preview.seek(timeAtClientX(x0))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // ---------------------------------------------------------------- drop from bin / OS
  const clearDropHints = () => {
    setGhost(null)
    setDropMark(null)
    setDropClip(null)
  }

  /** Gallery items: text/sticker/adjustment → new clip, transition → cut, filter → clip under pointer. */
  const effectDragOver = (e, track, fx) => {
    const st = getState()
    let t = timeAtClientX(e.clientX)
    if (track.kind !== 'video') return clearDropHints()
    if (fx.kind === 'transition') {
      const target = transitionTargetAt(st.project, track.id, t, Math.max(0.15, 36 / zoom))
      setDropMark(target ? { trackId: track.id, at: target.at } : null)
      if (!target) return
    } else if (fx.kind === 'filter' || fx.kind === 'effect' || fx.kind === 'textfx') {
      const c = st.project.clips.find(
        (x) => x.trackId === track.id && (fx.kind === 'textfx' ? x.kind === 'text' : x.kind !== 'audio') && t >= x.start && t < clipEnd(x),
      )
      setDropClip(c?.id ?? null)
      if (!c) return
    } else {
      if (snapping !== e.shiftKey) t = snapValue(t, snapCandidates(st.project, new Set(), st.time), SNAP_PX / zoom).v
      const dur = fx.kind === 'text' ? (TEXT_PRESETS.find((x) => x.id === fx.presetId)?.make(1920, 1080).duration ?? 4) : fx.kind === 'sticker' ? 3 : 5
      setGhost({ trackId: track.id, start: t, duration: dur })
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const effectDrop = (e, track, fx) => {
    const st = getState()
    const t = ghost?.start ?? timeAtClientX(e.clientX)
    clearDropHints()
    if (track.kind !== 'video') return
    if (fx.kind === 'text') addTextPreset(fx.presetId, { start: t, trackId: track.id })
    else if (fx.kind === 'sticker') addSticker(fx.sticker, { start: t, trackId: track.id })
    else if (fx.kind === 'adjustment') addAdjustmentLayer(fx.presetId, { start: t, trackId: track.id })
    else if (fx.kind === 'transition') {
      const target = transitionTargetAt(st.project, track.id, timeAtClientX(e.clientX), Math.max(0.15, 36 / zoom))
      if (target) addTransition(track.id, target.leftId, target.rightId, fx.type)
    } else if (fx.kind === 'filter' || fx.kind === 'effect' || fx.kind === 'textfx') {
      const at = timeAtClientX(e.clientX)
      const c = st.project.clips.find(
        (x) => x.trackId === track.id && (fx.kind === 'textfx' ? x.kind === 'text' : x.kind !== 'audio') && at >= x.start && at < clipEnd(x),
      )
      if (!c) return
      const ok =
        fx.kind === 'filter' ? applyFilterPreset([c.id], fx.presetId) : fx.kind === 'effect' ? addEffect([c.id], fx.type) : (applyTextFx([c.id], fx.fx), true)
      if (ok) setState({ selection: [c.id], sideTab: 'inspector' })
    }
  }

  const onLaneDragOver = (e, track) => {
    if (e.dataTransfer.types.includes(EFFECT_MIME) && dragState.effect) return effectDragOver(e, track, dragState.effect)
    const isAsset = e.dataTransfer.types.includes(ASSET_MIME)
    const isFiles = e.dataTransfer.types.includes('Files')
    if (!isAsset && !isFiles) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    let t = timeAtClientX(e.clientX)
    const st = getState()
    if (snapping !== e.shiftKey) t = snapValue(t, snapCandidates(st.project, new Set(), st.time), SNAP_PX / zoom).v
    const asset = dragState.assetId ? assetById.get(dragState.assetId) : undefined
    setGhost({ trackId: track.id, start: t, duration: asset ? asset.info.duration : 5 })
  }

  const onLaneDrop = async (e, track) => {
    e.preventDefault()
    e.stopPropagation()
    const fxRaw = e.dataTransfer.getData(EFFECT_MIME)
    if (fxRaw) {
      try {
        effectDrop(e, track, JSON.parse(fxRaw))
      } catch {
        clearDropHints()
      }
      return
    }
    const start = ghost?.start ?? timeAtClientX(e.clientX)
    setGhost(null)
    const st = getState()
    const placeOn = (assetId, at) => {
      const a = getState().project.assets.find((x) => x.id === assetId)
      if (!a) return at
      const vt = track.kind === 'video' ? track.id : baseVideoTrack(st.project)?.id
      const at2 = track.kind === 'audio' ? track.id : audioTracks(st.project)[0]?.id
      placeAsset(assetId, { start: at, videoTrackId: vt, audioTrackId: at2 })
      return at + a.info.duration
    }
    const id = e.dataTransfer.getData(ASSET_MIME)
    if (id) {
      placeOn(id, start)
      return
    }
    if (e.dataTransfer.files.length) {
      const added = await importFiles(e.dataTransfer.files)
      let at = start
      for (const a of added) at = placeOn(a.id, at)
    }
  }

  // ---------------------------------------------------------------- render
  const step = tickStep(zoom, project.fps)
  const t0 = Math.floor(Math.max(0, scrollX / zoom) / step) * step
  const t1 = (scrollX + viewW) / zoom
  const ticks = []
  for (let t = t0; t <= t1 && ticks.length < 400; t += step) ticks.push(t)

  return (
    <section className="panel timeline" aria-label="Timeline">
      <div className="tl-toolbar">
        <IconButton
          icon="magnet"
          label={snapping ? 'Snapping on' : 'Snapping off'}
          shortcut="N · hold Shift to invert"
          active={snapping}
          onClick={() => setState({ snapping: !snapping })}
        />
        <IconButton icon="scissors" label="Split at playhead" shortcut="S" onClick={splitAtPlayhead} />
        <IconButton
          icon="trash"
          label="Delete selected"
          shortcut="Del · ⇧Del ripple"
          onClick={() => deleteSelection(false)}
          disabled={!selection.length}
          disabledReason="Select a clip to delete"
        />
        <span className="tl-sep" />
        <button type="button" className="btn btn-small btn-ghost" onClick={() => addTrack('video')} title="Add video track">
          <Icon name="plus" size={12} /> Video
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={() => addTrack('audio')} title="Add audio track">
          <Icon name="plus" size={12} /> Audio
        </button>
        <div className="topbar-spacer" />
        <span className="tl-info">
          {project.clips.length} clips · {formatDuration(duration)}
        </span>
        <IconButton icon="zoomOut" label="Zoom out" shortcut="−" onClick={() => zoomBy(1 / 1.5)} />
        <input
          className="zoom-slider"
          type="range"
          min={Math.log(MIN_ZOOM)}
          max={Math.log(MAX_ZOOM)}
          step={0.01}
          value={Math.log(zoom)}
          onChange={(e) => setState({ zoom: Math.exp(Number(e.target.value)) })}
          aria-label="Timeline zoom"
          title="Zoom (⌘/Ctrl + scroll)"
        />
        <IconButton icon="zoomIn" label="Zoom in" shortcut="=" onClick={() => zoomBy(1.5)} />
        <IconButton icon="fit" label="Zoom to fit" shortcut="\\" onClick={fit} />
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-content" ref={contentRef} style={{ width: HEADER_W + contentW }}>
          <div className="tl-ruler-row" style={{ height: RULER_H }}>
            <div className="tl-corner" style={{ width: HEADER_W }} />
            <div
              className="tl-ruler"
              style={{ width: contentW }}
              onPointerDown={onRulerDown}
              onPointerMove={(e) => scrubbing.current && seekFromPointer(e)}
              onPointerUp={() => (scrubbing.current = false)}
            >
              {ticks.map((t) => (
                <div key={t.toFixed(4)} className="tick" style={{ left: t * zoom }}>
                  <span>{tickLabel(t, step, project.fps)}</span>
                </div>
              ))}
              <div className="playhead-head" style={{ left: time * zoom }} />
            </div>
          </div>
          {project.tracks.map((track) => (
            <div key={track.id} className={`tl-row tl-row-${track.kind}${track.locked ? ' locked' : ''}`} style={{ height: TRACK_H[track.kind] }}>
              <TrackHeader track={track} />
              <div
                className="tl-lane"
                data-track-id={track.id}
                style={{ width: contentW }}
                onPointerDown={onLanePointerDown}
                onDragOver={(e) => onLaneDragOver(e, track)}
                onDragLeave={clearDropHints}
                onDrop={(e) => void onLaneDrop(e, track)}
              >
                {project.clips
                  .filter((c) => c.trackId === track.id)
                  .map((c) => (
                    <ClipView
                      key={c.id}
                      clip={c}
                      zoom={zoom}
                      selected={selected.has(c.id)}
                      linkedSelected={!!c.linkId && !selected.has(c.id) && project.clips.some((x) => x.linkId === c.linkId && selected.has(x.id))}
                      thumb={c.assetId ? assetById.get(c.assetId)?.thumb : undefined}
                      name={clipName(c, c.assetId ? assetById.get(c.assetId)?.name : undefined)}
                      missing={!!c.assetId && !assetById.has(c.assetId)}
                      dropTarget={dropClip === c.id}
                      onDown={onClipDown}
                    />
                  ))}
                {track.kind === 'video' &&
                  resolveTransitions(project, track.id).map((rt) => (
                    <TransitionBadge key={rt.tr.id} rt={rt} zoom={zoom} selected={selectedTransitionId === rt.tr.id} />
                  ))}
                {dropMark && dropMark.trackId === track.id && <div className="tr-drop-mark" style={{ left: dropMark.at * zoom }} />}
                {ghost && ghost.trackId === track.id && (
                  <div className="clip-ghost" style={{ left: ghost.start * zoom, width: Math.max(4, ghost.duration * zoom) }} />
                )}
              </div>
            </div>
          ))}
          <div className="tl-add-row" style={{ paddingLeft: HEADER_W }} />
          <div className="playhead" style={{ left: HEADER_W + time * zoom }} />
          {snapLine !== null && <div className="snap-line" style={{ left: HEADER_W + snapLine * zoom }} />}
          {marquee && <div className="marquee" style={marquee} />}
        </div>
      </div>
      {trimTip && (
        <div className="drag-tip" style={{ left: trimTip.x + 14, top: trimTip.y - 30 }}>
          {trimTip.text}
        </div>
      )}
    </section>
  )
}

function TrackHeader({ track }) {
  return (
    <div className="tl-head" style={{ width: HEADER_W }}>
      <span className="tl-head-name">{track.name}</span>
      <div className="tl-head-btns">
        {track.kind === 'video' ? (
          <IconButton
            icon={track.hidden ? 'eyeOff' : 'eye'}
            label={track.hidden ? 'Show track' : 'Hide track'}
            size={14}
            active={track.hidden}
            onClick={() => updateTrack(track.id, track.hidden ? 'Show track' : 'Hide track', { hidden: !track.hidden })}
          />
        ) : (
          <IconButton
            icon={track.muted ? 'mute' : 'volume'}
            label={track.muted ? 'Unmute track' : 'Mute track'}
            size={14}
            active={track.muted}
            onClick={() => updateTrack(track.id, track.muted ? 'Unmute track' : 'Mute track', { muted: !track.muted })}
          />
        )}
        <IconButton
          icon={track.locked ? 'lock' : 'unlock'}
          label={track.locked ? 'Unlock track' : 'Lock track'}
          size={14}
          active={track.locked}
          onClick={() => updateTrack(track.id, track.locked ? 'Unlock track' : 'Lock track', { locked: !track.locked })}
        />
        <button
          type="button"
          className="tl-head-del"
          title={`Delete track ${track.name}`}
          aria-label={`Delete track ${track.name}`}
          onClick={() => removeTrack(track.id)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  )
}

function ClipView(props) {
  const { clip: c, zoom } = props
  const w = Math.max(2, c.duration * zoom)
  const fadeInW = c.audio.fadeIn * zoom
  const fadeOutW = c.audio.fadeOut * zoom
  return (
    <div
      className={`clip clip-${c.kind}${props.selected ? ' selected' : ''}${props.linkedSelected ? ' linked' : ''}${props.missing ? ' missing' : ''}${w < 40 ? ' narrow' : ''}${props.dropTarget ? ' drop-target' : ''}`}
      style={{ left: c.start * zoom, width: w }}
      onPointerDown={(e) => props.onDown(e, c, 'move')}
      title={`${props.name}\n${formatDuration(c.start)} → ${formatDuration(c.start + c.duration)} (${formatDuration(c.duration)})`}
      data-clip-id={c.id}
    >
      {(c.kind === 'video' || c.kind === 'image') && props.thumb && <div className="clip-thumbs" style={{ backgroundImage: `url(${props.thumb})` }} />}
      {c.kind === 'audio' && <div className="clip-wave" />}
      <div className="clip-label">
        {props.missing ? '⚠ ' : ''}
        {props.name}
      </div>
      {(hasFilter(c.filter) || hasAnim(c.anim) || !!c.effects?.some((e) => e.on) || (c.text?.fx && c.text.fx !== 'none')) && (
        <div className="clip-badges">
          {(hasFilter(c.filter) || c.effects?.some((e) => e.on)) && (
            <span
              title={[
                hasFilter(c.filter) ? `Filter: ${FILTER_PRESETS.find((f) => f.id === c.filter.preset)?.label ?? 'custom'}` : '',
                ...(c.effects ?? []).filter((e) => e.on).map((e) => e.type),
              ]
                .filter(Boolean)
                .join(', ')}
            >
              fx{(c.effects?.filter((e) => e.on).length ?? 0) > 1 ? ` ${c.effects.filter((e) => e.on).length}` : ''}
            </span>
          )}
          {(hasAnim(c.anim) || (c.text?.fx && c.text.fx !== 'none')) && <span title="Animated">✦</span>}
        </div>
      )}
      {c.kind === 'audio' && (fadeInW > 1 || fadeOutW > 1) && (
        <svg className="clip-fades" width={w} height="100%" viewBox={`0 0 ${w} 100`} preserveAspectRatio="none" aria-hidden="true">
          {fadeInW > 1 && <polygon points={`0,0 ${fadeInW},0 0,100`} />}
          {fadeOutW > 1 && <polygon points={`${w},0 ${w - fadeOutW},0 ${w},100`} />}
        </svg>
      )}
      <div className="trim trim-l" onPointerDown={(e) => props.onDown(e, c, 'trim-start')} title="Trim start" />
      <div className="trim trim-r" onPointerDown={(e) => props.onDown(e, c, 'trim-end')} title="Trim end" />
    </div>
  )
}

function clipName(c, assetName) {
  if (c.kind === 'text') return c.text?.content.split('\n')[0] || 'Text'
  if (c.kind === 'sticker') return c.sticker?.id === 'emoji' ? `${c.sticker.emoji ?? ''} Sticker` : (stickerDef(c.sticker)?.label ?? 'Sticker')
  if (c.kind === 'adjustment') return `Adjustment · ${FILTER_PRESETS.find((f) => f.id === c.filter?.preset)?.label ?? 'custom'}`
  return assetName || 'Missing media'
}

/** Transition on a cut/edge: click to select, drag an edge to change its duration (one undo step). */
function TransitionBadge({ rt, zoom, selected }) {
  const [hovered, setHovered] = useState(false)
  const type = rt.tr.type
  const render = useCallback((ctx, cw, _h, phase) => renderTransitionThumb(ctx, cw, type, phase), [type])
  const w = Math.max(48, (rt.end - rt.start) * zoom)
  const left = rt.start * zoom - (w - (rt.end - rt.start) * zoom) / 2
  const maxDur = rt.a && rt.b ? Math.min(rt.a.duration, rt.b.duration) : (rt.a ?? rt.b).duration
  const startResize = (e, side) => {
    e.stopPropagation()
    e.preventDefault()
    setState({ selectedTransitionId: rt.tr.id, selection: [], sideTab: 'inspector' })
    const x0 = e.clientX
    const d0 = rt.tr.duration
    // cut transitions are centred, so each px moves both edges; edge transitions grow from their anchor
    const k = rt.a && rt.b ? 2 : 1
    const sign = side === 'r' ? 1 : -1
    beginGesture()
    const move = (ev) => {
      const d = Math.min(maxDur, Math.max(0.1, d0 + ((ev.clientX - x0) / zoom) * k * sign))
      updateGesture((p) => {
        const t = (p.transitions ?? []).find((x) => x.id === rt.tr.id)
        if (t) t.duration = Math.round(d * 100) / 100
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      endGesture('Change transition duration')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const canLeft = !!rt.a // pair or out-edge: left handle changes length
  const canRight = !!rt.b
  return (
    <div
      className={`tr-badge${selected ? ' selected' : ''}`}
      style={{ left, width: w }}
      title={`${transitionLabel(rt.tr.type)} · ${rt.tr.duration.toFixed(2)} s\nClick to edit · drag an edge to change duration · Delete removes`}
      onPointerDown={(e) => {
        e.stopPropagation()
        setState({ selectedTransitionId: rt.tr.id, selection: [], sideTab: 'inspector' })
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <span className="tr-thumb" aria-hidden="true">
        <Thumb render={render} animate hovered={hovered} restPhase={0.42} />
      </span>
      {w > 110 && <span className="tr-name">{transitionLabel(rt.tr.type)}</span>}
      {canLeft && <span className="tr-edge l" onPointerDown={(e) => startResize(e, 'l')} />}
      {canRight && <span className="tr-edge r" onPointerDown={(e) => startResize(e, 'r')} />}
    </div>
  )
}
