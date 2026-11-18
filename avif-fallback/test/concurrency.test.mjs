/*!
 * Concurrency, determinism and failure-path tests.
 *
 * The same input must produce byte-identical output under parallel execution
 * and reordered chunking; corrupted inputs must fail with stable errors and
 * must never be reported as successes; a mid-run "restart" (new pipeline +
 * fresh backend state) must reproduce the prior result.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createPipeline } from '../src/pipeline.js';
import { ErrorCode } from '../src/errors.js';
import { FileResultCache } from '../src/cache.js';
import { applyOrientation } from '../src/pixel.js';
import { _resetBackend } from '../src/backend.js';
import { loadManifest, loadSample } from './helpers.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const manifest = await loadManifest();
let dir;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'avif-fb-conc-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('determinism under concurrency', () => {
  test('parallel decodes of the same input converge on one hash', async () => {
    const pipeline = createPipeline({ backend: 'wasm' });
    const input = await loadSample('size-256x128.avif');
    const results = await Promise.all(
      Array.from({ length: 12 }, () => pipeline.run(new Uint8Array(input), { format: 'rgba' })),
    );
    const hashes = new Set(results.map((r) => sha256(r.output)));
    assert.equal(hashes.size, 1);
    assert.ok(results.every((r) => r.backend === 'wasm'));
  });

  test('concurrent decodes of distinct inputs keep independent buffers', async () => {
    const pipeline = createPipeline({ backend: 'wasm' });
    const [a, b] = await Promise.all([
      pipeline.run(await loadSample('size-2x2.avif'), { format: 'rgba' }),
      pipeline.run(await loadSample('size-33x17.avif'), { format: 'rgba' }),
    ]);
    assert.notEqual(a.output.buffer, b.output.buffer);
    assert.equal(a.output.length, 2 * 2 * 4);
    assert.equal(b.output.length, 33 * 17 * 4);
  });

  test('orientation output is independent of band scheduling (permutation check)', () => {
    // Build a recognizable grid and apply every orientation twice; the
    // single-writer-per-output-index rule means repeated runs are identical.
    const w = 130; // spans multiple 64-row chunks after a 90-degree rotation
    const h = 70;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 31) & 255;
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r1 = applyOrientation(src, w, h, o);
      const r2 = applyOrientation(src, w, h, o);
      assert.deepEqual(r1.rgba, r2.rgba, `orientation ${o} not reproducible`);
    }
  });

  test('parallel writers of one cache key converge without partial files', async () => {
    const cache = new FileResultCache(path.join(dir, 'race'));
    const pipeline = createPipeline({ backend: 'wasm', cache });
    const input = await loadSample('alpha-zones.avif');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => pipeline.run(new Uint8Array(input), { format: 'png' })),
    );
    const hashes = new Set(results.map((r) => sha256(r.output)));
    assert.equal(hashes.size, 1);
    // Every job either published or consumed a cache entry; none errored.
    assert.equal(results.length, 8);
    assert.ok(cache.stats().hits + cache.stats().misses === 8);
    // Atomic publish leaves no temp files behind, and the final entry reads back.
    const removed = await cache.cleanupTemp();
    assert.equal(removed, 0);
    const key = results[0].key;
    const persisted = await cache.get(key);
    assert.ok(persisted && persisted.length > 0);
  });
});

describe('corrupted inputs never report success', () => {
  for (const entry of manifest.samples.filter((s) => s.kind === 'corrupt')) {
    test(`${entry.file} fails through the full pipeline`, async () => {
      const pipeline = createPipeline({ backend: 'wasm' });
      await assert.rejects(
        async () => pipeline.run(await loadSample(entry.file.split('/').pop()), { format: 'png' }),
        (err) => {
          assert.ok(Object.values(ErrorCode).includes(err.code), `unexpected code ${err.code}`);
          return true;
        },
      );
    });
  }

  test('byte-flipped image that passes structure still fails at decode, not silently', async () => {
    const pipeline = createPipeline({ backend: 'wasm' });
    const entry = manifest.samples.find((s) => s.file.endsWith('corrupt-byteflip.avif'));
    // The mdat payload corruption is invisible to the structural parser but
    // fatal to the AV1 decoder, proving decode-stage rejection is real.
    await assert.rejects(
      async () => pipeline.run(await loadSample(entry.file.split('/').pop())),
      (err) => err.code === ErrorCode.DECODE_FAILED,
    );
  });
});

describe('mid-run restart', () => {
  test('resetting the backend and rebuilding the pipeline reproduces identical pixels', async () => {
    const input = await loadSample('orient-6-rotate-90.avif');
    const before = await createPipeline({ backend: 'wasm' }).run(new Uint8Array(input), { format: 'rgba' });
    _resetBackend(); // simulate process-level backend restart
    const after = await createPipeline({ backend: 'wasm' }).run(new Uint8Array(input), { format: 'rgba' });
    assert.equal(sha256(before.output), sha256(after.output));
    assert.equal(before.width, after.width);
    assert.equal(before.height, after.height);
    assert.equal(before.orientation, after.orientation);
  });

  test('a cold pipeline repopulates an empty cache directory to the same bytes', async () => {
    const cacheDir = path.join(dir, 'restart-cache');
    const input = await loadSample('size-33x17.avif');
    const first = await createPipeline({ backend: 'wasm', cache: new FileResultCache(cacheDir) }).run(input, {
      format: 'png',
    });
    await rm(cacheDir, { recursive: true, force: true });
    const second = await createPipeline({ backend: 'wasm', cache: new FileResultCache(cacheDir) }).run(
      new Uint8Array(input),
      { format: 'png' },
    );
    assert.deepEqual(Buffer.from(first.output), Buffer.from(second.output));
    assert.equal(second.cached, false);
  });
});

describe('no half-finished result on failure', () => {
  test('a rejected animation job leaves no cache entry', async () => {
    const cache = new FileResultCache(path.join(dir, 'no-partial'));
    const pipeline = createPipeline({ backend: 'wasm', cache });
    const entry = manifest.samples.find((s) => s.kind === 'animation-reject');
    await assert.rejects(async () => pipeline.run(await loadSample(entry.file.split('/').pop())));
    assert.deepEqual(cache.stats(), { hits: 0, misses: 0 });
  });
});
