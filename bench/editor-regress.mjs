#!/usr/bin/env node
/**
 * Editor / rendering regression tests for the 2026-11-18 audits (Opus §5 E1–E20, Copilot F5/F6/F7/F10).
 * Each test reproduces the audit case through the real store actions or the shared drawFrame path
 * (window.__nleBench.editor) and failed on the unfixed code.
 *
 *   npx vite build --outDir <dir> && node bench/editor-regress.mjs [--dist <dir>] [--port <n>] [--headed] [--only <substring>]
 *
 * Defaults: --dist dist, --port 4190. Exits 1 if any test fails.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const headless = !process.argv.includes('--headed')
const dist = path.resolve(root, arg('--dist', 'dist'))
const port = Number(arg('--port', '4190'))
const only = arg('--only', '')

const server = spawn(
  process.execPath,
  [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--outDir', dist, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: root },
)
server.stderr.on('data', (d) => process.stderr.write(d))
const url = `http://127.0.0.1:${port}`
for (let i = 0; i < 75; i++) {
  try {
    if ((await fetch(url)).ok) break
  } catch {
    /* wait */
  }
  await new Promise((r) => setTimeout(r, 200))
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ channel: 'chrome', headless, args: ['--autoplay-policy=no-user-gesture-required'] })

/** Page-side helpers (installed in every fresh page). */
function installHelpers() {
  const E = () => window.__nleBench.editor
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const solid = (w, h, color) => {
    const c = new OffscreenCanvas(w, h)
    const x = c.getContext('2d')
    x.fillStyle = color
    x.fillRect(0, 0, w, h)
    return { image: c, width: w, height: h }
  }
  const gradient = (w, h) => {
    const c = new OffscreenCanvas(w, h)
    const x = c.getContext('2d')
    const g = x.createLinearGradient(0, 0, w, h)
    g.addColorStop(0, '#ff0000')
    g.addColorStop(0.5, '#00ff00')
    g.addColorStop(1, '#0000ff')
    x.fillStyle = g
    x.fillRect(0, 0, w, h)
    x.fillStyle = '#fff'
    for (let i = 0; i < 12; i++) x.fillRect((i * w) / 12, (i * h) / 12, w / 30, h / 30)
    return { image: c, width: w, height: h }
  }
  /** A fresh project (tracks: V2, V1, A1, A2). */
  const project = (over = {}) => ({ ...E().model.defaultProject(), width: 320, height: 180, fps: 30, transitions: [], ...over })
  const V = (p, name) => p.tracks.find((t) => t.name === name).id
  /** Render with the shared drawFrame path; returns a pixel reader. `offY` letterboxes like jobs.js. */
  const render = (p, t, frames = {}, opts = {}) => {
    const scale = opts.scale ?? 1
    const w = opts.w ?? Math.round(p.width * scale)
    const h = opts.h ?? Math.round(p.height * scale)
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (opts.offY) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, w, h)
    }
    ctx.save()
    if (opts.offY) ctx.translate(0, opts.offY)
    E().compositor.drawFrame(ctx, p, t, new Map(Object.entries(frames)), scale)
    ctx.restore()
    const data = ctx.getImageData(0, 0, w, h).data
    return { w, h, data, px: (x, y) => Array.from(data.slice((y * w + x) * 4, (y * w + x) * 4 + 4)) }
  }
  const fakeAsset = (kind, extra = {}) => {
    const id = E().model.uid('a')
    const info =
      kind === 'image'
        ? { kind: 'image', duration: 5, imageWidth: 64, imageHeight: 64, warnings: [] }
        : kind === 'audio'
          ? { kind: 'audio', duration: 5, audio: { canDecode: true, channels: 2, sampleRate: 48000 }, warnings: [] }
          : { kind: 'video', duration: 5, video: { width: 64, height: 64, fps: 30 }, warnings: [] }
    return { id, name: `${kind}-${id}.bin`, file: new File([new Uint8Array(16)], `${kind}.bin`), info: { ...info, ...extra } }
  }
  const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
  window.__T = { E, sleep, solid, gradient, project, V, render, fakeAsset, near }
}

async function freshPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e.message ?? e).split('\n')[0]))
  await page.goto(`${url}/?fresh=1`)
  await page.waitForFunction(() => window.__nleBench?.ready, null, { timeout: 60000 })
  await page.evaluate(installHelpers)
  return { ctx, page }
}

/** One test: fresh page, `fn(page)` returns { ok, detail }. Errors (e.g. a hook missing on old code) count as failures. */
async function test(name, fn, ms = 30000) {
  if (only && !name.includes(only)) return
  const { ctx, page } = await freshPage()
  let timer
  try {
    const r = await Promise.race([fn(page), new Promise((res) => (timer = setTimeout(() => res({ ok: false, detail: `TIMEOUT after ${ms} ms` }), ms)))])
    record(name, !!r.ok, typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail))
  } catch (e) {
    record(name, false, `error: ${String(e.message ?? e).split('\n')[0]}`)
  } finally {
    clearTimeout(timer)
    await ctx.close().catch(() => {})
  }
}

