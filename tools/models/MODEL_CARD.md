---
license: mit
library_name: onnx
pipeline_tag: image-to-image
tags:
  - image-denoising
  - nafnet
  - onnx
  - webgpu
datasets:
  - SIDD
---

# NAFNet (SIDD) for ONNX Runtime Web

ONNX conversions of the official NAFNet SIDD checkpoints, prepared for
[Hush](https://github.com/ms0242808/Hush), an open-source photo denoiser that
runs in the browser. **These files are conversions of the original PyTorch
checkpoints, not new models.** All credit for the architecture and the weights
belongs to the NAFNet authors.

## Files

{{FILES}}

All files take `input`, float32 NCHW RGB in [0, 1] with height and width that
are multiples of 16, and return `output` with the same shape and range.

One addition to the published network, in every file: each block's channel
attention is clamped, per channel, to the range it spans on the 1,280 SIDD
validation crops, widened by a quarter of that range. Unbounded, the attention
runs away on dark high-ISO JPEG shadows (JPEG blocking is something SIDD never
shows), and the output turns into 2-pixel stripes. On SIDD the clamp never
engages, so the scores below are the published network's.

- **fp32**: a direct export (opset 17, TorchScript exporter). Matches PyTorch to
  within 3 × 10⁻⁷ (width 32) and 2 × 10⁻⁶ (width 64); the width-64 export
  reproduces NAFNet's published `demo/denoise_img.png` to within one level.
- **fp16**: weights and activations in float16, except every LayerNorm and every
  global average pool, which stay in float32. In fp16 those overflow on real
  photos (squared deviations reach ~67,000; fp16 stops at 65,504) and a GPU
  then returns NaN. Inputs and outputs are float32.
- **int8** (width 32 only): static QDQ quantization of every convolution,
  per-channel int8 weights and uint8 activations, calibrated on 64 noisy SIDD
  validation crops. For CPU inference.

## Quality on SIDD validation (1,280 crops)

{{QUALITY}}

PSNR is computed over RGB on 8-bit outputs, the way photos are delivered.
NAFNet's README reports 39.97 dB (width 32) and 40.30 dB (width 64) on float
outputs.

## Source and licence

- Architecture and weights: [megvii-research/NAFNet](https://github.com/megvii-research/NAFNet),
  commit `2b4af71`, SIDD checkpoints from the README's official links, sha256-pinned
  (`NAFNet-SIDD-width32.pth` `89c70e80…`, `NAFNet-SIDD-width64.pth` `cd685efa…`).
  MIT License, Copyright (c) 2022 megvii-model.
- Training data: [SIDD](https://abdokamel.github.io/sidd/), MIT License.
- Conversion code: [tools/models](https://github.com/ms0242808/Hush/tree/main/tools/models)
  in the Hush repository, Apache-2.0. It reimplements the architecture from the
  paper; no NAFNet or BasicSR source is vendored.

```
MIT License

Copyright (c) 2022 megvii-model

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Citation

```bibtex
@inproceedings{chen2022simple,
  title     = {Simple Baselines for Image Restoration},
  author    = {Chen, Liangyu and Chu, Xiaojie and Zhang, Xiangyu and Sun, Jian},
  booktitle = {European Conference on Computer Vision (ECCV)},
  year      = {2022}
}

@inproceedings{abdelhamed2018high,
  title     = {A High-Quality Denoising Dataset for Smartphone Cameras},
  author    = {Abdelhamed, Abdelrahman and Lin, Stephen and Brown, Michael S.},
  booktitle = {IEEE Conference on Computer Vision and Pattern Recognition (CVPR)},
  year      = {2018}
}
```
