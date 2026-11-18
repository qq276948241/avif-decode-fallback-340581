/*!
 * Minimal ISOBMFF box builder used ONLY by the offline sample generator.
 * Kept separate from src/ (which is strictly read-only/validation) so that
 * production code can never synthesise or rewrite container boxes.
 *
 * The property injector works on a parsed box tree, not byte splicing:
 *   1. parse every box into {type, payload, children, isFullBox}
 *   2. insert irot/imir into the first ipco and add an essential ipma
 *      association for the primary item
 *   3. re-serialize and rebuild iloc absolute file offsets from a global
 *      position map, so every coded-extent pointer stays valid
 */

export function box(type, payload = new Uint8Array(0)) {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

export function fullBox(type, version, flags, payload = new Uint8Array(0)) {
  const head = new Uint8Array(4 + payload.length);
  head[0] = version;
  head[1] = (flags >> 16) & 255;
  head[2] = (flags >> 8) & 255;
  head[3] = flags & 255;
  head.set(payload, 4);
  return box(type, head);
}

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function ascii(text) {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
}

export function ftyp(brands = ['avif', 'mif1', 'miaf']) {
  const payload = new Uint8Array(4 + 4 + brands.length * 4);
  payload.set(ascii('avif'), 0);
  new DataView(payload.buffer).setUint32(4, 0);
  brands.forEach((b, i) => payload.set(ascii(b), 8 + i * 4));
  return box('ftyp', payload);
}

/** irot is a NON-full box: 1-byte angle 0..3 = 0/90/180/270 clockwise. */
export function irot(angle) {
  return box('irot', Uint8Array.from([angle & 3]));
}

/** imir is a NON-full box: axis 0 = left-right mirror, 1 = top-bottom. */
export function imir(axis) {
  return box('imir', Uint8Array.from([axis & 1]));
}

export function ispe(width, height) {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  return fullBox('ispe', 0, 0, payload);
}

export function nclx(cp = 1, tc = 13, mc = 6, fullRange = true) {
  const payload = new Uint8Array(7);
  const view = new DataView(payload.buffer);
  view.setUint16(0, cp);
  view.setUint16(2, tc);
  view.setUint16(4, mc);
  payload[6] = fullRange ? 0x80 : 0;
  return box('colr', concat(ascii('nclx'), payload));
}

// ---------------------------------------------------------------------------
// Box-tree parser (generator-only)
// ---------------------------------------------------------------------------

const FULL_BOXES = new Set(['meta', 'iinf', 'infe', 'ipma', 'pitm', 'iloc', 'hdlr', 'tkhd', 'ispe']);
// iinf is a full box whose payload is infe *entries*, not recursively nested
// boxes, so it is intentionally absent from CONTAINER_BOXES and kept as a leaf.
const CONTAINER_BOXES = new Set(['meta', 'iprp', 'ipco', 'moov', 'trak', 'mdia', 'minf', 'stbl']);

function typeAt(bytes, offset) {
  return String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
}

function parseTree(bytes, start, end) {
  const nodes = [];
  let off = start;
  while (off + 8 <= end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(off);
    if (size < 8 || off + size > end) {
      throw new Error(`bad box size ${size} at ${off} while building samples`);
    }
    const type = typeAt(bytes, off);
    const isFull = FULL_BOXES.has(type);
    const header = 8;
    const payloadStart = off + header + (isFull ? 4 : 0);
    // rawPayload always starts right after the 8-byte box header, so for full
    // boxes it includes the 4-byte version/flags prefix. fullPrefix records it
    // explicitly so callers can index payload fields past it.
    const node = {
      type,
      start: off,
      size,
      isFull,
      fullPrefix: isFull ? bytes.subarray(off + header, off + header + 4) : new Uint8Array(0),
      rawPayload: bytes.subarray(off + header, off + size),
      children: [],
    };
    if (CONTAINER_BOXES.has(type)) {
      node.children = parseTree(bytes, payloadStart, off + size);
    }
    nodes.push(node);
    off += size;
  }
  return nodes;
}

function findNode(nodes, type) {
  for (const n of nodes) {
    if (n.type === type) return n;
    const child = findNode(n.children, type);
    if (child) return child;
  }
  return undefined;
}

function findAll(nodes, type, acc = []) {
  for (const n of nodes) {
    if (n.type === type) acc.push(n);
    findAll(n.children, type, acc);
  }
  return acc;
}

/**
 * Inject one or more property boxes and wire them to the primary item via ipma.
 * Returns a new Uint8Array with consistent box sizes and iloc offsets.
 */
export function injectProperties(avifBytes, propertyBoxes) {
  const tree = parseTree(avifBytes, 0, avifBytes.length);
  const meta = findNode(tree, 'meta');
  if (!meta) throw new Error('no meta box; cannot inject properties');
  const iprp = findNode(meta.children, 'iprp');
  const ipco = findNode(iprp.children, 'ipco');
  const ipma = findNode(iprp.children, 'ipma');

  // Existing property count in ipco determines the new 1-based indices.
  const baseIndex = ipco.children.length;
  const added = propertyBoxes.map((raw, i) => {
    const inner = parseTree(raw, 0, raw.length)[0];
    ipco.children.push(inner);
    return { node: inner, index: baseIndex + i + 1 };
  });

  // ipma is a full box: rawPayload = version/flags(4) + body.
  // Body layout: entry_count(4) | item_ID(2) | association_count(1) |
  //              association bytes (v0: 1 byte each, high bit = essential).
  // Append essential associations for the new properties; entry_count and
  // item_ID stay untouched.
  const prefix = ipma.fullPrefix.length; // 4
  const firstEntry = ipma.rawPayload;
  const assocCountOffset = prefix + 4 + 2; // past version/flags, count, item_ID
  const assocCount = firstEntry[assocCountOffset];
  const extra = added.map((a) => 0x80 | a.index);
  const insertAt = assocCountOffset + 1 + assocCount;
  const newPayload = new Uint8Array(firstEntry.length + extra.length);
  newPayload.set(firstEntry.subarray(0, insertAt), 0);
  newPayload.set(Uint8Array.from(extra), insertAt);
  newPayload.set(firstEntry.subarray(insertAt), insertAt + extra.length);
  newPayload[assocCountOffset] = assocCount + extra.length;
  ipma.rawPayload = newPayload;

  // Re-serialize, then rebuild iloc absolute offsets.
  const bytes = serializeTree(tree);
  return rebuildIlocOffsets(bytes, avifBytes);
}

function serializeTree(nodes) {
  const parts = [];
  for (const node of nodes) {
    const isFull = FULL_BOXES.has(node.type);
    let body;
    if (CONTAINER_BOXES.has(node.type)) {
      const childBytes = serializeTree(node.children);
      body = isFull ? concat(Uint8Array.from([0, 0, 0, 0]), childBytes) : childBytes;
    } else {
      // rawPayload already includes any fullbox version/flags prefix.
      body = node.rawPayload;
    }
    parts.push(box(node.type, body));
  }
  return concat(...parts);
}

/**
 * iloc extents in these files use absolute file offsets. Re-point every
 * extent by matching the original mdat payload position: the coded bytes are
 * preserved verbatim, so oldOffset -> newOffset via a shift computed from mdat.
 */
function rebuildIlocOffsets(newBytes, oldBytes) {
  // iloc extent offsets in these files are absolute file positions (item 2's
  // single extent equals the mdat payload start). Shift every extent by the
  // change in the mdat PAYLOAD position — that is the exact displacement of
  // every coded byte.
  const oldMdatPayload = locateMdatPayload(oldBytes);
  const newMdatPayload = locateMdatPayload(newBytes);
  const shift = newMdatPayload - oldMdatPayload;
  if (shift === 0) return newBytes;

  const out = new Uint8Array(newBytes);
  const view = new DataView(out.buffer);
  const iloc = locateBox(out, 'iloc');
  if (!iloc) throw new Error('iloc not found after serialization');
  const p = iloc.payload; // points at fullbox payload
  const offsetSize = out[p] >> 4;
  const lengthSize = out[p] & 0x0f;
  const baseOffsetSize = out[p + 1] >> 4;
  const indexSize = out[p + 1] & 0x0f;
  const itemCount = view.getUint16(p + 2);
  let q = p + 4;
  for (let it = 0; it < itemCount; it++) {
    q += 2; // item_ID
    q += 2; // data_reference_index
    q += baseOffsetSize;
    const extentCount = view.getUint16(q);
    q += 2;
    for (let e = 0; e < extentCount; e++) {
      q += indexSize;
      if (offsetSize === 4) {
        view.setUint32(q, view.getUint32(q) + shift);
      }
      q += offsetSize + lengthSize;
    }
  }
  return out;
}

function locateBox(bytes, type) {
  const walk = (start, end) => {
    let off = start;
    while (off + 8 <= end) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const size = view.getUint32(off);
      const t = typeAt(bytes, off);
      if (t === type) return { start: off, payload: off + 8 + (FULL_BOXES.has(t) ? 4 : 0), size };
      if (CONTAINER_BOXES.has(t)) {
        const found = walk(off + 8 + (FULL_BOXES.has(t) ? 4 : 0), off + size);
        if (found) return found;
      }
      off += size;
    }
    return undefined;
  };
  return walk(0, bytes.length);
}

