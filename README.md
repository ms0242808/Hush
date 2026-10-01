# Hush (靜)

[![CI](https://github.com/ms0242808/Hush/actions/workflows/ci.yml/badge.svg)](https://github.com/ms0242808/Hush/actions/workflows/ci.yml)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

An open-source photo denoiser that runs **entirely in your browser, on your own
graphics chip**. Open a link, drop a photo, get a clean photo back. No install,
no account, no upload — and anyone can host it as a folder of static files.

> **Status: Phase 0 — foundations and the NAFNet feasibility spike.** The pipeline
> works end to end (drop a photo → NAFNet in a worker → before/after at 100% →
> export), but this phase's job was to measure whether it is fast enough. Read
> **[the Phase 0 results](docs/phase-0-results.md)** before building on it.
>
> Preview: **<https://hush.ms0242808.workers.dev>** · benchmark this computer:
> **<https://hush.ms0242808.workers.dev/bench/>**

## Your photos stay on this device

1. Hush removes noise on your computer, inside the browser tab, with your own graphics chip or processor.
2. The page may only connect to the site it came from (`Content-Security-Policy: connect-src 'self'`), which serves static files and accepts nothing. Your browser enforces that, and its network panel shows every request.
3. The code is open source. A lint rule forbids request bodies of any kind, and the end-to-end tests fail on any request to another origin or any CSP violation.

## What's here

| Path                       | What it is                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                 | The web app: React 18, TypeScript, Tailwind 4, Vite 8. The root page is the tool; `/bench/` is the Phase 0 benchmark.                                      |
| `packages/core`            | The platform-free pipeline: tiling, cosine feathering, row-band accumulation, manifest and capability rules. No DOM, no Node; its tests run in plain Node. |
| `packages/ops`             | Image operations built on core. This phase: denoise.                                                                                                       |
| `tools/models`             | Export, verify, quantize and publish the NAFNet ONNX models ([README](tools/models/README.md)).                                                            |
| `tools/eslint-plugin-hush` | The `no-upload` lint rule.                                                                                                                                 |
| `deploy/cloudflare`        | Assets-only Cloudflare deployment (no Worker script). Headers live in `apps/web/public/_headers`.                                                          |
| `docs`                     | The [app spec](docs/app_spec.md), [implementation phases](docs/implementation.md) and [Phase 0 results](docs/phase-0-results.md).                          |

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

| Command              | What it checks                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`     | TypeScript strict everywhere; `packages/core` and `packages/ops` compile without DOM or Node types.                                     |
| `pnpm lint`          | ESLint, including the platform-free rule for core and ops and the `no-upload` rule.                                                     |
| `pnpm test`          | Vitest in plain Node: tiling, seams, band memory, manifests, §2.10 rules, model tooling.                                                |
| `pnpm e2e`           | Playwright against a production build with the real headers and the tiny CI test models. Fails on any foreign request or CSP violation. |
| `pnpm check:dist`    | No file over 24 MiB; first-load JavaScript within 150 KB gzipped.                                                                       |
| `pnpm format:check`  | Prettier.                                                                                                                               |
| `pnpm notices:check` | `THIRD_PARTY_NOTICES.md` matches the dependency tree.                                                                                   |

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
trained on [SIDD](https://abdokamel.github.io/sidd/) (MIT). See
[NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
