#!/usr/bin/env node
/**
 * Showcase: opens the editor in headed Chrome, waits for you to import 3 videos, then builds an
 * edit that uses almost every tool (8 cuts, 9 transitions, 20+ video effects, filters, PiP, stickers,
 * animated titles with text effects, adjustment layers, linked audio) and plays it (export only with --export). The browser stays open until you close it.
 *
 *   node bench/showcase.mjs                 # uses your running `npm run dev` (127.0.0.1:5173), else starts one
 *   node bench/showcase.mjs --url http://127.0.0.1:5173
 *   node bench/showcase.mjs --test          # self-test: generates 3 clips instead of waiting, headless, exits
 *   node bench/showcase.mjs --export        # also export the MP4 to bench-results/showcase/ (off by default)
 *   node bench/showcase.mjs --files a.mp4 b.mov c.mp4   # import these instead of waiting for you
 *   node bench/showcase.mjs --no-sfx        # skip the sound-effect kit (bench/sfx/, imported automatically)
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'bench-results', 'showcase')
mkdirSync(out, { recursive: true })
const argv = process.argv.slice(2)
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
const test = argv.includes('--test')
const files = argv.includes('--files') ? argv.slice(argv.indexOf('--files') + 1).filter((x) => !x.startsWith('--')).map((f) => path.resolve(f)) : []
const doExport = argv.includes('--export')
const log = (...a) => console.log('[showcase]', ...a)
// how many videos the edit uses (1–4): --count N, else the number of --files videos, else 3
const want = arg('--count') ? Math.max(1, Math.min(4, Number(arg('--count')) || 3)) : null

// sound-effect kit (bench/sfx/sfx-*.wav, synthesized by bench/make-sfx.mjs); --no-sfx skips it
const sfxDir = path.join(root, 'bench', 'sfx')
const useSfx = !argv.includes('--no-sfx')
if (useSfx && !existsSync(path.join(sfxDir, 'sfx-whoosh.wav'))) {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, [path.join(root, 'bench', 'make-sfx.mjs')], { stdio: 'inherit' })
}
const sfxFiles = useSfx ? readdirSync(sfxDir).filter((f) => /^sfx-.+\.wav$/.test(f)).map((f) => path.join(sfxDir, f)) : []

const up = async (u) => {
  try {
    return (await fetch(u)).ok
  } catch {
    return false
  }
}

let url = arg('--url')
let server = null
if (!url) {
  // loopback addresses only: the name localhost can resolve elsewhere on a misconfigured machine
  for (const u of ['http://127.0.0.1:5173', 'http://[::1]:5173']) {
    if (await up(u)) {
      url = u
      break
    }
  }
}
if (!url) {
  const port = 5181
  log(`no dev server on :5173 — starting one on :${port}`)
  server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' })
  url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100 && !(await up(url)); i++) await new Promise((r) => setTimeout(r, 200))
}
url = url.replace('[::1]', '127.0.0.1')
log(`editor: ${url}`)

const browser = await chromium.launch({ channel: 'chrome', headless: test, args: ['--start-maximized'] })
const context = await browser.newContext({ viewport: test ? { width: 1440, height: 900 } : null, acceptDownloads: true })
const page = await context.newPage()
page.on('pageerror', (e) => log('page error:', e.message))
const cleanup = () => {
  server?.kill()
}

const seek = async (t) => {
  await page.evaluate((t) => window.__nleBench.seek(t), t)
  await page.waitForTimeout(600)
}

try {
  await page.goto(url)
  await page.waitForFunction(() => window.__nleBench?.ready, null, { timeout: 60000 })

  if (test) {
    for (const [i, spec] of [
      { width: 1280, height: 720, duration: 8, fps: 30 },
      { width: 1280, height: 720, duration: 6, fps: 30 },
      { width: 1280, height: 720, duration: 5, fps: 30 },
    ].entries()) {
      await page.evaluate((s) => window.__nleBench.generateFixture(s), spec)
      log(`generated test clip ${i + 1}`)
    }
    if (sfxFiles.length) await page.locator('input[type=file]').first().setInputFiles(sfxFiles)
  } else if (files.length) {
    log(`importing ${files.length} file(s): ${files.map((f) => path.basename(f)).join(', ')}`)
    await page.locator('input[type=file]').first().setInputFiles([...files, ...sfxFiles])
  } else {
    if (sfxFiles.length) await page.locator('input[type=file]').first().setInputFiles(sfxFiles)
    log(`Chrome is open — import ${want ?? 3} videos (drag them onto the Media panel, or click Import).`)
  }

  // wait until the videos are decodable in the bin
  const need = want ?? (files.length ? Math.min(4, files.length) : 3)
  let vids = []
  for (let last = -1; ; ) {
    vids = await page.evaluate(() => window.__nleBench.assets().filter((a) => a.info.kind === 'video' && a.info.video?.canDecode))
    if (vids.length !== last) {
      last = vids.length
      log(`videos imported: ${vids.length}/${need}${vids.length ? ' — ' + vids.map((v) => v.name).join(', ') : ''}`)
    }
    const nSfx = await page.evaluate(() => window.__nleBench.assets().filter((a) => /^sfx-/.test(a.name)).length)
    if (vids.length >= need && nSfx >= sfxFiles.length) break
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(800) // let thumbnails finish

  const ids = vids.slice(0, need).map((v) => v.id)
  const total = await page.evaluate((ids) => window.__nleBench.buildShowcase(ids), ids)
  log(`built a ${total.toFixed(1)} s edit from: ${vids.slice(0, need).map((v) => v.name).join(', ')}${sfxFiles.length ? ` + ${sfxFiles.length} sound effects` : ''}`)

  // snapshot a few moments for reference
  for (const [i, t] of [0.9, total * 0.18, total * 0.33, total * 0.5, total * 0.66, total * 0.82, total - 0.6].entries()) {
    await seek(t)
    await page.locator('canvas.viewer-canvas').screenshot({ path: path.join(out, `frame-${i + 1}.png`) }).catch(() => page.screenshot({ path: path.join(out, `frame-${i + 1}.png`) }))
  }
  await page.screenshot({ path: path.join(out, 'editor.png') })
  await seek(0)

  if (doExport) {
    log('exporting MP4 in the worker (watch progress in the Bench panel / Export Monitor)…')
    const r = await page.evaluate(() => window.__nleBench.exportTimeline({}, { runIn: 'worker', label: 'showcase', keepOutput: true }))
    log(`export ${r.status}, verify ${r.verify?.ok ? 'ok' : JSON.stringify(r.verify?.problems ?? r.error)} · ${(r.derived.conversionMs / 1000).toFixed(1)} s total · composite ${(r.timings.composite / 1000).toFixed(1)} s · ${(r.output?.bytes / 1e6).toFixed(1)} MB`)
    const dl = page.waitForEvent('download')
    await page.evaluate((id) => {
      const href = window.__nleBench.outputUrl(id)
      if (!href) throw new Error('export output not found')
      const a = document.createElement('a')
      a.href = href
      a.download = 'showcase.mp4'
      document.body.append(a)
      a.click()
      a.remove()
    }, r.id)
    const file = path.join(out, `showcase-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`)
    await (await dl).saveAs(file)
    log(`saved ${path.relative(root, file)}`)
  }

  if (test) {
    await browser.close()
  } else {
    log('Ready. Press Space in the editor to play it. Close the Chrome window when you are done.')
    await page.keyboard.press('Space').catch(() => {})
    await new Promise((r) => browser.on('disconnected', r))
  }
} catch (err) {
  log('failed:', err)
  await page.screenshot({ path: path.join(out, 'error.png') }).catch(() => {})
  process.exitCode = 1
  if (test) await browser.close()
  else await new Promise((r) => browser.on('disconnected', r))
} finally {
  cleanup()
}
