#!/usr/bin/env node
/**
 * Regression tests for defects found by the 2026-11-18 audits. Each test reproduces the failing case from the audit
 * report and must fail on the unfixed code.
 *   npm run build && node bench/regress.mjs [--headed]
 *
 *   F1  exports whose range ends between two audio samples used to hang (audio cursor never advanced)
 *   F2  stream-copy conversion ignored the requested audio sample rate / channel count
 *   F3  the output verifier passed files with the wrong audio config, a missing audio track, or a truncated tail
 *   B1  AAC always ran on the WASM extension (never the browser's encoder), and reports didn't say which ran
 *   B2  a hidden tab during a job was not recorded
 *   R1  the verifier treated copy-allowed conversions with matching codecs as stream copies: it skipped the size/fps
 *       checks (false positive) and expected the SOURCE frame count in full mode (false negative)
 *   F4  a failed disk write left the writable file neither closed nor aborted
 *
 * A hang is detected with a hard timeout; the browser context is then closed (a stuck worker can't be cancelled).
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const headless = !process.argv.includes('--headed')
const port = 4188
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root })
const url = `http://127.0.0.1:${port}`
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(url)).ok) break
  } catch {
    /* wait */
  }
  await new Promise((r) => setTimeout(r, 200))
}

/** 16-bit PCM WAV with a sine per channel. */
function wav({ rate = 48000, channels = 2, seconds = 1 }) {
  const n = Math.round(rate * seconds)
  const buf = Buffer.alloc(44 + n * channels * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * channels * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * channels * 2, 28)
  buf.writeUInt16LE(channels * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * channels * 2, 40)
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * (440 + 110 * c) * i) / rate) * 12000), 44 + (i * channels + c) * 2)
  return [...buf]
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ channel: 'chrome', headless })
async function freshPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(`${url}/?fresh=1`)
  await page.waitForFunction(() => window.__nleBench?.ready, null, { timeout: 60000 })
  return { ctx, page }
}
/** Runs fn(page) in a fresh context; resolves 'TIMEOUT' after ms and closes the context (kills a hung worker). */
async function withTimeout(ms, fn) {
  const { ctx, page } = await freshPage()
  let timer
  try {
    return await Promise.race([fn(page), new Promise((r) => (timer = setTimeout(() => r('TIMEOUT'), ms)))])
  } catch (e) {
    return { error: String(e.message ?? e).split('\n')[0] }
  } finally {
    clearTimeout(timer)
    await ctx.close().catch(() => {})
  }
}

const SRC = wav({ rate: 48000, channels: 2, seconds: 1 })
const WAV_SETTINGS = { container: 'wav', videoCodec: null, audioCodec: 'pcm-s16', sampleRate: 48000, audioChannels: 2 }

// ---------------------------------------------------------------- F1: fractional audio tail
for (const runIn of ['worker', 'main']) {
  // Main-thread mode would freeze the test page on the old code, so only run it once worker mode is known good.
  if (runIn === 'main' && !results.find((r) => r.name.startsWith('F1 audio-only WAV, range 0.100001 s [worker]'))?.ok) {
    record(`F1 audio-only WAV, range 0.100001 s [main]`, false, 'skipped: worker case failed (would freeze the page)')
    continue
  }
  const r = await withTimeout(15000, (page) =>
    page.evaluate(
      async ({ bytes, s, runIn }) => {
        const id = await window.__nleBench.importBytes('tone.wav', bytes, 'audio/wav')
        window.__nleBench.buildAudioTimeline(id, 0.5)
        const rep = await window.__nleBench.exportRange({ start: 0, end: 0.100001 }, s, { runIn })
        return { status: rep.status, error: rep.error, duration: rep.verify?.duration, ok: rep.verify?.ok }
      },
      { bytes: SRC, s: WAV_SETTINGS, runIn },
    ),
  )
  const ok = r !== 'TIMEOUT' && r.status === 'done' && r.ok && Math.abs(r.duration - 0.1) < 0.002
  record(`F1 audio-only WAV, range 0.100001 s [${runIn}]`, ok, r === 'TIMEOUT' ? 'HUNG (no result after 15 s)' : JSON.stringify(r))
}
{
  const r = await withTimeout(45000, (page) =>
    page.evaluate(async () => {
      const id = await window.__nleBench.generateFixture({ width: 640, height: 360, duration: 2, fps: 30 })
      window.__nleBench.buildTestTimeline(id)
      const rep = await window.__nleBench.exportRange({ start: 0, end: 1.000001 }, { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 640, height: 360 }, { runIn: 'worker' })
      return { status: rep.status, error: rep.error, duration: rep.verify?.duration, ok: rep.verify?.ok, problems: rep.verify?.problems }
    }),
  )
  record('F1 video + audio MP4, range 1.000001 s [worker]', r !== 'TIMEOUT' && r.status === 'done' && r.ok, r === 'TIMEOUT' ? 'HUNG (no result after 45 s)' : JSON.stringify(r))
}

