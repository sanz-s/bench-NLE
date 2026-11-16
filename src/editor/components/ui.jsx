import { useRef, useState } from 'react'

// ------------------------------------------------------------------ icons (stroke icons, 24-unit grid)

const PATHS = {
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  stepBack: <path d="M18 6v12M15 6l-8 6 8 6z" />,
  stepFwd: <path d="M6 6v12M9 6l8 6-8 6z" />,
  skipStart: <path d="M5 5v14M19 5l-10 7 10 7z" />,
  skipEnd: <path d="M19 5v14M5 5l10 7-10 7z" />,
  scissors: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  redo: <path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />,
  plus: <path d="M12 5v14M5 12h14" />,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  magnet: <path d="M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3zM6 7h4M14 7h4" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  ),
  volume: <path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />,
  mute: <path d="M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.8-1.3" />
    </>
  ),
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />,
  film: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-5-5L5 21" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12 5 5 9-10" />,
  alert: <path d="M12 3 2 20h20zM12 10v4M12 17v.5" />,
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </>
  ),
  zap: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  convert: <path d="M4 7h13l-3-3M20 17H7l3 3" />,
  keyboard: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-5-5M8 11h6M11 8v6" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-5-5M8 11h6" />
    </>
  ),
  sparkles: <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  gauge: <path d="M12 14l4-4M4 18a9 9 0 1 1 16 0" />,
}

export function Icon({ name, size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? null}
    </svg>
  )
}

// ------------------------------------------------------------------ buttons

export function IconButton(props) {
  const title = props.disabled && props.disabledReason ? props.disabledReason : props.shortcut ? `${props.label} (${props.shortcut})` : props.label
  return (
    <button
      type="button"
      className={`icon-btn${props.active ? ' active' : ''}`}
      onClick={props.onClick}
      aria-label={props.label}
      aria-pressed={props.active}
      title={title}
      disabled={props.disabled}
    >
      <Icon name={props.icon} size={props.size ?? 16} />
    </button>
  )
}

// ------------------------------------------------------------------ number field (scrub label, math input, reset)

export function NumberField(props) {
  const scale = props.displayScale ?? 1
  const precision = props.precision ?? 0
  const step = props.step ?? 1
  const shown = (props.value * scale).toFixed(precision)
  const [text, setText] = useState(shown)
  const [editing, setEditing] = useState(false)
  const drag = useRef(null)

  const clamp = (v) => Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v))
  const emit = (displayV, final) => props.onChange(clamp(displayV / scale), final)

  const commitText = () => {
    setEditing(false)
    const cur = props.value * scale
    const t = text.trim()
    let v = null
    const rel = /^([+\-*/])\s*(-?\d*\.?\d+)$/.exec(t)
    if (rel) {
      const n = parseFloat(rel[2])
      v = rel[1] === '+' ? cur + n : rel[1] === '-' ? cur - n : rel[1] === '*' ? cur * n : n !== 0 ? cur / n : cur
    } else if (/^-?\d*\.?\d+$/.test(t)) v = parseFloat(t)
    if (v !== null && Number.isFinite(v)) emit(v, true)
    else setText(shown)
  }

  return (
    <div className="num-field">
      <span
        className="num-label"
        title="Drag to change · Shift ×10 · Alt ×0.1 · Double-click to reset"
        onPointerDown={(e) => {
          e.target.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, v: props.value * scale, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const dx = e.clientX - d.x
          if (Math.abs(dx) > 2) d.moved = true
          if (!d.moved) return
          const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
          emit(d.v + Math.round(dx / 2) * step * mult, false)
        }}
        onPointerUp={() => {
          if (drag.current?.moved) emit(props.value * scale, true)
          drag.current = null
        }}
        onDoubleClick={() => props.defaultValue !== undefined && props.onChange(props.defaultValue, true)}
      >
        {props.label}
      </span>
      <input
        className="num-input"
        value={editing ? text : shown}
        onFocus={(e) => {
          setEditing(true)
          setText(shown)
          e.currentTarget.select()
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur()
          else if (e.key === 'Escape') {
            setText(shown)
            setEditing(false)
            e.target.blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
            const v = props.value * scale + (e.key === 'ArrowUp' ? 1 : -1) * step * mult
            emit(v, true)
            setText((clamp(v / scale) * scale).toFixed(precision))
          }
        }}
        inputMode="decimal"
        aria-label={props.label}
      />
      {props.suffix && <span className="num-suffix">{props.suffix}</span>}
      {props.defaultValue !== undefined && Math.abs(props.value - props.defaultValue) > 1e-9 && (
        <button type="button" className="reset-btn" title="Reset" aria-label={`Reset ${props.label}`} onClick={() => props.onChange(props.defaultValue, true)}>
          ↺
        </button>
      )}
    </div>
  )
}

export function Section({ title, children, right }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="section">
      <header className="section-head">
        <button type="button" className={`section-toggle${open ? ' open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="chevron" size={12} />
          {title}
        </button>
        {right}
      </header>
      {open && <div className="section-body">{children}</div>}
    </section>
  )
}

export function Badge({ children, tone = 'neutral', title }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  )
}
