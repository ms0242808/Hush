# Model tools

Everything between the official NAFNet checkpoints and the files Hush serves.
Python, managed with [uv](https://docs.astral.sh/uv/); only needed to produce or
re-check models, never to build or run the app.

```
official checkpoint (Google Drive, sha256-pinned)
  └─ calibrate.py ────── attention-bounds/: each block's attention range on SIDD (committed)
  └─ export.py ───────── ONNX fp32 + fp16, attention bounded, checked against PyTorch, fp16 and shadow audits
      └─ quantize.py ─── int8 (width 32, for the processor)
          └─ lock.py ─── models.lock.json: every file's size and sha256
              └─ publish_hf.py ─ Hugging Face model repo; pins the commit in the lock
                  └─ fetch-models.ts ─ download (or --from out/), verify, split ≤ 24 MiB, write manifest.json
```

## Reproduce the exports

```sh
cd tools/models
uv sync                                          # Python 3.12, PyTorch, ONNX, ONNX Runtime
uv run calibrate.py nafnet-sidd-w32 nafnet-sidd-w64 # only to re-derive attention-bounds/ (committed); needs SIDD
uv run export.py nafnet-sidd-w32 nafnet-sidd-w64 # downloads and verifies the checkpoints on first run
uv run quantize.py nafnet-sidd-w32               # needs the SIDD validation set (downloaded on first run, 310 MB)
uv run lock.py
cd ../..
pnpm fetch-models --from tools/models/out        # until the Hugging Face repo is published
```

The exports are deterministic: the same checkpoints and tool versions give the
same bytes, so `models.lock.json` doubles as a reproducibility check.

| Script                | What it does                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nafnet.py`           | NAFNet, reimplemented from the paper for export. No NAFNet or BasicSR source is vendored; parameter names match the official checkpoints, which load with `strict=True`.                          |
| `checkpoints.py`      | The official Google Drive links from the NAFNet README and their pinned sha256.                                                                                                                   |
| `calibrate.py`        | Each block's channel-attention range, per channel, over the 1,280 SIDD validation crops: `attention-bounds/<model>.json`.                                                                         |
| `export.py`           | ONNX export (opset 17) with the attention bounded, fp16 conversion, comparison with PyTorch, fp16 overflow audit, dark-shadow audit.                                                              |
| `quantize.py`         | Static QDQ int8 quantization of the convolutions, calibrated on 64 noisy SIDD crops.                                                                                                              |
| `verify_reference.py` | Runs every export on NAFNet's own `demo/noisy.png` and compares with its published `demo/denoise_img.png`.                                                                                        |
| `evaluate.py`         | PSNR and SSIM on the 1,280 SIDD validation crops.                                                                                                                                                 |
| `lock.py`             | Writes `models.lock.json` from `out/`.                                                                                                                                                            |
| `publish_hf.py`       | Uploads the locked files and a model card (`MODEL_CARD.md`) to Hugging Face, then pins the commit.                                                                                                |
| `make_test_models.py` | The two tiny models CI uses (`test-models/`): one inverts colours exactly, one returns NaN.                                                                                                       |
| `make_golden.py`      | Golden images for the browser pipeline (`apps/web/e2e/fixtures/golden/`): a noisy scene, NAFNet's output for it in one pass, and tiled the way Hush tiles it, all on ONNX Runtime's CPU provider. |
| `fetch-models.ts`     | Node, no Python: fetch, verify sha256, split into ≤ 24 MiB parts, write `manifest.json`.                                                                                                          |

## What was verified

- **Architecture**: bit-identical to the upstream implementation (max difference 0.0) on random input.
- **fp32 export**: within 3 × 10⁻⁷ (width 32) and 2 × 10⁻⁶ (width 64) of PyTorch.
- **Against NAFNet's published output**: the width-64 fp32 export reproduces `demo/denoise_img.png` at 96.3 dB, never more than one level off; fp16 at 69.4 dB, also never more than one level off.
- **fp16 on a real GPU**: matches fp32 at 62.6 dB in Chrome's WebGPU (max difference one level).

### The fp16 trap

A plain fp16 conversion returns **NaN on WebGPU** while looking perfect on
ONNX Runtime's CPU provider, which silently runs unsupported fp16 ops in fp32.
NAFNet's middle blocks square deviations up to ~67,000 inside each LayerNorm,
and global average pools sum to ~200,000; fp16 stops at 65,504. `export.py`
therefore keeps every LayerNorm and global pool in fp32 (`fp32_islands`) and
fails the export if anything left in fp16 comes within 2× of overflow. The
browser also refuses non-finite model output (`ModelOutputError`), and CI runs a
NaN-producing test model to prove it.

### The shadow runaway

NAFNet's channel attention multiplies each channel by a weight taken from the
whole tile's mean, and nothing limits it. On a high-ISO shadow with JPEG
blocking, which SIDD (lossless) never shows, the weights feed on themselves
through the deepest blocks: in each of two ISO 32,000 camera JPEGs, three of
seventy 768-px tiles came out as purple 2-pixel stripes (the decoder's pixel
shuffles), in fp32 PyTorch exactly as on a GPU. Tile size, fp16 and TLC-style
local pooling all leave it; lifting the input stops it but costs 0.5–1.4 dB on
SIDD.

`export.py` therefore clamps every attention weight to its range on SIDD
(`calibrate.py`), widened by a quarter of that range (`ATTENTION_MARGIN`). The
export fails if the committed `apps/web/e2e/fixtures/dark-shadow.jpg` (made by
`tools/fixtures`) comes out rougher than it went in. Measured with the bounds:

- **The shadow**: 0.44× the input's roughness (width 32), 0.05× (width 64);
  unbounded, 48× and 1.1×. In Chrome (`e2e:real`), 0.48× on WebGPU and 0.30×
  on the processor, where the unbounded export gave 28× and 10.5×.
- **SIDD**: the clamp never engages; every score is unchanged to the last
  digit (`evaluate.py --every 4`: 39.951 dB width 32, 40.302 dB width 64).
- **NAFNet's demo**: still reproduced as before (96.3 dB, never more than one
  level off).
- **The golden scene**: the clamp engages a little in its synthetic 3-pixel
  stripes (12% of pixels, at most 6 levels), 0.03–0.05 dB closer to the clean
  scene; the golden references were regenerated.
- **The two camera JPEGs**: every 400-px block of the export is smoother than
  the original (median 0.46×, worst 0.76×); the stripe tiles come out close to
  what width 64, which doesn't run away there, gives.
- **Speed**: unchanged, 0.52 MP/s at 24 and 45 MP on an M1 Pro.

## Publishing

`models.lock.json` names the Hugging Face repo (`hush-photo/nafnet-sidd-onnx`)
with `revision: null` until the first publish. Claim the organisation, log in
with a write token (`hf auth login`), then:

```sh
uv run publish_hf.py --dry-run
uv run publish_hf.py      # uploads, then runs lock.py --revision <commit>
```

Commit the updated lock. From then on `pnpm fetch-models` downloads that exact
commit and every deploy verifies every file's sha256.

Before publishing, open an issue on `megvii-research/NAFNet` asking the authors
to confirm the pretrained SIDD weights are covered by the repository's MIT
licence (app spec §4.6, "residual risk"), and link the answer from the model card.