// ================================================================ E20: Motion Trail ghosts show past frames
await test('E20 Motion Trail ghosts request and draw their own PAST frames (not the current one)', (page) =>
  page.evaluate(() => {
    const { E, project, V, render, solid } = window.__T
    const p = project()
    const fx = E().videoEffects.newEffect('trail')
    fx.params = { ...fx.params, count: 2, spacing: 100, fade: 95 }
    // half opacity so the ghosts underneath show through the current frame
    const c = E().model.makeClip('video', V(p, 'V1'), 0, 4, { effects: [fx], transform: { x: 0, y: 0, scale: 1, opacity: 0.5 } })
    p.clips.push(c)
    const reqs = E().compositor.frameRequests(p, 2)
    const keys = reqs.map((r) => r.key ?? r.clip.id)
    const ghostSrc = reqs.filter((r) => r.key).map((r) => +r.src.toFixed(3))
    // current frame red, ghost frames blue: blue must appear in the composite
    const frames = { [c.id]: solid(320, 180, '#ff0000') }
    for (const k of keys) if (k !== c.id) frames[k] = solid(320, 180, '#0000ff')
    const px = render(p, 2, frames).px(160, 90)
    const ok = keys.length === 3 && keys.includes(`${c.id}#g1`) && keys.includes(`${c.id}#g2`) && ghostSrc.length === 2 && px[2] > 40 && px[0] > 40
    return { ok, detail: { keys, ghostSrc, px } }
  }))

// ================================================================ F5 / E11: dissolve fades
await test('F5 outgoing-only dissolve fades out (red at 75 % ≈ 64)', (page) =>
  page.evaluate(() => {
    const { E, project, V, render, solid } = window.__T
    const p = project()
    const c = E().model.makeClip('image', V(p, 'V1'), 0, 2)
    p.clips.push(c)
    p.transitions = [{ id: 'tr', trackId: V(p, 'V1'), leftId: c.id, type: 'dissolve', duration: 1, easing: 'linear' }]
    const out = render(p, 1.75, { [c.id]: solid(320, 180, '#ff0000') }).px(160, 90)
    return { ok: Math.abs(out[0] - 64) <= 3 && out[1] < 4 && out[3] === 255, detail: { at75: out } }
  }))

await test('F5 incoming-only dissolve fades in (red at 25 % ≈ 64)', (page) =>
  page.evaluate(() => {
    const { E, project, V, render, solid } = window.__T
    const p = project()
    const c = E().model.makeClip('image', V(p, 'V1'), 0, 2)
    p.clips.push(c)
    p.transitions = [{ id: 'tr', trackId: V(p, 'V1'), rightId: c.id, type: 'dissolve', duration: 1, easing: 'linear' }]
    const out = render(p, 0.25, { [c.id]: solid(320, 180, '#ff0000') }).px(160, 90)
    return { ok: Math.abs(out[0] - 64) <= 3, detail: { at25: out } }
  }))

await test('E11 cut dissolve where B does not cover A: A still fades (no pop); full-frame cut unchanged', (page) =>
  page.evaluate(() => {
    const { E, project, V, render, solid } = window.__T
    const mk = (bScale) => {
      const p = project()
      const a = E().model.makeClip('image', V(p, 'V1'), 0, 2)
      const b = E().model.makeClip('image', V(p, 'V1'), 2, 2, { transform: { x: 0, y: 0, scale: bScale, opacity: 1 } })
      p.clips.push(a, b)
      p.transitions = [{ id: 'tr', trackId: V(p, 'V1'), leftId: a.id, rightId: b.id, type: 'dissolve', duration: 1, easing: 'linear' }]
      // t = 2.25 → p = 0.75
      return render(p, 2.25, { [a.id]: solid(320, 180, '#ff0000'), [b.id]: solid(320, 180, '#00ff00') })
    }
    const small = mk(0.5)
    const edge = small.px(10, 10) // A only (B is the centre half)
    const centre = small.px(160, 90) // A and B
    const full = mk(1).px(160, 90)
    const ok =
      Math.abs(edge[0] - 64) <= 3 &&
      Math.abs(centre[0] - 64) <= 3 &&
      Math.abs(centre[1] - 191) <= 3 &&
      Math.abs(full[0] - 64) <= 3 &&
      Math.abs(full[1] - 191) <= 3
    return { ok, detail: { edgeAOnly: edge, centre, fullFrame: full } }
  }))

// ================================================================ F6 / E10: filter overlays and clip alpha
await test('F6 10 %-opacity warm clip: neutral invert effect gives the same pixels, overlays follow alpha', (page) =>
  page.evaluate(() => {
    const { E, project, V, render, solid } = window.__T
    const { defaultFilter } = E().filters
    const mk = (opacity, effects) => {
      const p = project()
      const c = E().model.makeClip('video', V(p, 'V1'), 0, 2, { filter: defaultFilter('warm'), transform: { x: 0, y: 0, scale: 1, opacity }, effects })
      p.clips.push(c)
      return render(p, 1, { [c.id]: solid(320, 180, '#808080') }).px(160, 90)
    }
    const plain = mk(0.1)
    const neutral = mk(0.1, [{ id: 'fx', type: 'invert', on: true, params: { amount: 0 } }])
    const full = mk(1)
    const expect = full.slice(0, 3).map((v) => Math.round(v * 0.1))
    const same = plain.every((v, i) => Math.abs(v - neutral[i]) <= 1)
    const linear = plain.slice(0, 3).every((v, i) => Math.abs(v - expect[i]) <= 2)
    return { ok: same && linear, detail: { noEffect: plain, zeroInvert: neutral, fullOpacity: full, expected10pct: expect } }
  }))

