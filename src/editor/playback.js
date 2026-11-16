import { AudioBufferSink } from 'mediabunny'
import { openInput } from '../media/probe'
import { VideoReader, containSize } from '../media/videoReader'
import { audibleClips, clipEnd, drawFrame, frameRequests, timelineDuration } from '../media/compositor'
import { makeGainFn } from '../media/audioMix'
import { getState, setState, subscribe } from './store'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Preview engine: decodes with Mediabunny on the main thread (WebCodecs decoding itself is
 * off-thread), composites with the shared Canvas2D compositor, and clocks playback off the
 * AudioContext so audio and video stay in sync.
 */
class PreviewEngine {
  canvas = null
  ctx = null
  media = new Map()
  bitmaps = new Map()
  readers = new Map()
  rendering = false
  pendingTime = null
  lastProject = null
  lastTime = -1

  audioCtx = null
  master = null
  audioGen = 0
  nodes = new Set()
  playT0 = 0
  playCtx0 = 0
  raf = 0

  attach(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.resize()
    this.requestRender(getState().time)
  }

  detach() {
    this.canvas = null
    this.ctx = null
  }

  /** Preview renders at ≤ 960 px wide for speed; export always renders at full size. */
  get previewScale() {
    const p = getState().project
    return Math.min(1, 960 / p.width)
  }

