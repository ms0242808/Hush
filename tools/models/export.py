# SPDX-License-Identifier: Apache-2.0
"""Export NAFNet checkpoints to ONNX, fp32 and fp16, and check them against PyTorch.

    uv run export.py nafnet-sidd-w32 nafnet-sidd-w64

Writes `out/<model>.fp32.onnx` and `out/<model>.fp16.onnx`, then prints a JSON
summary (bytes, sha256, error versus PyTorch) for the results write-up and the
model lock file.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import warnings

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxconverter_common import float16

from checkpoints import ensure_checkpoint, sha256_file
from nafnet import CONFIGS, PAD_MULTIPLE, load_nafnet

OUT_DIR = pathlib.Path(__file__).parent / 'out'
OPSET = 17
DYNAMIC_AXES = {'input': {2: 'height', 3: 'width'}, 'output': {2: 'height', 3: 'width'}}


def export_fp32(model: torch.nn.Module, path: pathlib.Path) -> None:
	example = torch.rand(1, 3, 256, 256)
	with warnings.catch_warnings():
		warnings.simplefilter('ignore')  # the TorchScript exporter warns that it is legacy
		torch.onnx.export(
			model,
			(example,),
			str(path),
			input_names=['input'],
			output_names=['output'],
			dynamic_axes=DYNAMIC_AXES,
			opset_version=OPSET,
			do_constant_folding=True,
			dynamo=False,
		)
	onnx_model = onnx.load(str(path))
	onnx.checker.check_model(onnx_model, full_check=True)


FP16_MAX = 65504.0


def fp32_islands(model: onnx.ModelProto) -> list[str]:
	"""Nodes that must stay in float32 inside the fp16 model.

	Every LayerNorm2d (statistics and affine) and every global average pool.
	Measured on real noise, NAFNet's middle blocks square deviations up to
	~67,000 and global pools sum to ~200,000: past fp16's 65,504. WebGPU computes
	fp16 natively, so these overflow to Inf and the output turns to NaN. (ONNX
	Runtime's CPU provider silently upcasts them, which hides the problem.)
	"""
	return [n.name for n in model.graph.node if '/norm1/' in n.name or '/norm2/' in n.name or n.op_type == 'GlobalAveragePool']


def convert_fp16(src: pathlib.Path, dst: pathlib.Path) -> None:
	fp32 = onnx.load(str(src))
	# keep_io_types: the browser feeds and reads float32; the casts sit inside the graph.
	with warnings.catch_warnings():
		warnings.simplefilter('ignore')  # "number will be truncated": weights below fp16's range become ±1e-7
		model = float16.convert_float_to_float16(fp32, keep_io_types=True, node_block_list=fp32_islands(fp32))
	onnx.checker.check_model(model, full_check=True)
	onnx.save(model, str(dst))


def audit_fp16_ranges(fp32_path: pathlib.Path, fp16_path: pathlib.Path) -> dict[str, float]:
	"""Fail if any op the fp16 model computes in fp16 gets within 2× of overflow.

	Runs the fp32 model on a noisy photo-like tile with every intermediate
	exposed, then checks the largest magnitude of each node that is fp16 in the
	converted model. Reductions are checked on their inputs' sums, the value an
	fp16 accumulator would have to hold.
	"""
	fp16_nodes = {n.name for n in onnx.load(str(fp16_path)).graph.node}
	islands = set(fp32_islands(onnx.load(str(fp32_path))))
	model = onnx.load(str(fp32_path))
	exposed = []
	for node in model.graph.node:
		if node.op_type == 'Constant' or node.name in islands or node.name not in fp16_nodes:
			continue
		for output in node.output:
			model.graph.output.append(onnx.helper.make_tensor_value_info(output, onnx.TensorProto.FLOAT, None))
			exposed.append((node.name, output))

	rng = np.random.default_rng(1)
	size = 512
	yy, xx = np.mgrid[0:size, 0:size] / size
	clean = np.stack([0.2 + 0.6 * xx, 0.3 + 0.5 * yy, 0.5 + 0.3 * np.sin(6 * xx)])[None].astype(np.float32)
	noisy = np.clip(clean + rng.normal(0, 0.1, clean.shape), 0, 1).astype(np.float32)
	session = ort.InferenceSession(model.SerializeToString(), providers=['CPUExecutionProvider'])
	values = session.run([o for _, o in exposed], {'input': noisy})
	worst_name, worst = '', 0.0
	for (name, _), value in zip(exposed, values):
		magnitude = float(np.max(np.abs(value)))
		if magnitude > worst:
			worst_name, worst = name, magnitude
	if worst > FP16_MAX / 2:
		raise SystemExit(f'{fp16_path.name}: {worst_name} reaches {worst:.0f} in fp16 (max {FP16_MAX:.0f}); keep it in fp32')
	return {'largestFp16Magnitude': round(worst, 1), 'largestFp16Node': worst_name}


def psnr(a: np.ndarray, b: np.ndarray) -> float:
	mse = float(np.mean((np.clip(a, 0, 1) - np.clip(b, 0, 1)) ** 2))
	return float('inf') if mse == 0 else 10 * np.log10(1.0 / mse)


def check_against_torch(model: torch.nn.Module, onnx_path: pathlib.Path, size: int = 256) -> dict[str, float]:
	"""Run PyTorch and ONNX Runtime (CPU) on the same noisy input and compare."""
	rng = np.random.default_rng(0)
	# A smooth gradient plus Gaussian noise: closer to a photo than uniform noise.
	yy, xx = np.mgrid[0:size, 0:size] / size
	clean = np.stack([xx, yy, 0.5 * (xx + yy)])[None].astype(np.float32)
	noisy = np.clip(clean + rng.normal(0, 0.08, clean.shape), 0, 1).astype(np.float32)

	with torch.no_grad():
		expected = model(torch.from_numpy(noisy)).numpy()

	session = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
	(actual,) = session.run(None, {'input': noisy})
	return {
		'maxAbsDiff': float(np.max(np.abs(actual - expected))),
		'psnrVsTorch': psnr(actual, expected),
	}


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('models', nargs='+', choices=sorted(CONFIGS))
	args = parser.parse_args()

	OUT_DIR.mkdir(exist_ok=True)
	summary = []
	for model_id in args.models:
		model = load_nafnet(model_id, str(ensure_checkpoint(model_id)))
		fp32 = OUT_DIR / f'{model_id}.fp32.onnx'
		fp16 = OUT_DIR / f'{model_id}.fp16.onnx'

		export_fp32(model, fp32)
		convert_fp16(fp32, fp16)

		audit = audit_fp16_ranges(fp32, fp16)
		for precision, path in (('fp32', fp32), ('fp16', fp16)):
			entry = {
				'model': model_id,
				'precision': precision,
				'file': path.name,
				'bytes': path.stat().st_size,
				'sha256': sha256_file(path),
				'opset': OPSET,
				'padMultiple': PAD_MULTIPLE,
			}
			if precision == 'fp16':
				entry |= audit
			try:
				entry |= check_against_torch(model, path)
			except Exception as error:  # e.g. no fp16 Conv kernel in this onnxruntime build
				entry['check'] = f'skipped: {type(error).__name__}: {error}'.splitlines()[0]
			summary.append(entry)
			print(json.dumps(entry), flush=True)

	(OUT_DIR / 'export-summary.json').write_text(json.dumps(summary, indent=2) + '\n')


if __name__ == '__main__':
	main()
