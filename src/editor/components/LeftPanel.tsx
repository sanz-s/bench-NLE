import { useState } from 'react'
import { drawFrame } from '../../media/compositor'
import { defaultFilter, FILTER_PRESETS } from '../../media/effects/filters'
import { drawSticker, EMOJIS, stickerBaseSize, STICKERS, type StickerCat } from '../../media/effects/stickers'
import { TEXT_FX, TEXT_PRESETS } from '../../media/effects/text'
import { TRANSITION_CATS, TRANSITIONS, type TransitionCat } from '../../media/effects/transitions'
import { EFFECTS, FX_CATEGORIES, newEffect, type FxCategory } from '../../media/effects/fx/videoEffects'
import { defaultAnim } from '../../media/effects/animations'
import type { ClipSticker, TextFx, TransitionType } from '../../media/types'
import { makeClip } from '../model'
import { addAdjustmentLayer, addEffect, addSticker, addTextPreset, addTransition, applyFilterPreset, applyTextFx, getState, setState, toast, transitionTargetAt, useStore } from '../store'
import { MediaBin } from './MediaBin'
import { Thumb } from './Thumb'
import { miniProject, renderTransitionThumb, sampleFrame, THUMB_H, THUMB_W } from './fxThumbs'
import { EFFECT_MIME, dragState, type EffectPayload } from './dragState'
import { Icon } from './ui'

type Tab = 'media' | 'text' | 'stickers' | 'transitions' | 'filters'
const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'media', label: 'Media', icon: 'film' },
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'stickers', label: 'Stickers', icon: 'sparkles' },
  { id: 'transitions', label: 'Transitions', icon: 'convert' },
  { id: 'filters', label: 'Effects', icon: 'image' },
]

export function LeftPanel() {
  const tab = useStore((s) => s.leftTab)
  return (
    <aside className="panel left" aria-label="Library">
      <div className="left-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setState({ leftTab: t.id })} title={t.label}>
            <Icon name={t.icon} size={15} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      {tab === 'media' && <MediaBin />}
      {tab === 'text' && <TextGallery />}
      {tab === 'stickers' && <StickerGallery />}
      {tab === 'transitions' && <TransitionGallery />}
      {tab === 'filters' && <FilterGallery />}
    </aside>
  )
}

// ------------------------------------------------------------------ thumbnails rendered by the real compositor

