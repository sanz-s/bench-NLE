/**
 * window.__nleBench — automation API used by the Playwright runner (bench/run.mjs).
 * Everything goes through the same code paths as the UI.
 */
import { getCapabilities } from '../media/capabilities'
import { generateTestClip, importFiles, startConvert, startExport } from '../editor/actions'
import { getState, replaceProject, setState, setTime } from '../editor/store'
import { defaultEncodeSettings, defaultProject, makeClip, newTrack, videoTracks, audioTracks } from '../editor/model'
import { defaultFilter } from '../media/effects/filters'
import { defaultAnim } from '../media/effects/animations'
import { TEXT_FX, TEXT_PRESETS } from '../media/effects/text'
import { EFFECTS, newEffect } from '../media/effects/fx/videoEffects'
import { TRANSITIONS } from '../media/effects/transitions'
import { STICKERS } from '../media/effects/stickers'
import { serverHealth, setAutomated, setServerRootPid } from './serverClient'
import { flattenReport, toCSV } from './metrics'
import { installMainThreadObservers, startMainThreadWindow } from './mainThread'
import { runAndReport, verifyOutput } from './jobRunner'
import { probeFile } from '../media/probe'

function settingsFor(base, patch) {
  return { ...base, ...patch }
}

function releaseOutput(reportId) {
  const url = getState().outputs[reportId]
  if (!url) return
  URL.revokeObjectURL(url)
  setState((s) => {
    const outputs = { ...s.outputs }
    delete outputs[reportId]
    return { outputs }
  })
}

