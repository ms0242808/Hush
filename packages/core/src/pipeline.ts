// SPDX-License-Identifier: Apache-2.0
import type { CodecAdapter, OutputAdapter, SavedFile } from './adapters.ts';
import { DecodeError, PhotoTooLargeError, SaveError } from './errors.ts';
import { defaultOutputFormat, outputMimeType, outputName, type OutputFormat } from './formats.ts';
import { hasGps } from './metadata/exif.ts';
import { readPhoto, writePhotoMetadata, type ColourSource, type Zlib } from './metadata/photo.ts';
import type { MetadataWarning } from './metadata/warnings.ts';
import { xmpHasLocation } from './metadata/xmp.ts';
import type { ImageOperation } from './operation.ts';
import type { Recipe } from './recipe.ts';
import type { TiledProgress, TiledStats } from './tiled.ts';
import { CancelledError, type Bytes, type CancelSignal, type Clock, type Format, type Image8 } from './types.ts';

/** Export settings (§2.6, §5.3 export panel). */
export interface OutputSettings {
	/** 'auto' keeps the input's format, except HEIC and AVIF, which become JPEG. */
	format: OutputFormat | 'auto';
	/** JPEG and lossy WebP quality, 1–100. */
	quality: number;
	/** Appended to the file name: `IMG_2041-denoised.jpg`. */
	suffix: string;
	/** Strip GPS from EXIF and XMP. Opt-in. */
	removeLocation: boolean;
}

export const DEFAULT_OUTPUT: OutputSettings = {
	format: 'auto',
	quality: 95,
	suffix: '-denoised',
	removeLocation: false,
};

/** The §2.7 states a photo moves through. */
export type PhotoStage = 'reading' | 'decoding' | 'processing' | 'encoding' | 'saving';

export interface PhotoProgress {
	stage: PhotoStage;
	/** Overall progress for this photo, 0–1, weighted by the stages' typical cost. */
	fraction: number;
	tiles?: TiledProgress;
}

export interface PhotoJob {
	/** The input file name, for the output name. */
	name: string;
	bytes: Bytes;
	recipe: Recipe;
	output: OutputSettings;
}

export interface PipelineContext {
	codecs: CodecAdapter;
	output: OutputAdapter;
	zlib: Zlib;
	/** The loaded operations, by id. */
	operations: Readonly<Record<string, ImageOperation>>;
	/** The `Software` tag value (§2.6: APP_NAME). */
	software: string;
	/** §2.9: the largest photo this device should attempt, in megapixels. */
	maxMegapixels?: number;
	signal?: CancelSignal;
	now?: Clock;
	onProgress?: (progress: PhotoProgress) => void;
}

export interface PhotoStats {
	readMs: number;
	decodeMs: number;
	processMs: number;
	encodeMs: number;
	metadataMs: number;
	saveMs: number;
	totalMs: number;
	tiled: TiledStats | null;
	/** Float memory held at the peak: the band and tiles, plus the adjust stage's rows. */
	peakFloatBytes: number;
}

export interface PhotoResult {
	name: string;
	mimeType: string;
	format: OutputFormat;
	bytes: Bytes;
	width: number;
	height: number;
	saved: SavedFile;
	source: {
		format: Format;
		width: number;
		height: number;
		bitDepth: number;
		colour: ColourSource;
		hadLocation: boolean;
	};
	warnings: MetadataWarning[];
	stats: PhotoStats;
}

/** Rough share of a photo's time each stage takes, for one progress bar. */
const STAGE_SPAN: Record<PhotoStage, [number, number]> = {
	reading: [0, 0.01],
	decoding: [0.01, 0.05],
	processing: [0.05, 0.92],
	encoding: [0.92, 0.99],
	saving: [0.99, 1],
};

/** Check that a decoded image is the 8-bit RGB(A) the pipeline works on. */
export function asImage8(decoded: {
	width: number;
	height: number;
	channels: number;
	bitDepth: number;
	data: unknown;
}): Image8 {
	if (decoded.bitDepth !== 8 || !(decoded.data instanceof Uint8Array)) {
		throw new RangeError(`Expected 8-bit pixels, got ${decoded.bitDepth}-bit`);
	}
	if (decoded.channels !== 3 && decoded.channels !== 4)
		throw new RangeError(`Expected 3 or 4 channels, got ${decoded.channels}`);
	if (decoded.data.byteLength !== decoded.width * decoded.height * decoded.channels) {
		throw new RangeError('Pixel buffer size does not match the image size');
	}
	return { width: decoded.width, height: decoded.height, channels: decoded.channels, data: decoded.data };
}

