import { CanvasSink } from 'mediabunny'

/**
 * Sequential frame reader for one clip. Playback/export ask for monotonically increasing
 * times, so we keep a CanvasSink iterator open and advance it; a backwards or far-forward
 * jump restarts the iterator (which decodes from the nearest keyframe).
 */
export class VideoReader {
  sink
  iter = null
  current = null
  next = null
  done = false
  iterStart = 0
  width
  height

  constructor(track, width, height, poolSize = 4) {
    this.width = Math.max(2, Math.round(width))
    this.height = Math.max(2, Math.round(height))
    this.sink = new CanvasSink(track, { width: this.width, height: this.height, fit: 'fill', poolSize })
  }

  /** Frame covering source time `t` (or the closest earlier frame). */
  async frameAt(t) {
    const anchor = this.current?.timestamp ?? this.iterStart
    const restart = !this.iter || t < anchor - 1e-3 || t > anchor + 1.0
    if (restart) await this.reset(t)
    for (;;) {
      if (!this.next) {
        if (this.done) break
        const r = await this.iter.next()
        if (r.done) {
          this.done = true
          break
        }
        this.next = r.value
      }
      if (this.next.timestamp <= t + 1e-4 || !this.current) {
        this.current = this.next
        this.next = null
        if (this.current.timestamp + this.current.duration > t + 1e-4) break
      } else break
    }
    return this.current
  }

  async reset(t) {
    if (this.iter) await this.iter.return(undefined)
    this.iterStart = Math.max(0, t)
    this.iter = this.sink.canvases(this.iterStart)
    this.current = null
    this.next = null
    this.done = false
  }

  async dispose() {
    if (this.iter) await this.iter.return(undefined)
    this.iter = null
    this.current = null
    this.next = null
  }
}

/** Contain-fit `src` into `box`, never upscaling beyond the source resolution. */
export function containSize(srcW, srcH, boxW, boxH) {
  const s = Math.min(boxW / srcW, boxH / srcH, 1)
  return { w: Math.max(2, Math.round(srcW * s)), h: Math.max(2, Math.round(srcH * s)) }
}