function Card(props: { label: string; hint?: string; payload: EffectPayload; onApply: () => void; render: (ctx: CanvasRenderingContext2D, w: number, h: number, phase: number) => void; animate?: boolean; wide?: boolean; restPhase?: number }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      className={`fx-card${props.wide ? ' wide' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(EFFECT_MIME, JSON.stringify(props.payload))
        e.dataTransfer.effectAllowed = 'copy'
        dragState.effect = props.payload
      }}
      onDragEnd={() => (dragState.effect = null)}
      onClick={props.onApply}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      title={`${props.label}${props.hint ? `: ${props.hint}` : ''}\nClick to apply · drag onto the timeline`}
    >
      <Thumb render={props.render} animate={props.animate} hovered={hovered} restPhase={props.restPhase} />
      <span className="fx-label">{props.label}</span>
    </button>
  )
}

// ------------------------------------------------------------------ text

function TextGallery() {
  return (
    <div className="gallery">
      <p className="gallery-hint">Click to add at the playhead, or drag onto a track. Text goes on a free track above your video.</p>
      <div className="fx-grid">
        {TEXT_PRESETS.map((p) => (
          <Card
            key={p.id}
            label={p.label}
            payload={{ kind: 'text', presetId: p.id }}
            onApply={() => addTextPreset(p.id)}
            animate
            render={(ctx, w, _h, phase) => {
              const m = p.make(THUMB_W, THUMB_H)
              const clip = makeClip('text', 'T', 0, 3, { text: m.text, transform: { ...m.transform, x: m.transform.x * 0.6, y: m.transform.y * 0.4 }, anim: m.anim })
              drawFrame(ctx, miniProject([clip]), phase < 0.5 && phase !== 0.5 ? phase * 4 : 2.2, new Map(), w / THUMB_W)
            }}
          />
        ))}
      </div>
      <h3 className="gallery-h">Text effects</h3>
      <p className="gallery-hint">Click to apply to the selected text (or to a new title), or drag onto a text clip.</p>
      <div className="fx-grid">
        {[...TEXT_FX.filter((f) => f.id !== 'none'), { id: 'gradient', label: 'Gradient Text' }, { id: 'trail', label: 'Motion Trail' }].map((f) => (
          <Card
            key={f.id}
            label={f.label}
            payload={{ kind: 'textfx', fx: f.id as TextFx | 'gradient' | 'trail' }}
            onApply={() => applyTextFx(getState().selection, f.id as TextFx | 'gradient' | 'trail')}
            animate
            restPhase={0.24}
            render={(ctx, w, _h, phase) => {
              const isGrad = f.id === 'gradient'
              const isTrail = f.id === 'trail'
              const clip = makeClip('text', 'T', 0, 4, {
                text: {
                  content: f.id === 'kinetic' ? 'MOVE\nFAST' : 'Text FX',
                  size: 230,
                  color: f.id === 'neon-flicker' ? '#ff4dd8' : '#ffffff',
                  background: false,
                  bold: true,
                  weight: 800,
                  fx: isGrad || isTrail ? 'none' : (f.id as TextFx),
                  fxDur: 1,
                  glow: f.id === 'neon-flicker',
                  gradient: isGrad ? { on: true, c1: '#ff4dd8', c2: '#5b8cff', c3: '#38f9d7', angle: 0, animate: true } : undefined,
                },
                anim: isTrail ? { ...defaultAnim(), loop: 'float', loopSpeed: 3 } : undefined,
                effects: isTrail ? [{ ...newEffect('trail'), params: { count: 6, spacing: 45, fade: 70 } }] : undefined,
              })
              drawFrame(ctx, miniProject([clip]), 0.05 + phase * 2.2, new Map(), w / THUMB_W)
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ stickers

const measureText = (font: string, text: string) => {
  const c = document.createElement('canvas').getContext('2d')!
  c.font = font
  return c.measureText(text).width
}

function stickerRender(st: ClipSticker) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const sz = stickerBaseSize(st, 100, measureText)
    const k = Math.min((w * 0.78) / sz.w, (h * 0.72) / sz.h)
    ctx.save()
    ctx.translate(w / 2, h / 2)
    drawSticker(ctx, st, sz.w * k, sz.h * k)
    ctx.restore()
  }
}

function StickerGallery() {
  const [cat, setCat] = useState<StickerCat>('shapes')
  const cats: Array<[StickerCat, string]> = [
    ['shapes', 'Shapes'],
    ['arrows', 'Arrows'],
    ['badges', 'Badges'],
    ['emoji', 'Emoji'],
  ]
  return (
    <div className="gallery">
      <div className="seg seg-small" role="radiogroup" aria-label="Sticker category">
        {cats.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={cat === id} className={cat === id ? 'on' : ''} onClick={() => setCat(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="fx-grid stickers">
        {cat === 'emoji'
          ? EMOJIS.map((e) => {
              const st: ClipSticker = { id: 'emoji', emoji: e, color: '#ffffff', color2: '#ffffff' }
              return <Card key={e} label={e} payload={{ kind: 'sticker', sticker: st }} onApply={() => addSticker(st)} render={stickerRender(st)} />
            })
          : STICKERS.filter((s) => s.cat === cat).map((d) => {
              const st: ClipSticker = { id: d.id, color: d.color, color2: d.kind === 'badge' ? d.fg : '#ffffff' }
              return <Card key={d.id} label={d.label} payload={{ kind: 'sticker', sticker: st }} onApply={() => addSticker(st)} render={stickerRender(st)} wide={d.kind === 'badge'} />
            })}
      </div>
      <p className="gallery-hint">Your own PNG/WebP images work as stickers too: import them in Media and place them on an upper track.</p>
    </div>
  )
}

// ------------------------------------------------------------------ transitions

/** Click-to-apply: use the selected clip's end cut (or start), else the cut nearest the playhead. */
function applyTransitionSmart(type: TransitionType) {
  const st = getState()
  const p = st.project
  const sel = p.clips.find((c) => st.selection.includes(c.id) && c.kind !== 'audio')
  const tracks = sel ? [sel.trackId] : p.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  let best: { trackId: string; leftId?: string; rightId?: string; at: number } | null = null
  for (const trackId of tracks) {
    const target = sel
      ? transitionTargetAt(p, trackId, sel.start + sel.duration, 0.05) ?? transitionTargetAt(p, trackId, sel.start, 0.05)
      : transitionTargetAt(p, trackId, st.time, Infinity)
    if (target && (!best || Math.abs(target.at - st.time) < Math.abs(best.at - st.time))) best = { trackId, ...target }
  }
  if (!best) {
    toast('info', 'Add a clip to the timeline first, then drop the transition on a cut')
    return
  }
  addTransition(best.trackId, best.leftId, best.rightId, type)
}

function TransitionGallery() {
  const [cat, setCat] = useState<TransitionCat>('cinematic')
  return (
    <div className="gallery">
      <div className="seg seg-small seg-wrap" role="radiogroup" aria-label="Transition category">
        {TRANSITION_CATS.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={cat === c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <p className="gallery-hint">Drag onto a cut between two clips (or a clip's start/end). Click applies to the selected clip's end, or the cut nearest the playhead. Hover to preview.</p>
      <div className="fx-grid">
        {TRANSITIONS.filter((t) => t.cat === cat).map((t) => (
          <Card
            key={t.id}
            label={t.label}
            payload={{ kind: 'transition', type: t.id }}
            onApply={() => applyTransitionSmart(t.id)}
            animate
            restPhase={0.42}
            render={(ctx, w, _h, phase) => renderTransitionThumb(ctx, w, t.id, phase)}
          />
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ filters

/** What an effect thumbnail shows: the sample photo, or a sticker for effects that need transparency/motion. */
function effectThumb(type: string, phase: number, ctx: CanvasRenderingContext2D, w: number) {
  const onSticker = type === 'outline-glow' || type === 'trail' || type === 'neon-glow'
  const clip = onSticker
    ? makeClip('sticker', 'T', 0, 5, {
        id: 'S',
        sticker: { id: 'star', color: '#ffc83d', color2: '#ffffff' },
        transform: { x: 0, y: 0, scale: 2.4, opacity: 1 },
        anim: type === 'trail' ? { ...defaultAnim(), loop: 'float', loopSpeed: 3 } : undefined,
        effects: [newEffect(type)],
      })
    : makeClip('image', 'T', 0, 5, { id: 'S', assetId: 'S', effects: [newEffect(type)] })
  drawFrame(ctx, miniProject([clip]), 0.2 + phase * 4.5, new Map([['S', sampleFrame('scene')]]), w / THUMB_W)
}

function FilterGallery() {
  const selection = useStore((s) => s.selection)
  const clips = useStore((s) => s.project.clips)
  const sel = clips.filter((c) => selection.includes(c.id) && c.kind !== 'audio')
  const [cat, setCat] = useState<FxCategory | 'filters' | 'adjust'>('cinematic')
  const cats: Array<[FxCategory | 'filters' | 'adjust', string]> = [...FX_CATEGORIES.map((c) => [c.id, c.label.replace('Modern / ', '')] as [FxCategory, string]), ['filters', 'Filters'], ['adjust', 'Adjustment']]
  return (
    <div className="gallery">
      <div className="seg seg-small seg-wrap" role="radiogroup" aria-label="Effect category">
        {cats.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={cat === id} className={cat === id ? 'on' : ''} onClick={() => setCat(id)}>
            {label}
          </button>
        ))}
      </div>
      {cat !== 'filters' && cat !== 'adjust' && (
        <>
          <p className="gallery-hint">
            {sel.length ? `Click to add to ${sel.length} selected clip${sel.length > 1 ? 's' : ''}` : 'Select a clip, then click an effect, or drag an effect onto a clip'}. Effects stack. Tune or reorder them in the Inspector.
          </p>
          <div className="fx-grid">
            {EFFECTS.filter((e) => e.cat === cat).map((e) => (
              <Card
                key={e.id}
                label={e.label}
                payload={{ kind: 'effect', type: e.id }}
                onApply={() => addEffect(getState().selection, e.id)}
                animate
                render={(ctx, w, _h, phase) => effectThumb(e.id, phase, ctx, w)}
              />
            ))}
          </div>
        </>
      )}
      {cat === 'filters' && <>
      <p className="gallery-hint">
        {sel.length ? `Click to apply to ${sel.length} selected clip${sel.length > 1 ? 's' : ''}` : 'Select a clip, then click a filter, or drag a filter onto a clip'}. Fine-tune in the Inspector.
      </p>
      <div className="fx-grid">
        {FILTER_PRESETS.map((f) => (
          <Card
            key={f.id}
            label={f.label}
            payload={{ kind: 'filter', presetId: f.id }}
            onApply={() => applyFilterPreset(getState().selection, f.id)}
            render={(ctx, w) => {
              const clip = makeClip('image', 'T', 0, 5, { id: 'S', assetId: 'S', filter: defaultFilter(f.id) })
              drawFrame(ctx, miniProject([clip]), 1, new Map([['S', sampleFrame('scene')]]), w / THUMB_W)
            }}
          />
        ))}
      </div>
      </>}
      {cat === 'adjust' && <>
      <h3 className="gallery-h">Adjustment layer</h3>
      <p className="gallery-hint">Applies a filter to everything below it for its duration.</p>
      <div className="fx-grid">
        {['cinematic', 'bw', 'vintage', 'warm'].map((id) => (
          <Card
            key={id}
            label={`${FILTER_PRESETS.find((f) => f.id === id)?.label} layer`}
            payload={{ kind: 'adjustment', presetId: id }}
            onApply={() => addAdjustmentLayer(id)}
            render={(ctx, w) => {
              const img = makeClip('image', 'T', 0, 5, { id: 'S', assetId: 'S' })
              const adj = makeClip('adjustment', 'T', 0, 5, { filter: defaultFilter(id) })
              const proj = miniProject([img, adj], { tracks: [{ id: 'T2', kind: 'video', name: 'V2', muted: false, hidden: false, locked: false }, { id: 'T', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false }] })
              proj.clips[1] = { ...adj, trackId: 'T2' }
              drawFrame(ctx, proj, 1, new Map([['S', sampleFrame('scene')]]), w / THUMB_W)
            }}
          />
        ))}
      </div>
      </>}
    </div>
  )
}
