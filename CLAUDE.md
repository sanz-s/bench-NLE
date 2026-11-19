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
  - **Time-axis zoom/pan** (X only), shared by the charts of one view (live, detail, compare): drag across a chart to zoom into that part, ⌘/Ctrl+scroll or pinch to zoom, then drag or swipe sideways to pan. Double-click or Reset shows the whole job. In the live view, a window touching the right edge follows new samples.
  - Chart colors follow entities, using the dataviz palette, validated on `#17181b`. Stage bars use 4 fixed groups so any subset keeps valid neighbour pairs.
- `npm run bench:server`: CPU/GPU sampler for the terminal on :5199. `sudo npm run bench:server -- --powermetrics` adds CPU/GPU power, GPU frequency and Apple Silicon E/P-cluster frequency and active residency (`cpuClusters`). `--process-gpu` (also sudo) adds powermetrics' tasks sampler for per-process GPU time. It's opt-in because it costs ~80 ms/s CPU, and on macOS 26 every task reads 0 GPU ms/s, so the value stays null unless macOS reports it. `npm run test:bench-server` runs the OS-parser fixture tests, the summary-stat tests (`stats.test.mjs`) and a session integration test (`sessions.test.mjs`: starts a server on :5299 with a temp results dir).
- `npm run bench`: builds, starts `vite preview`, drives headed Google Chrome with Playwright through the scenarios in `bench/scenarios.mjs`, and writes `bench-results/*.json|csv`.
  - `npm run bench -- --scenario <id>` runs one scenario.
  - `--runs N` sets the repeat count (median is reported).
  - `--matrix` round-trip-tests every export format/codec combination.
  - `--trace` saves Chrome traces.
  - `--headless` / `--chromium` choose a different browser setup.
  - `--aac auto|native|wasm` picks the AAC encoder under test (default auto). Each row records `audioEncoderImpl`.
  - `--warmup N` (default 1) adds unrecorded warm-up runs per scenario.
  - `--cooldown S` (default 3) pauses between runs; with the bench-server up, it also waits ≤ 20 s for system CPU < `--idle-cpu` (25 %).
  - Capabilities are checked at each scenario's own output size, so an unsupported 4K encode is skipped, not failed.
  - Fixtures: the `h264_*` ones are smooth synthetic content (easy to encode, 1 s GOP), kept for comparability. `camera_1080p30` adds panning fine detail, per-frame sensor noise and a 2 s GOP (`spec.content: 'camera'`, `spec.keyFrameInterval`), and the `*-camera-*` scenarios use it. It's still synthetic. For real footage, put files in `bench/fixtures/` and use `fixture: 'file:<name>'`.
  - `--matrix` tests representative pairings (each video codec with one audio codec, plus each audio codec with the first video codec). `--matrix-all` tests every container × video × audio pairing.
- `npm run bench:mac` / `bench:linux` / `bench:win` (`bench/bench-os.mjs <mac|linux|win>`): one-command benchmark for that OS.
  - Machine checks first (`--check` runs only these): OS match (`--force` overrides), Node, dependencies, Chrome or Playwright Chromium, headed vs headless (Linux without `DISPLAY`/`WAYLAND_DISPLAY` adds `--headless`), AC vs battery, macOS Low Power Mode, and what the sampler can read (clang/procstat and ioreg; /proc, nvidia-smi, AMD sysfs, RAPL; PowerShell and an English UI for the GPU counters). It also warns when `exports.jsonl` isn't writable.
  - Then it starts `bench-server` (`--quiet`, output prefixed `[server]`), runs `vite build` (skip with `--no-build`) and `bench/run.mjs` with every other flag passed through, and stops the server it started. A server already answering on the port is reused and never stopped; it warns when that server is older than `bench-server/` (`/health` `startedAt`).
  - `--bench-port N` also sets `BENCH_SERVER` for vite preview's `/bench-api` bridge, so the page and the runner use the same server. `--no-server` points both at a dead port.
  - `--power`: macOS starts the server with `sudo … --powermetrics`; Linux with sudo for RAPL. Under sudo the server `chown`s the files it creates (results dir, `exports.jsonl`, the procstat binary) back to `SUDO_UID`, which also repairs a file an older sudo run left root-owned.
