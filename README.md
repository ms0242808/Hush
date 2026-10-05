# Hush (靜)

[![CI](https://github.com/ms0242808/Hush/actions/workflows/ci.yml/badge.svg)](https://github.com/ms0242808/Hush/actions/workflows/ci.yml)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

An open-source photo denoiser that runs **entirely in your browser, on your own
graphics chip**. Open a link, drop a photo, get a clean photo back. No install,
no account, no upload — and anyone can host it as a folder of static files.

> **Status: Phase 3 — batches.** Drop many photos, or choose a folder, and
> they become a grid of thumbnails sharing one set of settings; **Export**
> runs them one at a time into a folder (skipping what's already there) or
> into ZIP files in parts, with pause, cancel, retry and an honest
> multi-hour estimate — and a batch that stops (a closed tab, a crash) picks
> up where it left off. Every photo still opens in the single-photo editor at
> true 100%. Read **[the Phase 3 results](docs/phase-3-results.md)**,
> **[Phase 2](docs/phase-2-results.md)** (the editor),
> **[Phase 1](docs/phase-1-results.md)** (the pipeline) and
> **[Phase 0](docs/phase-0-results.md)** (speed is still an open decision there:
> a 45 MP photo takes about 93 s on an M1 Pro, so 100 of them take 2½ hours).
>
> Preview (deployed by hand, so it can lag behind `main`):
> **<https://hush.ms0242808.workers.dev>** · benchmark this computer, or run a
> photo through the pipeline and compare its metadata:
> **<https://hush.ms0242808.workers.dev/bench/>**

## Your photos stay on this device

1. Hush removes noise on your computer, inside the browser tab, with your own graphics chip or processor.
2. The page may only connect to the site it came from (`Content-Security-Policy: connect-src 'self'`), which serves static files and accepts nothing. Your browser enforces that, and its network panel shows every request.
3. The code is open source. A lint rule forbids request bodies of any kind, and the end-to-end tests fail on any request to another origin or any CSP violation.

## Using it

1. **Drop a photo** anywhere on the page, paste one, or choose one. The first
   photo downloads the noise model once (59 MB, with its size and progress
   on screen while the photo already shows; on a metered connection Hush asks
   first). It works offline after.
2. The photo opens at **100%** — one photo pixel per screen pixel — where it is
   noisiest. **Drag the divider** to compare; **press and hold** the photo, or
   press `\`, to see the original. Denoised tiles appear nearest the divider
   first.
3. **Strength**, **Luminance noise**, **Colour noise** and **Detail** change
   the result live. Save the settings as a **preset**; presets export and
   import as `.hush-preset.json` files.
4. **Export** at full size. It goes to Downloads, to a folder you choose
   (Chrome and Edge; never over an existing file), or to the share sheet on a
   phone, and Hush says exactly where it went. Format, quality, the file-name
   suffix, removing the location, and graphics chip or processor are under
   **Advanced**.

### Many photos at once

1. **Drop several photos**, or a folder, or press **Choose folder** (Chrome
   and Edge). They appear as a grid; photos Hush can't process (CMYK, HDR,
   animated, damaged) say why, and RAW files in the folder are left alone.
2. The four sliders and the preset apply to **every photo** in the batch.
   Click any photo to see them on it at 100%; `←` `→` move through the batch.
3. **Export N photos** shows how long it will take on this computer before it
   starts. Photos from a folder are saved into a `denoised` folder inside it;
   otherwise to a folder you choose, or — in Safari and Firefox — as ZIP
   files of up to 500 MB, each downloaded as soon as it's complete.
4. While it runs, a bar under the grid shows "Exporting 3 of 12", the time
   left (it can say hours), **Pause** and **Cancel**. The screen stays awake,
   and closing the tab asks first. Photos already in the folder are skipped;
   a failed photo says why and can be retried; if saving fails, the batch
   pauses and keeps the photo until you choose another folder.
5. If the tab closes or the browser crashes, open Hush again: it offers to
   **Continue** — for a folder, one permission and it carries on, skipping
   what's done; for chosen files, choose them again and the finished ones are
   skipped.

| Key                  | Does                                              |
| -------------------- | ------------------------------------------------- |
| `\`                  | The original, or the comparison                   |
| `Z`                  | Fit or 100%                                       |
| Space + drag, arrows | Move around the photo                             |
| `←` `→`              | The previous or next photo of a batch             |
| ⌘/Ctrl + O, E, Z     | Open (or add) photos · Export · Reset the sliders |
| `?`                  | All of these                                      |

## Photos in, photos out

| Opens                                   | Saves                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| JPEG, PNG, WebP, HEIC, AVIF             | The same format; HEIC and AVIF become JPEG. JPEG quality 95 by default.                             |
| Refused, with a reason, before decoding | CMYK JPEGs, HDR (PQ/HLG) HEIF and AVIF, animated WebP and PNG, photos over this device's size limit |

What the saved file keeps: **EXIF** byte for byte apart from `Software`, which
says `Hush` (maker notes keep their offsets; GPS goes only when you ask), the
**colour profile** byte for byte (a HEIC that declares Display P3 without one
gets one), **XMP**, **IPTC** captions, the JPEG comment and print resolution,
and PNG text and colour chunks. Pixels are never rotated: the orientation tag
travels instead, except for HEIC, whose decoder turns the photo upright and so
saves orientation 1. Hush works in 8 bits per channel for now and says so when
a photo had more.

## What's here

| Path                       | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                 | The web app: React 18, TypeScript, Tailwind 4, Vite 8. The root page is the tool: the drop zone, then the editor (`src/editor/`: a WebGL2 viewer with the adjust stage as a shader, the panel, presets, saving) or a batch (`src/batch/`: the thumbnail grid, the queue's progress, saving to a folder or ZIP parts, resuming after a reload), loaded lazily. Workers do the rest: decoding, thumbnails, the preview, export. `/bench/` measures this machine and runs the pipeline check.                                                   |
| `packages/core`            | The platform-free pipeline: format detection, metadata reading and writing, tiling with out-of-memory backoff and device-loss recovery, row-band accumulation, the adjust stage, recipes, manifests and model loading, behind `PlatformAdapters`; for the editor, the noisiest-region search, the progressive preview grid and scheduler, view geometry and the export estimate; and for batches, the queue (pause, cancel, retry, skip what's exported, measured time left) and a ZIP writer. No DOM, no Node; its tests run in plain Node. |
| `packages/ops`             | Image operations built on core. This phase: denoise, with its four sliders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tools/models`             | Export, verify, quantize and publish the NAFNet ONNX models, and make the golden images ([README](tools/models/README.md)).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tools/fixtures`           | The test photos, written by encoders independent of Hush (Pillow, pillow-heif) with camera-style metadata; `make_large.py` writes the 45 MP photo the real-model checks use.                                                                                                                                                                                                                                                                                                                                                                 |
| `tools/eslint-plugin-hush` | The `no-upload` lint rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `deploy/cloudflare`        | Assets-only Cloudflare deployment (no Worker script). Headers live in `apps/web/public/_headers`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `docs`                     | The [app spec](docs/app_spec.md), [implementation phases](docs/implementation.md), and each phase's results: [0](docs/phase-0-results.md), [1](docs/phase-1-results.md), [2](docs/phase-2-results.md), [3](docs/phase-3-results.md).                                                                                                                                                                                                                                                                                                         |

## Running it

Requirements: Node 24 and pnpm 12. Python and [uv](https://docs.astral.sh/uv/) only if you export models yourself.

```sh
pnpm install
```

The app needs model files. Until the converted models are published on Hugging
Face (see [tools/models](tools/models/README.md#publishing)), export them locally:

```sh
cd tools/models && uv sync && uv run export.py nafnet-sidd-w32 nafnet-sidd-w64 && uv run lock.py && cd ../..
pnpm fetch-models --from tools/models/out
```

Then:

```sh
pnpm dev                    # http://localhost:5173, cross-origin isolated
pnpm build && pnpm preview  # the production build at http://127.0.0.1:8788, with the production headers
```

`pnpm preview` runs `wrangler dev`, which indexes the build when it starts:
restart it after rebuilding.

Open `/bench/` to measure this machine against the spec's targets (§4.6).
`node apps/web/scripts/measure.ts --suite gpu` drives the same page with
Playwright and writes the results to `docs/phase-0/results/`.

## Checks

| Command                            | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                   | TypeScript strict everywhere; `packages/core` and `packages/ops` compile without DOM or Node types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm lint`                        | ESLint, including the platform-free rule for core and ops and the `no-upload` rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test`                        | Vitest in plain Node: metadata round-trips checked with exifr, tiling, seams, band memory up to 102 MP, the adjust stage, recipes, resilience, manifests, §2.10 rules, model tooling; the preview grid and scheduler, the noisiest region, presets, saving, diagnostics, every translation; the batch queue and ZIP parts (read back by Python's `zipfile`).                                                                                                                                                                                                           |
| `pnpm e2e`                         | Playwright against a production build with the real headers and the tiny CI test models: the editor end to end (the viewer's shader against core's adjust stage, presets, every save method, the model download, keyboard, zh-Hant), batches (thumbnails, folder input, export to a folder with skip-existing, pause, cancel, retry, a failed save, ZIP parts, resuming after a reload), every format through the pipeline, metadata read back with exifr, orientation, refusals, GPU-failure recovery, a 102 MP photo. Fails on any foreign request or CSP violation. |
| `pnpm --filter @hush/web e2e:real` | Locally, with the real model and a GPU (installed Chrome): golden images, seams, speed, a real device loss, 102 MP through NAFNet, Phase 2's acceptance — a 45 MP JPEG's preview timing and export EXIF — and Phase 3's: 45 MP JPEGs from a folder, Chrome killed halfway and reopened, memory sampled throughout (`HUSH_BATCH_COUNT=100` for the full run; 6 by default). `HUSH_PHOTO=/path/to/photo.jpg` runs the editor checks on a photo of yours; `HUSH_PHOTOS=a.jpg,b.jpg` a batch of them.                                                                      |
| `pnpm check:dist`                  | No file over 24 MiB; first-load JavaScript within 150 KB gzipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm format:check`                | Prettier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm notices:check`               | `THIRD_PARTY_NOTICES.md` matches the dependency tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

CI runs all of them on every pull request.

## Deploying

Hush is a static site. On Cloudflare (free plan, no payment method needed):

```sh
pnpm fetch-models && pnpm build && pnpm deploy:cloudflare
```

(Until the models are published on Hugging Face, use
`pnpm fetch-models --from tools/models/out` after exporting them.)

`deploy/cloudflare/wrangler.jsonc` is assets-only: no Worker script runs, so
there is nothing to bill. Confirm the headers arrived — with a GET, since
Cloudflare answers `HEAD` requests for pages with a bare 404:

```sh
curl -s -D - -o /dev/null https://<your-worker>.workers.dev/ | grep -iE 'content-security-policy|cross-origin'
```

`.github/workflows/deploy.yml` deploys `main` once the repository variable
`HUSH_DEPLOY` is `true` and the secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` are set. Other hosts (nginx, Docker, Firebase) arrive in
Phase 5; any host works if it serves `dist/` with the headers in `_headers`.

## Models and licences

Hush is Apache-2.0. It ships ONNX conversions of
[NAFNet](https://github.com/megvii-research/NAFNet) (MIT, © 2022 megvii-model),
trained on [SIDD](https://abdokamel.github.io/sidd/) (MIT). HEIC photos are
decoded by [libheif-js](https://github.com/catdad-experiments/libheif-js)
(LGPL-3.0), served as its own file under `/codecs/` and loaded only when a HEIC
is opened, so it can be replaced. See [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
