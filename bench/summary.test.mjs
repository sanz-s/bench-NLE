// node --test bench/summary.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { exitCode, median, medianRow, runPassed, summarizeScenario } from './summary.mjs'

const row = (ms, over = {}) => ({ scenario: 's', status: 'done', verified: true, conversionMs: ms, ...over })

test('median of odd/even counts, ignoring non-numbers', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([null, 5, NaN]), 5)
  assert.equal(median([]), null)
})

test('a run passes only when it finished AND its output verified', () => {
  assert.ok(runPassed(row(1)))
  assert.ok(!runPassed(row(1, { verified: false })))
  assert.ok(!runPassed(row(1, { verified: null })))
  assert.ok(!runPassed(row(1, { status: 'error' })))
})

test('medians exclude runs whose output failed verification', () => {
  // the unverified run is the fastest: it must not pull the median down
  const s = summarizeScenario([row(100), row(10, { verified: false, verifyProblems: 'audio track is missing' }), row(120), row(110)])
  assert.equal(s.median.conversionMs, 110)
  assert.equal(s.median.runs, 3)
  assert.equal(s.passed, 3)
  assert.equal(s.failed, 1)
  assert.equal(s.firstFailure, 'verify failed: audio track is missing')
})

test('no passing run → no median row', () => {
  const s = summarizeScenario([row(5, { status: 'error', error: 'boom' })])
  assert.equal(s.median, null)
  assert.equal(s.firstFailure, 'error: boom')
})

test('exit code is non-zero when any run failed or failed verification', () => {
  assert.equal(exitCode([row(1), row(2)]), 0)
  assert.equal(exitCode([row(1), row(2, { verified: false })]), 1)
  assert.equal(exitCode([row(1), row(2, { status: 'canceled' })]), 1)
  assert.equal(exitCode([row(1)], { skipped: 2 }), 0)
  assert.equal(exitCode([row(1)], { skipped: 2, failOnSkip: true }), 1)
})

test('medianRow picks the median run and keeps its non-numeric fields', () => {
  const m = medianRow([row(1, { runIn: 'worker' }), row(3, { runIn: 'worker' }), row(2, { runIn: 'worker' })])
  assert.equal(m.conversionMs, 2)
  assert.equal(m.runIn, 'worker')
})

test('the median row is one real run, not a mix of columns (audit §3.10)', () => {
  const s = summarizeScenario([row(100, { run: 1, cpu: 50 }), row(300, { run: 2, cpu: 10 }), row(200, { run: 3, cpu: 90 })])
  // column-wise this would be conversionMs 200 with cpu 50 (from run 1): a row that never happened
  assert.equal(s.median.conversionMs, 200)
  assert.equal(s.median.cpu, 90)
  assert.equal(s.median.medianOfRun, 3)
  // even count: lower middle
  assert.equal(summarizeScenario([row(10, { run: 1 }), row(20, { run: 2 })]).median.medianOfRun, 1)
})

test('hidden-tab and overlapping runs are left out of medians (audit §3.4, §3.7)', () => {
  const s = summarizeScenario([row(100), row(5, { tabHiddenMs: 1200 }), row(6, { overlappingJobs: 1 }), row(120)])
  assert.equal(s.passed, 2)
  assert.equal(s.failed, 2)
  assert.match(s.firstFailure, /tab hidden/)
  assert.ok(!runPassed(row(1, { overlappingJobs: 2 })))
  assert.ok(runPassed(row(1, { tabHiddenMs: 0, overlappingJobs: null })))
})

// ------------------------------------------------------------------ Markdown report (bench/report-md.mjs)
import { cell, markdownReport, mdTable } from './report-md.mjs'

test('report cells: empty → —, booleans → yes/no, pipes escaped', () => {
  assert.equal(cell(null), '—')
  assert.equal(cell(NaN), '—')
  assert.equal(cell(true), 'yes')
  assert.equal(cell('a|b'), 'a\\|b')
  assert.equal(cell(0), '0')
})

test('report tables are padded so every line has the same width', () => {
  const t = mdTable([{ key: 'a', title: 'Name' }, { key: 'n', title: 'ms', num: true }], [{ a: 'short', n: 5 }, { a: 'a much longer name', n: 12345 }])
  const lines = t.split('\n')
  assert.equal(new Set(lines.map((l) => l.length)).size, 1)
  assert.match(lines[1], /-:\s\|$/) // numbers right-aligned
  assert.match(lines[2], /\|\s+5 \|$/)
})

