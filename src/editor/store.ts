import { useSyncExternalStore } from 'react'
import type { Asset, Clip, ClipSticker, EffectInstance, Project, TextFx, Track, Transition, TransitionType } from '../media/types'
import { clipEnd, resolveTransitions, timelineDuration } from '../media/compositor'
import { TEXT_PRESETS } from '../media/effects/text'
import { defaultFilter } from '../media/effects/filters'
import { defaultAnim } from '../media/effects/animations'
import { effectDef, newEffect } from '../media/effects/fx/videoEffects'
import { transitionLabel } from '../media/effects/transitions'
import type { JobReport } from '../bench/metrics'
import type { ServerHealth } from '../bench/serverClient'
import { baseVideoTrack, clipsForAsset, defaultProject, makeClip, newTrack, nextTrackName, uid, videoTracks } from './model'

// ------------------------------------------------------------------ state

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error'
  text: string
  action?: { label: string; run: () => void }
}

export interface ActiveJob {
  id: string
  label: string
  progress: number
  runIn: 'worker' | 'main'
  cancel: () => void
}

export type Dialog = null | { type: 'export' } | { type: 'convert'; assetId: string } | { type: 'shortcuts' }

export interface State {
  project: Project
  selection: string[]
  selectedAssetId: string | null
  time: number
  playing: boolean
  zoom: number // px per second
  snapping: boolean
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  savedAt: number | null
  toasts: Toast[]
  jobs: ActiveJob[]
  reports: JobReport[]
  /** report id → object URL of the produced file (not persisted). */
  outputs: Record<string, string>
  dialog: Dialog
  importing: number
  undoLabel: string | null
  redoLabel: string | null
  server: ServerHealth | null
  sideTab: 'inspector' | 'bench'
  selectedTransitionId: string | null
  leftTab: 'media' | 'text' | 'stickers' | 'transitions' | 'filters'
}

let state: State = {
  project: defaultProject(),
  selection: [],
  selectedAssetId: null,
  time: 0,
  playing: false,
  zoom: 80,
  snapping: true,
  saveState: 'idle',
  savedAt: null,
  toasts: [],
  jobs: [],
  reports: loadReports(),
  outputs: {},
  dialog: null,
  importing: 0,
  undoLabel: null,
  redoLabel: null,
  server: null,
  sideTab: 'inspector',
  selectedTransitionId: null,
  leftTab: 'media',
}

const listeners = new Set<() => void>()

export function getState(): State {
  return state
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch
  const prevProject = state.project
  state = { ...state, ...p }
  if (state.project !== prevProject) scheduleAutosave()
  if ('reports' in p) saveReports(state.reports)
  for (const l of listeners) l()
}

export function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

// ------------------------------------------------------------------ history (undo/redo)

interface HistoryEntry {
  project: Project
  label: string
}
const past: HistoryEntry[] = []
const future: HistoryEntry[] = []
const MAX_HISTORY = 200
let gestureBase: Project | null = null

function syncHistoryLabels() {
  setState({ undoLabel: past.at(-1)?.label ?? null, redoLabel: future.at(-1)?.label ?? null })
}

/** Apply an undoable change. The recipe gets a deep copy it may mutate. */
export function commit(label: string, recipe: (p: Project) => void) {
  const before = state.project
  const draft = cloneProject(before)
  recipe(draft)
  pruneTransitions(draft)
  past.push({ project: before, label })
  if (past.length > MAX_HISTORY) past.shift()
  future.length = 0
  setState({ project: draft })
  syncHistoryLabels()
}

/** Gestures (drags) update the project live and commit once at the end. */
export function beginGesture() {
  gestureBase = state.project
}
export function updateGesture(recipe: (p: Project) => void) {
  if (!gestureBase) beginGesture()
  const draft = cloneProject(gestureBase!)
  recipe(draft)
  setState({ project: draft })
}
export function endGesture(label: string) {
  if (gestureBase && gestureBase !== state.project) {
    const pruned = cloneProject(state.project)
    if (pruneTransitions(pruned)) setState({ project: pruned })
    past.push({ project: gestureBase, label })
    if (past.length > MAX_HISTORY) past.shift()
    future.length = 0
    syncHistoryLabels()
  }
  gestureBase = null
}
export function cancelGesture() {
  if (gestureBase) setState({ project: gestureBase })
  gestureBase = null
}

