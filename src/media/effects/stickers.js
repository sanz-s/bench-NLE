/**
 * Built-in stickers, drawn with Path2D / text so they render identically in the preview and in
 * the export worker (no SVG decoding needed, which workers can't do).
 * Paths are in a 100×100 box.
 */

export const STICKERS = [
  { id: 'arrow-right', label: 'Arrow →', cat: 'arrows', kind: 'path', d: 'M8 38 H58 V16 L94 50 L58 84 V62 H8 Z', color: '#ffd23f' },
  { id: 'arrow-left', label: 'Arrow ←', cat: 'arrows', kind: 'path', d: 'M92 38 H42 V16 L6 50 L42 84 V62 H92 Z', color: '#ffd23f' },
  { id: 'arrow-up', label: 'Arrow ↑', cat: 'arrows', kind: 'path', d: 'M38 92 V42 H16 L50 6 L84 42 H62 V92 Z', color: '#ffd23f' },
  { id: 'arrow-down', label: 'Arrow ↓', cat: 'arrows', kind: 'path', d: 'M38 8 V58 H16 L50 94 L84 58 H62 V8 Z', color: '#ffd23f' },
  {
    id: 'arrow-curve',
    label: 'Curved arrow',
    cat: 'arrows',
    kind: 'path',
    d: 'M12 84 C12 42 38 22 64 22 V6 L95 32 L64 58 V42 C44 42 30 56 28 84 Z',
    color: '#ff5d73',
  },
  { id: 'swoosh', label: 'Swoosh', cat: 'arrows', kind: 'path', d: 'M4 62 Q50 28 96 50 L93 62 Q50 44 8 74 Z', color: '#ff5d73' },
  { id: 'circle', label: 'Circle', cat: 'shapes', kind: 'path', d: 'M50 6 A44 44 0 1 1 49.99 6 Z', color: '#3fa7ff' },
  { id: 'ring', label: 'Ring', cat: 'shapes', kind: 'ring', color: '#ff3b3b' },
  { id: 'frame', label: 'Highlight box', cat: 'shapes', kind: 'frame', color: '#ffd23f' },
  { id: 'star', label: 'Star', cat: 'shapes', kind: 'star', points: 5, inner: 0.45, color: '#ffc83d' },
  { id: 'burst', label: 'Burst', cat: 'shapes', kind: 'star', points: 14, inner: 0.72, color: '#ff4f9a' },
  {
    id: 'sparkle',
    label: 'Sparkle',
    cat: 'shapes',
    kind: 'path',
    d: 'M50 4 C54 34 66 46 96 50 C66 54 54 66 50 96 C46 66 34 54 4 50 C34 46 46 34 50 4 Z',
    color: '#fff3a6',
  },
  {
    id: 'heart',
    label: 'Heart',
    cat: 'shapes',
    kind: 'path',
    d: 'M50 88 C20 66 6 50 6 32 C6 18 17 8 30 8 C39 8 46 13 50 20 C54 13 61 8 70 8 C83 8 94 18 94 32 C94 50 80 66 50 88 Z',
    color: '#ff4f6d',
  },
  { id: 'check', label: 'Check', cat: 'shapes', kind: 'path', d: 'M8 52 L22 38 L40 56 L78 16 L92 30 L40 84 Z', color: '#2ecc71' },
  {
    id: 'cross',
    label: 'Cross',
    cat: 'shapes',
    kind: 'path',
    d: 'M20 8 L50 38 L80 8 L92 20 L62 50 L92 80 L80 92 L50 62 L20 92 L8 80 L38 50 L8 20 Z',
    color: '#ff3b3b',
  },
  {
    id: 'bubble',
    label: 'Speech bubble',
    cat: 'shapes',
    kind: 'path',
    d: 'M12 12 H88 Q95 12 95 19 V62 Q95 69 88 69 H44 L22 90 L27 69 H12 Q5 69 5 62 V19 Q5 12 12 12 Z',
    color: '#ffffff',
  },
  {
    id: 'pin',
    label: 'Location pin',
    cat: 'shapes',
    kind: 'path',
    d: 'M50 95 C50 95 16 58 16 36 A34 34 0 0 1 84 36 C84 58 50 95 50 95 Z M50 22 A14 14 0 1 0 50.01 22 Z',
    evenodd: true,
    color: '#ff3b3b',
  },
  { id: 'play', label: 'Play button', cat: 'shapes', kind: 'path', d: 'M50 6 A44 44 0 1 1 49.99 6 Z M40 30 L72 50 L40 70 Z', evenodd: true, color: '#ff0033' },
  { id: 'bolt', label: 'Lightning', cat: 'shapes', kind: 'path', d: 'M58 4 L16 56 H46 L38 96 L84 40 H54 Z', color: '#ffd23f' },
  { id: 'crown', label: 'Crown', cat: 'shapes', kind: 'path', d: 'M8 80 L14 28 L34 52 L50 18 L66 52 L86 28 L92 80 Z', color: '#ffc83d' },
  { id: 'badge-new', label: 'NEW', cat: 'badges', kind: 'badge', text: 'NEW', color: '#ff3b5c', fg: '#ffffff' },
  { id: 'badge-sale', label: 'SALE', cat: 'badges', kind: 'badge', text: 'SALE', color: '#ffd23f', fg: '#111111' },
  { id: 'badge-off', label: '50% OFF', cat: 'badges', kind: 'badge', text: '50% OFF', color: '#111111', fg: '#ffd23f' },
  { id: 'badge-live', label: 'LIVE', cat: 'badges', kind: 'badge', text: '● LIVE', color: '#e60023', fg: '#ffffff' },
  { id: 'badge-sub', label: 'SUBSCRIBE', cat: 'badges', kind: 'badge', text: 'SUBSCRIBE', color: '#ff0000', fg: '#ffffff' },
  { id: 'badge-follow', label: 'FOLLOW', cat: 'badges', kind: 'badge', text: '+ FOLLOW', color: '#3d6fe8', fg: '#ffffff' },
  { id: 'badge-wow', label: 'WOW!', cat: 'badges', kind: 'badge', text: 'WOW!', color: '#8a2be2', fg: '#ffffff' },
]