test('report: medians, skipped and failed scenarios each get their section', () => {
  const ok = { scenario: 's1', run: 1, status: 'done', verified: true, conversionMs: 100, encodeWaitMs: null }
  const bad = { scenario: 's2', run: 1, status: 'error', verified: null, error: 'boom' }
  const md = markdownReport({
    title: 'T',
    env: { OS: 'x' },
    mode: 'scenarios',
    rows: [ok, { ...ok, run: 'median' }, bad],
    summary: [
      { scenario: 's1', passedRuns: '1/1', median: { ...ok, run: 'median' } },
      { scenario: 's2', failedAll: true, passedRuns: '0/1', error: 'error: boom' },
      { scenario: 's3', skipped: true, reason: 'av1 not encodable' },
    ],
    checks: [{ level: 'warn', what: 'power', detail: 'on battery' }],
  })
  assert.match(md, /\*\*Result: FAILED \(1 of 2 runs failed\)\*\*/)
  assert.match(md, /## Speed[\s\S]*\| s1 [\s\S]*pipelined/)
  assert.match(md, /## Scenarios with no passing run[\s\S]*error: boom/)
  assert.match(md, /## Skipped[\s\S]*av1 not encodable/)
  assert.match(md, /## Machine checks[\s\S]*warning[\s\S]*on battery/)
  assert.doesNotMatch(md.split('## Every run')[1].split('##')[0], /median/) // per-run table leaves out median rows
})

test('report with several browsers: comparison table, one section per engine, missing browser listed', () => {
  const run = (browser, ms) => ({ browser, scenario: 'exp', run: 1, status: 'done', verified: true, conversionMs: ms })
  const md = markdownReport({
    title: 'T',
    env: {},
    mode: 'scenarios',
    browsers: [
      { key: 'chrome', name: 'Google Chrome', engine: 'Blink', status: 'ran', version: '1' },
      { key: 'firefox', name: 'Firefox (Playwright build)', engine: 'Gecko', status: 'ran', version: '2' },
      { key: 'webkit', name: 'WebKit (Playwright build, not Safari)', engine: 'WebKit', status: 'skipped', note: 'not installed: run `npx playwright install --with-deps`' },
    ],
    rows: [run('chrome', 100), run('firefox', 300)],
    summary: [
      { browser: 'chrome', scenario: 'exp', passedRuns: '1/1', median: run('chrome', 100) },
      { browser: 'firefox', scenario: 'exp', passedRuns: '1/1', median: run('firefox', 300) },
      { browser: 'firefox', scenario: 'hevc', skipped: true, reason: 'hevc not encodable in this browser' },
    ],
  })
  assert.match(md, /\*\*Result: PASSED[^\n]*1 browser\(s\) not installed/)
  assert.match(md, /## Engines side by side[\s\S]*\| exp +\| +100 \| +300 \|/)
  assert.match(md, /## Google Chrome · Blink engine[\s\S]*### Speed/)
  assert.match(md, /## Firefox \(Playwright build\) · Gecko engine[\s\S]*### Skipped[\s\S]*hevc not encodable/)
  assert.match(md, /npx playwright install --with-deps/)
})

test('requestedBrowsers: all = one browser per engine; --chromium still works; unknown names fail', async () => {
  const { requestedBrowsers } = await import('./browsers.mjs')
  assert.deepEqual(requestedBrowsers([]), ['chrome', 'firefox', 'webkit'])
  assert.deepEqual(requestedBrowsers(['--browsers', 'webkit,Chrome']), ['webkit', 'chrome'])
  assert.deepEqual(requestedBrowsers(['--chromium']), ['chromium'])
  assert.throws(() => requestedBrowsers(['--browsers', 'safari']), /unknown browser safari/)
})

test('WebKit (Safari) is skipped on Linux and Windows, whatever is installed', async () => {
  const { browserAvailability } = await import('./browsers.mjs')
  const fakePw = { webkit: { executablePath: () => process.execPath } } // a path that exists
  for (const os of ['linux', 'win32']) {
    const a = browserAvailability('webkit', fakePw, os)
    assert.equal(a.ok, false)
    assert.equal(a.platformSkip, true)
    assert.match(a.fix, /only on macOS/)
  }
  assert.equal(browserAvailability('webkit', fakePw, 'darwin').ok, true)
})

test('report: an output only the software decoder could read is marked "yes (software decode)"', () => {
  const sw = { scenario: 's1', run: 1, status: 'done', verified: true, conversionMs: 100, verifyDecoder: 'software (the default decoder failed: Decoding error.)' }
  const md = markdownReport({ title: 'T', env: {}, mode: 'scenarios', rows: [sw], summary: [{ scenario: 's1', passedRuns: '1/1', median: sw }], checks: [] })
  assert.match(md.split('## Every run')[1], /yes \(software decode\)/)
  assert.match(md, /PASSED/)
})

test('report: a browser that failed partway still gets its section and comparison column (Windows Firefox, 2026-11-24)', () => {
  const run = (browser, scenario, ms) => ({ browser, scenario, run: 1, status: 'done', verified: true, conversionMs: ms })
  const lostRow = { browser: 'firefox', scenario: 'exp', run: 1, status: 'error', verified: null, error: 'page lost during this scenario: the tab crashed' }
  const md = markdownReport({
    title: 'T',
    env: {},
    mode: 'scenarios',
    browsers: [
      { key: 'chrome', name: 'Google Chrome', engine: 'Blink', status: 'ran', version: '1' },
      { key: 'firefox', name: 'Firefox (Playwright build)', engine: 'Gecko', status: 'failed', version: '2', note: 'the page was lost 3 times' },
    ],
    rows: [run('chrome', 'conv', 100), run('chrome', 'exp', 200), run('firefox', 'conv', 300), lostRow],
    summary: [
      { browser: 'chrome', scenario: 'conv', passedRuns: '1/1', median: run('chrome', 'conv', 100) },
      { browser: 'chrome', scenario: 'exp', passedRuns: '1/1', median: run('chrome', 'exp', 200) },
      { browser: 'chrome', scenario: 'late', passedRuns: '1/1', median: run('chrome', 'late', 50) },
      { browser: 'firefox', scenario: 'conv', passedRuns: '1/1', median: run('firefox', 'conv', 300) },
      { browser: 'firefox', scenario: 'exp', failedAll: true, passedRuns: '0/1', error: lostRow.error },
    ],
  })
  assert.match(md, /\*\*Result: FAILED[^\n]*could not run[^\n]*· 2 browser\(s\)/)
  assert.match(md, /## Engines side by side[\s\S]*\| conv +\| +100 \| +300 \|[\s\S]*\| late +\| +50 \| +not run \|/)
  assert.match(md, /## Firefox \(Playwright build\) · Gecko engine \(stopped early: the page was lost 3 times\)[\s\S]*### Speed[\s\S]*### Scenarios with no passing run[\s\S]*the tab crashed/)
})
