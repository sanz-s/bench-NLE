import { useEffect, useState } from 'react'
import { addTextClip, redo, setProjectSettings, setState, undo, useStore } from '../store'
import { Icon, IconButton } from './ui'

function relTime(ts, now) {
  if (!ts) return ''
  const s = Math.round((now - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  return `${m} min ago`
}

export function TopBar() {
  const name = useStore((s) => s.project.name)
  const saveState = useStore((s) => s.saveState)
  const savedAt = useStore((s) => s.savedAt)
  const undoLabel = useStore((s) => s.undoLabel)
  const redoLabel = useStore((s) => s.redoLabel)
  const jobs = useStore((s) => s.jobs)
  const server = useStore((s) => s.server)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [])

  const job = jobs[0]
  return (
    <header className="topbar">
      <div className="brand" aria-label="Bunny NLE">
        <span className="brand-mark">
          <Icon name="film" size={16} />
        </span>
        <span className="brand-name">Bunny NLE</span>
      </div>
      <input
        key={name}
        className="project-name"
        defaultValue={name}
        aria-label="Project name"
        onBlur={(e) => {
          const v = e.target.value.trim()
          if (v && v !== name) setProjectSettings('Rename project', { name: v })
          else e.target.value = name
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
      />
      <span className={`save-state save-${saveState}`} title="Projects autosave to this browser (IndexedDB)">
        {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Autosave failed' : savedAt ? `Saved · ${relTime(savedAt, now)}` : 'Not saved yet'}
      </span>
      <div className="topbar-group">
        <IconButton
          icon="undo"
          label={undoLabel ? `Undo: ${undoLabel}` : 'Undo'}
          shortcut="⌘Z"
          onClick={undo}
          disabled={!undoLabel}
          disabledReason="Nothing to undo"
        />
        <IconButton
          icon="redo"
          label={redoLabel ? `Redo: ${redoLabel}` : 'Redo'}
          shortcut="⇧⌘Z"
          onClick={redo}
          disabled={!redoLabel}
          disabledReason="Nothing to redo"
        />
        <IconButton icon="text" label="Add title at playhead" shortcut="T" onClick={addTextClip} />
      </div>
      <div className="topbar-spacer" />
      <button
        type="button"
        className={`server-pill ${server ? 'on' : 'off'}`}
        onClick={() => setState({ sideTab: 'bench' })}
        title={
          server
            ? `bench-server online · GPU via ${server.gpuSource ?? 'n/a'}${server.powermetrics ? ' + powermetrics' : ''}`
            : 'bench-server not running: run `npm run bench:server` for CPU/GPU metrics'
        }
      >
        <span className="dot" />
        <Icon name="cpu" size={14} />
        {server ? 'Metrics on' : 'Metrics off'}
      </button>
      {server && (
        <a
          className="btn btn-small dash-link"
          href="http://127.0.0.1:5199/"
          target="_blank"
          rel="noopener"
          title="Open the Export Monitor: live CPU / GPU / main-thread charts during exports, and all saved results"
        >
          <Icon name="gauge" size={14} /> Dashboard
        </a>
      )}
      <IconButton icon="keyboard" label="Keyboard shortcuts" shortcut="?" onClick={() => setState({ dialog: { type: 'shortcuts' } })} />
      {job && (
        <div className="job-pill" title={`${job.label} (${job.runIn})`}>
          <div className="job-bar" style={{ width: `${Math.round(job.progress * 100)}%` }} />
          <span>{Math.round(job.progress * 100)}%</span>
          <button type="button" className="job-cancel" onClick={job.cancel} aria-label="Cancel job" title="Cancel">
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <button type="button" className="btn btn-primary export-btn" onClick={() => setState({ dialog: { type: 'export' } })} title="Export (⌘E)">
        <Icon name="download" size={16} />
        Export
      </button>
    </header>
  )
}
