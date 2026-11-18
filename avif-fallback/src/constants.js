/*!
 * Single source of truth for pipeline rules and resource limits.
 *
 * RULES_VERSION is part of every cache key: bumping it invalidates every
 * previously published result, so pixel-rule changes can never be served from
 * a stale cache entry.
 */

export const RULES_VERSION = 'avif-fb-1.0.0';

// Hard bounds. Chosen so the largest legal RGBA output fits comfortably in
// practical memory budgets while integer dimension math cannot overflow
// Number.MAX_SAFE_INTEGER.
export const LIMITS = Object.freeze({
  maxWidth: 16384,
  maxHeight: 16384,
  maxPixels: 67_108_864, // 8192 x 8192 equivalent
  maxInputBytes: 64 * 1024 * 1024,
  // Decoded RGBA budget per request (4 bytes per channel).
  maxDecodedBytes: 268_435_456,
  // Chunk height used by the deterministic tile pass; must divide work so that
  // reordered chunks still write the same final buffer.
  chunkRows: 64,
});

// EXIF-style orientation values we know how to apply. 1 = identity.
export const SUPPORTED_ORIENTATIONS = Object.freeze(new Set([1, 2, 3, 4, 5, 6, 7, 8]));

// CICP colour primaries / matrix coefficients accepted as sRGB-equivalent.
// Anything else is rejected rather than silently mis-coloured.
// [colourPrimaries, transferCharacteristics, matrixCoefficients]
export const ACCEPTED_CICP = Object.freeze([
  [2, 2, 0], // "unspecified" triple: libavif/rgb-only passthrough, treated sRGB
  [1, 13, 6], // sRGB / IEC 61966-2-1, BT.601 limited-range matrix per AOMD
  [1, 13, 1], // sRGB, BT.709
  [1, 1, 6],
  [1, 1, 1],
]);

export const CHANNELS = 4; // output is always premultiplied-independent RGBA
