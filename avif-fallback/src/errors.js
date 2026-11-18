/*!
 * Stable error taxonomy for the AVIF fallback pipeline.
 *
 * Every rejection produced by this package uses one of the codes below so that
 * callers can branch on `err.code` instead of message text. Messages are
 * append-only and carry no mutable state (no buffers, no cache internals).
 */

export const ErrorCode = Object.freeze({
  NOT_AVIF: 'AVIF_NOT_AVIF',
  TRUNCATED_BOX: 'AVIF_TRUNCATED_BOX',
  INVALID_BOX: 'AVIF_INVALID_BOX',
  DIMENSION_MISMATCH: 'AVIF_DIMENSION_MISMATCH',
  DIMENSION_UNSUPPORTED: 'AVIF_DIMENSION_UNSUPPORTED',
  COLOUR_SPACE_UNSUPPORTED: 'AVIF_COLOUR_SPACE_UNSUPPORTED',
  ORIENTATION_INVALID: 'AVIF_ORIENTATION_INVALID',
  ORIENTATION_MISMATCH: 'AVIF_ORIENTATION_MISMATCH',
  ANIMATION_UNSUPPORTED: 'AVIF_ANIMATION_UNSUPPORTED',
  FRAME_CORRUPT: 'AVIF_FRAME_CORRUPT',
  MEMORY_LIMIT: 'AVIF_MEMORY_LIMIT',
  DECODER_UNAVAILABLE: 'AVIF_DECODER_UNAVAILABLE',
  DECODE_FAILED: 'AVIF_DECODE_FAILED',
  PUBLISH_FAILED: 'AVIF_PUBLISH_FAILED',
  INPUT_EMPTY: 'AVIF_INPUT_EMPTY',
  INPUT_TOO_LARGE: 'AVIF_INPUT_TOO_LARGE',
  SERVICE_SHUTDOWN: 'AVIF_SERVICE_SHUTDOWN',
});

const EXIT_QUALITY = Object.freeze({
  [ErrorCode.NOT_AVIF]: 'reject',
  [ErrorCode.TRUNCATED_BOX]: 'reject',
  [ErrorCode.INVALID_BOX]: 'reject',
  [ErrorCode.DIMENSION_MISMATCH]: 'reject',
  [ErrorCode.DIMENSION_UNSUPPORTED]: 'reject',
  [ErrorCode.COLOUR_SPACE_UNSUPPORTED]: 'reject',
  [ErrorCode.ORIENTATION_INVALID]: 'reject',
  [ErrorCode.ORIENTATION_MISMATCH]: 'reject',
  [ErrorCode.ANIMATION_UNSUPPORTED]: 'reject',
  [ErrorCode.FRAME_CORRUPT]: 'reject',
  [ErrorCode.MEMORY_LIMIT]: 'reject',
  [ErrorCode.DECODER_UNAVAILABLE]: 'fail-closed',
  [ErrorCode.DECODE_FAILED]: 'reject',
  [ErrorCode.PUBLISH_FAILED]: 'fail-closed',
  [ErrorCode.INPUT_EMPTY]: 'reject',
  [ErrorCode.INPUT_TOO_LARGE]: 'reject',
  [ErrorCode.SERVICE_SHUTDOWN]: 'fail-closed',
});

export class AvifError extends Error {
  /**
   * @param {string} code one of ErrorCode
   * @param {string} message stable, human-readable detail
   * @param {{ cause?: unknown, details?: Record<string, unknown> }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, { cause: extra.cause });
    this.name = 'AvifError';
    this.code = code;
    this.quality = EXIT_QUALITY[code] ?? 'reject';
    // Freeze a shallow copy so later mutation of caller objects cannot alter
    // the recorded failure.
    this.details = Object.freeze({ ...(extra.details ?? {}) });
  }

  toJSON() {
    return { name: this.name, code: this.code, quality: this.quality, message: this.message, details: this.details };
  }
}

/**
 * Wrap an unknown thrown value from the WASM boundary into a stable error.
 * Never re-throws the raw foreign exception.
 */
export function wrapDecoderError(cause) {
  if (cause instanceof AvifError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AvifError(ErrorCode.DECODE_FAILED, `decoder rejected input: ${message}`, { cause });
}
