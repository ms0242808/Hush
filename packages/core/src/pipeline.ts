// SPDX-License-Identifier: Apache-2.0
import type { CodecAdapter, OutputAdapter, SavedFile } from './adapters.ts';
import { DecodeError, PhotoTooLargeError, SaveError } from './errors.ts';
import { defaultOutputFormat, outputMimeType, outputName, type OutputFormat } from './formats.ts';
import { hasGps } from './metadata/exif.ts';
import { readPhoto, writePhotoMetadata, type ColourSource, type PhotoInfo, type Zlib } from './metadata/photo.ts';
import type { MetadataWarning } from './metadata/warnings.ts';
import { xmpHasLocation } from './metadata/xmp.ts';
import type { ImageOperation } from './operation.ts';
import type { Recipe } from './recipe.ts';
import type { TiledProgress, TiledStats } from './tiled.ts';
import {
	CancelledError,
	type Bytes,
	type CancelSignal,
	type Clock,
	type DecodedOrientation,
	type Format,
	type Image8,
} from './types.ts';

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
	const processed = await runRecipe(image, job.recipe, {
		operations: context.operations,
		...(context.signal && { signal: context.signal }),
		now,
		onProgress: (tiles) => report('processing', tiles.tilesDone / tiles.tileCount, tiles),
	});
	const processMs = now() - t;
	checkCancelled();

	report('encoding');
	const encoded = await encodePhoto(image, info, decoded.orientation, job, { ...context, now });
	checkCancelled();

	report('saving');
	t = now();
	const { name, mimeType, format } = encoded;
	let saved: SavedFile;
	try {
		saved = await context.output.save(name, encoded.bytes, mimeType);
	} catch (error) {
		throw new SaveError(name, encoded.bytes, mimeType, error);
	}
	const saveMs = now() - t;
	report('saving', 1);

	return {
		name,
		mimeType,
		format,
		bytes: encoded.bytes,
		width: image.width,
		height: image.height,
		saved,
		source: describeSource(info),
		warnings: encoded.warnings,
		stats: {
			readMs,
			decodeMs,
			processMs,
			encodeMs: encoded.encodeMs,
			metadataMs: encoded.metadataMs,
			saveMs,
			totalMs: now() - started,
			tiled: processed.tiled,
			peakFloatBytes: (processed.tiled?.peakFloatBytes ?? 0) + processed.floatBytes,
		},
	};
}

export interface RecipeRunOptions {
	operations: Readonly<Record<string, ImageOperation>>;
	signal?: CancelSignal;
	now?: Clock;
	onProgress?: (tiles: TiledProgress) => void;
	/** Where the result goes; by default over the input, in place. */
	output?: Image8;
}

/**
 * Run a recipe's steps over an image. The first step reads `image` and
 * writes `output`; later ones (none yet) work on that result in place.
 */
export async function runRecipe(
	image: Image8,
	recipe: Recipe,
	options: RecipeRunOptions,
): Promise<{ tiled: TiledStats | null; floatBytes: number }> {
	const output = options.output ?? image;
	let tiled: TiledStats | null = null;
	let floatBytes = 0;
	let input = image;
	for (const step of recipe.ops) {
		const operation = options.operations[step.op];
		if (!operation) throw new RangeError(`Operation "${step.op}" isn't loaded`);
		const result = await operation.run({
			input,
			output,
			params: step.params,
			...(options.signal && { signal: options.signal }),
			...(options.now && { now: options.now }),
			...(options.onProgress && { onProgress: options.onProgress }),
		});
		tiled ??= result.stats;
		floatBytes = Math.max(floatBytes, result.floatBytes);
		input = output;
	}
	return { tiled, floatBytes };
}

export interface EncodedPhoto {
	name: string;
	mimeType: string;
	format: OutputFormat;
	bytes: Bytes;
	warnings: MetadataWarning[];
	encodeMs: number;
	metadataMs: number;
}

/**
 * Encode processed pixels in the chosen format and put the source's
 * metadata back (§2.6). `orientation` says whether the decoder had already
 * turned the pixels upright.
 */
export async function encodePhoto(
	image: Image8,
	info: PhotoInfo,
	orientation: DecodedOrientation,
	job: Pick<PhotoJob, 'name' | 'output'>,
	context: { codecs: CodecAdapter; zlib: Zlib; software: string; now?: Clock },
): Promise<EncodedPhoto> {
	const now = context.now ?? (() => 0);
	let t = now();
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
			orientation: orientation === 'applied' ? 1 : info.orientation,
			width: image.width,
			height: image.height,
		},
		context.zlib,
	);
	return {
		name: outputName(job.name, format, job.output.suffix),
		mimeType: outputMimeType(format),
		format,
		bytes: written.bytes,
		warnings: [...new Set([...info.warnings, ...written.warnings])],
		encodeMs,
		metadataMs: now() - t,
	};
}

/** What the result reports about its source. */
export function describeSource(info: PhotoInfo): PhotoResult['source'] {
	return {
		format: info.format,
		width: info.width,
		height: info.height,
		bitDepth: info.bitDepth,
		colour: info.colour,
		hadLocation: (info.exif !== null && hasGps(info.exif)) || (info.xmp !== null && xmpHasLocation(info.xmp)),
	};
}
