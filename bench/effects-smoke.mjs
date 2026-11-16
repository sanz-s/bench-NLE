#!/usr/bin/env node
/**
 * Effects smoke test through the real UI: text presets, stickers, filters, transitions (drag onto a
 * cut), copy/paste, then an effects-heavy export rendered in the worker + main thread and re-probed.
 *   npm run build && node bench/effects-smoke.mjs [--headless]
 * Screenshots → bench-results/effects-smoke/
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'bench-results', 'effects-smoke')
mkdirSync(out, { recursive: true })
const headless = process.argv.includes('--headless')
const port = 4185
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

const fails = []
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) fails.push(msg)
}
const shot = (page, name) => page.screenshot({ path: path.join(out, name) })

const browser = await chromium.launch({ channel: 'chrome', headless })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => fails.push(`page error: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()))
const tab = (name) => page.locator('.left-tabs button', { hasText: name }).click()
const seek = async (t) => {
  await page.locator('input.timecode').click()
  await page.keyboard.type(String(t))
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(350)
}

try {
  await page.goto(`${url}/?fresh=1`)
  await page.waitForFunction(() => window.__nleBench?.ready)
  await page.evaluate(() => window.__nleBench.setAutomated(true))
  await page.getByRole('button', { name: 'Or generate a test clip' }).click()
  await page.waitForSelector('.bin-item', { timeout: 60000 })
  await page.locator('.bin-item').first().dblclick()
  await page.waitForSelector('.clip-video')

  // split V1 at 5 s → a cut to put a transition on
  await seek(5)
  await page.keyboard.press('s')
  check((await page.locator('.clip-video').count()) === 2, 'split creates a cut on V1')

  // ---- transitions: drag "Cross dissolve" onto the cut
  await tab('Transitions')
  await page.waitForSelector('.fx-card')
  let total = 0
  for (const b of await page.locator('.gallery .seg button').all()) {
    await b.click()
    total += await page.locator('.fx-card').count()
  }
  check(total >= 49, `transitions gallery lists ${total} transitions across 4 categories`)
  await page.locator('.gallery .seg button', { hasText: 'Basic' }).click()
  const v1 = page.locator('.tl-row-video').last().locator('.tl-lane')
  const vB = await page.locator('.tl-row-video').last().locator('.clip-video').last().boundingBox()
  const lane = await v1.boundingBox()
  await page.locator('.fx-card', { hasText: 'Cross dissolve' }).dragTo(v1, { targetPosition: { x: vB.x - lane.x + 2, y: lane.height / 2 } })
  await page.waitForTimeout(300)
  check((await page.locator('.tr-badge').count()) === 1, 'dropping a transition on the cut adds a badge')
  check((await page.locator('.tr-badge canvas').count()) === 1, 'the badge shows the transition preview image')
  check((await page.locator('.inspector-title', { hasText: 'Cross dissolve' }).count()) === 1, 'new transition is selected in the Inspector')
  await seek(5)
  await shot(page, '1-transition-mid.png')

  // ---- filters: select first clip, click Vintage
  await page.locator('.tl-row-video').last().locator('.clip-video').first().click({ position: { x: 30, y: 20 } })
  await tab('Effects')
  await page.locator('.gallery .seg button', { hasText: 'Filters' }).click()
  await page.locator('.fx-card', { hasText: 'Vintage' }).first().click()
  check((await page.locator('.clip-badges span', { hasText: 'fx' }).count()) >= 1, 'filter applied (fx badge on the clip)')
  check((await page.locator('.section-toggle', { hasText: /^Filter$/ }).count()) === 1, 'Inspector shows the Filter section')
  // video effects stack
  await page.locator('.gallery .seg button', { hasText: 'Cinematic' }).click()
  await page.locator('.fx-card', { hasText: 'Lens Flare' }).click()
  await page.locator('.gallery .seg button', { hasText: 'Social' }).click()
  await page.locator('.fx-card', { hasText: 'RGB Split' }).click()
  check((await page.locator('.fx-item').count()) === 2, 'two video effects stacked in the Inspector')
  await page.locator('.fx-item').first().getByRole('checkbox').uncheck()
  check((await page.locator('.fx-item.off').count()) === 1, 'an effect can be switched off')
  await page.locator('.fx-item').first().getByRole('checkbox').check()

  // ---- text preset + sticker
  await seek(1)
  await tab('Text')
  await page.locator('.fx-card', { hasText: 'Lower third' }).click()
  check((await page.locator('.clip-text').count()) === 1, 'Lower third preset adds a text clip')
  await page.locator('.fx-card', { hasText: 'Text Pop' }).click()
  check((await page.locator('#sel-Effect').inputValue()) === 'pop', 'Text Pop applied to the selected text')
  await tab('Stickers')
  await page.locator('.fx-card', { hasText: 'Star' }).click()
  check((await page.locator('.clip-sticker').count()) === 1, 'Star sticker adds a sticker clip')
  const overlaps = await page.evaluate(() => {
    const bad = []
    document.querySelectorAll('.tl-lane').forEach((l) => {
      const b = [...l.querySelectorAll('.clip')].map((c) => c.getBoundingClientRect()).sort((x, y) => x.left - y.left)
      for (let i = 1; i < b.length; i++) if (b[i].left < b[i - 1].right - 1) bad.push(l.dataset.trackId)
    })
    return bad
  })
  check(overlaps.length === 0, 'text and sticker went onto free tracks (no overlaps)')
  await seek(2.2)
  await shot(page, '2-overlays.png')

  // ---- adjustment layer
  await tab('Effects')
  await page.locator('.gallery .seg button', { hasText: 'Adjustment' }).click()
  await page.locator('.fx-card', { hasText: 'B&W layer' }).click()
  check((await page.locator('.clip-adjustment').count()) === 1, 'adjustment layer added')
  await seek(2.5)
  await shot(page, '3-adjustment-bw.png')

  // ---- copy / paste / duplicate
  const before = await page.locator('.clip').count()
  await page.locator('.clip-sticker').click()
  await page.keyboard.press('Meta+c')
  await seek(6)
  await page.keyboard.press('Meta+v')
  check((await page.locator('.clip-sticker').count()) === 2, '⌘C / ⌘V pastes the sticker at the playhead')
  await page.keyboard.press('Meta+d')
  check((await page.locator('.clip-sticker').count()) === 3, '⌘D duplicates it')
  await page.keyboard.press('Meta+z')
  await page.keyboard.press('Meta+z')
  check((await page.locator('.clip').count()) === before, 'two ⌘Z undo duplicate + paste')
  const textBefore = await page.locator('.clip-text').count()
  await page.locator('.clip-text').click()
  await page.keyboard.press('Meta+x')
  check((await page.locator('.clip-text').count()) === textBefore - 1, '⌘X cuts the text clip')
  await page.keyboard.press('Meta+v')
  check((await page.locator('.clip-text').count()) === textBefore, '…and ⌘V pastes it back')

  // ---- delete the transition with the keyboard, undo brings it back
  await page.locator('.tr-badge').click()
  await page.keyboard.press('Delete')
  check((await page.locator('.tr-badge').count()) === 0, 'Delete removes the selected transition')
  await page.keyboard.press('Meta+z')
  check((await page.locator('.tr-badge').count()) === 1, '⌘Z restores it')
  await shot(page, '4-timeline.png')

  // ---- effects export (worker + main) through the same compositor, re-probed + decoded
  for (const runIn of ['worker', 'main']) {
    const r = await page.evaluate((runIn) => window.__nleBench.exportTimeline({}, { runIn, label: `effects ${runIn}` }), runIn)
    check(r.status === 'done' && r.verify?.ok, `effects export in ${runIn}: ${r.status}, verify ${r.verify?.ok ? 'ok' : r.verify?.problems?.join('; ') || r.error} · composite ${Math.round(r.timings.composite)} ms · total ${Math.round(r.derived.conversionMs)} ms`)
  }
  // benchmark edit used by `npm run bench -- --scenario export-effects-worker`
  await page.evaluate(() => {
    const id = window.__nleBench.assets()[0].id
    window.__nleBench.buildEffectsTimeline(id)
  })
  const rb = await page.evaluate(() => window.__nleBench.exportTimeline({}, { runIn: 'worker', label: 'effects bench edit' }))
  check(rb.status === 'done' && rb.verify?.ok, `benchmark effects edit exports and verifies (${Math.round(rb.derived.conversionMs)} ms)`)
  await seek(5)
  await shot(page, '5-bench-edit-dissolve.png')
} catch (err) {
  fails.push(String(err))
  await shot(page, 'error.png').catch(() => {})
} finally {
  await browser.close()
  preview.kill()
}
console.log(fails.length ? `\n${fails.length} problem(s):\n- ${fails.join('\n- ')}` : '\nEffects smoke test passed')
console.log(`screenshots: ${path.relative(root, out)}/`)
process.exit(fails.length ? 1 : 0)
