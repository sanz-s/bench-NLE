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
  { key: 'scenario', title: 'Scenario' },
  { key: 'run', title: 'Run', num: true },
  { key: 'status', title: 'Status' },
  { key: 'verified', title: 'Verified' },
  { key: 'conversionMs', title: 'Total ms', num: true },
  { key: 'encodeWaitMs', title: 'Encode wait ms', num: true, fmt: (v) => v ?? 'pipelined' },
  { key: 'realtimeX', title: '× realtime', num: true },
  { key: 'mtTbtMs', title: 'TBT ms', num: true },
  { key: 'sysCpuAvg', title: 'CPU %', num: true },
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
]

/**
 * @param {object} o
 * @param {string} o.title
 * @param {Record<string, any>} o.env           machine / run settings, rendered as a two-column table
 * @param {'scenarios' | 'matrix'} o.mode
 * @param {object[]} o.summary                  run.mjs summary entries (scenario mode: medians, skips, failures)
 * @param {object[]} o.rows                     flattened per-run rows (incl. median rows, which are left out here)
 * @param {{ level: string, what: string, detail: string }[]} [o.checks]  bench-os machine checks
 * @param {string} [o.command]                 the runner command line
 * @param {string[]} [o.files]                  JSON/CSV files written next to this report
 */
export function markdownReport({ title, env, mode, summary, rows, checks = [], command = '', files = [] }) {
  const out = [`# ${title}`, '']
  const runRows = rows.filter((r) => r.run !== 'median')
  const failed = runRows.filter((r) => failureReason(r) !== null)

  if (mode === 'matrix') {
    const bad = summary.filter((s) => !(s.status === 'done' && s.verified === true))
    out.push(`**Result: ${bad.length ? `FAILED (${bad.length} of ${summary.length} combinations)` : `PASSED (all ${summary.length} combinations)`}**`, '')
    out.push('## Setup', '', mdTable([{ key: 'k', title: 'Item' }, { key: 'v', title: 'Value' }], Object.entries(env).map(([k, v]) => ({ k, v }))), '')
    out.push('## Combinations', '', mdTable(MATRIX_COLS, summary), '')
  } else {
    const medians = summary.filter((s) => s.median)
    const skipped = summary.filter((s) => s.skipped)
    const noPass = summary.filter((s) => s.failedAll)
    const verdict = failed.length ? `FAILED (${failed.length} of ${runRows.length} runs)` : `PASSED (${runRows.length} of ${runRows.length} runs verified)`
    out.push(`**Result: ${verdict}** · ${medians.length + noPass.length} scenario(s) run · ${skipped.length} skipped`, '')
    out.push('## Setup', '', mdTable([{ key: 'k', title: 'Item' }, { key: 'v', title: 'Value' }], Object.entries(env).map(([k, v]) => ({ k, v }))), '')

    const med = medians.map((s) => ({ ...s.median, scenario: s.scenario, passedRuns: s.passedRuns }))
    if (med.length) {
      out.push('## Speed (median run per scenario)', '', mdTable(SPEED_COLS, med), '')
      out.push('## Main thread and machine load (same median runs)', '', mdTable(LOAD_COLS, med), '')
    }
    if (noPass.length) {
      out.push('## Scenarios with no passing run', '', mdTable([{ key: 'scenario', title: 'Scenario' }, { key: 'passedRuns', title: 'Passed' }, { key: 'error', title: 'First failure' }], noPass), '')
    }
    if (skipped.length) {
      out.push('## Skipped (not supported on this machine)', '', mdTable([{ key: 'scenario', title: 'Scenario' }, { key: 'reason', title: 'Reason' }], skipped), '')
    }
    if (runRows.length) out.push('## Every run', '', mdTable(RUN_COLS, runRows), '')
    out.push('## What the columns mean', '', mdTable([{ key: 0, title: 'Column' }, { key: 1, title: 'Meaning' }], LEGEND), '')
  }

  if (checks.length) {
    const lv = { ok: 'ok', warn: 'warning', fail: 'FAIL' }
    out.push('## Machine checks', '', mdTable([{ key: 'what', title: 'Check' }, { key: 'level', title: 'Result', fmt: (v) => lv[v] ?? v }, { key: 'detail', title: 'Detail' }], checks), '')
  }
  if (command) out.push('## Command', '', '```', command, '```', '')
  if (files.length) out.push('## Raw data', '', ...files.map((f) => `- \`${f}\``), '')
  return out.join('\n')
}
