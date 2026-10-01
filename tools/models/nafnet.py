# SPDX-License-Identifier: Apache-2.0
"""NAFNet, written for export.

An independent implementation of the architecture described in
"Simple Baselines for Image Restoration" (Chen, Chu, Zhang, Sun — ECCV 2022,
arXiv:2204.04676). No source is copied from megvii-research/NAFNet or BasicSR;
parameter names match the official checkpoints so they load with strict=True.

Differences from the training code, all deliberate for inference export:
  * LayerNorm2d is plain tensor ops (the original uses a custom autograd
    function, which ONNX can't trace).
  * No dropout.
  * The model does not pad its input. Hush's tiler guarantees tiles whose sides
    are multiples of `PAD_MULTIPLE`, so padding and cropping inside the graph
    would only add work.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn

PAD_MULTIPLE = 16  # 2 ** number of encoder levels


@dataclass(frozen=True)
class NAFNetConfig:
	width: int
	enc_blk_nums: tuple[int, ...]
	middle_blk_num: int
	dec_blk_nums: tuple[int, ...]


# The SIDD configurations from the official test options
# (options/test/SIDD/NAFNet-width{32,64}.yml).
CONFIGS: dict[str, NAFNetConfig] = {
	'nafnet-sidd-w32': NAFNetConfig(width=32, enc_blk_nums=(2, 2, 4, 8), middle_blk_num=12, dec_blk_nums=(2, 2, 2, 2)),
	'nafnet-sidd-w64': NAFNetConfig(width=64, enc_blk_nums=(2, 2, 4, 8), middle_blk_num=12, dec_blk_nums=(2, 2, 2, 2)),
}


class LayerNorm2d(nn.Module):
	"""Layer norm over the channel dimension of an NCHW tensor."""

	def __init__(self, channels: int, eps: float = 1e-6) -> None:
		super().__init__()
		self.weight = nn.Parameter(torch.ones(channels))
		self.bias = nn.Parameter(torch.zeros(channels))
		self.eps = eps

	def forward(self, x: torch.Tensor) -> torch.Tensor:
		mu = x.mean(1, keepdim=True)
		centred = x - mu
		var = centred.pow(2).mean(1, keepdim=True)
		y = centred / (var + self.eps).sqrt()
		return self.weight.view(1, -1, 1, 1) * y + self.bias.view(1, -1, 1, 1)


class SimpleGate(nn.Module):
	"""Split channels in half and multiply the halves: NAFNet's stand-in for an activation.

	The channel count is fixed at construction. `x.chunk(2, dim=1)` traces into a
	Shape → Gather → Div → Split chain per gate, which ONNX Runtime keeps on the
	CPU; constant slices keep the whole graph on the GPU.
	"""

	def __init__(self, channels: int) -> None:
		super().__init__()
		self.half = channels // 2

	def forward(self, x: torch.Tensor) -> torch.Tensor:
		return x[:, : self.half] * x[:, self.half :]


class NAFBlock(nn.Module):
	def __init__(self, c: int, dw_expand: int = 2, ffn_expand: int = 2) -> None:
		super().__init__()
		dw = c * dw_expand
		ffn = c * ffn_expand

		self.norm1 = LayerNorm2d(c)
		self.conv1 = nn.Conv2d(c, dw, kernel_size=1)
		self.conv2 = nn.Conv2d(dw, dw, kernel_size=3, padding=1, groups=dw)
		self.sg = SimpleGate(dw)
		# Simplified channel attention: global average pool, then a 1×1 conv.
		self.sca = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Conv2d(dw // 2, dw // 2, kernel_size=1))
		self.conv3 = nn.Conv2d(dw // 2, c, kernel_size=1)

		self.norm2 = LayerNorm2d(c)
		self.conv4 = nn.Conv2d(c, ffn, kernel_size=1)
		self.sg2 = SimpleGate(ffn)
		self.conv5 = nn.Conv2d(ffn // 2, c, kernel_size=1)

		self.beta = nn.Parameter(torch.zeros((1, c, 1, 1)))
		self.gamma = nn.Parameter(torch.zeros((1, c, 1, 1)))

	def forward(self, inp: torch.Tensor) -> torch.Tensor:
		x = self.sg(self.conv2(self.conv1(self.norm1(inp))))
		x = self.conv3(x * self.sca(x))
		y = inp + x * self.beta

		x = self.conv5(self.sg2(self.conv4(self.norm2(y))))
		return y + x * self.gamma


class NAFNet(nn.Module):
	def __init__(self, config: NAFNetConfig, img_channel: int = 3) -> None:
		super().__init__()
		width = config.width
		self.intro = nn.Conv2d(img_channel, width, kernel_size=3, padding=1)
		self.ending = nn.Conv2d(width, img_channel, kernel_size=3, padding=1)

		self.encoders = nn.ModuleList()
		self.downs = nn.ModuleList()
		self.ups = nn.ModuleList()
		self.decoders = nn.ModuleList()

		chan = width
		for num in config.enc_blk_nums:
			self.encoders.append(nn.Sequential(*[NAFBlock(chan) for _ in range(num)]))
			self.downs.append(nn.Conv2d(chan, chan * 2, kernel_size=2, stride=2))
			chan *= 2

		self.middle_blks = nn.Sequential(*[NAFBlock(chan) for _ in range(config.middle_blk_num)])

		for num in config.dec_blk_nums:
			self.ups.append(nn.Sequential(nn.Conv2d(chan, chan * 2, kernel_size=1, bias=False), nn.PixelShuffle(2)))
			chan //= 2
			self.decoders.append(nn.Sequential(*[NAFBlock(chan) for _ in range(num)]))

	def forward(self, inp: torch.Tensor) -> torch.Tensor:
		"""`inp` is NCHW RGB in [0, 1] with H and W multiples of PAD_MULTIPLE."""
		x = self.intro(inp)

		skips: list[torch.Tensor] = []
		for encoder, down in zip(self.encoders, self.downs):
			x = encoder(x)
			skips.append(x)
			x = down(x)

		x = self.middle_blks(x)

		for decoder, up, skip in zip(self.decoders, self.ups, reversed(skips)):
			x = decoder(up(x) + skip)

		return self.ending(x) + inp


def load_nafnet(model_id: str, checkpoint_path: str) -> NAFNet:
	"""Build the network for `model_id` and load an official checkpoint into it."""
	model = NAFNet(CONFIGS[model_id])
	checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=True)
	state = checkpoint.get('params', checkpoint)
	model.load_state_dict(state, strict=True)
	return model.eval()