export const EMOJIS = [
  '😀',
  '😂',
  '😍',
  '🥳',
  '😎',
  '🤯',
  '😱',
  '🤔',
  '😭',
  '😡',
  '👍',
  '👎',
  '👏',
  '🙌',
  '🙏',
  '💪',
  '👀',
  '🔥',
  '✨',
  '⭐',
  '💯',
  '❤️',
  '💔',
  '💥',
  '💡',
  '🎉',
  '🎬',
  '🎵',
  '📸',
  '🚀',
  '⚡',
  '🌈',
  '☀️',
  '🌙',
  '🍕',
  '☕',
  '✅',
  '❌',
  '⚠️',
  '📍',
]

export function stickerDef(s) {
  return STICKERS.find((d) => d.id === s.id) ?? null
}

const pathCache = new Map()
function path(d) {
  let p = pathCache.get(d)
  if (!p) {
    p = new Path2D(d)
    pathCache.set(d, p)
  }
  return p
}

function starPath(points, inner) {
  const key = `star:${points}:${inner}`
  let p = pathCache.get(key)
  if (!p) {
    p = new Path2D()
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? 46 : 46 * inner
      const a = (Math.PI * i) / points - Math.PI / 2
      const x = 50 + Math.cos(a) * r
      const y = 50 + Math.sin(a) * r
      if (i === 0) p.moveTo(x, y)
      else p.lineTo(x, y)
    }
    p.closePath()
    pathCache.set(key, p)
  }
  return p
}

const BADGE_FONT = (size) => `800 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`

/** Sticker size in project px (before transform.scale): square for shapes/emoji, text width for badges. */
export function stickerBaseSize(s, H, measure) {
  const base = H * 0.22
  const def = stickerDef(s)
  if (def?.kind === 'badge') {
    const fs = base * 0.32
    const tw = measure(BADGE_FONT(fs), def.text)
    return { w: tw + fs * 1.4, h: fs * 1.9 }
  }
  return { w: base, h: base }
}

/** Draw a sticker centred at the origin of the current transform, w × h in canvas px. */
export function drawSticker(ctx, s, w, h) {
  const def = stickerDef(s)
  const color = s.color
  const outline = s.color2
  if (s.id === 'emoji' && s.emoji) {
    ctx.font = `${h * 0.86}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(s.emoji, 0, h * 0.04)
    return
  }
  if (!def) return
  if (def.kind === 'badge') {
    const r = h * 0.28
    ctx.shadowColor = 'rgba(0,0,0,0.35)'
    ctx.shadowBlur = h * 0.15
    ctx.shadowOffsetY = h * 0.05
    ctx.beginPath()
    ctx.roundRect(-w / 2, -h / 2, w, h, r)
    ctx.fillStyle = color
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.font = BADGE_FONT(h / 1.9)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = outline
    ctx.fillText(def.text, 0, h * 0.04)
    return
  }
  const k = Math.min(w, h) / 100
  ctx.scale(k, k)
  ctx.translate(-50, -50)
  ctx.lineJoin = 'round'
  if (def.kind === 'ring' || def.kind === 'frame') {
    ctx.lineWidth = 9
    ctx.strokeStyle = outline
    ctx.globalAlpha *= 0.9
    const shape = () => {
      ctx.beginPath()
      if (def.kind === 'ring') ctx.ellipse(50, 50, 42, 42, 0, 0, Math.PI * 2)
      else ctx.roundRect(8, 18, 84, 64, 6)
    }
    shape()
    ctx.lineWidth = 12
    ctx.stroke()
    shape()
    ctx.lineWidth = 7
    ctx.strokeStyle = color
    ctx.stroke()
    return
  }
  const p = def.kind === 'star' ? starPath(def.points, def.inner) : def.kind === 'path' ? path(def.d) : null
  if (!p) return
  const rule = def.kind === 'path' && def.evenodd ? 'evenodd' : 'nonzero'
  // sticker look: white die-cut outline + soft shadow
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 6
  ctx.shadowOffsetY = 2
  ctx.lineWidth = 7
  ctx.strokeStyle = outline
  ctx.stroke(p)
  ctx.shadowColor = 'transparent'
  ctx.fillStyle = color
  ctx.fill(p, rule)
}
