/*!
 * HTTP service fronting the fallback pipeline.
 *
 * Operational guarantees:
 *  - GET /health never runs a codec: it reports cached probe state and queue
 *    depth, so a slow/synchronous decode cannot stall health checks.
 *  - Decode requests enter a bounded queue; when the queue is full or the
 *    server is draining they fail fast with SERVICE_SHUTDOWN.
 *  - SIGTERM/SIGINT start a graceful drain with a deadline: stop accepting,
 *    wait for in-flight jobs up to SHUTDOWN_TIMEOUT_MS, then close. Temp cache
 *    files are swept on startup and shutdown.
 */

import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FileResultCache } from './cache.js';
import { RULES_VERSION } from './constants.js';
import { AvifError, ErrorCode } from './errors.js';
import { createPipeline } from './pipeline.js';
import { probeCapabilities } from './capability.js';

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 5000);
const MAX_QUEUE_DEPTH = Number(process.env.MAX_QUEUE_DEPTH ?? 16);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 64 * 1024 * 1024);

export async function createApp(options = {}) {
  const cacheDir = options.cacheDir ?? path.join(tmpdir(), `avif-fallback-${process.pid}`);
  const cache = new FileResultCache(cacheDir);
  await cache.cleanupTemp();
  const pipeline = createPipeline({ cache, backend: options.backend ?? 'auto' });

  const state = {
    startedAt: new Date().toISOString(),
    shuttingDown: false,
    inFlight: 0,
    queued: 0,
    accepted: 0,
    rejected: 0,
  };
  let capability = null;
  try {
    capability = await probeCapabilities();
  } catch (err) {
    capability = { selected: null, error: err.toJSON ? err.toJSON() : { message: String(err) } };
  }

  function json(res, status, body) {
    const payload = JSON.stringify(body);
    // Connection: close keeps the socket lifecycle explicit: every response
    // terminates its connection, which makes graceful shutdown deterministic
    // and leaves no idle keep-alive handles keeping the process alive.
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      connection: 'close',
    });
    res.end(payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new AvifError(ErrorCode.INPUT_TOO_LARGE, `body exceeds ${MAX_BODY_BYTES} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks, size)));
      req.on('error', reject);
    });
  }

  const activeConnections = new Set();
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      // Deliberately no codec call on this path.
      json(res, 200, {
        status: state.shuttingDown ? 'draining' : 'ok',
        rulesVersion: RULES_VERSION,
        backend: capability?.selected ?? 'none',
        degraded: capability?.degraded ?? false,
        queueDepth: state.queued,
        inFlight: state.inFlight,
        uptimeMs: Date.now() - Date.parse(state.startedAt),
      });
      return;
    }

    if (req.method === 'POST' && (req.url === '/decode' || req.url.startsWith('/decode?'))) {
      if (state.shuttingDown) {
        state.rejected += 1;
        json(res, 503, { error: { code: ErrorCode.SERVICE_SHUTDOWN, message: 'service is draining' } });
        return;
      }
      if (state.queued >= MAX_QUEUE_DEPTH) {
        state.rejected += 1;
        json(res, 503, { error: { code: ErrorCode.SERVICE_SHUTDOWN, message: 'queue saturated' } });
        return;
      }
      state.queued += 1;
      try {
        const body = await readBody(req);
        state.queued -= 1;
        state.inFlight += 1;
        const wantPng = req.url.includes('format=png') || !req.url.includes('format=rgba');
        const result = await pipeline.run(body, { format: wantPng ? 'png' : 'rgba' });
        state.accepted += 1;
        res.writeHead(200, {
          'content-type': wantPng ? 'image/png' : 'application/octet-stream',
          'x-job-id': result.jobId,
          'x-backend': result.backend,
          'x-cache': result.cached ? 'hit' : 'miss',
          'x-rules-version': RULES_VERSION,
          'x-orientation': String(result.orientation),
          connection: 'close',
        });
        res.end(Buffer.from(result.output));
      } catch (err) {
        state.rejected += 1;
        const avif = err instanceof AvifError ? err : new AvifError(ErrorCode.DECODE_FAILED, err.message, { cause: err });
        json(res, avif.quality === 'fail-closed' ? 502 : 422, { error: avif.toJSON() });
      } finally {
        state.inFlight = Math.max(0, state.inFlight - 1);
      }
      return;
    }

    json(res, 404, { error: { code: 'NOT_FOUND', message: `${req.method} ${req.url}` } });
  });

  // Track every socket so a graceful shutdown can end idle keep-alive
  // connections (which would otherwise keep server.close() pending forever).
  server.on('connection', (socket) => {
    activeConnections.add(socket);
    socket.on('close', () => activeConnections.delete(socket));
  });

  async function shutdown(signal) {
    if (state.shuttingDown) return undefined;
    state.shuttingDown = true;
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    // Stop accepting new connections immediately.
    server.close(() => {});
    // Wait for in-flight work, bounded by the deadline.
    while (state.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const timedOut = state.inFlight > 0;
    // Close any socket still open (idle keep-alive included) so the server can
    // actually stop and the process is free to exit.
    for (const socket of activeConnections) socket.destroy();
    activeConnections.clear();
    const swept = await cache.cleanupTemp();
    return { signal, timedOut, inFlightAbandoned: state.inFlight, tempFilesRemoved: swept, stats: { ...state } };
  }

  return { server, shutdown, state, cache, getCapability: () => capability };
}

// Startable directly: node src/service.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8790);
  const app = await createApp();
  app.server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({ event: 'listening', port, pid: process.pid, rulesVersion: RULES_VERSION }));
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      const report = await app.shutdown(signal);
      console.log(JSON.stringify({ event: 'shutdown', ...report }));
      process.exit(report.timedOut ? 1 : 0);
    });
  }
}