export function undo() {
  const e = past.pop()
  if (!e) return
  future.push({ project: state.project, label: e.label })
  setState({ project: e.project, selection: state.selection.filter((id) => e.project.clips.some((c) => c.id === id)) })
  syncHistoryLabels()
  toast('info', `Undo: ${e.label}`)
}

export function redo() {
  const e = future.pop()
  if (!e) return
  past.push({ project: state.project, label: e.label })
  setState({ project: e.project })
  syncHistoryLabels()
  toast('info', `Redo: ${e.label}`)
}

/** Assets hold File objects (immutable) — share them; deep-copy everything else. */
function cloneProject(p: Project): Project {
  return {
    ...p,
    assets: p.assets.slice(),
    tracks: p.tracks.map((t) => ({ ...t })),
    clips: p.clips.map(cloneClip),
    transitions: (p.transitions ?? []).map((t) => ({ ...t })),
  }
}

function cloneClip(c: Clip): Clip {
  return {
    ...c,
    transform: { ...c.transform },
    audio: { ...c.audio },
    text: c.text ? { ...c.text } : undefined,
    filter: c.filter ? { ...c.filter } : undefined,
    anim: c.anim ? { ...c.anim } : undefined,
    sticker: c.sticker ? { ...c.sticker } : undefined,
    effects: c.effects?.map((e) => ({ ...e, params: { ...e.params } })),
  }
}

/** Drop transitions whose clips were deleted, moved apart or moved to another track. Returns true if any removed. */
function pruneTransitions(p: Project): boolean {
  const list = p.transitions ?? []
  if (!list.length) return false
  const valid = new Set(resolveTransitions(p).map((r) => r.tr.id))
  const kept = list.filter((t) => valid.has(t.id))
  if (kept.length === list.length) return false
  p.transitions = kept
  if (state.selectedTransitionId && !valid.has(state.selectedTransitionId)) setTimeout(() => setState({ selectedTransitionId: null }))
  return true
}

// ------------------------------------------------------------------ toasts

export function toast(kind: Toast['kind'], text: string, action?: Toast['action'], ms = 3500) {
  const id = uid('toast')
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, action }] }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
}

// ------------------------------------------------------------------ actions

export function addAsset(asset: Asset) {
  // Assets live in the project but adding one is not an undoable edit.
  setState((s) => ({ project: { ...s.project, assets: [...s.project.assets, asset] } }))
}

export function removeAsset(id: string) {
  commit('Remove media', (p) => {
    p.assets = p.assets.filter((a) => a.id !== id)
    p.clips = p.clips.filter((c) => c.assetId !== id)
  })
}

/** Append an asset at the end of the base tracks (or at `start` on given tracks). */
export function placeAsset(assetId: string, opts: { start?: number; videoTrackId?: string; audioTrackId?: string } = {}) {
  const asset = state.project.assets.find((a) => a.id === assetId)
  if (!asset) return
  let placed: Clip[] = []
  commit(`Add ${asset.name}`, (p) => {
    let start = opts.start
    const tentative = clipsForAsset(p, asset, 0, opts.videoTrackId, opts.audioTrackId)
    if (start === undefined) {
      start = tentative.reduce((m, c) => Math.max(m, ...p.clips.filter((x) => x.trackId === c.trackId).map(clipEnd), 0), 0)
    }
    placed = clipsForAsset(p, asset, start, opts.videoTrackId, opts.audioTrackId)
    for (const c of placed) placeWithoutOverlap(p, c)
    p.clips.push(...placed)
  })
  setState({ selection: placed.map((c) => c.id) })
}

const EPS = 1e-6

