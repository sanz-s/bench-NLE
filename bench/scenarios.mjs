/**
 * Benchmark scenarios for bench/run.mjs.
 * - fixtures are generated in the page with Mediabunny (no external files, no ffmpeg),
 *   or use `file:<name>` to reference a real file placed in bench/fixtures/.
 * - type 'convert' runs one file through either the Mediabunny Conversion API ('conversion')
 *   or the manual decode → draw → encode pipeline ('pipeline', gives per-stage timings).
 * - type 'export' renders the standard benchmark timeline (main clip + PiP + title + audio fades).
 */

export const FIXTURES = {
  h264_1080p30: { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1920, height: 1080, fps: 30, duration: 10 },
  h264_4k30: { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 3840, height: 2160, fps: 30, duration: 5 },
  matrix_small: { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 640, height: 360, fps: 30, duration: 2 },
}

const v = (container, videoCodec, audioCodec, extra = {}) => ({ container, videoCodec, audioCodec, ...extra })

export const SCENARIOS = [
  // --- single-file conversions (Mediabunny Conversion API)
  { id: 'conv-mp4-mkv-copy', type: 'convert', fixture: 'h264_1080p30', engine: 'conversion', allowCopy: true, settings: v('mkv', 'avc', 'aac') },
  { id: 'conv-h264-vp9-webm', type: 'convert', fixture: 'h264_1080p30', engine: 'conversion', allowCopy: false, settings: v('webm', 'vp9', 'opus') },
  { id: 'conv-h264-av1-mp4', type: 'convert', fixture: 'h264_1080p30', engine: 'conversion', allowCopy: false, settings: v('mp4', 'av1', 'aac') },
  { id: 'conv-h264-hevc-mp4', type: 'convert', fixture: 'h264_1080p30', engine: 'conversion', allowCopy: false, settings: v('mp4', 'hevc', 'aac') },
  { id: 'conv-h264-h264-mp4', type: 'convert', fixture: 'h264_1080p30', engine: 'conversion', allowCopy: false, settings: v('mp4', 'avc', 'aac') },
  { id: 'conv-audio-mp3', type: 'convert', fixture: 'h264_1080p30', engine: 'conversion', allowCopy: false, settings: v('mp3', null, 'mp3', { qualityMode: 'bitrate', audioBitrate: 192000 }) },
  { id: 'conv-audio-flac', type: 'convert', fixture: 'h264_1080p30', engine: 'conversion', allowCopy: false, settings: v('flac', null, 'flac') },
  { id: 'conv-audio-wav', type: 'convert', fixture: 'h264_1080p30', engine: 'conversion', allowCopy: false, settings: v('wav', null, 'pcm-s16') },

  // --- same conversion through the manual pipeline (stage split + encoder latency)
  { id: 'pipe-h264-h264-mp4', type: 'convert', fixture: 'h264_1080p30', engine: 'pipeline', settings: v('mp4', 'avc', 'aac') },
  { id: 'pipe-h264-vp9-webm', type: 'convert', fixture: 'h264_1080p30', engine: 'pipeline', settings: v('webm', 'vp9', 'opus') },

  // --- timeline exports: worker vs main thread, hardware vs software
  { id: 'export-h264-worker', type: 'export', fixture: 'h264_1080p30', runIn: 'worker', settings: v('mp4', 'avc', 'aac') },
  { id: 'export-h264-main', type: 'export', fixture: 'h264_1080p30', runIn: 'main', settings: v('mp4', 'avc', 'aac') },
  { id: 'export-h264-hw', type: 'export', fixture: 'h264_1080p30', runIn: 'worker', settings: v('mp4', 'avc', 'aac', { hardwareAcceleration: 'prefer-hardware' }) },
  { id: 'export-h264-sw', type: 'export', fixture: 'h264_1080p30', runIn: 'worker', settings: v('mp4', 'avc', 'aac', { hardwareAcceleration: 'prefer-software' }) },
  { id: 'export-vp9-worker', type: 'export', fixture: 'h264_1080p30', runIn: 'worker', settings: v('webm', 'vp9', 'opus') },
  // effects: vintage filter, cross dissolve, animated sticker, lower third, cinematic adjustment layer
  { id: 'export-effects-worker', type: 'export', timeline: 'effects', fixture: 'h264_1080p30', runIn: 'worker', settings: v('mp4', 'avc', 'aac') },
  { id: 'export-effects-main', type: 'export', timeline: 'effects', fixture: 'h264_1080p30', runIn: 'main', settings: v('mp4', 'avc', 'aac') },
  { id: 'export-h264-4k-worker', type: 'export', fixture: 'h264_4k30', runIn: 'worker', settings: v('mp4', 'avc', 'aac', { width: 3840, height: 2160 }), projectSize: [3840, 2160] },
]
