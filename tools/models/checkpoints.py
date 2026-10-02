# SPDX-License-Identifier: Apache-2.0
"""Official NAFNet checkpoints: where they come from and what they must hash to.

The links are the Google Drive links in the NAFNet README
(https://github.com/megvii-research/NAFNet, commit 2b4af71). Never substitute a
third-party re-upload: the sha256 pin is what makes an export reproducible.
"""

from __future__ import annotations

import hashlib
import pathlib
from dataclasses import dataclass

CACHE_DIR = pathlib.Path(__file__).parent / '.cache' / 'checkpoints'


@dataclass(frozen=True)
class Checkpoint:
	filename: str
	gdrive_id: str
	sha256: str
	published_psnr: float  # SIDD validation PSNR from the NAFNet README


CHECKPOINTS: dict[str, Checkpoint] = {
	'nafnet-sidd-w32': Checkpoint(
		filename='NAFNet-SIDD-width32.pth',
		gdrive_id='1lsByk21Xw-6aW7epCwOQxvm6HYCQZPHZ',
		sha256='89c70e808d1783b6c07911306e106aaf0d4f7f3da8c61078b99ff7f8929a26f4',
		published_psnr=39.9672,
	),
	'nafnet-sidd-w64': Checkpoint(
		filename='NAFNet-SIDD-width64.pth',
		gdrive_id='14Fht1QQJ2gMlk4N1ERCRuElg8JfjrWWR',
		sha256='cd685efaae01f7c4e9951f2deab05780079c8eb1e49ed664b72f6db04dabb445',
		published_psnr=40.3045,
	),
}


def sha256_file(path: pathlib.Path) -> str:
	digest = hashlib.sha256()
	with path.open('rb') as f:
		for chunk in iter(lambda: f.read(1 << 20), b''):
			digest.update(chunk)
	return digest.hexdigest()


def ensure_checkpoint(model_id: str) -> pathlib.Path:
	"""Return the local path of a verified checkpoint, downloading it if needed."""
	ckpt = CHECKPOINTS[model_id]
	path = CACHE_DIR / ckpt.filename
	if not path.exists():
		import gdown  # imported lazily: only needed on a cold cache

		CACHE_DIR.mkdir(parents=True, exist_ok=True)
		gdown.download(id=ckpt.gdrive_id, output=str(path), quiet=False)

	actual = sha256_file(path)
	if ckpt.sha256 and actual != ckpt.sha256:
		raise SystemExit(
			f'{path.name}: sha256 {actual} does not match the pinned {ckpt.sha256}. '
			'Delete the file and download it again from the official link.'
		)
	return path