await test('E10 filter overlays stay inside the clip shape (filtered text leaves its transparent box alone)', (page) =>
  page.evaluate(() => {
    const { E, project, V, render } = window.__T
    const { defaultFilter } = E().filters
    const mk = (filter) => {
      // mid-grey background: a soft-light / overlay pass leaking outside the glyphs would change it
      const p = project({ background: '#404040' })
      const c = E().model.makeClip('text', V(p, 'V1'), 0, 2, { text: { content: 'I  I', size: 90, color: '#ffffff', background: false, bold: true }, filter })
      p.clips.push(c)
      return render(p, 1)
    }
    const plain = mk(undefined)
    const filtered = mk({ ...defaultFilter('warm'), tint: 0, grain: 80, temperature: 60 })
    // pixels that are pure background without the filter must stay background with it
    let leaked = 0
    let glyph = 0
    for (let i = 0; i < plain.data.length; i += 4) {
      const bg = plain.data[i] === 64 && plain.data[i + 1] === 64 && plain.data[i + 2] === 64
      if (!bg) glyph++
      else if (Math.abs(filtered.data[i] - 64) > 2 || Math.abs(filtered.data[i + 1] - 64) > 2 || Math.abs(filtered.data[i + 2] - 64) > 2) leaked++
    }
    return { ok: glyph > 100 && leaked === 0, detail: { glyphPixels: glyph, overlayPixelsOutsideGlyphs: leaked } }
  }))

// ================================================================ E4: letterbox
await test('E4 letterboxed export ≠ preview: nothing is drawn into the bars, inner picture equals the preview', (page) =>
  page.evaluate(() => {
    const { E, project, V, render, solid } = window.__T
    const p = project()
    const c = E().model.makeClip('image', V(p, 'V1'), 0, 2, { transform: { x: 0, y: 60, scale: 1, opacity: 1 } })
    p.clips.push(c)
    const frames = { [c.id]: solid(320, 180, '#ff0000') }
    const boxed = render(p, 1, frames, { w: 320, h: 240, offY: 30 })
    const plain = render(p, 1, frames)
    const bar = boxed.px(160, 225)
    let diff = 0
    for (let y = 0; y < 180; y += 3) for (let x = 0; x < 320; x += 3) if (boxed.px(x, y + 30).some((v, i) => Math.abs(v - plain.px(x, y)[i]) > 1)) diff++
    return { ok: bar[0] === 0 && bar[1] === 0 && bar[2] === 0 && diff === 0, detail: { bottomBar: bar, innerPixelsDiffering: diff } }
  }))

// ================================================================ E15: grain scales with output size
await test('E15 grain is sized in project pixels (same pattern in a half-size preview)', (page) =>
  page.evaluate(() => {
    const { E, project, V, render, solid } = window.__T
    const { defaultFilter } = E().filters
    const p = project({ width: 640, height: 360 })
    const c = E().model.makeClip('video', V(p, 'V1'), 0, 2, { filter: { ...defaultFilter(), grain: 80 } })
    p.clips.push(c)
    const period = (r, y, lag) => {
      let d = 0
      let n = 0
      for (let x = 0; x + lag < r.w; x++) {
        d += Math.abs(r.px(x, y)[0] - r.px(x + lag, y)[0])
        n++
      }
      return d / n
    }
    const half = render(p, 0, { [c.id]: solid(320, 180, '#808080') }, { scale: 0.5 })
    const fullR = render(p, 0, { [c.id]: solid(640, 360, '#808080') }, { scale: 1 })
    const halfLag80 = period(half, 90, 80) // 160 project px at scale 0.5
    const fullLag160 = period(fullR, 180, 160)
    return { ok: halfLag80 < 1.5 && fullLag160 < 1.5, detail: { meanDiffHalfAt80px: halfLag80.toFixed(2), meanDiffFullAt160px: fullLag160.toFixed(2) } }
  }))

// ================================================================ E14: adjustment clip inside a layer transition
await test('E14 adjustment layer keeps its effect inside a layer-based transition (ink drop)', (page) =>
  page.evaluate(() => {
    const { E, project, V, render, solid } = window.__T
    const { defaultFilter } = E().filters
    const p = project()
    const base = E().model.makeClip('image', V(p, 'V1'), 0, 2)
    const adj = E().model.makeClip('adjustment', V(p, 'V2'), 0, 2, { filter: defaultFilter('invert') })
    p.clips.push(base, adj)
    p.transitions = [{ id: 'tr', trackId: V(p, 'V2'), rightId: adj.id, type: 'ink-drop', duration: 1, easing: 'linear' }]
    const frames = { [base.id]: solid(320, 180, '#ff0000') }
    const during = render(p, 0.98, frames).px(160, 90)
    const after = render(p, 1.5, frames).px(160, 90)
    const cyan = (v) => v[0] < 20 && v[1] > 235 && v[2] > 235
    return { ok: cyan(during) && cyan(after), detail: { duringTransition: during, afterTransition: after } }
  }))

