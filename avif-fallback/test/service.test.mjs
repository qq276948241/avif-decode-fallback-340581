/*!
 * HTTP service tests.
 *
 * Health checks must answer without invoking a codec; decode requests must
 * publish real output; failures use stable codes; graceful shutdown waits
 * within its deadline and sweeps temporary files.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../src/service.js';
import { loadSample } from './helpers.mjs';

let app;
let base;
let cacheDir;

before(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'avif-fb-svc-'));
  app = await createApp({ cacheDir, backend: 'wasm' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const addr = app.server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.shutdown('test-end');
  await rm(cacheDir, { recursive: true, force: true });
});

describe('service endpoints', () => {
  test('GET /health reports readiness without running a codec', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.backend, 'wasm');
    assert.equal(body.degraded, true);
    assert.ok(Number.isInteger(body.queueDepth));
  });

  test('POST /decode returns a real PNG with trace headers', async () => {
    const input = await loadSample('size-2x2.avif');
    const res = await fetch(`${base}/decode?format=png`, { method: 'POST', body: input });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-backend'), 'wasm');
    assert.match(res.headers.get('x-rules-version'), /^avif-fb-/);
    const png = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test('a second identical request is served from cache', async () => {
    const input = await loadSample('size-2x2.avif');
    await fetch(`${base}/decode?format=png`, { method: 'POST', body: new Uint8Array(input) });
    const res = await fetch(`${base}/decode?format=png`, { method: 'POST', body: new Uint8Array(input) });
    assert.equal(res.headers.get('x-cache'), 'hit');
  });

  test('corrupt input is a 422 with a stable error code', async () => {
    const input = await loadSample('corrupt-ftyp-only.avif');
    const res = await fetch(`${base}/decode`, { method: 'POST', body: input });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.error.code.startsWith('AVIF_'));
  });

  test('unknown route is a JSON 404', async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'NOT_FOUND');
  });
});

describe('graceful shutdown and temp cleanup', () => {
  test('shutdown drains within the deadline and removes temp files', async () => {
    const dir2 = await mkdtemp(path.join(tmpdir(), 'avif-fb-shutdown-'));
    const local = await createApp({ cacheDir: dir2, backend: 'wasm' });
    await new Promise((resolve) => local.server.listen(0, '127.0.0.1', resolve));
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir2, 'ab'), { recursive: true });
    await writeFile(path.join(dir2, 'ab', 'ab12.9.1.tmp'), 'x');
    const report = await local.shutdown('SIGTERM');
    assert.equal(report.timedOut, false);
    assert.ok(report.tempFilesRemoved >= 1);
    const remaining = await readdir(dir2).catch(() => []);
    assert.ok(!remaining.some((f) => f.endsWith('.tmp')));
    await rm(dir2, { recursive: true, force: true });
  });

  test('shutdown waits for an in-flight request and then closes', async () => {
    const dir3 = await mkdtemp(path.join(tmpdir(), 'avif-fb-drain-'));
    const local = await createApp({ cacheDir: dir3, backend: 'wasm' });
    await new Promise((resolve) => local.server.listen(0, '127.0.0.1', resolve));
    const addr = local.server.address();
    // Start a real decode request, then signal shutdown while it is in flight.
    const inFlight = fetch(`http://127.0.0.1:${addr.port}/decode?format=png`, {
      method: 'POST',
      body: await loadSample('size-2x2.avif'),
    });
    // Give the request a tick to enter the handler before draining.
    await new Promise((r) => setTimeout(r, 5));
    const report = await local.shutdown('SIGTERM');
    const res = await inFlight;
    // The request that started before shutdown is allowed to complete.
    assert.equal(res.status, 200);
    assert.equal(report.timedOut, false);
    assert.equal(report.inFlightAbandoned, 0);
    // After close, a brand-new connection is refused (server really stopped).
    await assert.rejects(() => fetch(`http://127.0.0.1:${addr.port}/health`));
    await rm(dir3, { recursive: true, force: true });
  });

  test('a request explicitly handled while draining gets SERVICE_SHUTDOWN', async () => {
    const dir4 = await mkdtemp(path.join(tmpdir(), 'avif-fb-flag-'));
    const local = await createApp({ cacheDir: dir4, backend: 'wasm' });
    local.state.shuttingDown = true; // simulate the drain flag without closing
    await new Promise((resolve) => local.server.listen(0, '127.0.0.1', resolve));
    const addr = local.server.address();
    const res = await fetch(`http://127.0.0.1:${addr.port}/decode`, {
      method: 'POST',
      body: await loadSample('size-2x2.avif'),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'AVIF_SERVICE_SHUTDOWN');
    const health = await (await fetch(`http://127.0.0.1:${addr.port}/health`)).json();
    assert.equal(health.status, 'draining');
    await local.shutdown('SIGTERM');
    await rm(dir4, { recursive: true, force: true });
  });
});
