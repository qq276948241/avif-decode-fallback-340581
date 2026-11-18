/*!
 * Decode capability probe.
 *
 * The probe answers one question: which backend can actually decode AVIF in
 * this process? It tries the native pipeline (sharp/libvips) first and the
 * locked WASM backend second, records why each candidate was accepted or
 * rejected, and freezes the result.
 *
 * Silent downgrade is impossible by construction:
 *  - every decode call records `backend` on its result,
 *  - selecting a backend the probe did not certify throws DECODER_UNAVAILABLE,
 *  - the probe outcome carries timestamps and versions for diagnostics.
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AvifError, ErrorCode } from './errors.js';
import { decodeRgba } from './backend.js';
import { RULES_VERSION } from './constants.js';

const require = createRequire(import.meta.url);

let cached;
let probeBytes;

/**
 * Build a valid 1x1 lossless AVIF at runtime via the locked encoder, so the
 * probe never depends on a hand-authored byte blob. Memoised per process.
 */
async function getProbeBytes() {
  if (probeBytes) return probeBytes;
  const encodeEntry = await import('@jsquash/avif/encode.js');
  const jsPath = require.resolve('@jsquash/avif/encode.js');
  const wasmPath = path.join(path.dirname(jsPath), 'codec', 'enc', 'avif_enc.wasm');
  await encodeEntry.init(await WebAssembly.compile(await readFile(wasmPath)));
  const rgba = new Uint8ClampedArray([10, 20, 30, 255]);
  const out = await encodeEntry.default({ data: rgba, width: 1, height: 1 }, { lossless: true });
  probeBytes = Buffer.from(out);
  return probeBytes;
}

async function probeNative() {
  const started = Date.now();
  try {
    const sharp = require('sharp');
    const versions = sharp.versions ? sharp.versions('heif') : undefined;
    const probe = await getProbeBytes();
    const meta = await sharp(probe).metadata();
    if (meta.format !== 'heif' || !meta.width) {
      return { ok: false, reason: `native metadata reported format=${meta.format}`, durationMs: Date.now() - started };
    }
    return {
      ok: true,
      backend: 'native',
      version: typeof versions === 'string' ? versions : 'unknown',
      durationMs: Date.now() - started,
    };
  } catch (cause) {
    return {
      ok: false,
      backend: 'native',
      reason: cause.code ? `${cause.code}: ${cause.message}` : String(cause.message ?? cause),
      durationMs: Date.now() - started,
    };
  }
}

async function probeWasm() {
  const started = Date.now();
  try {
    const probe = await getProbeBytes();
    const out = await decodeRgba(probe.buffer.slice(probe.byteOffset, probe.byteOffset + probe.byteLength));
    if (out.width !== 1 || out.height !== 1) {
      return { ok: false, reason: `unexpected probe geometry ${out.width}x${out.height}`, durationMs: Date.now() - started };
    }
    return { ok: true, backend: 'wasm', version: '@jsquash/avif@2.1.1', durationMs: Date.now() - started };
  } catch (cause) {
    return {
      ok: false,
      backend: 'wasm',
      reason: cause instanceof AvifError ? `${cause.code}: ${cause.message}` : String(cause.message ?? cause),
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Run (or return cached) capability detection.
 * @param {{ force?: 'native'|'wasm' }} [options] omit force for auto selection
 */
export async function probeCapabilities(options = {}) {
  // The auto probe is the canonical cached result; a forced call reuses the
  // same backend evidence but validates the requested backend is certified.
  if (!cached) {
    const native = await probeNative();
    const wasm = await probeWasm();
    const autoSelected = native.ok ? 'native' : wasm.ok ? 'wasm' : null;
    cached = Object.freeze({
      rulesVersion: RULES_VERSION,
      probedAt: new Date().toISOString(),
      selected: autoSelected,
      native: Object.freeze(native),
      wasm: Object.freeze(wasm),
      degraded: autoSelected === 'wasm',
    });
  }

  if (options.force === 'native') {
    if (!cached.native.ok) {
      throw new AvifError(ErrorCode.DECODER_UNAVAILABLE, `forced native backend unavailable: ${cached.native.reason}`, {
        details: { native: cached.native, wasm: cached.wasm },
      });
    }
    return Object.freeze({ ...cached, selected: 'native', degraded: false });
  }
  if (options.force === 'wasm') {
    if (!cached.wasm.ok) {
      throw new AvifError(ErrorCode.DECODER_UNAVAILABLE, `forced wasm backend unavailable: ${cached.wasm.reason}`, {
        details: { native: cached.native, wasm: cached.wasm },
      });
    }
    return Object.freeze({ ...cached, selected: 'wasm', degraded: true });
  }

  if (!cached.selected) {
    throw new AvifError(ErrorCode.DECODER_UNAVAILABLE, 'no AVIF backend could decode the probe image', {
      details: { native: cached.native, wasm: cached.wasm },
    });
  }
  return cached;
}

export function _resetProbe() {
  cached = undefined;
}