// ================================================================ E9: split keeps clip-local animation phase
await test('E9 split does not restart clip-local animation (loop spin text, Ken Burns image)', (page) =>
  page.evaluate(() => {
    const { E, project, V, render, gradient } = window.__T
    const S = E().store
    const p = project()
    const text = E().model.makeClip('text', V(p, 'V2'), 0, 4, {
      text: { content: 'SPIN', size: 40, color: '#ffffff', background: true, bold: true },
      anim: { ...E().animations.defaultAnim(), loop: 'spin', loopSpeed: 0.5 },
    })
    const img = E().model.makeClip('image', V(p, 'V1'), 0, 4, { effects: [{ id: 'kb', type: 'ken-burns', on: true, params: {} }] })
    p.clips.push(text, img)
    const frames = () => {
      const f = {}
      for (const c of S.getState().project.clips) if (c.kind === 'image') f[c.id] = gradient(320, 180)
      return f
    }
    S.replaceProject(p)
    const before = render(S.getState().project, 2.5, frames())
    S.setState({ selection: [], time: 2 })
    S.splitAtPlayhead()
    const after = render(S.getState().project, 2.5, frames())
    let diff = 0
    for (let i = 0; i < before.data.length; i += 4)
      if (Math.abs(before.data[i] - after.data[i]) > 2 || Math.abs(before.data[i + 1] - after.data[i + 1]) > 2) diff++
    return { ok: S.getState().project.clips.length === 4 && diff === 0, detail: { clips: S.getState().project.clips.length, pixelsChangedBySplit: diff } }
  }))

// ================================================================ E5: undo/redo/gestures keep imported assets
await test('E5 undo keeps media imported after the undone step (import A, place A, import B, ⌘Z)', (page) =>
  page.evaluate(() => {
    const { E, project, fakeAsset } = window.__T
    const S = E().store
    S.replaceProject(project())
    const A = fakeAsset('image')
    const B = fakeAsset('image')
    S.addAsset(A)
    S.placeAsset(A.id)
    S.addAsset(B)
    S.undo()
    const afterUndo = S.getState().project.assets.map((a) => a.id)
    S.redo()
    const afterRedo = S.getState().project.assets.map((a) => a.id)
    const ok = afterUndo.includes(A.id) && afterUndo.includes(B.id) && afterRedo.includes(B.id) && S.getState().project.clips.length === 1
    return { ok, detail: { afterUndoHasB: afterUndo.includes(B.id), afterRedoHasB: afterRedo.includes(B.id), clips: S.getState().project.clips.length } }
  }))

await test('E5 an import finishing during a drag survives the drag (and its undo)', (page) =>
  page.evaluate(() => {
    const { E, project, fakeAsset } = window.__T
    const S = E().store
    S.replaceProject(project())
    const A = fakeAsset('image')
    S.addAsset(A)
    S.placeAsset(A.id)
    const id = S.getState().project.clips[0].id
    S.beginGesture()
    S.updateGesture((p) => (p.clips.find((c) => c.id === id).start = 1))
    const C = fakeAsset('image')
    S.addAsset(C) // import completes mid-drag
    S.updateGesture((p) => (p.clips.find((c) => c.id === id).start = 2))
    S.endGesture('Move clip')
    const afterDrag = S.getState().project.assets.some((a) => a.id === C.id)
    const start = S.getState().project.clips[0].start
    S.undo()
    const afterUndo = S.getState().project.assets.some((a) => a.id === C.id)
    return { ok: afterDrag && afterUndo && start === 2, detail: { afterDrag, afterUndo, start } }
  }))

await test('E5 undo of an explicit media removal restores it; redo removes it again', (page) =>
  page.evaluate(() => {
    const { E, project, fakeAsset } = window.__T
    const S = E().store
    S.replaceProject(project())
    const A = fakeAsset('image')
    const B = fakeAsset('image')
    S.addAsset(A)
    S.addAsset(B)
    S.placeAsset(B.id)
    S.removeAsset(B.id)
    const removed = !S.getState().project.assets.some((a) => a.id === B.id) && S.getState().project.clips.length === 0
    S.undo()
    const restored =
      S.getState()
        .project.assets.map((a) => a.id)
        .join() === [A.id, B.id].join() && S.getState().project.clips.length === 1
    S.redo()
    const again = !S.getState().project.assets.some((a) => a.id === B.id) && S.getState().project.assets.some((a) => a.id === A.id)
    return { ok: removed && restored && again, detail: { removed, restored, removedAgainOnRedo: again } }
  }))

// ================================================================ E6: ripple delete of several clips
await test('E6 ripple delete X and Z of X[0-2] Y[2-4] Z[4-6] W[6-8] puts Y at 0-2 and W at 2-4 (any order)', (page) =>
  page.evaluate(() => {
    const { E, project, V } = window.__T
    const S = E().store
    const run = (order) => {
      const p = project()
      const mk = (s) => E().model.makeClip('image', V(p, 'V1'), s, 2)
      const [X, Y, Z, W] = [0, 2, 4, 6].map(mk)
      p.clips.push(X, Y, Z, W)
      S.replaceProject(p)
      S.setState({ selection: order === 'xz' ? [X.id, Z.id] : [Z.id, X.id] })
      S.deleteSelection(true)
      const q = S.getState().project.clips
      return { y: q.find((c) => c.id === Y.id).start, w: q.find((c) => c.id === W.id).start }
    }
    const a = run('xz')
    const b = run('zx')
    return { ok: a.y === 0 && a.w === 2 && b.y === 0 && b.w === 2, detail: { selectXZ: a, selectZX: b } }
  }))

