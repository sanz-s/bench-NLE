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
