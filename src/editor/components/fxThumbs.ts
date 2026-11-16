import { drawFrame, type FrameImage } from '../../media/compositor'
import type { Clip, Project, TransitionType } from '../../media/types'
import { makeClip } from '../model'

// Thumbnails are rendered by the real compositor at this virtual resolution, then scaled down.
export const THUMB_W = 1920
export const THUMB_H = 1080
export const miniProject = (clips: Clip[], extra: Partial<Project> = {}): Project => ({
  id: 'thumb',
  name: 'thumb',
  width: THUMB_W,
  height: THUMB_H,
  fps: 30,
  sampleRate: 48000,
  background: '#1b1e27',
  assets: [],
  tracks: [{ id: 'T', kind: 'video', name: 'V', muted: false, hidden: false, locked: false }],
  clips,
  ...extra,
})

let sampleCache: Record<string, HTMLCanvasElement> = {}
/** A colourful sample "photo" so filter thumbnails show something meaningful. */
export function sampleFrame(kind: 'scene' | 'A' | 'B'): FrameImage {
  if (!sampleCache[kind]) {
    const c = document.createElement('canvas')
    c.width = 320
    c.height = 180
    const g = c.getContext('2d')!
    if (kind === 'scene') {
      const sky = g.createLinearGradient(0, 0, 0, 180)
      sky.addColorStop(0, '#3a8dde')
      sky.addColorStop(0.6, '#f5b26b')
      sky.addColorStop(1, '#f07b52')
      g.fillStyle = sky
      g.fillRect(0, 0, 320, 180)
      g.fillStyle = '#ffe38a'
      g.beginPath()
      g.arc(225, 95, 26, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#2f6e4f'
      g.beginPath()
      g.moveTo(0, 180)
      g.quadraticCurveTo(80, 100, 170, 150)
      g.quadraticCurveTo(250, 120, 320, 140)
      g.lineTo(320, 180)
      g.fill()
      g.fillStyle = '#1d4a35'
      g.fillRect(40, 120, 14, 40)
      g.beginPath()
      g.arc(47, 116, 18, 0, Math.PI * 2)
      g.fill()
    } else {
      g.fillStyle = kind === 'A' ? '#2f6fd6' : '#e2672f'
      g.fillRect(0, 0, 320, 180)
      g.fillStyle = 'rgba(255,255,255,0.9)'
      g.font = '800 96px system-ui, sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(kind, 160, 96)
    }
    sampleCache[kind] = c
  }
  const c = sampleCache[kind]
  return { image: c, width: c.width, height: c.height }
}
if (import.meta.hot) import.meta.hot.dispose(() => (sampleCache = {}))

/** Draw transition `type` between sample frames A and B; phase 0..1 sweeps across it (0.5 = midpoint). */
export function renderTransitionThumb(ctx: CanvasRenderingContext2D, w: number, type: TransitionType, phase: number) {
  const a = makeClip('image', 'T', 0, 2, { id: 'A', assetId: 'A' })
  const b = makeClip('image', 'T', 2, 2, { id: 'B', assetId: 'B' })
  const proj = miniProject([a, b], { transitions: [{ id: 'x', trackId: 'T', leftId: 'A', rightId: 'B', type, duration: 1, easing: 'ease-in-out' }] })
  const frames = new Map<string, FrameImage | null>([
    ['A', sampleFrame('A')],
    ['B', sampleFrame('B')],
  ])
  // short holds on A and B, then the sweep
  const q = phase < 0.2 ? 0 : phase > 0.8 ? 1 : (phase - 0.2) / 0.6
  drawFrame(ctx, proj, 1.5 + q * 0.999, frames, w / THUMB_W)
}