  resize() {
    if (!this.canvas) return
    const p = getState().project
    const s = this.previewScale
    const w = Math.round(p.width * s)
    const h = Math.round(p.height * s)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      void this.disposeReaders()
    }
  }

  getMedia(asset) {
    let p = this.media.get(asset.id)
    if (!p) {
      p = (async () => {
        try {
          const input = openInput(asset.file)
          const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
          const displayW = video ? await video.getDisplayWidth() : 0
          const displayH = video ? await video.getDisplayHeight() : 0
          return { input, video, audio, displayW, displayH }
        } catch (err) {
          console.warn('preview: cannot open', asset.name, err)
          return null
        }
      })()
      this.media.set(asset.id, p)
    }
    return p
  }

  getBitmap(asset) {
    let p = this.bitmaps.get(asset.id)
    if (!p) {
      p = createImageBitmap(asset.file).catch(() => null)
      this.bitmaps.set(asset.id, p)
    }
    return p
  }

  async disposeReaders() {
    const rs = [...this.readers.values()]
    this.readers.clear()
    await Promise.all(rs.map((r) => r.dispose()))
  }

  /** Coalesces render requests: only the latest time is rendered once the current frame finishes. */
  requestRender(t) {
    this.pendingTime = t
    if (!this.rendering) void this.renderLoop()
  }

  async renderLoop() {
    this.rendering = true
    try {
      while (this.pendingTime !== null) {
        const t = this.pendingTime
        this.pendingTime = null
        await this.renderAt(t)
      }
    } finally {
      this.rendering = false
    }
  }

  async renderAt(t) {
    if (!this.canvas || !this.ctx) return
    this.resize()
    const { project } = getState()
    const scale = this.previewScale
    const requests = frameRequests(project, t)
    const frames = new Map()
    const assetById = new Map(project.assets.map((a) => [a.id, a]))
    await Promise.all(
      requests.map(async ({ clip: c, src }) => {
        if (!c.assetId) return
        const asset = assetById.get(c.assetId)
        if (!asset) return
        if (c.kind === 'image') {
          const bmp = await this.getBitmap(asset)
          if (bmp) frames.set(c.id, { image: bmp, width: bmp.width, height: bmp.height })
          return
        }
        const m = await this.getMedia(asset)
        if (!m?.video) return
        const key = `${c.id}:${c.assetId}`
        let r = this.readers.get(key)
        if (!r) {
          const size = containSize(m.displayW, m.displayH, this.canvas.width, this.canvas.height)
          r = new VideoReader(m.video, size.w, size.h, 4)
          this.readers.set(key, r)
        }
        try {
          const f = await r.frameAt(src)
          if (f) frames.set(c.id, { image: f.canvas, width: f.canvas.width, height: f.canvas.height })
        } catch (err) {
          console.warn('preview decode failed', err)
        }
      }),
    )
    if (!this.ctx) return
    drawFrame(this.ctx, project, t, frames, scale)
    // Drop readers for clips no longer near the playhead.
    for (const [key, r] of this.readers) {
      const id = key.split(':')[0]
      const c = project.clips.find((x) => x.id === id)
      if (!c || t < c.start - 2 || t > clipEnd(c) + 2) {
        this.readers.delete(key)
        void r.dispose()
      }
    }
    this.lastProject = project
    this.lastTime = t
  }

  // ---------------------------------------------------------------- playback

  async play() {
    const st = getState()
    const end = timelineDuration(st.project)
    if (end <= 0) return
    let t0 = st.time
    if (t0 >= end - 1e-3) t0 = 0
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: st.project.sampleRate })
      this.master = this.audioCtx.createGain()
      this.master.connect(this.audioCtx.destination)
    }
    await this.audioCtx.resume()
    this.playT0 = t0
    this.playCtx0 = this.audioCtx.currentTime + 0.06
    setState({ playing: true, time: t0 })
    this.scheduleAudio(t0)
    const loop = () => {
      if (!getState().playing) return
      const t = this.currentPlayTime()
      const endNow = timelineDuration(getState().project)
      if (t >= endNow) {
        this.pause()
        setState({ time: endNow })
        return
      }
      setState({ time: t })
      this.requestRender(t)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  currentPlayTime() {
    if (!this.audioCtx) return getState().time
    return this.playT0 + Math.max(0, this.audioCtx.currentTime - this.playCtx0)
  }

  pause() {
    cancelAnimationFrame(this.raf)
    this.stopAudio()
    if (getState().playing) setState({ playing: false })
  }

  toggle() {
    if (getState().playing) this.pause()
    else void this.play()
  }

  /** Seek while playing restarts the clock and audio at the new time. */
  seek(t) {
    const st = getState()
    setState({ time: Math.max(0, t) })
    if (st.playing && this.audioCtx) {
      this.stopAudio()
      this.playT0 = Math.max(0, t)
      this.playCtx0 = this.audioCtx.currentTime + 0.05
      this.scheduleAudio(this.playT0)
    }
    this.requestRender(Math.max(0, t))
  }

  stopAudio() {
    this.audioGen++
    for (const n of this.nodes) {
      try {
        n.stop()
      } catch {
        /* not started */
      }
    }
    this.nodes.clear()
  }

  scheduleAudio(t0) {
    const gen = ++this.audioGen
    const { project } = getState()
    const assets = new Map(project.assets.map((a) => [a.id, a]))
    const gain = makeGainFn(project)
    for (const c of audibleClips(project)) {
      if (clipEnd(c) <= t0) continue
      const asset = assets.get(c.assetId)
      if (asset) void this.scheduleClip(c, asset, t0, gen, gain)
    }
  }

  async scheduleClip(c, asset, t0, gen, gain) {
    const ctx = this.audioCtx
    // Wait until the clip is within the lookahead window before opening a decoder.
    while (gen === this.audioGen && c.start - this.currentPlayTime() > 2) await sleep(200)
    if (gen !== this.audioGen) return
    const m = await this.getMedia(asset)
    if (!m?.audio || gen !== this.audioGen) return
    if (!(await m.audio.canDecode())) return
    const sink = new AudioBufferSink(m.audio)
    const srcStart = c.in + Math.max(0, t0 - c.start)
    const srcEnd = c.in + c.duration
    const iter = sink.buffers(srcStart, srcEnd)
    try {
      for await (const { buffer, timestamp } of iter) {
        if (gen !== this.audioGen) break
        const bufTimelineStart = c.start + (timestamp - c.in)
        const startAt = Math.max(bufTimelineStart, c.start, t0)
        const endAt = Math.min(bufTimelineStart + buffer.duration, clipEnd(c))
        if (endAt <= startAt) continue
        // Lookahead: don't schedule more than 1.5 s ahead.
        while (gen === this.audioGen && startAt - this.currentPlayTime() > 1.5) await sleep(100)
        if (gen !== this.audioGen) break
        let when = this.playCtx0 + (startAt - this.playT0)
        let offset = startAt - bufTimelineStart
        let dur = endAt - startAt
        let tlStart = startAt
        const late = ctx.currentTime - when
        if (late > 0) {
          when += late
          offset += late
          dur -= late
          tlStart += late
          if (dur <= 0) continue
        }
        const node = ctx.createBufferSource()
        node.buffer = buffer
        const g = ctx.createGain()
        g.gain.setValueAtTime(gain(c, tlStart), when)
        g.gain.linearRampToValueAtTime(gain(c, endAt), when + dur)
        node.connect(g).connect(this.master)
        node.start(when, offset, dur)
        this.nodes.add(node)
        node.onended = () => this.nodes.delete(node)
      }
    } finally {
      await iter.return(undefined)
    }
  }

  /** Re-render when the project changes (edits, inspector tweaks) while paused. */
  watch() {
    return subscribe(() => {
      const st = getState()
      if (st.playing) return
      if (st.project !== this.lastProject || st.time !== this.lastTime) this.requestRender(st.time)
    })
  }

  /** Forget cached inputs for removed assets. */
  prune(project) {
    const ids = new Set(project.assets.map((a) => a.id))
    for (const [id, p] of this.media) {
      if (!ids.has(id)) {
        this.media.delete(id)
        void p.then((m) => m?.input.dispose())
      }
    }
  }
}

export const preview = new PreviewEngine()
