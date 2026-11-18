/*!
 * Deterministic pixel transforms.
 *
 * Coordinate contract (documented, not assumed):
 *  - origin (0,0) is the top-left pixel; x grows right, y grows down.
 *  - buffers are tightly packed row-major RGBA, 4 bytes per pixel, stride =
 *    width * 4. No row padding.
 *  - all index math is integer; no floating point participates in addressing.
 *  - alpha is straight (non-premultiplied) 0..255; 0 means fully transparent
 *    and RGB channels are preserved untouched, never cleared or expanded.
 *
 * Determinism contract:
 *  - transform output is a freshly allocated buffer; callers never write into
 *    shared mutable state.
 *  - the chunked visitor processes fixed-height bands, but each output index
 *    has exactly one writer regardless of band scheduling order. Reordered or
 *    parallel chunk execution therefore produces byte-identical output.
 */

import { AvifError, ErrorCode } from './errors.js';
import { CHANNELS, LIMITS } from './constants.js';

/**
 * EXIF orientation -> source-coordinate mapping.
 * Given destination (x, y) in a W x H output canvas, return the source (sx, sy)
 * in the encoded w x h image. w/h are encoded dimensions; W/H oriented ones.
 *
 * Formulas follow the EXIF 2.3 specification table and use only integer ops.
 */
// For each code, given destination (x, y) on the oriented canvas we return the
// encoded source coordinate (sx, sy). Swapping codes (5..8) exchange w/h.
// Formulas are the standard EXIF 2.3 destination->source mappings; each is a
// bounds-checked bijection (validated in test/pixel.test.mjs).
const ORIENTATION_MAP = Object.freeze({
  1: (x, y) => [x, y], // identity
  2: (x, y, w) => [w - 1 - x, y], // mirror horizontal (flip left-right)
  3: (x, y, w, h) => [w - 1 - x, h - 1 - y], // rotate 180
  4: (x, y, w, h) => [x, h - 1 - y], // mirror vertical (flip top-bottom)
  5: (x, y) => [y, x], // transpose: mirror then rotate 270 CW
  6: (x, y, w, h) => [y, h - 1 - x], // rotate 90 CW
  7: (x, y, w, h) => [w - 1 - y, h - 1 - x], // transverse: mirror then rotate 90 CW
  8: (x, y, w) => [w - 1 - y, x], // rotate 270 CW
});

/** Output canvas dimensions after applying an orientation code. */
export function orientedDimensions(encodedWidth, encodedHeight, orientation) {
  const swap = orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8;
  return swap
    ? { width: encodedHeight, height: encodedWidth }
    : { width: encodedWidth, height: encodedHeight };
}

function index(x, y, width) {
  return (y * width + x) * CHANNELS;
}

/**
 * Apply an EXIF orientation. Pure: allocates and returns a new Uint8Array.
 */
export function applyOrientation(rgba, width, height, orientation) {
  if (rgba.length !== width * height * CHANNELS) {
    throw new AvifError(
      ErrorCode.DIMENSION_MISMATCH,
      `pixel buffer length ${rgba.length} does not match ${width}x${height}x${CHANNELS}`,
      { details: { expected: width * height * CHANNELS, actual: rgba.length } },
    );
  }
  if (orientation === 1) {
    const out = new Uint8Array(rgba.length);
    out.set(rgba); // identity still returns an independent buffer
    return { rgba: out, width, height };
  }
  const map = ORIENTATION_MAP[orientation];
  if (!map) {
    throw new AvifError(ErrorCode.ORIENTATION_INVALID, `orientation ${orientation} has no pixel map`, {
      details: { orientation },
    });
  }
  const { width: outW, height: outH } = orientedDimensions(width, height, orientation);
  const out = new Uint8Array(outW * outH * CHANNELS);

  // Chunked over output bands. Chunks may be visited in any order because
  // every output offset is written exactly once.
  const visitBand = (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < outW; x++) {
        const [sx, sy] = map(x, y, width, height);
        const src = index(sx, sy, width);
        const dst = index(x, y, outW);
        out[dst] = rgba[src];
        out[dst + 1] = rgba[src + 1];
        out[dst + 2] = rgba[src + 2];
        out[dst + 3] = rgba[src + 3]; // straight alpha carried unchanged
      }
    }
  };
  for (let y0 = 0; y0 < outH; y0 += LIMITS.chunkRows) {
    visitBand(y0, Math.min(y0 + LIMITS.chunkRows, outH));
  }
  return { rgba: out, width: outW, height: outH };
}

/**
 * Sample a pixel with explicit edge clamping ("extend" semantics at the
 * boundary). Integer-only; never reads outside the allocated buffer.
 */
export function sampleClamped(rgba, width, height, x, y) {
  const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
  const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
  const i = index(cx, cy, width);
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

/**
 * Integer division with round-half-up style deterministic rounding used for
 * any integer averaging: floor((a + b/2) / b). Documented so two platforms
 * agree; never relies on Math.round of a float.
 */
export function roundedDivide(a, b) {
  if (b <= 0) throw new AvifError(ErrorCode.INVALID_BOX, 'divisor must be positive', { details: { b } });
  return Math.floor((a + Math.floor(b / 2)) / b);
}

/** Verify a decoded buffer against the structural descriptor. */
export function assertDecodedGeometry(decoded, descriptor) {
  if (decoded.width !== descriptor.width || decoded.height !== descriptor.height) {
    throw new AvifError(
      ErrorCode.DIMENSION_MISMATCH,
      `decoder emitted ${decoded.width}x${decoded.height} but ispe declared ${descriptor.width}x${descriptor.height}`,
      {
        details: {
          decoded: { width: decoded.width, height: decoded.height },
          declared: { width: descriptor.width, height: descriptor.height },
        },
      },
    );
  }
  const expectedBytes = decoded.width * decoded.height * CHANNELS;
  if (decoded.rgba.byteLength !== expectedBytes) {
    throw new AvifError(
      ErrorCode.DIMENSION_MISMATCH,
      `decoded byte length ${decoded.rgba.byteLength} != expected ${expectedBytes}`,
      { details: { expectedBytes, actualBytes: decoded.rgba.byteLength } },
    );
  }
  if (expectedBytes > LIMITS.maxDecodedBytes) {
    throw new AvifError(
      ErrorCode.MEMORY_LIMIT,
      `decoded RGBA would need ${expectedBytes} bytes, limit ${LIMITS.maxDecodedBytes}`,
      { details: { expectedBytes, limit: LIMITS.maxDecodedBytes } },
    );
  }
}
