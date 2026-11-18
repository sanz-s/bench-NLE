/**
 * Pure result-summary logic for bench/run.mjs (unit-tested in bench/summary.test.mjs):
 *  - medians are built ONLY from runs that finished (status 'done') AND passed output verification
 *  - a run "fails" when it errored, was canceled, or its output failed verification
 *  - the process exit code is non-zero when any run failed (skipped scenarios are listed, not failures)
 */
export const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** Column-wise median of the given rows (each numeric column independently). */
export function medianRow(rows) {
  const out = { ...rows[0] }
  for (const k of Object.keys(rows[0])) {
    if (typeof rows[0][k] === 'number') out[k] = median(rows.map((r) => r[k]))
  }
  out.runs = rows.length
  return out
}

export const runPassed = (row) => row.status === 'done' && row.verified === true

/** One scenario's runs → { median row from passing runs only (or null), counts, first failure } */
export function summarizeScenario(rows) {
  const passed = rows.filter(runPassed)
  const failed = rows.filter((r) => !runPassed(r))
  const why = (r) => (r.status !== 'done' ? `${r.status}${r.error ? `: ${r.error}` : ''}` : `verify failed${(r.verifyProblems ?? r.problems) ? `: ${r.verifyProblems ?? r.problems}` : ''}`)
  return {
    median: passed.length ? { ...medianRow(passed), run: 'median' } : null,
    runs: rows.length,
    passed: passed.length,
    failed: failed.length,
    firstFailure: failed[0] ? why(failed[0]) : null,
  }
}

/** Exit code for the whole run: 1 if any run failed. `skipped` is reported but doesn't fail the run. */
export function exitCode(rows, { failOnSkip = false, skipped = 0 } = {}) {
  if (rows.some((r) => !runPassed(r))) return 1
  if (failOnSkip && skipped > 0) return 1
  return 0
}
