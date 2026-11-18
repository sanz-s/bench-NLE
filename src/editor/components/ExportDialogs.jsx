import { useEffect, useMemo, useState } from 'react'
import { getCapabilities } from '../../media/capabilities'
import { nativeAacSupported } from '../../media/extensions'
import { timelineDuration } from '../../media/compositor'
import { canStreamToDisk, startConvert, startExport } from '../actions'
import { setState, useStore } from '../store'
import { defaultEncodeSettings, formatBytes, formatDuration } from '../model'
import { Badge, Icon } from './ui'

const AUDIO_PREF = ['aac', 'opus', 'mp3', 'flac', 'vorbis', 'pcm-s16', 'ac3', 'eac3']
const VIDEO_PREF = ['avc', 'vp9', 'av1', 'hevc', 'vp8']

const PRESETS = [
  {
    name: 'YouTube 1080p',
    hint: 'MP4 · H.264 · AAC',
    apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1920, height: 1080, qualityMode: 'level', quality: 'high' }),
  },
  {
    name: 'Reels / TikTok',
    hint: '9:16 MP4 · H.264',
    apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1080, height: 1920, qualityMode: 'level', quality: 'high' }),
  },
  {
    name: 'Web WebM',
    hint: 'VP9 · Opus',
    apply: () => ({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', qualityMode: 'level', quality: 'medium' }),
  },
  {
    name: 'AV1 small',
    hint: 'MP4 · AV1 · AAC',
    apply: () => ({ container: 'mp4', videoCodec: 'av1', audioCodec: 'aac', qualityMode: 'level', quality: 'medium' }),
  },
  {
    name: 'Podcast MP3',
    hint: 'audio · 192 kb/s',
    apply: () => ({ container: 'mp3', videoCodec: null, audioCodec: 'mp3', qualityMode: 'bitrate', audioBitrate: 192_000 }),
  },
  { name: 'Lossless FLAC', hint: 'audio · FLAC', apply: () => ({ container: 'flac', videoCodec: null, audioCodec: 'flac' }) },
  {
    name: 'Archive MKV',
    hint: 'H.264 · FLAC',
    apply: () => ({ container: 'mkv', videoCodec: 'avc', audioCodec: 'flac', qualityMode: 'level', quality: 'very-high' }),
  },
]

function loadSettings(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw), width: fallback.width, height: fallback.height, fps: fallback.fps } : fallback
  } catch {
    return fallback
  }
}
function saveSettings(key, s) {
  try {
    localStorage.setItem(key, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

/** Pick codecs that are valid for the chosen container in this browser. */
function normalize(s, caps) {
  if (!caps) return s
  const c = caps.find((x) => x.id === s.container)
  if (!c) return s
  const okV = c.video.filter((v) => v.available).map((v) => v.codec)
  const okA = c.audio.filter((a) => a.available).map((a) => a.codec)
  let videoCodec = s.videoCodec
  if (c.audioOnly) videoCodec = null
  else if (videoCodec && !okV.includes(videoCodec)) videoCodec = VIDEO_PREF.find((v) => okV.includes(v)) ?? okV[0] ?? null
  let audioCodec = s.audioCodec
  if (audioCodec && !okA.includes(audioCodec)) audioCodec = AUDIO_PREF.find((a) => okA.includes(a)) ?? okA[0] ?? null
  if (!audioCodec && c.audioOnly) audioCodec = AUDIO_PREF.find((a) => okA.includes(a)) ?? okA[0] ?? null
  if (videoCodec === s.videoCodec && audioCodec === s.audioCodec) return s
  return { ...s, videoCodec, audioCodec }
}

function useCaps(s) {
  const [caps, setCaps] = useState(null)
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      void getCapabilities({ width: s.width, height: s.height, fps: s.fps, channels: s.audioChannels, sampleRate: s.sampleRate }).then(
        (c) => live && setCaps(c),
      )
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [s.width, s.height, s.fps, s.audioChannels, s.sampleRate])
  return caps
}

function Modal({ title, children, footer, onClose }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-foot">{footer}</footer>
      </div>
    </div>
  )
}

function EncodeForm({ s, set, caps, duration, sourceSize }) {
  const [nativeAac, setNativeAac] = useState(null)
  useEffect(() => {
    void nativeAacSupported().then(setNativeAac)
  }, [])
  const cur = caps?.find((c) => c.id === s.container)
  const estimate = s.qualityMode === 'bitrate' ? (((s.videoCodec ? s.videoBitrate : 0) + (s.audioCodec ? s.audioBitrate : 0)) * duration) / 8 : null
  const sizes = [
    [sourceSize.label, sourceSize.w, sourceSize.h],
    ['2160p', 3840, 2160],
    ['1080p', 1920, 1080],
    ['720p', 1280, 720],
    ['480p', 854, 480],
    ['Vertical 1080×1920', 1080, 1920],
  ]
  return (
    <div className="encode-form">
      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.name} type="button" className="preset" onClick={() => set(p.apply(s))}>
            <strong>{p.name}</strong>
            <span>{p.hint}</span>
          </button>
        ))}
      </div>

      <h3 className="form-h">Container</h3>
      {!caps ? (
        <p className="muted">
          <span className="spinner" /> Checking which formats this browser can encode…
        </p>
      ) : (
        <div className="container-grid" role="radiogroup" aria-label="Container">
          {caps.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={s.container === c.id}
              className={`container-opt${s.container === c.id ? ' on' : ''}`}
              disabled={!c.available}
              title={c.available ? `${c.label} (${c.ext})` : c.reason}
              onClick={() => set({ container: c.id })}
            >
              <strong>{c.label.replace(' (audio)', '')}</strong>
              <span>
                {c.ext}
                {c.audioOnly ? ' · audio' : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {cur && (
        <div className="form-grid">
          {!cur.audioOnly && (
            <label className="form-field">
              <span>Video codec</span>
              <select value={s.videoCodec ?? ''} onChange={(e) => set({ videoCodec: e.target.value || null })}>
                {cur.video.map((v) => (
                  <option key={v.codec} value={v.codec} disabled={!v.available} title={v.reason}>
                    {v.label}
                    {v.available ? '' : ' — not encodable here'}
                  </option>
                ))}
                <option value="">None (no video)</option>
              </select>
            </label>
          )}
          <label className="form-field">
            <span>Audio codec</span>
            <select value={s.audioCodec ?? ''} onChange={(e) => set({ audioCodec: e.target.value || null })}>
              {cur.audio.map((a) => (
                <option key={a.codec} value={a.codec} disabled={!a.available} title={a.reason}>
                  {a.label}
                  {a.viaExtension && a.available ? ' · ext' : ''}
                  {a.available ? '' : ' — not encodable here'}
                </option>
              ))}
              {!cur.audioOnly && <option value="">None (no audio)</option>}
            </select>
          </label>
          {!cur.audioOnly && s.videoCodec && (
            <>
              <label className="form-field">
                <span>Resolution</span>
                <select
                  value={sizes.find(([, w, h]) => w === s.width && h === s.height)?.[0] ?? 'custom'}
                  onChange={(e) => {
                    const f = sizes.find(([n]) => n === e.target.value)
                    if (f) set({ width: f[1], height: f[2] })
                  }}
                >
                  {sizes.map(([n, w, h]) => (
                    <option key={n} value={n}>
                      {n} · {w}×{h}
                    </option>
                  ))}
                  {!sizes.some(([, w, h]) => w === s.width && h === s.height) && (
                    <option value="custom">
                      Custom · {s.width}×{s.height}
                    </option>
                  )}
                </select>
              </label>
              <label className="form-field">
                <span>Frame rate</span>
                <select value={s.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
                  {[...new Set([s.fps, 23.976, 24, 25, 29.97, 30, 50, 60])]
                    .sort((a, b) => a - b)
                    .map((f) => (
                      <option key={f} value={f}>
                        {Number.isInteger(f) ? f : f.toFixed(3)} fps
                      </option>
                    ))}
                </select>
              </label>
              <label className="form-field">
                <span>Keyframe every</span>
                <select value={s.keyFrameInterval} onChange={(e) => set({ keyFrameInterval: Number(e.target.value) })}>
                  {[0.5, 1, 2, 4, 5, 10].map((k) => (
                    <option key={k} value={k}>
                      {k} s
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Hardware</span>
                <select value={s.hardwareAcceleration} onChange={(e) => set({ hardwareAcceleration: e.target.value })}>
                  <option value="no-preference">Browser decides</option>
                  <option value="prefer-hardware">Prefer GPU / hardware</option>
                  <option value="prefer-software">Prefer CPU / software</option>
                </select>
              </label>
            </>
          )}
          <label className="form-field">
            <span>Quality</span>
            <select
              value={s.qualityMode === 'bitrate' ? 'bitrate' : s.quality}
              onChange={(e) => (e.target.value === 'bitrate' ? set({ qualityMode: 'bitrate' }) : set({ qualityMode: 'level', quality: e.target.value }))}
            >
              <option value="very-high">Very high</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
              <option value="very-low">Very low</option>
              <option value="bitrate">Exact bitrate…</option>
            </select>
          </label>
          {s.qualityMode === 'bitrate' && s.videoCodec && !cur.audioOnly && (
            <label className="form-field">
              <span>Video Mb/s</span>
              <input
                type="number"
                min={0.1}
                step={0.5}
                value={s.videoBitrate / 1e6}
                onChange={(e) => set({ videoBitrate: Math.max(0.1, Number(e.target.value)) * 1e6 })}
              />
            </label>
          )}
          {s.qualityMode === 'bitrate' && s.audioCodec && (
            <label className="form-field">
              <span>Audio kb/s</span>
              <input
                type="number"
                min={32}
                step={16}
                value={s.audioBitrate / 1000}
                onChange={(e) => set({ audioBitrate: Math.max(32, Number(e.target.value)) * 1000 })}
              />
            </label>
          )}
          {s.audioCodec && (
            <>
              <label className="form-field">
                <span>Channels</span>
                <select value={s.audioChannels} onChange={(e) => set({ audioChannels: Number(e.target.value) })}>
                  <option value={1}>Mono</option>
                  <option value={2}>Stereo</option>
                </select>
              </label>
              <label className="form-field">
                <span>Sample rate</span>
                <select value={s.sampleRate} onChange={(e) => set({ sampleRate: Number(e.target.value) })}>
                  <option value={44100}>44.1 kHz</option>
                  <option value={48000}>48 kHz</option>
                </select>
              </label>
              {s.audioCodec === 'aac' && (
                <label className="form-field" title="Which AAC encoder to benchmark. Auto uses the browser's own encoder when it has one.">
                  <span>AAC encoder</span>
                  <select value={s.aacEncoder ?? 'auto'} onChange={(e) => set({ aacEncoder: e.target.value })}>
                    <option value="auto">Auto ({nativeAac === false ? 'WASM: no native AAC here' : 'browser native'})</option>
                    <option value="native" disabled={nativeAac === false}>
                      Browser native (WebCodecs){nativeAac === false ? ' · not available' : ''}
                    </option>
                    <option value="wasm">WASM extension (FFmpeg)</option>
                  </select>
                </label>
              )}
            </>
          )}
        </div>
      )}
      <p className="form-summary">
        {formatDuration(duration)} → <strong>{s.container.toUpperCase()}</strong> {s.videoCodec ? <Badge tone="accent">{s.videoCodec}</Badge> : null}{' '}
        {s.audioCodec ? <Badge tone="accent">{s.audioCodec}</Badge> : null}
        {estimate !== null && <span className="muted"> · ≈ {formatBytes(estimate)}</span>}
        {cur?.audio.find((a) => a.codec === s.audioCodec)?.viaExtension && (
          <span className="muted"> · audio via {cur.audio.find((a) => a.codec === s.audioCodec).viaExtension}</span>
        )}
      </p>
    </div>
  )
}

function RunOptions({ runIn, setRunIn, toDisk, setToDisk }) {
  const streamOk = canStreamToDisk()
  return (
    <div className="run-options">
      <div className="seg" role="radiogroup" aria-label="Run in">
        <button
          type="button"
          role="radio"
          aria-checked={runIn === 'worker'}
          className={runIn === 'worker' ? 'on' : ''}
          onClick={() => setRunIn('worker')}
          title="Encode in a Web Worker (UI stays responsive)"
        >
          Worker
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={runIn === 'main'}
          className={runIn === 'main' ? 'on' : ''}
          onClick={() => setRunIn('main')}
          title="Encode on the main thread (for benchmarking main-thread blocking)"
        >
          Main thread
        </button>
      </div>
      <label
        className="check"
        title={
          streamOk
            ? 'Stream straight into a file on disk (no full copy in memory)'
            : 'Your browser has no File System Access API, so the result is kept in memory and downloaded'
        }
      >
        <input type="checkbox" checked={toDisk && streamOk} disabled={!streamOk} onChange={(e) => setToDisk(e.target.checked)} />
        Save directly to disk
      </label>
    </div>
  )
}

export function ExportDialog() {
  const project = useStore((s) => s.project)
  const duration = timelineDuration(project)
  const [s, setS] = useState(() => loadSettings('nle.exportSettings', defaultEncodeSettings(project)))
  const caps = useCaps(s)
  const [runIn, setRunIn] = useState('worker')
  const [toDisk, setToDisk] = useState(false)
  const ns = useMemo(() => normalize(s, caps), [s, caps])
  const close = () => setState({ dialog: null })
  const set = (patch) => setS((prev) => ({ ...prev, ...patch }))
  const go = () => {
    saveSettings('nle.exportSettings', ns)
    close()
    void startExport(ns, { runIn, saveToDisk: toDisk, autoDownload: true })
  }
  const nothing = duration <= 0
  return (
    <Modal
      title="Export timeline"
      onClose={close}
      footer={
        <>
          <RunOptions runIn={runIn} setRunIn={setRunIn} toDisk={toDisk} setToDisk={setToDisk} />
          <div className="topbar-spacer" />
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={go}
            disabled={nothing || !caps || (!ns.videoCodec && !ns.audioCodec)}
            title={nothing ? 'The timeline is empty' : undefined}
          >
            <Icon name="download" size={14} /> Export
          </button>
        </>
      }
    >
      <EncodeForm s={ns} set={set} caps={caps} duration={duration} sourceSize={{ w: project.width, h: project.height, label: 'Sequence' }} />
    </Modal>
  )
}

export function ConvertDialog({ assetId }) {
  const asset = useStore((s) => s.project.assets.find((a) => a.id === assetId))
  const project = useStore((s) => s.project)
  const close = () => setState({ dialog: null })
  const src = asset?.info
  const [s, setS] = useState(() => {
    const base = loadSettings('nle.convertSettings', defaultEncodeSettings(project))
    return {
      ...base,
      width: src?.video?.width ?? base.width,
      height: src?.video?.height ?? base.height,
      fps: src?.video?.fps ? Math.round(src.video.fps * 1000) / 1000 : base.fps,
      videoCodec: src?.video ? base.videoCodec : null,
    }
  })
  const caps = useCaps(s)
  const [engine, setEngine] = useState('conversion')
  const [allowCopy, setAllowCopy] = useState(true)
  const [runIn, setRunIn] = useState('worker')
  const [toDisk, setToDisk] = useState(false)
  const [trim, setTrim] = useState({ start: 0, end: src?.duration ?? 0 })
  const ns = useMemo(() => normalize(s, caps), [s, caps])
  if (!asset || !src) return null
  const set = (patch) => setS((prev) => ({ ...prev, ...patch }))
  const willCopyVideo =
    engine === 'conversion' && allowCopy && !!src.video && ns.videoCodec === src.video.codec && ns.width === src.video.width && ns.height === src.video.height
  const willCopyAudio = engine === 'conversion' && allowCopy && !!src.audio && ns.audioCodec === src.audio.codec
  const go = () => {
    saveSettings('nle.convertSettings', ns)
    close()
    void startConvert(asset, ns, engine, allowCopy, trim, { runIn, saveToDisk: toDisk, autoDownload: true })
  }
  return (
    <Modal
      title={`Convert “${asset.name}”`}
      onClose={close}
      footer={
        <>
          <RunOptions runIn={runIn} setRunIn={setRunIn} toDisk={toDisk} setToDisk={setToDisk} />
          <div className="topbar-spacer" />
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={go} disabled={!caps || (!ns.videoCodec && !ns.audioCodec) || trim.end <= trim.start}>
            <Icon name="convert" size={14} /> Convert
          </button>
        </>
      }
    >
      <div className="convert-src">
        <span className="muted">Source</span> {src.container} ·{' '}
        {src.video ? `${src.video.codec} ${src.video.width}×${src.video.height} ${src.video.fps.toFixed(2)}fps` : 'no video'} ·{' '}
        {src.audio ? `${src.audio.codec} ${src.audio.channels}ch ${src.audio.sampleRate}Hz` : 'no audio'} · {formatDuration(src.duration)}
      </div>
      <div className="engine-pick">
        <label className={`engine-opt${engine === 'conversion' ? ' on' : ''}`}>
          <input type="radio" name="engine" checked={engine === 'conversion'} onChange={() => setEngine('conversion')} />
          <div>
            <strong>Mediabunny Conversion</strong>
            <span>Fastest. Copies streams without re-encoding when codec and size match. Reports total time only.</span>
          </div>
        </label>
        <label className={`engine-opt${engine === 'pipeline' ? ' on' : ''}`}>
          <input type="radio" name="engine" checked={engine === 'pipeline'} onChange={() => setEngine('pipeline')} />
          <div>
            <strong>Manual pipeline</strong>
            <span>Always decodes → draws → encodes. Splits decode / composite / encode time and per-frame encoder latency.</span>
          </div>
        </label>
      </div>
      <div className="form-grid compact">
        {engine === 'conversion' && (
          <label className="check">
            <input type="checkbox" checked={allowCopy} onChange={(e) => setAllowCopy(e.target.checked)} />
            Allow stream copy
            {(willCopyVideo || willCopyAudio) && (
              <Badge tone="ok" title="These tracks will be copied without re-encoding">
                copy: {[willCopyVideo && 'video', willCopyAudio && 'audio'].filter(Boolean).join(' + ')}
              </Badge>
            )}
          </label>
        )}
        <label className="form-field">
          <span>Trim start (s)</span>
          <input type="number" min={0} step={0.1} value={trim.start} onChange={(e) => setTrim({ ...trim, start: Math.max(0, Number(e.target.value)) })} />
        </label>
        <label className="form-field">
          <span>Trim end (s)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            max={src.duration}
            value={Number(trim.end.toFixed(3))}
            onChange={(e) => setTrim({ ...trim, end: Math.min(src.duration, Number(e.target.value)) })}
          />
        </label>
      </div>
      <EncodeForm
        s={ns}
        set={set}
        caps={caps}
        duration={trim.end - trim.start}
        sourceSize={{ w: src.video?.width ?? project.width, h: src.video?.height ?? project.height, label: 'Source' }}
      />
    </Modal>
  )
}
