### Phase 0 — Foundations and NAFNet spike ⚠️ go/no-go

Public GitHub repo with the chosen licence. pnpm monorepo (§9.2). Vite, TS strict, Tailwind, shadcn, i18n scaffold. GitHub Actions: typecheck, lint (incl. DOM-free `core` rule and no-upload rule), test, build, **24 MiB file check**. Assets-only Cloudflare deployment with a working `_headers` file — confirm COOP/COEP and CSP actually arrive.

**The spike:** export NAFNet-SIDD width-32 and width-64 to ONNX (fp16, fp32), publish to a Hugging Face repo, build `fetch-models` with splitting. Bare page: tile, band-accumulate and denoise one photo in a worker. Measure against the §4.6 table on: Windows laptop with integrated GPU (Chrome, Edge), Windows with discrete GPU, Apple-silicon Mac (Safari 26, Chrome), the multithreaded WASM fallback on a CPU-only setup (a VM or a browser with hardware acceleration off), and an int8-quantized variant on that CPU path. Verify every §2.10 detection branch produces the right message. Record MP/s at 24 and 45 MP, peak memory, seams, and quality on the test set. Confirm WebGPU works in a worker in each browser. Measure the ORT WASM file sizes. 🟡 Optional: confirm SCUNet exports and loads, and benchmark NIND UNet.

**darktable baseline:** process the same test photos with darktable 5.6.1's neural restore (denoise tab, NIND UNet and NAFNet) on the same Windows machines. Record time per photo and save the outputs. Hush's NAFNet results are compared against these side by side at 100% — the quality bar is "at least as good as darktable", and darktable's own guidance of a few seconds per frame on GPU is the speed reference.

> ✅ Written results against §4.6. **Go** if NAFNet is in the go band. **Switch to SCUNet** if quality fails. **Rethink** if speed is in the no-go band — SCUNet is unlikely to fix speed.

### Phase 1 — The pipeline, headless

Decode (JPEG, PNG, WebP, HEIC, AVIF) → tile → infer → row-band accumulate → adjust → encode → metadata, all in `packages/core` and `packages/ops` behind `PlatformAdapters`, driven by a recipe. WebGPU with multithreaded WASM fallback. OOM backoff, `device.lost` recovery. Manifest loading, part reassembly, hash verification.

> ✅ Golden-image tests pass. No visible seams. EXIF, orientation and ICC round-trip. A 102 MP synthetic photo completes on desktop with float memory bounded by one band. `packages/core` tests pass in plain Node.

### Phase 2 — Single-photo editor

Drop zone at the root, viewer at true 100%, before/after divider, live controls, recipes with export/import, all save methods, model download UX, capability notices, keyboard shortcuts, About panel with licences, Copy diagnostics. Full zh-Hant.

> ✅ A photographer drops a 45 MP JPEG, sees a clear before/after at 100% within the preview target once the model is cached, and exports a file whose EXIF matches the original.

### Phase 3 — Batch

Queue, folder input, thumbnails, shared settings, progress and multi-hour ETA, pause/cancel/retry, wake lock, unload warning, save-to-folder with skip-existing and resume-after-reload, ZIP in parts.

> ✅ 100 × 45 MP JPEGs complete in Chrome with flat memory, saved to a folder. Kill the tab halfway, reopen, grant permission — the batch resumes and skips what's done.

### Phase 4 — PWA and offline

Installable desktop PWA, shell precached, model cached, full offline processing.

> ✅ With networking off, the installed app processes a batch end to end.

### Phase 5 — Open-source release

Self-hosting guide and configs (§9.3), README in both languages, CONTRIBUTING, model card, third-party notices, privacy note, desktop test matrix, Lighthouse ≥ 90, accessibility audit.

> ✅ Someone who has never seen the repo deploys their own copy to Cloudflare by following the README, and it passes the same CSP check as yours.
