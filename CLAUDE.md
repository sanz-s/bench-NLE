# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is
A browser-based non-linear video editor (NLE) whose purpose is **benchmarking Mediabunny export**: conversion time, encoding time, main-thread blocking, and CPU/GPU usage. The full product spec and build plan live in `~/.claude/plans/list-what-should-a-ancient-hamster.md`.

## Hard constraints
- **All media work goes through Mediabunny** (`mediabunny`) and its official extensions (`@mediabunny/aac-encoder`, `mp3-encoder`, `flac-encoder`, `prores`, `ac3`, `dts`, `truehd`). Never add ffmpeg.wasm or any other media library. Still images are the only exception: they use the browser's `createImageBitmap`.
- **The NLE is fully client-side.** `bench-server/` only measures the machine (CPU/GPU). The app must work when it isn't running, and it does nothing but measure.
- Heavy media jobs run in a Web Worker by default. A main-thread mode also exists, but only so the two can be compared in benchmarks.

## Commands
- `npm run dev`: Vite dev server on :5173. It sends COOP/COEP headers, and a small middleware (`benchApiBridge` in `vite.config.js`) bridges `/bench-api` to :5199. The bridge returns 503 quietly when the bench-server is down.
- `npm run build`: production build (`vite build`). The code is plain JavaScript (ES modules + JSX), so there is no typecheck step; `npm run lint` and the Playwright tests are the safety net.
- `npm run lint`: oxlint.
- `npm run preview`: serves `dist/` with the same headers and proxy.
- **Export Monitor dashboard:** `bench-server/dashboard.html`, a single self-contained page served at http://127.0.0.1:5199/.
  - The editor's `jobRunner` opens a server session for every export or convert. It streams progress (`/sessions/:id/progress`) and 500 ms main-thread buckets (`/sessions/:id/mainthread`, from `startMainThreadStream`), then posts the final report (`/sessions/:id/report`).
  - The server stores each job as one record (report + CPU/GPU/main-thread series) in `bench-results/exports.jsonl`.
  - Records carry `source: editor|playwright`. Playwright is detected via `setRootPid`/`setAutomated`.
  - Chart colors follow entities, using the dataviz palette, validated on `#17181b`. Stage bars use 4 fixed groups so any subset keeps valid neighbour pairs.
- `npm run bench:server`: CPU/GPU sampler for the terminal on :5199. `sudo npm run bench:server -- --powermetrics` adds CPU/GPU power and frequency.
- `npm run bench`: builds, starts `vite preview`, drives headed Google Chrome with Playwright through the scenarios in `bench/scenarios.mjs`, and writes `bench-results/*.json|csv`.
  - `npm run bench -- --scenario <id>` runs one scenario.
  - `--runs N` sets the repeat count (median is reported).
  - `--matrix` round-trip-tests every export format/codec combination.
  - `--trace` saves Chrome traces.
  - `--headless` / `--chromium` choose a different browser setup.
- `npm run bench:matrix`: round-trips every encodable container × codec (convert, then re-probe).
- `npm run test:ui`: UI smoke tests through the real UI. `bench/ui-smoke.mjs` covers editing; `bench/effects-smoke.mjs` covers text, stickers, filters, transitions, copy/paste and effects exports. Screenshots go to `bench-results/ui-smoke/` and `bench-results/effects-smoke/`.
- `node bench/showcase.mjs [--files a b c] [--export] [--no-sfx] [--test]`: opens headed Chrome on the running dev server (or starts one), imports 3 videos (or waits for you to), builds the all-tools showcase edit (`buildShowcase` in `harness.js`) and leaves the window open. It also imports the synthesized SFX kit from `bench/sfx/` (`node bench/make-sfx.mjs` regenerates it); any asset named `sfx-<name>.wav` is placed on A2+. Export only with `--export`.
- `npx playwright install chromium` is needed only for `--chromium`. The default uses the installed Chrome.