const api = {
  version: 1,
  ready: true,

  async capabilities(q) {
    const p = getState().project
    return getCapabilities({ width: p.width, height: p.height, fps: p.fps, channels: 2, sampleRate: 48000, ...q })
  },

  serverHealth,

  setRootPid(pid) {
    setServerRootPid(pid)
  },

  /** Tag runs as automated so the dashboard hides them by default. */
  setAutomated(v) {
    setAutomated(v)
  },

  /** Fresh empty timeline at the given size. Imported/generated assets are kept unless keepAssets is false. */
  reset(width = 1920, height = 1080, fps = 30, keepAssets = true) {
    const p = defaultProject()
    replaceProject({ ...p, width, height, fps, name: 'Benchmark', assets: keepAssets ? getState().project.assets : [] })
  },

  async generateFixture(spec) {
    const asset = await generateTestClip(spec)
    if (!asset) throw new Error('fixture generation failed')
    return asset.id
  },

  /** Import a file from bytes (Playwright passes real fixture files this way). */
  async importBytes(name, bytes, type = '') {
    const [a] = await importFiles([new File([new Uint8Array(bytes)], name, { type })])
    if (!a) throw new Error(`import failed for ${name}`)
    return a.id
  },

  assets() {
    return getState().project.assets.map((a) => ({ id: a.id, name: a.name, info: a.info }))
  },

  /**
   * Standard benchmark edit: main clip on V1 (+ its audio on A1), the same clip as a
   * picture-in-picture on V2, a title on V2, and a 0.5 s fade in/out on the audio.
   */
  buildTestTimeline(assetId) {
    const st = getState()
    const asset = assetId ? st.project.assets.find((a) => a.id === assetId) : st.project.assets.find((a) => a.info.kind === 'video')
    if (!asset) throw new Error('no video asset')
    const p = { ...st.project, clips: [] }
    const [v2, v1] = videoTracks(p)
    const [a1] = audioTracks(p)
    const dur = asset.info.duration
    p.clips.push(makeClip('video', v1.id, 0, dur, { assetId: asset.id, linkId: 'L1' }))
    if (asset.info.audio?.canDecode) {
      p.clips.push(makeClip('audio', a1.id, 0, dur, { assetId: asset.id, linkId: 'L1', audio: { gain: 0.9, fadeIn: 0.5, fadeOut: 0.5 } }))
    }
    const pip = Math.min(dur, Math.max(1, dur - 2))
    p.clips.push(
      makeClip('video', v2.id, 1, pip, {
        assetId: asset.id,
        in: Math.min(1, dur / 4),
        transform: { x: p.width * 0.28, y: -p.height * 0.26, scale: 0.35, opacity: 0.95 },
      }),
    )
    p.clips.push(
      makeClip('text', v2.id, 0, 1, {
        text: { content: 'Benchmark', size: Math.round(p.height / 9), color: '#ffffff', background: true, bold: true },
        transform: { x: 0, y: p.height * 0.3, scale: 1, opacity: 1 },
      }),
    )
    replaceProject(p)
    return dur
  },

  /**
   * Effects benchmark edit (exercises every effect path in the compositor):
   * V1 two halves of the clip with a cross dissolve + Vintage filter on the first half,
   * V2 animated star sticker + lower-third text, V3 Cinematic adjustment layer with vignette.
   */
  /** Test hook: a timeline with one audio clip of `dur` seconds from `assetId` (audio-only exports). */
  buildAudioTimeline(assetId, dur) {
    const st = getState()
    const asset = st.project.assets.find((a) => a.id === assetId)
    if (!asset) throw new Error(`unknown asset ${assetId}`)
    const p = { ...st.project, clips: [], transitions: [] }
    const [a1] = audioTracks(p)
    p.clips.push(makeClip('audio', a1.id, 0, Math.min(dur, asset.info.duration), { assetId: asset.id }))
    replaceProject(p)
  },

  buildEffectsTimeline(assetId) {
    const st = getState()
    const asset = assetId ? st.project.assets.find((a) => a.id === assetId) : st.project.assets.find((a) => a.info.kind === 'video')
    if (!asset) throw new Error('no video asset')
    const base = st.project
    const v3 = newTrack('video', 'V3')
    const tracks = [v3, ...base.tracks.map((t) => ({ ...t }))]
    const p = { ...base, tracks, clips: [], transitions: [] }
    const [, v2, v1] = videoTracks(p)
    const [a1] = audioTracks(p)
    const dur = asset.info.duration
    const half = dur / 2
    const vA = makeClip('video', v1.id, 0, half, { assetId: asset.id, linkId: 'LA', filter: defaultFilter('vintage') })
    const vB = makeClip('video', v1.id, half, dur - half, { assetId: asset.id, linkId: 'LB', in: half })
    p.clips.push(vA, vB)
    if (asset.info.audio?.canDecode) {
      p.clips.push(makeClip('audio', a1.id, 0, half, { assetId: asset.id, linkId: 'LA' }))
      p.clips.push(makeClip('audio', a1.id, half, dur - half, { assetId: asset.id, linkId: 'LB', in: half }))
    }
    p.transitions.push({ id: 'trAB', trackId: v1.id, leftId: vA.id, rightId: vB.id, type: 'dissolve', duration: 1, easing: 'ease-in-out' })
    p.clips.push(
      makeClip('sticker', v2.id, 1, 3, {
        sticker: { id: 'star', color: '#ffc83d', color2: '#ffffff' },
        transform: { x: Math.round(p.width * 0.3), y: -Math.round(p.height * 0.25), scale: 1, opacity: 1 },
        anim: { ...defaultAnim(), in: 'pop', loop: 'pulse', out: 'fade' },
      }),
    )
    const lt = TEXT_PRESETS.find((x) => x.id === 'lower-third').make(p.width, p.height)
    p.clips.push(makeClip('text', v2.id, 4.5, Math.min(5, dur - 4.5), { text: lt.text, transform: lt.transform, anim: lt.anim }))
    p.clips.push(makeClip('adjustment', v3.id, Math.max(0, dur - 4), 4, { filter: { ...defaultFilter('cinematic'), vignette: 30 } }))
    replaceProject(p)
    return dur
  },

  /** Catalog test edit: the clip split in two with `transition` on the cut, `effect` on both halves, plus a text clip with `textFx`. */
  buildFxTimeline(assetId, spec) {
    const st = getState()
    const asset = st.project.assets.find((a) => a.id === assetId)
    if (!asset) throw new Error('no asset')
    const p = { ...st.project, clips: [], transitions: [] }
    const [v2, v1] = videoTracks(p)
    const dur = asset.info.duration
    const half = dur / 2
    const fx = spec.effect ? [newEffect(spec.effect)] : undefined
    const a = makeClip('video', v1.id, 0, half, { assetId: asset.id, effects: fx })
    const b = makeClip('video', v1.id, half, dur - half, { assetId: asset.id, in: half, effects: fx ? [newEffect(spec.effect)] : undefined })
    p.clips.push(a, b)
    if (spec.transition)
      p.transitions.push({ id: 'tr', trackId: v1.id, leftId: a.id, rightId: b.id, type: spec.transition, duration: Math.min(1, half), easing: 'ease-in-out' })
    if (spec.textFx) {
      p.clips.push(
        makeClip('text', v2.id, 0, dur, {
          text: {
            content: 'Catalog\nTest',
            size: Math.round(p.height / 8),
            color: '#ffffff',
            background: false,
            bold: true,
            weight: 800,
            fx: spec.textFx,
            fxDur: 1,
            gradient: { on: true, c1: '#ff4dd8', c2: '#5b8cff', angle: 0, animate: true },
          },
          effects: spec.textFx === 'trail' ? [newEffect('trail')] : undefined,
          anim: spec.textFx === 'trail' ? { ...defaultAnim(), loop: 'float', loopSpeed: 2 } : undefined,
        }),
      )
    }
    replaceProject(p)
    return dur
  },

  /**
   * Showcase edit from (up to) four imported videos: 8 cuts alternating the sources on V1, each with its own
   * effect stack and a different transition on every cut, PiP + stickers on V2, animated titles on V3,
   * adjustment layers on V4, and the linked audio on A1. Returns the edit duration.
   */
  buildShowcase(ids) {
    const st = getState()
    const vids = (ids?.length ? ids.map((id) => st.project.assets.find((a) => a.id === id)) : st.project.assets.filter((a) => a.info.kind === 'video'))
      .filter((a) => !!a && a.info.kind === 'video')
      .slice(0, 4)
    if (!vids.length) throw new Error('import at least one video first')
    const src = vids
    const nSrc = src.length
    // project size from the first video (long edge ≤ 1920, even dimensions)
    const v0 = src[0].info.video
    const k = v0 ? Math.min(1, 1920 / Math.max(v0.width, v0.height)) : 1
    const W = v0 ? Math.round((v0.width * k) / 2) * 2 : 1920
    const H = v0 ? Math.round((v0.height * k) / 2) * 2 : 1080
    const V4 = newTrack('video', 'V4'),
      V3 = newTrack('video', 'V3'),
      V2 = newTrack('video', 'V2'),
      V1 = newTrack('video', 'V1')
    const A1 = newTrack('audio', 'A1'),
      A2 = newTrack('audio', 'A2')
    const clips = []
    const transitions = []
    const fx = (type, params = {}) => {
      const e = newEffect(type)
      e.params = { ...e.params, ...params }
      return e
    }

    // ---- V1: 8 segments cycling through the sources (A B C D A B C D with four), each use spread through the file
    const plan = [
      { s: 0, effects: [fx('ken-burns', { from: 100, to: 130 }), fx('color-grade')], cut: 'cross-zoom' },
      { s: 1, effects: [fx('film-grain', { amount: 30 }), fx('vignette')], filter: defaultFilter('vivid'), cut: 'whip-pan' },
      { s: 2, effects: [fx('rgb-split'), fx('scanlines')], cut: 'glitch-shake' },
      { s: 0, effects: [fx('glitch'), fx('chromatic')], cut: 'ink-drop' },
      { s: 1, effects: [fx('bloom'), fx('anamorphic'), fx('lens-flare')], cut: 'light-leak' },
      { s: 2, effects: [fx('handheld'), fx('motion-blur')], filter: defaultFilter('cyber'), cut: '3d-flip' },
      { s: 0, effects: [fx('duotone'), fx('elastic-scale')], cut: 'film-burn' },
      { s: 1, effects: [fx('depth-of-field'), fx('soft-glow'), fx('cinematic-bars')], filter: defaultFilter('cinematic') },
    ]
    plan.forEach((seg, i) => (seg.s = i % nSrc))
    const uses = src.map(() => 0)
    const count = plan.reduce((n, x) => (n[x.s]++, n), src.map(() => 0))
    let t = 0
    const v1 = []
    plan.forEach((seg, i) => {
      const a = src[seg.s]
      const d = a.info.duration
      const n = count[seg.s]
      const j = uses[seg.s]++
      const len = Math.max(0.8, Math.min(3.2, d / n - 0.3))
      const inPt = Math.max(0, Math.min(d - len, ((d - len) * (j + 0.5)) / n))
      const link = `SL${i}`
      const c = makeClip('video', V1.id, t, len, { assetId: a.id, in: inPt, linkId: link, effects: seg.effects, filter: seg.filter })
      v1.push(c)
      clips.push(c)
      if (a.info.audio?.canDecode) {
        clips.push(
          makeClip('audio', A1.id, t, len, {
            assetId: a.id,
            in: inPt,
            linkId: link,
            audio: { gain: 0.85, fadeIn: i === 0 ? 0.4 : 0, fadeOut: i === plan.length - 1 ? 1.2 : 0 },
          }),
        )
      }
      t += len
    })
    const total = t
    v1.forEach((c, i) => {
      const cut = plan[i].cut
      if (cut && v1[i + 1])
        transitions.push({
          id: `trS${i}`,
          trackId: V1.id,
          leftId: c.id,
          rightId: v1[i + 1].id,
          type: cut,
          duration: Math.min(0.8, c.duration / 2, v1[i + 1].duration / 2),
          easing: 'ease-in-out',
        })
    })
    transitions.push({ id: 'trIn', trackId: V1.id, rightId: v1[0].id, type: 'smooth-zoom-out', duration: 0.6, easing: 'ease-out' })
    transitions.push({ id: 'trOut', trackId: V1.id, leftId: v1[v1.length - 1].id, type: 'dip-black', duration: 1, easing: 'ease-in-out' })
    const at = (i) => v1[Math.min(i, v1.length - 1)].start
    const len = (i) => v1[Math.min(i, v1.length - 1)].duration

    // ---- V2: picture-in-picture + stickers (never overlapping on the track)
    const pipSrc = src[2 % nSrc] // a different source than the segment it floats over
    const pipLen = Math.min(len(1) - 0.2, pipSrc.info.duration)
    clips.push(
      makeClip('video', V2.id, at(1) + 0.1, pipLen, {
        assetId: pipSrc.id,
        in: Math.max(0, pipSrc.info.duration - pipLen) / 3,
        transform: { x: Math.round(W * 0.3), y: -Math.round(H * 0.25), scale: 0.32, opacity: 1 },
        rotation: -4,
        effects: [fx('outline-glow')],
        anim: { ...defaultAnim(), in: 'slide-left', inDur: 0.5, out: 'zoom', outDur: 0.4, loop: 'float', loopSpeed: 0.7 },
      }),
    )
    const sticker = (start, dur, sid, x, y, scale, anim, extra = {}) =>
      clips.push(
        makeClip('sticker', V2.id, start, dur, {
          transform: { x: Math.round(W * x), y: Math.round(H * y), scale, opacity: 1 },
          anim: { ...defaultAnim(), ...anim },
          ...extra,
          sticker:
            extra.sticker ??
            (() => {
              const d = STICKERS.find((x) => x.id === sid)
              return { id: sid, color: d.color, color2: d.kind === 'badge' ? (d.fg ?? '#ffffff') : '#ffffff' }
            })(),
        }),
      )
    sticker(at(0) + 0.6, len(0) - 0.8, 'sparkle', 0.33, -0.28, 0.8, { in: 'pop', loop: 'spin', loopSpeed: 0.5, out: 'fade' })
    sticker(
      at(2) + 0.3,
      len(2) - 0.5,
      'emoji',
      -0.32,
      -0.25,
      1.1,
      { in: 'zoom', loop: 'bounce', out: 'pop' },
      { sticker: { id: 'emoji', emoji: '🔥', color: '#ffffff', color2: '#ffffff' } },
    )
    sticker(at(3) + 0.3, len(3) - 0.5, 'bolt', 0.34, 0.2, 1, { in: 'pop', loop: 'wiggle', out: 'fade' }, { effects: [fx('neon-glow')] })
    sticker(at(4) + 0.4, len(4) - 0.6, 'badge-live', -0.36, -0.36, 0.9, { in: 'slide-right', loop: 'pulse', out: 'fade' })
    sticker(at(6) + 0.3, len(6) - 0.5, 'star', 0.3, -0.26, 1, { in: 'pop', loop: 'pulse', out: 'zoom' }, { effects: [fx('trail')] })
    sticker(at(7) + 0.3, Math.max(0.5, len(7) - 1.4), 'badge-sub', 0, 0.36, 1, { in: 'pop', loop: 'pulse', out: 'fade' })

    // ---- V3: titles — one text effect / preset per segment
    const preset = (id, start, dur, patch, extra = {}) => {
      const pr = TEXT_PRESETS.find((x) => x.id === id).make(W, H)
      clips.push(makeClip('text', V3.id, start, dur, { text: { ...pr.text, ...patch }, transform: pr.transform, anim: pr.anim, ...extra }))
    }
    const grad = { on: true, c1: '#ff4dd8', c2: '#5b8cff', c3: '#38f9d7', angle: 20, animate: true }
    preset('title', at(0) + 0.2, len(0) - 0.4, { content: 'TRANSFORM', fx: 'kinetic', fxDur: 1, gradient: grad, size: Math.round(H * 0.14) })
    preset('caption-bar', at(1) + 0.2, len(1) - 0.4, { content: 'Mediabunny · in-browser NLE' })
    preset('neon', at(2) + 0.2, len(2) - 0.4, { content: 'GLITCH MODE', fx: 'neon-flicker', size: Math.round(H * 0.1) })
    preset('big-bold', at(3) + 0.2, len(3) - 0.4, { content: 'NO LIMITS', fx: 'glitch', fxDur: 0.8 })
    preset('lower-third', at(4) + 0.2, len(4) - 0.4, { content: 'Golden hour\nBloom · Anamorphic · Flare' })
    preset('outline', at(5) + 0.2, len(5) - 0.4, { content: 'MOTION', fx: 'tracking', fxDur: 1.2 })
    preset('callout', at(6) + 0.2, len(6) - 0.4, { content: 'Text pop!', fx: 'pop', fxDur: 0.8 })
    preset('quote', at(7) + 0.2, Math.max(0.8, len(7) - 1.2), { content: 'Made in the browser.', fx: 'flip', fxDur: 1 })

    // ---- V4: adjustment layers over everything below
    clips.push(makeClip('adjustment', V4.id, at(5) + len(5) * 0.35, len(5) * 0.45, { filter: { ...defaultFilter('noir') } }))
    clips.push(makeClip('adjustment', V4.id, at(6), len(6), { effects: [fx('noise', { amount: 25 })] }))

    // ---- sound effects: any imported asset named sfx-<name>.wav, timed to cuts / titles / stickers (A2, A3, … as needed)
    const sfxAssets = new Map()
    for (const a of st.project.assets) {
      const m = /^sfx-(.+)\.wav$/i.exec(a.name)
      if (m && a.info.audio?.canDecode) sfxAssets.set(m[1].toLowerCase(), a)
    }
    const sfxTracks = [A2]
    const sfx = (name, start, gain = 0.8) => {
      const a = sfxAssets.get(name)
      if (!a) return
      const s0 = Math.max(0, start)
      const dur = Math.min(a.info.duration, total - s0)
      if (dur < 0.05) return
      const free = (tr) => !clips.some((c) => c.trackId === tr.id && c.start < s0 + dur - 1e-3 && c.start + c.duration > s0 + 1e-3)
      let tr = sfxTracks.find(free)
      if (!tr) sfxTracks.push((tr = newTrack('audio', `A${sfxTracks.length + 2}`)))
      clips.push(makeClip('audio', tr.id, s0, dur, { assetId: a.id, audio: { gain, fadeIn: 0, fadeOut: dur < a.info.duration ? Math.min(0.3, dur / 2) : 0 } }))
    }
    if (sfxAssets.size) {
      for (const c of clips) if (c.kind === 'audio' && c.trackId === A1.id) c.audio = { ...c.audio, gain: 0.65 }
      const cut = (i) => v1[i + 1].start
      sfx('whoosh', 0, 0.6) // intro zoom
      sfx('impact', at(0) + 0.2, 0.9) // TRANSFORM title
      sfx('shimmer', at(0) + 0.6, 0.45) // sparkle sticker
      sfx('whoosh', cut(0) - 0.4) // cross zoom
      sfx('whoosh', cut(1) - 0.4, 0.9) // whip pan
      sfx('pop', at(1) + 0.1, 0.7) // PiP slides in
      sfx('glitch', cut(2) - 0.35, 0.7) // glitch shake
      sfx('pop', at(2) + 0.3, 0.7) // 🔥
      sfx('swoosh-in', cut(3) - 0.6, 0.7) // into the ink drop
      sfx('impact', cut(3), 0.7)
      sfx('glitch', at(3) + 0.2, 0.55) // NO LIMITS text glitch
      sfx('pop', at(3) + 0.3, 0.6) // ⚡
      sfx('riser', cut(4) - 2.2, 0.55) // build into the light leak
      sfx('shimmer', cut(4) - 0.2, 0.6)
      sfx('pop', at(4) + 0.4, 0.6) // LIVE badge
      sfx('whoosh', cut(5) - 0.4) // 3D flip
      sfx('burn', cut(6) - 0.7, 0.7) // film burn
      sfx('pop', at(6) + 0.2, 0.7) // Text pop
      sfx('pop', at(6) + 0.3, 0.6) // star
      sfx('shimmer', at(7) + 0.2, 0.5) // 3D text flip
      sfx('pop', at(7) + 0.3, 0.7) // SUBSCRIBE
      sfx('impact', total - 1.3, 0.8) // ending hit into the dip to black
    }

    const name = vids.map((v) => v.name.replace(/\.[^.]+$/, '')).join(' + ')
    replaceProject({ ...st.project, name: `Showcase · ${name}`, width: W, height: H, fps: 30, tracks: [V4, V3, V2, V1, A1, ...sfxTracks], clips, transitions })
    return total
  },

  catalog() {
    return {
      effects: EFFECTS.map((e) => e.id),
      transitions: TRANSITIONS.map((t) => t.id),
      textFx: [...TEXT_FX.map((t) => t.id).filter((x) => x !== 'none'), 'trail'],
    }
  },

  async exportTimeline(patch = {}, opts = {}) {
    const settings = settingsFor(defaultEncodeSettings(getState().project), patch)
    const res = await startExport(settings, { runIn: opts.runIn ?? 'worker', saveToDisk: false, label: opts.label })
    if (!res) throw new Error('export did not start')
    if (!opts.keepOutput) releaseOutput(res.report.id)
    return res.report
  },

  /**
   * Test hook (bench/regress.mjs): export the current timeline over an EXACT range through the normal job runner,
   * without the UI. With opts.keepFile the output File is kept as window.__nleBench.lastFile.
   */
  async exportRange(range, patch = {}, opts = {}) {
    const project = getState().project
    const settings = settingsFor(defaultEncodeSettings(project), patch)
    const { report, file } = await runAndReport({ kind: 'export', project, settings, range, target: { kind: 'buffer' } }, { runIn: opts.runIn ?? 'worker', label: opts.label ?? 'range export' })
    if (opts.keepFile) this.lastFile = file
    return report
  },

  /** Test hook: probe a File (or the output of a kept report) independently of the verifier. */
  async probe(fileOrReportId) {
    let f = fileOrReportId
    if (typeof f === 'string') f = new File([await (await fetch(getState().outputs[f])).blob()], 'out')
    return probeFile(f)
  },

  /** Test hook: run the output verifier on a File as if `job` had produced it. */
  verifyFile(file, job, expectedDuration, expect = {}) {
    return verifyOutput(file, job, expectedDuration, expect)
  },

  async convert(assetId, patch = {}, opts = {}) {
    const asset = getState().project.assets.find((a) => a.id === assetId)
    if (!asset) throw new Error(`unknown asset ${assetId}`)
    const v = asset.info.video
    const base = {
      ...defaultEncodeSettings(getState().project),
      width: v?.width ?? 1920,
      height: v?.height ?? 1080,
      fps: v?.fps ? Math.round(v.fps * 1000) / 1000 : 30,
    }
    const res = await startConvert(
      asset,
      settingsFor(base, patch),
      opts.engine ?? 'conversion',
      opts.allowCopy ?? true,
      { start: 0, end: asset.info.duration },
      { runIn: opts.runIn ?? 'worker', saveToDisk: false, label: opts.label },
    )
    if (!res) throw new Error('convert did not start')
    if (!opts.keepOutput) releaseOutput(res.report.id)
    return res.report
  },

  /** Sanity check for the blocking metrics: blocks the main thread 3 × 120 ms and returns what was measured. */
  async selfTestMainThread() {
    const stop = startMainThreadWindow()
    for (let i = 0; i < 3; i++) {
      // Yield first so each block runs as a normal event-loop task (CDP-dispatched evaluation isn't attributed as one).
      await new Promise((r) => setTimeout(r, 40))
      const t = performance.now()
      while (performance.now() - t < 120) {
        /* busy */
      }
    }
    await new Promise((r) => setTimeout(r, 250))
    return stop()
  },

  seek(t) {
    setTime(t)
  },

  /** Blob URL of an output kept with `keepOutput: true`. */
  outputUrl(reportId) {
    return getState().outputs[reportId]
  },

  reports() {
    return getState().reports
  },

  /** Flat row (same columns as the in-app CSV) so the runner doesn't duplicate the schema. */
  flatten(r) {
    return flattenReport(r)
  },

  toCSV(rs) {
    return toCSV(rs)
  },
}

export function installHarness() {
  installMainThreadObservers()
  window.__nleBench = api
}
