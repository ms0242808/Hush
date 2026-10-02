// SPDX-License-Identifier: Apache-2.0

/**
 * Full-resolution chroma (4:4:4) stops here. MozJPEG keeps whole-image
 * buffers in a WASM heap capped at 2 GiB; at 4:4:4 a noisy photo outgrows it
 * between 91 and 102 MP (measured). 61 MP — the §2.9 standard device limit —
 * leaves half again as much room; above it, 4:2:0 roughly halves the need.
 */
export const FULL_CHROMA_MAX_MEGAPIXELS = 61;
/** After a photo this big, start a fresh encoder: a WASM heap never shrinks, and a batch shouldn't carry 2 GB. */
export const RESET_AFTER_MEGAPIXELS = 24;

/**
 * JPEG: baseline with optimised Huffman tables, like the files cameras and
 * Lightroom write. No chroma subsampling at quality 90 and above, as Adobe's
 * exports do at high quality, so colour-noise reduction isn't blurred away —
 * unless the photo is too big for the encoder's memory.
 */
export function jpegOptions(quality: number, megapixels: number, fullChroma = true) {
	return {
		quality,
		baseline: false,
		progressive: false,
		optimize_coding: true,
		auto_subsample: false,
		chroma_subsample: fullChroma && quality >= 90 && megapixels <= FULL_CHROMA_MAX_MEGAPIXELS ? 1 : 2,
	};
}
