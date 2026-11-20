/**
 * Markdown report for bench/run.mjs (pure functions, unit-tested in bench/summary.test.mjs).
 * The runner writes this file instead of printing console tables, which wrap and misalign in narrow terminals.
 * Tables are padded so the columns also line up when the .md is read as plain text.
 */
import { failureReason } from './summary.mjs'

const DASH = '—'

/** A cell value as text: null/undefined → —, booleans → yes/no, numbers with thousands kept plain. */
export function cell(v) {
  if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return DASH
  if (v === true) return 'yes'
  if (v === false) return 'no'
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * A padded GitHub-flavoured Markdown table.
 * @param {{ key: string, title: string, num?: boolean, fmt?: (v: any, row: object) => any }[]} cols
 * @param {object[]} rows
 */
export function mdTable(cols, rows) {
  const text = rows.map((r) => cols.map((c) => cell(c.fmt ? c.fmt(r[c.key], r) : r[c.key])))
  const width = cols.map((c, i) => Math.max(3, c.title.length, ...text.map((t) => t[i].length)))
  const pad = (s, i) => (cols[i].num ? s.padStart(width[i]) : s.padEnd(width[i]))
  const line = (cells) => `| ${cells.map(pad).join(' | ')} |`
  const rule = `| ${width.map((w, i) => (cols[i].num ? `${'-'.repeat(w - 1)}:` : '-'.repeat(w))).join(' | ')} |`
  return [line(cols.map((c) => c.title)), rule, ...text.map(line)].join('\n')
}

const mb = (bytes) => (typeof bytes === 'number' ? +(bytes / 1048576).toFixed(2) : null)
const ms = (v) => (typeof v === 'number' ? Math.round(v) : v)

const SPEED_COLS = [
  { key: 'scenario', title: 'Scenario' },
  { key: 'passedRuns', title: 'Passed' },
  { key: 'runIn', title: 'Run in' },
  { key: 'audioEncoderImpl', title: 'Audio encoder' },
  { key: 'conversionMs', title: 'Total ms', num: true },
  { key: 'encodeWaitMs', title: 'Encode wait ms', num: true, fmt: (v) => v ?? 'pipelined' },
  { key: 'realtimeX', title: '× realtime', num: true },
  { key: 'pipelineFps', title: 'fps', num: true },
  { key: 'outBytes', title: 'Size MB', num: true, fmt: mb },
  { key: 'verified', title: 'Verified' },
]

const LOAD_COLS = [
  { key: 'scenario', title: 'Scenario' },
  { key: 'mtTbtMs', title: 'TBT ms', num: true },
  { key: 'mtLongestMs', title: 'Longest task ms', num: true },
  { key: 'cdp_mainTaskMs', title: 'Main-thread ms', num: true, fmt: ms },
  { key: 'mtRafGaps50', title: 'Frames > 50 ms', num: true },
  { key: 'sysCpuAvg', title: 'CPU %', num: true },
  { key: 'browserCpuAvg', title: 'Browser CPU %', num: true },
  { key: 'gpuAvg', title: 'GPU %', num: true },
  { key: 'cpuPowerAvgW', title: 'CPU W', num: true },
  { key: 'gpuPowerAvgW', title: 'GPU W', num: true },
  { key: 'browserRssMaxMB', title: 'Browser RSS MB', num: true },
]

const RUN_COLS = [
  { key: 'browser', title: 'Browser' },
  { key: 'scenario', title: 'Scenario' },
  { key: 'run', title: 'Run', num: true },
  { key: 'status', title: 'Status' },
  { key: 'verified', title: 'Verified' },
  { key: 'conversionMs', title: 'Total ms', num: true },
  { key: 'encodeWaitMs', title: 'Encode wait ms', num: true, fmt: (v) => v ?? 'pipelined' },
  { key: 'realtimeX', title: '× realtime', num: true },
  { key: 'mtRafGaps50', title: 'Frames > 50 ms', num: true },
  { key: 'browserCpuAvg', title: 'Browser CPU %', num: true },
  { key: 'gpuAvg', title: 'GPU %', num: true },
  { key: 'problem', title: 'Problem', fmt: (_, r) => failureReason(r) ?? '' },
]

const MATRIX_COLS = [
  { key: 'combo', title: 'Container / video / audio' },
  { key: 'status', title: 'Status' },
  { key: 'verified', title: 'Verified' },
  { key: 'ms', title: 'Total ms', num: true },
  { key: 'problem', title: 'Problem' },
]

const LEGEND = [
  ['Passed', 'runs that finished, passed output verification, ran in a visible tab and did not overlap another job / runs'],
  ['Total ms', 'whole job time (conversion time). The summary shows the median run, picked by this column'],
  ['Encode wait ms', 'time spent waiting on the encoder queue plus the final flush; "pipelined" for Mediabunny Conversion jobs, where it can’t be separated'],
  ['× realtime', 'media duration ÷ job time (2 = twice as fast as playback)'],
  ['fps', 'output frames ÷ job time'],
  ['Verified', 'the output was re-opened and decoded, and its tracks, codecs, size, fps and durations matched the request'],
  ['TBT ms', 'total blocking time on the page’s main thread (sum of long-task time over 50 ms)'],
  ['Longest task ms', 'longest single main-thread task during the job'],
  ['Main-thread ms', 'Chrome’s own main-thread task time for the job (CDP), the clearest worker vs main-thread comparison'],
  ['Frames > 50 ms', 'animation frames that took longer than 50 ms (visible UI jank)'],
  ['CPU %', 'whole-machine CPU, time-weighted average over the job (needs the bench-server)'],
  ['Browser CPU %', 'CPU of the benchmark browser’s processes (100 = one full core)'],
  ['GPU %', 'GPU device utilisation (whole machine)'],
  ['CPU W / GPU W', 'average power; only with --power (sudo)'],
  ['—', 'not measured. TBT and longest task need the Long Tasks API and Main-thread ms needs CDP: both Chromium only. Frames > 50 ms works in every engine, so use it to compare main-thread jank across engines'],
]

const ENGINE_NOTES = [
  'Firefox and WebKit are Playwright’s own builds: Playwright can’t drive stock Firefox or Safari. WebKit is close to Safari (same engine and media stack on macOS) but is not Safari, so read it as “the WebKit engine”, not as Safari’s exact numbers.',
  'Firefox has no native AAC encoder, so with `--aac auto` its AAC goes through the WASM encoder (see the Audio encoder column). The other engines use the browser’s own. Compare AAC jobs across engines with that in mind.',
  'Browser CPU % counts the browser’s process tree. Playwright’s WebKit on macOS runs its page, GPU and network work in services started by the system (`com.apple.WebKit.*.Development`); those are added in, and are shared if several Playwright WebKits run at once.',
  'Whether an encode used hardware or software is not reported by any browser; “Hardware” settings record what was requested.',
]

const setupTable = (env) => mdTable([{ key: 'k', title: 'Item' }, { key: 'v', title: 'Value' }], Object.entries(env).map(([k, v]) => ({ k, v })))

const BROWSER_COLS = [
  { key: 'name', title: 'Browser' },
  { key: 'engine', title: 'Engine' },
  { key: 'version', title: 'Version' },
  { key: 'status', title: 'Status' },
  { key: 'isolated', title: 'Cross-origin isolated' },
  { key: 'note', title: 'Note' },
]

/** One column per browser that ran: the median Total ms, or why there is none. */
function comparisonTable(browsers, summary) {
  const ran = browsers.filter((b) => b.status === 'ran')
  const scenarios = [...new Set(summary.map((s) => s.scenario))]
  const cols = [{ key: 'scenario', title: 'Scenario' }, ...ran.map((b) => ({ key: b.key, title: `${b.name.split(' (')[0]} ms`, num: true }))]
  const data = scenarios.map((sc) => {
    const row = { scenario: sc }
    for (const b of ran) {
      const e = summary.find((s) => s.browser === b.key && s.scenario === sc)
      row[b.key] = !e ? null : e.median ? e.median.conversionMs : e.skipped ? 'skipped' : 'FAILED'
    }
    return row
  })
  return mdTable(cols, data)
}

/**
 * @param {object} o
 * @param {string} o.title
 * @param {Record<string, any>} o.env           machine / run settings, rendered as a two-column table
 * @param {{ key: string, name: string, engine: string, status: string, version?: string, isolated?: boolean, note?: string }[]} [o.browsers]
 * @param {'scenarios' | 'matrix'} o.mode
 * @param {object[]} o.summary                  run.mjs summary entries (each with `browser`; scenario mode: medians, skips, failures)
 * @param {object[]} o.rows                     flattened per-run rows (incl. median rows, which are left out here)
 * @param {{ level: string, what: string, detail: string }[]} [o.checks]  bench-os machine checks
 * @param {string} [o.command]                 the runner command line
 * @param {string[]} [o.files]                  JSON/CSV files written next to this report
 */
export function markdownReport({ title, env, browsers = [], mode, summary, rows, checks = [], command = '', files = [] }) {
  const out = [`# ${title}`, '']
  const runRows = rows.filter((r) => r.run !== 'median')
  const failed = runRows.filter((r) => failureReason(r) !== null)
  const ran = browsers.filter((b) => b.status === 'ran')
  const brokenBrowsers = browsers.filter((b) => b.status === 'failed')
  const skippedBrowsers = browsers.filter((b) => b.status === 'skipped' && !b.platformSkip)
  const forBrowser = (b) => summary.filter((s) => (s.browser ?? null) === (b?.key ?? null))
  const groups = browsers.length ? ran : [null] // reports without browser info: one unnamed group
  const browserNote = [brokenBrowsers.length && `${brokenBrowsers.length} browser(s) failed to run`, skippedBrowsers.length && `${skippedBrowsers.length} browser(s) not installed`].filter(Boolean).join(' · ')

  if (mode === 'matrix') {
    const bad = summary.filter((s) => !(s.status === 'done' && s.verified === true))
    const verdict = bad.length || brokenBrowsers.length || (browsers.length && !ran.length) ? `FAILED (${bad.length} of ${summary.length} combinations)` : `PASSED (all ${summary.length} combinations)`
    out.push(`**Result: ${verdict}**${browserNote ? ` · ${browserNote}` : ''}`, '')
    out.push('## Setup', '', setupTable(env), '')
    if (browsers.length) out.push('## Browsers', '', mdTable(BROWSER_COLS, browsers), '')
    for (const b of groups) {
      out.push(b ? `## Combinations: ${b.name} · ${b.engine} engine` : '## Combinations', '', mdTable(MATRIX_COLS, forBrowser(b)), '')
    }
  } else {
    const medians = summary.filter((s) => s.median)
    const skipped = summary.filter((s) => s.skipped)
    const noPass = summary.filter((s) => s.failedAll)
    const verdict =
      failed.length || brokenBrowsers.length || (browsers.length && !ran.length)
        ? `FAILED (${[failed.length && `${failed.length} of ${runRows.length} runs failed`, brokenBrowsers.length && `${brokenBrowsers.map((b) => b.name).join(', ')} could not run`, browsers.length && !ran.length && 'no browser ran'].filter(Boolean).join('; ')})`
        : `PASSED (${runRows.length} of ${runRows.length} runs verified)`
    out.push(`**Result: ${verdict}** · ${ran.length || 1} browser(s) · ${new Set([...medians, ...noPass].map((s) => s.scenario)).size} scenario(s) run · ${skipped.length} skipped${skippedBrowsers.length ? ` · ${skippedBrowsers.length} browser(s) not installed` : ''}`, '')
    out.push('## Setup', '', setupTable(env), '')
    if (browsers.length) out.push('## Browsers', '', mdTable(BROWSER_COLS, browsers), '')
    if (ran.length > 1 && summary.length) out.push('## Engines side by side (median Total ms, lower is faster)', '', comparisonTable(browsers, summary), '')

    for (const b of groups) {
      const mine = forBrowser(b)
      const h = b ? `## ${b.name} · ${b.engine} engine` : null
      const sub = b ? '###' : '##'
      if (h) out.push(h, '')
      const med = mine.filter((s) => s.median).map((s) => ({ ...s.median, scenario: s.scenario, passedRuns: s.passedRuns }))
      if (med.length) {
        out.push(`${sub} Speed (median run per scenario)`, '', mdTable(SPEED_COLS, med), '')
        out.push(`${sub} Main thread and machine load (same median runs)`, '', mdTable(LOAD_COLS, med), '')
      }
      const np = mine.filter((s) => s.failedAll)
      if (np.length) out.push(`${sub} Scenarios with no passing run`, '', mdTable([{ key: 'scenario', title: 'Scenario' }, { key: 'passedRuns', title: 'Passed' }, { key: 'error', title: 'First failure' }], np), '')
      const sk = mine.filter((s) => s.skipped)
      if (sk.length) out.push(`${sub} Skipped (not supported in this browser)`, '', mdTable([{ key: 'scenario', title: 'Scenario' }, { key: 'reason', title: 'Reason' }], sk), '')
      if (b && !mine.length) out.push('No scenarios ran.', '')
    }
    if (runRows.length) out.push('## Every run', '', mdTable(browsers.length ? RUN_COLS : RUN_COLS.slice(1), runRows), '')
    out.push('## What the columns mean', '', mdTable([{ key: 0, title: 'Column' }, { key: 1, title: 'Meaning' }], LEGEND), '')
  }
  if (browsers.length) out.push('## Reading results across engines', '', ...ENGINE_NOTES.map((n) => `- ${n}`), '')

  if (checks.length) {
    const lv = { ok: 'ok', warn: 'warning', fail: 'FAIL' }
    out.push('## Machine checks', '', mdTable([{ key: 'what', title: 'Check' }, { key: 'level', title: 'Result', fmt: (v) => lv[v] ?? v }, { key: 'detail', title: 'Detail' }], checks), '')
  }
  if (command) out.push('## Command', '', '```', command, '```', '')
  if (files.length) out.push('## Raw data', '', ...files.map((f) => `- \`${f}\``), '')
  return out.join('\n')
}
