import { useEffect, useState } from 'react'
import { TopBar } from './editor/components/TopBar'
import { LeftPanel } from './editor/components/LeftPanel'
import { Viewer } from './editor/components/Viewer'
import { Inspector } from './editor/components/Inspector'
import { Timeline } from './editor/components/Timeline'
import { BenchPanel } from './editor/components/BenchPanel'
import { ConvertDialog, ExportDialog } from './editor/components/ExportDialogs'
import { Icon } from './editor/components/ui'
import { setState, useStore } from './editor/store'
import { installShortcuts, SHORTCUTS } from './editor/shortcuts'
import { importFiles } from './editor/actions'
import { serverHealth } from './bench/serverClient'
import { preview } from './editor/playback'

function SidePanel() {
  const tab = useStore((s) => s.sideTab)
  const runs = useStore((s) => s.reports.length)
  return (
    <aside className="panel side">
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'inspector'}
          className={tab === 'inspector' ? 'on' : ''}
          onClick={() => setState({ sideTab: 'inspector' })}
        >
          Inspector
        </button>
        <button type="button" role="tab" aria-selected={tab === 'bench'} className={tab === 'bench' ? 'on' : ''} onClick={() => setState({ sideTab: 'bench' })}>
          <Icon name="gauge" size={14} /> Bench {runs > 0 && <span className="tab-count">{runs}</span>}
        </button>
      </div>
      <div className="side-body">{tab === 'inspector' ? <Inspector /> : <BenchPanel />}</div>
    </aside>
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'zap'} size={14} />
          <span>{t.text}</span>
          {t.action && (
            <button type="button" className="toast-action" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function ShortcutsDialog() {
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setState({ dialog: null })}>
      <div className="modal modal-narrow" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header className="modal-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="icon-btn" onClick={() => setState({ dialog: null })} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">
          <dl className="shortcut-list">
            {SHORTCUTS.map(([k, d]) => (
              <div key={k}>
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const dialog = useStore((s) => s.dialog)
  const [fileDrag, setFileDrag] = useState(false)

  useEffect(() => installShortcuts(), [])

  // Optional bench-server: poll health so the UI can show live CPU/GPU when it's running.
  useEffect(() => {
    let alive = true
    const check = async () => {
      const h = await serverHealth()
      if (alive) setState({ server: h })
    }
    void check()
    const t = setInterval(check, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    const leave = () => preview.pause()
    window.addEventListener('blur', leave)
    return () => window.removeEventListener('blur', leave)
  }, [])

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setFileDrag(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) setFileDrag(false)
      }}
      onDrop={(e) => {
        setFileDrag(false)
        if (e.dataTransfer.files.length && !e.defaultPrevented) {
          e.preventDefault()
          void importFiles(e.dataTransfer.files)
        }
      }}
    >
      <TopBar />
      <div className="workspace">
        <LeftPanel />
        <Viewer />
        <SidePanel />
      </div>
      <Timeline />
      {dialog?.type === 'export' && <ExportDialog />}
      {dialog?.type === 'convert' && <ConvertDialog assetId={dialog.assetId} />}
      {dialog?.type === 'shortcuts' && <ShortcutsDialog />}
      <Toasts />
      {fileDrag && <div className="file-drop-hint">Drop to import with Mediabunny</div>}
    </div>
  )
}