- `npm run bench:matrix`: round-trips every encodable container × codec (convert, then re-probe).
- `npm run test:regress`: regression tests for the defects found by the 2026-11-18 audits. Each test failed on the unfixed code, except guard tests that are marked as such.
  - `bench/regress.mjs`: export and measurement. Fractional audio tails, copy ignoring audio settings, verifier false positives and the copy heuristic (R1), AAC choice, tab visibility, failed-write cleanup (F4).
  - `bench/editor-regress.mjs`: 33 editor/render tests (E1–E20, F5–F7, F10, job queue). Flags: `--dist <dir> --port <n> --only <substr> --headed`. It uses `window.__nleBench.editor`, which exposes the store, model, compositor and other modules to tests.
  - `bench/summary.test.mjs`: median and acceptance logic.
- `npm run test:ui`: UI smoke tests through the real UI. `bench/ui-smoke.mjs` covers editing; `bench/effects-smoke.mjs` covers text, stickers, filters, transitions, copy/paste and effects exports. Screenshots go to `bench-results/ui-smoke/` and `bench-results/effects-smoke/`.
- `node bench/showcase.mjs [--files a b c] [--export] [--no-sfx] [--test]`: opens headed Chrome on the running dev server (or starts one), imports 3 videos (or waits for you to), builds the all-tools showcase edit (`buildShowcase` in `harness.js`) and leaves the window open. It also imports the synthesized SFX kit from `bench/sfx/` (`node bench/make-sfx.mjs` regenerates it); any asset named `sfx-<name>.wav` is placed on A2+. Export only with `--export`.
- `npx playwright install chromium` is needed only for `--chromium`. The default uses the installed Chrome.

