/** Preset recipe: values at 100% intensity. Identity values are omitted. */

export const FILTER_PRESETS = [
  { id: 'none', label: 'Original', recipe: {} },
  { id: 'bw', label: 'B&W', recipe: { grayscale: 1, contrast: 1.1 } },
  { id: 'noir', label: 'Noir', recipe: { grayscale: 1, contrast: 1.45, brightness: 0.9, vignette: 45 } },
  { id: 'sepia', label: 'Sepia', recipe: { sepia: 0.9, contrast: 1.05 } },
  { id: 'vintage', label: 'Vintage', recipe: { sepia: 0.35, contrast: 0.9, saturate: 0.8, brightness: 1.05, vignette: 30, grain: 25 } },
  { id: 'warm', label: 'Warm', recipe: { temperature: 45, saturate: 1.1 } },
  { id: 'cool', label: 'Cool', recipe: { temperature: -45, saturate: 1.05 } },
  { id: 'vivid', label: 'Vivid', recipe: { saturate: 1.6, contrast: 1.15 } },
  { id: 'fade', label: 'Faded', recipe: { contrast: 0.78, brightness: 1.1, saturate: 0.7 } },
  { id: 'cinematic', label: 'Cinematic', recipe: { contrast: 1.2, saturate: 0.85, temperature: -12, vignette: 35, tint: '#0f6f77' } },
  { id: 'cyber', label: 'Cyber', recipe: { hue: -30, saturate: 1.8, contrast: 1.2, tint: '#8a2be2' } },
  { id: 'dreamy', label: 'Dreamy', recipe: { blur: 1.5, brightness: 1.1, saturate: 1.2, tint: '#ffb6d9' } },
  { id: 'invert', label: 'Invert', recipe: { invert: 1 } },
]

export function defaultFilter(preset = 'none') {
  return { preset, intensity: 100, brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0, blur: 0, vignette: 0, grain: 0 }
}

export function hasFilter(f) {
  if (!f) return false
  return (f.preset !== 'none' && f.intensity > 0) || !!(f.brightness || f.contrast || f.saturation || f.hue || f.temperature || f.blur || f.vignette || f.grain)
}

/** Combine preset (scaled by intensity) + manual adjustments into what the compositor applies. */
export function resolveFilter(f, resolutionScale) {
  const r = FILTER_PRESETS.find((p) => p.id === f.preset)?.recipe ?? {}
  const k = Math.max(0, Math.min(1, f.intensity / 100))
  const lerp = (id, v) => id + ((v ?? id) - id) * k
  const parts = []
  const grayscale = lerp(0, r.grayscale)
  const sepia = lerp(0, r.sepia)
  const invert = lerp(0, r.invert)
  const brightness = lerp(1, r.brightness) * (1 + f.brightness / 100)
  const contrast = lerp(1, r.contrast) * (1 + f.contrast / 100)
  const saturate = lerp(1, r.saturate) * (1 + f.saturation / 100)
  const hue = lerp(0, r.hue) + f.hue
  const blur = (lerp(0, r.blur) + f.blur) * resolutionScale
  if (grayscale > 0.001) parts.push(`grayscale(${grayscale.toFixed(3)})`)
  if (sepia > 0.001) parts.push(`sepia(${sepia.toFixed(3)})`)
  if (invert > 0.001) parts.push(`invert(${invert.toFixed(3)})`)
  if (Math.abs(brightness - 1) > 0.001) parts.push(`brightness(${brightness.toFixed(3)})`)
  if (Math.abs(contrast - 1) > 0.001) parts.push(`contrast(${contrast.toFixed(3)})`)
  if (Math.abs(saturate - 1) > 0.001) parts.push(`saturate(${saturate.toFixed(3)})`)
  if (Math.abs(hue) > 0.05) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`)
  if (blur > 0.05) parts.push(`blur(${blur.toFixed(2)}px)`)
  return {
    css: parts.length ? parts.join(' ') : 'none',
    temperature: lerp(0, r.temperature) + f.temperature,
    vignette: Math.min(100, lerp(0, r.vignette) + f.vignette),
    grain: Math.min(100, lerp(0, r.grain) + f.grain),
    tint: r.tint ?? null,
    tintAmount: r.tint ? 0.35 * k : 0,
    /** canvas px per project px: grain is sized in project pixels so preview and export match */
    scale: resolutionScale,
  }
}

/** Does the resolved filter need the overlay pass (temperature, tint, grain, vignette)? */
export function hasFilterOverlays(f) {
  return Math.abs(f.temperature) > 0.5 || (!!f.tint && f.tintAmount > 0) || f.grain > 0.5 || f.vignette > 0.5
}

// ------------------------------------------------------------------ overlays (temperature, tint, vignette, grain)

let grainTile = null
function getGrainTile() {
  if (grainTile) return grainTile
  grainTile = new OffscreenCanvas(160, 160)
  const g = grainTile.getContext('2d')
  const img = g.createImageData(160, 160)
  // deterministic noise so exports are reproducible
  let seed = 1234567
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const v = seed & 255
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return grainTile
}

/**
 * Overlays that CSS filters can't express, drawn over `rect` (canvas pixels) after the clip.
 * `t` animates the grain. Caller has already set transform/clip for the layer.
 * Every overlay's strength is multiplied by the inherited `ctx.globalAlpha` (clip opacity / fades).
 */
export function drawFilterOverlays(ctx, f, rect, t) {
  const { x, y, w, h } = rect
  if (w <= 0 || h <= 0) return
  const base = ctx.globalAlpha
  if (base <= 0) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  if (Math.abs(f.temperature) > 0.5) {
    const a = Math.min(0.45, (Math.abs(f.temperature) / 100) * 0.45)
    ctx.globalCompositeOperation = 'soft-light'
    ctx.globalAlpha = base
    ctx.fillStyle = f.temperature > 0 ? `rgba(255,140,30,${a})` : `rgba(30,120,255,${a})`
    ctx.fillRect(x, y, w, h)
  }
  if (f.tint && f.tintAmount > 0) {
    ctx.globalCompositeOperation = 'soft-light'
    ctx.globalAlpha = base * f.tintAmount
    ctx.fillStyle = f.tint
    ctx.fillRect(x, y, w, h)
  }
  if (f.grain > 0.5) {
    ctx.globalCompositeOperation = 'overlay'
    ctx.globalAlpha = base * Math.min(0.5, (f.grain / 100) * 0.5)
    const pat = ctx.createPattern(getGrainTile(), 'repeat')
    if (pat) {
      // shift the noise tile each "film frame" (24 fps) so grain moves; pattern origin follows the transform.
      // The tile is sized in project pixels (× f.scale), so a downscaled preview shows the same grain as the export.
      const k = f.scale > 0 ? f.scale : 1
      const off = Math.floor(t * 24) * 37
      const ox = (off % 160) * k
      const oy = ((off * 7) % 160) * k
      ctx.translate(ox, oy)
      ctx.scale(k, k)
      ctx.fillStyle = pat
      ctx.fillRect((x - ox) / k, (y - oy) / k, w / k, h / k)
    }
  }
  ctx.restore()
  if (f.vignette > 0.5) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    const cx = x + w / 2
    const cy = y + h / 2
    const r = Math.hypot(w, h) / 2
    const g = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r)
    const a = Math.min(0.85, (f.vignette / 100) * 0.85)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, `rgba(0,0,0,${a})`)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = base
    ctx.fillStyle = g
    ctx.fillRect(x, y, w, h)
    ctx.restore()
  }
}