/** Does [start, end) on `trackId` collide with any clip not in `ignore`? */
export function overlapsOnTrack(p: Project, trackId: string, start: number, end: number, ignore: Set<string> = new Set()): boolean {
  return p.clips.some((c) => c.trackId === trackId && !ignore.has(c.id) && c.start < end - EPS && clipEnd(c) > start + EPS)
}

/**
 * No-overwrite placement rule: a clip never sits on top of another clip on the same track.
 * If `clip` collides on its track, it moves to the nearest same-kind track that is free for its
 * time range (video searches upward, audio downward). If none is free, a new track is created
 * (video on top of the stack, audio at the bottom) and the clip goes there.
 * Mutates `p` (may add a track) and `clip.trackId`.
 */
export function placeWithoutOverlap(p: Project, clip: Clip, ignore: Set<string> = new Set()): void {
  const self = new Set(ignore).add(clip.id)
  const end = clipEnd(clip)
  if (!overlapsOnTrack(p, clip.trackId, clip.start, end, self)) return
  const track = p.tracks.find((t) => t.id === clip.trackId)
  if (!track) return
  const kind = track.kind
  const same = p.tracks.filter((t) => t.kind === kind)
  const idx = same.findIndex((t) => t.id === track.id)
  // video tracks are stored top→bottom, so "upward" is towards index 0; audio grows downward
  const order = kind === 'video' ? same.slice(0, idx).reverse() : same.slice(idx + 1)
  const free = order.find((t) => !t.locked && !overlapsOnTrack(p, t.id, clip.start, end, self))
  if (free) {
    clip.trackId = free.id
    return
  }
  const t = newTrack(kind, nextTrackName(p, kind))
  if (kind === 'video') p.tracks.unshift(t)
  else p.tracks.push(t)
  clip.trackId = t.id
}

/** Fix projects saved with overlapping clips: later clips move to a free/new track. Returns how many moved. */
export function repairOverlaps(p: Project): number {
  let moved = 0
  const pending = new Set(p.clips.map((c) => c.id))
  for (const c of [...p.clips].sort((a, b) => a.start - b.start)) {
    pending.delete(c.id)
    const before = c.trackId
    placeWithoutOverlap(p, c, pending)
    if (c.trackId !== before) moved++
  }
  return moved
}

export function linkedIds(p: Project, ids: string[]): string[] {
  const set = new Set(ids)
  const links = new Set(p.clips.filter((c) => set.has(c.id) && c.linkId).map((c) => c.linkId!))
  for (const c of p.clips) if (c.linkId && links.has(c.linkId)) set.add(c.id)
  return [...set]
}

export function deleteSelection(ripple = false) {
  const ids = linkedIds(state.project, state.selection)
  if (!ids.length) return
  commit(ids.length > 1 ? `Delete ${ids.length} clips` : 'Delete clip', (p) => {
    const removed = p.clips.filter((c) => ids.includes(c.id))
    p.clips = p.clips.filter((c) => !ids.includes(c.id))
    if (ripple) {
      for (const r of removed) {
        for (const c of p.clips) if (c.trackId === r.trackId && c.start >= clipEnd(r) - 1e-6) c.start -= r.duration
      }
    }
  })
  setState({ selection: [] })
}

