/*!
 * WASM backend boundary.
 *
 * Two guarantees that the rest of the pipeline relies on:
 *  1. Serialized access: the emscripten module keeps state on a single heap.
 *     JS is single-threaded and module.decode is synchronous, but decode()
 *     calls can still interleave around `await` points in callers. A mutex
 *     makes the acquire/decode/copy critical section explicit and order-safe.
 *  2. No aliased buffers: every result is copied into a freshly allocated
 *     Uint8Array before the lock is released, so two requests can never share
 *     a WASM heap view that a later decode would overwrite.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { AvifError, ErrorCode } from './errors.js';

const require = createRequire(import.meta.url);

let modulePromise;
let queueChain = Promise.resolve();

function withLock(task) {
  const run = queueChain.then(task, task);
  // Keep the chain alive even if task rejects.
  queueChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadModule() {
  const decodeEntry = require.resolve('@jsquash/avif/decode.js');
  const wasmPath = path.join(path.dirname(decodeEntry), 'codec', 'dec', 'avif_dec.wasm');
  const [{ default: decode, init }, wasmBytes] = await Promise.all([
    import('@jsquash/avif/decode.js'),
    readFile(wasmPath),
  ]);
  const compiled = await WebAssembly.compile(wasmBytes);
  await init(compiled);
  return decode;
}

/**
 * Decode to an independent RGBA buffer.
 *
 * @param {ArrayBuffer} arrayBuffer must be a *detached-ownership* view: callers
 *        pass buffer.slice(...) so the WASM layer cannot alias caller memory.
 * @returns {Promise<{width:number, height:number, rgba: Uint8Array, bitDepth: number}>}
 */
export async function decodeRgba(arrayBuffer, bitDepth = 8) {
  if (!modulePromise) {
    modulePromise = loadModule().catch((cause) => {
      modulePromise = undefined;
      throw new AvifError(ErrorCode.DECODER_UNAVAILABLE, 'WASM AVIF backend failed to initialise', { cause });
    });
  }
  let decode;
  try {
    decode = await modulePromise;
  } catch (err) {
    throw err instanceof AvifError ? err : new AvifError(ErrorCode.DECODER_UNAVAILABLE, err.message, { cause: err });
  }

  return withLock(async () => {
    let image;
    try {
      image = bitDepth === 8 ? await decode(arrayBuffer) : await decode(arrayBuffer, { bitDepth });
    } catch (cause) {
      throw new AvifError(ErrorCode.DECODE_FAILED, `WASM decode failed: ${cause.message ?? cause}`, { cause });
    }
    if (!image || !image.data || image.width === 0 || image.height === 0) {
      throw new AvifError(ErrorCode.DECODE_FAILED, 'decoder returned an empty result without throwing');
    }
    // Hard copy out of the WASM heap, then release the lock.
    const rgba = new Uint8Array(image.data.length);
    rgba.set(image.data);
    return { width: image.width, height: image.height, rgba, bitDepth };
  });
}

/** Test-only hook: force re-initialisation on next call. */
export function _resetBackend() {
  modulePromise = undefined;
  queueChain = Promise.resolve();
}
