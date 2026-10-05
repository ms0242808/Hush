# Hush (靜) — In-Browser Photo Denoiser — Build Spec

**Status:** final v4 · **Licence:** Apache-2.0 · **Hosting:** Cloudflare Workers static assets, free plan · **Languages:** `en`, `zh-Hant` · **Platform this phase:** desktop browser first

> **How to use this document.** This is a build prompt for a coding agent. Hand it over **one phase at a time** (§8) with §1–§6 as standing context. Phase 0 is a feasibility spike with a go/no-go gate — do not let the agent skip it and start on UI.
>
> 🟡 marks decisions I inferred that you haven't explicitly confirmed. §12 lists what's still open.

### Changes in v4 (final)

| Finding                                                                                                        | Effect                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **darktable 5.6 (June 2026) added free, open-source AI denoise** — the closest existing tool                   | Positioning rewritten around it (§1.3). darktable becomes the Phase 0 quality and speed benchmark.                                    |
| **Hands-on test: darktable's interface felt overwhelming, and exporting the denoised photo failed on Windows** | New §5.13 turns those failures into requirements: no import step, no library, save location always visible, no silent write failures. |
| **NIND UNet** is darktable's default denoise model, trained on real camera photos rather than smartphones      | Added as an optional third candidate in the Phase 0 spike, subject to the same three-part licence check (§4.6).                       |
| **Web app vs Electron**                                                                                        | Web app now. Desktop later with **Tauri, not Electron**, because Electron can't build the planned iOS and Android apps (§10.2).       |

### Changes in v3.1

| Decision                                | Effect                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Name: Hush (靜)**                     | `APP_NAME` = **Hush** everywhere. Availability checks in §0 are now a to-do list.                                                         |
| **Licence: Apache-2.0**                 | Confirmed (§9.1).                                                                                                                         |
| **Custom domain already on Cloudflare** | Production runs on your domain; `*.workers.dev` only for previews (§9.3).                                                                 |
| **"What if there's no GPU?"**           | New §2.10 (detection and CPU path) and §5.12 (what the user sees). CPU throughput added to the Phase 0 measurements and the §4.6 targets. |

All §12 open questions are resolved.

### Changes from v2

| Your answer                                              | Effect on this spec                                                                                                                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Photos are mostly 24 MP or 45 MP**                     | Pipeline sized for 45 MP as the normal case and 61–102 MP as the ceiling. Row-band processing added so memory stays flat (§2.3). Large-batch behaviour — long runs, resume, split ZIPs — added (§2.7, §2.8).           |
| **Four sliders**                                         | Confirmed.                                                                                                                                                                                                             |
| **Performance targets**                                  | Kept, restated as megapixels per second so they apply to 45 MP too, with go / borderline / no-go bands and Lightroom context (§4.6).                                                                                   |
| **Open source, self-deployable**                         | New §9 on licence, repo layout and self-hosting. The whole app is now a static site plus model files that anyone can deploy anywhere.                                                                                  |
| **Future photo editor**                                  | Presets become an _edit recipe_ — an ordered list of operations — at zero extra cost now (§4.5).                                                                                                                       |
| **Drop Analytics; Firebase and Cloudflare both allowed** | Moved hosting to **Cloudflare**, where static files have no bandwidth cap. Firebase isn't needed this phase at all. Remote Config replaced by a static manifest file. The app now talks only to its own origin (§4.7). |
| **Cloudflare R2**                                        | Kept as an _option_, not the default — R2 requires a payment method on file even for its free tier. Serving the model as static files avoids that entirely (§6.3).                                                     |

---

## 0. Name candidates

| Name           | 中文     | Why it works                                                                                                   | Watch out for                         |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Hush** ⭐    | 靜       | Noise → silence. One syllable, one character, same idea in both languages. Works as a verb: "hush this photo." | Common word — needs a modifier domain |
| **BaseISO** ⭐ | 低感     | Insider language: shot at ISO 6400, looks like base ISO                                                        | Opaque to non-photographers           |
| **澄** (Cheng) | 澄       | Water going still until the sediment settles. 澄清 = to clarify.                                               | Needs an English wordmark             |
| **Blue Hour**  | 藍調時刻 | The hour photographers push ISO                                                                                | Likely taken                          |
| **Stillwater** | 止水     | 心如止水 — still water, no ripples, no grain                                                                   | Common place name                     |
| **Nightglass** | 夜鏡     | Low-light, lens-adjacent                                                                                       | Vague                                 |
| **Sieve**      | 篩       | Filters grain, keeps the image                                                                                 | Kitchen connotation                   |
| **Grainless**  | 無粒     | Zero explanation needed                                                                                        | Some photographers love grain         |

**Chosen: Hush (靜).** It also survives the project growing into a general open-source photo editor (§4.5), since it isn't literally about noise.