/** Split selected clips (or every clip under the playhead if nothing is selected) at the playhead. */
export function splitAtPlayhead() {
  const t = state.time
  const p0 = state.project
  let targets = state.selection.length ? linkedIds(p0, state.selection) : p0.clips.map((c) => c.id)
  targets = targets.filter((id) => {
    const c = p0.clips.find((x) => x.id === id)!
    const tr = p0.tracks.find((x) => x.id === c.trackId)
    return !tr?.locked && t > c.start + 1e-3 && t < clipEnd(c) - 1e-3
  })
  if (!targets.length) {
    toast('info', 'Move the playhead over a clip to split it')
    return
  }
  const newLinks = new Map<string, string>()
  const rightIds: string[] = []
  commit('Split', (p) => {
    const added: Clip[] = []
    for (const c of p.clips) {
      if (!targets.includes(c.id)) continue
      const leftDur = t - c.start
      let link: string | undefined
      if (c.linkId) {
        if (!newLinks.has(c.linkId)) newLinks.set(c.linkId, uid('l'))
        link = newLinks.get(c.linkId)
      }
      const right: Clip = {
        ...c,
        id: uid('c'),
        start: t,
        in: c.in + leftDur,
        duration: c.duration - leftDur,
        linkId: link,
        transform: { ...c.transform },
        audio: { ...c.audio, fadeIn: 0 },
        text: c.text ? { ...c.text } : undefined,
      }
      c.duration = leftDur
      c.audio.fadeOut = 0
      // transitions on the clip's END now belong to the right half
      for (const tr of p.transitions ?? []) if (tr.leftId === c.id) tr.leftId = right.id
      if (c.anim) {
        right.anim = { ...c.anim, in: 'none', reveal: 'none' }
        c.anim = { ...c.anim, out: 'none' }
      }
      added.push(right)
      rightIds.push(right.id)
    }
    p.clips.push(...added)
  })
  setState({ selection: rightIds })
}

export function updateClip(id: string, label: string, patch: (c: Clip) => void) {
  commit(label, (p) => {
    const c = p.clips.find((x) => x.id === id)
    if (c) patch(c)
  })
}

export function updateTrack(id: string, label: string, patch: Partial<Track>) {
  commit(label, (p) => {
    const t = p.tracks.find((x) => x.id === id)
    if (t) Object.assign(t, patch)
  })
}

export function addTrack(kind: Track['kind']) {
  commit(`Add ${kind} track`, (p) => {
    const t = newTrack(kind, nextTrackName(p, kind))
    if (kind === 'video') p.tracks.unshift(t)
    else p.tracks.push(t)
  })
}

export function removeTrack(id: string) {
  const p0 = state.project
  const tr = p0.tracks.find((t) => t.id === id)
  if (!tr) return
  if (p0.tracks.filter((t) => t.kind === tr.kind).length <= 1) {
    toast('info', `Keep at least one ${tr.kind} track`)
    return
  }
  commit(`Delete track ${tr.name}`, (p) => {
    p.tracks = p.tracks.filter((t) => t.id !== id)
    p.clips = p.clips.filter((c) => c.trackId !== id)
  })
}

export function addTextClip() {
  const p0 = state.project
  const vt = videoTracks(p0)[0]
  if (!vt) return
  const clip = makeClip('text', vt.id, state.time, 4, {
    text: { content: 'Your title', size: Math.round(p0.height / 10), color: '#ffffff', background: true, bold: true },
    transform: { x: 0, y: Math.round(p0.height * 0.3), scale: 1, opacity: 1 },
  })
  commit('Add text', (p) => {
    placeWithoutOverlap(p, clip)
    p.clips.push(clip)
  })
  setState({ selection: [clip.id], sideTab: 'inspector' })
}

export function setProjectSettings(label: string, patch: Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps' | 'background'>>) {
  commit(label, (p) => Object.assign(p, patch))
}

export function setTime(t: number) {
  const max = Math.max(0, timelineDuration(state.project))
  setState({ time: Math.max(0, Math.min(t, max + 10)) })
}

export function newProject() {
  past.length = 0
  future.length = 0
  setState({ project: defaultProject(), selection: [], selectedAssetId: null, time: 0 })
  syncHistoryLabels()
}

export function replaceProject(p: Project) {
  past.length = 0
  future.length = 0
  setState({ project: p, selection: [], time: 0 })
  syncHistoryLabels()
}

// ------------------------------------------------------------------ reports

export function addReport(r: JobReport, fileUrl?: string) {
  setState((s) => ({
    reports: [r, ...s.reports].slice(0, 300),
    outputs: fileUrl ? { ...s.outputs, [r.id]: fileUrl } : s.outputs,
  }))
}

export function clearReports() {
  for (const url of Object.values(state.outputs)) URL.revokeObjectURL(url)
  setState({ reports: [], outputs: {} })
}

