/*!
 * Minimal zero-dependency PNG writer for RGBA pixel buffers.
 *
 * Uses zlib "stored" (uncompressed) deflate blocks wrapped in an RFC 1950
 * zlib stream, so pixel bytes round-trip exactly with no encoder heuristics.
 * CRC32 and Adler32 are computed with integer arithmetic only.
 */

import { AvifError, ErrorCode } from './errors.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type, payload) {
  const len = u32(payload.length);
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const body = Uint8Array.from([...typeBytes, ...payload]);
  return Uint8Array.from([...len, ...body, ...u32(crc32(body))]);
}

/**
 * Wrap raw bytes in a zlib stream of stored deflate blocks (max 65535 bytes).
 */
function zlibStored(data) {
  const blocks = [];
  let pos = 0;
  while (pos < data.length || data.length === 0) {
    const remaining = data.length - pos;
    const blockLen = Math.min(remaining, 65535);
    const final = pos + blockLen === data.length ? 1 : 0;
    const header = [
      final, // BFINAL + BTYPE=00
      blockLen & 255,
      (blockLen >> 8) & 255,
      (~blockLen) & 255,
      ((~blockLen) >> 8) & 255,
    ];
    blocks.push(Uint8Array.from(header));
    if (blockLen > 0) blocks.push(data.subarray(pos, pos + blockLen));
    pos += blockLen;
    if (final) break;
  }
  const adler = adler32(data);
  return Uint8Array.from([0x78, 0x01, ...blocks.flatMap((b) => Array.from(b)), ...u32(adler)]);
}

/**
 * @param {Uint8Array} rgba tightly packed row-major RGBA
 * @returns {Uint8Array} complete PNG file bytes
 */
export function encodePng(rgba, width, height) {
  if (rgba.length !== width * height * 4) {
    throw new AvifError(
      ErrorCode.PUBLISH_FAILED,
      `PNG input ${rgba.length} bytes does not match ${width}x${height} RGBA`,
      { details: { actual: rgba.length, expected: width * height * 4 } },
    );
  }
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Uint8Array.from([
    ...u32(width),
    ...u32(height),
    8, // bit depth
    6, // colour type 6 = RGBA
    0,
    0,
    0,
  ]);
  // Filter byte 0 (none) before each scanline.
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }
  const idat = zlibStored(raw);
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Uint8Array.from([])),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
