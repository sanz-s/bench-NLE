/**
 * Integration tests for bench-server session handling (audit §3.2–3.4, Copilot F9). Starts a real server on a spare
 * port with a short session timeout, and uses two child processes as stand-in "browsers" (a Playwright-style rootPid
 * is always kept, whatever the executable is called).
 *   node --test bench-server/sessions.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = 5299
const BASE = `http://127.0.0.1:${PORT}`
const TIMEOUT_MS = 2500
let server
let busy
let idle
let tmp

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function post(p, body = {}) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return r.json()
}

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'bench-server-test-'))
  server = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT), '--quiet', '--interval', '250'], {
    env: { ...process.env, BENCH_SESSION_TIMEOUT_MS: String(TIMEOUT_MS), BENCH_RESULTS_DIR: tmp },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  busy = spawn(process.execPath, ['-e', 'for(;;){}']) // ~100 % of one core
  idle = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'])
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + '/health')).ok) break
    } catch {
      /* not up yet */
    }
    await sleep(100)
  }
  await sleep(800) // a few samples so every pid has a CPU baseline
})

after(() => {
  server?.kill()
  busy?.kill()
  idle?.kill()
  rmSync(tmp, { recursive: true, force: true })
})

test('overlapping sessions are flagged on both sides and each keeps its own process filter', async () => {
  const a = await post('/sessions', { label: 'busy browser', rootPid: busy.pid })
  const b = await post('/sessions', { label: 'idle browser', rootPid: idle.pid })
  await sleep(1500)
  const sa = await post(`/sessions/${a.id}/stop`)
  const sb = await post(`/sessions/${b.id}/stop`)
  assert.equal(sa.overlap?.sessions?.[0]?.id, b.id)
  assert.equal(sb.overlap?.sessions?.[0]?.id, a.id)
  assert.equal(sa.overlap.sessions[0].sameBrowser, false)
  // old behaviour: both sessions measured the FIRST session's tree (both ≈ 100 %)
  assert.ok(sa.browserCpuPct.avg > 60, `busy tree avg ${sa.browserCpuPct.avg}`)
  assert.ok(sb.browserCpuPct.avg < 20, `idle tree avg ${sb.browserCpuPct.avg}`)
})

test('a finished job keeps its overlap when the other job runs on (Copilot R2)', async () => {
  const a = await post('/sessions', { label: 'short', rootPid: busy.pid })
  const b = await post('/sessions', { label: 'long', rootPid: idle.pid })
  await sleep(600)
  const sa = await post(`/sessions/${a.id}/stop`)
  const first = sa.overlap.sessions[0].overlapMs
  assert.ok(first <= sa.durationMs, `overlap ${first} ms > job ${sa.durationMs} ms`)
  await sleep(1200) // b keeps running
  await post(`/sessions/${b.id}/stop`)
  // a's summary must not change after b stops (old code: it grew to b's end)
  const again = await post(`/sessions/${a.id}/stop`)
  assert.equal(again.overlap.sessions[0].overlapMs, first)
  const sb = await post(`/sessions/${b.id}/stop`)
  assert.ok(Math.abs(sb.overlap.sessions[0].overlapMs - first) < 5, `b sees ${sb.overlap.sessions[0].overlapMs} ms, a sees ${first} ms`)
})

test('the job-end mark stops sampling; the pre-job sample is not part of the session', async () => {
  const t0 = Date.now()
  const { id } = await post('/sessions', { label: 'window', rootPid: busy.pid })
  await sleep(1000)
  const markAt = Date.now()
  await post(`/sessions/${id}/mark`, { name: 'job-end' })
  await sleep(1200) // the client verifies / reports here: not part of the job
  const s = await post(`/sessions/${id}/stop`)
  assert.equal(s.sampleWindow, 'session start → job-end mark')
  // every sample lies inside [start, job-end]; the sampled time ≈ the job, not job + 1.2 s tail
  assert.ok(s.raw.every((x) => x.t >= 0), 'no sample from before the session')
  assert.ok(s.sampledMs < markAt - t0 + 400, `sampled ${s.sampledMs} ms for a ${markAt - t0} ms job`)
  assert.ok(s.sampledMs > 700, `sampled ${s.sampledMs} ms`)
  assert.equal(s.averaging.startsWith('time-weighted'), true)
  assert.equal(s.overlap, null)
})

test('a session whose page goes quiet expires and leaves the Live view', async () => {
  const { id } = await post('/sessions', { label: 'orphan', rootPid: idle.pid })
  let mon = await (await fetch(BASE + '/monitor')).json()
  assert.ok(mon.jobs.some((j) => j.id === id))
  await sleep(TIMEOUT_MS + 3000)
  mon = await (await fetch(BASE + '/monitor')).json()
  assert.ok(!mon.jobs.some((j) => j.id === id), 'expired session still listed as running')
  const s = await post(`/sessions/${id}/stop`)
  assert.ok(s.orphaned, 'summary marks the session as orphaned')
  // a session started afterwards doesn't overlap the dead one
  const fresh = await post('/sessions', { label: 'after orphan', rootPid: busy.pid })
  const sf = await post(`/sessions/${fresh.id}/stop`)
  assert.equal(sf.overlap, null)
})

test('only local origins and hosts may use the API; bodies are capped (audit §3.12)', async () => {
  const http = await import('node:http')
  const raw = (opts, body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, ...opts }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'] }))
      })
      req.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: 'reset' }) : reject(e)))
      if (body) req.write(body)
      req.end()
    })
  // a website wiping the records: refused, and no CORS grant
  const evil = await raw({ method: 'DELETE', path: '/records', headers: { origin: 'https://evil.example' } })
  assert.equal(evil.status, 403)
  assert.equal(evil.acao, undefined)
  // DNS rebinding: right IP, foreign Host header
  assert.equal((await raw({ method: 'GET', path: '/records', headers: { host: 'evil.example:5299' } })).status, 403)
  // the dashboard / Vite pages are fine, and get their own origin back (never '*')
  const ok = await raw({ method: 'GET', path: '/health', headers: { origin: 'http://localhost:5173' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.acao, 'http://localhost:5173')
  // no Origin (Vite bridge, Node, curl)
  assert.equal((await raw({ method: 'GET', path: '/health' })).status, 200)
  // oversized body
  const big = await raw({ method: 'POST', path: '/sessions', headers: { 'content-type': 'application/json', 'content-length': String(17 * 1024 * 1024) } })
  assert.ok(big.status === 413 || big.status === 'reset', `got ${big.status}`)
})