## Architecture (data flow)
- `src/media/`: the Mediabunny-only layer, with no React. It runs in both the main thread and the worker.
  - `extensions.js` `registerAllExtensions()` must run once **in every JS context** (main thread and each worker) before any decode or encode.
  - `formats.js` maps container ids to Mediabunny `*OutputFormat` classes.
  - `capabilities.js` builds the format matrix (container → encodable codecs + reasons) that drives the export and convert UI.
  - `probe.js` turns a File into `MediaInfo`.
  - `compositor.js` draws one timeline instant on a 2D canvas. Preview and export share it.
  - `videoReader.js` reads frames sequentially through `CanvasSink`, with seek reset.
  - `audioMix.js` decodes, resamples and mixes audio with gain and fades.
  - `jobs.js` runs every job: a timeline export (`Output` + `CanvasSource` + `AudioSampleSource`), a single-file `Conversion`, or a "manual pipeline" conversion. It returns stage timings.
- `src/workers/media.worker.js` is a thin wrapper around `runJob()` from `jobs.js`.
- `src/editor/` is the React UI.
  - `store.js` holds the project, undo/redo (snapshot stack plus gesture batching) and IndexedDB autosave. File objects survive structured clone.
  - `playback.js` drives the preview: an AudioContext-clocked rAF loop and audio scheduling.
  - The UI components are in `components/`.
- `src/bench/`:
  - `metrics.js` builds `JobReport` objects (`deriveMetrics`, `flattenReport`) and the CSV.
  - `mainThread.js` tracks Long Tasks / TBT and rAF frame gaps.
  - `serverClient.js` talks to the optional `/bench-api`.
  - `jobRunner.js` orchestrates: server session → worker or main → output verification → report.
  - `harness.js` exposes `window.__nleBench` for Playwright.
