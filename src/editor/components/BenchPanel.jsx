import { useEffect, useState } from 'react'
import { liveSample } from '../../bench/serverClient'
import { toCSV } from '../../bench/metrics'
import { clearReports, useStore } from '../store'
import { download } from '../actions'
import { formatBytes } from '../model'
import { Badge, Icon } from './ui'

const ms = (v) => (v === null || v === undefined ? '—' : v >= 10000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`)
const pct = (s) => (s ? `${s.avg.toFixed(0)}% avg · ${s.max.toFixed(0)}% max` : '—')
const num = (v, d = 1, suf = '') => (v === null || v === undefined ? '—' : `${v.toFixed(d)}${suf}`)

function saveBlob(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  download(url, name)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function BenchPanel() {
  const reports = useStore((s) => s.reports)
  const server = useStore((s) => s.server)
  const jobs = useStore((s) => s.jobs)
  const outputs = useStore((s) => s.outputs)
  const [live, setLive] = useState(null)
  const [open, setOpen] = useState(null)

  useEffect(() => {
    if (!server) return
    let alive = true
    const tick = async () => {
      const s = await liveSample()
      if (alive) setLive(s)
    }
    void tick()
    const t = setInterval(tick, jobs.length ? 1000 : 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [server, jobs.length])

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const shownLive = server ? live : null
  return (
    <div className="bench">
      <div className={`bench-server ${server ? 'on' : 'off'}`}>
        <div className="bench-server-head">
          <span className="dot" />
          <strong>{server ? 'bench-server connected' : 'bench-server not running'}</strong>
        </div>
        {server ? (
          <div className="live-grid">
            <div>
              <span>System CPU</span>
              <b>{num(shownLive?.cpuSystemPct, 0, '%')}</b>
            </div>
            <div>
              <span>Browser CPU</span>
              <b>{num(shownLive?.browserCpuPct, 0, '%')}</b>
            </div>
            <div>
              <span>GPU</span>
              <b>{num(shownLive?.gpuDevicePct, 0, '%')}</b>
            </div>
            <div>
              <span>Browser RAM</span>
              <b>{shownLive?.browserRssMB ? `${(shownLive.browserRssMB / 1024).toFixed(2)} GB` : '—'}</b>
            </div>
          </div>
        ) : (
          <p className="small muted">
            For CPU/GPU numbers run <code>npm run bench:server</code> in a terminal. The editor works fully without it.
          </p>
        )}
      </div>

      <div className="bench-actions">
        <strong>
          {reports.length} {reports.length === 1 ? 'run' : 'runs'}
        </strong>
        <div className="topbar-spacer" />
        <button
          type="button"
          className="btn btn-small"
          disabled={!reports.length}
          onClick={() => saveBlob(JSON.stringify(reports, null, 2), `bench-${stamp()}.json`, 'application/json')}
        >
          JSON
        </button>
        <button type="button" className="btn btn-small" disabled={!reports.length} onClick={() => saveBlob(toCSV(reports), `bench-${stamp()}.csv`, 'text/csv')}>
          CSV
        </button>
        <button type="button" className="btn btn-small btn-ghost" disabled={!reports.length} onClick={clearReports} title="Clear all results">
          <Icon name="trash" size={13} />
        </button>
      </div>

      {reports.length === 0 && (
        <p className="small muted pad">
          Export the timeline or convert a file. Each run records conversion time, encode time, encoder latency, main-thread blocking (long tasks / TBT) and,
          with the server, CPU/GPU usage.
        </p>
      )}
      <ul className="report-list">
        {reports.map((r) => (
          <ReportCard key={r.id} r={r} url={outputs[r.id]} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} />
        ))}
      </ul>
    </div>
  )
}

function ReportCard({ r, url, open, toggle }) {
  const t = r.timings
  const mt = r.mainThread
  const sys = r.system
  return (
    <li className={`report ${r.status}`}>
      <button type="button" className="report-head" onClick={toggle} aria-expanded={open}>
        <div className="report-title">
          <span>{r.label}</span>
          <span className="small muted">
            {r.engine} · {r.runIn} · {new Date(r.createdAt).toLocaleTimeString()}
          </span>
        </div>
        {r.status === 'done' ? (
          r.verify?.ok === false ? (
            <Badge tone="warn" title={r.verify.problems.join('\n')}>
              check
            </Badge>
          ) : (
            <Badge tone="ok">ok</Badge>
          )
        ) : (
          <Badge tone="bad">{r.status}</Badge>
        )}
      </button>
      {r.status !== 'done' ? (
        <p className="small report-error">{r.error}</p>
      ) : (
        <div className="report-kpis">
          <div title="Job start → file finalized (worker spawn excluded)">
            <span>Conversion</span>
            <b>{ms(r.derived.conversionMs)}</b>
          </div>
          <div title="Time awaiting encoder submissions + finalize flush">
            <span>Encode</span>
            <b>{r.derived.encodeMs === null ? 'pipelined' : ms(r.derived.encodeMs)}</b>
          </div>
          <div title="Media seconds per wall-clock second">
            <span>Speed</span>
            <b>{num(r.derived.realtimeFactor, 1, '×')}</b>
          </div>
          <div title="Total Blocking Time on the main thread during the job">
            <span>Main TBT</span>
            <b>{ms(mt?.tbtMs)}</b>
          </div>
          <div title="Average whole-system CPU from bench-server">
            <span>CPU</span>
            <b>{sys?.cpuSystemPct ? `${sys.cpuSystemPct.avg.toFixed(0)}%` : '—'}</b>
          </div>
          <div title="Average GPU device utilization from bench-server">
            <span>GPU</span>
            <b>{sys?.gpuDevicePct ? `${sys.gpuDevicePct.avg.toFixed(0)}%` : '—'}</b>
          </div>
        </div>
      )}
      {open && (
        <div className="report-detail">
          <table>
            <tbody>
              <Row
                k="Input"
                v={
                  r.kind === 'export'
                    ? `${r.input.name} · ${r.input.clips ?? 0} clips · ${r.input.duration.toFixed(2)}s`
                    : `${r.input.name} (${r.input.container} ${r.input.videoCodec ?? '—'}/${r.input.audioCodec ?? '—'})`
                }
              />
              <Row k="Output" v={`${r.output.fileName} · ${formatBytes(r.output.bytes)} · ${num(r.output.bitrateKbps, 0, ' kb/s')}`} />
              <Row
                k="Settings"
                v={`${r.settings.width}×${r.settings.height} @ ${r.settings.fps} · ${r.settings.qualityMode === 'level' ? r.settings.quality : `${(r.settings.videoBitrate / 1e6).toFixed(1)} Mb/s`} · hw ${r.settings.hardwareAcceleration}`}
              />
              {r.encoder?.videoEncoderConfig && (
                <Row k="Encoder" v={`${r.encoder.videoEncoderConfig.codec} · ${r.encoder.videoEncoderConfig.hardwareAcceleration ?? 'default'}`} />
              )}
              {r.conversion && (
                <Row k="Stream copy" v={`video ${fmtBool(r.conversion.copyExpected.video)} · audio ${fmtBool(r.conversion.copyExpected.audio)}`} />
              )}
              <Row k="Frames" v={`${r.frames} · ${num(r.derived.encodeFps, 1, ' fps')}`} />
              <Row k="Worker spawn" v={ms(t.workerSpawn)} />
              <Row k="Setup" v={ms(t.setup)} />
              <Row k="Decode wait" v={ms(t.decodeWait)} />
              <Row k="Composite" v={ms(t.composite)} />
              <Row k="Video encode wait" v={ms(t.videoEncodeWait)} />
              <Row k="Audio decode+mix" v={ms(t.audioDecodeMix)} />
              <Row k="Audio encode wait" v={ms(t.audioEncodeWait)} />
              <Row k="Finalize / mux" v={ms(t.finalize)} />
              {t.timeToFirstProgress !== undefined && <Row k="First progress" v={ms(t.timeToFirstProgress)} />}
              {r.encoder && (
                <Row k="Encoder latency" v={`${ms(r.encoder.latencyAvg)} avg · ${ms(r.encoder.latencyP95)} p95 · ${ms(r.encoder.latencyMax)} max`} />
              )}
              {r.encoder && <Row k="Encoder busy span" v={ms(r.encoder.encoderSpan)} />}
              {mt && <Row k="Long tasks" v={`${mt.longTasks} · longest ${ms(mt.longestTaskMs)} · blocked ${mt.blockedPct.toFixed(1)}%`} />}
              {mt && <Row k="Frame gaps" v={`${mt.rafGapsOver50ms} frames > 50 ms · p95 ${num(mt.rafP95Ms, 1, ' ms')}`} />}
              {mt?.loafBlockingMs !== null && mt && <Row k="LoAF blocking" v={ms(mt.loafBlockingMs)} />}
              <Row k="Peak JS heap" v={num(r.peakHeapMB, 0, ' MB')} />
              {sys && (
                <>
                  <Row k="System CPU" v={pct(sys.cpuSystemPct)} />
                  <Row k="Browser CPU" v={`${pct(sys.browserCpuPct)} (100% = 1 core)`} />
                  {Object.entries(sys.browserCpuByType).map(([type, s]) => (
                    <Row key={type} k={`  ${type}`} v={pct(s)} />
                  ))}
                  <Row k="GPU device" v={pct(sys.gpuDevicePct)} />
                  {sys.gpuPowerW && <Row k="GPU power" v={`${sys.gpuPowerW.avg.toFixed(2)} W avg`} />}
                  {sys.cpuPowerW && <Row k="CPU power" v={`${sys.cpuPowerW.avg.toFixed(2)} W avg`} />}
                  <Row k="Browser RSS" v={sys.browserRssMB ? `${Math.round(sys.browserRssMB.max)} MB max` : '—'} />
                </>
              )}
              {r.verify && (
                <Row
                  k="Verify"
                  v={
                    r.verify.ok
                      ? `ok · ${r.verify.container} ${r.verify.videoCodec ?? ''}/${r.verify.audioCodec ?? ''} ${r.verify.duration?.toFixed(2)}s`
                      : r.verify.problems.join('; ')
                  }
                />
              )}
              <Row k="Env" v={`${r.env.cores} cores · isolated ${r.env.crossOriginIsolated} · ${r.env.gpu ?? ''}`} />
            </tbody>
          </table>
          {url && (
            <button type="button" className="btn btn-small" onClick={() => download(url, r.output.fileName)}>
              <Icon name="download" size={13} /> Download output
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function fmtBool(v) {
  return v === null ? 'n/a' : v ? 'yes' : 'no (transcode)'
}

function Row({ k, v }) {
  return (
    <tr>
      <th>{k}</th>
      <td>{v}</td>
    </tr>
  )
}
