/*!
 * End-to-end AVIF fallback pipeline.
 *
 * Stages (each either completes or throws a stable AvifError; nothing is
 * observable to the caller before the final publish stage):
 *
 *   1. inspect     ISOBMFF structural validation, zero pixel allocation
 *   2. certify     capability probe selects an already-certified backend
 *   3. decode      locked WASM call returning an independent RGBA copy
 *   4. cross-check decoded geometry must equal declared ispe geometry
 *   5. orient      deterministic integer EXIF transform (fresh buffer)
 *   6. publish     encode output, then atomically place it (cache/FS)
 *
 * Animation policy: multi-frame / image-sequence inputs are rejected in stage
 * 1, so a failed frame can never hide inside a partially-successful result set.
 */

import { randomUUID } from 'node:crypto';

import { decodeRgba } from './backend.js';
import { buildCacheKey, FileResultCache } from './cache.js';
import { probeCapabilities } from './capability.js';
import { CHANNELS, RULES_VERSION } from './constants.js';
import { AvifError, ErrorCode } from './errors.js';
import { inspectAvif } from './isobmff.js';
import { applyOrientation, assertDecodedGeometry, orientedDimensions } from './pixel.js';
import { encodePng } from './png.js';

function colourFingerprint(descriptor) {
  const c = descriptor.colour;
  if (c.colourType === 'nclx') {
    return `nclx:${c.colourPrimaries}/${c.transferCharacteristics}/${c.matrixCoefficients}/${c.fullRange ? 1 : 0}`;
  }
  if (c.colourType === 'prof' || c.colourType === 'rICC') {
    return `icc:${c.profileBytes}`;
  }
  return 'unspecified';
}

export function createPipeline(options = {}) {
  const cache = options.cache ?? null;
  const forcedBackend = options.backend ?? 'auto';

  async function run(input, requestOptions = {}) {
    const jobId = randomUUID();
    const started = Date.now();
    const trace = [];
    const step = async (name, fn) => {
      const t0 = Date.now();
      try {
        const value = await fn();
        trace.push({ stage: name, ok: true, ms: Date.now() - t0 });
        return value;
      } catch (err) {
        trace.push({ stage: name, ok: false, ms: Date.now() - t0, code: err.code ?? 'UNKNOWN' });
        throw err;
      }
    };

    let bytes = input instanceof Buffer ? new Uint8Array(input) : input;
    if (!(bytes instanceof Uint8Array)) {
      throw new AvifError(ErrorCode.INPUT_EMPTY, 'pipeline input must be Buffer or Uint8Array');
    }
    // Owned copy: downstream WASM never aliases caller-owned memory.
    bytes = new Uint8Array(bytes);

    // Stage 1 — structural validation (no pixels allocated on rejection).
    const descriptor = await step('inspect', () => inspectAvif(bytes));

    const format = requestOptions.format ?? 'png';
    if (format !== 'png' && format !== 'rgba') {
      throw new AvifError(ErrorCode.PUBLISH_FAILED, `unsupported output format "${format}"`, {
        details: { format },
      });
    }

    const cacheParams = {
      orientation: descriptor.orientation,
      colourFingerprint: colourFingerprint(descriptor),
      format,
      alphaPolicy: 'straight',
    };
    const { key, hash, canonical } = buildCacheKey(bytes, cacheParams);

    if (cache) {
      const hit = await cache.get(key);
      if (hit) {
        return {
          jobId,
          cached: true,
          backend: 'cache',
          rulesVersion: RULES_VERSION,
          key,
          inputHash: hash,
          width: orientedDimensions(descriptor.width, descriptor.height, descriptor.orientation).width,
          height: orientedDimensions(descriptor.width, descriptor.height, descriptor.orientation).height,
          channels: CHANNELS,
          orientation: descriptor.orientation,
          output: hit,
          trace: [{ stage: 'cache-hit', ok: true, ms: 0 }],
          elapsedMs: Date.now() - started,
        };
      }
    }

    // Stage 2 — certified backend only.
    const capability = await step('probe', () =>
      forcedBackend === 'auto' ? probeCapabilities() : probeCapabilities({ force: forcedBackend }),
    );
    if (forcedBackend !== 'auto' && capability.selected !== forcedBackend) {
      throw new AvifError(
        ErrorCode.DECODER_UNAVAILABLE,
        `certified backend is "${capability.selected}", requested "${forcedBackend}"`,
      );
    }

    // Stage 3 — decode under the backend lock, owning the ArrayBuffer slice.
    const slice = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const decoded = await step('decode', () => decodeRgba(slice));

    // Stage 4 — cross-check declared vs actual geometry.
    step('cross-check', () => assertDecodedGeometry(decoded, descriptor));

    // Stage 5 — orientation in a fresh, deterministic buffer.
    const oriented = await step('orient', () =>
      applyOrientation(decoded.rgba, decoded.width, decoded.height, descriptor.orientation),
    );

    // Stage 6 — publish. Build payload first, then atomic cache placement.
    const output = await step('encode', () =>
      format === 'png' ? encodePng(oriented.rgba, oriented.width, oriented.height) : oriented.rgba,
    );
    if (cache) {
      await step('publish', () => cache.set(key, output));
    }

    return {
      jobId,
      cached: false,
      backend: capability.selected,
      degraded: capability.degraded,
      rulesVersion: RULES_VERSION,
      key,
      cacheCanonical: canonical,
      inputHash: hash,
      width: oriented.width,
      height: oriented.height,
      channels: CHANNELS,
      orientation: descriptor.orientation,
      colour: descriptor.colour,
      output,
      descriptor,
      trace,
      elapsedMs: Date.now() - started,
    };
  }

  return { run, cache };
}
