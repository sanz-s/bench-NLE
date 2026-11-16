import type { ReactNode } from 'react'
import type { AnimIn, AnimLoop, Clip, ClipAnim, ClipFilter, ClipText, EffectInstance, Easing, Project, TextAlign, TextFx, TextReveal, TransitionType } from '../../media/types'
import { clipEnd, resolveTransitions } from '../../media/compositor'
import { ANIM_IN, ANIM_LOOP, ANIM_OUT, defaultAnim, TEXT_REVEALS } from '../../media/effects/animations'
import { defaultFilter, FILTER_PRESETS } from '../../media/effects/filters'
import { EMOJIS, stickerDef } from '../../media/effects/stickers'
import { FONTS, TEXT_FX, textStyle } from '../../media/effects/text'
import { EFFECTS, FX_CATEGORIES, effectDef, paramsOf, type ParamDef } from '../../media/effects/fx/videoEffects'
import { TRANSITIONS, transitionLabel } from '../../media/effects/transitions'
import {
  addEffect,
  addTransition,
  moveEffect,
  removeEffect,
  updateEffect,
  beginGesture,
  deleteTransition,
  endGesture,
  setProjectSettings,
  updateClip,
  updateGesture,
  updateTransition,
  useStore,
} from '../store'
import { formatDuration } from '../model'
import { IconButton, NumberField, Section } from './ui'

const RES_PRESETS: Array<[string, number, number]> = [
  ['1080p 16:9', 1920, 1080],
  ['720p 16:9', 1280, 720],
  ['4K UHD', 3840, 2160],
  ['Vertical 9:16', 1080, 1920],
  ['Square 1:1', 1080, 1080],
]

/** Live while dragging (gesture), one undo step when released or typed. */
function useClipEditor(clip: Clip) {
  return (label: string, apply: (c: Clip, v: number) => void) => (v: number, final: boolean) => {
    updateGesture((p) => {
      const c = p.clips.find((x) => x.id === clip.id)
      if (c) apply(c, v)
    })
    if (final) endGesture(label)
  }
}

// ------------------------------------------------------------------ small field components