// ---------------------------------------------------------------- F2: copy must honour requested audio config
{
  const r = await withTimeout(30000, (page) =>
    page.evaluate(
      async ({ bytes }) => {
        const id = await window.__nleBench.importBytes('tone48k-stereo.wav', bytes, 'audio/wav')
        const rep = await window.__nleBench.convert(id, { container: 'wav', videoCodec: null, audioCodec: 'pcm-s16', sampleRate: 24000, audioChannels: 1 }, { allowCopy: true, keepOutput: true })
        const info = await window.__nleBench.probe(rep.id)
        return { status: rep.status, copyExpected: rep.conversion?.copyExpected?.audio, rate: info.audio?.sampleRate, channels: info.audio?.channels, verifyOk: rep.verify?.ok }
      },
      { bytes: SRC },
    ),
  )
  const ok = r !== 'TIMEOUT' && r.status === 'done' && r.rate === 24000 && r.channels === 1 && r.copyExpected === false && r.verifyOk === true
  record('F2 WAV 48 kHz stereo → 24 kHz mono with copy allowed', ok, JSON.stringify(r))
}

// ---------------------------------------------------------------- F3: the verifier must reject bad outputs
{
  const r = await withTimeout(30000, (page) =>
    page.evaluate(
      async ({ bytes }) => {
        const file = new File([new Uint8Array(bytes)], 'tone48k-stereo.wav', { type: 'audio/wav' })
        const job = { kind: 'convert', engine: 'conversion', allowCopy: true, settings: { container: 'wav', videoCodec: null, audioCodec: 'pcm-s16', sampleRate: 24000, audioChannels: 1, fps: 30 }, asset: { info: { audio: { codec: 'pcm-s16' } } } }
        const v = await window.__nleBench.verifyFile(file, job, 1, { tracks: { video: false, audio: true }, mimeType: 'audio/wav' })
        return { ok: v.ok, problems: v.problems }
      },
      { bytes: SRC },
    ),
  )
  record('F3 verifier rejects 48 kHz stereo when 24 kHz mono was requested', r !== 'TIMEOUT' && r.ok === false, JSON.stringify(r))
}
{
  const r = await withTimeout(45000, (page) =>
    page.evaluate(async () => {
      // a video-only file, verified as the output of a job that was supposed to write audio too
      const id = await window.__nleBench.generateFixture({ width: 640, height: 360, duration: 2, fps: 30, audioCodec: null })
      window.__nleBench.buildTestTimeline(id)
      await window.__nleBench.exportRange({ start: 0, end: 2 }, { container: 'mp4', videoCodec: 'avc', audioCodec: null, width: 640, height: 360 }, { runIn: 'worker', keepFile: true })
      const file = window.__nleBench.lastFile
      const job = { kind: 'export', settings: { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 640, height: 360, fps: 30, sampleRate: 48000, audioChannels: 2 } }
      const v = await window.__nleBench.verifyFile(file, job, 2, { tracks: { video: true, audio: true }, mimeType: 'video/mp4' })
      return { ok: v.ok, problems: v.problems }
    }),
  )
  record('F3 verifier rejects an output that is missing its audio track', r !== 'TIMEOUT' && r.ok === false, JSON.stringify(r))
}
{
  const r = await withTimeout(45000, (page) =>
    page.evaluate(async () => {
      // a 4 s MP4 cut at 55 % (index at the front, so it still opens): its tail frames are gone
      const id = await window.__nleBench.generateFixture({ width: 640, height: 360, duration: 4, fps: 30 })
      window.__nleBench.buildTestTimeline(id)
      const rep = await window.__nleBench.exportRange({ start: 0, end: 4 }, { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 640, height: 360 }, { runIn: 'worker', keepFile: true })
      const full = window.__nleBench.lastFile
      const cut = new File([full.slice(0, Math.floor(full.size * 0.55))], 'cut.mp4', { type: 'video/mp4' })
      const job = { kind: 'export', settings: { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 640, height: 360, fps: 30, sampleRate: 48000, audioChannels: 2 } }
      const intact = await window.__nleBench.verifyFile(full, job, 4, { tracks: { video: true, audio: true }, mimeType: 'video/mp4' })
      const v = await window.__nleBench.verifyFile(cut, job, 4, { tracks: { video: true, audio: true }, mimeType: 'video/mp4' })
      return { exportOk: rep.verify?.ok, intactOk: intact.ok, intactProblems: intact.problems, cutOk: v.ok, problems: v.problems }
    }),
  )
  record('F3 verifier rejects a truncated MP4 (and still accepts the intact one)', r !== 'TIMEOUT' && r.intactOk === true && r.cutOk === false, JSON.stringify(r))
}

