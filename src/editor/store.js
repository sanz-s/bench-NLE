import { useSyncExternalStore } from 'react'
import { clipEnd, resolveTransitions, timelineDuration } from '../media/compositor'
import { TEXT_PRESETS } from '../media/effects/text'
import { defaultFilter } from '../media/effects/filters'
import { defaultAnim } from '../media/effects/animations'
import { effectDef, newEffect } from '../media/effects/fx/videoEffects'
import { transitionLabel } from '../media/effects/transitions'
import { baseVideoTrack, clipsForAsset, defaultProject, makeClip, newTrack, nextTrackName, uid, videoTracks } from './model'

// ------------------------------------------------------------------ state

let state = {
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

const listeners = new Set()

export function getState() {
  return state
}

export function setState(patch) {
  const p = typeof patch === 'function' ? patch(state) : patch
  const prevProject = state.project
  state = { ...state, ...p }
  if (state.project !== prevProject) scheduleAutosave()
  if ('reports' in p) saveReports(state.reports)
  for (const l of listeners) l()
}

export function subscribe(l) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useStore(selector) {
  return useSyncExternalStore(subscribe, () => selector(state))
}

// ------------------------------------------------------------------ history (undo/redo)

const past = []
const future = []
const MAX_HISTORY = 200
let gestureBase = null
let gestureLockWarned = false

/**
 * History entries hold whole project snapshots plus the explicit asset changes of that step (`delta`).
 * Assets are NOT restored from snapshots: imports are not undoable edits, so undo/redo keeps the current
 * asset list and only re-applies (or reverts) the asset additions/removals the step itself made.
 */
function pushHistory(before, label, delta = NO_DELTA) {
  past.push({ project: before, label, delta })
  if (past.length > MAX_HISTORY) past.shift()
  future.length = 0
}
const NO_DELTA = { added: [], removed: [] }

function assetDelta(before, after) {
  const b = new Set(before.assets.map((a) => a.id))
  const a = new Set(after.assets.map((x) => x.id))
  const added = after.assets.filter((x) => !b.has(x.id))
  const removed = before.assets.map((x, index) => ({ asset: x, index })).filter((r) => !a.has(r.asset.id))
  return added.length || removed.length ? { added, removed } : NO_DELTA
}

/** Current assets with a step undone: its additions removed, its removals restored at their old index. */
function assetsUndone(cur, d) {
  const addedIds = new Set(d.added.map((a) => a.id))
  const out = cur.filter((a) => !addedIds.has(a.id))
  for (const { asset, index } of d.removed) if (!out.some((a) => a.id === asset.id)) out.splice(Math.min(index, out.length), 0, asset)
  return out
}
/** Current assets with a step redone. */
function assetsRedone(cur, d) {
  const removedIds = new Set(d.removed.map((r) => r.asset.id))
  const out = cur.filter((a) => !removedIds.has(a.id))
  for (const a of d.added) if (!out.some((x) => x.id === a.id)) out.push(a)
  return out
}

function syncHistoryLabels() {
  setState({ undoLabel: past.at(-1)?.label ?? null, redoLabel: future.at(-1)?.label ?? null })
}

/** Content equality for history purposes (assets compared by id; File objects aren't serializable). */
function sameProject(a, b) {
  if (a === b) return true
  const key = (p) => JSON.stringify({ ...p, assets: p.assets.map((x) => x.id) })
  return key(a) === key(b)
}

/**
 * Apply an undoable change. The recipe gets a deep copy it may mutate. Returns true if the project changed.
 * Clips on locked tracks are protected (see enforceLocks); a recipe that changes nothing adds no undo entry.
 */
export function commit(label, recipe) {
  // An open gesture (e.g. a drag whose release was lost) must not revert this commit later: settle it first.
  if (gestureBase) endGesture('Edit')
  const before = state.project
  const draft = cloneProject(before)
  recipe(draft)
  const blocked = finishDraft(before, draft)
  if (blocked) lockToast(blocked)
  if (sameProject(before, draft)) return false
  pushHistory(before, label, assetDelta(before, draft))
  setState({ project: draft })
  syncHistoryLabels()
  return true
}

/** Post-recipe invariants shared by commits and gestures. Returns how many locked items were protected. */
function finishDraft(before, draft) {
  retargetTransitions(draft)
  cleanLinks(draft, lockedTrackIds(before))
  const blocked = enforceLocks(before, draft)
  pruneTransitions(draft)
  return blocked
}

/** Gestures (drags) update the project live and commit once at the end. */
export function beginGesture() {
  if (gestureBase) endGesture('Edit')
  gestureBase = state.project
  gestureLockWarned = false
}
export function updateGesture(recipe) {
  if (!gestureBase) beginGesture()
  const draft = cloneProject(gestureBase)
  // assets added while the gesture runs (an import finishing mid-drag, a thumbnail) must survive
  draft.assets = state.project.assets.slice()
  recipe(draft)
  const blocked = finishDraft(gestureBase, draft)
  if (blocked && !gestureLockWarned) {
    gestureLockWarned = true
    lockToast(blocked)
  }
  setState({ project: draft })
}
export function endGesture(label) {
  const base = gestureBase
  gestureBase = null
  if (!base || base === state.project) return
  if (sameProject(base, state.project)) return
  // gestures never add/remove assets themselves: any asset difference came from imports and is not undoable
  pushHistory(base, label || 'Edit')
  syncHistoryLabels()
}
export function cancelGesture() {
  if (gestureBase) setState({ project: { ...gestureBase, assets: state.project.assets } })
  gestureBase = null
}

/** Is a gesture open? (test hook / diagnostics) */
export function gestureOpen() {
  return !!gestureBase
}

const keepSelection = (project) => state.selection.filter((id) => project.clips.some((c) => c.id === id))

export function undo() {
  if (gestureBase) endGesture('Edit')
  const e = past.pop()
  if (!e) return
  const cur = state.project
  future.push({ project: cur, label: e.label, delta: e.delta })
  const project = { ...e.project, assets: assetsUndone(cur.assets, e.delta) }
  setState({ project, selection: keepSelection(project) })
  syncHistoryLabels()
  toast('info', `Undo: ${e.label}`)
}

export function redo() {
  if (gestureBase) endGesture('Edit')
  const e = future.pop()
  if (!e) return
  const cur = state.project
  past.push({ project: cur, label: e.label, delta: e.delta })
  const project = { ...e.project, assets: assetsRedone(cur.assets, e.delta) }
  setState({ project, selection: keepSelection(project) })
  syncHistoryLabels()
  toast('info', `Redo: ${e.label}`)
}

/** Assets hold File objects (immutable) — share them; deep-copy everything else. */
function cloneProject(p) {
  return {
    ...p,
    assets: p.assets.slice(),
    tracks: p.tracks.map((t) => ({ ...t })),
    clips: p.clips.map(cloneClip),
    transitions: (p.transitions ?? []).map((t) => ({ ...t })),
  }
}

function cloneClip(c) {
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

/** Drop transitions whose clips were deleted, moved apart or split across tracks. Returns true if any removed. */
function pruneTransitions(p) {
  const list = p.transitions ?? []
  if (!list.length) return false
  const valid = new Set(resolveTransitions(p).map((r) => r.tr.id))
  const kept = list.filter((t) => valid.has(t.id))
  if (kept.length === list.length) return false
  p.transitions = kept
  if (state.selectedTransitionId && !valid.has(state.selectedTransitionId)) setTimeout(() => setState({ selectedTransitionId: null }))
  return true
}

/** A transition follows its clips: when they all moved to another track, so does the transition. */
function retargetTransitions(p) {
  if (!p.transitions?.length) return
  const byId = new Map(p.clips.map((c) => [c.id, c]))
  for (const tr of p.transitions) {
    const a = tr.leftId ? byId.get(tr.leftId) : null
    const b = tr.rightId ? byId.get(tr.rightId) : null
    if (a && b && a.trackId !== b.trackId) continue
    const track = a?.trackId ?? b?.trackId
    if (track && track !== tr.trackId) tr.trackId = track
  }
}

/** Remove linkIds that no longer link anything (partner deleted, its track removed, …). Locked clips are left alone. */
function cleanLinks(p, locked) {
  const count = new Map()
  for (const c of p.clips) if (c.linkId) count.set(c.linkId, (count.get(c.linkId) ?? 0) + 1)
  for (const c of p.clips) if (c.linkId && count.get(c.linkId) === 1 && !locked.has(c.trackId)) delete c.linkId
}

// ------------------------------------------------------------------ track locks

/**
 * Lock semantics: a clip on a locked track can't be changed — not moved, trimmed, split, deleted, cut,
 * edited in the Inspector, given attributes/effects/filters, or have its transitions changed — and no clip
 * can be placed onto a locked track. Hiding/muting/unlocking the track itself stays possible.
 */
export function lockedTrackIds(p) {
  return new Set(p.tracks.filter((t) => t.locked).map((t) => t.id))
}

export function isClipLocked(p, idOrClip) {
  const c = typeof idOrClip === 'string' ? p.clips.find((x) => x.id === idOrClip) : idOrClip
  return !!c && !!p.tracks.find((t) => t.id === c.trackId)?.locked
}

function lockToast(n) {
  toast('info', `Track is locked: ${n} item${n > 1 ? 's' : ''} left unchanged. Unlock the track to edit.`)
}

/**
 * Safety net run after every recipe: clips (and transitions touching them) that were on a locked track in
 * `before` are restored exactly; clips that newly landed on a locked track are moved to a free track.
 * Returns how many items it had to protect.
 */
function enforceLocks(before, draft) {
  const locked = lockedTrackIds(before)
  if (!locked.size) return 0
  const orig = new Map(before.clips.filter((c) => locked.has(c.trackId)).map((c) => [c.id, c]))
  let fixed = 0
  const seen = new Set()
  draft.clips = draft.clips.map((c) => {
    const o = orig.get(c.id)
    if (!o) return c
    seen.add(c.id)
    if (JSON.stringify(o) === JSON.stringify(c)) return c
    fixed++
    return cloneClip(o)
  })
  for (const [id, o] of orig) {
    if (seen.has(id)) continue
    draft.clips.push(cloneClip(o))
    fixed++
  }
  // clips moved/pasted/placed onto a locked track go to a free track instead
  for (const c of draft.clips) {
    if (orig.has(c.id) || !locked.has(c.trackId)) continue
    const was = before.clips.find((x) => x.id === c.id)
    if (was && was.trackId === c.trackId) continue
    placeWithoutOverlap(draft, c)
    fixed++
  }
  // transitions touching a locked clip are part of it
  const touches = (t) => orig.has(t.leftId) || orig.has(t.rightId)
  const beforeTr = new Map((before.transitions ?? []).filter(touches).map((t) => [t.id, t]))
  const list = (draft.transitions ?? []).filter((t) => {
    if (!touches(t) || beforeTr.has(t.id)) return true
    fixed++
    return false
  })
  const kept = new Set(list.map((t) => t.id))
  draft.transitions = list.map((t) => {
    const o = beforeTr.get(t.id)
    // trackId is derived from the clips (retargetTransitions), so it isn't an edit of the locked transition
    if (!o || JSON.stringify({ ...o, trackId: 0 }) === JSON.stringify({ ...t, trackId: 0 })) return t
    fixed++
    return { ...o }
  })
  for (const [id, o] of beforeTr) {
    if (kept.has(id)) continue
    draft.transitions.push({ ...o })
    fixed++
  }
  return fixed
}

// ------------------------------------------------------------------ toasts

export function toast(kind, text, action, ms = 3500) {
  const id = uid('toast')
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, action }] }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
}