function locateMdatPayload(bytes) {
  const mdat = locateBox(bytes, 'mdat');
  if (!mdat) throw new Error('mdat not found');
  return mdat.start + 8;
}

/**
 * Rewrite an existing property box's payload in place (no length change).
 * Used for colour/dimension tampering where byte offsets must stay identical.
 */
export function mutateFirstProperty(avifBytes, type, newPayload) {
  const tree = parseTree(avifBytes, 0, avifBytes.length);
  const ipco = findNode(findNode(findNode(tree, 'meta').children, 'iprp').children, 'ipco');
  const target = ipco.children.find((n) => n.type === type);
  if (!target) throw new Error(`property ${type} not found`);
  if (target.rawPayload.length !== newPayload.length) {
    throw new Error(`in-place mutation requires equal length (${target.rawPayload.length} vs ${newPayload.length})`);
  }
  target.rawPayload = newPayload;
  // Same length everywhere => offsets unchanged; plain re-serialize is safe.
  return serializeTree(tree);
}

/** Append a moov/trak skeleton so the parser rejects the sequence signal. */
export function withSequenceBrand(avifBytes) {
  const tkhd = fullBox('tkhd', 0, 7, new Uint8Array(80));
  const mdia = box('mdia', box('minf', box('stbl', box('stsd'))));
  const trak = box('trak', concat(tkhd, mdia));
  const moov = box('moov', trak);
  return concat(avifBytes, moov);
}