// ---------------------------------------------------------------- B1: AAC encoder choice is real and recorded
{
  const r = await withTimeout(90000, (page) =>
    page.evaluate(async () => {
      const id = await window.__nleBench.generateFixture({ width: 640, height: 360, duration: 3, fps: 30 })
      window.__nleBench.buildTestTimeline(id)
      const hasNative = typeof AudioEncoder !== 'undefined' && (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported
      const out = { hasNative }
      for (const mode of hasNative ? ['native', 'wasm', 'auto'] : ['wasm', 'auto']) {
        const rep = await window.__nleBench.exportRange({ start: 0, end: 3 }, { container: 'mp4', videoCodec: null, audioCodec: 'aac', aacEncoder: mode }, { runIn: 'worker' })
        out[mode] = { status: rep.status, impl: rep.audioEncoder?.impl, ok: rep.verify?.ok, bytes: rep.output.bytes }
      }
      return out
    }),
  )
  const want = (m, impl) => r[m]?.status === 'done' && r[m].ok === true && r[m].impl === impl
  const ok =
    r !== 'TIMEOUT' &&
    want('wasm', 'wasm-extension') &&
    (r.hasNative
      ? want('native', 'native-webcodecs') && want('auto', 'native-webcodecs') && r.native.bytes !== r.wasm.bytes // different encoders → different bitstreams
      : want('auto', 'wasm-extension'))
  record('B1 AAC native vs WASM is selectable, actually changes the encoder, and is recorded', ok, JSON.stringify(r))
}

// ---------------------------------------------------------------- B2: tab visibility is recorded
{
  const r = await withTimeout(45000, (page) =>
    page.evaluate(async () => {
      // simulate the user switching tabs mid-job (headless tabs never become hidden on their own)
      let vis = 'visible'
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis })
      const flip = (v) => {
        vis = v
        document.dispatchEvent(new Event('visibilitychange'))
      }
      const id = await window.__nleBench.generateFixture({ width: 640, height: 360, duration: 4, fps: 30 })
      window.__nleBench.buildTestTimeline(id)
      // flip relative to the job's own start (jobRunner awaits this gate right before the job)
      window.__nleBenchGate = async (name) => {
        if (name !== 'job-start') return
        setTimeout(() => flip('hidden'), 30)
        setTimeout(() => flip('visible'), 330)
      }
      const rep = await window.__nleBench.exportRange({ start: 0, end: 4 }, { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 640, height: 360 }, { runIn: 'worker' })
      return { wallMs: rep.derived.wallMs, visibility: rep.visibility }
    }),
  )
  const v = r?.visibility
  const ok = r !== 'TIMEOUT' && v && v.changes === 2 && v.hiddenMs > 200 && v.hiddenMs < 500 && v.startedHidden === false && v.endedHidden === false
  record('B2 a tab hidden mid-job is recorded (≈300 ms hidden)', ok, JSON.stringify(r))
}