function loadReports(): JobReport[] {
  try {
    const raw = localStorage.getItem('nle.reports')
    return raw ? (JSON.parse(raw) as JobReport[]) : []
  } catch {
    return []
  }
}

function saveReports(r: JobReport[]) {
  try {
    localStorage.setItem('nle.reports', JSON.stringify(r.slice(0, 300)))
  } catch {
    /* storage full or blocked — reports remain in memory */
  }
}

// ------------------------------------------------------------------ autosave (IndexedDB; File objects survive structured clone)

const DB_NAME = 'bunny-nle'
let saveTimer: ReturnType<typeof setTimeout> | null = null
let autosaveEnabled = false

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(key: string, value: unknown) {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB()
  const v = await new Promise<T | undefined>((resolve, reject) => {
    const req = db.transaction('kv').objectStore('kv').get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return v
}

function scheduleAutosave() {
  if (!autosaveEnabled) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    state = { ...state, saveState: 'saving' }
    for (const l of listeners) l()
    try {
      await idbPut('project', state.project)
      state = { ...state, saveState: 'saved', savedAt: Date.now() }
    } catch (err) {
      console.warn('autosave failed', err)
      state = { ...state, saveState: 'error' }
    }
    for (const l of listeners) l()
  }, 700)
}

/** Restore the last project (if any), then enable autosave. */
export async function restoreProject(skip = false): Promise<boolean> {
  try {
    const p = skip ? undefined : await idbGet<Project>('project')
    if (p && Array.isArray(p.clips)) {
      const moved = repairOverlaps(p)
      setState({ project: p, saveState: 'saved', savedAt: Date.now() })
      if (moved) setTimeout(() => toast('info', `Moved ${moved} overlapping clip${moved > 1 ? 's' : ''} to free tracks`), 500)
      autosaveEnabled = true
      return true
    }
  } catch (err) {
    console.warn('restore failed', err)
  }
  autosaveEnabled = true
  return false
}

// ------------------------------------------------------------------ effects: text presets, stickers, adjustment layers, filters, transitions

/** Add a visual overlay clip (text/sticker/adjustment) at `start` on the top video track (or `trackId`), never overwriting. */
function addOverlayClip(label: string, make: (p: Project, trackId: string, start: number) => Clip, opts: { start?: number; trackId?: string } = {}) {
  const p0 = state.project
  const trackId = opts.trackId ?? videoTracks(p0)[0]?.id
  if (!trackId) return
  let clip: Clip | null = null
  commit(label, (p) => {
    clip = make(p, trackId, Math.max(0, opts.start ?? state.time))
    placeWithoutOverlap(p, clip)
    p.clips.push(clip)
  })
  if (clip) setState({ selection: [(clip as Clip).id], selectedTransitionId: null, sideTab: 'inspector' })
}

export function addTextPreset(presetId: string, opts: { start?: number; trackId?: string } = {}) {
  const preset = TEXT_PRESETS.find((x) => x.id === presetId) ?? TEXT_PRESETS[0]
  addOverlayClip(`Add ${preset.label}`, (p, trackId, start) => {
    const m = preset.make(p.width, p.height)
    return makeClip('text', trackId, start, m.duration ?? 4, { text: m.text, transform: m.transform, anim: m.anim })
  }, opts)
}

export function addSticker(sticker: ClipSticker, opts: { start?: number; trackId?: string } = {}) {
  addOverlayClip('Add sticker', (p, trackId, start) =>
    makeClip('sticker', trackId, start, 3, {
      sticker,
      transform: { x: Math.round(p.width * 0.25), y: -Math.round(p.height * 0.2), scale: 1, opacity: 1 },
      anim: { ...defaultAnim(), in: 'pop', inDur: 0.4, out: 'pop', outDur: 0.3 },
    }),
  opts)
}

export function addAdjustmentLayer(presetId = 'cinematic', opts: { start?: number; trackId?: string } = {}) {
  addOverlayClip('Add adjustment layer', (_p, trackId, start) => makeClip('adjustment', trackId, start, 5, { filter: defaultFilter(presetId) }), opts)
}

