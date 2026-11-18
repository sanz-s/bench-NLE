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

test('medianRow is column-wise and keeps non-numeric fields from the first row', () => {
  const m = medianRow([row(1, { runIn: 'worker' }), row(3, { runIn: 'worker' }), row(2, { runIn: 'worker' })])
  assert.equal(m.conversionMs, 2)
  assert.equal(m.runIn, 'worker')
})
