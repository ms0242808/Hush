# SPDX-License-Identifier: Apache-2.0
"""Measure the range of every block's channel attention on SIDD, for export.py to bound it.

    uv run calibrate.py nafnet-sidd-w32 nafnet-sidd-w64

NAFNet's simplified channel attention multiplies each channel by a weight
computed from the whole tile's mean, and nothing limits that weight. On a
high-ISO shadow with JPEG blocking, which SIDD (lossless) never shows, the
weights feed on themselves through the deepest blocks and the decoder's pixel
shuffles turn the result into 2-pixel stripes. On SIDD the weights stay within a
range; this records it per channel over all 1,280 validation crops, rounded
outwards, into `attention-bounds/<model>.json`. The files are committed, so an
export needs neither SIDD nor this script, and gives the same bytes anywhere.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib

import numpy as np
import torch

import sidd
from checkpoints import ensure_checkpoint
from nafnet import CONFIGS, blocks, load_nafnet

BOUNDS_DIR = pathlib.Path(__file__).parent / 'attention-bounds'
DECIMALS = 4


def calibrate(model_id: str) -> dict:
	model = load_nafnet(model_id, str(ensure_checkpoint(model_id)))
	low: dict[str, np.ndarray] = {}
	high: dict[str, np.ndarray] = {}

	def record(name: str):
		def hook(_module, _inputs, output: torch.Tensor) -> None:
			weights = output.reshape(output.shape[1]).numpy()
			low[name] = np.minimum(low.get(name, weights), weights)
			high[name] = np.maximum(high.get(name, weights), weights)

		return hook

	for name, block in blocks(model):
		block.sca.register_forward_hook(record(name))
	crops = 0
	with torch.no_grad():
		for _, noisy, _ in sidd.pairs():
			model(torch.from_numpy((noisy.astype(np.float32) / 255.0).transpose(2, 0, 1)[None].copy()))
			crops += 1

	scale = 10**DECIMALS
	return {
		'model': model_id,
		'source': f'SIDD validation, {crops} crops of 256 × 256',
		'blocks': {
			name: {
				'min': [math.floor(v * scale) / scale for v in low[name].tolist()],
				'max': [math.ceil(v * scale) / scale for v in high[name].tolist()],
			}
			for name, _ in blocks(model)
		},
	}


def write(path: pathlib.Path, bounds: dict) -> None:
	"""One block per line: readable diffs without a line per number."""
	lines = [f'\t\t{json.dumps(name)}: {json.dumps(value, separators=(",", ":"))}' for name, value in bounds['blocks'].items()]
	head = {key: value for key, value in bounds.items() if key != 'blocks'}
	text = '{\n' + ''.join(f'\t{json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},\n' for k, v in head.items())
	path.write_text(text + '\t"blocks": {\n' + ',\n'.join(lines) + '\n\t}\n}\n')


def load_bounds(model_id: str) -> dict[str, tuple[list[float], list[float]]]:
	path = BOUNDS_DIR / f'{model_id}.json'
	if not path.exists():
		raise SystemExit(f'{path.name} is missing: run `uv run calibrate.py {model_id}` first')
	return {name: (value['min'], value['max']) for name, value in json.loads(path.read_text())['blocks'].items()}


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('models', nargs='+', choices=sorted(CONFIGS))
	args = parser.parse_args()
	BOUNDS_DIR.mkdir(exist_ok=True)
	for model_id in args.models:
		bounds = calibrate(model_id)
		path = BOUNDS_DIR / f'{model_id}.json'
		write(path, bounds)
		print(f'{path.name}: {len(bounds["blocks"])} blocks, {path.stat().st_size:,} bytes', flush=True)


if __name__ == '__main__':
	main()