// ================================================================ E7 / F7: track locks
await test('E7/F7 locked track: delete, cut, Inspector edit, gesture, paste attributes, transitions and track delete are refused', (page) =>
  page.evaluate(() => {
    const { E, project, V } = window.__T
    const S = E().store
    const p = project()
    const v1 = V(p, 'V1')
    const X = E().model.makeClip('image', v1, 0, 2)
    const Y = E().model.makeClip('image', v1, 2, 2)
    const T = E().model.makeClip('image', V(p, 'V2'), 0, 2, { transform: { x: 50, y: 0, scale: 0.5, opacity: 0.5 } })
    p.clips.push(X, Y, T)
    p.tracks.find((t) => t.id === v1).locked = true
    S.replaceProject(p)
    const snap = () => JSON.stringify(S.getState().project.clips.filter((c) => c.trackId === v1))
    const before = snap()
    const out = {}
    S.setState({ selection: [X.id] })
    S.deleteSelection(false)
    out.delete = snap() === before
    S.setState({ selection: [X.id] })
    S.deleteSelection(true)
    out.rippleDelete = snap() === before
    S.setState({ selection: [X.id] })
    S.copySelection(true)
    out.cut = snap() === before
    if (S.getState().project.clips.some((c) => c.id === X.id)) S.updateClip(X.id, 'Opacity', (c) => (c.transform.opacity = 0.2))
    out.inspector = snap() === before
    S.updateGesture((q) => {
      const c = q.clips.find((x) => x.id === X.id)
      if (c) c.transform.x = 99
    })
    S.endGesture('Position X')
    out.gesture = snap() === before
    S.setState({ selection: [T.id] })
    S.copySelection(false)
    S.setState({ selection: [X.id] })
    S.pasteAttributes()
    out.pasteAttributes = snap() === before
    S.addTransition(v1, X.id, Y.id, 'dissolve')
    out.addTransition = (S.getState().project.transitions ?? []).length === 0
    S.removeTrack(v1)
    out.removeTrack = S.getState().project.tracks.some((t) => t.id === v1) && snap() === before
    return { ok: Object.values(out).every(Boolean), detail: out }
  }))

await test('E7/F7 deleting an unlocked clip keeps its linked partner on a locked track', (page) =>
  page.evaluate(() => {
    const { E, project, V } = window.__T
    const S = E().store
    const p = project()
    const a1 = V(p, 'A1')
    const vid = E().model.makeClip('video', V(p, 'V1'), 0, 2, { linkId: 'L1', assetId: 'x' })
    const aud = E().model.makeClip('audio', a1, 0, 2, { linkId: 'L1', assetId: 'x' })
    p.clips.push(vid, aud)
    p.tracks.find((t) => t.id === a1).locked = true
    S.replaceProject(p)
    S.setState({ selection: [vid.id] })
    S.deleteSelection(false)
    const ids = S.getState().project.clips.map((c) => c.id)
    return { ok: ids.includes(aud.id) && !ids.includes(vid.id), detail: { videoDeleted: !ids.includes(vid.id), lockedAudioKept: ids.includes(aud.id) } }
  }))

await test('E7 Inspector shows a locked clip as read-only', (page) =>
  page.evaluate(async () => {
    const { E, project, V, sleep } = window.__T
    const S = E().store
    const p = project()
    const X = E().model.makeClip('text', V(p, 'V1'), 0, 2, { text: { content: 'Hi', size: 40, color: '#fff', background: true, bold: true } })
    p.clips.push(X)
    p.tracks.find((t) => t.name === 'V1').locked = true
    S.replaceProject(p)
    S.setState({ selection: [X.id], sideTab: 'inspector', selectedTransitionId: null })
    await sleep(250)
    const banner = !!document.querySelector('[data-testid="inspector-locked"]')
    const fs = document.querySelector('fieldset.inspector-fields')
    const textarea = document.querySelector('.inspector textarea')
    return {
      ok: banner && !!fs?.disabled && !!textarea?.matches(':disabled'),
      detail: { banner, fieldsetDisabled: !!fs?.disabled, textareaDisabled: !!textarea?.matches(':disabled') },
    }
  }))

// ================================================================ E12: transitions follow their clips
await test('E12 moving both clips of a transition to another track keeps the transition', (page) =>
  page.evaluate(() => {
    const { E, project, V } = window.__T
    const S = E().store
    const p = project()
    const a = E().model.makeClip('image', V(p, 'V1'), 0, 2)
    const b = E().model.makeClip('image', V(p, 'V1'), 2, 2)
    p.clips.push(a, b)
    p.transitions = [{ id: 'tr', trackId: V(p, 'V1'), leftId: a.id, rightId: b.id, type: 'dissolve', duration: 0.5, easing: 'linear' }]
    S.replaceProject(p)
    const v2 = V(p, 'V2')
    S.commit('Move clips', (q) => {
      for (const c of q.clips) c.trackId = v2
    })
    const q = S.getState().project
    const resolved = E().compositor.resolveTransitions(q, v2).length
    return { ok: (q.transitions ?? []).length === 1 && resolved === 1, detail: { transitions: (q.transitions ?? []).length, resolvedOnV2: resolved } }
  }))

