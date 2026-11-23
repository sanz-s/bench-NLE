/**
 * Pure summary statistics for bench-server (no I/O, so `npm run test:bench-server` can test them).
 */

/**
 * avg / p95 / max of the finite numbers in `values`.
 * With `weights` (same length; each sample's interval in ms), `avg` is time-weighted: a forced sample that covers
 * 40 ms counts 40/500 as much as a regular 500 ms one. p95 and max stay per-sample.
 */
export function stat(values, weights) {
  let sum = 0
  let wsum = 0
  const v = []
  for (let i = 0; i < values.length; i++) {
    const x = values[i]
    if (typeof x !== 'number' || !Number.isFinite(x)) continue
    v.push(x)
    const w = weights ? weights[i] : 1
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
      sum += x * w
      wsum += w
    }
  }
  if (!v.length) return null
  const sorted = v.sort((a, b) => a - b)
  return {
    avg: wsum > 0 ? sum / wsum : sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted[sorted.length - 1],
  }
}

/**
 * The overlap section of a session summary: the other jobs that were sampled at the same time.
 * System-wide numbers (CPU, GPU, power) include them; browser numbers do too when they ran in the same browser.
 * @param {{rootPid: number|null, overlaps: Map<string, {label: string, rootPid: number|null, from: number, to: number|null}>}} sess
 */
export function overlapSummary(sess, now = Date.now(), ignore = () => false) {
  if (!sess.overlaps?.size) return null
  const live = [...sess.overlaps.entries()].filter(([id]) => !ignore(id))
  if (!live.length) return null
  const sessions = live.map(([id, o]) => ({
    id,
    label: o.label,
    sameBrowser: o.rootPid === sess.rootPid,
    overlapMs: Math.max(0, (o.to ?? now) - o.from),
  }))
  const sameBrowser = sessions.some((s) => s.sameBrowser)
  return {
    sessions,
    note: `Another job ran at the same time: system CPU, GPU and power include it${sameBrowser ? ', and so do the browser-process numbers (same browser)' : '; browser-process numbers are per session (different browser)'}.`,
  }
}

/**
 * Phantom sessions: created, but the page never used them (no request after the start). That happens when the page
 * gave up waiting for the start answer (slow server) and ran its job without a session; the server still made one.
 * A real job claims its session within milliseconds (job-start mark), so `graceMs` of silence is plenty.
 */
export function isPhantomSession(s, now, graceMs) {
  return !!s && !s.claimed && !s.end && now - s.start > graceMs
}
export function phantomSessions(sessions, now, graceMs) {
  const out = []
  for (const [id, s] of sessions) if (isPhantomSession(s, now, graceMs)) out.push(id)
  return out
}

/** Sessions with no request for `timeoutMs` (tab closed, reloaded or crashed mid-job). */
export function expiredSessions(sessions, now, timeoutMs) {
  const out = []
  for (const [id, s] of sessions) if (!s.end && now - (s.lastSeen ?? s.start) > timeoutMs) out.push(id)
  return out
}
