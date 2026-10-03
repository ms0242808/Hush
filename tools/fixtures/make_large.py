# SPDX-License-Identifier: Apache-2.0
"""Write a 45 MP high-ISO-style JPEG with full camera metadata, for the real-model checks.

    cd tools/fixtures && uv run make_large.py [width height]

The Phase 2 acceptance check (`pnpm --filter @hush/web e2e:real`) opens a
45 MP JPEG, times the before/after preview and compares the export's EXIF
with the original's. A file that size isn't committed: this script writes it
to apps/web/e2e/real/.photos/ (ignored by git), and the test runs it when the
file is missing. The scene is synthetic — sky gradient, hills, a lit town,
fine texture — with noise shaped like a sensor's at ISO 6400: grain in
luminance, coarser blotches in colour, stronger in the shadows. Metadata is
what a camera writes: make, model, lens, exposure, GPS, a maker note, an sRGB
profile. Deterministic for a given Pillow and numpy.
"""

from __future__ import annotations

import pathlib
import sys

import numpy as np
from PIL import Image, ImageCms
from PIL.TiffImagePlugin import IFDRational

OUT = pathlib.Path(__file__).resolve().parents[2] / 'apps' / 'web' / 'e2e' / 'real' / '.photos'


def scene(width: int, height: int, seed: int = 45) -> np.ndarray:
	rng = np.random.default_rng(seed)
	y = np.linspace(0, 1, height, dtype=np.float32)[:, None]
	x = np.linspace(0, 1, width, dtype=np.float32)[None, :]
	sky = np.stack([40 + 160 * (1 - y) ** 3, 30 + 60 * (1 - y) ** 2, 60 + 50 * (1 - y)], axis=-1)
	rgb = np.broadcast_to(sky, (height, width, 3)).astype(np.float32).copy()
	# Hills: darker, with fine texture the model has to keep.
	ridge = 0.55 + 0.08 * np.sin(x * 9.0) + 0.05 * np.sin(x * 23.0 + 1.3)
	hills = y > ridge
	texture = rng.normal(0, 1, (height // 8, width // 8)).astype(np.float32)
	texture = np.asarray(
		Image.fromarray(((texture * 30) + 128).clip(0, 255).astype(np.uint8)).resize((width, height), Image.BICUBIC),
		dtype=np.float32,
	)
	rgb[hills] = np.stack([18 + 0.1 * texture, 24 + 0.12 * texture, 20 + 0.08 * texture], axis=-1)[hills]
	# A lit town along the bottom: small bright windows.
	town = (y > 0.82) & (np.sin(x * 900) > 0.97) & (np.sin(y * 700) > 0.6)
	rgb[np.broadcast_to(town, (height, width))] = (250, 210, 120)
	# Sensor noise at ISO 6400.
	shadow = 1.7 - rgb.mean(axis=2, keepdims=True) / 255.0
	luma = rng.normal(0, 7, (height, width, 1)).astype(np.float32)
	chroma = rng.normal(0, 3, (height, width, 3)).astype(np.float32)
	blotch = rng.normal(0, 1, (height // 3, width // 3, 3)).astype(np.float32)
	blotch = (
		np.asarray(
			Image.fromarray(((blotch * 40) + 128).clip(0, 255).astype(np.uint8)).resize((width, height), Image.BILINEAR),
			dtype=np.float32,
		)
		- 128
	) * 0.1
	rgb += shadow * (luma + chroma + blotch)
	return rgb.clip(0, 255).astype(np.uint8)


def camera_exif() -> Image.Exif:
	exif = Image.Exif()
	exif[0x010F] = 'Sony'  # Make
	exif[0x0110] = 'ILCE-7RM4'  # Model
	exif[0x0131] = 'ILCE-7RM4 v2.00'  # Software: Hush replaces this one tag
	exif[0x0132] = '2026:09:14 19:42:07'  # DateTime
	exif[0x0112] = 1  # Orientation
	exif[0x013B] = 'Test Photographer'  # Artist
	exif[0x8298] = '(c) Test Photographer'  # Copyright
	sub = exif.get_ifd(0x8769)
	sub[0x829A] = IFDRational(1, 60)  # ExposureTime
	sub[0x829D] = IFDRational(28, 10)  # FNumber
	sub[0x8827] = 6400  # ISOSpeedRatings
	sub[0x9003] = '2026:09:14 19:42:07'  # DateTimeOriginal
	sub[0x920A] = IFDRational(35, 1)  # FocalLength
	sub[0xA434] = 'FE 35mm F1.4 GM'  # LensModel
	sub[0x927C] = b'SONY DSC \x00\x00\x00' + bytes(range(64))  # MakerNote: must survive byte for byte
	gps = exif.get_ifd(0x8825)
	gps[1] = 'N'
	gps[2] = (IFDRational(47, 1), IFDRational(44, 1), IFDRational(12, 1))
	gps[3] = 'E'
	gps[4] = (IFDRational(13, 1), IFDRational(26, 1), IFDRational(55, 1))
	return exif


def main() -> None:
	width, height = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) == 3 else (8256, 5504)
	OUT.mkdir(parents=True, exist_ok=True)
	path = OUT / f'synthetic-{width}x{height}.jpg'
	icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
	Image.fromarray(scene(width, height)).save(
		path, quality=92, subsampling=0, exif=camera_exif().tobytes(), icc_profile=icc
	)
	print(f'{path} ({width} × {height}, {width * height / 1e6:.1f} MP, {path.stat().st_size / 1e6:.1f} MB)')


if __name__ == '__main__':
	main()