// ------------------------------------------------------------------ actions

export function addAsset(asset) {
  // Assets live in the project but adding one is not an undoable edit (undo/redo keep the current asset list).
  setState((s) => ({ project: { ...s.project, assets: [...s.project.assets, asset] } }))
}

/** Non-undoable asset metadata update (e.g. a thumbnail that finished after import). */
export function patchAsset(id, patch) {
  setState((s) => ({ project: { ...s.project, assets: s.project.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)) } }))
}

export function removeAsset(id) {
  const p0 = state.project
  if (p0.clips.some((c) => c.assetId === id && isClipLocked(p0, c))) {
    toast('info', 'This media is used on a locked track. Unlock the track to remove it')
    return
  }
  commit('Remove media', (p) => {
    p.assets = p.assets.filter((a) => a.id !== id)
    p.clips = p.clips.filter((c) => c.assetId !== id)
  })
}

/** Append an asset at the end of the base tracks (or at `start` on given tracks). */
export function placeAsset(assetId, opts = {}) {
  const asset = state.project.assets.find((a) => a.id === assetId)
  if (!asset) return
  let placed = []
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
export function overlapsOnTrack(p, trackId, start, end, ignore = new Set()) {
  return p.clips.some((c) => c.trackId === trackId && !ignore.has(c.id) && c.start < end - EPS && clipEnd(c) > start + EPS)
}

/**
 * No-overwrite placement rule: a clip never sits on top of another clip on the same track.
 * If `clip` collides on its track, it moves to the nearest same-kind track that is free for its
 * time range (video searches upward, audio downward). If none is free, a new track is created
 * (video on top of the stack, audio at the bottom) and the clip goes there.
 * A locked track counts as occupied (unless `avoidLocked` is false, as when repairing a saved project).
 * Mutates `p` (may add a track) and `clip.trackId`.
 */
export function placeWithoutOverlap(p, clip, ignore = new Set(), avoidLocked = true) {
  const self = new Set(ignore).add(clip.id)
  const end = clipEnd(clip)
  const track = p.tracks.find((t) => t.id === clip.trackId)
  const blocked = avoidLocked && !!track?.locked
  if (!blocked && !overlapsOnTrack(p, clip.trackId, clip.start, end, self)) return
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
export function repairOverlaps(p) {
  let moved = 0
  const pending = new Set(p.clips.map((c) => c.id))
  for (const c of [...p.clips].sort((a, b) => a.start - b.start)) {
    pending.delete(c.id)
    const before = c.trackId
    placeWithoutOverlap(p, c, pending, false)
    if (c.trackId !== before) moved++
  }
  return moved
}

export function linkedIds(p, ids) {
  const set = new Set(ids)
  const links = new Set(p.clips.filter((c) => set.has(c.id) && c.linkId).map((c) => c.linkId))
  for (const c of p.clips) if (c.linkId && links.has(c.linkId)) set.add(c.id)
  return [...set]
}

/** Expand `ids` to linked partners and split them into editable and locked ones. */
function editableIds(p, ids) {
  const all = linkedIds(p, ids)
  const editable = all.filter((id) => !isClipLocked(p, id))
  return { all, editable, locked: all.length - editable.length }
}

export function deleteSelection(ripple = false) {
  const p0 = state.project
  const { all, editable: ids, locked } = editableIds(p0, state.selection)
  if (!all.length) return
  if (!ids.length) {
    toast('info', 'Clip is on a locked track. Unlock the track to delete it')
    return
  }
  const del = new Set(ids)
  commit(ids.length > 1 ? `Delete ${ids.length} clips` : 'Delete clip', (p) => {
    const removed = p.clips.filter((c) => del.has(c.id))
    p.clips = p.clips.filter((c) => !del.has(c.id))
    if (ripple) {
      // Close every gap at once, from the ORIGINAL positions: a clip moves left by the total length of the
      // removed clips on its track that ended before it (independent of selection order).
      for (const c of p.clips) {
        let shift = 0
        for (const r of removed) if (r.trackId === c.trackId && clipEnd(r) <= c.start + 1e-6) shift += r.duration
        if (shift) c.start = Math.max(0, c.start - shift)
      }
    }
  })
  if (locked) toast('info', `${locked} clip${locked > 1 ? 's' : ''} on locked tracks kept`)
  setState({ selection: state.selection.filter((id) => !del.has(id) && state.project.clips.some((c) => c.id === id)) })
}

/** Split selected clips (or every clip under the playhead if nothing is selected) at the playhead. */
export function splitAtPlayhead() {
  const t = state.time
  const p0 = state.project
  let targets = state.selection.length ? linkedIds(p0, state.selection) : p0.clips.map((c) => c.id)
  targets = targets.filter((id) => {
    const c = p0.clips.find((x) => x.id === id)
    const tr = p0.tracks.find((x) => x.id === c.trackId)
    return !tr?.locked && t > c.start + 1e-3 && t < clipEnd(c) - 1e-3
  })
  if (!targets.length) {
    toast('info', 'Move the playhead over a clip to split it')
    return
  }
  const newLinks = new Map()
  const rightIds = []
  commit('Split', (p) => {
    const added = []
    for (const c of p.clips) {
      if (!targets.includes(c.id)) continue
      const leftDur = t - c.start
      let link
      if (c.linkId) {
        if (!newLinks.has(c.linkId)) newLinks.set(c.linkId, uid('l'))
        link = newLinks.get(c.linkId)
      }
      // Both halves keep the original clip's animation clock: `phase` = seconds into the original clip at
      // this half's start, `span` = the original length. Clip-local animation (loops, Ken Burns, shake,
      // text fx, reveals) then continues across the cut instead of restarting (see clipLocal in compositor).
      const phase = c.phase ?? 0
      const span = c.span ?? phase + c.duration
      const right = {
        ...cloneClip(c),
        id: uid('c'),
        start: t,
        in: c.in + leftDur,
        duration: c.duration - leftDur,
        linkId: link,
        phase: phase + leftDur,
        span,
        audio: { ...c.audio, fadeIn: 0 },
      }
      c.duration = leftDur
      c.phase = phase
      c.span = span
      c.audio.fadeOut = 0
      // transitions on the clip's END now belong to the right half
      for (const tr of p.transitions ?? []) if (tr.leftId === c.id) tr.leftId = right.id
      if (c.anim) {
        // entry animation only on the left half, exit only on the right; reveal continues via the phase
        right.anim = { ...c.anim, in: 'none' }
        c.anim = { ...c.anim, out: 'none' }
      }
      added.push(right)
      rightIds.push(right.id)
    }
    p.clips.push(...added)
  })
  setState({ selection: rightIds })
}

export function updateClip(id, label, patch) {
  if (isClipLocked(state.project, id)) {
    toast('info', 'Track is locked. Unlock it to edit this clip')
    return
  }
  commit(label, (p) => {
    const c = p.clips.find((x) => x.id === id)
    if (c) patch(c)
  })
}

export function updateTrack(id, label, patch) {
  commit(label, (p) => {
    const t = p.tracks.find((x) => x.id === id)
    if (t) Object.assign(t, patch)
  })
}

export function addTrack(kind) {
  commit(`Add ${kind} track`, (p) => {
    const t = newTrack(kind, nextTrackName(p, kind))
    if (kind === 'video') p.tracks.unshift(t)
    else p.tracks.push(t)
  })
}

export function removeTrack(id) {
  const p0 = state.project
  const tr = p0.tracks.find((t) => t.id === id)
  if (!tr) return
  if (p0.tracks.filter((t) => t.kind === tr.kind).length <= 1) {
    toast('info', `Keep at least one ${tr.kind} track`)
    return
  }
  if (tr.locked) {
    toast('info', `Track ${tr.name} is locked. Unlock it to delete it`)
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

export function setProjectSettings(label, patch) {
  commit(label, (p) => Object.assign(p, patch))
}

export function setTime(t) {
  const max = Math.max(0, timelineDuration(state.project))
  setState({ time: Math.max(0, Math.min(t, max + 10)) })
}

export function newProject() {
  past.length = 0
  future.length = 0
  setState({ project: defaultProject(), selection: [], selectedAssetId: null, time: 0 })
  syncHistoryLabels()
}

export function replaceProject(p) {
  past.length = 0
  future.length = 0
  setState({ project: p, selection: [], time: 0 })
  syncHistoryLabels()
}

// ------------------------------------------------------------------ reports

/** Exported files kept in memory (Blob URLs) for download. Older ones are released so they don't inflate later jobs' memory numbers. */
export const MAX_OUTPUTS = 10
const MAX_REPORTS = 300

export function addReport(r, fileUrl) {
  const reports = [r, ...state.reports].slice(0, MAX_REPORTS)
  const live = new Set(reports.map((x) => x.id))
  // keys keep insertion order (oldest first); report ids are never integer-like
  const entries = Object.entries(fileUrl ? { ...state.outputs, [r.id]: fileUrl } : state.outputs)
  const kept = entries.filter(([id]) => live.has(id)).slice(-MAX_OUTPUTS)
  const keptIds = new Set(kept.map(([id]) => id))
  for (const [id, url] of entries) if (!keptIds.has(id)) URL.revokeObjectURL(url)
  setState({ reports, outputs: Object.fromEntries(kept) })
}

export function clearReports() {
  for (const url of Object.values(state.outputs)) URL.revokeObjectURL(url)
  setState({ reports: [], outputs: {} })
}

function loadReports() {
  try {
    const raw = localStorage.getItem('nle.reports')
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveReports(r) {
  try {
    localStorage.setItem('nle.reports', JSON.stringify(r.slice(0, 300)))
  } catch {
    /* storage full or blocked — reports remain in memory */
  }
}

// ------------------------------------------------------------------ autosave (IndexedDB; File objects survive structured clone)

const DB_NAME = 'bunny-nle'
let saveTimer = null
let autosaveEnabled = false

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(key, value) {
  const db = await openDB()
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
  } finally {
    db.close()
  }
}

async function idbGet(key) {
  const db = await openDB()
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
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
export async function restoreProject(skip = false) {
  try {
    const p = skip ? undefined : await idbGet('project')
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
function addOverlayClip(label, make, opts = {}) {
  const p0 = state.project
  const trackId = opts.trackId ?? videoTracks(p0)[0]?.id
  if (!trackId) return
  let clip = null
  commit(label, (p) => {
    clip = make(p, trackId, Math.max(0, opts.start ?? state.time))
    placeWithoutOverlap(p, clip)
    p.clips.push(clip)
  })
  if (clip) setState({ selection: [clip.id], selectedTransitionId: null, sideTab: 'inspector' })
}

export function addTextPreset(presetId, opts = {}) {
  const preset = TEXT_PRESETS.find((x) => x.id === presetId) ?? TEXT_PRESETS[0]
  addOverlayClip(
    `Add ${preset.label}`,
    (p, trackId, start) => {
      const m = preset.make(p.width, p.height)
      return makeClip('text', trackId, start, m.duration ?? 4, { text: m.text, transform: m.transform, anim: m.anim })
    },
    opts,
  )
}

export function addSticker(sticker, opts = {}) {
  addOverlayClip(
    'Add sticker',
    (p, trackId, start) =>
      makeClip('sticker', trackId, start, 3, {
        sticker,
        transform: { x: Math.round(p.width * 0.25), y: -Math.round(p.height * 0.2), scale: 1, opacity: 1 },
        anim: { ...defaultAnim(), in: 'pop', inDur: 0.4, out: 'pop', outDur: 0.3 },
      }),
    opts,
  )
}

export function addAdjustmentLayer(presetId = 'cinematic', opts = {}) {
  addOverlayClip('Add adjustment layer', (_p, trackId, start) => makeClip('adjustment', trackId, start, 5, { filter: defaultFilter(presetId) }), opts)
}

/** Apply a filter preset to visual clips (keeps manual slider values). */
export function applyFilterPreset(clipIds, presetId) {
  const anyVisual = clipIds.some((id) => state.project.clips.find((x) => x.id === id && x.kind !== 'audio'))
  const ids = visualIds(clipIds)
  if (!ids.length) {
    if (!anyVisual) toast('info', 'Select a video, image, text or sticker clip first (or drop the filter onto a clip)')
    return false
  }
  commit(presetId === 'none' ? 'Remove filter' : 'Apply filter', (p) => {
    for (const c of p.clips) if (ids.includes(c.id)) c.filter = { ...(c.filter ?? defaultFilter()), preset: presetId, intensity: c.filter?.intensity ?? 100 }
  })
  return true
}

/** Add (or replace) a transition on a cut (left+right) or a lone clip edge. */
function transitionLocked(p, leftId, rightId) {
  if ((leftId && isClipLocked(p, leftId)) || (rightId && isClipLocked(p, rightId))) {
    toast('info', 'Track is locked. Unlock it to change transitions')
    return true
  }
  return false
}

export function addTransition(trackId, leftId, rightId, type, duration = 0.5) {
  if (!leftId && !rightId) return
  if (transitionLocked(state.project, leftId, rightId)) return
  const id = uid('tr')
  commit(`Add ${transitionLabel(type)}`, (p) => {
    p.transitions = (p.transitions ?? []).filter((t) => !(t.trackId === trackId && t.leftId === leftId && t.rightId === rightId))
    // an edge transition and a cut transition can't share the same clip edge
    p.transitions = p.transitions.filter((t) => !((leftId && t.leftId === leftId) || (rightId && t.rightId === rightId)))
    p.transitions.push({ id, trackId, leftId, rightId, type, duration, easing: 'ease-in-out' })
  })
  if ((state.project.transitions ?? []).some((t) => t.id === id)) setState({ selectedTransitionId: id, selection: [], sideTab: 'inspector' })
}

export function updateTransition(id, label, patch) {
  const t0 = (state.project.transitions ?? []).find((x) => x.id === id)
  if (t0 && transitionLocked(state.project, t0.leftId, t0.rightId)) return
  commit(label, (p) => {
    const t = (p.transitions ?? []).find((x) => x.id === id)
    if (t) Object.assign(t, patch)
  })
}

export function deleteTransition(id) {
  const t0 = (state.project.transitions ?? []).find((x) => x.id === id)
  if (t0 && transitionLocked(state.project, t0.leftId, t0.rightId)) return
  commit('Delete transition', (p) => {
    p.transitions = (p.transitions ?? []).filter((t) => t.id !== id)
  })
  setState({ selectedTransitionId: null })
}

/**
 * Where a transition dropped/clicked near time `t` on a track should go:
 * the nearest cut between touching clips, else the nearest lone clip edge.
 */
export function transitionTargetAt(p, trackId, t, maxDist) {
  const clips = p.clips.filter((c) => c.trackId === trackId && c.kind !== 'audio').sort((a, b) => a.start - b.start)
  let best = null
  const consider = (cand) => {
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
  const { d: _d, ...rest } = best
  return rest
}

// ------------------------------------------------------------------ clipboard (copy / cut / paste / duplicate / paste attributes)

let clipboard = null

export function hasClipboard() {
  return !!clipboard?.clips.length
}

export function copySelection(cut = false) {
  const p = state.project
  const exp = editableIds(p, state.selection)
  // cutting removes clips, so locked ones are neither copied nor removed
  const ids = cut ? exp.editable : exp.all
  const clips = p.clips.filter((c) => ids.includes(c.id))
  if (!clips.length) {
    toast('info', cut && exp.all.length ? 'Clip is on a locked track. Unlock the track to cut it' : 'Select clips to copy')
    return false
  }
  const set = new Set(ids)
  clipboard = {
    clips: clips.map(cloneClip),
    transitions: (p.transitions ?? []).filter((t) => (!t.leftId || set.has(t.leftId)) && (!t.rightId || set.has(t.rightId))).map((t) => ({ ...t })),
    origin: Math.min(...clips.map((c) => c.start)),
  }
  if (cut) {
    const del = new Set(ids)
    commit(clips.length > 1 ? `Cut ${clips.length} clips` : 'Cut clip', (d) => {
      d.clips = d.clips.filter((c) => !del.has(c.id))
    })
    setState({ selection: state.selection.filter((id) => !del.has(id) && state.project.clips.some((c) => c.id === id)) })
  }
  const skipped = cut ? exp.locked : 0
  toast('info', `${cut ? 'Cut' : 'Copied'} ${clips.length} clip${clips.length > 1 ? 's' : ''}${skipped ? ` (${skipped} on locked tracks kept)` : ''}`)
  return true
}

/** Paste at `at` (default: playhead). Clips keep their tracks and relative timing; collisions go to free/new tracks. */
export function pasteClipboard(at = state.time) {
  if (!clipboard?.clips.length) {
    toast('info', 'Nothing to paste. Copy clips with ⌘C first')
    return
  }
  const cb = clipboard
  const idMap = new Map()
  const linkMap = new Map()
  let pasted = []
  commit(`Paste ${cb.clips.length} clip${cb.clips.length > 1 ? 's' : ''}`, (p) => {
    const trackIds = new Set(p.tracks.map((t) => t.id))
    const newClips = []
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
      ...cb.transitions.map((t) => ({
        ...t,
        id: uid('tr'),
        leftId: t.leftId && idMap.get(t.leftId),
        rightId: t.rightId && idMap.get(t.rightId),
        trackId:
          idMap.get(t.leftId ?? '') || idMap.get(t.rightId ?? '')
            ? (p.clips.find((c) => c.id === (idMap.get(t.leftId ?? '') ?? idMap.get(t.rightId ?? '')))?.trackId ?? t.trackId)
            : t.trackId,
      })),
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

function copySilently() {
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
  if (!state.selection.length) return toast('info', 'Select the clips to paste attributes onto')
  const ids = state.selection.filter((id) => !isClipLocked(state.project, id))
  if (!ids.length) return toast('info', 'Track is locked. Unlock it to paste attributes')
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

/** Visual clips among `ids` that may be edited (locked ones are dropped, with a toast if that leaves none). */
function visualIds(ids) {
  const visual = ids.filter((id) => {
    const c = state.project.clips.find((x) => x.id === id)
    return c && c.kind !== 'audio'
  })
  const out = visual.filter((id) => !isClipLocked(state.project, id))
  if (visual.length && !out.length) toast('info', 'Track is locked. Unlock it to edit this clip')
  return out
}

/** Add a video effect to clips (top of the stack = applied last). */
export function addEffect(clipIds, type) {
  const ids = visualIds(clipIds)
  const def = effectDef(type)
  if (!def) return false
  if (!ids.length) {
    if (!clipIds.some((id) => state.project.clips.find((x) => x.id === id && x.kind !== 'audio')))
      toast('info', 'Select a clip first (or drop the effect onto a clip)')
    return false
  }
  commit(`Add ${def.label}`, (p) => {
    for (const c of p.clips) if (ids.includes(c.id)) c.effects = [...(c.effects ?? []), newEffect(type)]
  })
  return true
}

export function updateEffect(clipId, effectId, label, patch) {
  if (!visualIds([clipId]).length) return
  commit(label, (p) => {
    const e = p.clips.find((c) => c.id === clipId)?.effects?.find((x) => x.id === effectId)
    if (e) patch(e)
  })
}

export function removeEffect(clipId, effectId) {
  if (!visualIds([clipId]).length) return
  commit('Remove effect', (p) => {
    const c = p.clips.find((x) => x.id === clipId)
    if (c?.effects) c.effects = c.effects.filter((e) => e.id !== effectId)
  })
}

export function moveEffect(clipId, effectId, dir) {
  if (!visualIds([clipId]).length) return
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
export function applyTextFx(clipIds, fx) {
  const texts = clipIds.filter((id) => state.project.clips.find((c) => c.id === id)?.kind === 'text')
  const ids = texts.filter((id) => !isClipLocked(state.project, id))
  if (texts.length && !ids.length) return toast('info', 'Track is locked. Unlock it to edit this title')
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