## Architecture (data flow)
- `src/media/`: the Mediabunny-only layer, with no React. It runs in both the main thread and the worker.
  - `extensions.js` `registerAllExtensions()` must run once **in every JS context** (main thread and each worker) before any decode or encode.
    - It registers everything **except the AAC encoder**. Mediabunny tries custom encoders before native WebCodecs, so `prepareAacEncoder(mode, config)` registers the WASM AAC encoder only for `settings.aacEncoder` = `'wasm'`, or `'auto'` (the default) when the browser has no native AAC **for that job's sample rate and channel count**. `runJob` calls it for every job.
    - Each report carries `audioEncoder: { codec, impl: native-webcodecs | wasm-extension | mediabunny-pcm | copy, requested }`.
    - Workers are created per job, so they always get the requested mode. The main thread can't unregister, so after one `'wasm'` main-thread job, later main-thread jobs also use WASM, and the report says so (`note`).
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
- `bench-server/server.mjs` uses Node built-ins plus one small native helper. All OS-output parsing lives in `bench-server/probes.mjs` (pure functions; `npm run test:bench-server` runs fixture tests, macOS fixtures are real captures). Per platform:
  - **macOS:** `bench-server/native/procstat.c` (compiled with clang on first start, gitignored binary; `BENCH_NO_NATIVE=1` disables it) streams pid/ppid/CPU ns/phys_footprint/RSS/path via `proc_pid_rusage`. It costs ~2–3 % of one core, versus ~38 % for `ps` + `top`. Without it: `ps` CPU/RSS, no footprint. GPU from `ioreg` (busiest GPU). VideoToolbox `VTEncoderXPCService`/`VTDecoderXPCService` CPU/memory is recorded separately (`mediaEncoderCpuPct`), because hardware encode runs there and the Media Engine itself is not exposed.
  - **Linux:** `/proc/<pid>/stat` (clock-tick CPU), `smaps_rollup` PSS, `/proc/net/tcp` + fd scan for attribution, NVIDIA `nvidia-smi` (all GPUs, encoder/decoder, power), AMD sysfs `gpu_busy_percent`, RAPL package power. Tested in a Linux container with a fake browser.
  - **Windows (written, UNTESTED):** two long-lived PowerShell loops (they exit with the server): `Win32_Process` (CPU, private bytes, parents) and `Get-Counter` `\GPU Engine(*)` / `\GPU Process Memory(*)` (per engine incl. VideoEncode/Decode, per browser PID). `Get-NetTCPConnection` for attribution. Counter names are English-only.
  - **Which processes count as "the browser"** (`attribution` in each summary's `method`):
    1. `playwright-pid`: Playwright passes the browser PID (`setRootPid`). That root is always kept, whatever its binary is called (e.g. `chrome-headless-shell`).
    2. `socket`: editor exports. The Vite bridge forwards the browser socket's port (`x-bench-peer-port`); `resolveBrowserRoot()` finds the socket's owner (`lsof` on macOS, `/proc/net/tcp` on Linux, `Get-NetTCPConnection` on Windows) and walks up to the browser main process. A WebKit-service owner means Safari (`safari-webkit`: Safari plus all WebKit services). Requests that skip the bridge send `pagePort` instead (`page-port-ambiguous` if several browsers are connected).
    3. `name-match`: fallback. Executable basenames (`BROWSER_EXE_RE` in `probes.mjs`, never whole command lines) plus their descendants.
  - Non-browser children (extension native-messaging hosts, crashpad) are always dropped, except renamed Firefox children on Linux. Firefox child roles (tab, gpu, rdd, socket) map onto Chrome's process types.
  - Each session stores an idle `baseline` (the ~2 s of samples before it started; the sample taken when the session opens belongs to the baseline, not the job).
  - **Sampling window:** session start → the client's `job-end` mark (`jobRunner` sends it right after the job). The server takes one last sample then and ignores later ones, so the main-thread wait, verification and the report never dilute the averages. Each sample carries `dtMs`, and summary averages are **time-weighted** (p95/max per sample). The summary has `sampledMs`, `sampleWindow` and `averaging`.
  - **Overlap:** sessions sampled at the same time are flagged on both sides (`summary.overlap`), because system CPU/GPU/power are shared. Each session has its own process filter (one snapshot, one view per filter), so another browser's job doesn't steal its numbers.
  - **Orphans:** a session with no request for `BENCH_SESSION_TIMEOUT_MS` (default 180 s) expires (`summary.orphaned`). Its samples after the last request are dropped, and it leaves the Live view.
  - `BENCH_RESULTS_DIR` overrides `bench-results/` (used by the tests).
  - **Local only:** requests must come from a `localhost` / `127.0.0.1` / `[::1]` Host. An `Origin`, if sent, must be one of those, so websites can't read or `DELETE` records and DNS rebinding is refused (403). CORS echoes the local origin, never `*`. Bodies are capped at 16 MB (413). `method` also records the CPU, RAM, GPU and power sources. The dashboard detail shows all of them, with a ⚠ for name-match and older records.
- `bench/run.mjs` is the Playwright runner. It adds CDP `Performance.getMetrics` deltas to each in-app report, covering **the job only**: it exposes `__nleBenchGate`, which `jobRunner` awaits right before and after the job. `cdp.window` is `job`, and `cdp.wholeRunTaskMs` keeps the old whole-evaluate number.

## Effects (text, stickers, transitions, filters, animations)
- **Modules:** `src/media/effects/` holds `text.js` (fonts, presets, layout/draw), `stickers.js` (Path2D/emoji library), `filters.js` (presets → `ctx.filter` + overlays for temperature, tint, vignette and grain), `animations.js` (in/out/loop/reveal → per-frame `AnimState`) and `transitions.js` (draw math).
- **Shared rendering:** `compositor.js` `layerItemsAt()` resolves each track at time t into clips or a transition (A + B + eased progress). `frameRequests()` lists the media frames needed, including transition partners past a clip's edge. `drawFrame()` renders them.
  - The preview (`playback.js`), the export (`jobs.js`) and the gallery thumbnails (`components/fxThumbs.js`) all use this same path. Keep it that way, so previews match exports.
- **Video effects** (`effects/fx/videoEffects.js`, 28 effects) are a per-clip stack (`clip.effects`).
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

## Editor rules (from the audit fixes)
- **Locks:** a clip on a locked track can't be changed in any way (move, trim, split, delete, cut, Inspector, paste attributes, effects, transitions). `enforceLocks` in `store.js` runs after every commit and gesture, restores locked clips exactly, and moves clips that land on a locked track off it. The UI also refuses with a toast, and the Inspector shows a read-only fieldset. Known gap: a transition shared between a locked clip and an unlocked neighbour is dropped when the neighbour moves away.
- **Undo never drops media:** history entries carry an asset delta. Undo/redo keep the live asset list, except that undoing an explicit asset removal restores the asset. Gestures read assets from live state, so an import that finishes mid-drag survives. No-op commits add no undo entry.
- **Editor jobs are queued (FIFO):** a second export or convert waits (`status: 'queued'`, cancelable, "N queued" in the top bar), so benchmark sessions don't overlap. The test hooks `exportRange` / `exportToHandle` call `runAndReport` directly and bypass the queue.
- **Outputs:** at most `MAX_OUTPUTS` (10) export Blob URLs are kept. Older ones, and those of trimmed reports, are revoked, and the Bench panel says so.
- **Split keeps animation phase:** the right half gets `phase` / `span` (`clipLocal` / `clipSpan` in `animations.js`), so loops, Ken Burns, text fx and reveals continue across the cut.
- **Timecode:** SMPTE drop-frame (`HH:MM:SS;FF`) for 29.97/59.94, and exact-rate for 23.976. Clip edges snap to the frame grid unless they snap to another clip.
- **Rendering paths:**
  - `drawFrame` clips to the project rect, so letterbox bars stay black in preview and export.
  - A dissolve uses the cheap in-place path only when B is opaque and covers A. Otherwise A·(1−p) and B·p are summed in layers, and one-sided transitions fade.
  - Filter overlays multiply the inherited alpha. Faded or non-video filtered clips render isolated, then composite once at clip alpha. Both cost extra full-frame layers, so composite times differ from older runs for those edits.
- **Motion Trail:** each ghost shows the clip's own PAST frame. `frameRequests` returns `{ key: '<clip>#g<i>' }` requests, export and preview use `key ?? clip.id` for their reader and frame maps, and each ghost costs one extra decoder. Gallery thumbnails still draw the current frame.
- **Audio mix:** 3/4/5/6/8-channel down-mix keeps the centre channel. The mix buffer grows by doubling. The resampler is still linear (no anti-aliasing).

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
- **Encode wait (`derived.encodeWaitMs`, was `encodeMs`):** time spent awaiting `source.add()` (encoder queue back-pressure) plus the finalize flush. It is not encoder busy time: a decode-bound job reads ~0 while the encoder works. Use `encoder.encoderSpan` (first video submit → last video packet) and the latency numbers for encoder work.
- **`derived.pipelineFps` (was `encodeFps`):** output frames ÷ total job time, i.e. end-to-end throughput. Conversion frame counts are estimated from duration × fps. `hwPreference` is the *requested* hardware mode; the browser doesn't say which path ran.
- **Encoder latency:** submit → `onEncodedPacket`, per frame.
- **Decode time:** time awaiting frames from sinks.
- **Mediabunny `Conversion` jobs:** only total, init and time-to-first-progress can be measured, because decode and encode are pipelined internally. Use the "manual pipeline" engine for a per-stage split.
- **Composite time** only counts 2D command submission. Canvas raster and readback land in encode wait (inside `CanvasSource.add`).
- **TBT** is usually 0 even on the main thread, because the pipeline yields each frame. Compare modes with CDP `cdp_mainTaskMs`.
- **Extra per-job fields:**
  - `browserFootprintMB`: the real footprint. Prefer it to `browserRssMB`, which over-counts shared memory.
  - `baseline`: idle CPU/GPU and `backgroundLoad` before the job.
  - `conditions`: power source, low-power mode, thermal state.
  - `samplerOverhead`: the server's own CPU, its probes, and spawns per sample.
  - `report.memory`: main-thread JS heap peak (always on). It's stopped before output verification.
  - `report.visibility`: whether the tab was hidden during the job (`hiddenMs`, `changes`, `startedHidden`). A hidden tab throttles timers, rAF and main-thread jobs, so the dashboard flags it ⚠.
  - Page + workers memory via `measureUserAgentSpecificMemory` is opt-in (`localStorage['bench.pageMemory'] = '1'`). Chrome answers at a GC it may trigger mid-export (about 13 s in testing), so it is off by default, and jobs shorter than that get null.
  - CPU baselines are kept for every pid, so the first sample of a job has a value.
- **CPU/GPU/RAM limits (known):**
  - Media Engine load and per-tab attribution inside a user's own Chrome are not measurable.
  - macOS per-process GPU: powermetrics lists a GPU ms/s column but reports 0.00 for every task on macOS 26 (`--process-gpu` picks it up if that changes).
  - Safari is a WebKit name group, shared with other WebKit apps.
  - Windows paths are untested.
  - **Native vs WASM AAC sizes differ:** on macOS Chrome the native AAC encoder wrote ~47 kb/s for the synthetic fixture tone, where the WASM encoder wrote ~194 kb/s for the same requested quality (2026-11-18, `bench/regress.mjs` B1). So compare encode speed between the two with output size in mind.
- **Output verification:** `verifyOutput` (in `jobRunner.js`) re-probes each output and decodes it (`decodeCheck` in `probe.js`).
  - **Checks:** the tracks the job meant to write are present (`result.tracks`); codecs; container (output-format MIME vs re-probed MIME); size; frame rate (±2 %); audio sample rate (except codec-imposed rates, e.g. Opus at 48 kHz) and channels.
  - **Durations, per track** (`result.trackDurations`): video within ±1 frame; audio within the codec's priming plus padding (`AUDIO_SLACK`: AAC 2112+2048 samples, measured over a full length sweep; MP3, Opus …; PCM ±1 sample). Mediabunny keeps encoder priming in the timeline, so AAC tracks run ~45–90 ms long.
  - **No stream-copy exemption.** Copy only happens when codec, size and fps (audio: codec, rate, channels) already match the request, so size, fps and frame count are always checked against the request.
  - **Decode depth:** by default the first 3 frames and samples **plus the last video frame and the final ~0.25 s of audio**, which catches truncated files. Full decode (every frame and sample, with the frame count and audio length compared) is on for `--matrix`, and opt-in with `--full-verify` or `localStorage['bench.fullVerify'] = '1'`. `verify.depth` records which one ran.
  - `status: 'done'` only means the job ran; `verify.ok` is the content check.
  - `bench/run.mjs` (`bench/summary.mjs`) reports the **median run**, a real run picked by conversion time rather than a column-wise median. It's chosen only from runs that finished, verified, ran in a visible tab and didn't overlap another job. The runner exits 1 if any run fails one of those.
- **Audio progress in exports** is an integer sample cursor (`audioPos` / `audioTotal` in `jobs.js`). Never compare a float audio time against the duration: a sub-sample remainder used to hang the export.
- **Conversion stream copy** happens only when codec, sample rate **and** channel count already match the request (`audioSame` in `jobs.js`).
- **Failure cleanup:** `exportProject` and `runConversion` run inside `try` / `catch` / `finally`. On any error or cancel they call `output.cancel()` and `handle.fail()`, which aborts a streamed file's writable. Readers, decoders, the asset pool and the input are always disposed. Audio samples are closed even if `add()` throws.

## Gotchas
- COOP `same-origin` and COEP `require-corp` are required. The extension WASM uses shared-memory threads, so without them it falls back to a slower path and skews the benchmarks. Don't load cross-origin resources (fonts, CDNs) without CORP/CORS.
- Check Mediabunny API names against `node_modules/mediabunny/dist/mediabunny.d.ts`, not against the docs or memory. Track getters there are async (`getCodec()`, `getDisplayWidth()`, …).
- Always `close()` `VideoSample`/`AudioSample` objects. CanvasSink canvases come from a pool, so draw them immediately.
- MP4/MOV use `fastStart: 'in-memory'` only with `BufferTarget`. Streaming to disk (`StreamTarget` + `showSaveFilePicker`, Chromium only) uses `fastStart: false`.
- HLS output writes many files, so it's greyed out in the UI.
- Real GPU and hardware-encoder numbers need **headed** Chrome. Headless may fall back to software.
- The code is plain JavaScript (converted from TypeScript). Source files are `.js`/`.jsx`, imports stay extensionless, and the worker is loaded as `new URL('../workers/media.worker.js', import.meta.url)`. `jsconfig.json` exists only for editor IntelliSense. There are no type annotations, so use JSDoc comments for anything worth documenting.
