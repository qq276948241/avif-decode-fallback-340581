/*!
 * Structural validation tests: every rejection must use a stable error code
 * and must never leave partial state (the validator allocates no pixels and
 * returns either one frozen descriptor or throws).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCode } from '../src/errors.js';
import { inspectAvif } from '../src/isobmff.js';
import { loadManifest, loadSample } from './helpers.mjs';

const manifest = await loadManifest();

describe('ISOBMFF structural validation', () => {
  test('accepts every well-formed sample and freezes its descriptor', async () => {
    for (const entry of manifest.samples) {
      if (entry.expectedErrorCode) continue;
      const descriptor = inspectAvif(await loadSample(pathName(entry.file)));
      assert.ok(Object.isFrozen(descriptor), `${entry.file} descriptor must be frozen`);
      assert.equal(descriptor.animated, false);
      assert.ok(descriptor.width > 0 && descriptor.height > 0);
    }
  });

  test('rejects each negative fixture with its documented stable code', async () => {
    for (const entry of manifest.samples) {
      if (!entry.expectedErrorCode) continue;
      await assert.rejects(
        async () => inspectAvif(await loadSample(pathName(entry.file))),
        (err) => {
          assert.equal(err.code, entry.expectedErrorCode, entry.file);
          assert.equal(err.name, 'AvifError');
          assert.ok(typeof err.message === 'string' && err.message.length > 0);
          return true;
        },
      );
    }
  });

  test('empty and oversized inputs are rejected before any box walk', () => {
    assert.throws(() => inspectAvif(new Uint8Array(0)), (e) => e.code === ErrorCode.INPUT_EMPTY);
    const huge = new Uint8Array(64 * 1024 * 1024 + 1);
    assert.throws(() => inspectAvif(huge), (e) => e.code === ErrorCode.INPUT_TOO_LARGE);
  });

  test('rejects non-Uint8Array input without touching it', () => {
    assert.throws(() => inspectAvif('not-bytes'), (e) => e.code === ErrorCode.INPUT_EMPTY);
  });

  test('descriptor orientation stays within the supported EXIF range', async () => {
    for (const entry of manifest.samples.filter((s) => s.kind === 'orientation')) {
      const d = inspectAvif(await loadSample(pathName(entry.file)));
      assert.ok(d.orientation >= 1 && d.orientation <= 8);
      assert.equal(d.orientation, entry.orientation);
    }
  });
});

function pathName(file) {
  return file.split('/').pop();
}