/**
 * Append a SECOND ispe with different extents (equal-length box) AND associate
 * it with the primary item, so the validator observes two conflicting spatial
 * extents on the SAME item (a genuine error, not a legal grid/thumbnail).
 */
export function addConflictingIspe(avifBytes, width, height) {
  const tree = parseTree(avifBytes, 0, avifBytes.length);
  const meta = findNode(tree, 'meta');
  const iprp = findNode(meta.children, 'iprp');
  const ipco = findNode(iprp.children, 'ipco');
  const ipma = findNode(iprp.children, 'ipma');
  const first = ipco.children.find((n) => n.type === 'ispe');
  if (!first) throw new Error('ispe not found');
  const payload = new Uint8Array(first.rawPayload);
  new DataView(payload.buffer).setUint32(4, width);
  new DataView(payload.buffer).setUint32(8, height);
  const newIndex = ipco.children.length + 1;
  ipco.children.push({ type: 'ispe', isFull: true, fullPrefix: first.fullPrefix.slice(), rawPayload: payload, children: [] });

  // Associate the new ispe (non-essential, high bit clear) with the FIRST
  // ipma entry (the primary item). rawPayload includes the 4-byte fullbox
  // prefix; body layout is entry_count(4) item_ID(2) assoc_count(1), so the
  // association count sits at relative offset 4+4+2 = 10.
  const entry = ipma.rawPayload;
  const assocCountOffset = 10;
  const assocCount = entry[assocCountOffset];
  const insertAt = assocCountOffset + 1 + assocCount;
  const grown = new Uint8Array(entry.length + 1);
  grown.set(entry.subarray(0, insertAt), 0);
  grown[insertAt] = newIndex & 0x7f; // non-essential, 1-byte v0 index
  grown.set(entry.subarray(insertAt), insertAt + 1);
  grown[assocCountOffset] = assocCount + 1;
  ipma.rawPayload = grown;

  const bytes = serializeTree(tree);
  return rebuildIlocOffsets(bytes, avifBytes);
}

/**
 * Overwrite the ispe width/height in place (equal length, so every file offset
 * and iloc pointer stays valid). Used to craft dimension-limit fixtures.
 */
export function tamperIspe(avifBytes, width, height) {
  const tree = parseTree(avifBytes, 0, avifBytes.length);
  const ipco = findNode(findNode(findNode(tree, 'meta').children, 'iprp').children, 'ipco');
  const target = ipco.children.find((n) => n.type === 'ispe');
  if (!target) throw new Error('ispe not found');
  const payload = new Uint8Array(target.rawPayload);
  const view = new DataView(payload.buffer);
  view.setUint32(4, width); // 4-byte fullbox prefix precedes width/height
  view.setUint32(8, height);
  target.rawPayload = payload;
  return serializeTree(tree);
}

/**
 * Overwrite the nclx CICP triple in place (equal length). Used to craft a
 * colour-space rejection fixture without disturbing coded data or offsets.
 */
export function tamperNclx(avifBytes, cp, tc, mc, fullRange = false) {
  const tree = parseTree(avifBytes, 0, avifBytes.length);
  const ipco = findNode(findNode(findNode(tree, 'meta').children, 'iprp').children, 'ipco');
  const target = ipco.children.find((n) => n.type === 'colr');
  if (!target) throw new Error('colr not found');
  const payload = new Uint8Array(target.rawPayload);
  const view = new DataView(payload.buffer);
  // layout: 'nclx'(4) + cp(2) + tc(2) + mc(2) + range(1)
  view.setUint16(4, cp);
  view.setUint16(6, tc);
  view.setUint16(8, mc);
  payload[10] = fullRange ? 0x80 : 0;
  target.rawPayload = payload;
  return serializeTree(tree);
}
