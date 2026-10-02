# SPDX-License-Identifier: Apache-2.0
"""Build the photos Hush's end-to-end tests open, with encoders independent of Hush.

    cd tools/fixtures && uv sync && uv run make_fixtures.py

Pillow writes JPEG, PNG, WebP and AVIF; pillow-heif (libheif + x265) writes
HEIC. Metadata is what cameras and phones write: EXIF with GPS and a maker
note, an ICC profile, XMP (with location and a non-ASCII title), IPTC, a JPEG
comment, print resolution. The IPTC segment is assembled here by hand, from
the Photoshop IRB specification, not by Hush's code.

Every photo is the same upright scene — a noisy gradient with a red square in
its top-left corner — stored the way the format usually stores it: rotated
90° anticlockwise with an orientation saying "turn clockwise to view" (EXIF 6,
or HEIF irot), so tests can check nothing is ever rotated twice.

The scene is deterministic; re-running reproduces the same pixels (encoders
may differ by version, so the files are committed rather than rebuilt in CI).
"""

from __future__ import annotations

import io
import pathlib
import struct

import numpy as np
import pillow_heif
from PIL import Image, ImageCms, PngImagePlugin

OUT = pathlib.Path(__file__).resolve().parents[2] / 'apps' / 'web' / 'e2e' / 'fixtures'

#: The scene upright: portrait, 180 × 260.
WIDTH, HEIGHT = 180, 260

XMP = (
	'<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
	'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
	'<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
	' xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/"'
	' xmp:Rating="4" tiff:Orientation="6" exif:GPSLatitude="25,2.205667N" exif:GPSLongitude="121,33.761167E">'
	'<dc:title><rdf:Alt><rdf:li xml:lang="x-default">婚禮 · 台北</rdf:li></rdf:Alt></dc:title>'
	'</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
)


def scene(seed: int = 7) -> Image.Image:
	"""The upright photo: smooth colour gradient, a red square top-left, high-ISO-like noise."""
	rng = np.random.default_rng(seed)
	y, x = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float64)
	rgb = np.stack(
		[
			60 + 120 * x / WIDTH,
			50 + 140 * y / HEIGHT,
			140 - 60 * (x + y) / (WIDTH + HEIGHT),
		],
		axis=-1,
	)
	rgb[8:40, 8:40] = (220, 30, 30)
	rgb += rng.normal(0, 14, (HEIGHT, WIDTH, 1)) + rng.normal(0, 6, (HEIGHT, WIDTH, 3))
	return Image.fromarray(np.clip(rgb, 0, 255).round().astype(np.uint8), 'RGB')


def stored() -> Image.Image:
	"""The scene as the camera stores it: turned 90° anticlockwise, to be shown with EXIF orientation 6."""
	return scene().transpose(Image.Transpose.ROTATE_90)


def exif(orientation: int = 6) -> Image.Exif:
	e = Image.Exif()
	e[0x010F] = 'Canon'
	e[0x0110] = 'Canon EOS R5'
	e[0x0112] = orientation
	e[0x0131] = 'Firmware Version 1.8.1'
	e[0x0132] = '2026:09:12 21:14:03'
	e[0x013B] = 'Test Studio'
	sub = e.get_ifd(0x8769)
	sub[0x829A] = 1 / 125
	sub[0x829D] = 2.8
	sub[0x8827] = 6400
	sub[0x9003] = '2026:09:12 21:14:03'
	sub[0xA434] = 'RF24-70mm F2.8 L IS USM'
	sub[0x927C] = bytes((i * 37 + 11) & 0xFF for i in range(96))  # a maker note: opaque bytes
	gps = e.get_ifd(0x8825)
	gps[0x0000] = b'\x02\x03\x00\x00'
	gps[0x0001] = 'N'
	gps[0x0002] = (25.0, 2.0, 12.34)
	gps[0x0003] = 'E'
	gps[0x0004] = (121.0, 33.0, 45.67)
	return e


def icc() -> bytes:
	"""An sRGB profile from LittleCMS: real, small, and not Hush's."""
	return ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()


