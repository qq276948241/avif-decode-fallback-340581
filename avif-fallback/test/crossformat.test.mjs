/*!
 * Cross-format and capability tests.
 *
 * The fallback must coexist with the native sharp path: capability detection
 * records both candidates, and the chosen backend is always stamped on the
 * result. Outputs are verified across the two supported publish formats
 * (raw RGBA and PNG), plus the repo's own pre-existing AVIF fixtures.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeCapabilities, _resetProbe } from '../src/capability.js';
import { createPipeline } from '../src/pipeline.js';
import { encodePng } from '../src/png.js';
import { RULES_VERSION } from '../src/constants.js';
import { loadSample } from './helpers.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));
const repoFixtures = path.join(here, '..', '..', 'test', 'fixtures');

describe('capability probe', () => {
  test('records native and wasm candidates and selects a certified backend', async () => {
    _resetProbe();
    const cap = await probeCapabilities();
    assert.ok(cap.native && 'ok' in cap.native);
    assert.ok(cap.wasm && 'ok' in cap.wasm);
    assert.ok(['native', 'wasm'].includes(cap.selected));
    assert.equal(cap.rulesVersion, RULES_VERSION);
    assert.equal(cap.wasm.ok, true); // locked WASM backend always available offline
    assert.equal(cap.native.ok, false); // sharp is not installed in this package
  });

  test('forcing an unavailable native backend fails closed', async () => {
    _resetProbe();
    await assert.rejects(() => probeCapabilities({ force: 'native' }), (e) => e.code === 'AVIF_DECODER_UNAVAILABLE');
  });

  test('forcing wasm returns a degraded, certified selection', async () => {
    const cap = await probeCapabilities({ force: 'wasm' });
    assert.equal(cap.selected, 'wasm');
    assert.equal(cap.degraded, true);
  });
});

describe('cross-format publishing', () => {
  test('PNG output decodes back to the same RGBA pixels (stored blocks)', async () => {
    const pipeline = createPipeline({ backend: 'wasm' });
    const result = await pipeline.run(await loadSample('alpha-zones.avif'), { format: 'rgba' });
    const png = encodePng(result.output, result.width, result.height);
    const decoded = await parsePngRgba(png);
    assert.deepEqual(decoded, result.output);
  });

  test('rgba and png outputs share identical underlying pixels', async () => {
    const pipeline = createPipeline({ backend: 'wasm' });
    const input = await loadSample('size-33x17.avif');
    const rgba = await pipeline.run(new Uint8Array(input), { format: 'rgba' });
    const png = await pipeline.run(new Uint8Array(input), { format: 'png' });
    const fromPng = await parsePngRgba(png.output);
    assert.deepEqual(fromPng, rgba.output);
  });
});

describe('upstream sharp fixtures remain decodable through the fallback', () => {
  for (const name of ['pitm.avif', 'sdr_cosmos12920_cicp1-13-6_yuv444_full_qp10.avif']) {
    test(`decodes upstream fixture ${name}`, async () => {
      const file = path.join(repoFixtures, name);
      const input = new Uint8Array(await readFile(file));
      const result = await createPipeline({ backend: 'wasm' }).run(input, { format: 'rgba' });
      assert.ok(result.width > 0 && result.height > 0);
      assert.equal(result.output.length, result.width * result.height * 4);
      // Stable hash across repeated runs.
      const again = await createPipeline({ backend: 'wasm' }).run(new Uint8Array(input), { format: 'rgba' });
      assert.equal(sha256(again.output), sha256(result.output));
    });
  }
});

/** Minimal RGBA PNG reader sufficient for verifying our own writer. */
async function parsePngRgba(png) {
  const inflate = async (data) => {
    const { gunzipSync } = await import('node:zlib');
    // Stored-block zlib stream: use inflateRaw via zlib's inflate with wrapper.
    const { inflateSync } = await import('node:zlib');
    return inflateSync(data);
  };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  let idat = [];
  let width = 0;
  let height = 0;
  while (off < png.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    const payload = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = new DataView(payload.buffer, payload.byteOffset).getUint32(0);
      height = new DataView(payload.buffer, payload.byteOffset).getUint32(4);
    } else if (type === 'IDAT') {
      idat.push(payload);
    }
    off += 12 + len;
  }
  const raw = await inflate(Buffer.concat(idat.map((p) => Buffer.from(p))));
  const stride = width * 4;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error('unexpected PNG filter in self-generated file');
    out.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return out;
}
