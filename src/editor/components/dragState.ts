/** MIME type for dragging media-bin assets onto the timeline. */
export const ASSET_MIME = 'application/x-nle-asset'
/** Gallery items (text presets, stickers, transitions, filters) dragged onto the timeline. */
export const EFFECT_MIME = 'application/x-nle-effect'

export type EffectPayload =
  | { kind: 'text'; presetId: string }
  | { kind: 'sticker'; sticker: import('../../media/types').ClipSticker }
  | { kind: 'transition'; type: import('../../media/types').TransitionType }
  | { kind: 'filter'; presetId: string }
  | { kind: 'adjustment'; presetId: string }
  | { kind: 'effect'; type: string }
  | { kind: 'textfx'; fx: import('../../media/types').TextFx | 'gradient' | 'trail' }

/**
 * dataTransfer contents can't be read during dragover, so the dragged item is mirrored here
 * for drop ghosts / targets.
 */
export const dragState: { assetId: string | null; effect: EffectPayload | null } = { assetId: null, effect: null }