// ================================================================ E13: a stale gesture can't revert later commits
await test('E13 a gesture left open does not revert a later edit', (page) =>
  page.evaluate(() => {
    const { E, project, V } = window.__T
    const S = E().store
    const p = project()
    const a = E().model.makeClip('image', V(p, 'V1'), 0, 2)
    p.clips.push(a)
    S.replaceProject(p)
    S.beginGesture() // e.g. a transition-handle drag whose pointerup was lost
    S.updateGesture((q) => (q.clips[0].transform.x = 10))
    S.updateClip(a.id, 'Opacity', (c) => (c.transform.opacity = 0.5))
    S.updateGesture((q) => (q.clips[0].transform.y = 20)) // next Inspector drag
    S.endGesture('Position Y')
    const c = S.getState().project.clips[0]
    return { ok: c.transform.opacity === 0.5 && c.transform.y === 20, detail: { opacity: c.transform.opacity, y: c.transform.y } }
  }))

// ================================================================ E1: export Blob URLs released
await test('E1 only the 10 most recent export outputs stay in memory; older Blob URLs are revoked', (page) =>
  page.evaluate(async () => {
    const { E } = window.__T
    const S = E().store
    S.clearReports()
    const urls = []
    for (let i = 0; i < 12; i++) {
      const url = URL.createObjectURL(new Blob([new Uint8Array(1024)]))
      urls.push(url)
      S.addReport({ id: `r${i}x`, status: 'done', target: 'buffer', output: { fileName: `f${i}.mp4` } }, url)
    }
    const kept = Object.keys(S.getState().outputs).length
    const alive = async (u) => {
      try {
        await (await fetch(u)).arrayBuffer()
        return true
      } catch {
        return false
      }
    }
    const oldestAlive = await alive(urls[0])
    const newestAlive = await alive(urls[11])
    S.clearReports()
    return { ok: kept === 10 && !oldestAlive && newestAlive, detail: { kept, oldestAlive, newestAlive } }
  }))

// ================================================================ concurrent jobs
await test(
  'JOBS a second export waits for the running one (no overlapping benchmark jobs)',
  (page) =>
    page.evaluate(async () => {
      const { E } = window.__T
      const nb = window.__nleBench
      const S = E().store
      const id = await nb.generateFixture({ width: 320, height: 180, duration: 1, fps: 30 })
      nb.buildTestTimeline(id)
      let maxRunning = 0
      let sawQueued = false
      const unsub = S.subscribe(() => {
        const jobs = S.getState().jobs
        maxRunning = Math.max(maxRunning, jobs.filter((j) => j.status !== 'queued').length)
        if (jobs.some((j) => j.status === 'queued')) sawQueued = true
      })
      const s = { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 320, height: 180 }
      const [a, b] = await Promise.all([nb.exportTimeline(s, { label: 'first' }), nb.exportTimeline(s, { label: 'second' })])
      unsub()
      const endA = Date.parse(a.createdAt)
      const startB = Date.parse(b.createdAt) - b.derived.wallMs
      return {
        ok: maxRunning === 1 && sawQueued && a.status === 'done' && b.status === 'done' && startB >= endA - 50,
        detail: { maxRunning, sawQueued, statuses: [a.status, b.status], gapMs: Math.round(startB - endA) },
      }
    }),
  90000,
)

// ================================================================ F10: IndexedDB connection closed on failure
await test('F10 autosave closes its IndexedDB connection when the transaction fails', (page) =>
  page.evaluate(async () => {
    const { E, sleep } = window.__T
    const S = E().store
    const proto = IDBDatabase.prototype
    const origTx = proto.transaction
    const origClose = proto.close
    let closes = 0
    proto.close = function () {
      closes++
      return origClose.call(this)
    }
    proto.transaction = function () {
      throw new DOMException('injected failure', 'InvalidStateError')
    }
    try {
      S.commit('Rename', (p) => (p.name = `n${Math.random()}`))
      await sleep(1400)
    } finally {
      proto.transaction = origTx
      proto.close = origClose
    }
    return { ok: closes >= 1 && S.getState().saveState === 'error', detail: { closes, saveState: S.getState().saveState } }
  }))

// ================================================================ E2: preview cache pruned
await test('E2 removing media disposes its preview decoder input', (page) =>
  page.evaluate(async () => {
    const { E, project, fakeAsset, sleep } = window.__T
    const S = E().store
    const pv = E().preview
    S.replaceProject(project())
    const A = fakeAsset('video')
    S.addAsset(A)
    S.placeAsset(A.id)
    await pv.renderAt(0.5)
    const opened = pv.media.has(A.id)
    S.removeAsset(A.id)
    await sleep(50)
    return { ok: opened && !pv.media.has(A.id), detail: { openedForPreview: opened, stillCachedAfterRemove: pv.media.has(A.id) } }
  }))

