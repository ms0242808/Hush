# SPDX-License-Identifier: Apache-2.0
"""Publish the exported models to the Hugging Face model repo, then pin the commit.

    hf auth login                      # once, with a token that can write to the repo
    uv run publish_hf.py --dry-run     # show what would be uploaded
    uv run publish_hf.py               # upload, then write the commit into models.lock.json

Uploads exactly the files models.lock.json lists (checked against their sha256
first), plus a model card with the quality numbers from evaluate.py. The
printed commit is what fetch-models downloads from; a changed upstream file
then fails the build instead of shipping silently (§6.4).
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys

from checkpoints import sha256_file

HERE = pathlib.Path(__file__).parent
OUT = HERE / 'out'
LOCK = HERE / 'models.lock.json'


def model_card(lock: dict) -> str:
	files = ['| File | Precision | Size | sha256 |', '| --- | --- | ---: | --- |']
	for model in lock['models']:
		for v in model['variants']:
			files.append(f'| `{v["file"]}` | {v["precision"]} | {v["bytes"] / 1e6:.1f} MB | `{v["sha256"]}` |')
	quality = '_Run evaluate.py to fill this in._'
	report = OUT / 'sidd-eval.json'
	if report.exists():
		rows = ['| File | PSNR (dB) | SSIM |', '| --- | ---: | ---: |']
		for entry in json.loads(report.read_text()):
			rows.append(f'| `{entry["model"]}` | {entry["psnr"]:.2f} | {entry["ssim"]:.4f} |')
		quality = '\n'.join(rows)
	template = (HERE / 'MODEL_CARD.md').read_text()
	return template.replace('{{FILES}}', '\n'.join(files)).replace('{{QUALITY}}', quality)


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('--dry-run', action='store_true')
	args = parser.parse_args()

	lock = json.loads(LOCK.read_text())
	repo = lock['source']['repo']
	uploads: list[tuple[pathlib.Path, str]] = []
	for model in lock['models']:
		for v in model['variants']:
			path = OUT / v['file']
			if not path.exists() or sha256_file(path) != v['sha256']:
				sys.exit(f'{v["file"]}: missing or not the file models.lock.json pins. Re-run export.py / quantize.py / lock.py.')
			uploads.append((path, v['file']))

	card = model_card(lock)
	if args.dry_run:
		print(f'Would upload to https://huggingface.co/{repo}:')
		for path, name in uploads:
			print(f'  {name}  ({path.stat().st_size / 1e6:.1f} MB)')
		print('  README.md (model card)')
		return

	from huggingface_hub import CommitOperationAdd, HfApi

	api = HfApi()
	api.create_repo(repo, repo_type='model', exist_ok=True)
	operations = [CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(path)) for path, name in uploads]
	operations.append(CommitOperationAdd(path_in_repo='README.md', path_or_fileobj=card.encode()))
	commit = api.create_commit(repo, operations=operations, commit_message='Publish NAFNet SIDD ONNX conversions')
	revision = commit.oid
	print(f'Published https://huggingface.co/{repo}/tree/{revision}')
	subprocess.run([sys.executable, str(HERE / 'lock.py'), '--revision', revision], check=True)
	print('models.lock.json now pins that revision. Commit it.')


if __name__ == '__main__':
	main()
