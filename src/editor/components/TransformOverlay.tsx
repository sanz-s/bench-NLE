import { useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { activeVisualClips, clipBounds, type Bounds } from '../../media/compositor'
import type { Clip, Project } from '../../media/types'
import { endGesture, setState, updateGesture, useStore } from '../store'

type Corner = 'nw' | 'ne' | 'sw' | 'se'
const SNAP_PX = 6 // screen pixels

interface Drag {
  mode: 'move' | 'scale'
  clipId: string
  x0: number
  y0: number
  ox: number
  oy: number
  os: number
  /** scale drags: distance from the clip centre to the pointer at drag start (screen px) */
  d0: number
  centre: { x: number; y: number }
  bounds: Bounds
  moved: boolean
}

function sourceSize(p: Project, c: Clip): { width: number; height: number } | null {
  const a = c.assetId ? p.assets.find((x) => x.id === c.assetId) : undefined
  if (!a) return null
  if (a.info.kind === 'image') return { width: a.info.imageWidth ?? 0, height: a.info.imageHeight ?? 0 }
  return a.info.video ? { width: a.info.video.width, height: a.info.video.height } : null
}

/**
 * On-canvas transform for the program monitor: click a clip to select it, drag to move
 * (Shift = lock axis, snaps to frame centre/edges), drag a corner to scale from the centre
 * (snaps to 100%). Each drag is one undo step. `k` = CSS pixels per project pixel.
 */
export function TransformOverlay({ k }: { k: number }) {
  const project = useStore((s) => s.project)
  const time = useStore((s) => s.time)
  const selection = useStore((s) => s.selection)
  const playing = useStore((s) => s.playing)
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })
  const [tip, setTip] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const drag = useRef<Drag | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const handlers = useRef<{ move: (e: PointerEvent) => void; up: () => void }>({ move: () => {}, up: () => {} })

  const active = activeVisualClips(project, time)
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  const boundsOf = (c: Clip) => clipBounds(project, c, sourceSize(project, c))
  const selectedClip = selection.length === 1 ? active.find((c) => c.id === selection[0]) : undefined

  /** Topmost clip under a point (project px). activeVisualClips is bottom → top. */
  const hitTest = (px: number, py: number): Clip | undefined => {
    for (let i = active.length - 1; i >= 0; i--) {
      const b = boundsOf(active[i])
      if (b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return active[i]
    }
    return undefined
  }

  const toProject = (clientX: number, clientY: number) => {
    const r = rootRef.current!.getBoundingClientRect()
    return { x: (clientX - r.left) / k, y: (clientY - r.top) / k }
  }

  const begin = (e: RPointerEvent, clip: Clip, mode: Drag['mode']) => {
    e.stopPropagation()
    e.preventDefault()
    setState({ selection: [clip.id], sideTab: 'inspector', selectedTransitionId: null })
    if (locked.has(clip.trackId)) return
    const b = boundsOf(clip)
    if (!b) return
    const r = rootRef.current!.getBoundingClientRect()
    const centre = { x: r.left + (b.x + b.w / 2) * k, y: r.top + (b.y + b.h / 2) * k }
    drag.current = {
      mode,
      clipId: clip.id,
      x0: e.clientX,
      y0: e.clientY,
      ox: clip.transform.x,
      oy: clip.transform.y,
      os: clip.transform.scale,
      d0: Math.max(4, Math.hypot(e.clientX - centre.x, e.clientY - centre.y)),
      centre,
      bounds: b,
      moved: false,
    }
    // window listeners: never lose the release, even if the pointer leaves the viewer
    const move = (ev: PointerEvent) => handlers.current.move(ev)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      handlers.current.up()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const onMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 2) return
    d.moved = true
    const W = project.width
    const H = project.height
    if (d.mode === 'move') {
      let dx = (e.clientX - d.x0) / k
      let dy = (e.clientY - d.y0) / k
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      let x = d.ox + dx
      let y = d.oy + dy
      const thr = SNAP_PX / k
      const hw = d.bounds.w / 2
      const hh = d.bounds.h / 2
      let v = false
      let h = false
      if (!e.altKey) {
        // centre, then edges flush with the frame
        for (const target of [0, hw - W / 2, W / 2 - hw]) {
          if (Math.abs(x - target) < thr) {
            x = target
            v = target === 0
            break
          }
        }
        for (const target of [0, hh - H / 2, H / 2 - hh]) {
          if (Math.abs(y - target) < thr) {
            y = target
            h = target === 0
            break
          }
        }
      }
      setGuides({ v, h })
      const nx = Math.round(x)
      const ny = Math.round(y)
      updateGesture((p) => {
        const c = p.clips.find((c) => c.id === d.clipId)
        if (c) {
          c.transform.x = nx
          c.transform.y = ny
        }
      })
      setTip(`X ${nx}  Y ${ny}`)
    } else {
      const dist = Math.hypot(e.clientX - d.centre.x, e.clientY - d.centre.y)
      let s = Math.min(10, Math.max(0.02, (d.os * dist) / d.d0))
      if (!e.altKey && Math.abs(s - 1) < 0.03) s = 1
      const ns = Math.round(s * 1000) / 1000
      updateGesture((p) => {
        const c = p.clips.find((c) => c.id === d.clipId)
        if (c) c.transform.scale = ns
      })
      setTip(`${Math.round(ns * 100)}%`)
    }
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    setGuides({ v: false, h: false })
    setTip(null)
    if (!d) return
    endGesture(d.moved ? (d.mode === 'move' ? 'Move in frame' : 'Scale clip') : '')
  }

  useLayoutEffect(() => {
    handlers.current = { move: onMove, up: onUp }
  })

  if (playing) return null

  const sb = selectedClip ? boundsOf(selectedClip) : null
  const hoverClip = hover && hover !== selectedClip?.id ? active.find((c) => c.id === hover) : undefined
  const hb = hoverClip ? boundsOf(hoverClip) : null
  const box = (b: Bounds) => ({ left: b.x * k, top: b.y * k, width: b.w * k, height: b.h * k })

  return (
    <div
      ref={rootRef}
      className="xform-root"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const pt = toProject(e.clientX, e.clientY)
        const hit = hitTest(pt.x, pt.y)
        if (hit) begin(e, hit, 'move')
        else setState({ selection: [], selectedTransitionId: null })
      }}
      onPointerMove={(e) => {
        if (drag.current) return
        const pt = toProject(e.clientX, e.clientY)
        setHover(hitTest(pt.x, pt.y)?.id ?? null)
      }}
      onPointerLeave={() => setHover(null)}
    >
      {hb && <div className="xform-hover" style={box(hb)} />}
      {sb && selectedClip && (
        <div
          className={`xform-box${locked.has(selectedClip.trackId) ? ' locked' : ''}`}
          style={box(sb)}
          onPointerDown={(e) => e.button === 0 && begin(e, selectedClip, 'move')}
          title={locked.has(selectedClip.trackId) ? 'Track is locked' : 'Drag to move · Shift locks axis · Alt disables snapping'}
        >
          {!locked.has(selectedClip.trackId) &&
            (['nw', 'ne', 'sw', 'se'] as Corner[]).map((c) => (
              <span
                key={c}
                className={`xform-handle h-${c}`}
                onPointerDown={(e) => e.button === 0 && begin(e, selectedClip, 'scale')}
                title="Drag to scale (snaps to 100%, Alt disables)"
              />
            ))}
          {tip && <span className="xform-tip">{tip}</span>}
        </div>
      )}
      {guides.v && <div className="xform-guide v" />}
      {guides.h && <div className="xform-guide h" />}
    </div>
  )
}
