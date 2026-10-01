# SPDX-License-Identifier: Apache-2.0
"""Build the tiny ONNX models the end-to-end tests run instead of NAFNet.

    uv run make_test_models.py

Both have NAFNet's interface (NCHW float32 RGB in [0, 1], any size) and run in
milliseconds on the WASM backend CI uses.

`hush-test-invert` computes 1 − x with a single 1×1 convolution. Its output is
exact: if the tiler, band accumulator or blend is off by one pixel or one level
anywhere, the inverted photo won't match pixel for pixel. A model that changes
nothing couldn't prove it ran at all.

`hush-test-nan` returns x / (x − x): NaN and infinity everywhere, the way an
fp16 overflow on a GPU does. The app must refuse it rather than export a black
photo.
"""

from __future__ import annotations

import hashlib
import json
import pathlib

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

OUT = pathlib.Path(__file__).parent / 'test-models'


def invert_model() -> onnx.ModelProto:
	weight = numpy_helper.from_array(-np.eye(3, dtype=np.float32).reshape(3, 3, 1, 1), 'weight')
	bias = numpy_helper.from_array(np.ones(3, dtype=np.float32), 'bias')
	graph = helper.make_graph(
		[helper.make_node('Conv', ['input', 'weight', 'bias'], ['output'], kernel_shape=[1, 1])],
		'hush-test-invert',
		[helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 'height', 'width'])],
		[helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3, 'height', 'width'])],
		initializer=[weight, bias],
	)
	model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='hush')
	model.ir_version = 8
	onnx.checker.check_model(model, full_check=True)
	return model


def nan_model() -> onnx.ModelProto:
	graph = helper.make_graph(
		[
			helper.make_node('Sub', ['input', 'input'], ['zero']),
			helper.make_node('Div', ['input', 'zero'], ['output']),
		],
		'hush-test-nan',
		[helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 'height', 'width'])],
		[helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3, 'height', 'width'])],
	)
	model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='hush')
	model.ir_version = 8
	onnx.checker.check_model(model, full_check=True)
	return model


def entry(model_id: str, label_en: str, label_zh: str, path: pathlib.Path) -> dict:
	data = path.read_bytes()
	return {
		'id': model_id,
		'family': 'test',
		'task': 'denoise',
		'label': {'en': label_en, 'zh-Hant': label_zh},
		'tile': {'padMultiple': 16, 'overlap': 16},
		'input': {'range': [0, 1], 'layout': 'NCHW', 'colour': 'RGB'},
		'licence': {'code': 'Apache-2.0 (Hush)', 'weights': 'Apache-2.0 (Hush)', 'trainingData': 'None'},
		'variants': [
			{
				'precision': 'fp32',
				'file': path.name,
				'bytes': len(data),
				'sha256': hashlib.sha256(data).hexdigest(),
				'backends': ['webgpu', 'wasm'],
			}
		],
	}


def main() -> None:
	OUT.mkdir(exist_ok=True)
	invert = OUT / 'hush-test-invert.fp32.onnx'
	onnx.save(invert_model(), str(invert))
	nan = OUT / 'hush-test-nan.fp32.onnx'
	onnx.save(nan_model(), str(nan))

	lock = {
		'schema': 1,
		'source': {'kind': 'repository', 'path': '.'},
		'active': {'denoise': 'hush-test-invert'},
		'models': [
			entry('hush-test-invert', 'Test model (inverts colours)', '測試模型（反轉色彩）', invert),
			entry('hush-test-nan', 'Test model (returns NaN)', '測試模型（輸出 NaN）', nan),
		],
	}
	(OUT / 'models.lock.json').write_text(json.dumps(lock, indent='\t', ensure_ascii=False) + '\n')
	for path in (invert, nan):
		print(f'{path.name}: {path.stat().st_size} bytes')


if __name__ == '__main__':
	main()