function Row({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field-row">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

function SelectRow<T extends string | number>(props: { label: string; value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void }) {
  const id = `sel-${props.label.replace(/\W+/g, '-')}`
  return (
    <Row label={props.label} htmlFor={id}>
      <select id={id} className="grow" value={String(props.value)} onChange={(e) => props.onChange((typeof props.value === 'number' ? Number(e.target.value) : e.target.value) as T)}>
        {props.options.map((o) => (
          <option key={String(o.id)} value={String(o.id)}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  )
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = `col-${label.replace(/\W+/g, '-')}`
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'
  return (
    <Row label={label} htmlFor={id}>
      <input id={id} type="color" value={hex} onChange={(e) => onChange(e.target.value)} />
      <span className="mono small muted">{hex}</span>
    </Row>
  )
}

function Checks({ items }: { items: Array<{ label: string; checked: boolean; onChange: (v: boolean) => void }> }) {
  return (
    <div className="check-row">
      {items.map((it) => (
        <label key={it.label} className="check">
          <input type="checkbox" checked={it.checked} onChange={(e) => it.onChange(e.target.checked)} />
          {it.label}
        </label>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ inspector root

export function Inspector() {
  const selection = useStore((s) => s.selection)
  const project = useStore((s) => s.project)
  const trId = useStore((s) => s.selectedTransitionId)
  const tr = trId ? resolveTransitions(project).find((r) => r.tr.id === trId) : undefined
  if (tr) return <TransitionInspector id={tr.tr.id} type={tr.tr.type} duration={tr.tr.duration} easing={tr.tr.easing} kind={tr.a && tr.b ? 'cut' : tr.b ? 'in' : 'out'} maxDur={tr.a && tr.b ? Math.min(tr.a.duration, tr.b.duration) : (tr.a ?? tr.b)!.duration} />
  const clips = project.clips.filter((c) => selection.includes(c.id))
  if (clips.length === 1) return <ClipInspector clip={clips[0]} project={project} />
  if (clips.length > 1)
    return (
      <div className="inspector">
        <p className="muted pad">{clips.length} clips selected. Select one clip to edit its properties. Filters from the library apply to all selected clips.</p>
      </div>
    )
  return <ProjectInspector project={project} />
}

// ------------------------------------------------------------------ clip

function ClipInspector({ clip, project }: { clip: Clip; project: Project }) {
  const edit = useClipEditor(clip)
  const asset = project.assets.find((a) => a.id === clip.assetId)
  const visual = clip.kind !== 'audio'
  const transformable = visual && clip.kind !== 'adjustment'
  const title =
    clip.kind === 'text'
      ? clip.text?.content.split('\n')[0]
      : clip.kind === 'sticker'
        ? clip.sticker?.id === 'emoji'
          ? `${clip.sticker.emoji} emoji`
          : stickerDef(clip.sticker!)?.label
        : clip.kind === 'adjustment'
          ? 'Adjustment layer'
          : asset?.name ?? 'Clip'
  return (
    <div className="inspector">
      <div className="inspector-title">
        <span className={`kind-chip kind-${clip.kind}`}>{clip.kind}</span>
        <strong title={title}>{title}</strong>
      </div>
      <Section title="Timing">
        <dl className="kv">
          <dt>Start</dt>
          <dd>{formatDuration(clip.start)}</dd>
          <dt>Duration</dt>
          <dd>{formatDuration(clip.duration)}</dd>
          {(clip.kind === 'video' || clip.kind === 'audio') && (
            <>
              <dt>Source in</dt>
              <dd>{formatDuration(clip.in)}</dd>
            </>
          )}
        </dl>
      </Section>
      {clip.kind === 'text' && clip.text && <TextSection clip={clip} project={project} />}
      {clip.kind === 'sticker' && clip.sticker && <StickerSection clip={clip} />}
      {transformable && (
        <Section title="Transform">
          <NumberField label="X" value={clip.transform.x} defaultValue={0} suffix="px" onChange={edit('Position X', (c, v) => (c.transform.x = Math.round(v)))} />
          <NumberField label="Y" value={clip.transform.y} defaultValue={0} suffix="px" onChange={edit('Position Y', (c, v) => (c.transform.y = Math.round(v)))} />
          <NumberField label="Scale" value={clip.transform.scale} displayScale={100} min={0.01} max={10} defaultValue={1} suffix="%" onChange={edit('Scale', (c, v) => (c.transform.scale = v))} />
          <NumberField label="Rotation" value={clip.rotation ?? 0} min={-360} max={360} defaultValue={0} suffix="°" onChange={edit('Rotation', (c, v) => (c.rotation = Math.round(v * 10) / 10))} />
          <NumberField label="Opacity" value={clip.transform.opacity} displayScale={100} min={0} max={1} defaultValue={1} suffix="%" onChange={edit('Opacity', (c, v) => (c.transform.opacity = v))} />
        </Section>
      )}
      {clip.kind === 'adjustment' && (
        <Section title="Layer">
          <NumberField label="Opacity" value={clip.transform.opacity} displayScale={100} min={0} max={1} defaultValue={1} suffix="%" onChange={edit('Opacity', (c, v) => (c.transform.opacity = v))} />
          <p className="small muted">Filters everything on the tracks below while it plays.</p>
        </Section>
      )}
      {visual && <EffectsSection clip={clip} />}
      {visual && <FilterSection clip={clip} />}
      {transformable && <AnimationSection clip={clip} />}
      {visual && <ClipTransitionsSection clip={clip} project={project} />}
      {clip.kind === 'audio' && (
        <Section title="Audio">
          <NumberField
            label="Gain"
            value={clip.audio.gain > 0 ? 20 * Math.log10(clip.audio.gain) : -60}
            min={-60}
            max={12}
            step={0.5}
            precision={1}
            defaultValue={0}
            suffix="dB"
            onChange={(v, final) => edit('Gain', (c, db) => (c.audio.gain = db <= -60 ? 0 : 10 ** (db / 20)))(v, final)}
          />
          <NumberField label="Fade in" value={clip.audio.fadeIn} min={0} max={clip.duration} step={0.05} precision={2} defaultValue={0} suffix="s" onChange={edit('Fade in', (c, v) => (c.audio.fadeIn = v))} />
          <NumberField label="Fade out" value={clip.audio.fadeOut} min={0} max={clip.duration} step={0.05} precision={2} defaultValue={0} suffix="s" onChange={edit('Fade out', (c, v) => (c.audio.fadeOut = v))} />
        </Section>
      )}
    </div>
  )
}

function TextSection({ clip, project }: { clip: Clip; project: Project }) {
  const t = clip.text!
  const st = textStyle(t)
  const edit = useClipEditor(clip)
  const set = (label: string, patch: Partial<ClipText>) => updateClip(clip.id, label, (c) => Object.assign(c.text!, patch))
  return (
    <>
      <Section title="Text">
        <textarea
          className="text-input"
          value={t.content}
          rows={3}
          aria-label="Text content"
          onFocus={() => beginGesture()}
          onChange={(e) => {
            const v = e.target.value
            updateGesture((p) => {
              const c = p.clips.find((x) => x.id === clip.id)
              if (c?.text) c.text.content = v
            })
          }}
          onBlur={() => endGesture('Edit text')}
        />
        <SelectRow label="Font" value={t.font ?? 'system'} options={FONTS.map((f) => ({ id: f.id, label: f.label }))} onChange={(v) => set('Font', { font: v })} />
        <SelectRow
          label="Weight"
          value={st.weight}
          options={[300, 400, 500, 600, 700, 800, 900].map((w) => ({ id: w, label: { 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Heavy', 900: 'Black' }[w] ?? String(w) }))}
          onChange={(v) => set('Weight', { weight: v, bold: v >= 700 })}
        />
        <NumberField label="Size" value={t.size} min={6} max={1000} defaultValue={Math.round(project.height / 10)} suffix="px" onChange={edit('Text size', (c, v) => (c.text!.size = Math.round(v)))} />
        <ColorRow label="Color" value={t.color} onChange={(v) => set('Text color', { color: v })} />
        <Row label="Align">
          <div className="seg seg-small" role="radiogroup" aria-label="Text alignment">
            {(['left', 'center', 'right'] as TextAlign[]).map((a) => (
              <button key={a} type="button" role="radio" aria-checked={st.align === a} className={st.align === a ? 'on' : ''} onClick={() => set('Align text', { align: a })}>
                {a === 'left' ? '⟸' : a === 'center' ? '≡' : '⟹'}
              </button>
            ))}
          </div>
        </Row>
        <NumberField label="Spacing" value={t.letterSpacing ?? 0} min={-20} max={80} defaultValue={0} suffix="px" onChange={edit('Letter spacing', (c, v) => (c.text!.letterSpacing = Math.round(v)))} />
        <NumberField label="Line height" value={t.lineHeight ?? 1.2} min={0.7} max={3} step={0.05} precision={2} defaultValue={1.2} suffix="×" onChange={edit('Line height', (c, v) => (c.text!.lineHeight = v))} />
        <Checks
          items={[
            { label: 'Shadow', checked: st.shadow, onChange: (v) => set('Text shadow', { shadow: v }) },
            { label: 'Glow', checked: st.glow, onChange: (v) => set('Text glow', { glow: v }) },
            { label: 'Italic', checked: st.italic, onChange: (v) => set('Italic', { italic: v }) },
            { label: 'CAPS', checked: st.uppercase, onChange: (v) => set('Uppercase', { uppercase: v }) },
          ]}
        />
      </Section>
      <Section title="Text effect">
        <SelectRow<TextFx> label="Effect" value={t.fx ?? 'none'} options={TEXT_FX} onChange={(v) => set('Text effect', { fx: v, fxDur: t.fxDur ?? 1, glow: v === 'neon-flicker' ? true : t.glow })} />
        {(t.fx ?? 'none') !== 'none' && t.fx !== 'glitch' && t.fx !== 'neon-flicker' && (
          <NumberField label="Intro length" value={t.fxDur ?? 1} min={0.1} max={10} step={0.1} precision={1} defaultValue={1} suffix="s" onChange={edit('Effect length', (c, v) => (c.text!.fxDur = Math.round(v * 10) / 10))} />
        )}
        <Checks items={[{ label: 'Gradient fill', checked: !!t.gradient?.on, onChange: (v) => set('Gradient text', { gradient: { c1: '#ff4dd8', c2: '#5b8cff', c3: '#38f9d7', angle: 0, animate: true, ...t.gradient, on: v } }) }]} />
        {t.gradient?.on && (
          <>
            <ColorRow label="Color 1" value={t.gradient.c1} onChange={(v) => set('Gradient color', { gradient: { ...t.gradient!, c1: v } })} />
            <ColorRow label="Color 2" value={t.gradient.c2} onChange={(v) => set('Gradient color', { gradient: { ...t.gradient!, c2: v } })} />
            <ColorRow label="Color 3" value={t.gradient.c3 ?? '#ffffff'} onChange={(v) => set('Gradient color', { gradient: { ...t.gradient!, c3: v } })} />
            <NumberField label="Angle" value={t.gradient.angle} min={-180} max={180} defaultValue={0} suffix="°" onChange={edit('Gradient angle', (c, v) => (c.text!.gradient = { ...c.text!.gradient!, angle: Math.round(v) }))} />
            <Checks items={[{ label: 'Animate colors', checked: t.gradient.animate, onChange: (v) => set('Gradient animation', { gradient: { ...t.gradient!, animate: v } }) }]} />
          </>
        )}
        <p className="small muted">Motion Trail is in Effects (works on any clip).</p>
      </Section>
      <Section title="Outline & box">
        <NumberField label="Outline" value={t.outlineWidth ?? 0} min={0} max={40} defaultValue={0} suffix="px" onChange={edit('Outline width', (c, v) => (c.text!.outlineWidth = Math.round(v)))} />
        {(t.outlineWidth ?? 0) > 0 && <ColorRow label="Outline color" value={st.outlineColor} onChange={(v) => set('Outline color', { outlineColor: v })} />}
        <Checks items={[{ label: 'Background box', checked: st.background, onChange: (v) => set('Text background', { background: v }) }]} />
        {st.background && (
          <>
            <ColorRow label="Box color" value={st.bgColor} onChange={(v) => set('Box color', { bgColor: v })} />
            <NumberField label="Box opacity" value={st.bgOpacity} displayScale={100} min={0} max={1} defaultValue={0.6} suffix="%" onChange={edit('Box opacity', (c, v) => (c.text!.bgOpacity = v))} />
            <NumberField label="Rounding" value={st.bgRadius} displayScale={100} min={0} max={1} defaultValue={0.25} suffix="%" onChange={edit('Box rounding', (c, v) => (c.text!.bgRadius = v))} />
          </>
        )}
      </Section>
    </>
  )
}

function StickerSection({ clip }: { clip: Clip }) {
  const s = clip.sticker!
  const def = stickerDef(s)
  const set = (label: string, patch: Partial<NonNullable<Clip['sticker']>>) => updateClip(clip.id, label, (c) => Object.assign(c.sticker!, patch))
  return (
    <Section title="Sticker">
      {s.id === 'emoji' ? (
        <div className="emoji-pick" role="listbox" aria-label="Emoji">
          {EMOJIS.map((e) => (
            <button key={e} type="button" className={e === s.emoji ? 'on' : ''} onClick={() => set('Change emoji', { emoji: e })} aria-label={e}>
              {e}
            </button>
          ))}
        </div>
      ) : (
        <>
          <ColorRow label={def?.kind === 'badge' ? 'Badge color' : 'Fill'} value={s.color} onChange={(v) => set('Sticker color', { color: v })} />
          <ColorRow label={def?.kind === 'badge' ? 'Text color' : 'Outline'} value={s.color2} onChange={(v) => set('Sticker outline', { color2: v })} />
        </>
      )}
    </Section>
  )
}

function ParamControl({ clip, inst, def }: { clip: Clip; inst: EffectInstance; def: ParamDef }) {
  const p = paramsOf(inst)
  if (def.type === 'number') {
    return (
      <NumberField
        label={def.label}
        value={Number(p[def.key])}
        min={def.min}
        max={def.max}
        step={def.step ?? (def.max - def.min > 20 ? 1 : 0.1)}
        precision={def.step && def.step < 1 ? 1 : 0}
        defaultValue={def.def}
        suffix={def.unit}
        onChange={(v, final) => {
          updateGesture((pr) => {
            const e = pr.clips.find((c) => c.id === clip.id)?.effects?.find((x) => x.id === inst.id)
            if (e) e.params = { ...e.params, [def.key]: v }
          })
          if (final) endGesture(def.label)
        }}
      />
    )
  }
  if (def.type === 'color') return <ColorRow label={def.label} value={String(p[def.key])} onChange={(v) => updateEffect(clip.id, inst.id, def.label, (e) => (e.params = { ...e.params, [def.key]: v }))} />
  return <SelectRow label={def.label} value={String(p[def.key])} options={def.options} onChange={(v) => updateEffect(clip.id, inst.id, def.label, (e) => (e.params = { ...e.params, [def.key]: v }))} />
}

function EffectsSection({ clip }: { clip: Clip }) {
  const list = clip.effects ?? []
  return (
    <Section title={`Effects${list.length ? ` (${list.length})` : ''}`}>
      {list.length === 0 && <p className="small muted">No effects yet. Add one below or from the Effects tab.</p>}
      {list.map((inst, i) => {
        const def = effectDef(inst.type)
        return (
          <div key={inst.id} className={`fx-item${inst.on ? '' : ' off'}`}>
            <div className="fx-item-head">
              <label className="check" title={inst.on ? 'Disable' : 'Enable'}>
                <input type="checkbox" checked={inst.on} onChange={(e) => updateEffect(clip.id, inst.id, e.target.checked ? 'Enable effect' : 'Disable effect', (x) => (x.on = e.target.checked))} />
                <strong>{def?.label ?? inst.type}</strong>
              </label>
              <div className="topbar-spacer" />
              <IconButton icon="chevron" label="Move up (applied earlier)" size={12} disabled={i === 0} onClick={() => moveEffect(clip.id, inst.id, -1)} />
              <IconButton icon="x" label="Remove effect" size={12} onClick={() => removeEffect(clip.id, inst.id)} />
            </div>
            {inst.on && def?.params.map((pd) => <ParamControl key={pd.key} clip={clip} inst={inst} def={pd} />)}
          </div>
        )
      })}
      <select
        className="add-fx"
        value=""
        aria-label="Add effect"
        onChange={(e) => {
          if (e.target.value) addEffect([clip.id], e.target.value)
        }}
      >
        <option value="">+ Add effect…</option>
        {FX_CATEGORIES.map((c) => (
          <optgroup key={c.id} label={c.label}>
            {EFFECTS.filter((x) => x.cat === c.id).map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Section>
  )
}

function FilterSection({ clip }: { clip: Clip }) {
  const f = clip.filter ?? defaultFilter()
  const edit = useClipEditor(clip)
  const fe = (label: string, key: keyof ClipFilter) => edit(label, (c, v) => (c.filter = { ...(c.filter ?? defaultFilter()), [key]: Math.round(v) }))
  return (
    <Section
      title="Filter"
      right={
        clip.filter && <IconButton icon="x" label="Remove filter" size={13} onClick={() => updateClip(clip.id, 'Remove filter', (c) => (c.filter = undefined))} />
      }
    >
      <SelectRow label="Preset" value={f.preset} options={FILTER_PRESETS.map((p) => ({ id: p.id, label: p.label }))} onChange={(v) => updateClip(clip.id, 'Filter preset', (c) => (c.filter = { ...(c.filter ?? defaultFilter()), preset: v }))} />
      {f.preset !== 'none' && <NumberField label="Intensity" value={f.intensity} min={0} max={100} defaultValue={100} suffix="%" onChange={fe('Filter intensity', 'intensity')} />}
      <NumberField label="Brightness" value={f.brightness} min={-100} max={100} defaultValue={0} onChange={fe('Brightness', 'brightness')} />
      <NumberField label="Contrast" value={f.contrast} min={-100} max={100} defaultValue={0} onChange={fe('Contrast', 'contrast')} />
      <NumberField label="Saturation" value={f.saturation} min={-100} max={100} defaultValue={0} onChange={fe('Saturation', 'saturation')} />
      <NumberField label="Temperature" value={f.temperature} min={-100} max={100} defaultValue={0} onChange={fe('Temperature', 'temperature')} />
      <NumberField label="Hue" value={f.hue} min={-180} max={180} defaultValue={0} suffix="°" onChange={fe('Hue', 'hue')} />
      <NumberField label="Blur" value={f.blur} min={0} max={60} defaultValue={0} suffix="px" onChange={fe('Blur', 'blur')} />
      <NumberField label="Vignette" value={f.vignette} min={0} max={100} defaultValue={0} onChange={fe('Vignette', 'vignette')} />
      <NumberField label="Grain" value={f.grain} min={0} max={100} defaultValue={0} onChange={fe('Grain', 'grain')} />
    </Section>
  )
}

function AnimationSection({ clip }: { clip: Clip }) {
  const a = clip.anim ?? defaultAnim()
  const edit = useClipEditor(clip)
  const set = (label: string, patch: Partial<ClipAnim>) => updateClip(clip.id, label, (c) => (c.anim = { ...(c.anim ?? defaultAnim()), ...patch }))
  const ae = (label: string, key: 'inDur' | 'outDur' | 'loopSpeed' | 'revealDur') => edit(label, (c, v) => (c.anim = { ...(c.anim ?? defaultAnim()), [key]: Math.round(v * 100) / 100 }))
  return (
    <Section title="Animation">
      <SelectRow<AnimIn> label="In" value={a.in} options={ANIM_IN} onChange={(v) => set('Animation in', { in: v })} />
      {a.in !== 'none' && <NumberField label="In length" value={a.inDur} min={0.05} max={Math.max(0.1, clip.duration)} step={0.05} precision={2} defaultValue={0.5} suffix="s" onChange={ae('In length', 'inDur')} />}
      <SelectRow<AnimIn> label="Out" value={a.out} options={ANIM_OUT} onChange={(v) => set('Animation out', { out: v })} />
      {a.out !== 'none' && <NumberField label="Out length" value={a.outDur} min={0.05} max={Math.max(0.1, clip.duration)} step={0.05} precision={2} defaultValue={0.5} suffix="s" onChange={ae('Out length', 'outDur')} />}
      <SelectRow<AnimLoop> label="Loop" value={a.loop} options={ANIM_LOOP} onChange={(v) => set('Loop animation', { loop: v })} />
      {a.loop !== 'none' && <NumberField label="Speed" value={a.loopSpeed} min={0.1} max={5} step={0.1} precision={1} defaultValue={1} suffix="×" onChange={ae('Loop speed', 'loopSpeed')} />}
      {clip.kind === 'text' && (
        <>
          <SelectRow<TextReveal> label="Reveal" value={a.reveal} options={TEXT_REVEALS} onChange={(v) => set('Text reveal', { reveal: v })} />
          {a.reveal !== 'none' && <NumberField label="Reveal time" value={a.revealDur} min={0.1} max={Math.max(0.2, clip.duration)} step={0.1} precision={1} defaultValue={1.2} suffix="s" onChange={ae('Reveal time', 'revealDur')} />}
        </>
      )}
    </Section>
  )
}

/** Quick access to the transitions on this clip's start and end. */
function ClipTransitionsSection({ clip, project }: { clip: Clip; project: Project }) {
  const rts = resolveTransitions(project, clip.trackId)
  const atStart = rts.find((r) => r.b?.id === clip.id)
  const atEnd = rts.find((r) => r.a?.id === clip.id)
  const prev = project.clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && c.kind !== 'audio' && Math.abs(clipEnd(c) - clip.start) < 0.02)
  const next = project.clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && c.kind !== 'audio' && Math.abs(c.start - clipEnd(clip)) < 0.02)
  const opts = [{ id: 'none', label: 'None' }, ...TRANSITIONS.map((t) => ({ id: t.id, label: t.label }))]
  const change = (edge: 'start' | 'end', v: string) => {
    const existing = edge === 'start' ? atStart : atEnd
    if (v === 'none') {
      if (existing) deleteTransition(existing.tr.id)
      return
    }
    if (existing) updateTransition(existing.tr.id, 'Change transition', { type: v as TransitionType })
    else if (edge === 'start') addTransition(clip.trackId, prev?.id, clip.id, v as TransitionType)
    else addTransition(clip.trackId, clip.id, next?.id, v as TransitionType)
  }
  return (
    <Section title="Transitions">
      <SelectRow label={prev ? 'From previous' : 'At start'} value={atStart?.tr.type ?? 'none'} options={opts} onChange={(v) => change('start', v)} />
      <SelectRow label={next ? 'To next' : 'At end'} value={atEnd?.tr.type ?? 'none'} options={opts} onChange={(v) => change('end', v)} />
      <p className="small muted">Or drag one from the Transitions tab onto a cut.</p>
    </Section>
  )
}

// ------------------------------------------------------------------ transition

function TransitionInspector(props: { id: string; type: TransitionType; duration: number; easing: Easing; kind: 'cut' | 'in' | 'out'; maxDur: number }) {
  return (
    <div className="inspector">
      <div className="inspector-title">
        <span className="kind-chip kind-transition">transition</span>
        <strong>{transitionLabel(props.type)}</strong>
        <div className="topbar-spacer" />
        <IconButton icon="trash" label="Delete transition" shortcut="Del" onClick={() => deleteTransition(props.id)} />
      </div>
      <Section title="Transition">
        <SelectRow label="Type" value={props.type} options={TRANSITIONS.map((t) => ({ id: t.id, label: t.label }))} onChange={(v) => updateTransition(props.id, 'Change transition', { type: v })} />
        <NumberField
          label="Duration"
          value={props.duration}
          min={0.1}
          max={props.maxDur}
          step={0.05}
          precision={2}
          defaultValue={0.5}
          suffix="s"
          onChange={(v, final) => {
            updateGesture((p) => {
              const t = (p.transitions ?? []).find((x) => x.id === props.id)
              if (t) t.duration = Math.round(v * 100) / 100
            })
            if (final) endGesture('Transition duration')
          }}
        />
        <SelectRow<Easing>
          label="Easing"
          value={props.easing}
          options={[
            { id: 'ease-in-out', label: 'Ease in-out' },
            { id: 'linear', label: 'Linear' },
            { id: 'ease-in', label: 'Ease in' },
            { id: 'ease-out', label: 'Ease out' },
          ]}
          onChange={(v) => updateTransition(props.id, 'Transition easing', { easing: v })}
        />
        <p className="small muted">
          {props.kind === 'cut' ? 'Plays across the cut: half before, half after. Uses extra source frames when available. Linked audio dips across the cut.' : props.kind === 'in' ? 'Transition in at the start of the clip.' : 'Transition out at the end of the clip.'}
        </p>
      </Section>
    </div>
  )
}

// ------------------------------------------------------------------ project

function ProjectInspector({ project }: { project: Project }) {
  const preset = RES_PRESETS.find(([, w, h]) => w === project.width && h === project.height)
  return (
    <div className="inspector">
      <div className="inspector-title">
        <span className="kind-chip">project</span>
        <strong>Sequence settings</strong>
      </div>
      <Section title="Format">
        <div className="field-row">
          <label className="field-label" htmlFor="res-preset">
            Resolution
          </label>
          <select
            id="res-preset"
            className="grow"
            value={preset ? preset[0] : 'custom'}
            onChange={(e) => {
              const p = RES_PRESETS.find(([n]) => n === e.target.value)
              if (p) setProjectSettings('Change resolution', { width: p[1], height: p[2] })
            }}
          >
            {RES_PRESETS.map(([n, w, h]) => (
              <option key={n} value={n}>
                {n} · {w}×{h}
              </option>
            ))}
            {!preset && <option value="custom">Custom · {project.width}×{project.height}</option>}
          </select>
        </div>
        <NumberField label="Width" value={project.width} min={16} max={7680} step={2} onChange={(v, f) => f && setProjectSettings('Change width', { width: Math.round(v / 2) * 2 })} />
        <NumberField label="Height" value={project.height} min={16} max={4320} step={2} onChange={(v, f) => f && setProjectSettings('Change height', { height: Math.round(v / 2) * 2 })} />
        <div className="field-row">
          <label className="field-label" htmlFor="fps">
            Frame rate
          </label>
          <select id="fps" className="grow" value={project.fps} onChange={(e) => setProjectSettings('Change frame rate', { fps: Number(e.target.value) })}>
            {[23.976, 24, 25, 29.97, 30, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="bg">
            Background
          </label>
          <input id="bg" type="color" value={project.background} onChange={(e) => setProjectSettings('Background color', { background: e.target.value })} />
        </div>
      </Section>
      <p className="muted pad small">Select a clip to edit its transform, text, filter, animation or transitions. Select a transition on the timeline to edit it.</p>
    </div>
  )
}