// ---------------------------------------------------------------- R1: copy-allowed conversions are verified against the request
{
  const r = await withTimeout(60000, (page) =>
    page.evaluate(async () => {
      const b = window.__nleBench
      b.reset(320, 180, 30)
      const id = await b.generateFixture({ width: 320, height: 180, duration: 1, fps: 30 })
      b.buildTestTimeline(id)
      await b.exportRange({ start: 0, end: 1 }, { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 320, height: 180 }, { runIn: 'worker', keepFile: true })
      // a 320×180 @ 30 file offered as the output of a copy-allowed 160×90 @ 60 conversion
      const job = { kind: 'convert', engine: 'conversion', allowCopy: true, settings: { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 160, height: 90, fps: 60, sampleRate: 48000, audioChannels: 2 }, asset: { info: { video: { codec: 'avc', width: 320, height: 180, fps: 30 }, audio: { codec: 'aac' } } } }
      const v = await b.verifyFile(b.lastFile, job, 1, { tracks: { video: true, audio: true }, mimeType: 'video/mp4' })
      return { ok: v.ok, problems: v.problems }
    }),
  )
  record('R1 verifier rejects a 320×180@30 file for a copy-allowed 160×90@60 request', r !== 'TIMEOUT' && r.ok === false && r.problems.some((p) => /size/.test(p)), JSON.stringify(r))
}
{
  const r = await withTimeout(60000, (page) =>
    page.evaluate(async () => {
      const b = window.__nleBench
      localStorage.setItem('bench.fullVerify', '1')
      const id = await b.generateFixture({ width: 320, height: 180, duration: 1, fps: 30 })
      const out = {}
      for (const depth of ['full', 'head+tail']) {
        if (depth !== 'full') localStorage.removeItem('bench.fullVerify')
        const rep = await b.convert(id, { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 160, height: 90, fps: 60 }, { allowCopy: true })
        out[depth] = { status: rep.status, copied: rep.conversion?.copyExpected?.video, depth: rep.verify?.depth, ok: rep.verify?.ok, problems: rep.verify?.problems }
      }
      return out
    }),
  )
  const good = (x) => x?.status === 'done' && x.copied === false && x.ok === true
  record('R1 a correct copy-allowed resize + 30→60 fps conversion verifies (full and head+tail)', r !== 'TIMEOUT' && good(r.full) && r.full.depth === 'full' && good(r['head+tail']), JSON.stringify(r))
}

// ---------------------------------------------------------------- F4: a failed write aborts the writable
{
  const r = await withTimeout(45000, (page) =>
    page.evaluate(async () => {
      const b = window.__nleBench
      if (typeof b.exportToHandle !== 'function') return { missing: 'exportToHandle hook' }
      const id = await b.generateFixture({ width: 320, height: 180, duration: 1, fps: 30 })
      b.buildTestTimeline(id)
      const calls = { createWritable: 0, write: 0, close: 0, abort: 0 }
      const handle = {
        name: 'fail.mp4',
        createWritable: async () => {
          calls.createWritable++
          return {
            write: async () => {
              calls.write++
              throw new Error('synthetic disk-full')
            },
            close: async () => void calls.close++,
            abort: async () => void calls.abort++,
          }
        },
        getFile: async () => new File([], 'fail.mp4'),
      }
      const rep = await b.exportToHandle({ start: 0, end: 1 }, { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 320, height: 180 }, handle)
      // the page must still be able to export normally afterwards (nothing left half-open)
      const after = await b.exportRange({ start: 0, end: 1 }, { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 320, height: 180 }, { runIn: 'main' })
      return { status: rep.status, error: rep.error, calls, afterStatus: after.status, afterOk: after.verify?.ok }
    }),
  )
  const ok = r !== 'TIMEOUT' && !r.missing && r.status === 'error' && r.calls.abort === 1 && r.calls.close === 0 && r.afterStatus === 'done' && r.afterOk === true
  record('F4 a failed disk write aborts the writable, and the next export works', ok, JSON.stringify(r))
}

await browser.close()
preview.kill()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} regression tests passed`)
process.exit(failed.length ? 1 : 0)
