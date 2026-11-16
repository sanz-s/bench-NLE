#!/usr/bin/env node
/**
 * Editor smoke test through the real UI (clicks + keyboard), with screenshots.
 *   npm run build && node bench/ui-smoke.mjs [--headless]
 * Flow: generate test clip → append → split → add title → undo/redo → trim by drag → export via dialog → report appears.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'bench-results', 'ui-smoke')
mkdirSync(out, { recursive: true })
const headless = process.argv.includes('--headless')
const port = 4182
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

const browser = await chromium.launch({ channel: 'chrome', headless })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => fails.push(`page error: ${e.message}`))
try {
  await page.goto(`${url}/?fresh=1`)
  await page.waitForSelector('.empty-drop')
  await page.evaluate(() => window.__nleBench.setAutomated(true))
  await page.screenshot({ path: path.join(out, '1-empty.png') })

  await page.getByRole('button', { name: 'Or generate a test clip' }).click()
  await page.waitForSelector('.bin-item', { timeout: 60000 })
  check((await page.locator('.bin-item').count()) === 1, 'test clip imported into the media bin')

  await page.locator('.bin-item').first().dblclick()
  await page.waitForSelector('.clip')
  check((await page.locator('.clip').count()) === 2, 'double-click appends linked video + audio clips')

  // seek to 5s by typing into the timecode field, then split
  await page.locator('input.timecode').click()
  await page.keyboard.type('5')
  await page.keyboard.press('Enter')
  await page.locator('.tl-scroll').click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press('Escape')
  await page.keyboard.press('s')
  check((await page.locator('.clip').count()) === 4, 'S splits both linked clips at the playhead')

  await page.keyboard.press('t')
  check((await page.locator('.clip-text').count()) === 1, 'T adds a title clip')
  await page.keyboard.press('Meta+z')
  check((await page.locator('.clip-text').count()) === 0, '⌘Z undoes the title')
  await page.keyboard.press('Meta+Shift+z')
  check((await page.locator('.clip-text').count()) === 1, '⇧⌘Z redoes it')

  // playback: Space plays from the playhead (AudioContext clock), Space again pauses
  await page.locator('input.timecode').click()
  await page.keyboard.type('1')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await page.waitForTimeout(1200)
  await page.keyboard.press('Space')
  const tc = await page.locator('input.timecode').inputValue()
  const [, , ss, ff] = tc.split(':').map(Number)
  const played = ss + ff / 30
  check(played > 1.6 && played < 3.5, `playback advances the playhead (1.00s → ${played.toFixed(2)}s)`)

  // trim the end of the last video clip by dragging its right handle 60px left
  const vClip = page.locator('.tl-row-video .clip-video').last()
  const before = await vClip.boundingBox()
  const handle = vClip.locator('.trim-r')
  const hb = await handle.boundingBox()
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x - 60, hb.y + hb.height / 2, { steps: 8 })
  await page.screenshot({ path: path.join(out, '2-trimming.png') })
  await page.mouse.up()
  const after = await vClip.boundingBox()
  check(after.width < before.width - 40, `drag trims the clip (${Math.round(before.width)} → ${Math.round(after.width)} px)`)

  // no-overwrite rule: dropping media onto an occupied spot creates/uses another track instead
  const vTracksBefore = await page.locator('.tl-row-video').count()
  const clipsBefore = await page.locator('.clip').count()
  const v1Lane = page.locator('.tl-row-video .tl-lane').last()
  const lb = await v1Lane.boundingBox()
  await page.locator('.bin-item').first().dragTo(v1Lane, { targetPosition: { x: 20, y: lb.height / 2 } })
  await page.waitForTimeout(300)
  const vTracksAfter = await page.locator('.tl-row-video').count()
  const v1Videos = await page.locator('.tl-row-video').last().locator('.clip-video').count()
  check(await page.locator('.clip').count() === clipsBefore + 2, 'dropping on an occupied track adds the new clips')
  check(vTracksAfter === vTracksBefore + 1 && v1Videos === 2, `overlapping drop goes to a new video track (${vTracksBefore} → ${vTracksAfter} tracks), V1 untouched`)
  const a2Clips = await page.locator('.tl-row-audio').nth(1).locator('.clip-audio').count()
  check(a2Clips === 1, 'its audio goes to the free A2 track instead of overwriting A1')

  // moving a clip onto another clip on the same track relocates it instead of overwriting
  const right = page.locator('.tl-row-video').last().locator('.clip-video').last()
  const rb = await right.boundingBox()
  const audioTracksBefore = await page.locator('.tl-row-audio').count()
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
  await page.mouse.down()
  await page.mouse.move(rb.x + rb.width / 2 - (rb.x - lb.x) - 1, rb.y + rb.height / 2, { steps: 10 })
  const tipText = await page.locator('.drag-tip').innerText().catch(() => '')
  await page.mouse.up()
  await page.waitForTimeout(200)
  check(/new track/.test(tipText), `drag tooltip warns before the jump ("${tipText}")`)
  check((await page.locator('.tl-row-video').last().locator('.clip-video').count()) === 1, 'moved clip left V1 instead of overwriting the clip there')
  check((await page.locator('.tl-row-audio').count()) === audioTracksBefore + 1, 'its linked audio found no free audio track, so a new one was created')

  // moving a clip DOWN onto an occupied track (cross-track drag re-mounts the element) must still relocate
  const topClip = page.locator('.tl-row-video').first().locator('.clip').first()
  const tb = await topClip.boundingBox()
  const v1 = await page.locator('.tl-row-video').last().boundingBox()
  await page.mouse.move(tb.x + 10, tb.y + tb.height / 2)
  await page.mouse.down()
  await page.mouse.move(tb.x + 14, v1.y + v1.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const overlaps = await page.evaluate(() => {
    const bad = []
    document.querySelectorAll('.tl-lane').forEach((lane) => {
      const boxes = [...lane.querySelectorAll('.clip')].map((c) => c.getBoundingClientRect()).sort((a, b) => a.left - b.left)
      for (let i = 1; i < boxes.length; i++) if (boxes[i].left < boxes[i - 1].right - 1) bad.push(lane.dataset.trackId)
    })
    return bad
  })
  check(overlaps.length === 0, `cross-track drag onto occupied V1 leaves no overlapping clips${overlaps.length ? ` (overlap on ${overlaps})` : ''}`)

  // box (marquee) selection: drag on empty timeline space selects every clip the box touches
  await page.keyboard.press('Escape')
  const laneBox = await page.locator('.tl-row-video').first().locator('.tl-lane').boundingBox()
  const lastRow = await page.locator('.tl-row-audio').last().boundingBox()
  const scrollBox = await page.locator('.tl-scroll').boundingBox()
  const clipsTotal = await page.locator('.clip').count()
  await page.mouse.move(Math.min(laneBox.x + laneBox.width, scrollBox.x + scrollBox.width) - 40, laneBox.y + 3)
  await page.mouse.down()
  await page.mouse.move(laneBox.x + 2, lastRow.y + lastRow.height - 3, { steps: 10 })
  const marqueeShown = await page.locator('.marquee').count()
  await page.mouse.up()
  const selectedCount = await page.locator('.clip.selected').count()
  check(marqueeShown === 1 && selectedCount === clipsTotal, `dragging a box on empty timeline space selects clips (${selectedCount}/${clipsTotal})`)
  await page.keyboard.press('Escape')

  // on-canvas transform in the viewer: click selects, drag moves, corner scales, one undo step each
  await page.locator('input.timecode').click()
  await page.keyboard.type('0.5')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  const frame = await page.locator('.viewer-frame').boundingBox()
  await page.mouse.click(frame.x + frame.width * 0.2, frame.y + frame.height * 0.5)
  await page.waitForSelector('.xform-box')
  check(true, 'clicking the clip in the preview selects it (transform box shown)')
  const xBefore = Number(await page.getByLabel('X', { exact: true }).inputValue())
  await page.mouse.move(frame.x + frame.width * 0.2, frame.y + frame.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(frame.x + frame.width * 0.2 + 80, frame.y + frame.height * 0.5 + 40, { steps: 8 })
  await page.screenshot({ path: path.join(out, '2b-viewer-move.png') })
  await page.mouse.up()
  const xAfter = Number(await page.getByLabel('X', { exact: true }).inputValue())
  check(xAfter - xBefore > 100, `dragging in the preview moves the clip (X ${xBefore} → ${xAfter})`)
  const h = await page.locator('.xform-handle.h-nw').boundingBox()
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await page.mouse.down()
  await page.mouse.move(h.x + 120, h.y + 70, { steps: 8 })
  await page.mouse.up()
  const scale = Number(await page.getByLabel('Scale', { exact: true }).inputValue())
  check(scale < 95 && scale > 10, `dragging a corner scales the clip (100% → ${scale}%)`)
  await page.keyboard.press('Meta+z')
  await page.keyboard.press('Meta+z')
  const xUndo = Number(await page.getByLabel('X', { exact: true }).inputValue())
  const sUndo = Number(await page.getByLabel('Scale', { exact: true }).inputValue())
  check(xUndo === xBefore && sUndo === 100, 'two ⌘Z undo the scale and the move')

  // inspector edit via scrub label
  await vClip.click()
  await page.waitForSelector('.inspector .num-field')
  await page.screenshot({ path: path.join(out, '3-editor.png') })

  // export through the dialog (worker, buffer target → download suppressed in automation)
  await page.keyboard.press('Meta+e')
  await page.waitForSelector('.modal .container-opt')
  await page.screenshot({ path: path.join(out, '4-export-dialog.png') })
  const disabled = await page.locator('.container-opt:disabled').count()
  check(disabled >= 1, `export dialog greys out unavailable containers (${disabled})`)
  await page.locator('.modal-foot .btn-primary').click()
  await page.getByRole('tab', { name: /Bench/ }).click()
  await page.waitForSelector('.report.done', { timeout: 120000 })
  await page.locator('.report-head').first().click()
  await page.screenshot({ path: path.join(out, '5-bench.png') })
  const verified = await page.locator('.report .badge-ok').count()
  check(verified >= 1, 'export finished and the output re-probed OK')

  // reload → autosave restores the project
  await page.waitForTimeout(1200)
  await page.goto(url)
  await page.waitForSelector('.clip', { timeout: 20000 })
  check((await page.locator('.clip').count()) >= 7, 'reload restores the autosaved project (IndexedDB)')
} catch (err) {
  fails.push(String(err))
  await page.screenshot({ path: path.join(out, 'error.png') }).catch(() => {})
} finally {
  await browser.close()
  preview.kill()
}
console.log(fails.length ? `\n${fails.length} problem(s):\n- ${fails.join('\n- ')}` : '\nUI smoke test passed')
console.log(`screenshots: ${path.relative(root, out)}/`)
process.exit(fails.length ? 1 : 0)
