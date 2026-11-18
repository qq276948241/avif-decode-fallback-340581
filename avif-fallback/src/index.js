/*!
 * Public entry for the AVIF decode fallback package.
 *
 * Compatibility-layer boundary: this package does NOT modify sharp's entry
 * points or global behaviour. It is a side-package that sharp (or any caller)
 * can opt into explicitly. Importing it never registers global handlers, never
 * monkey-patches modules and never touches the parent project's `lib/` tree.
 */

export { AvifError, ErrorCode, wrapDecoderError } from './errors.js';
export { inspectAvif } from './isobmff.js';
export { probeCapabilities } from './capability.js';
export { createPipeline } from './pipeline.js';
export { FileResultCache, buildCacheKey } from './cache.js';
export { applyOrientation, orientedDimensions, sampleClamped, roundedDivide, assertDecodedGeometry } from './pixel.js';
export { encodePng } from './png.js';
export { decodeRgba } from './backend.js';
export { RULES_VERSION, LIMITS, SUPPORTED_ORIENTATIONS } from './constants.js';
