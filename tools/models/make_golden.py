# SPDX-License-Identifier: Apache-2.0
"""Golden images for the browser pipeline (§11): a noisy photo, and NAFNet's output for it
computed here, independently of the browser.

    uv run make_golden.py

Two kinds of reference, both from the fp32 export on ONNX Runtime's CPU provider:

  whole       one pass over the photo, after the same 48-pixel mirror margin Hush adds
              at its edges. What the model "means". Tiling can't match it exactly: each
              NAFNet block's global average pool sees only its own tile, so fine texture
              comes out a little differently per tile (about 45 dB on this scene, mostly
              in the 3-pixel stripes; no seams).
  tiled-N     the same photo tiled the way Hush tiles it under an N-pixel ceiling —
              fewest tiles, shared evenly, cosine feather over the overlap — written here
              from the spec, not from Hush's code. The browser must match this one
              closely: only fp16 and summation order separate them.

Writes apps/web/e2e/fixtures/golden/: the noisy input and the references, 8-bit PNG.
"""

from __future__ import annotations

import math
import pathlib

import numpy as np
import onnxruntime as ort
from PIL import Image

HERE = pathlib.Path(__file__).parent
OUT = HERE.parents[1] / 'apps' / 'web' / 'e2e' / 'fixtures' / 'golden'
MODEL = HERE / 'out' / 'nafnet-sidd-w32.fp32.onnx'
WIDTH, HEIGHT = 1024, 768
MARGIN = 48  # the manifest's overlap: Hush's mirror margin at image edges
PAD_MULTIPLE = 16