// ================================================================ E8: edits during playback reach audio
await test('E8 an audio edit during playback re-schedules the audio (a video-only edit does not)', (page) =>
  page.evaluate(async () => {
    const { E, project, fakeAsset, sleep } = window.__T
    const S = E().store
    const pv = E().preview
    const p = project()
    const A = fakeAsset('audio')
    p.assets = [A]
    const aud = E().model.makeClip('audio', p.tracks.find((t) => t.name === 'A1').id, 0, 5, { assetId: A.id })
    const img = E().model.makeClip('image', p.tracks.find((t) => t.name === 'V1').id, 0, 5)
    p.clips.push(aud, img)
    S.replaceProject(p)
    await pv.play()
    await sleep(300)
    const g0 = pv.audioGen
    S.updateClip(img.id, 'Opacity', (c) => (c.transform.opacity = 0.5))
    await sleep(300)
    const g1 = pv.audioGen
    S.updateClip(aud.id, 'Gain', (c) => (c.audio.gain = 0.25))
    await sleep(400)
    const g2 = pv.audioGen
    const playing = S.getState().playing
    pv.pause()
    return { ok: playing && g1 === g0 && g2 > g1, detail: { playing, genBefore: g0, afterVideoEdit: g1, afterGainEdit: g2 } }
  }))

// ================================================================ E17: preview clock includes output latency
await test('E17 preview picture follows the speaker (subtracts outputLatency + baseLatency)', (page) =>
  page.evaluate(() => {
    const { E } = window.__T
    const pv = E().preview
    const saved = { ctx: pv.audioCtx, t0: pv.playT0, c0: pv.playCtx0 }
    pv.audioCtx = { currentTime: 10, outputLatency: 0.2, baseLatency: 0.01 }
    pv.playT0 = 0
    pv.playCtx0 = 0
    const t = pv.currentPlayTime()
    pv.audioCtx = saved.ctx
    pv.playT0 = saved.t0
    pv.playCtx0 = saved.c0
    return { ok: Math.abs(t - 9.79) < 1e-9, detail: { shownTime: t } }
  }))

// ================================================================ E16: audio mix
await test('E16 down-mix keeps quad surrounds and the 7.1 centre; buffer append is linear time', (page) =>
  page.evaluate(() => {
    const { E } = window.__T
    const R = E().audioMix.ClipAudioReader.prototype
    const n = 8
    const planes = (c, hot) => Array.from({ length: c }, (_, i) => new Float32Array(n).fill(hot.includes(i) ? 1 : 0))
    const quad = R.mapChannels.call({ outCh: 2 }, planes(4, [2, 3])) // only SL/SR carry signal
    const s71 = R.mapChannels.call({ outCh: 2 }, planes(8, [2])) // only centre
    const quadOk = quad[0][0] > 0.3 && quad[1][0] > 0.3
    const centreOk = s71[0][0] > 0.5 && s71[1][0] > 0.5
    // append: 3000 packets of 1024 frames (the old full-copy-per-packet append took seconds)
    const obj = { bufStart: 0, bufLen: 0, srcRate: 48000, outCh: 2, buf: [new Float32Array(0), new Float32Array(0)] }
    const chunk = [new Float32Array(1024).fill(0.5), new Float32Array(1024).fill(-0.5)]
    const t0 = performance.now()
    for (let i = 0; i < 3000; i++) R.append.call(obj, chunk, (i * 1024) / 48000)
    const ms = performance.now() - t0
    const dataOk = obj.bufLen === 3000 * 1024 && obj.buf[0][obj.bufLen - 1] === 0.5 && obj.buf[1][12345] === -0.5
    return {
      ok: quadOk && centreOk && dataOk && ms < 100,
      detail: { quadLR: [quad[0][0], quad[1][0]], centreLR: [s71[0][0], s71[1][0]], appendMs: Math.round(ms), dataOk },
    }
  }))

// ================================================================ E18: timecode at fractional rates
await test('E18 timecode does not drift at 29.97 (drop-frame) and 23.976 (exact rate)', (page) =>
  page.evaluate(() => {
    const { E } = window.__T
    const { formatTimecode: f, parseTimecode: parse } = E().model
    const got = {
      df10min: f(600, 29.97),
      df1min: f(60, 29.97), // real 60 s = frame 1798 → 00:00:59;28 (drop-frame only re-syncs every 10 min)
      df1hour: f(3600, 29.97),
      r23hour: f(3600, 23.976),
      int30: f(61.5, 30),
    }
    const round = [600, 60, 3600, 123.456].every((t) => Math.abs(parse(f(t, 29.97), 29.97, 0) - t) < 1 / 29.97)
    const round23 = [3600, 61.2].every((t) => Math.abs(parse(f(t, 23.976), 23.976, 0) - t) < 1 / 23.976)
    const ok =
      got.df10min === '00:10:00;00' &&
      got.df1min === '00:00:59;28' &&
      got.df1hour === '01:00:00;00' &&
      got.r23hour === '01:00:00:00' &&
      got.int30 === '00:01:01:15' &&
      round &&
      round23
    return { ok, detail: { ...got, roundTrip: round && round23 } }
  }))

