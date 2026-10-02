// SPDX-License-Identifier: Apache-2.0
import { SNIFF_BYTES, sniffFormat, type Format } from '@hush/core';

export type PhotoFormat = Format;

export { sniffFormat };

/** Identify a file from its first bytes, without reading the rest: never by its name or MIME type. */
export async function sniffFile(file: Blob): Promise<PhotoFormat | null> {
	return sniffFormat(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
}
