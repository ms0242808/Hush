# Model tools

Everything between the official NAFNet checkpoints and the files Hush serves.
Python, managed with [uv](https://docs.astral.sh/uv/); only needed to produce or
re-check models, never to build or run the app.

```
official checkpoint (Google Drive, sha256-pinned)
  └─ export.py ───────── ONNX fp32 + fp16, checked against PyTorch and an fp16 overflow audit
      └─ quantize.py ─── int8 (width 32, for the processor)
          └─ lock.py ─── models.lock.json: every file's size and sha256
              └─ publish_hf.py ─ Hugging Face model repo; pins the commit in the lock
                  └─ fetch-models.ts ─ download (or --from out/), verify, split ≤ 24 MiB, write manifest.json
```

## Reproduce the exports

```sh
cd tools/models
uv sync                                          # Python 3.12, PyTorch, ONNX, ONNX Runtime
uv run export.py nafnet-sidd-w32 nafnet-sidd-w64 # downloads and verifies the checkpoints on first run
uv run quantize.py nafnet-sidd-w32               # needs the SIDD validation set (downloaded on first run, 310 MB)
uv run lock.py
cd ../..
pnpm fetch-models --from tools/models/out        # until the Hugging Face repo is published
```

The exports are deterministic: the same checkpoints and tool versions give the
same bytes, so `models.lock.json` doubles as a reproducibility check.

| Script                | What it does                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nafnet.py`           | NAFNet, reimplemented from the paper for export. No NAFNet or BasicSR source is vendored; parameter names match the official checkpoints, which load with `strict=True`. |
| `checkpoints.py`      | The official Google Drive links from the NAFNet README and their pinned sha256.                                                                                          |
| `export.py`           | ONNX export (opset 17), fp16 conversion, comparison with PyTorch, fp16 overflow audit.                                                                                   |
| `quantize.py`         | Static QDQ int8 quantization of the convolutions, calibrated on 64 noisy SIDD crops.                                                                                     |
| `verify_reference.py` | Runs every export on NAFNet's own `demo/noisy.png` and compares with its published `demo/denoise_img.png`.                                                               |
| `evaluate.py`         | PSNR and SSIM on the 1,280 SIDD validation crops.                                                                                                                        |
| `lock.py`             | Writes `models.lock.json` from `out/`.                                                                                                                                   |
| `publish_hf.py`       | Uploads the locked files and a model card (`MODEL_CARD.md`) to Hugging Face, then pins the commit.                                                                       |
| `make_test_models.py` | The two tiny models CI uses (`test-models/`): one inverts colours exactly, one returns NaN.                                                                              |
| `fetch-models.ts`     | Node, no Python: fetch, verify sha256, split into ≤ 24 MiB parts, write `manifest.json`.                                                                                 |

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
