/*!
 * Shared test helpers: sample loading and manifest access.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const samplesDir = path.join(here, '..', 'samples');

export async function loadSample(name) {
  return new Uint8Array(await readFile(path.join(samplesDir, name)));
}

export async function loadManifest() {
  return JSON.parse(await readFile(path.join(samplesDir, 'manifest.json'), 'utf8'));
}

export function findInManifest(manifest, file) {
  return manifest.samples.find((s) => s.file === file);
}
