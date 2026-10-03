# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hush (靜) is an open-source photo denoiser that runs NAFNet entirely in the browser (WebGPU, or multithreaded WASM on the processor), shipped as a static site. The product spec is `docs/app_spec.md` (sections are cited as §n.n throughout the code); work is done one phase at a time per `docs/implementation.md`. Each finished phase gets `docs/phase-N-results.md` (verdict against the phase's criterion, decisions, measurements), a ticked checkbox in `docs/app_spec.md` §8, and a README status update.

## Commands

Node 24 and pnpm 12 (`.nvmrc`, `packageManager`). Python/uv only for `tools/models` and `tools/fixtures`.

```sh
pnpm install
pnpm fetch-models --from tools/models/out   # release models into apps/web/.models/release (HF repo unpublished: export first, see tools/models/README.md)
pnpm fetch-models --set test                # the tiny CI test models (invert, NaN) into apps/web/.models/test
pnpm dev                                    # Vite on :5173 (COOP/COEP, no CSP); serves the release models
pnpm build && pnpm preview                  # production build served by wrangler dev on :8788 with the real _headers; restart preview after rebuilding
pnpm typecheck && pnpm lint && pnpm test    # tsc everywhere, ESLint, Vitest (all projects)
pnpm e2e                                    # builds apps/web/dist-e2e with the test models, then Playwright against wrangler dev :8790
pnpm check:dist                             # after `HUSH_MODELS=test pnpm build`: no file > 24 MiB, first-load JS ≤ 150 KB gzipped
pnpm format && pnpm notices                 # Prettier; regenerate THIRD_PARTY_NOTICES.md after dependency changes (CI checks both)
pnpm --filter @hush/web e2e:real            # local only: release models, real GPU, installed Chrome (CI has neither)
```

Single tests:

```sh
npx vitest run --project core packages/core/test/preview.test.ts -t "pauses"   # projects: core, ops, web, eslint-plugin, model-tools
cd apps/web && pnpm exec vite build --mode e2e --outDir dist-e2e               # once, then after app changes
cd apps/web && npx playwright test e2e/editor.spec.ts -g "presets"
cd apps/web && HUSH_PHOTO=/path/photo.jpg npx playwright test -c playwright.real.config.ts e2e/real/editor.spec.ts   # needs dist-real: HUSH_MODELS=release vite build --mode e2e --outDir dist-real
```

## Architecture

- **`packages/core`** — the platform-free pipeline. It may not touch `window`, `document`, `navigator`, `fetch`, timers, `performance`, Node built-ins etc. (ESLint `no-restricted-globals` + a tsconfig without DOM/Node types; tests run in plain Node). Everything platform-specific comes in through `PlatformAdapters` (`src/adapters.ts`): codecs, inference sessions, model storage, assets, output, sha256, zlib, clock. Key flow: `readPhoto` (container + metadata, refuses CMYK/HDR/animated/too large before decoding) → codec decode → `runRecipe` (operations from a recipe; denoise = `runTiled`: even tile plan, cosine feather, row-band accumulation, OOM backoff, device-loss recovery, with `RowAdjuster` applying the four sliders per finished row) → `encodePhoto` (encode + metadata re-injected byte for byte). Editor-side pieces also live here: `view.ts` (display ↔ stored geometry for EXIF orientations), `noise.ts` (noisiest region), `preview-grid.ts` + `preview.ts` (the progressive preview), `estimate.ts`.
- **`packages/ops`** — `ImageOperation`s; denoise is the only one. A recipe (`{schema:1, ops:[{op, model, params}]}`) is what the pipeline takes, and what presets are.
- **`apps/web`** — React 18 + Tailwind 4 + shadcn-style components on Radix. Three threads, Comlink between them, pixels moved as transferables:
  - main thread: `src/app/App.tsx` (drop zone = first paint) lazily loads `src/editor/` — a zustand store (`store.ts`), one `EditorSession` (`session.ts`) that drives the worker and writes everything the UI shows into the store, and the `Viewer` (WebGL2 at exact device pixels; per-frame state lives in refs, not React state).
  - `src/worker/pipeline.worker.ts`: owns the model session (one runtime per worker — switching backend means a new worker), the preview scheduler, region crops, and exports (in place over the decoded photo, then re-decoded in the background). The `/bench/` page uses the older headless entry points in the same worker.
  - `src/worker/decode.worker.ts`: a nested, per-photo worker that decodes, finds the noisiest region and builds the fit-view overview, so the model loads in parallel; it is terminated afterwards to free the decoder's WASM heap.
