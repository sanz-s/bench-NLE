import { CanvasSink, type InputVideoTrack, type WrappedCanvas } from 'mediabunny'

/**
 * Sequential frame reader for one clip. Playback/export ask for monotonically increasing
 * times, so we keep a CanvasSink iterator open and advance it; a backwards or far-forward
 * jump restarts the iterator (which decodes from the nearest keyframe).
 */
export class VideoReader {
  private sink: CanvasSink
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null
  private current: WrappedCanvas | null = null
  private next: WrappedCanvas | null = null
  private done = false
  private iterStart = 0
  readonly width: number
  readonly height: number

  constructor(track: InputVideoTrack, width: number, height: number, poolSize = 4) {
    this.width = Math.max(2, Math.round(width))
    this.height = Math.max(2, Math.round(height))
    this.sink = new CanvasSink(track, { width: this.width, height: this.height, fit: 'fill', poolSize })
  }

  /** Frame covering source time `t` (or the closest earlier frame). */
  async frameAt(t: number): Promise<WrappedCanvas | null> {
    const anchor = this.current?.timestamp ?? this.iterStart
    const restart = !this.iter || t < anchor - 1e-3 || t > anchor + 1.0
    if (restart) await this.reset(t)
    for (;;) {
      if (!this.next) {
        if (this.done) break
        const r = await this.iter!.next()
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

  private async reset(t: number) {
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
export function containSize(srcW: number, srcH: number, boxW: number, boxH: number): { w: number; h: number } {
  const s = Math.min(boxW / srcW, boxH / srcH, 1)
  return { w: Math.max(2, Math.round(srcW * s)), h: Math.max(2, Math.round(srcH * s)) }
}
