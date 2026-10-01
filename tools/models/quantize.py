# SPDX-License-Identifier: Apache-2.0
"""Quantize an fp32 export to int8 for the processor-only path (§2.10).

    uv run quantize.py nafnet-sidd-w32

Static QDQ quantization of every convolution: int8 per-channel weights, uint8
activations, calibrated on noisy SIDD crops. Layer norms, gates and the
residual adds stay in float. Writes `out/<model>.int8.onnx`. Whether int8
ships is decided by evaluate.py, not here.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import tempfile

import numpy as np
from onnxruntime.quantization import CalibrationDataReader, CalibrationMethod, QuantFormat, QuantType, quantize_static
from onnxruntime.quantization.shape_inference import quant_pre_process

import sidd
from checkpoints import sha256_file

OUT = pathlib.Path(__file__).parent / 'out'
CALIBRATION_EVERY = 20  # 64 of the 1,280 crops


class NoisyCrops(CalibrationDataReader):
	def __init__(self) -> None:
		crops = [noisy for _, noisy, _ in sidd.pairs(every=CALIBRATION_EVERY)]
		self._feeds = iter([{'input': (c.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]} for c in crops])

	def get_next(self) -> dict[str, np.ndarray] | None:
		return next(self._feeds, None)


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('models', nargs='+')
	args = parser.parse_args()

	for model_id in args.models:
		src = OUT / f'{model_id}.fp32.onnx'
		dst = OUT / f'{model_id}.int8.onnx'
		with tempfile.TemporaryDirectory() as tmp:
			prepared = pathlib.Path(tmp) / 'prepared.onnx'
			# Symbolic shape inference can't follow the dynamic height and width through DepthToSpace;
			# ONNX's own shape inference is enough for per-channel Conv weights.
			quant_pre_process(str(src), str(prepared), skip_symbolic_shape=True)
			quantize_static(
				str(prepared),
				str(dst),
				NoisyCrops(),
				quant_format=QuantFormat.QDQ,
				op_types_to_quantize=['Conv'],
				per_channel=True,
				activation_type=QuantType.QUInt8,
				weight_type=QuantType.QInt8,
				calibrate_method=CalibrationMethod.MinMax,
			)
		print(json.dumps({'model': model_id, 'precision': 'int8', 'file': dst.name, 'bytes': dst.stat().st_size, 'sha256': sha256_file(dst)}))


if __name__ == '__main__':
	main()
