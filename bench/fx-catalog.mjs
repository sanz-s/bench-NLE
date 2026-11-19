#!/usr/bin/env node
/**
 * Renders EVERY video effect, transition and text effect through the real export pipeline
 * (export worker → Mediabunny → re-probe + decode), and records each one's composite cost.
 *   npm run build && node bench/fx-catalog.mjs [--headless] [--only effects|transitions|text]
 * Output: bench-results/fx-catalog-<ts>.csv + gallery screenshots in bench-results/fx-catalog/
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'bench-results', 'fx-catalog')
mkdirSync(out, { recursive: true })
const headless = process.argv.includes('--headless')
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
const port = 4186
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

const browser = await chromium.launch({ channel: 'chrome', headless })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`${url}/?fresh=1`)
await page.waitForFunction(() => window.__nleBench?.ready)
await page.evaluate(() => window.__nleBench.setAutomated(true))
const assetId = await page.evaluate(() => window.__nleBench.generateFixture({ width: 1280, height: 720, fps: 30, duration: 2 }))
await page.evaluate(() => window.__nleBench.reset(1280, 720, 30))
const cat = await page.evaluate(() => window.__nleBench.catalog())

// baseline: plain cut, no effects
const rows = []
const run = async (kind, id, spec) => {
  await page.evaluate(([a, s]) => window.__nleBench.buildFxTimeline(a, s), [assetId, spec])
  const r = await page.evaluate((label) => window.__nleBench.exportTimeline({}, { runIn: 'worker', label }), `${kind}:${id}`)
  const ok = r.status === 'done' && r.verify?.ok
  rows.push({ kind, id, ok, composite_ms: Math.round(r.timings.composite ?? 0), total_ms: Math.round(r.derived.conversionMs), fps: r.derived.pipelineFps ? +r.derived.pipelineFps.toFixed(1) : null, problem: r.error ?? r.verify?.problems?.join('; ') ?? '' })
  process.stdout.write(`${ok ? '✓' : '✗'} ${kind.padEnd(10)} ${id.padEnd(20)} composite ${String(Math.round(r.timings.composite ?? 0)).padStart(5)} ms  total ${Math.round(r.derived.conversionMs)} ms${ok ? '' : `  ${rows.at(-1).problem}`}\n`)
}
await run('baseline', 'none', {})
if (!only || only === 'effects') for (const e of cat.effects) await run('effect', e, { effect: e })
if (!only || only === 'transitions') for (const t of cat.transitions) await run('transition', t, { transition: t })
if (!only || only === 'text') for (const t of cat.textFx) await run('text', t, { textFx: t })

// gallery screenshots (thumbnails are rendered by the same compositor on the main thread)
await page.evaluate(() => window.__nleBench.reset(1920, 1080, 30))
const tab = (n) => page.locator('.left-tabs button', { hasText: n }).click()
const segs = async (name) => {
  for (const b of await page.locator('.gallery .seg button').all()) {
    const label = (await b.innerText()).replace(/\W+/g, '-').toLowerCase()
    await b.click()
    await page.waitForTimeout(400)
    await page.locator('.panel.left').screenshot({ path: path.join(out, `${name}-${label}.png`) })
  }
}
await tab('Effects')
await segs('effects')
await tab('Transitions')
await segs('transitions')
await tab('Text')
await page.locator('.gallery').evaluate((el) => (el.scrollTop = el.scrollHeight))
await page.waitForTimeout(400)
await page.locator('.panel.left').screenshot({ path: path.join(out, 'text-effects.png') })

await browser.close()
preview.kill()
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const cols = Object.keys(rows[0])
writeFileSync(path.join(root, 'bench-results', `fx-catalog-${stamp}.csv`), [cols.join(','), ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n'))
const bad = rows.filter((r) => !r.ok)
console.log(`\n${rows.length - bad.length}/${rows.length} rendered + verified · page errors: ${errors.length}${errors.length ? `\n  ${[...new Set(errors)].slice(0, 5).join('\n  ')}` : ''}`)
console.log(`csv: bench-results/fx-catalog-${stamp}.csv · screenshots: bench-results/fx-catalog/`)
process.exit(bad.length || errors.length ? 1 : 0)