/** Apply a filter preset to visual clips (keeps manual slider values). */
export function applyFilterPreset(clipIds: string[], presetId: string) {
  const ids = clipIds.filter((id) => {
    const c = state.project.clips.find((x) => x.id === id)
    return c && c.kind !== 'audio'
  })
  if (!ids.length) {
    toast('info', 'Select a video, image, text or sticker clip first (or drop the filter onto a clip)')
    return false
  }
  commit(presetId === 'none' ? 'Remove filter' : 'Apply filter', (p) => {
    for (const c of p.clips) if (ids.includes(c.id)) c.filter = { ...(c.filter ?? defaultFilter()), preset: presetId, intensity: c.filter?.intensity ?? 100 }
  })
  return true
}

/** Add (or replace) a transition on a cut (left+right) or a lone clip edge. */
export function addTransition(trackId: string, leftId: string | undefined, rightId: string | undefined, type: TransitionType, duration = 0.5) {
  if (!leftId && !rightId) return
  const id = uid('tr')
  commit(`Add ${transitionLabel(type)}`, (p) => {
    p.transitions = (p.transitions ?? []).filter((t) => !(t.trackId === trackId && t.leftId === leftId && t.rightId === rightId))
    // an edge transition and a cut transition can't share the same clip edge
    p.transitions = p.transitions.filter((t) => !((leftId && t.leftId === leftId) || (rightId && t.rightId === rightId)))
    p.transitions.push({ id, trackId, leftId, rightId, type, duration, easing: 'ease-in-out' })
  })
  if ((state.project.transitions ?? []).some((t) => t.id === id)) setState({ selectedTransitionId: id, selection: [], sideTab: 'inspector' })
}

export function updateTransition(id: string, label: string, patch: Partial<Transition>) {
  commit(label, (p) => {
    const t = (p.transitions ?? []).find((x) => x.id === id)
    if (t) Object.assign(t, patch)
  })
}

export function deleteTransition(id: string) {
  commit('Delete transition', (p) => {
    p.transitions = (p.transitions ?? []).filter((t) => t.id !== id)
  })
  setState({ selectedTransitionId: null })
}

/**
 * Where a transition dropped/clicked near time `t` on a track should go:
 * the nearest cut between touching clips, else the nearest lone clip edge.
 */
export function transitionTargetAt(p: Project, trackId: string, t: number, maxDist: number): { leftId?: string; rightId?: string; at: number } | null {
  const clips = p.clips.filter((c) => c.trackId === trackId && c.kind !== 'audio').sort((a, b) => a.start - b.start)
  let best: { leftId?: string; rightId?: string; at: number; d: number } | null = null
  const consider = (cand: { leftId?: string; rightId?: string; at: number }) => {
    const d = Math.abs(cand.at - t)
    if (d <= maxDist && (!best || d < best.d)) best = { ...cand, d }
  }
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    const prev = clips.find((x) => Math.abs(clipEnd(x) - c.start) < 0.02 && x.id !== c.id)
    const next = clips.find((x) => Math.abs(x.start - clipEnd(c)) < 0.02 && x.id !== c.id)
    if (prev) consider({ leftId: prev.id, rightId: c.id, at: c.start })
    else consider({ rightId: c.id, at: c.start })
    if (!next) consider({ leftId: c.id, at: clipEnd(c) })
  }
  if (!best) return null
  const { d: _d, ...rest } = best as { leftId?: string; rightId?: string; at: number; d: number }
  return rest
}

// ------------------------------------------------------------------ clipboard (copy / cut / paste / duplicate / paste attributes)

interface ClipboardData {
  clips: Clip[]
  /** Transitions entirely between copied clips (re-linked on paste). */
  transitions: Transition[]
  /** Earliest start, so paste keeps relative timing. */
  origin: number
}
let clipboard: ClipboardData | null = null

export function hasClipboard() {
  return !!clipboard?.clips.length
}

