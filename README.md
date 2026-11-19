# Bunny NLE: browser video editor + Mediabunny export benchmarks

A fully client-side non-linear video editor. Every import, decode, conversion and export goes through
[Mediabunny](https://mediabunny.dev) and its official extensions, with no ffmpeg. It ships with built-in
export benchmarking: conversion time, encode time, main-thread blocking, and CPU/GPU usage.

## Quick start
```bash
npm install
npm run dev                 # http://localhost:5173  (the editor; works on its own)
npm run bench:server        # optional, in a 2nd terminal: CPU/GPU sampler → "Metrics on" in the top bar
```
## Export Monitor (dashboard)
With `npm run bench:server` running, open **http://127.0.0.1:5199**, or click **Dashboard** in the editor's top bar.
It only watches encoding jobs: **timeline exports** and **file conversions**. Recording starts when you press
Export or Convert, and stops when the job finishes. Nothing is recorded while you edit.
- **Live:** progress and ETA, plus live charts of system CPU, Chrome CPU, GPU %, main-thread blocking (long-task time
  per 0.5 s) and Chrome memory. Watts appear too when the server runs with `--powermetrics`.
- **Results:** every job is saved to `bench-results/exports.jsonl`, so results survive restarts. You can sort and filter.
  Click a result to see its stage breakdown and full CPU/GPU/main-thread charts. Tick 2–4 results and press
  **Compare** for side-by-side bars and overlaid GPU/CPU lines. JSON/CSV download and delete are also there.
- Playwright runs are tagged "automated" and hidden unless you tick *Include automated runs*.

Drop files into the Media panel, or click ✨ to generate a 1080p test clip. Then drag the clip to the
timeline, edit, and press **Export** (⌘E). Each export or conversion appears in the **Bench** tab, which
can download the results as JSON or CSV.

## Automated benchmarks (Playwright)
```bash
npm run bench                         # build → serve dist/ → headed Chrome → all scenarios × 3 runs
npm run bench -- --scenario export-h264-worker,export-h264-main --runs 5
npm run bench -- --trace              # also save Chrome traces (open in DevTools › Performance)
npm run bench -- --aac native         # AAC encoder under test: auto (default) | native | wasm
npm run bench -- --warmup 2 --cooldown 5   # warm-up runs (not counted) and pause between runs
npm run bench:matrix                  # round-trip each encodable codec (representative pairings)
npm run bench -- --matrix-all         # …every container × video × audio pairing
npm run test:ui                       # editor smoke test through the real UI (+ screenshots)
npm run test:regress                  # regression tests for the audited defects
sudo npm run bench:server -- --powermetrics   # adds GPU/CPU power (W) + GPU frequency
```
Results go to `bench-results/run-<timestamp>.json|csv`, with one row per run plus a median row per scenario. The median row is the real median run (by conversion time), picked only from runs that verified, ran in a visible tab and didn't overlap another job.
Scenarios are defined in `bench/scenarios.mjs`. Real media files can go in `bench/fixtures/`, referenced as `fixture: 'file:<name>'`.

### What is measured
| Metric | Source |
|---|---|
| Conversion time, setup, decode wait, composite, **encode time** (encoder submit/backpressure + finalize), audio mix | in-app stage timers (`src/media/jobs.js`) |
| Encoder latency per frame (submit → encoded packet), encoder busy span, encoder codec string / HW preference | `onEncodedPacket` / `onEncoderConfig` |
| Real-time factor, encode fps, output size and bitrate, peak JS heap | in-app |
| Output verification: re-opened with Mediabunny, codec, duration and size checked | in-app |
| **Main-thread blocking**: long tasks, longest task, TBT, % blocked, LoAF blocking, rAF frame gaps | `PerformanceObserver` in the page |
| Main-thread task / script / layout / style time | Playwright CDP `Performance.getMetrics` deltas |
| System CPU, browser CPU per process type (gpu-process, renderer, utility…), browser RSS | `bench-server` (`os.cpus`, `ps` cputime deltas, filtered to the Playwright browser's PID tree) |
| GPU utilisation (Device / Renderer / Tiler %) | `bench-server` via `ioreg` (macOS, no sudo) or `nvidia-smi` |
| GPU/CPU power, GPU frequency | `bench-server --powermetrics` (sudo) |

The Mediabunny `Conversion` engine pipelines decode and encode internally, so it reports total time only.
Use the **Manual pipeline** engine in the Convert dialog (or the `pipe-*` scenarios) to split the stages.

### Measurement caveats
- **Composite time is understated.** It only covers 2D canvas command submission. The GPU raster and the canvas → VideoFrame readback happen inside `CanvasSource.add()`, so they're counted under encode wait. Per-frame encoder latency (submit → packet) is the cleaner encode figure.
- **TBT is often 0 even in main-thread mode**, because the Mediabunny pipeline yields every frame, so no task exceeds 50 ms. The CDP main-thread task time (`cdp_mainTaskMs`) is what separates the two modes. The runner self-tests the long-task probe at startup with 3 × 120 ms injected blocks, which should report TBT ≈ 210 ms.
- Peak JS heap is only reported for main-thread jobs (`performance.memory` isn't available in workers).
- "Stream copy" for Conversion jobs is predicted from the settings, not measured: same codec, size and frame rate for video, and same codec, sample rate and channel count for audio.
- **Encode wait** (`encodeWaitMs`) is time spent *waiting* on the encoders (back-pressure + flush), not encoder busy time. **Pipeline fps** (`pipelineFps`) is frames ÷ total job time, i.e. end-to-end throughput. Conversion frame counts are estimated from duration × fps, and audio-only jobs have none.
- Short jobs (under the 500 ms sample interval) get only a few CPU/GPU samples. Averages are time-weighted over session start → job end. GPU % from `ioreg` covers the whole GPU, not only the browser.

## Effects
- **Library tabs** (left panel): Media · Text · Stickers · Transitions · Filters. Click an item to apply it at the playhead or to the selected clip, or drag it onto the timeline.
- **Text:** 10 presets (title, subtitle, lower third, callout, quote, caption bar, neon, outline, big & bold, typewriter). Full styling covers font, weight, outline, shadow/glow, box, alignment and spacing, plus reveal animations.
- **Stickers:** vector shapes, arrows, badges and emoji, all with editable colors.
- **Transitions:** 49 types in 4 categories: Basic, Smooth & cinematic, Glitch & trendy, Creative. They work on cuts or clip edges, with an animated preview on hover and on the timeline badge. Drag a badge's edge to change its duration. Linked audio dips across the cut.
- **Video effects (stackable):** 28 effects in 3 groups. Each has its own sliders; reorder them or switch them on and off in the Inspector.
  - Cinematic: color grading, grain, vignette, bloom, lens flare, soft glow, anamorphic, depth of field, motion blur, bars.
  - Motion: Ken Burns, camera shake, handheld, bounce, elastic scale, wave, motion trail.
  - Social: RGB split, glitch, pixelate, duotone, invert, scanlines, halftone, noise, neon glow, outline glow, chromatic aberration.
- **Text effects:** kinetic typography, tracking, neon flicker, per-letter pop, 3D flip, glitch, gradient fill (animated) and motion trail, on top of the typewriter and word reveals.
- All of it is plain Canvas2D with no WebGL, so preview and export match. Not included because they need GPU shaders: perspective warp, ripple, fisheye, lens distortion, edge detection, posterize.
- `npm run bench:fx` renders the whole catalog through the export worker and records each effect's composite cost.
- **Filters:** 12 presets, plus brightness, contrast, saturation, temperature, hue, blur, vignette and grain. Adjustment layers filter everything below them.
- **Animations:** in/out/loop animations for any visual clip.
- **Editing:** ⌘C/⌘X/⌘V copy/cut/paste at the playhead, ⌘D duplicate, ⌥⌘V paste attributes. Drag on empty timeline space to box-select clips.

## Formats
- **Import:** MP4/M4V/M4A, MOV, MKV, WebM, Ogg, MPEG-TS, MP3, WAV, AAC, FLAC, plus ProRes, AC-3/E-AC-3, DTS and TrueHD through
  the extensions. Still images (PNG/JPG/WebP/AVIF/GIF) use the browser's image decoder. AVI/FLV/WMV are rejected with a clear message.
- **Export:** MP4, MOV, WebM, MKV, MPEG-TS, Ogg, MP3, WAV, AAC, FLAC. The dialog only offers codecs this browser
  can encode, and greys out the rest with the reason. HLS is listed but disabled in this MVP because it writes multiple files.
