// SPDX-License-Identifier: Apache-2.0

/**
 * The largest file allowed in the build output (§6.6 rule 1). Cloudflare's
 * static assets cap files at 25 MiB; 24 MiB leaves headroom. Model files and
 * the ONNX Runtime binary are split into parts of at most this size.
 */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;

/** First-load JavaScript budget for the root page, gzipped (§5.10). */
export const INITIAL_JS_BUDGET_BYTES = 150 * 1024;
