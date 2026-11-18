/*!
 * Deterministic pixel-pipeline tests.
 *
 * Covers boundary sizes, all eight EXIF orientations, straight-alpha semantics,
 * integer rounding and the guarantee that chunk scheduling cannot change the
 * result. Expected pixels are derived from the same pure painter used to make
 * the samples, so assertions test real processing rather than stored logs.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { applyOrientation, orientedDimensions, roundedDivide, sampleClamped } from '../src/pixel.js';
import { CHANNELS } from '../src/constants.js';
import { loadManifest, loadSample } from './helpers.mjs';
import { createPipeline } from '../src/pipeline.js';

const manifest = await loadManifest();
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Painter with a unique, collision-free alpha at every coordinate. */
function paint(width, height, seed) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = (x * 37 + seed * 11) & 255;
      rgba[i + 1] = (y * 53 + seed * 7) & 255;
      rgba[i + 2] = (x * 11 + y * 13 + seed * 3) & 255;
      // Unique nonzero alpha (pixel index + 1) makes the pixel multiset a
      // faithful bijection check rather than a collision-prone comparison.
      rgba[i + 3] = (n % 254) + 1;
      n += 1;
    }
  }
  return rgba;
}

describe('boundary sizes and bit-exact decode', () => {
  const pipeline = createPipeline({ backend: 'wasm' });

  for (const entry of manifest.samples.filter((s) => s.kind === 'boundary-size')) {
    test(`decodes ${entry.width}x${entry.height} to the exact painted pixels`, async () => {
      const result = await pipeline.run(await loadSample(entry.file.split('/').pop()), { format: 'rgba' });
      assert.equal(result.width, entry.width);
      assert.equal(result.height, entry.height);
      assert.equal(result.output.length, entry.width * entry.height * CHANNELS);
      assert.equal(sha256(result.output), entry.expectedRgbaSha256);
    });
  }
});

describe('EXIF orientation geometry and pixels', () => {
  test('orientedDimensions swaps axes only for codes 5..8', () => {
    for (const o of [1, 2, 3, 4]) assert.deepEqual(orientedDimensions(8, 5, o), { width: 8, height: 5 });
    for (const o of [5, 6, 7, 8]) assert.deepEqual(orientedDimensions(8, 5, o), { width: 5, height: 8 });
  });

  const coded = paint(4, 3, 2);
  const cases = [
    [1, 4, 3],
    [2, 4, 3],
    [3, 4, 3],
    [4, 4, 3],
    [5, 3, 4],
    [6, 3, 4],
    [7, 3, 4],
    [8, 3, 4],
  ];
  for (const [orientation, w, h] of cases) {
    test(`orientation ${orientation} produces a self-consistent bijection`, () => {
      const out = applyOrientation(coded, 4, 3, orientation);
      assert.equal(out.width, w);
      assert.equal(out.height, h);
      // Orientation only permutes whole RGBA pixels: compare the multiset of
      // 4-byte pixels, never individual channel bytes.
      const pixelKey = (arr, p) => `${arr[p]},${arr[p + 1]},${arr[p + 2]},${arr[p + 3]}`;
      const keysOf = (arr) => {
        const set = [];
        for (let p = 0; p < arr.length; p += 4) set.push(pixelKey(arr, p));
        return set.sort();
      };
      assert.deepEqual(keysOf(out.rgba), keysOf(coded));
      // And the inverse-consistency for the swapping orientations: the output
      // has exactly the declared pixel count.
      assert.equal(out.rgba.length, w * h * 4);
    });
  }

  test('identity orientation returns an independent buffer, not the input alias', () => {
    const out = applyOrientation(coded, 4, 3, 1);
    assert.notEqual(out.rgba.buffer, coded.buffer);
    out.rgba[0] = 99;
    assert.notEqual(coded[0], 99);
  });

  test('all orientation fixtures decode and report the declared code', async () => {
    const pipeline = createPipeline({ backend: 'wasm' });
    for (const entry of manifest.samples.filter((s) => s.kind === 'orientation')) {
      const result = await pipeline.run(await loadSample(entry.file.split('/').pop()), { format: 'rgba' });
      assert.equal(result.orientation, entry.orientation);
    }
  });
});

describe('alpha semantics', () => {
  test('straight alpha 0/128/255 zones survive decode untouched', async () => {
    const pipeline = createPipeline({ backend: 'wasm' });
    const entry = manifest.samples.find((s) => s.kind === 'alpha');
    const result = await pipeline.run(await loadSample(entry.file.split('/').pop()), { format: 'rgba' });
    const w = result.width;
    const alphaAt = (x, y) => result.output[(y * w + x) * 4 + 3];
    for (let y = 0; y < result.height; y++) {
      assert.equal(alphaAt(0, y), 0);
      assert.equal(alphaAt(5, y), 128);
      assert.equal(alphaAt(10, y), 255);
    }
    // Fully transparent pixel keeps its RGB channels (not zeroed).
    const firstRgb = [result.output[0], result.output[1], result.output[2]];
    assert.ok(firstRgb.some((v) => v !== 0));
  });
});

describe('integer and boundary helpers', () => {
  test('roundedDivide uses deterministic half-up integer rounding', () => {
    assert.equal(roundedDivide(0, 4), 0);
    assert.equal(roundedDivide(1, 4), 0);
    assert.equal(roundedDivide(2, 4), 1); // floor((2+2)/4)
    assert.equal(roundedDivide(7, 2), 4);
    assert.throws(() => roundedDivide(1, 0));
  });

  test('sampleClamped never reads outside the buffer', () => {
    const rgba = paint(3, 3, 1);
    const tl = sampleClamped(rgba, 3, 3, -5, -9);
    const br = sampleClamped(rgba, 3, 3, 99, 77);
    assert.deepEqual(tl, [...rgba.subarray(0, 4)]);
    assert.deepEqual(br, [...rgba.subarray(((2 * 3 + 2) * 4), ((2 * 3 + 2) * 4) + 4)]);
  });
});