- `bench-server/server.mjs` uses Node built-ins only. It reads system CPU from `os.cpus()` deltas, per-process browser CPU from `ps` cputime deltas (grouped by Chrome `--type=`, optionally filtered to a root PID's process tree), and GPU from `ioreg` `Device Utilization %`.
- `bench/run.mjs` is the Playwright runner. It adds CDP `Performance.getMetrics` deltas to each in-app report.

## Effects (text, stickers, transitions, filters, animations)
- **Modules:** `src/media/effects/` holds `text.js` (fonts, presets, layout/draw), `stickers.js` (Path2D/emoji library), `filters.js` (presets → `ctx.filter` + overlays for temperature, tint, vignette and grain), `animations.js` (in/out/loop/reveal → per-frame `AnimState`) and `transitions.js` (draw math).
- **Shared rendering:** `compositor.js` `layerItemsAt()` resolves each track at time t into clips or a transition (A + B + eased progress). `frameRequests()` lists the media frames needed, including transition partners past a clip's edge. `drawFrame()` renders them.
  - The preview (`playback.js`), the export (`jobs.js`) and the gallery thumbnails (`components/fxThumbs.js`) all use this same path. Keep it that way, so previews match exports.
- **Video effects** (`effects/fx/videoEffects.js`, 27 effects) are a per-clip stack (`clip.effects`).
  - Each effect declares typed `params`, which the Inspector turns into controls automatically.
  - Each also has a Canvas2D `process(src → dst)` layer processor or a `motion()` transform modifier. Motion Trail is handled in `drawClip`.
  - Clips with layer effects render alone into a pooled full-frame layer (`fx/util.js` `acquire`/`release`, which must be released in the same frame), run through the chain, then composite.
- **Advanced transitions** (`effects/fx/transitionsFx.js`, 34 of the 49 total) get `TransitionSides`: draw a side in place, or as a full-frame layer for masks, smears and pixel tricks.
  - Procedural masks (ink, smoke, film burn, luma) are built at 160×90 and upscaled.
- **No WebGL by decision.** Perspective warp, ripple, fisheye, lens distortion, edge detection and posterize are intentionally not implemented.
- **Text effects** (`TEXT_FX` in `text.js`): kinetic, tracking, neon flicker, pop, 3D flip, glitch (which runs the glitch processor) and gradient fill.
- `npm run bench:fx` (`bench/fx-catalog.mjs`) exports every effect, transition and text effect through the worker, verifies each one, and writes per-effect composite cost to CSV.
- **Adjustment clips** filter the canvas onto itself (`drawImage(ctx.canvas)`) for everything below them.
- **Transitions** live in `project.transitions`, keyed by `leftId`/`rightId`. They are dropped by `pruneTransitions` (in `store.js`) when clips stop touching. Splitting a clip moves end-transitions to the right half.
- **Audio** linked to a video transition gets an equal-power dip (`makeGainFn` in `audioMix.js`).
- **No web fonts:** only system fonts are used, so text renders the same in the export worker.
- **Clipboard:** `copySelection` / `pasteClipboard` / `duplicateSelection` / `pasteAttributes` live in `store.js` and are wired to ⌘C/X/V/D and ⌥⌘V in `shortcuts.js`.
- **Box select:** dragging on empty timeline space draws a marquee (`onLanePointerDown` in `Timeline.jsx`). A click without a drag seeks.

## Timeline placement rule
Clips never overwrite each other. `placeWithoutOverlap()` in `store.js` handles adding media, adding a title, and drag-moves (applied on release).
- A clip that would collide goes to the nearest free track of the same kind (video searches upward, audio downward). If none is free, a new track is created.
- Trims are clamped at the neighbouring clip (`trimLimits` in `Timeline.jsx`).
- `bench/ui-smoke.mjs` covers all of these.

## On-canvas transform
`components/TransformOverlay.jsx` sits over the preview canvas.
- It uses `clipBounds()` from `compositor.js`, the same geometry `drawComposite` draws with, for hit-testing and the selection box.
- Drags use window listeners and `updateGesture`/`endGesture`, so each move or scale is one undo step.

## Metric definitions
The `JobReport` shape built in `src/bench/metrics.js` (`deriveMetrics`) and `jobRunner.js` is the source of truth, and `jobs.js` fills the stage timers.
- **Encode time:** time spent awaiting `source.add()` (encoder queue and backpressure) plus finalize flush.
- **Encoder latency:** submit → `onEncodedPacket`, per frame.
- **Decode time:** time awaiting frames from sinks.
- **Mediabunny `Conversion` jobs:** only total, init and time-to-first-progress can be measured, because decode and encode are pipelined internally. Use the "manual pipeline" engine for a per-stage split.
- **Composite time** only counts 2D command submission. Canvas raster and readback land in encode wait (inside `CanvasSource.add`).
- **TBT** is usually 0 even on the main thread, because the pipeline yields each frame. Compare modes with CDP `cdp_mainTaskMs`.
- `verifyOutput` (in `jobRunner.js`) re-probes each output and really decodes it (`decodeCheck` in `probe.js`), so `--matrix` doubles as an import/decode test.

## Gotchas
- COOP `same-origin` and COEP `require-corp` are required. The extension WASM uses shared-memory threads, so without them it falls back to a slower path and skews the benchmarks. Don't load cross-origin resources (fonts, CDNs) without CORP/CORS.
- Check Mediabunny API names against `node_modules/mediabunny/dist/mediabunny.d.ts`, not against the docs or memory. Track getters there are async (`getCodec()`, `getDisplayWidth()`, …).
- Always `close()` `VideoSample`/`AudioSample` objects. CanvasSink canvases come from a pool, so draw them immediately.
- MP4/MOV use `fastStart: 'in-memory'` only with `BufferTarget`. Streaming to disk (`StreamTarget` + `showSaveFilePicker`, Chromium only) uses `fastStart: false`.
- HLS output writes many files, so it's greyed out in the UI.
- Real GPU and hardware-encoder numbers need **headed** Chrome. Headless may fall back to software.
- The code is plain JavaScript (converted from TypeScript). Source files are `.js`/`.jsx`, imports stay extensionless, and the worker is loaded as `new URL('../workers/media.worker.js', import.meta.url)`. `jsconfig.json` exists only for editor IntelliSense. There are no type annotations, so use JSDoc comments for anything worth documenting.