// ================================================================ E19: dragged clip edges land on frames
await test('E19 a clip dragged on the timeline lands on the frame grid', async (page) => {
  await page.evaluate(() => {
    const { E, project, fakeAsset } = window.__T
    const S = E().store
    const p = project({ width: 1920, height: 1080 })
    const A = fakeAsset('image')
    p.assets = [A]
    const c = E().model.makeClip('image', p.tracks.find((t) => t.name === 'V1').id, 1, 2, { assetId: A.id })
    p.clips.push(c)
    S.replaceProject(p)
    S.setState({ zoom: 80, snapping: false })
    window.__T.clipId = c.id
  })
  await page.waitForTimeout(300)
  const id = await page.evaluate(() => window.__T.clipId)
  const box = await page.locator(`.clip[data-clip-id="${id}"]`).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 37, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  const start = await page.evaluate(
    (cid) =>
      window.__T
        .E()
        .store.getState()
        .project.clips.find((c) => c.id === cid).start,
    id,
  )
  const frames = start * 30
  return { ok: Math.abs(start - 1) > 0.1 && Math.abs(frames - Math.round(frames)) < 1e-6, detail: { start, frames } }
})

// ================================================================ E20: small items
await test('E20 a no-op commit adds no undo entry', (page) =>
  page.evaluate(() => {
    const { E, project } = window.__T
    const S = E().store
    S.replaceProject(project())
    S.commit('Nothing', () => {})
    return { ok: S.getState().undoLabel === null, detail: { undoLabel: S.getState().undoLabel } }
  }))

await test('E20 redo drops selected clips that the redone step removes', (page) =>
  page.evaluate(() => {
    const { E, project, V } = window.__T
    const S = E().store
    const p = project()
    const X = E().model.makeClip('image', V(p, 'V1'), 0, 2)
    p.clips.push(X)
    S.replaceProject(p)
    S.setState({ selection: [X.id] })
    S.deleteSelection(false)
    S.undo()
    S.setState({ selection: [X.id] })
    S.redo()
    return { ok: S.getState().selection.length === 0, detail: { selection: S.getState().selection } }
  }))

await test('E20 deleting a track clears linkIds left dangling on its partners', (page) =>
  page.evaluate(() => {
    const { E, project, V } = window.__T
    const S = E().store
    const p = project()
    const vid = E().model.makeClip('video', V(p, 'V2'), 0, 2, { linkId: 'L1', assetId: 'x' })
    const aud = E().model.makeClip('audio', V(p, 'A1'), 0, 2, { linkId: 'L1', assetId: 'x' })
    p.clips.push(vid, aud)
    S.replaceProject(p)
    S.removeTrack(V(p, 'V2'))
    const a = S.getState().project.clips.find((c) => c.id === aud.id)
    return { ok: !!a && !a.linkId, detail: { audioLinkId: a?.linkId ?? null } }
  }))

await test('E20 pooled layers are returned when an effect throws', (page) =>
  page.evaluate(() => {
    const { E, project, V, solid } = window.__T
    const def = E().videoEffects.effectDef('invert')
    const orig = def.process
    const p = project()
    const c = E().model.makeClip('image', V(p, 'V1'), 0, 2, {
      effects: [
        { id: 'a', type: 'duotone', on: true, params: {} },
        { id: 'b', type: 'invert', on: true, params: { amount: 50 } },
      ],
    })
    p.clips.push(c)
    const before = E().fxUtil.poolStats().outstanding
    def.process = () => {
      throw new Error('boom')
    }
    let threw = false
    try {
      E().compositor.drawFrame(new OffscreenCanvas(320, 180).getContext('2d'), p, 1, new Map([[c.id, solid(320, 180, '#f00')]]), 1)
    } catch {
      threw = true
    } finally {
      def.process = orig
    }
    const after = E().fxUtil.poolStats().outstanding
    const l1 = E().fxUtil.acquire(320, 180)
    const l2 = E().fxUtil.acquire(320, 180)
    E().fxUtil.release(l1, l2)
    return { ok: threw && after === before && l1 !== l2, detail: { threw, outstandingBefore: before, outstandingAfter: after, distinctLayers: l1 !== l2 } }
  }))

await test('E20 on-canvas hit-testing honours clip rotation', async (page) => {
  await page.evaluate(() => {
    const { E, project, fakeAsset } = window.__T
    const S = E().store
    const p = project({ width: 1920, height: 1080 })
    const A = fakeAsset('image', { imageWidth: 1600, imageHeight: 200 })
    p.assets = [A]
    const c = E().model.makeClip('image', p.tracks.find((t) => t.name === 'V1').id, 0, 5, { assetId: A.id, rotation: 90 })
    p.clips.push(c)
    S.replaceProject(p)
    S.setState({ time: 1, selection: [] })
    window.__T.clipId = c.id
  })
  await page.waitForTimeout(300)
  const root = await page.locator('.xform-root').boundingBox()
  const k = root.width / 1920
  const clickAt = async (x, y) => {
    await page.evaluate(() => window.__T.E().store.setState({ selection: [] }))
    await page.mouse.click(root.x + x * k, root.y + y * k)
    await page.waitForTimeout(80)
    return page.evaluate(() => window.__T.E().store.getState().selection.length)
  }
  const insideRotated = await clickAt(960, 100) // inside the rotated clip, outside its unrotated rect
  const insideUnrotatedOnly = await clickAt(250, 540) // inside the unrotated rect only
  return {
    ok: insideRotated === 1 && insideUnrotatedOnly === 0,
    detail: { selectedOnRotatedHit: insideRotated, selectedOnUnrotatedOnlyHit: insideUnrotatedOnly },
  }
})

await browser.close()
server.kill()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} editor regression tests passed`)
process.exit(failed.length ? 1 : 0)
