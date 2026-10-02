# Phase 0 results: foundations and the NAFNet spike

**Date:** 2026-10-01 · **Measured on:** Apple M1 Pro (8-core CPU, 14-core GPU, 16 GB), macOS, Google Chrome 154, ONNX Runtime Web 1.30.0 · **Raw data:** [`docs/phase-0/results/`](phase-0/results/)

## Verdict

| Question                                       | Answer                                                                                                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does NAFNet run in a browser worker on WebGPU? | **Yes.** Chrome and WebKit, inside the pipeline worker, cross-origin isolated, from a static host that serves only its own origin.                                                                       |
| Is the quality right?                          | **Yes — go.** The export reproduces NAFNet's published output and SIDD numbers; fp16 is indistinguishable from fp32. No reason to switch to SCUNet.                                                      |
| Is it fast enough?                             | **No, not against §4.6 — rethink.** On this M1 Pro, a "strong machine" by the spec's definition, full photos run at 0.56–0.58 MP/s: the no-go band (< 1.2 MP/s). The 1 MP preview is borderline (1.8 s). |
| Is the slowness the browser's fault?           | **No.** Native PyTorch on the same GPU runs the same model only ~1.3× faster. The strong-machine target is ~4× what the browser achieves and ~2.6× what native code achieves here.                       |
| CPU-only path                                  | **Go.** A 24 MP photo in 3.5 minutes on 7 threads (0.12 MP/s; target ≥ 0.08).                                                                                                                            |