**To-do before the repo goes public:** [TIPO trademark search](https://twtmsearch.tipo.gov.tw/) for 靜 / Hush in the software class, and claim the **GitHub organization**, **npm scope** and **Hugging Face organization** — pick one handle and use it for all three (e.g. `hush-photo`), since `hush` alone is almost certainly taken. The domain is already yours. App-store names can wait for the native phase.

`APP_NAME` throughout this document = **Hush** (UI) / **靜** (zh-Hant UI).

---

## 1. What we're building

### 1.1 One-liner

An open-source, no-install, no-upload photo denoiser that runs the NAFNet neural model **entirely in the photographer's browser on their own GPU**, for one photo or a whole shoot — and that anyone can host themselves as a folder of static files.

### 1.2 Three decisions everything else follows from

**Processing happens on the user's device.** WebGPU runs the model on the photographer's own GPU. Zero compute cost, zero image bandwidth, works offline once cached, and "your photos never leave this device" is a fact rather than a policy.

**The app is a static site.** HTML, JavaScript, WASM and model files. No server code, no database, no accounts, no telemetry. That makes it free to host, trivial to self-host, and easy to audit.

**It talks only to its own origin.** Everything — runtime, codecs, fonts, model — is served from the same place as the page. A Content-Security-Policy of `connect-src 'self'` enforces it, and anyone can confirm it in their browser's network panel. For a privacy claim aimed at professionals handling client work, that's the strongest proof available short of reading the code — and the code is open too.

### 1.3 Who it's for

Photographers who want a quick, good denoise without opening Lightroom: event and wedding shooters with a batch of high-ISO JPEGs to deliver, people editing away from their main machine, studios that want a private tool on their own network, anyone who wants a second tool that's always one link away.

**Positioning.** Lightroom's AI Denoise, DxO PureRAW and Topaz are better on RAW and nobody should pretend otherwise.

**The closest alternative is darktable 5.6** (June 2026): free, open source, local, on Windows with a Traditional Chinese interface, and with AI denoise ("neural restore") including RAW-to-DNG. So "free", "open source" and "private" are not differentiators on their own. darktable is a professional RAW workflow application: it needs an install, an AI setup step, a model download, an import into its library, and familiarity with a dense interface — and in hands-on testing, exporting the result failed on Windows.

`APP_NAME` wins on **zero friction**: open a link, drop photos, get clean photos back. No install, no setup, no library, no learning curve — the one job done obviously. Everything in this spec should be judged against that promise. GIMP, the other common free option, uses traditional filters that trade noise for blur, and isn't a serious competitor on quality.

### 1.4 Rules

- **No landing page.** The root URL _is_ the tool. First paint is a drop zone.
- **No sign-in, no accounts, no analytics, no cookies.**
- Single photo or batch. Typical photo: **24 MP or 45 MP**.
- Language auto-detected: `zh-Hant` or `en`, English fallback.
- **Desktop browser first.** Chrome, Edge and Safari on Windows and macOS are the tested targets. Phones and tablets work best-effort.

### 1.5 Out of scope for this phase

RAW files, native apps, accounts and cloud sync (all planned in §10). Server-side processing. 16-bit output. Operations other than denoise — but the pipeline and preset format are built for them (§4.5).

---

## 2. The processing pipeline

**This is the product.** Build it first, behind tests, before any UI is pretty.

### 2.1 Stages

```
File ─▶ Decode ─▶ Tile ─▶ Infer ─▶ Band accumulate ─▶ Adjust ─▶ Encode ─▶ Metadata ─▶ Save
         WASM      TS     WebGPU        TS              TS        WASM        TS
                          / WASM
```

All stages run in a **Web Worker**; the main thread only draws UI. Buffers move between threads as `Transferable`s, never copied.

### 2.2 Decode — never through a canvas

Browser canvases have size ceilings that photographer-sized images hit. Decode with WASM codecs straight to raw pixel buffers:

| Input       | Decoder                   | Notes                                                                                     |
| ----------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| JPEG        | `@jsquash/jpeg` (MozJPEG) | The main case                                                                             |
| PNG         | `@jsquash/png`            | 8-bit this phase                                                                          |
| WebP        | `@jsquash/webp`           |                                                                                           |
| HEIC / HEIF | `libheif-js`              | iPhone photos on a desktop. Lazy-loaded. LGPL — kept as a separately loaded module (§9.1) |
| AVIF        | `@jsquash/avif`           | Lazy-loaded                                                                               |
| RAW         | —                         | ❌ Next phase (§10.1)                                                                     |

Canvas is used **only for the on-screen preview**, which is always a crop or a downscale.

### 2.3 Tiling and row-band accumulation

NAFNet can't take a 45 MP photo in one pass. Split into overlapping tiles:

- **Tile size** from WebGPU adapter limits plus a probe run; typically 256–768 px, always a multiple of the model's padding requirement (read from the manifest, §4.3).
- **Overlap** 32–64 px, with each tile's output weighted by a **cosine feather window** so no grid appears at 100%.
- **Reflection padding** at image edges.
- **Tiles run in row-major order, sequentially.**

**Row-band accumulation — required at 45 MP.** The naive approach keeps a full-image float accumulation buffer plus a weight buffer. For a 45 MP photo that's over half a gigabyte before anything else, and a 61 MP or 102 MP file tips a browser tab over. Instead:

- Keep only a **band** of rows in float: one tile height plus the overlap.
- When all tiles overlapping a row have been processed, that row is final: normalize it, apply the adjust step (§2.5) using the matching original rows, and write it straight into the 8-bit output buffer.
- Slide the band down.

Peak float memory drops from "whole image" to "one band" — roughly 80 MB for an 8192-px-wide photo instead of 540 MB — and it's the same regardless of photo height.

**Failure handling:**

- GPU out-of-memory → halve the tile size, retry that tile, remember the smaller size for the session.
- `GPUDevice.lost` → recreate the device, reload the session, resume from the current band. Never restart the photo.

### 2.4 Inference

- **Runtime:** ONNX Runtime Web, execution providers `['webgpu', 'wasm']`.
- **WebGPU** is primary and ships by default in current Chrome, Edge, Safari 26 and Firefox on Windows and Apple-silicon macOS.
- **WASM** is the fallback, roughly an order of magnitude slower. Because the page is cross-origin isolated (§4.4), the fallback runs **multithreaded**, which recovers a good part of that gap on a multi-core laptop. When it's the only option, the UI says so before the user starts — see §2.10.
- **fp16** when the adapter exposes `shader-f16`; fp32 otherwise. Both listed in the manifest.

### 2.5 Adjust — why the sliders feel instant

Run inference **once**. Every slider is a cheap blend between original and denoised:

| Control             | Implementation                                                                         |
| ------------------- | -------------------------------------------------------------------------------------- |
| **Strength**        | `out = lerp(original, denoised, strength)`                                             |
| **Luminance noise** | Blend the Y channel (YCbCr) with this weight                                           |
| **Colour noise**    | Blend Cb/Cr independently of luma                                                      |
| **Detail**          | Add back a fraction of the original's high-frequency band: `original − blur(original)` |

On the preview crop this runs at 60 fps. On export it runs per finalized row inside the band loop, so no full-size denoised buffer is ever held.

### 2.6 Encode and metadata

Encoding goes through WASM (`@jsquash/*`), not canvas.

- **EXIF**: read with `exifr`, re-inject into the output (APP1 for JPEG, `eXIf` for PNG, EXIF chunk for WebP). Set `Software` to `APP_NAME`; keep everything else.
- **Orientation**: never rotate pixels. Keep the tag; rotate only when drawing the preview. Rotating pixels _and_ keeping the tag turns every portrait photo sideways.
- **ICC profile**: extract and re-embed byte-for-byte; decode without colour conversion so Display P3 and Adobe RGB round-trip.
- **HEIC in → JPEG out** by default, carrying EXIF and ICC.
- **Remove location**: opt-in toggle, off by default.
- **Format** defaults to input (except HEIC). JPEG quality defaults to 🟡 **95**.
- **Filename**: `name-denoised.ext`, suffix configurable.

### 2.7 Batch queue — built for long runs

At 45 MP, a 400-photo wedding batch on a mid-range laptop is an **hours-long job** — as it is in Lightroom. Design for that honestly:

```
queued → decoding → processing (band n / m) → encoding → saved
                                              ↘ failed (reason, retry)
                                              ↘ skipped (already exported)
                                              ↘ cancelled
```

- One photo at a time; overall progress weighted by megapixels.
- **ETA** from measured throughput, and allowed to say hours: "About 3 h 40 min left. Keep this laptop plugged in."
- **Screen Wake Lock** while running. `beforeunload` warning.
- Pause, resume, cancel, retry failed.
- **Resume after a crash or reload:**
  - **Save to folder** (Chrome, Edge): on restart, any photo whose output already exists in the destination folder is marked _skipped_. Input and output folder handles are kept in IndexedDB, so after a reload the user grants permission once and the batch continues where it stopped.
  - **ZIP** (Safari, Firefox): completed ZIP parts are already downloaded (§2.8); the user re-drops the remaining files.
- Settings shared across the batch; per-photo overrides later.

### 2.8 Saving results

| Method                                     | Where                   | Why                                                                                                                                                                                |
| ------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Save to folder** (`showDirectoryPicker`) | Chrome, Edge desktop    | Best for batch: each file writes as it finishes, memory stays flat, enables resume                                                                                                 |
| **ZIP in parts** (streamed, `client-zip`)  | Safari, Firefox desktop | 400 × 45 MP JPEGs is several gigabytes. Split into parts of 🟡 ≤ 1 GB, each downloaded as it completes, so nothing huge is ever held in memory and a crash loses at most one part. |
| **Single download**                        | Everywhere              | One photo                                                                                                                                                                          |
| **Share sheet**                            | Phones, best-effort     | "Save to Photos"                                                                                                                                                                   |

The UI recommends Chrome or Edge for batches over 🟡 50 photos, and says why.

### 2.9 Device limits

- Detect on load: WebGPU adapter and limits, `shader-f16`, `navigator.deviceMemory` where available.
- 🟡 Per device class, maximum photo size: **high** 102 MP (medium format), **standard** 61 MP, **constrained** 24 MP.
- Over the limit → a clear message with options, never a silent tab crash.

### 2.10 No usable GPU

**"No GPU" is rarer than it sounds.** Almost every laptop has an _integrated_ GPU — Intel Iris Xe or UHD, AMD Radeon graphics, the GPU inside Apple silicon — and WebGPU uses it. A laptop without a separate graphics card is exactly the "mid-range laptop, integrated GPU" row in §4.6, not a failure case.

When WebGPU genuinely isn't usable, it's one of four situations. Detect which, because each has a different fix:

| Situation                                                                                            | How it's detected                                                                                                                  | What Hush does                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The browser can't use WebGPU, but the GPU is fine** — older Safari, Firefox on Linux or Intel Macs | `navigator.gpu` missing or `requestAdapter()` returns `null`, but WebGL reports a real GPU renderer                                | Suggest the fix first: "This computer has a graphics chip this browser can't use. Chrome or Edge will be much faster." Still allow the CPU path. |
| **Hardware acceleration is off, or the browser has blocklisted the graphics driver**                 | No WebGPU, and WebGL reports a _software_ renderer (SwiftShader, "Microsoft Basic Render Driver", llvmpipe) on an ordinary desktop | Show per-browser steps to turn hardware acceleration on, and suggest updating graphics drivers. Allow the CPU path.                              |
| **A software WebGPU adapter**                                                                        | `adapter.info.isFallbackAdapter === true`                                                                                          | **Never use it.** CPU-emulated WebGPU is slower than WASM. Go straight to the WASM path.                                                         |
| **Genuinely no GPU acceleration** — virtual machines, remote desktop, some cloud PCs                 | Software WebGL renderer, no WebGPU                                                                                                 | CPU path with honest estimates.                                                                                                                  |

The WebGL renderer string is only a hint (some browsers mask it for privacy), so treat it as "which message to show", never as a gate.

**The CPU path:**

- ONNX Runtime **WASM with SIMD and multithreading** (cross-origin isolation, §4.4), using `navigator.hardwareConcurrency − 1` threads so the interface stays responsive.
- **fp32** model variant — fp16 brings no speed benefit on the CPU path.
- 🟡 **Try an int8-quantized NAFNet in Phase 0.** Quantization often makes convolutional models 2–3× faster on CPU at some quality cost. If the quality holds up on the test set, add it to the manifest as the CPU variant.
- **Expected speed:** roughly an order of magnitude slower than an integrated GPU — 🟡 on the order of **3–10 minutes for a 24 MP photo** on a modern 8-core laptop, and about twice that at 45 MP. These are estimates; Phase 0 replaces them with measurements.
- **Per-machine estimate before committing:** on first use, time a single tile and extrapolate, so the user sees "about 6 minutes per photo on this computer" _before_ pressing Export — not after waiting.
- **Preview stays usable:** the preview crop shrinks to about 512 × 512 on CPU so it renders in seconds, and **the sliders stay instant** because they blend already-computed results (§2.5) rather than re-running the model. The CPU path is where that design pays off most.
- **Batches are allowed, never blocked.** The photographer decides — but they decide with a total estimate in front of them (§5.12).
- **Manual override** in Advanced settings — _Processing: Automatic / Graphics chip / Processor_ — for troubleshooting a buggy graphics driver, and for reproducing bug reports.

**What improves this later.** The native apps (§10.2) run ONNX Runtime natively on the CPU, which is considerably faster than WASM, and can use the **NPUs** now common in Windows laptops (Intel Core Ultra, AMD Ryzen AI, Snapdragon X) through DirectML or QNN. For CPU-only Windows users, the native app is the real answer. In the browser, WebNN could eventually reach NPUs too, but it's still maturing — revisit it when planning the native phase.

---

## 3. Stack

| Layer            | Choice                                                                  | Notes                                                               |
| ---------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Build            | **Vite** + React 18 + TypeScript strict                                 |                                                                     |
| UI               | **Tailwind** + **shadcn/ui**                                            |                                                                     |
| Motion           | **motion**                                                              | `LazyMotion` + `domAnimation`; sparingly (§5.7)                     |
| Workers          | **Comlink**                                                             |                                                                     |
| Inference        | **ONNX Runtime Web**                                                    | WebGPU + WASM EPs; **self-hosted**, not from a CDN                  |
| Model            | **NAFNet** (SIDD weights) → ONNX                                        | SCUNet as the prepared fallback (§4.6)                              |
| Codecs           | **@jsquash/\*** (jpeg, png, webp, avif), **libheif-js**                 | Self-hosted, lazy-loaded per format                                 |
| Metadata         | **exifr** + small in-house segment writer                               |                                                                     |
| Batch output     | **client-zip**, File System Access API                                  |                                                                     |
| State            | **Zustand**                                                             |                                                                     |
| Persistence      | `localStorage` (settings, recipes), IndexedDB (history, folder handles) | Nothing server-side                                                 |
| Fonts            | Self-hosted Latin display face, **system CJK stack** for Chinese        | No Google Fonts — it would break `connect-src 'self'`               |
| i18n             | i18next + react-i18next + browser-languagedetector                      |                                                                     |
| PWA              | vite-plugin-pwa                                                         | Phase 4                                                             |
| **Hosting**      | **Cloudflare Workers — static assets only**                             | No Worker script; free and unmetered (§6)                           |
| Model publishing | **Hugging Face Hub** (public model repo)                                | Source of truth for converted weights; fetched at build time (§6.3) |
| Firebase         | **Not used this phase**                                                 | Returns if accounts are added (§10.3)                               |
| CI/CD            | **GitHub Actions**                                                      | Free for public repositories                                        |
| Tests            | Vitest, Playwright                                                      |                                                                     |
| Monorepo         | pnpm workspaces                                                         | §9.2                                                                |

---

## 4. Architecture

### 4.1 Runtime layout

```
┌──────────────────── Browser tab ────────────────────┐
│ Main thread: React UI · preview canvas · live blend  │
│        │ Comlink                                     │
│        ▼                                             │
│ Pipeline worker (packages/core + packages/ops)       │
│   decode · tile · band · NAFNet · adjust · encode    │
└──────────────────────────────────────────────────────┘
                     │  same origin only
                     ▼
     Cloudflare static assets (or any static host)
     /             app shell
     /ort/         ONNX Runtime WASM
     /codecs/      jsquash, libheif
     /models/      manifest.json + NAFNet parts
```

Photos flow only inside the box.

🟡 **Verify in Phase 0:** WebGPU inside a dedicated worker on Safari 26 (macOS) and Chrome/Edge (Windows). If a browser fails, run the ORT session on the main thread for that browser only.

### 4.2 No backend

There is nothing server-side: no database, no functions, no accounts, no analytics. Settings and edit recipes live in `localStorage`; history and folder handles in IndexedDB. Recipes export and import as JSON files to move between computers.

### 4.3 The model manifest

A static file, `/models/manifest.json`, lists the available models. **Switching NAFNet → SCUNet means editing this file and pushing** — CI redeploys in a minute or two. No code changes.

```json
{
	"schema": 1,
	"active": { "denoise": "nafnet-sidd-w32" },
	"models": [
		{
			"id": "nafnet-sidd-w32",
			"family": "nafnet",
			"task": "denoise",
			"label": { "en": "NAFNet", "zh-Hant": "NAFNet" },
			"variants": [
				{
					"precision": "fp16",
					"bytes": 0,
					"sha256": "…",
					"parts": ["nafnet-sidd-w32.fp16.onnx.000", "nafnet-sidd-w32.fp16.onnx.001"]
				}
			],
			"tile": { "padMultiple": 16, "overlap": 48 },
			"input": { "range": [0, 1], "layout": "NCHW", "colour": "RGB" },
			"source": { "repo": "https://huggingface.co/…", "revision": "<commit sha>" },
			"licence": {
				"code": "MIT (NAFNet) + Apache-2.0 (BasicSR)",
				"weights": "MIT (NAFNet repo)",
				"trainingData": "SIDD — MIT"
			}
		}
	]
}
```

- The pipeline reads `tile` and `input` from here rather than hard-coding them — that's what makes a model switch config-only.
- `parts` exists because Cloudflare static assets cap each file at 25 MiB (§6.2). The client fetches parts in parallel, concatenates, and verifies the whole file's `sha256` before handing it to ORT.
- `licence` is shown in the app's About panel. For an open-source project that redistributes weights, attribution isn't optional.
- `?model=<id>` URL override for side-by-side testing. Harmless to leave in production builds.
- `manifest.json` is served with `Cache-Control: no-cache`; model parts are content-addressed and immutable.

### 4.4 Headers and cross-origin isolation

Because everything is same-origin, **cross-origin isolation is now trivial**: `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. That unlocks `SharedArrayBuffer`, which makes the WASM fallback multithreaded.

Headers are set in a `_headers` file (Cloudflare) — 🟡 verify in Phase 0 that assets-only Workers apply it — and equivalent config is provided for other hosts (§9.3).

### 4.5 Built to grow: portable core, edit recipes

**Portable core — for the native apps next phase.** The pipeline has no browser assumptions; every platform capability sits behind an adapter:

```
packages/core   pure TypeScript — tiling, band accumulation, feather, adjust math, queue,
                metadata splicing, manifest and recipe handling. No DOM, no Web APIs.
packages/ops    ImageOperation implementations (NAFNet now; SCUNet, RAW, others later).
apps/web        React UI + browser adapters.
```

```ts
interface PlatformAdapters {
	codecs: {
		decode(bytes: Bytes, hint: Format): Promise<RawImage>;
		encode(img: RawImage, opts: EncodeOpts): Promise<Bytes>;
	};
	inference: { createSession(model: ModelVariant): Promise<InferenceSession> };
	storage: { getModel(sha256: string): Promise<Bytes | null>; putModel(sha256: string, b: Bytes): Promise<void> };
	output: { save(name: string, bytes: Bytes): Promise<void> };
}

interface RawImage {
	width: number;
	height: number;
	channels: 3 | 4;
	bitDepth: 8 | 16 | 32; // 8 this phase; the field exists so an editor can grow into 16/float
	colourSpace: 'srgb' | 'display-p3' | 'adobe-rgb' | 'linear' | 'icc';
	icc?: Bytes;
	data: Uint8Array | Uint16Array | Float32Array;
}
```

A lint rule forbids `window`, `document`, `navigator` and `lib.dom` types in `packages/core` and `packages/ops`. Their unit tests run in plain Node, which proves the boundary holds.

**Edit recipes — for the photo editor later.** You mentioned this might become an open-source photo editor. The cheapest thing to do about that _now_ is the preset format. Instead of flat denoise settings, a preset is an ordered list of operations:

```json
{
	"schema": 1,
	"name": "Wedding reception",
	"ops": [
		{
			"op": "denoise",
			"model": "nafnet-sidd-w32",
			"params": { "strength": 0.7, "luma": 0.8, "colour": 1.0, "detail": 0.3 }
		}
	]
}
```

This phase, `ops` always has exactly one entry. When sharpening, exposure or crop arrive, they append to the list — every saved preset still loads, and a recipe becomes the natural format for non-destructive editing (the same idea as Lightroom's XMP sidecars). The pipeline takes a recipe, not a settings object.

```ts
interface ImageOperation {
	id: string; // 'denoise'
	tiling?: { padMultiple: number; overlap: number; scale: 1 | 2 | 4 }; // absent for per-pixel ops
	controls: ControlSchema[]; // drives the settings panel
	load(ctx: OpContext): Promise<void>;
	run(input: RawImage | Band, params: Params): Promise<RawImage | Band>;
	dispose(): void;
}
```

Do **not** build a second operation, a layer system, or an undo history this phase. Just don't make them hard.

### 4.6 The model: NAFNet first, SCUNet if needed

**Primary: NAFNet, SIDD weights, width-32.** Strong on real sensor noise; its plain convolutional design converts cleanly to ONNX and suits WebGPU. Benchmark width-64 in the spike as a possible high-quality option for strong GPUs.

**Fallback: SCUNet**, a Swin-Conv hybrid built for blind real-world denoising.

🟡 **Optional third candidate: NIND UNet** — darktable 5.6's default denoise model, trained on the Natural Image Noise Dataset of real camera photos rather than SIDD's smartphone captures, so potentially a better fit for photographers' noise. darktable publishes its models as ONNX in the `darktable-ai` repository with source, training data and licence documented. It enters the manifest only if the code, weights and training data all pass the redistribution check, exactly as NAFNet did.

**Performance targets, as throughput** so they cover 24 MP and 45 MP:

| Machine                                                     | Go                                      | Borderline                                            | No-go                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mid-range laptop, integrated GPU** (Chrome/Edge, Windows) | ≥ 0.8 MP/s — 24 MP ≤ 30 s, 45 MP ≤ 56 s | 0.4–0.8 MP/s — ship with honest ETAs, keep optimizing | < 0.4 MP/s — 24 MP over a minute                                                                                                                     |
| **Strong machine** (Apple silicon Pro/Max, discrete GPU)    | ≥ 2.4 MP/s — 24 MP ≤ 10 s, 45 MP ≤ 19 s | 1.2–2.4 MP/s                                          | < 1.2 MP/s                                                                                                                                           |
| **Preview crop** (~1 MP, model cached, WebGPU)              | ≤ 1.5 s everywhere                      | ≤ 3 s                                                 | > 3 s                                                                                                                                                |
| **CPU only** (WASM, 8-core laptop, §2.10)                   | ≥ 0.08 MP/s — 24 MP ≤ 5 min             | 0.04–0.08 MP/s                                        | < 0.04 MP/s — 24 MP over 10 min. Not a no-go for the project: it means the CPU path gets a quantized model or a stronger "use a GPU" recommendation. |

**Context:** these are at or slightly ahead of what Lightroom's AI Denoise does on comparable hardware, so they're ambitious but not unreasonable for a browser. **The preview number matters most** — it decides whether the tool _feels_ fast. Export time decides whether a batch finishes over lunch or overnight, and photographers already accept overnight for big jobs.

**What large batches mean in practice**, at the "go" line on a mid-range laptop: 20 × 24 MP ≈ 10 minutes; 400 × 45 MP ≈ 6 hours. That's why §2.7 treats resume and honest multi-hour ETAs as requirements, not extras.

**When to switch:**

| Problem                                                                                | Try first (still NAFNet)                                      | Switch to SCUNet?                                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Quality**: smeared texture, waxy skin, colour blotches, JPEG blocks smoothed to mush | Lower default strength; more detail recovery; try width-64    | ✅ Yes — this is what SCUNet is for                                                                       |
| **Quality**: very heavy noise (ISO 12800+) or unusual noise                            | —                                                             | ✅ Yes                                                                                                    |
| **Speed** below target                                                                 | fp16, larger tiles, width-32, confirm WebGPU is really in use | ⚠️ **Probably not** — SCUNet's attention layers are generally heavier per pixel. Measure before assuming. |
| **Compatibility**: ONNX op unsupported on WebGPU somewhere                             | Re-export with a different opset                              | Only if SCUNet exports cleaner                                                                            |

**Quality evaluation:** ~30 high-ISO photos across camera brands at 24 and 45 MP, including compressed JPEGs and iPhone HEICs. Compare 100% crops side by side, blind where possible. PSNR is for regression tests, not for deciding whether photographers like it.

✅ **Licences checked (September 2026) — redistribution is permitted:**

| Component                                         | Licence                                                                       | Source                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| NAFNet code                                       | MIT, © 2022 megvii-model                                                      | `LICENSE` in `megvii-research/NAFNet`         |
| BasicSR code bundled in that repo                 | Apache-2.0, © 2018–2020 BasicSR Authors                                       | Same `LICENSE` file                           |
| SIDD dataset (training data for the SIDD weights) | MIT                                                                           | Official SIDD project page, "License" section |
| NAFNet pretrained weights                         | Not named separately — covered by the repo's MIT licence by the usual reading | See the residual-risk note below              |

**Obligations this creates:** keep the MIT copyright notice for NAFNet in `THIRD_PARTY_NOTICES`, the Hugging Face model card and the About panel; state in the model card that the files are ONNX conversions of the original PyTorch checkpoints (and which are fp16 or quantized); cite the NAFNet and SIDD papers. If any BasicSR-derived source file is vendored into `tools/models/`, keep its header and ship the Apache-2.0 text alongside it — or write the export script from scratch against the architecture and avoid vendoring entirely. Both MIT and Apache-2.0 are compatible with Hush's own Apache-2.0 licence.

**Residual risk (low):** the NAFNet `LICENSE` covers "the Software and associated documentation files" without naming the weights, which are hosted on Google Drive / Baidu rather than in the repo. Treating them as MIT is the standard community reading, but for a public redistribution it's worth a one-line confirmation: open a GitHub issue on `megvii-research/NAFNet` asking whether the pretrained SIDD weights are covered by the repository's MIT licence, and link the answer from the model card. Not a blocker for Phase 0. Always download from the official links in the NAFNet README and pin the checksum — not from third-party re-uploads.

🟡 **Optional half-day in Phase 0:** export SCUNet to ONNX and confirm it loads under ORT Web with WebGPU, so the escape route is proven before you need it.

### 4.7 Privacy, enforced

Shipped in `_headers` (and equivalents for other hosts):

```
Content-Security-Policy:
  default-src 'self';
  connect-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self' blob:;
  img-src 'self' blob: data:;
  style-src 'self' 'unsafe-inline';
  font-src 'self';
  object-src 'none';
  base-uri 'none';
  frame-ancestors 'none'
```

- `connect-src 'self'` means the page **cannot** send data anywhere except the server it came from — which serves only static files and accepts nothing.
- No upload code. A lint rule flags `fetch`/`XMLHttpRequest` calls with a `Blob`, `File` or `ArrayBuffer` body.
- No analytics, no error tracker, no cookies. Bug reports use a **Copy diagnostics** button (browser, GPU adapter, backend, timings, error codes — never filenames, EXIF or pixels) that the user pastes into a GitHub issue themselves.
- The privacy note can be three sentences long, and all three are verifiable.

---

## 5. UI/UX requirements

### 5.1 Design direction

A photo tool's hard rule: **the interface must not change how the photo looks.**

- **Neutral dark grey chrome** — not black, not tinted.
- **One accent colour, only on interactive controls**, never as a background near the photo.
- The photo gets the space; panels are narrow and quiet.
- 🟡 Dark by default regardless of system theme, with a light-grey option for accessibility.

The **signature element** is the before/after divider. Make dragging it precise and physical; let everything else recede.

### 5.2 First visit

- A full-window drop zone: "Drop photos here to remove noise" / 「將相片拖曳至此以降低雜訊」
- **Choose photos**, **Choose folder** (Chrome, Edge), drop, or paste.
- Always visible: **"Your photos stay on this device. Nothing is uploaded."** with a small **How we know** link to the privacy note and the source code.
- A capability notice only when needed, worded for the specific situation (§2.10, §5.12).
- No account button, no cookie banner — there's nothing to consent to.

### 5.3 Single photo — the editor

- **Viewer** opens at **100% zoom** on 🟡 the noisiest region. Noise is invisible at fit-to-screen.
- 100% means one image pixel per **device** pixel; account for `devicePixelRatio`.
- **Before/after**: draggable split divider; press-and-hold shows the original; `\` toggles, matching Lightroom.
- **Controls**: Strength, Luminance, Colour, Detail — all live.
- **Presets** (recipes): save, apply, rename, delete, export/import as JSON.
- **Export panel**: format, quality, suffix, remove location, save method.
- **Export** runs full resolution with band-level progress.
- **About**: version, model name, model and code licences, link to source.

### 5.4 Batch

- Drop many files or choose a folder → thumbnail grid.
- Click any thumbnail to tune settings; they apply to the batch.
- **Start** runs the queue; each thumbnail shows its state; a sticky footer shows progress and an ETA that can say hours.
- Failed items show why and offer retry. Skipped items say "already exported".
- Before a batch over 🟡 50 photos in Safari or Firefox: "Large batches work best in Chrome or Edge, which can save straight to a folder and resume if interrupted."

### 5.5 Phones and tablets — best-effort

Layout adapts (bottom sheet, pinch-zoom, press-and-hold), but phones aren't in the test matrix. A soft notice on small screens: "Works best on a computer — large photos and batches may be slow here."

### 5.6 First-use model download

- Before the first download, show the real size from the manifest: "One-time download, 58 MB. Works offline after."
- On metered connections (`navigator.connection.saveData`), ask first.
- Progress with real bytes across all parts. Later sessions load from cache.

### 5.7 Motion

Small: panel transitions, queue state changes, zoom easing. Never animate the photo. `prefers-reduced-motion` disables all of it.

### 5.8 Keyboard

`\` before/after · `Z` 100% / fit · hold `Space` to pan · `←` `→` previous/next in batch · `⌘/Ctrl+O` open · `⌘/Ctrl+E` export · `⌘/Ctrl+Z` reset sliders · `?` shortcut overlay.

### 5.9 Localization

- `navigator.languages` → `zh-Hant` (accept `zh-TW`, `zh-HK`, `zh-Hant-*`) or `en`; everything else → `en`. Manual switch persists.
- **Taiwan photography vocabulary**, following Adobe's Traditional Chinese Lightroom terms:

| Concept         | Use (Taiwan)        | Avoid (Mainland) |
| --------------- | ------------------- | ---------------- |
| Noise           | 雜訊                | 噪点             |
| Noise reduction | 減少雜訊 / 降低雜訊 | —                |
| Colour noise    | 色彩雜訊            | 彩色噪点         |
| Luminance noise | 明度雜訊            | 亮度噪点         |
| Export          | 匯出                | 导出             |
| Batch           | 批次                | 批量             |
| File            | 檔案                | 文件             |
| Folder          | 資料夾              | 文件夹           |
| Photo           | 相片 / 照片         | 图片             |
| Preset          | 預設集              | 预设             |

- Translation files live in the repo as plain JSON so contributors can add languages by pull request. Missing keys fall back to English per key, never per page.

### 5.10 Quality floor

- **WCAG 2.1 AA.** Divider is a keyboard-operable `role="slider"`. Throttled polite `aria-live` for progress. Visible focus.
- **Initial JS ≤ 150 KB gzipped.** First paint _is_ the product. ORT and codecs load after a file is chosen; the model never downloads without one.
- Every state has a designed screen: empty, downloading model, processing, done, error, unsupported browser.

### 5.11 Interface copy

- Active verbs, sentence case: **Remove noise**, **Export**, **Save to folder**.
- A verb keeps its name through the flow: **Export 12 photos** → "Exporting 3 of 12" → **12 photos exported**.
- Errors say what happened and what to do, without apology.
- Photographers' words: **photos**, **strength**, **colour noise**, **detail**.

### 5.12 When there's no usable GPU

The goal is that nobody is surprised by a wait. Every message names the situation, the expected time, and the fix — in that order.

- **First load, fixable browser issue:** a dismissible banner — "This browser can't use your graphics chip, so photos will take minutes instead of seconds. Open Hush in Chrome or Edge for full speed."
- **First load, hardware acceleration off:** "Hardware acceleration is turned off in this browser. Turn it on for much faster processing." with a **Show me how** link to per-browser steps.
- **First load, genuinely no GPU:** "This computer will process photos on its processor. It works, but slowly — about a few minutes per photo."
- **Before a single export on CPU:** the measured per-machine estimate on the button itself — **Export (about 6 min)**.
- **Before a batch on CPU:** "This batch would take about 14 hours on this computer. Consider running it on a computer with a graphics chip, or start it overnight." with **Start anyway** and **Cancel**. Shown above 🟡 1 hour of estimated work.
- **During processing:** the normal progress and ETA — no extra nagging once the user has chosen.
- **Copy diagnostics** includes which §2.10 situation was detected, so bug reports explain themselves.

### 5.13 Lessons from testing darktable

Hands-on testing of darktable 5.6 on Windows produced two failures: the interface felt overwhelming, and the denoised photo couldn't be exported. Both become requirements:

- **No import, no library, no catalogue.** Photos go from the drop zone straight to the viewer. Nothing is "added" anywhere.
- **No setup before the first result.** No preferences to enable, no model to pick. The only interruption allowed is the one-time model download notice (§5.6).
- **One screen.** Viewer, four sliders, export. Anything else lives behind a single "Advanced" disclosure. If a feature needs a new panel, question the feature first.
- **The save location is always visible.** Before export: "Saving to: Downloads" or the chosen folder name. After export: "Saved _IMG_2041-denoised.jpg_ to _Wedding/denoised_" — the actual filename and folder, not just "Done".
- **No silent write failures.** Every save is confirmed by the browser's own completion (download event or File System Access write resolving). If a write fails — permission revoked, disk full, folder blocked — say which photo, why, and what to do, and keep the result in memory so the user can retry without reprocessing.
- **Output is the format the photographer delivers.** JPEG in, JPEG out by default — no intermediate TIFF that needs a second export step.
- **Test the Windows save paths explicitly**, including a folder under OneDrive and with Windows Security's Controlled folder access turned on, so Hush never reproduces the failure that sent you looking in the first place.

---

## 6. Free-tier budget — a design constraint

Moving to Cloudflare changes the shape of this section completely. On Firebase, the binding constraint was **bandwidth** (360 MB/day). On Cloudflare, static-asset requests are unmetered — so the constraints become **file size** and **not attaching a payment method**.

### 6.1 The ceilings

Verified September 2026 — re-check before launch.

| Resource                                | Free allowance                                                 | Exposure                                                              |
| --------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Static-asset requests and bandwidth** | Unmetered                                                      | 🟢 The model can be downloaded by every visitor at no cost            |
| **Individual static file size**         | **25 MiB**                                                     | 🔴 **The binding constraint** — model and possibly ORT WASM exceed it |
| Static files per deployment             | 20,000                                                         | 🟢 A few hundred at most                                              |
| Worker script requests                  | 100,000 / day                                                  | 🟢 **Not used** — assets-only deployment, no script runs              |
| Hugging Face public model repo          | Free                                                           | 🟢 Build-time source only; users never hit it                         |
| GitHub Actions                          | Free for public repos                                          | 🟢                                                                    |
| R2                                      | 10 GB storage free — **but requires a payment method on file** | ⚪ Optional, not in the default deployment                            |

### 6.2 The 25 MiB rule

| Asset             | Size                                                  | Handling                                                                         |
| ----------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| App shell         | ~300 KB                                               | Normal static files                                                              |
| Codecs            | ~0.1–2 MB each                                        | Normal static files                                                              |
| ONNX Runtime WASM | Several MB to low tens of MB — **measure in Phase 0** | If over 24 MiB: split into parts, reassemble, pass via `ort.env.wasm.wasmBinary` |
| NAFNet weights    | Tens of MB (fp16), roughly double (fp32)              | **Always split** into ≤ 24 MiB parts at build time                               |

Splitting is simple and costs nothing at runtime: parallel fetches, one `ArrayBuffer`, one `sha256` check, stored whole in the Cache API. It's also what makes the app deployable to almost any static host.

### 6.3 Why not R2 by default

You liked R2, and it's a good product — but for this project it's a step backwards on two counts:

- **R2 requires billing details on the account even for the free tier.** An assets-only deployment doesn't. "No card attached" is the property that guarantees no bug, abuser or viral spike can ever bill you — and it's what lets a self-hoster deploy without any payment setup.
- **R2 is cross-origin** unless proxied through a Worker script (which then counts against the 100,000/day request limit). Same-origin static files keep `connect-src 'self'` and cross-origin isolation trivial. Public `r2.dev` URLs aren't meant for production either, so R2 would also need a custom domain.

**R2 stays a supported option**: set `MODEL_BASE_URL` at build time and the manifest points there. It's the right choice for someone deploying to a host with small file-size limits, or to **Firebase Hosting**, whose 360 MB/day cap can't carry model downloads (§9.3).

### 6.4 Where the model comes from

```
PyTorch checkpoint ──(tools/models/export.py)──▶ ONNX fp16/fp32
        ──▶ Hugging Face model repo (public, with model card and licence)
        ──(build: pnpm fetch-models, pinned to a commit sha)──▶ verify sha256 ──▶ split ──▶ dist/models/
        ──▶ Cloudflare static assets
```

Hugging Face is the **publishing** point — where the open-source community expects to find weights, with a model card and licence. Cloudflare is the **serving** point. Users only ever touch Cloudflare. Pinning to a Hugging Face commit sha means a build is reproducible and a changed upstream file fails the hash check instead of shipping silently.

### 6.5 Caching

- Hashed assets and model parts: `Cache-Control: public, max-age=31536000, immutable`.
- `index.html`, `manifest.json`, service worker: `no-cache`.
- Assembled model in the **Cache API** keyed by `sha256` — downloaded once per browser.
- The service worker precaches the shell only, **never** the model.

### 6.6 Rules

1. **No file over 24 MiB in the build output.** CI fails the build if one appears.
2. **No request leaves the origin.** CI runs the E2E suite with the CSP enforced and fails on any violation.
3. **The model downloads only after a photo is chosen**, with a size notice on metered connections.
4. **Nothing is stored server-side.** There is no server-side.
5. **No payment method on the Cloudflare account** for the default deployment. Anything that would require one — R2, Worker scripts beyond the free tier, paid features — is a deliberate decision, not a convenience.

---

## 7. What would change the cost model

- **Accounts and cloud recipe sync** → Firebase Auth + Firestore (both free, no card), or Cloudflare D1. Low risk.
- **Server-side processing** → GPU compute, per-photo cost, breaks the privacy promise. Opt-in only, if ever.
- **A paid hosted edition** → possible alongside the open-source one; depends on the licence choice (§9.1).

None in this phase.

---

## 8. Build order — this phase

Each phase ends deployable. Don't start one until the previous criteria pass. Read docs/implementation.md for more details about each phases. Update the checkbox when you have done the task.

- [x] Phase 0 Foundations and NAFNet spike ⚠️ go/no-go — [results](phase-0-results.md): quality go, speed rethink
- [x] Phase 1 — The pipeline, headless — [results](phase-1-results.md): golden images, no seams, metadata round-trip, 102 MP within one band
- [x] Phase 2 — Single-photo editor — [results](phase-2-results.md): 45 MP before/after at 100% in 1.7 s with the model cached (borderline band), EXIF kept on export
- [x] Phase 3 — Batch — [results](phase-3-results.md): 100 × 45 MP to a folder in 2 h 38 min (95 s per photo) with flat memory; Chrome killed halfway, reopened, resumed and skipped the 50 done
- [ ] Phase 4 — PWA and offline
- [ ] Phase 5 — Open-source release

---

## 9. Open source and self-hosting

### 9.1 Licences

- **Project code: Apache-2.0** (confirmed). Permissive, with an explicit patent grant; anyone — including you, later — can build commercial things on it. Add a `NOTICE` file and SPDX headers (`SPDX-License-Identifier: Apache-2.0`) to source files. No contributor licence agreement needed; the Apache licence's own contribution clause covers pull requests.
- **Model weights**: NAFNet (MIT) trained on SIDD (MIT) — redistribution permitted, with attribution (§4.6). Every model added later must pass the same check before it enters the manifest: code licence, weights licence, training-data licence.
- **Dependencies**: `libheif-js` is LGPL — keep it as a separately loaded WASM module (which it already is), so the LGPL's replaceability condition is met. Generate `THIRD_PARTY_NOTICES` automatically in CI from the dependency tree.

### 9.2 Repository layout

```
apps/web/                React app, browser adapters, _headers
packages/core/           platform-free pipeline
packages/ops/            operations (denoise)
tools/models/            export.py, model card template, fetch-models, split
deploy/
  cloudflare/            wrangler config (assets-only)
  firebase/              firebase.json with headers + MODEL_BASE_URL note
  nginx/                 nginx.conf with headers, for LAN / studio self-hosting
  docker/                Dockerfile (nginx serving dist/)
docs/                    self-hosting, architecture, adding a model, adding a language
```

### 9.3 Self-hosting targets

The build output is a folder. Anything that can serve it with the right headers works:

| Target                      | Headers              | Model files                                            | Notes                                                                                                                                                                                     |
| --------------------------- | -------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare** (default)    | `_headers`           | Same origin, split                                     | `pnpm build && wrangler deploy`. No payment method needed. Production is served on your own domain (already on Cloudflare); PR previews use `*.workers.dev`. Self-hosters can use either. |
| **Docker / nginx**          | `nginx.conf`         | Same origin, no size limit                             | For studios running it on their own network — fully offline-capable                                                                                                                       |
| **Firebase Hosting**        | `firebase.json`      | **External** via `MODEL_BASE_URL` (R2 or Hugging Face) | Hosting's 360 MB/day free transfer can't carry model downloads                                                                                                                            |
| **Netlify, Vercel, others** | Their headers config | Check per-file limits                                  | Documented, not tested in CI                                                                                                                                                              |
| **GitHub Pages**            | ❌ Can't set headers | —                                                      | Works without cross-origin isolation (single-threaded WASM fallback) and without the CSP header. Documented as limited.                                                                   |

### 9.4 CI/CD

- PR: typecheck, lint, unit tests, build, bundle-size check, 24 MiB check, CSP-enforced E2E, preview deployment.
- `main`: deploy to Cloudflare.
- **Model release workflow**, manual trigger: export → hash → publish to Hugging Face → PR updating `manifest.json`. Switching NAFNet → SCUNet goes through this path.
- Releases tagged with a changelog; the About panel shows the version.

---

## 10. Next phase (planned, not built now)

### 10.1 RAW support

LibRaw (WASM on web, native in apps), handling both Bayer and Fujifilm X-Trans demosaicing. Step one: demosaic, then NAFNet. Step two: Bayer-domain denoising adapted per camera body — a data project as much as a coding one. Open decision: DNG output (stays editable in Lightroom, much harder) or TIFF/JPEG. `RawImage` already carries `bitDepth` and `colourSpace` for this.

### 10.2 Native apps — Windows, iOS, Android

Native ONNX Runtime (DirectML, Core ML/Neural Engine, NNAPI/QNN), no browser memory caps, background processing, full file-system and photo-library access. **Route: Tauri 2** (decided), reusing the React UI and `packages/core` with native adapters; macOS comes almost free.

- **Why not Electron:** Electron cannot build iOS or Android apps, which are on the roadmap. It also bundles a whole Chromium (100+ MB installers) and by default runs inference through the same WebGPU path as the browser. Its one real advantage — identical Chromium on every platform — doesn't outweigh losing mobile.
- **Tauri trade-off to plan for:** it uses the system web view — WebView2 (Chromium) on Windows, WebKit on macOS and iOS — so UI behaviour can differ slightly between platforms. Inference doesn't depend on the web view: it runs in native ONNX Runtime from Rust.
- **When to start:** when users ask for what a browser does badly — overnight batches of hundreds of photos, RAW files, processing without keeping a tab open. darktable already serves desktop users willing to install a large app, so the desktop build must keep Hush's zero-friction promise: a small installer, no setup, same one-screen UI. New costs appear here: Apple Developer Program, Google Play registration, Windows code signing or Microsoft Store.

### 10.3 Later

Accounts and cloud recipe sync (Firebase Auth + Firestore). More operations — sharpen, upscale, JPEG-artefact removal, then basic tone and colour — growing toward the open-source editor via recipes. 16-bit and linear-float working space.

---

## 11. Testing

- **Golden images** by PSNR/SSIM within tolerance — GPU output isn't bit-exact.
- **Seam test**: gradient and flat grey with small tiles; no discontinuity at tile or band boundaries.
- **Band memory test**: 102 MP synthetic photo; assert peak float allocation is bounded by band size.
- **Metadata round-trip**: rotated, P3-profiled, GPS-tagged fixtures.
- **Recipe tests**: schema v1 recipes load; unknown future ops fail with a clear message rather than silently.
- **Unit tests** for `packages/core` in plain Node.
- **E2E** (Playwright) with the CSP enforced: drop → preview → export → verify file; any request to another origin fails the test. CI uses the WASM provider and a tiny test model.
- **Resume test**: interrupt a folder batch, reload, assert completed files are skipped.
- **No-GPU tests**: with WebGPU disabled, with a mocked fallback adapter (`isFallbackAdapter: true`), and with a software WebGL renderer — assert the WASM path is chosen, the fallback adapter is never used, and the matching §5.12 message appears.
- **Manual desktop matrix** before each release: Windows integrated GPU, Windows discrete GPU, Apple-silicon Mac (Safari, Chrome), one older Intel Mac.

---

## 12. Open questions

All resolved:

| Question     | Answer                                                               |
| ------------ | -------------------------------------------------------------------- |
| Code licence | Apache-2.0                                                           |
| Name         | Hush (靜)                                                            |
| Domain       | Your own domain, already on Cloudflare; `*.workers.dev` for previews |

Remaining to-dos, none blocking Phase 0: the name availability checks in §0, and the optional one-line confirmation from the NAFNet authors about the weights (§4.6).

✅ **Model licence check: done.** NAFNet code MIT, SIDD training data MIT — Hush may redistribute the converted weights with attribution.
