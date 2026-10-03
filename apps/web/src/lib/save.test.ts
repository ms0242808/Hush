// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { classifySaveError, numberedName, saveExport, SaveFailure } from './save';

const domError = (name: string) => Object.assign(new Error(name), { name });

/** Enough of FileSystemDirectoryHandle to write into memory, failing the way real folders do when asked. */
function fakeFolder(
	options: { existing?: string[]; directories?: string[]; failOnWrite?: string; failOnClose?: string } = {},
) {
	const files = new Map<string, Uint8Array>(options.existing?.map((name) => [name, new Uint8Array()]));
	const directories = new Set(options.directories);
	let aborted = 0;
	const folder = {
		kind: 'directory',
		name: 'Wedding',
		getFileHandle(name: string, init?: { create?: boolean }) {
			if (directories.has(name)) return Promise.reject(domError('TypeMismatchError'));
			if (!files.has(name) && !init?.create) return Promise.reject(domError('NotFoundError'));
			return Promise.resolve({
				createWritable: () => {
					let pending: Uint8Array | null = null;
					return Promise.resolve({
						write(bytes: Uint8Array) {
							if (options.failOnWrite) return Promise.reject(domError(options.failOnWrite));
							pending = bytes;
							return Promise.resolve();
						},
						close() {
							if (options.failOnClose) return Promise.reject(domError(options.failOnClose));
							files.set(name, pending!);
							return Promise.resolve();
						},
						abort() {
							aborted++;
							return Promise.resolve();
						},
					});
				},
			});
		},
	};
	return { folder: folder as unknown as FileSystemDirectoryHandle, files, aborted: () => aborted };
}

const photo = { name: 'IMG_2041-denoised.jpg', bytes: Uint8Array.of(0xff, 0xd8, 0xff), mimeType: 'image/jpeg' };

describe('saving to a folder (§2.8, §5.13)', () => {
	it('writes the file and says where, once the write has closed', async () => {
		const { folder, files } = fakeFolder();
		const saved = await saveExport(photo, { method: 'folder', folder });
		expect(saved).toEqual({ name: 'IMG_2041-denoised.jpg', method: 'folder', folder: 'Wedding' });
		expect(files.get('IMG_2041-denoised.jpg')).toEqual(photo.bytes);
	});

	it('never replaces a file: the next free number instead', async () => {
		const { folder, files } = fakeFolder({
			existing: ['IMG_2041-denoised.jpg', 'IMG_2041-denoised (2).jpg'],
			directories: ['IMG_2041-denoised (3).jpg'],
		});
		const saved = await saveExport(photo, { method: 'folder', folder });
		expect(saved.name).toBe('IMG_2041-denoised (4).jpg');
		expect(files.get('IMG_2041-denoised.jpg')).toEqual(new Uint8Array());
	});

	it('says why a write failed, and cleans up the half-written file', async () => {
		const full = fakeFolder({ failOnWrite: 'QuotaExceededError' });
		await expect(saveExport(photo, { method: 'folder', folder: full.folder })).rejects.toMatchObject({
			name: 'SaveFailure',
			problem: 'no-space',
		});
		expect(full.aborted()).toBe(1);

		const blocked = fakeFolder({ failOnClose: 'NoModificationAllowedError' });
		const failure = await saveExport(photo, { method: 'folder', folder: blocked.folder }).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(SaveFailure);
		expect((failure as SaveFailure).problem).toBe('blocked');
		expect(blocked.files.has('IMG_2041-denoised.jpg')).toBe(false);
	});
});

describe('save errors in plain words', () => {
	it.each([
		['NotAllowedError', 'permission'],
		['SecurityError', 'permission'],
		['NotFoundError', 'not-found'],
		['QuotaExceededError', 'no-space'],
		['NoModificationAllowedError', 'blocked'],
		['InvalidModificationError', 'blocked'],
		['AbortError', 'cancelled'],
		['SomethingNew', 'unknown'],
	])('%s → %s', (name, problem) => {
		expect(classifySaveError(domError(name))).toBe(problem);
	});
});

describe('numbered names', () => {
	it('numbers before the extension, like browsers do for downloads', () => {
		expect(numberedName('IMG_2041-denoised.jpg', 1)).toBe('IMG_2041-denoised.jpg');
		expect(numberedName('IMG_2041-denoised.jpg', 2)).toBe('IMG_2041-denoised (2).jpg');
		expect(numberedName('scan', 3)).toBe('scan (3)');
	});
});
