/** MIME type for dragging media-bin assets onto the timeline. */
export const ASSET_MIME = 'application/x-nle-asset'
/** Gallery items (text presets, stickers, transitions, filters) dragged onto the timeline. */
export const EFFECT_MIME = 'application/x-nle-effect'

/**
 * dataTransfer contents can't be read during dragover, so the dragged item is mirrored here
 * for drop ghosts / targets.
 */
export const dragState = { assetId: null, effect: null }
