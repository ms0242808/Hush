// SPDX-License-Identifier: Apache-2.0
import { ZIP_PART_BYTES, ZipWriter } from '@hush/core';
import { downloadBlob } from './save.ts';

/**
 * A batch saved as ZIP files in parts (§2.8: Safari and Firefox, which can't
 * write to a folder). Each photo is kept as a Blob the moment it's encoded —
 * the browser may move it out of the page's memory — and a part is a Blob of
 * headers and those photos, assembled without copying them. When the next
 * photo would take a part past its limit, the part downloads and is let go:
 * nothing large is held for long, and a crash loses at most one part.
 */
export interface ZipPhoto {
	id: string;
	name: string;
	bytes: Uint8Array;
	crc32: number;
	modified: Date;
}

export interface DownloadedPart {
	name: string;
	/** The batch photos in it, by id. */
	ids: string[];
	bytes: number;
}

/** Below §2.8's 1 GB ceiling: half as much held in memory, and half as much lost to a crash. */
export const BATCH_ZIP_PART_BYTES = ZIP_PART_BYTES / 2;

export class ZipParts {
	private writer = new ZipWriter();
	private pieces: BlobPart[] = [];
	private ids: string[] = [];
	private readonly base: string;
	private next: number;
	private readonly onPart: (part: DownloadedPart) => void;
	private readonly limit: number;

	/** `base` names the parts: `Wedding-denoised` → `Wedding-denoised-1.zip`, `-2.zip`, … */
	constructor(base: string, next: number, onPart: (part: DownloadedPart) => void, limit = BATCH_ZIP_PART_BYTES) {
		this.base = base;
		this.next = next;
		this.onPart = onPart;
		this.limit = limit;
	}

	/** Photos waiting in the part being filled. */
	get pending(): readonly string[] {
		return this.ids;
	}

	/** The name the part being filled will download under. */
	get partName(): string {
		return `${this.base}-${this.next}.zip`;
	}

	add(photo: ZipPhoto): void {
		if (this.writer.count > 0 && this.writer.wouldExceed(photo.name, photo.bytes.length, this.limit)) this.flush();
		const header = this.writer.add({
			name: photo.name,
			size: photo.bytes.length,
			crc32: photo.crc32,
			modified: photo.modified,
		});
		this.pieces.push(header as Uint8Array<ArrayBuffer>, new Blob([photo.bytes as Uint8Array<ArrayBuffer>]));
		this.ids.push(photo.id);
	}

	/** Finish the part being filled and download it. Nothing happens if it's empty. */
	flush(): DownloadedPart | null {
		if (this.writer.count === 0) return null;
		this.pieces.push(this.writer.finish() as Uint8Array<ArrayBuffer>);
		const blob = new Blob(this.pieces, { type: 'application/zip' });
		const part = { name: this.partName, ids: this.ids, bytes: blob.size };
		downloadBlob(blob, part.name);
		this.writer = new ZipWriter();
		this.pieces = [];
		this.ids = [];
		this.next++;
		this.onPart(part);
		return part;
	}

	/** The number the next part will get. */
	get nextPart(): number {
		return this.next;
	}
}
