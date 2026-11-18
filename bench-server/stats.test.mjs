import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expiredSessions, overlapSummary, stat } from './stats.mjs'

test('stat: unweighted when no weights are given', () => {
  assert.deepEqual(stat([10, 20, 30]), { avg: 20, p95: 30, max: 30 })
  assert.equal(stat([null, undefined, NaN]), null)
})

test('stat: avg is weighted by each sample interval (audit §3.2)', () => {
  // a 2 s job at 100 % with a 40 ms forced idle sample at the end: unweighted the idle sample counts like 500 ms
  const values = [100, 100, 100, 100, 0]
  const weights = [500, 500, 500, 500, 40]
  assert.equal(stat(values).avg, 80)
  assert.ok(Math.abs(stat(values, weights).avg - 98.04) < 0.01)
  // p95 / max are per sample
  assert.equal(stat(values, weights).max, 100)
})

test('stat: non-numeric values drop out together with their weights', () => {
  const r = stat([50, null, 100], [1000, 1000, 1000])
  assert.equal(r.avg, 75)
})

test('stat: falls back to the plain mean when no weight is usable', () => {
  assert.equal(stat([10, 30], [undefined, null]).avg, 20)
})

test('overlapSummary: flags other jobs and whether they shared the browser', () => {
  const sess = {
    rootPid: 100,
    overlaps: new Map([
      ['a', { label: 'job A', rootPid: 100, from: 1000, to: 3000 }],
      ['b', { label: 'job B', rootPid: 200, from: 2000, to: null }],
    ]),
  }
  const o = overlapSummary(sess, 5000)
  assert.deepEqual(
    o.sessions.map((x) => [x.id, x.sameBrowser, x.overlapMs]),
    [
      ['a', true, 2000],
      ['b', false, 3000],
    ],
  )
  assert.match(o.note, /same browser/)
  assert.equal(overlapSummary({ rootPid: 1, overlaps: new Map() }), null)
})

test('expiredSessions: only running sessions silent for longer than the timeout', () => {
  const now = 100_000
  const sessions = new Map([
    ['quiet', { start: 0, lastSeen: 10_000 }],
    ['talking', { start: 0, lastSeen: 99_000 }],
    ['stopped', { start: 0, lastSeen: 0, end: 5_000 }],
    ['no-lastSeen', { start: 1_000 }],
  ])
  assert.deepEqual(expiredSessions(sessions, now, 60_000), ['quiet', 'no-lastSeen'])
})