def iptc_segment() -> bytes:
	"""APP13: a Photoshop IRB holding IPTC-IIM caption and copyright."""

	def dataset(number: int, value: bytes) -> bytes:
		return b'\x1c\x02' + bytes([number]) + struct.pack('>H', len(value)) + value

	iim = dataset(0, b'\x00\x04') + dataset(120, 'First dance'.encode()) + dataset(116, '© 2026 Test Studio'.encode())
	irb = b'8BIM' + struct.pack('>H', 0x0404) + b'\x00\x00' + struct.pack('>I', len(iim)) + iim
	if len(iim) % 2:
		irb += b'\x00'
	payload = b'Photoshop 3.0\x00' + irb
	return b'\xff\xed' + struct.pack('>H', len(payload) + 2) + payload


def comment_segment(text: str) -> bytes:
	payload = text.encode()
	return b'\xff\xfe' + struct.pack('>H', len(payload) + 2) + payload


def insert_before_tables(jpeg: bytes, *segments: bytes) -> bytes:
	"""Put segments after the last APPn, before the quantisation tables."""
	at = 2
	while jpeg[at] == 0xFF and 0xE0 <= jpeg[at + 1] <= 0xEF:
		at += 2 + struct.unpack('>H', jpeg[at + 2 : at + 4])[0]
	return jpeg[:at] + b''.join(segments) + jpeg[at:]


def save(name: str, data: bytes) -> None:
	(OUT / name).write_bytes(data)
	print(f'{name}: {len(data):,} bytes')


def main() -> None:
	OUT.mkdir(parents=True, exist_ok=True)
	pillow_heif.register_heif_opener()
	photo = stored()
	profile = icc()

	buffer = io.BytesIO()
	photo.save(buffer, 'JPEG', quality=92, exif=exif().tobytes(), icc_profile=profile, dpi=(300, 300), xmp=XMP.encode())
	save('meta-camera.jpg', insert_before_tables(buffer.getvalue(), iptc_segment(), comment_segment('Shot on the night')))

	info = PngImagePlugin.PngInfo()
	info.add_itxt('XML:com.adobe.xmp', XMP)
	info.add_text('Author', 'Test Studio')
	buffer = io.BytesIO()
	photo.save(buffer, 'PNG', exif=exif().tobytes(), icc_profile=profile, dpi=(300, 300), pnginfo=info)
	save('meta-camera.png', buffer.getvalue())

	buffer = io.BytesIO()
	photo.save(buffer, 'WEBP', quality=90, exif=exif().tobytes(), icc_profile=profile, xmp=XMP.encode())
	save('meta-camera.webp', buffer.getvalue())

	buffer = io.BytesIO()
	photo.save(buffer, 'WEBP', lossless=True, exif=exif().tobytes())
	save('meta-lossless.webp', buffer.getvalue())

	# HEIC as an iPhone writes it: the rotation in irot, EXIF Orientation reset to 1.
	buffer = io.BytesIO()
	photo.save(buffer, 'HEIF', quality=92, exif=exif().tobytes(), icc_profile=profile, xmp=XMP.encode())
	save('meta-phone.heic', buffer.getvalue())

	# AVIF as Pillow writes it: irot and EXIF Orientation 6 together.
	buffer = io.BytesIO()
	photo.save(buffer, 'AVIF', quality=92, exif=exif().tobytes(), icc_profile=profile, xmp=XMP.encode())
	save('meta-camera.avif', buffer.getvalue())

	# What Hush refuses, each with its own message.
	buffer = io.BytesIO()
	scene().convert('CMYK').save(buffer, 'JPEG', quality=90)
	save('refuse-cmyk.jpg', buffer.getvalue())

	buffer = io.BytesIO()
	frames = [scene(1), scene(2)]
	frames[0].save(buffer, 'WEBP', save_all=True, append_images=frames[1:], duration=200, loop=0, quality=80)
	save('refuse-animated.webp', buffer.getvalue())

	# More than 8 bits per channel: processed in 8 bits, with a warning.
	grey = np.asarray(scene().convert('L'), dtype=np.uint16) * 257
	buffer = io.BytesIO()
	Image.fromarray(grey).save(buffer, 'PNG')  # uint16 → a 16-bit greyscale PNG
	save('deep-16bit.png', buffer.getvalue())


if __name__ == '__main__':
	main()
