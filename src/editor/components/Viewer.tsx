import { useEffect, useRef, useState } from 'react'
import { timelineDuration } from '../../media/compositor'
import { preview } from '../playback'
import { useStore } from '../store'
import { formatTimecode, parseTimecode } from '../model'
import { IconButton } from './ui'
import { TransformOverlay } from './TransformOverlay'

export function Viewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const time = useStore((s) => s.time)
  const playing = useStore((s) => s.playing)
  const fps = useStore((s) => s.project.fps)
  const width = useStore((s) => s.project.width)
  const height = useStore((s) => s.project.height)
  const project = useStore((s) => s.project)
  const duration = timelineDuration(project)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [tcText, setTcText] = useState<string | null>(null)

  useEffect(() => {
    const c = canvasRef.current!
    preview.attach(c)
    const unwatch = preview.watch()
    return () => {
      unwatch()
      preview.detach()
    }
  }, [])

  useEffect(() => {
    const el = wrapRef.current!
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const aspect = width / height
  const fitW = Math.max(0, Math.min(box.w - 24, (box.h - 24) * aspect))
  const fitH = fitW / aspect
  const step = 1 / fps

  return (
    <section className="panel viewer" aria-label="Program monitor">
      <div className="viewer-stage" ref={wrapRef}>
        <div className="viewer-frame" style={{ width: fitW, height: fitH }}>
          <canvas ref={canvasRef} className="viewer-canvas" aria-label="Preview" />
          {fitW > 0 && <TransformOverlay k={fitW / width} />}
        </div>
        {duration === 0 && (
          <div className="viewer-empty">
            <strong>Nothing on the timeline yet</strong>
            <span>Import media on the left, then drag it onto the timeline.</span>
          </div>
        )}
      </div>
      <div className="transport">
        <input
          className="timecode"
          value={tcText ?? formatTimecode(time, fps)}
          aria-label="Playhead timecode"
          title="Type a time (e.g. 1:23:10, 12.5, +2s, -10f) and press Enter"
          onFocus={(e) => {
            setTcText(formatTimecode(time, fps))
            e.currentTarget.select()
          }}
          onChange={(e) => setTcText(e.target.value)}
          onBlur={() => setTcText(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const t = parseTimecode(tcText ?? '', fps, time)
              if (t !== null) preview.seek(Math.max(0, t))
              ;(e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
        />
        <div className="transport-buttons">
          <IconButton icon="skipStart" label="Go to start" shortcut="Home" onClick={() => preview.seek(0)} />
          <IconButton icon="stepBack" label="Previous frame" shortcut="←" onClick={() => preview.seek(Math.max(0, time - step))} />
          <button type="button" className="play-btn" onClick={() => preview.toggle()} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              {playing ? (
                <>
                  <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" />
                  <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" />
                </>
              ) : (
                <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
              )}
            </svg>
          </button>
          <IconButton icon="stepFwd" label="Next frame" shortcut="→" onClick={() => preview.seek(time + step)} />
          <IconButton icon="skipEnd" label="Go to end" shortcut="End" onClick={() => preview.seek(duration)} />
        </div>
        <span className="timecode dim" title="Timeline duration">
          {formatTimecode(duration, fps)}
        </span>
      </div>
    </section>
  )
}
