# SPDX-License-Identifier: Apache-2.0
"""SIDD validation crops: 1,280 pairs of 256×256 noisy and clean sRGB images.

Read from the LMDB files NAFNet's evaluation uses (docs/SIDD.md, "Download the
evaluation data"), unzipped under `.cache/sidd/`. SIDD is MIT-licensed.
"""

from __future__ import annotations

import io
import pathlib
import zipfile
from collections.abc import Iterator

import lmdb
import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).parent / '.cache' / 'sidd'
ZIP = ROOT / 'sidd-val.zip'
GDRIVE_ID = '1gZx_K2vmiHalRNOb1aj93KuUQ2guOlLp'


def _find(name: str) -> pathlib.Path:
	matches = list(ROOT.rglob(name))
	if not matches:
		if not ZIP.exists():
			import gdown

			ROOT.mkdir(parents=True, exist_ok=True)
			gdown.download(id=GDRIVE_ID, output=str(ZIP), quiet=False)
		with zipfile.ZipFile(ZIP) as archive:
			archive.extractall(ROOT)
		matches = list(ROOT.rglob(name))
	if not matches:
		raise SystemExit(f'{name} not found in {ROOT}')
	return matches[0]


def _keys(db: pathlib.Path) -> list[str]:
	# meta_info.txt lines look like "ValidationBlocksSrgb_0.png (256,256,3) 1"; the LMDB key drops ".png".
	meta = db / 'meta_info.txt'
	return [line.split(' ')[0].removesuffix('.png') for line in meta.read_text().splitlines() if line.strip()]


def pairs(limit: int | None = None, every: int = 1) -> Iterator[tuple[str, np.ndarray, np.ndarray]]:
	"""Yield (key, noisy, clean) as uint8 HWC RGB arrays."""
	noisy_db = _find('input_crops.lmdb')
	clean_db = _find('gt_crops.lmdb')
	keys = _keys(noisy_db)[::every][:limit]
	with (
		lmdb.open(str(noisy_db), readonly=True, lock=False, readahead=False) as noisy_env,
		lmdb.open(str(clean_db), readonly=True, lock=False, readahead=False) as clean_env,
		noisy_env.begin() as noisy_txn,
		clean_env.begin() as clean_txn,
	):
		for key in keys:
			noisy = Image.open(io.BytesIO(noisy_txn.get(key.encode()))).convert('RGB')
			clean = Image.open(io.BytesIO(clean_txn.get(key.encode()))).convert('RGB')
			yield key, np.asarray(noisy), np.asarray(clean)