/**
 * One photo, end to end (§2.1): read the container → decode → run the recipe
 * → encode → put the metadata back → save. Processing happens in place over
 * the decoded pixels, so a 100 MP photo is held once, in 8 bits; the model's
 * float output never exceeds one band.
 */
export async function processPhoto(job: PhotoJob, context: PipelineContext): Promise<PhotoResult> {
	const now = context.now ?? (() => 0);
	const started = now();
	const report = (stage: PhotoStage, within = 0, tiles?: TiledProgress) => {
		const [from, to] = STAGE_SPAN[stage];
		context.onProgress?.({ stage, fraction: from + (to - from) * within, ...(tiles && { tiles }) });
	};
	const checkCancelled = () => {
		if (context.signal?.aborted) throw new CancelledError();
	};

	report('reading');
	let t = now();
	const info = await readPhoto(job.bytes, context.zlib);
	const megapixels = (info.width * info.height) / 1e6;
	if (context.maxMegapixels !== undefined && megapixels > context.maxMegapixels) {
		throw new PhotoTooLargeError(megapixels, context.maxMegapixels);
	}
	const readMs = now() - t;
	checkCancelled();

	report('decoding');
	t = now();
	let decoded;
	try {
		decoded = await context.codecs.decode(job.bytes, info.format);
	} catch (error) {
		throw error instanceof DecodeError ? error : new DecodeError(info.format, error);
	}
	const image = asImage8(decoded.image);
	const decodeMs = now() - t;
	checkCancelled();

	report('processing');
	t = now();
	let tiled: TiledStats | null = null;
	let operationFloatBytes = 0;
	for (const step of job.recipe.ops) {
		const operation = context.operations[step.op];
		if (!operation) throw new RangeError(`Operation "${step.op}" isn't loaded`);
		const result = await operation.run({
			input: image,
			output: image,
			params: step.params,
			...(context.signal && { signal: context.signal }),
			now,
			onProgress: (tiles) => report('processing', tiles.tilesDone / tiles.tileCount, tiles),
		});
		tiled ??= result.stats;
		operationFloatBytes = Math.max(operationFloatBytes, result.floatBytes);
	}
	const processMs = now() - t;
	checkCancelled();

	report('encoding');
	t = now();
	const format = job.output.format === 'auto' ? defaultOutputFormat(info.format) : job.output.format;
	const encoded = await context.codecs.encode(image, {
		format,
		quality: job.output.quality,
		...(format === 'webp' && info.webp?.lossless && { lossless: true }),
	});
	const encodeMs = now() - t;

	t = now();
	const written = await writePhotoMetadata(
		encoded,
		info,
		{
			format,
			software: context.software,
			removeLocation: job.output.removeLocation,
			orientation: decoded.orientation === 'applied' ? 1 : info.orientation,
			width: image.width,
			height: image.height,
		},
		context.zlib,
	);
	const metadataMs = now() - t;
	checkCancelled();

	report('saving');
	t = now();
	const name = outputName(job.name, format, job.output.suffix);
	const mimeType = outputMimeType(format);
	let saved: SavedFile;
	try {
		saved = await context.output.save(name, written.bytes, mimeType);
	} catch (error) {
		throw new SaveError(name, written.bytes, mimeType, error);
	}
	const saveMs = now() - t;
	report('saving', 1);

	return {
		name,
		mimeType,
		format,
		bytes: written.bytes,
		width: image.width,
		height: image.height,
		saved,
		source: {
			format: info.format,
			width: info.width,
			height: info.height,
			bitDepth: info.bitDepth,
			colour: info.colour,
			hadLocation: (info.exif !== null && hasGps(info.exif)) || (info.xmp !== null && xmpHasLocation(info.xmp)),
		},
		warnings: [...new Set([...info.warnings, ...written.warnings])],
		stats: {
			readMs,
			decodeMs,
			processMs,
			encodeMs,
			metadataMs,
			saveMs,
			totalMs: now() - started,
			tiled,
			peakFloatBytes: (tiled?.peakFloatBytes ?? 0) + operationFloatBytes,
		},
	};
}
