# SPDX-License-Identifier: Apache-2.0
"""Check exported models against NAFNet's own published output.

    uv run verify_reference.py

The NAFNet repository ships `demo/noisy.png` and `demo/denoise_img.png`, the
width-64 SIDD model's output for it (README: "Image Denoise" demo). Running our
ONNX export on the same input must reproduce that image to within rounding.
Both files are pinned by commit and sha256.
"""

from __future__ import annotations

import hashlib
import io
import json
import pathlib
import urllib.request

import numpy as np
import onnxruntime as ort
from PIL import Image

COMMIT = '2b4af71ebe098a92a75910c233a3965a3e93ede4'
BASE = f'https://raw.githubusercontent.com/megvii-research/NAFNet/{COMMIT}/demo/'
FILES = {
	'noisy.png': '403034182fa320130dae0d75b92e85e0850771378e674d65455c403a4958e29c',
	'denoise_img.png': 'be1031225f65487e439105ee48aac467309b9cec46ad03c0bfd52c8374af06b9',
}
CACHE = pathlib.Path(__file__).parent / '.cache' / 'reference'
OUT = pathlib.Path(__file__).parent / 'out'


def fetch(name: str) -> np.ndarray:
	path = CACHE / name
	if not path.exists():
		CACHE.mkdir(parents=True, exist_ok=True)
		with urllib.request.urlopen(BASE + name) as response:  # noqa: S310 — fixed https URL
			path.write_bytes(response.read())
	data = path.read_bytes()
	if hashlib.sha256(data).hexdigest() != FILES[name]:
		raise SystemExit(f'{name}: unexpected sha256; delete {path} and retry')
	return np.asarray(Image.open(io.BytesIO(data)).convert('RGB'))


def run(model: pathlib.Path, rgb: np.ndarray) -> np.ndarray:
	session = ort.InferenceSession(str(model), providers=['CPUExecutionProvider'])
	x = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
	(y,) = session.run(None, {'input': x})
	# The same conversion as NAFNet's tensor2img: clamp, scale, round.
	return np.clip(y[0].transpose(1, 2, 0) * 255.0, 0, 255).round().astype(np.uint8)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
	mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
	return float('inf') if mse == 0 else float(10 * np.log10(255.0**2 / mse))


def main() -> None:
	noisy = fetch('noisy.png')
	official = fetch('denoise_img.png')
	results = []
	for model in sorted(OUT.glob('*.onnx')):
		output = run(model, noisy)
		diff = np.abs(output.astype(np.int16) - official.astype(np.int16))
		entry = {
			'model': model.name,
			'psnrVsOfficialW64': round(psnr(output, official), 2),
			'maxDiff': int(diff.max()),
			'pixelsOffByMoreThan1': int((diff > 1).sum()),
			'psnrVsNoisyInput': round(psnr(output, noisy), 2),
		}
		results.append(entry)
		print(json.dumps(entry), flush=True)
	(OUT / 'reference-check.json').write_text(json.dumps(results, indent=2) + '\n')


if __name__ == '__main__':
	main()
