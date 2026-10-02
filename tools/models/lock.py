# SPDX-License-Identifier: Apache-2.0
"""Write models.lock.json from the files in out/.

    uv run lock.py                 keep the current Hugging Face revision
    uv run lock.py --revision SHA  after publish_hf.py: pin the published commit

The lock is the single source of truth for what ships: fetch-models refuses
any file whose size or sha256 differs from it.
"""

from __future__ import annotations

import argparse
import json
import pathlib

from checkpoints import sha256_file

HERE = pathlib.Path(__file__).parent
OUT = HERE / 'out'
LOCK = HERE / 'models.lock.json'
HF_REPO = 'hush-photo/nafnet-sidd-onnx'

LICENCE = {
	'code': 'MIT (NAFNet, © 2022 megvii-model) + Apache-2.0 (BasicSR)',
	'weights': 'MIT (NAFNet repository)',
	'trainingData': 'SIDD (MIT)',
}

# Which backends each precision is for. fp16 needs WebGPU's shader-f16; int8
# runs only on the processor. Variants not listed here are not shipped.
BACKENDS = {'fp16': ['webgpu'], 'fp32': ['webgpu', 'wasm'], 'int8': ['wasm']}

# int8 is not shipped: in Phase 0 it ran only ~12% faster than fp32 on the
# processor while costing 0.95 dB on SIDD (docs/phase-0-results.md).
# quantize.py stays for later experiments; add 'int8' back here to ship it.
MODELS = [
	{'width': 32, 'precisions': ['fp16', 'fp32']},
	{'width': 64, 'precisions': ['fp16', 'fp32']},
]


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('--revision', help='Hugging Face commit the files were published at')
	args = parser.parse_args()

	previous = json.loads(LOCK.read_text()) if LOCK.exists() else {}
	revision = args.revision or previous.get('source', {}).get('revision')

	models = []
	for spec in MODELS:
		model_id = f'nafnet-sidd-w{spec["width"]}'
		variants = []
		for precision in spec['precisions']:
			path = OUT / f'{model_id}.{precision}.onnx'
			if not path.exists():
				raise SystemExit(f'{path.name} is missing: run export.py (and quantize.py for int8) first')
			variants.append(
				{
					'precision': precision,
					'file': path.name,
					'bytes': path.stat().st_size,
					'sha256': sha256_file(path),
					'backends': BACKENDS[precision],
				}
			)
		models.append(
			{
				'id': model_id,
				'family': 'nafnet',
				'task': 'denoise',
				'label': {'en': f'NAFNet (SIDD, width {spec["width"]})', 'zh-Hant': f'NAFNet（SIDD，寬度 {spec["width"]}）'},
				# channels: the widest tensor kept at full resolution (each block expands to 2 × width),
				# which with the precision sizes a tile's largest GPU buffer.
				'tile': {'padMultiple': 16, 'overlap': 48, 'channels': 2 * spec['width']},
				'input': {'range': [0, 1], 'layout': 'NCHW', 'colour': 'RGB'},
				'licence': LICENCE,
				'variants': variants,
			}
		)

	lock = {
		'schema': 1,
		'source': {'kind': 'huggingface', 'repo': HF_REPO, 'revision': revision},
		'active': {'denoise': 'nafnet-sidd-w32'},
		'models': models,
	}
	LOCK.write_text(json.dumps(lock, indent='\t', ensure_ascii=False) + '\n')
	for model in models:
		for v in model['variants']:
			print(f'{model["id"]} {v["precision"]:4} {v["bytes"]:>10} {v["sha256"][:16]}')


if __name__ == '__main__':
	main()
