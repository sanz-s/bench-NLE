import { preview } from './playback'
import { MAX_ZOOM, MIN_ZOOM } from './components/Timeline'
import {
  addTextClip,
  copySelection,
  deleteSelection,
  deleteTransition,
  duplicateSelection,
  getState,
  pasteAttributes,
  pasteClipboard,
  redo,
  setState,
  splitAtPlayhead,
  undo,
} from './store'
import { timelineDuration, clipEnd } from '../media/compositor'

export const SHORTCUTS = [
  ['Space', 'Play / pause'],
  ['K', 'Pause'],
  ['L', 'Play'],
  ['J', 'Back 1 second'],
  ['← / →', 'Previous / next frame'],
  ['⇧← / ⇧→', 'Back / forward 10 frames'],
  ['↑ / ↓', 'Previous / next edit point'],
  ['Home / End', 'Go to start / end'],
  ['S', 'Split at playhead'],
  ['Delete', 'Delete selected clips'],
  ['⇧ Delete', 'Ripple delete (close the gap)'],
  ['T', 'Add title at playhead'],
  ['N', 'Toggle snapping (hold ⇧ while dragging to invert)'],
  ['= / −', 'Zoom timeline in / out'],
  ['\\', 'Zoom timeline to fit'],
  ['⌘Z / ⇧⌘Z', 'Undo / redo'],
  ['⌘A', 'Select all clips'],
  ['⌘C / ⌘X / ⌘V', 'Copy / cut / paste clips at the playhead'],
  ['⌘D', 'Duplicate selected clips'],
  ['⌥⌘V', 'Paste attributes (filter, animation, transform)'],
  ['⌘E', 'Export'],
  ['⌘I', 'Import media'],
  ['Esc', 'Deselect / close dialog'],
  ['?', 'Show shortcuts'],
]

function isTyping(el) {
  const e = el
  if (!e) return false
  const tag = e.tagName
  if (tag === 'TEXTAREA' || e.isContentEditable) return true
  if (tag === 'INPUT') {
    const type = e.type
    return !['checkbox', 'radio', 'range', 'button', 'color'].includes(type)
  }
  return tag === 'SELECT'
}

function editPoints() {
  const p = getState().project
  const pts = new Set([0])
  for (const c of p.clips) {
    pts.add(c.start)
    pts.add(clipEnd(c))
  }
  return [...pts].sort((a, b) => a - b)
}

export function installShortcuts() {
  const onKey = (e) => {
    const st = getState()
    if (e.key === 'Escape') {
      if (st.dialog) setState({ dialog: null })
      else if (isTyping(e.target)) e.target.blur()
      else setState({ selection: [] })
      return
    }
    if (isTyping(e.target) || st.dialog) return
    const mod = e.metaKey || e.ctrlKey
    const fps = st.project.fps
    const k = e.key.toLowerCase()

    if (mod && k === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (mod && k === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if (mod && k === 'e') {
      e.preventDefault()
      setState({ dialog: { type: 'export' } })
      return
    }
    if (mod && k === 'i') {
      e.preventDefault()
      document.getElementById('file-import')?.click()
      return
    }
    if (mod && (k === 'c' || k === 'x')) {
      // let the browser copy selected page text (e.g. from the bench panel)
      if (!st.selection.length && window.getSelection()?.toString()) return
      e.preventDefault()
      copySelection(k === 'x')
      return
    }
    if (mod && k === 'v') {
      e.preventDefault()
      if (e.altKey) pasteAttributes()
      else pasteClipboard()
      return
    }
    if (mod && k === 'd') {
      e.preventDefault()
      duplicateSelection()
      return
    }
    if (mod && k === 'a') {
      e.preventDefault()
      setState({ selection: st.project.clips.map((c) => c.id) })
      return
    }
    if (mod) return

    switch (e.key) {
      case ' ':
        e.preventDefault()
        preview.toggle()
        break
      case 'k':
      case 'K':
        preview.pause()
        break
      case 'l':
      case 'L':
        if (!st.playing) void preview.play()
        break
      case 'j':
      case 'J':
        preview.seek(Math.max(0, st.time - 1))
        break
      case 'ArrowLeft':
        e.preventDefault()
        preview.seek(Math.max(0, st.time - (e.shiftKey ? 10 : 1) / fps))
        break
      case 'ArrowRight':
        e.preventDefault()
        preview.seek(st.time + (e.shiftKey ? 10 : 1) / fps)
        break
      case 'ArrowUp': {
        e.preventDefault()
        const prev = editPoints()
          .filter((t) => t < st.time - 1e-4)
          .pop()
        if (prev !== undefined) preview.seek(prev)
        break
      }
      case 'ArrowDown': {
        e.preventDefault()
        const next = editPoints().find((t) => t > st.time + 1e-4)
        if (next !== undefined) preview.seek(next)
        break
      }
      case 'Home':
        e.preventDefault()
        preview.seek(0)
        break
      case 'End':
        e.preventDefault()
        preview.seek(timelineDuration(st.project))
        break
      case 's':
      case 'S':
        splitAtPlayhead()
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        if (st.selectedTransitionId) deleteTransition(st.selectedTransitionId)
        else deleteSelection(e.shiftKey)
        break
      case 't':
      case 'T':
        addTextClip()
        break
      case 'n':
      case 'N':
        setState({ snapping: !st.snapping })
        break
      case '=':
      case '+':
        setState({ zoom: Math.min(MAX_ZOOM, st.zoom * 1.5) })
        break
      case '-':
      case '_':
        setState({ zoom: Math.max(MIN_ZOOM, st.zoom / 1.5) })
        break
      case '\\':
        window.dispatchEvent(new Event('nle:fit-timeline'))
        break
      case '?':
        setState({ dialog: { type: 'shortcuts' } })
        break
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
