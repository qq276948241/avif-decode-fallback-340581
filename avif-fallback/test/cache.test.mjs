/*!
 * Cache-key, atomic-publish and concurrency tests.
 *
 * The cache key must include the rules version and the colour/orientation
 * parameters; concurrent or reordered work must converge on byte-identical
 * output without ever exposing a half-written file.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildCacheKey, FileResultCache } from '../src/cache.js';
import { RULES_VERSION } from '../src/constants.js';
import { createPipeline } from '../src/pipeline.js';
import { loadSample } from './helpers.mjs';

let dir;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'avif-fb-cache-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cache key composition', () => {
  const input = new Uint8Array([1, 2, 3, 4]);

  test('includes the rules version literally', () => {
    const { canonical } = buildCacheKey(input, {
      orientation: 1,
      colourFingerprint: 'nclx:1/13/6/1',
      format: 'png',
    });
    assert.ok(canonical.includes(RULES_VERSION));
  });

  test('different orientation yields a different key', () => {
    const base = { colourFingerprint: 'nclx:1/13/6/1', format: 'png' };
    const a = buildCacheKey(input, { ...base, orientation: 1 }).key;
    const b = buildCacheKey(input, { ...base, orientation: 6 }).key;
    assert.notEqual(a, b);
  });

  test('different colour fingerprint yields a different key', () => {
    const base = { orientation: 1, format: 'png' };
    const a = buildCacheKey(input, { ...base, colourFingerprint: 'nclx:1/13/6/1' }).key;
    const b = buildCacheKey(input, { ...base, colourFingerprint: 'icc:420' }).key;
    assert.notEqual(a, b);
  });

  test('different output format yields a different key', () => {
    const base = { orientation: 1, colourFingerprint: 'nclx:1/13/6/1' };
    assert.notEqual(
      buildCacheKey(input, { ...base, format: 'png' }).key,
      buildCacheKey(input, { ...base, format: 'rgba' }).key,
    );
  });

  test('identical parameters produce a stable key across calls', () => {
    const params = { orientation: 3, colourFingerprint: 'nclx:2/2/0/0', format: 'png' };
    assert.equal(buildCacheKey(input, params).key, buildCacheKey(input, params).key);
  });
});

describe('atomic file cache', () => {
  test('a missing key returns undefined and records a miss', async () => {
    const cache = new FileResultCache(dir);
    const result = await cache.get('deadbeefdeadbeef');
    assert.equal(result, undefined);
    assert.equal(cache.stats().misses, 1);
  });

  test('set then get returns identical bytes and records a hit', async () => {
    const cache = new FileResultCache(dir);
    const payload = Buffer.from('publish-block');
    await cache.set('abc123abc123abc1', payload);
    const back = await cache.get('abc123abc123abc1');
    assert.deepEqual(back, payload);
    assert.equal(cache.stats().hits, 1);
  });

  test('a leftover .tmp file is swept and never read as a result', async () => {
    const cache = new FileResultCache(dir);
    const shard = path.join(dir, 'ff');
    await rm(shard, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(shard, { recursive: true });
    await writeFile(path.join(shard, 'ff00.1.2.tmp'), 'partial');
    const removed = await cache.cleanupTemp();
    assert.equal(removed, 1);
    assert.equal(await cache.get('ff00'), undefined);
  });
});

describe('pipeline cache integration and repeated submission', () => {
  test('repeating the same job returns a cache hit with identical bytes', async () => {
    const cache = new FileResultCache(path.join(dir, 'pipe'));
    const pipeline = createPipeline({ backend: 'wasm', cache });
    const input = await loadSample('size-33x17.avif');
    const first = await pipeline.run(input, { format: 'png' });
    const second = await pipeline.run(new Uint8Array(input), { format: 'png' });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.backend, 'cache');
    assert.deepEqual(Buffer.from(second.output), Buffer.from(first.output));
    assert.equal(second.key, first.key);
  });
});