Following the decision rule in `docs/implementation.md` — _go_ if NAFNet is in the go band, _switch to SCUNet_ if quality fails, _rethink_ if speed is in the no-go band — **the result is "rethink", for speed only.** SCUNet would not help: it is heavier per pixel. The options are in [What to decide](#what-to-decide).

The foundations (repository, CI, lint rules, deployment, headers) are done and are independent of that decision.

## Against the §4.6 targets

| Row (§4.6)                                 | Go          | Measured here                                                     | Band                   |
| ------------------------------------------ | ----------- | ----------------------------------------------------------------- | ---------------------- |
| Strong machine (Apple silicon Pro/Max)     | ≥ 2.4 MP/s  | **0.56 MP/s** (24 MP in 42.5 s) · **0.58 MP/s** (45 MP in 78.2 s) | **no-go** (< 1.2)      |
| Preview crop (~1 MP, model cached, WebGPU) | ≤ 1.5 s     | **1.8 s** (1.79–1.88 s)                                           | **borderline** (≤ 3 s) |
| CPU only (WASM, 8-core laptop)             | ≥ 0.08 MP/s | **0.12 MP/s** (24 MP in 208 s) · 0.09 MP/s at 1 MP                | **go**                 |
| Mid-range laptop, integrated GPU (Windows) | ≥ 0.8 MP/s  | not measured here — see [Still to measure](#still-to-measure)     | —                      |

NAFNet-SIDD width 32, fp16, WebGPU, tiles ≤ 1024 px, synthetic photos (throughput does not depend on content).

## Quality

**The export is exact.** `nafnet.py` is an independent implementation of the architecture (no NAFNet or BasicSR source vendored) whose state-dict keys match the official checkpoints:

| Check                                                 | Result                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| Hush's architecture vs upstream code, same weights    | max difference **0.0**                                           |
| ONNX fp32 vs PyTorch                                  | 2.7 × 10⁻⁷ (w32), 2.1 × 10⁻⁶ (w64)                               |
| ONNX w64 vs NAFNet's published `demo/denoise_img.png` | fp32 **96.3 dB**, fp16 69.4 dB; no pixel more than one level off |
| fp16 vs fp32, in Chrome's WebGPU                      | **62.6 dB**, max one level                                       |

**SIDD validation** (`tools/models/evaluate.py`, ONNX Runtime CPU):

| Model       | All 1,280 crops (8-bit) | 320 crops (8-bit) | 320 crops (float) | SSIM¹  |
| ----------- | ----------------------- | ----------------- | ----------------- | ------ |
| Noisy input | 23.66 dB                | 23.76 dB          |                   |        |
| w32 fp32    | **39.88 dB**            | 39.95 dB          | 40.04 dB          | 0.9223 |
| w32 fp16    |                         | 39.95 dB          | 40.04 dB          | 0.9223 |
| w32 int8    | 38.93 dB                | 38.99 dB          | 39.06 dB          | 0.9096 |
| w64 fp32    |                         | 40.30 dB          | 40.40 dB          | 0.9259 |
| w64 fp16    |                         | 40.30 dB          | 40.40 dB          | 0.9259 |

NAFNet's README reports 39.97 dB (w32) and 40.30 dB (w64), computed on float outputs. On the same crops, rounding to 8-bit costs 0.086 dB — exactly the gap between our 39.88 dB and 39.97 dB. The width-64 model is +0.35 dB, as published.

¹ Standard per-channel SSIM. NAFNet reports a 3-D SSIM variant, so compare SSIM only between rows here.

**Seams.** Each block's global average pool sees only its own tile, so tiles disagree slightly; the cosine feather must hide it. On a 1024² crop of a 24 MP photo, tiled output against one-tile output: **52.0 dB** (416-px tiles) and **53.2 dB** (592-px tiles), at most 6 levels apart anywhere — invisible at 100%. A unit test drives ±0.02 per-tile bias (a 10-level step at a hard edge) through the blend and asserts no step above one level per pixel.

**Visual comparison** on a real high-ISO test set (§4.6: ~30 photos at 24 and 45 MP) and against darktable has not been done: see below.

### The fp16 trap (found and fixed)

The first fp16 export produced **NaN on WebGPU** — a black photo — while scoring perfectly on ONNX Runtime's CPU provider, which silently upcasts the ops it lacks fp16 kernels for. Measured on real noise, NAFNet's middle blocks square deviations up to ~67,000 inside each LayerNorm, and global average pools sum to ~200,000; fp16 stops at 65,504. Fixes, each tested:

- The fp16 export keeps every LayerNorm and global pool in fp32 (`fp32_islands` in `tools/models/export.py`), and fails if anything left in fp16 comes within 2× of overflow. The largest fp16 value is now 300 (w32) and 3,578 (w64).
- The browser refuses non-finite model output (`ModelOutputError`) instead of exporting it; CI runs a NaN-producing test model to prove it.

The fp32 islands cost about 10% of the fp16 speed-up; all numbers here are after the fix.

## Speed

### WebGPU, Chrome 154, M1 Pro

| Run                 | Model, precision | Tiles     | Time                     | MP/s      |
| ------------------- | ---------------- | --------- | ------------------------ | --------- |
| Preview, 1 MP       | w32 fp16         | 1 × 1120² | 1.88 s cold, 1.79 s warm | 0.56–0.59 |
| Preview, 1 MP       | w32 fp32         | 1 × 1120² | 2.16–2.30 s              | 0.46–0.49 |
| 24 MP (6000 × 4000) | w32 fp16         | ≤ 512     | 48.4 s                   | 0.50      |
| 24 MP               | w32 fp16         | ≤ 768     | 46.2 s                   | 0.52      |
| 24 MP               | w32 fp16         | ≤ 1024    | **42.5 s**               | **0.56**  |
| 45 MP (8256 × 5504) | w32 fp16         | ≤ 1024    | **78.2 s**               | **0.58**  |
| 24 MP               | w32 fp32         | ≤ 1024    | 51.5 s                   | 0.47      |
| Preview, 1 MP       | w64 fp16         | 1 × 1120² | 4.4–5.2 s                | 0.20–0.24 |
| 24 MP               | w64 fp16         | ≤ 1024    | 112.4 s                  | 0.21      |

What moved the numbers, and what didn't:

- **Even tiling.** Fixed-size tiles with a clamped last tile made the model process 1.38–1.53× a 24 MP photo's pixels. `planAxis` now picks the fewest tiles that cover each axis and shrinks them to share it evenly: 1.29× at a 512 px ceiling and 1.15× at 1024 px — 6–25% less work at the same overlap (computed from the tile plans; all timings here use it).
- **Bigger tiles**: per-pixel cost is flat from 512² to 1120² — the GPU is saturated, not waiting on dispatch — so larger tiles help only through less overlap.
- **`preferredLayout: NCHW` (+12%)**, now the default. `validationMode: disabled`: no change. ORT's older JSEP WebGPU build: **2× slower**. WebNN: not exposed in Chrome 154 on macOS.
- **fp16 vs fp32**: 15–20% faster.
- **Width 64**: 2.6× slower for +0.35 dB. Not worth it for interactive use; a candidate "high quality" setting only on strong GPUs.

**Native reference** — PyTorch on Metal, same GPU, same model: 0.88 MP/s (fp16, 512² tiles) and 0.94 MP/s (1024²). The browser reaches ~75% of that. The runtime is not the bottleneck; the model's cost on this GPU is.

**Peak memory** — the pipeline's own float memory is one band plus three tiles, 44–125 MiB, flat in photo height (asserted by a unit test). The whole Chrome process tree, GPU process included, peaked at 2.0–3.3 GB for width 32 and 4.0 GB for width 64.

**First use** — the deployed site processed its first photo in 16.7 s including downloading the 27 MB runtime and the 59 MB model; both are cached afterwards.

### Processor only (WASM, 7 threads)

| Run   | Precision | Time    | MP/s |
| ----- | --------- | ------- | ---- |
| 1 MP  | fp32      | 11.4 s  | 0.09 |
| 1 MP  | int8      | 10.2 s  | 0.10 |
| 24 MP | fp32      | 208.3 s | 0.12 |

The GPU path is only ~5× faster than the CPU path on this machine (the spec expected ~10×).

**int8 does not ship.** It is 12% faster than fp32 and costs 0.96 dB on SIDD — more than the whole width-32 → width-64 gain. The spec ships it only "if the quality holds up". `tools/models/quantize.py` stays for later experiments.

## The other Phase 0 checks

**WebGPU inside a dedicated worker:** Chrome 154 (macOS) ✓ with `shader-f16`; WebKit 26.6 — Safari's engine, via Playwright — ✓ with `shader-f16` (1 MP in 3.35 s, 1.9× slower than Chrome on the same GPU). Firefox: Playwright's Firefox 155 build would not launch on this macOS release, so untested. No browser needed the main-thread fallback.

**Every §2.10 branch shows its own message**, tested end to end with the browser's WebGPU and WebGL facts substituted (`apps/web/e2e/capabilities.spec.ts`): hardware adapter (no notice); WebGPU missing with a real GPU (suggests Chrome or Edge, or an update when already in one); software renderer (hardware acceleration off, with per-browser steps); a CPU-emulated fallback adapter (never used — the photo is shown to run on the processor); a virtual machine (processor only, no steps that wouldn't help); no WebGL at all. On a real browser, Chrome with `--disable-gpu` reports no adapter and a SwiftShader renderer and shows "Hardware acceleration is turned off in this browser."

**ONNX Runtime Web 1.30.0 binaries:** `ort-wasm-simd-threaded.asyncify.wasm` (the WebGPU build) is **26.8 MB — over the 25 MiB Cloudflare limit**, so it ships in two parts, joined in the worker and passed as `env.wasm.wasmBinary` (§6.2). The CPU-only build is 14.2 MB. Also measured, not used: JSEP 28.3 MB, JSPI 16.8 MB (Chromium only).

**Model files** (all split into ≤ 24 MiB, content-addressed parts): w32 fp16 59.3 MB, w32 fp32 117.0 MB, w64 fp16 233.0 MB, w64 fp32 464.3 MB.

**Cloudflare, assets only:** deployed to <https://hush.ms0242808.workers.dev> with no Worker script. Verified on the live site: `Content-Security-Policy` exactly as §4.7 (plus `form-action 'none'`), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`, `crossOriginIsolated === true`, `no-cache` on pages and the manifest, `immutable` on hashed assets, model parts and the runtime. A full run on the live site — model download, NAFNet on WebGPU, export — made **zero requests to other origins and no CSP violations**. One quirk: Cloudflare answers `HEAD` on HTML pages with a plain 404 (GET is correct), so uptime checks must use GET.

**Initial JavaScript:** 87.6 KB gzipped (budget 150 KB). The runtime, codecs and model load only after a photo is chosen (end-to-end tested).

## Still to measure

These need hardware or software this machine doesn't have. The benchmark is deployed for exactly this: open **<https://hush.ms0242808.workers.dev/bench/>**, press **Run standard suite**, then **Copy as Markdown** and add the table under `docs/phase-0/results/`.

| Machine                                                 | Why it matters                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Windows laptop, integrated GPU (Chrome and Edge)        | The §4.6 "mid-range laptop" row — the main audience                                               |
| Windows, discrete GPU                                   | The other "strong machine"                                                                        |
| Safari 26/27 on Apple silicon (real Safari, not WebKit) | Safari's WebGPU in a worker; WebKit suggests ~1.9× slower than Chrome                             |
| Newer Apple silicon (M3/M4 Pro or Max)                  | 2–3× the M1 Pro's GPU; would show whether the strong-machine row is reachable on current hardware |
| darktable 5.6.1 neural restore (Windows, same photos)   | The quality and speed bar from the spec                                                           |
| ~30 real high-ISO photos, 24 and 45 MP, JPEG and HEIC   | Visual quality at 100%; HEIC decoding arrives in Phase 1                                          |

## What to decide

Quality is settled; speed is the open question. In order of cost:

1. **Measure the real targets first** (above). If mid-range Windows GPUs land in the borderline band, the spec already plans honest multi-hour ETAs for batches (§2.7), and single photos take under a minute.
2. **Re-baseline the targets** to what this class of model costs: about 40 s per 24 MP photo on an M1 Pro. Whether that is acceptable is a product call; darktable's timings on the same machines (still to measure) are the comparison the spec names.
3. **Faster kernels.** ONNX Runtime runs about 1,300 kernels per tile, most of them small memory-bound element-wise ops. Fusing each NAFNet block into a handful of WGSL kernels (LayerNorm into the following 1×1 convolution, gates and channel attention together) plausibly gives 2–3×. Bounded work, but it means owning a custom inference path.
4. **A cheaper model.** Distil NAFNet-w32 into a smaller network (width 16, fewer middle blocks: ~4× fewer operations) on SIDD (MIT). The only route to the 2.4 MP/s target on M1-class GPUs; it costs a training project and some quality.

SCUNet is not on the list: it is heavier per pixel, and quality is not the problem.

Phase 1 (decode, encode, metadata, the pipeline behind `PlatformAdapters`) is mostly model-independent and could proceed while this is decided.

## How to reproduce

```sh
pnpm install && pnpm build && pnpm preview          # production build with the production headers
node apps/web/scripts/measure.ts --suite gpu --label <machine>-<browser>
node apps/web/scripts/measure.ts --suite cpu --label <machine>-<browser>-wasm
cd tools/models && uv run verify_reference.py && uv run evaluate.py --every 4
```
