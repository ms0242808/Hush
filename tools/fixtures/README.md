# Test photos

The photos Hush's end-to-end tests open (`apps/web/e2e/fixtures/`), written by
encoders that share no code with Hush — Pillow for JPEG, PNG, WebP and AVIF,
pillow-heif (libheif + x265) for HEIC — so a test that reads Hush's output back
never grades Hush against itself.

```sh
cd tools/fixtures
uv sync
uv run make_fixtures.py
```

Each photo is the same upright scene (a noisy gradient with a red square in the
top-left corner) stored turned 90° anticlockwise, with the orientation saying to
turn it back, and carries what cameras and phones write: EXIF with GPS and a
maker note, a Display P3 profile (written from the ICC specification and checked
by LittleCMS), XMP with location and a non-ASCII title, IPTC, a comment, print
resolution. The `refuse-*` photos are ones Hush must decline with a reason:
CMYK and animated.

The files are committed, not rebuilt in CI: encoders change between versions,
and the tests compare against the exact bytes.