- **The sliders never re-run the model.** The viewer's fragment shader (`src/editor/viewer/renderer-gl.ts`) is a copy of core's `adjust.ts` math; `renderer-2d.ts` (no WebGL2) calls core's `adjustImage` directly. `e2e/editor.spec.ts` checks both against core. Change one, change all three.
- **Models are manifest-driven** (`/models/manifest.json`: tiling conventions, variants, licences; parts ≤ 24 MiB, sha256-verified, cached in the Cache API). `build/models.ts` ships `.models/test` in the `e2e` mode (or `HUSH_MODELS=test`) and `.models/release` otherwise. `?model=<id>` picks another model.

## Constraints that are easy to break

- **Privacy is enforced, not promised**: CSP `connect-src 'self'` (headers in `apps/web/public/_headers`; COOP/COEP make the page cross-origin isolated). The `hush/no-upload` lint rule forbids request bodies, non-GET/HEAD fetches, non-literal fetch options, XHR/WebSocket. Every Playwright test fails on a foreign request or a CSP violation. No inline scripts (hence `public/theme.js` for the pre-paint theme). The model must not download before a photo is chosen (tested).
- **Budgets**: first-load JS ≤ 150 KB gzipped — the editor, dialogs, codecs and ONNX Runtime all load lazily; no build file over 24 MiB (Cloudflare's limit).
- **Memory**: a 100 MP photo is held once in 8 bits; float memory is bounded by one band. Don't add full-size float buffers or second copies of the photo.
- **Pixels are never rotated** (§2.6): orientation travels as a tag; the viewer maps display ↔ stored coordinates.
- **i18n**: every string goes in both `src/i18n/locales/en.json` and `zh-Hant.json`. `locales.test.ts` enforces key parity, identical placeholders and Taiwan photography vocabulary (雜訊, 匯出, 預設集, 明度/色彩雜訊 — never Mainland terms). Copy is sentence case with active verbs; errors say what happened and what to do (§5.11).
- **UI motion** follows the emil-design-eng skill: never animate the photo or keyboard-initiated actions, name transitioned properties (no `transition: all`), custom ease-out curves, honour `prefers-reduced-motion`. Menus close without an exit animation on purpose (an exit animation let a quick reopen be closed by the old menu's focus return).
- TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (hence `a[i]! += x` and `...(x && { x })`). Core imports use `.ts` extensions. Every source file starts with `// SPDX-License-Identifier: Apache-2.0`. Prettier: tabs, single quotes, width 120.

## Testing notes

- Non-production builds expose test hooks: `window.__hushEditor` (the zustand store), `window.__hushViewer` (`readPhoto('original' | 'result')`, `state()`, draw count), and on `/bench/` `window.__hushPipeline` / `window.__hushBench`. In the Vite dev server, read state through these hooks: `import('/src/...')` from `page.evaluate` can load a second module instance after HMR.
- CI's browser is Playwright's headless Chromium with the test models and no WebGPU, so e2e runs the processor path; the invert model makes "the result" exactly 255 − original. Real-model numbers come only from `e2e:real` on a GPU — CI green is not real-model verification.
- Headless Chromium crashes when it reads a stored private-file-system (OPFS) directory handle back from IndexedDB; installed Chrome doesn't. Folder-handle persistence across reloads is therefore checked in `e2e:real`.
- Under emulated device scale factors, `devicePixelContentBoxSize` reports CSS pixels; the viewer cross-checks it against CSS size × `devicePixelRatio`.
- Test photos in `apps/web/e2e/fixtures` are committed, written by encoders independent of Hush (`tools/fixtures/make_fixtures.py`); golden images come from `tools/models/make_golden.py`. Encoder versions change bytes, so don't regenerate them casually. The 45 MP photo for `e2e:real` is generated into the gitignored `apps/web/e2e/real/.photos/` by `tools/fixtures/make_large.py`.