export function copySelection(cut = false): boolean {
  const p = state.project
  const ids = linkedIds(p, state.selection)
  const clips = p.clips.filter((c) => ids.includes(c.id))
  if (!clips.length) {
    toast('info', 'Select clips to copy')
    return false
  }
  const set = new Set(ids)
  clipboard = {
    clips: clips.map(cloneClip),
    transitions: (p.transitions ?? []).filter((t) => (!t.leftId || set.has(t.leftId)) && (!t.rightId || set.has(t.rightId))).map((t) => ({ ...t })),
    origin: Math.min(...clips.map((c) => c.start)),
  }
  if (cut) deleteSelection(false)
  toast('info', `${cut ? 'Cut' : 'Copied'} ${clips.length} clip${clips.length > 1 ? 's' : ''}`)
  return true
}

/** Paste at `at` (default: playhead). Clips keep their tracks and relative timing; collisions go to free/new tracks. */
export function pasteClipboard(at = state.time) {
  if (!clipboard?.clips.length) {
    toast('info', 'Nothing to paste. Copy clips with ⌘C first')
    return
  }
  const cb = clipboard
  const idMap = new Map<string, string>()
  const linkMap = new Map<string, string>()
  let pasted: string[] = []
  commit(`Paste ${cb.clips.length} clip${cb.clips.length > 1 ? 's' : ''}`, (p) => {
    const trackIds = new Set(p.tracks.map((t) => t.id))
    const newClips: Clip[] = []
    for (const c of cb.clips) {
      const n = cloneClip(c)
      n.id = uid('c')
      idMap.set(c.id, n.id)
      if (c.linkId) {
        if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('l'))
        n.linkId = linkMap.get(c.linkId)
      }
      n.start = Math.max(0, at + (c.start - cb.origin))
      // the original track may have been deleted since copying
      if (!trackIds.has(n.trackId)) {
        const kind = c.kind === 'audio' ? 'audio' : 'video'
        n.trackId = (kind === 'video' ? baseVideoTrack(p) : p.tracks.find((t) => t.kind === 'audio'))?.id ?? n.trackId
      }
      newClips.push(n)
    }
    // keep pasted A/V pairs together: settle video first, then audio
    const pending = new Set(newClips.map((c) => c.id))
    for (const n of [...newClips].sort((a, b) => (a.kind === 'audio' ? 1 : 0) - (b.kind === 'audio' ? 1 : 0) || a.start - b.start)) {
      pending.delete(n.id)
      p.clips.push(n)
      placeWithoutOverlap(p, n, pending)
    }
    p.transitions = [
      ...(p.transitions ?? []),
      ...cb.transitions.map((t) => ({ ...t, id: uid('tr'), leftId: t.leftId && idMap.get(t.leftId), rightId: t.rightId && idMap.get(t.rightId), trackId: (idMap.get(t.leftId ?? '') || idMap.get(t.rightId ?? '')) ? (p.clips.find((c) => c.id === (idMap.get(t.leftId ?? '') ?? idMap.get(t.rightId ?? '')))?.trackId ?? t.trackId) : t.trackId })),
    ]
    pasted = newClips.map((c) => c.id)
  })
  setState({ selection: pasted, selectedTransitionId: null })
}

/** ⌘D: copy + paste right after the selection's end, without touching the clipboard. */
export function duplicateSelection() {
  const saved = clipboard
  const p = state.project
  const ids = linkedIds(p, state.selection)
  const clips = p.clips.filter((c) => ids.includes(c.id))
  if (!clips.length) return toast('info', 'Select clips to duplicate')
  if (copySilently()) pasteClipboard(Math.max(...clips.map(clipEnd)))
  clipboard = saved
}

function copySilently(): boolean {
  const p = state.project
  const ids = linkedIds(p, state.selection)
  const clips = p.clips.filter((c) => ids.includes(c.id))
  if (!clips.length) return false
  const set = new Set(ids)
  clipboard = {
    clips: clips.map(cloneClip),
    transitions: (p.transitions ?? []).filter((t) => (!t.leftId || set.has(t.leftId)) && (!t.rightId || set.has(t.rightId))).map((t) => ({ ...t })),
    origin: Math.min(...clips.map((c) => c.start)),
  }
  return true
}

