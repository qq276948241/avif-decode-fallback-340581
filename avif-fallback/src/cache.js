/*!
 * Content-addressed result cache with explicit, auditable keys.
 *
 * Key composition (order is fixed and serialised canonically):
 *   RULES_VERSION | sha256(input) | orientation | colour fingerprint |
 *   output format | alpha policy
 *
 * A pixel-rule change bumps RULES_VERSION and therefore cannot collide with a
 * previously cached render. Colour and orientation parameters are part of the
 * key, so two requests that differ only in irot/imir or CICP handling never
 * share an entry.
 *
 * Storage: temp file + fsync + atomic rename. A crashed write can only leave
 * a *.tmp file behind; readers never observe half-published output.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RULES_VERSION } from './constants.js';

export function buildCacheKey(input, params) {
  const hash = createHash('sha256').update(input).digest('hex');
  const canonical = JSON.stringify({
    v: RULES_VERSION,
    input: hash,
    orientation: params.orientation,
    colour: params.colourFingerprint,
    format: params.format,
    alphaPolicy: params.alphaPolicy ?? 'straight',
  });
  return { hash, key: createHash('sha256').update(canonical).digest('hex'), canonical };
}

export class FileResultCache {
  static counter = 0;

  constructor(directory) {
    this.directory = directory;
    this.hits = 0;
    this.misses = 0;
  }

  entryPath(key) {
    // Two-level sharding avoids huge flat directories.
    return path.join(this.directory, key.slice(0, 2), `${key}.bin`);
  }

  tmpPath(key) {
    // Monotonic counter plus randomness guarantees a unique temp name even for
    // many concurrent writes landing in the same millisecond.
    FileResultCache.counter += 1;
    const nonce = `${process.pid}.${Date.now()}.${FileResultCache.counter}.${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    return path.join(this.directory, key.slice(0, 2), `${key}.${nonce}.tmp`);
  }

  async get(key) {
    try {
      const data = await readFile(this.entryPath(key));
      this.hits += 1;
      return data;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.misses += 1;
      return undefined;
    }
  }

  /**
   * Atomic publish. The temp file is fully written before rename, which is
   * atomic on POSIX. Concurrent writers of the same key race safely: a loser
   * sees EEXIST/ENOTEMPTY and discards its temp file, so readers never observe
   * a partial result. An ENOENT (another writer swept temp files concurrently)
   * is retried once after re-creating the shard directory.
   */
  async set(key, payload) {
    const dir = path.join(this.directory, key.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const tmp = this.tmpPath(key);
    await writeFile(tmp, payload);
    try {
      await rename(tmp, this.entryPath(key));
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') {
        await rm(tmp, { force: true }); // another writer published first
        return;
      }
      if (err.code === 'ENOENT') {
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, payload);
        try {
          await rename(tmp, this.entryPath(key));
          return;
        } catch (retryErr) {
          await rm(tmp, { force: true });
          if (retryErr.code !== 'EEXIST' && retryErr.code !== 'ENOTEMPTY') throw retryErr;
          return;
        }
      }
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async cleanupTemp() {
    // Best-effort sweep of *.tmp leftovers, used on startup and shutdown.
    const { readdir } = await import('node:fs/promises');
    let removed = 0;
    let entries = [];
    try {
      entries = await readdir(this.directory);
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
    for (const shard of entries) {
      const shardDir = path.join(this.directory, shard);
      let files = [];
      try {
        files = await readdir(shardDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.endsWith('.tmp')) {
          await rm(path.join(shardDir, f), { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }

  stats() {
    return { hits: this.hits, misses: this.misses };
  }
}
