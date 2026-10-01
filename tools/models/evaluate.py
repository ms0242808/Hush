# SPDX-License-Identifier: Apache-2.0
"""Measure exported models on the SIDD validation set, the way NAFNet reports it.

    uv run evaluate.py                       every model in out/
    uv run evaluate.py --every 4             a quarter of the crops, for a quick look

PSNR over RGB, no border crop, averaged over crops, two ways:
  psnr       on outputs clamped, scaled and rounded to 8-bit — what a photo gets;
  psnrFloat  on unrounded outputs, as NAFNet's validation computes it
             (README: 39.97 dB width 32, 40.30 dB width 64).
SSIM is the standard per-channel 11×11 Gaussian SSIM on 8-bit outputs; NAFNet
reports a 3-D variant, so compare SSIM between our variants only. Runs on ONNX
Runtime's CPU provider for reproducible numbers; speed is measured in the
browser, not here.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import time

import numpy as np
import onnxruntime as ort

import sidd

OUT = pathlib.Path(__file__).parent / 'out'


def psnr(a: np.ndarray, b: np.ndarray) -> float:
	mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
	return float('inf') if mse == 0 else float(10 * np.log10(255.0**2 / mse))


def _filter(img: np.ndarray, window: np.ndarray) -> np.ndarray:
	"""'valid' 2-D correlation per channel with a separable Gaussian window."""
	k = window.shape[0]
	h, w = img.shape[:2]
	rows = sum(window[i] * img[i : h - k + 1 + i] for i in range(k))
	return sum(window[j] * rows[:, j : w - k + 1 + j] for j in range(k))


def ssim(a: np.ndarray, b: np.ndarray) -> float:
	"""SSIM with an 11×11 Gaussian (σ 1.5), per channel then averaged — BasicSR's calculate_ssim."""
	x = np.arange(11) - 5
	g = np.exp(-(x**2) / (2 * 1.5**2))
	g /= g.sum()
	c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
	a = a.astype(np.float64)
	b = b.astype(np.float64)
	mu_a, mu_b = _filter(a, g), _filter(b, g)
	var_a = _filter(a * a, g) - mu_a**2
	var_b = _filter(b * b, g) - mu_b**2
	cov = _filter(a * b, g) - mu_a * mu_b
	value = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (var_a + var_b + c2))
	return float(value.mean())


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('models', nargs='*', help='file names in out/ (default: all)')
	parser.add_argument('--every', type=int, default=1, help='use every Nth crop')
	args = parser.parse_args()

	models = [OUT / m for m in args.models] if args.models else sorted(OUT.glob('*.onnx'))
	crops = list(sidd.pairs(every=args.every))
	options = ort.SessionOptions()
	options.intra_op_num_threads = 8

	report = []
	noisy_psnr = np.mean([psnr(noisy, clean) for _, noisy, clean in crops])
	print(json.dumps({'model': '(noisy input)', 'crops': len(crops), 'psnr': round(float(noisy_psnr), 3)}), flush=True)
	for path in models:
		session = ort.InferenceSession(str(path), options, providers=['CPUExecutionProvider'])
		psnrs, float_psnrs, ssims = [], [], []
		start = time.perf_counter()
		for _, noisy, clean in crops:
			x = (noisy.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
			(y,) = session.run(None, {'input': x})
			unrounded = np.clip(y[0].transpose(1, 2, 0) * 255.0, 0, 255)
			out = unrounded.round().astype(np.uint8)
			psnrs.append(psnr(out, clean))
			float_psnrs.append(psnr(unrounded, clean))
			ssims.append(ssim(out, clean))
		entry = {
			'model': path.name,
			'crops': len(crops),
			'psnr': round(float(np.mean(psnrs)), 3),
			'psnrFloat': round(float(np.mean(float_psnrs)), 3),
			'ssim': round(float(np.mean(ssims)), 4),
			'seconds': round(time.perf_counter() - start, 1),
		}
		report.append(entry)
		print(json.dumps(entry), flush=True)

	suffix = '' if args.every == 1 else f'-every{args.every}'
	(OUT / f'sidd-eval{suffix}.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
	main()