def noisy_photo(seed: int = 2026) -> np.ndarray:
	"""A deterministic high-ISO-like scene: smooth gradients, hard edges, fine lines, luminance and colour noise."""
	rng = np.random.default_rng(seed)
	y, x = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float64)
	rgb = np.stack(
		[
			70 + 110 * np.sin(x / 210) ** 2 + 30 * y / HEIGHT,
			60 + 90 * y / HEIGHT + 20 * np.cos(x / 97),
			120 + 60 * np.cos((x + y) / 300),
		],
		axis=-1,
	)
	rgb[180:420, 240:520] = (205, 196, 182)  # a flat, light box
	rgb[500:620, 600:960] = (40, 44, 52)  # a flat, dark box
	stripes = (x.astype(int) // 3) % 2 == 0
	rgb[640:740, 80:420][stripes[640:740, 80:420]] *= 0.55  # fine detail
	rgb += rng.normal(0, 15, (HEIGHT, WIDTH, 1)) + rng.normal(0, 6, (HEIGHT, WIDTH, 3))
	return np.clip(rgb, 0, 255).round().astype(np.uint8)


def denoise(image: np.ndarray) -> np.ndarray:
	session = ort.InferenceSession(str(MODEL), providers=['CPUExecutionProvider'])
	padded = np.pad(image.astype(np.float32) / 255.0, ((MARGIN, MARGIN), (MARGIN, MARGIN), (0, 0)), mode='reflect')
	h, w = padded.shape[:2]
	extra_h = (-h) % PAD_MULTIPLE
	extra_w = (-w) % PAD_MULTIPLE
	padded = np.pad(padded, ((0, extra_h), (0, extra_w), (0, 0)), mode='reflect')
	tensor = padded.transpose(2, 0, 1)[None]
	output = session.run(None, {session.get_inputs()[0].name: tensor})[0][0].transpose(1, 2, 0)
	output = output[MARGIN : MARGIN + HEIGHT, MARGIN : MARGIN + WIDTH]
	return np.clip(output * 255.0 + 0.5, 0, 255).astype(np.uint8)


def plan_axis(length: int, ceiling: int) -> tuple[int, list[int]]:
	"""Fewest tiles of at most `ceiling` (a multiple of 16) covering the mirrored axis, shared evenly."""
	most = (ceiling // PAD_MULTIPLE) * PAD_MULTIPLE
	start, extended = -MARGIN, length + 2 * MARGIN
	if extended <= most:
		return math.ceil(extended / PAD_MULTIPLE) * PAD_MULTIPLE, [start]

	def size_for(n: int) -> int:
		return math.ceil(math.ceil((extended + (n - 1) * MARGIN) / n) / PAD_MULTIPLE) * PAD_MULTIPLE

	count = math.ceil((extended - MARGIN) / (most - MARGIN))
	size = size_for(count)
	while size > most:
		count += 1
		size = size_for(count)
	span = extended - size
	return size, [start + (i * span) // (count - 1) for i in range(count)]


def feather(size: int) -> np.ndarray:
	"""Raised-cosine ramps over the overlap at both ends, flat in between."""
	ramp = min(MARGIN, size // 2)
	i = np.arange(size)

	def rise(p: np.ndarray) -> np.ndarray:
		return 0.5 - 0.5 * np.cos(np.pi * (p + 0.5) / ramp)

	return np.where(i < ramp, rise(i), 1.0) * np.where(size - 1 - i < ramp, rise(size - 1 - i), 1.0)


def mirror(index: np.ndarray, length: int) -> np.ndarray:
	period = 2 * (length - 1)
	m = np.mod(index, period)
	return np.where(m < length, m, period - m)


def denoise_tiled(image: np.ndarray, ceiling: int) -> np.ndarray:
	session = ort.InferenceSession(str(MODEL), providers=['CPUExecutionProvider'])
	h, w = image.shape[:2]
	tile_w, xs = plan_axis(w, ceiling)
	tile_h, ys = plan_axis(h, ceiling)
	weights = feather(tile_h)[:, None] * feather(tile_w)[None, :]
	total = np.zeros((h, w, 3))
	norm = np.zeros((h, w, 1))
	source = image.astype(np.float32) / 255.0
	for y0 in ys:
		for x0 in xs:
			rows, cols = mirror(np.arange(y0, y0 + tile_h), h), mirror(np.arange(x0, x0 + tile_w), w)
			tile = source[rows][:, cols].transpose(2, 0, 1)[None]
			result = session.run(None, {session.get_inputs()[0].name: tile})[0][0].transpose(1, 2, 0)
			ty, tx = np.arange(y0, y0 + tile_h), np.arange(x0, x0 + tile_w)
			keep_y, keep_x = (ty >= 0) & (ty < h), (tx >= 0) & (tx < w)
			region = np.ix_(ty[keep_y], tx[keep_x])
			total[region] += (result * weights[..., None])[np.ix_(keep_y, keep_x)]
			norm[region] += weights[..., None][np.ix_(keep_y, keep_x)]
	return np.clip(total / norm * 255.0 + 0.5, 0, 255).astype(np.uint8)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
	return float(10 * np.log10(255.0**2 / np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)))


def main() -> None:
	OUT.mkdir(parents=True, exist_ok=True)
	noisy = noisy_photo()
	clean = denoise(noisy)
	Image.fromarray(noisy, 'RGB').save(OUT / 'noisy-1024x768.png', optimize=True)
	Image.fromarray(clean, 'RGB').save(OUT / 'nafnet-sidd-w32.fp32.png', optimize=True)
	diff = noisy.astype(np.int16) - clean.astype(np.int16)
	print(f'noise removed: {diff.std():.1f} levels RMS')
	# The ceilings Hush uses by default: 768 on WebGPU, 512 on the processor.
	for ceiling in (768, 512):
		tiled = denoise_tiled(noisy, ceiling)
		Image.fromarray(tiled, 'RGB').save(OUT / f'nafnet-sidd-w32.fp32.tiled-{ceiling}.png', optimize=True)
		print(f'tiled under {ceiling} px: {psnr(tiled, clean):.1f} dB against one pass')
	print(f'wrote {OUT}')


if __name__ == '__main__':
	main()