/** ⌥⌘V: apply the first copied clip's filter, animation and transform to the selected clips. */
export function pasteAttributes() {
  const src = clipboard?.clips.find((c) => c.kind !== 'audio') ?? clipboard?.clips[0]
  if (!src) return toast('info', 'Copy a clip first (⌘C), then select clips and press ⌥⌘V')
  const ids = state.selection
  if (!ids.length) return toast('info', 'Select the clips to paste attributes onto')
  commit('Paste attributes', (p) => {
    for (const c of p.clips) {
      if (!ids.includes(c.id)) continue
      if (c.kind === 'audio' || src.kind === 'audio') {
        if (c.kind === 'audio' && src.kind === 'audio') c.audio = { ...src.audio }
        continue
      }
      c.filter = src.filter ? { ...src.filter } : undefined
      c.anim = src.anim ? { ...src.anim } : undefined
      c.transform = { ...src.transform }
      c.rotation = src.rotation
    }
  })
  toast('info', 'Pasted filter, animation and transform')
}

// ------------------------------------------------------------------ effect stack

function visualIds(ids: string[]): string[] {
  return ids.filter((id) => {
    const c = state.project.clips.find((x) => x.id === id)
    return c && c.kind !== 'audio'
  })
}

/** Add a video effect to clips (top of the stack = applied last). */
export function addEffect(clipIds: string[], type: string): boolean {
  const ids = visualIds(clipIds)
  const def = effectDef(type)
  if (!def) return false
  if (!ids.length) {
    toast('info', 'Select a clip first (or drop the effect onto a clip)')
    return false
  }
  commit(`Add ${def.label}`, (p) => {
    for (const c of p.clips) if (ids.includes(c.id)) c.effects = [...(c.effects ?? []), newEffect(type)]
  })
  return true
}

export function updateEffect(clipId: string, effectId: string, label: string, patch: (e: EffectInstance) => void) {
  commit(label, (p) => {
    const e = p.clips.find((c) => c.id === clipId)?.effects?.find((x) => x.id === effectId)
    if (e) patch(e)
  })
}

export function removeEffect(clipId: string, effectId: string) {
  commit('Remove effect', (p) => {
    const c = p.clips.find((x) => x.id === clipId)
    if (c?.effects) c.effects = c.effects.filter((e) => e.id !== effectId)
  })
}

export function moveEffect(clipId: string, effectId: string, dir: -1 | 1) {
  commit('Reorder effects', (p) => {
    const list = p.clips.find((x) => x.id === clipId)?.effects
    if (!list) return
    const i = list.findIndex((e) => e.id === effectId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
  })
}

/** Text effect on text clips; with no text selected, adds a new title using it. */
export function applyTextFx(clipIds: string[], fx: TextFx | 'gradient' | 'trail') {
  const ids = clipIds.filter((id) => state.project.clips.find((c) => c.id === id)?.kind === 'text')
  if (!ids.length) {
    addTextPreset(fx === 'neon-flicker' ? 'neon' : 'title')
    const created = state.selection
    if (!created.length) return
    return applyTextFx(created, fx)
  }
  commit('Text effect', (p) => {
    for (const c of p.clips) {
      if (!ids.includes(c.id) || !c.text) continue
      if (fx === 'gradient') c.text.gradient = { on: true, c1: '#ff4dd8', c2: '#5b8cff', c3: '#38f9d7', angle: 0, animate: true }
      else if (fx === 'trail') {
        if (!c.effects?.some((e) => e.type === 'trail')) c.effects = [...(c.effects ?? []), newEffect('trail')]
        if (!c.anim || c.anim.loop === 'none') c.anim = { ...(c.anim ?? defaultAnim()), loop: 'float', loopSpeed: 1.6 }
      } else {
        c.text.fx = fx
        c.text.fxDur = c.text.fxDur ?? 1
        if (fx === 'neon-flicker') c.text.glow = true
      }
    }
  })
}
