/**
 * Pure result-summary logic for bench/run.mjs (unit-tested in bench/summary.test.mjs):
 *  - the median row is the real median run, chosen ONLY from runs that finished (status 'done'), passed output
 *    verification, ran in a visible tab and didn't overlap another job
 *  - a run "fails" when it errored, was canceled, failed verification, ran hidden or overlapped another job
 *  - the process exit code is non-zero when any run failed (skipped scenarios are listed, not failures)
 */
export const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/**
 * The median RUN: the real run whose conversion time is the median (lower middle for an even count), with all of
 * its own columns. A column-wise median would mix columns from different runs into a row that never happened.
 */
export function medianRow(rows, key = 'conversionMs') {
  const sorted = [...rows].sort((a, b) => (a[key] ?? Infinity) - (b[key] ?? Infinity))
  const pick = sorted[Math.floor((sorted.length - 1) / 2)]
  return { ...pick, runs: rows.length, medianOfRun: pick.run ?? null }
}

/**
 * Why a run can't be used for a median, or null if it can. Besides errors and failed verification, a run whose tab
 * was hidden (throttled timers / rAF) or that overlapped another job (shared CPU/GPU) isn't a clean measurement.
 */
export function failureReason(r) {
  if (r.status !== 'done') return `${r.status}${r.error ? `: ${r.error}` : ''}`
  if (r.verified !== true) return `verify failed${(r.verifyProblems ?? r.problems) ? `: ${r.verifyProblems ?? r.problems}` : ''}`
  if (r.tabHiddenMs > 0) return `tab hidden for ${Math.round(r.tabHiddenMs)} ms during the job`
  if (r.overlappingJobs > 0) return `overlapped ${r.overlappingJobs} other job(s)`
  return null
}

export const runPassed = (row) => failureReason(row) === null

/** One scenario's runs → { median run from passing runs only (or null), counts, first failure } */
export function summarizeScenario(rows) {
  const passed = rows.filter(runPassed)
  const failed = rows.filter((r) => !runPassed(r))
  return {
    median: passed.length ? { ...medianRow(passed), run: 'median' } : null,
    runs: rows.length,
    passed: passed.length,
    failed: failed.length,
    firstFailure: failed[0] ? failureReason(failed[0]) : null,
  }
}

/** Exit code for the whole run: 1 if any run failed. `skipped` is reported but doesn't fail the run. */
export function exitCode(rows, { failOnSkip = false, skipped = 0 } = {}) {
  if (rows.some((r) => !runPassed(r))) return 1
  if (failOnSkip && skipped > 0) return 1
  return 0
}
