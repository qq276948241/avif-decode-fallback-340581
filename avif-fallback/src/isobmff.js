/*!
 * Read-only ISOBMFF (ISO/IEC 14496-12) structural validator for AVIF.
 *
 * Design contract:
 *  - Never allocates pixel memory; it only walks box headers and reads the
 *    small descriptor boxes (ispe, colr, irot, imir, pitm, iinf).
 *  - Every rejection carries a stable ErrorCode and leaves no partial output:
 *    the parser returns either one immutable descriptor or throws AvifError.
 *  - Pure function over the input Uint8Array: same bytes always yield the same
 *    descriptor regardless of caller concurrency.
 */

import { AvifError, ErrorCode } from './errors.js';
import { ACCEPTED_CICP, LIMITS, SUPPORTED_ORIENTATIONS } from './constants.js';

const BRAND_AVIF = 'avif';
const BRAND_AVIS = 'avis'; // image sequence brand => animation

function readType(view, offset) {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const c = view.getUint8(offset + i);
    s += String.fromCharCode(c);
  }
  return s;
}

function readAscii(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/**
 * Walk every box in [start, end). The visitor receives (type, headerStart,
 * payloadStart, payloadEnd, view). Truncation is checked before every visit.
 */
function walkBoxes(view, start, end, visit, depth = 0) {
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) {
      throw new AvifError(ErrorCode.TRUNCATED_BOX, `box header needs 8 bytes, ${end - offset} remain`);
    }
    const size32 = view.getUint32(offset);
    const type = readType(view, offset + 4);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (end - offset < 16) {
        throw new AvifError(ErrorCode.TRUNCATED_BOX, 'largesize box header truncated');
      }
      const hi = view.getUint32(offset + 8);
      const lo = view.getUint32(offset + 12);
      size = hi * 2 ** 32 + lo;
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset; // box extends to end of buffer
    }
    if (!/^[\x20-\x7e]{4}$/.test(type)) {
      throw new AvifError(ErrorCode.NOT_AVIF, `first box type is not a printable ISOBMFF type at offset ${offset}`);
    }
    if (size < headerSize || offset + size > end) {
      throw new AvifError(ErrorCode.TRUNCATED_BOX, `box "${type}" (size ${size}) exceeds container`);
    }
    const payloadStart = offset + headerSize;
    const payloadEnd = offset + size;
    visit(type, offset, payloadStart, payloadEnd, view, depth);
    offset = payloadEnd;
  }
}

function parseIspe(view, payloadStart, payloadEnd) {
  // Receives the offset AFTER the 4-byte fullbox prefix:
  // image_width(4), image_height(4).
  if (payloadEnd - payloadStart < 8) {
    throw new AvifError(ErrorCode.TRUNCATED_BOX, 'ispe box truncated');
  }
  return {
    width: view.getUint32(payloadStart),
    height: view.getUint32(payloadStart + 4),
  };
}

function parseColr(view, payloadStart, payloadEnd) {
  if (payloadEnd - payloadStart < 4) {
    throw new AvifError(ErrorCode.TRUNCATED_BOX, 'colr box truncated');
  }
  const colourType = readAscii(view, payloadStart, 4);
  if (colourType === 'nclx') {
    // colour_primaries(2), transfer_characteristics(2), matrix_coefficients(2),
    // full_range_flag(1)
    if (payloadEnd - payloadStart < 11) {
      throw new AvifError(ErrorCode.TRUNCATED_BOX, 'nclx colour box truncated');
    }
    const cp = view.getUint16(payloadStart + 4);
    const tc = view.getUint16(payloadStart + 6);
    const mc = view.getUint16(payloadStart + 8);
    const fullRange = (view.getUint8(payloadStart + 10) & 0x80) === 0x80;
    return { colourType, colourPrimaries: cp, transferCharacteristics: tc, matrixCoefficients: mc, fullRange };
  }
  // 'prof' / 'rICC': ICC profile. We accept and pass through; pixel semantics
  // stay RGBA and the descriptor records the profile presence.
  if (colourType === 'prof' || colourType === 'rICC') {
    return { colourType, profileBytes: payloadEnd - (payloadStart + 4) };
  }
  throw new AvifError(
    ErrorCode.COLOUR_SPACE_UNSUPPORTED,
    `unsupported colour type "${colourType}"`,
    { details: { colourType } },
  );
}

function parseIrot(view, payloadStart, payloadEnd) {
  // irot is a NON-full box: single angle byte 0..3 => 0/90/180/270 CW.
  if (payloadEnd - payloadStart < 1) {
    throw new AvifError(ErrorCode.TRUNCATED_BOX, 'irot box truncated');
  }
  const angle = view.getUint8(payloadStart) & 0x03;
  // Map irot angle to EXIF orientation (rotation only, no mirror).
  return [1, 6, 3, 8][angle];
}

function parseImir(view, payloadStart, payloadEnd) {
  // imir is a NON-full box. Per ISO 23008-12: axis 0 = flip about a vertical
  // axis (left-right mirror, EXIF 2); axis 1 = flip about a horizontal axis
  // (top-bottom mirror, EXIF 4).
  if (payloadEnd - payloadStart < 1) {
    throw new AvifError(ErrorCode.TRUNCATED_BOX, 'imir box truncated');
  }
  return view.getUint8(payloadStart) & 0x01;
}

/**
 * Combine an irot angle (EXIF rotation code) and an imir axis into one EXIF
 * orientation. AVIF applies imir before irot per ISO 23008-12.
 */
function combineOrientation(rotation, mirrorAxis) {
  if (mirrorAxis === undefined) return rotation ?? 1;
  // axis 0 -> EXIF 2 (left-right); axis 1 -> EXIF 4 (top-bottom).
  const mirrorBase = mirrorAxis === 0 ? 2 : 4;
  if (rotation === undefined || rotation === 1) return mirrorBase;
  const table = {
    // mirrorBase -> per applied rotation code (6=90CW, 3=180, 8=270CW)
    2: { 6: 5, 3: 4, 8: 7 },
    4: { 6: 7, 3: 2, 8: 5 },
  };
  return table[mirrorBase][rotation];
}

/**
 * Validate and describe an AVIF byte sequence.
 *
 * @param {Uint8Array} bytes
 * @returns {Readonly<object>} immutable structural descriptor
 */
export function inspectAvif(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new AvifError(ErrorCode.INPUT_EMPTY, 'input must be a Uint8Array');
  }
  if (bytes.byteLength === 0) {
    throw new AvifError(ErrorCode.INPUT_EMPTY, 'input is empty');
  }
  if (bytes.byteLength > LIMITS.maxInputBytes) {
    throw new AvifError(
      ErrorCode.INPUT_TOO_LARGE,
      `input ${bytes.byteLength} bytes exceeds limit ${LIMITS.maxInputBytes}`,
      { details: { byteLength: bytes.byteLength, limit: LIMITS.maxInputBytes } },
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let ftypSeen = false;
  let compatibleBrands = [];
  let hasSequenceBrand = false;
  const ispeCandidates = [];
  const colrCandidates = [];
  let irotCode;
  let imirAxis;
  let pitmValue;
  let itemCount = 0;
  let trakCount = 0;
  let moovSeen = false;
  let mdatCount = 0;
  // ipco property order, populated via 'ipco-order' collection, plus the
  // per-item ipma associations used to resolve grid/thumbnail ambiguity.
  const ipmaEntries = [];
  const ipcoPropertyOrder = [];

  walkBoxes(view, 0, bytes.byteLength, (type, hStart, pStart, pEnd) => {
    if (type === 'ftyp') {
      ftypSeen = true;
      if (pEnd - pStart < 8) {
        throw new AvifError(ErrorCode.TRUNCATED_BOX, 'ftyp box truncated');
      }
      const major = readAscii(view, pStart, 4);
      const brandCount = Math.floor((pEnd - pStart - 8) / 4);
      compatibleBrands = [major];
      for (let i = 0; i < brandCount; i++) {
        compatibleBrands.push(readAscii(view, pStart + 8 + i * 4, 4));
      }
      if (compatibleBrands.includes(BRAND_AVIS)) hasSequenceBrand = true;
      if (!compatibleBrands.includes(BRAND_AVIF) && major !== BRAND_AVIF) {
        throw new AvifError(
          ErrorCode.NOT_AVIF,
          `ftyp brands ${compatibleBrands.join(',')} do not include "avif"`,
          { details: { brands: compatibleBrands } },
        );
      }
    } else if (type === 'mdat') {
      mdatCount += 1;
    } else if (type === 'moov') {
      moovSeen = true;
      walkBoxes(view, pStart, pEnd, (innerType, _h, ipStart, ipEnd) => {
        if (innerType === 'trak') trakCount += 1;
        if (innerType === 'udta') {
          walkBoxes(view, ipStart, ipEnd, (t3, _h3, a, b) => {
            if (t3 === 'meta') walkMeta(view, a, b, collect);
          });
        }
      });
    } else if (type === 'meta') {
      walkMeta(view, pStart, pEnd, collect);
    }
  });

  function collect(kind, boxType, payload) {
    if (kind === 'ispe') ispeCandidates.push(parseIspe(view, payload[0], payload[1]));
    else if (kind === 'colr') colrCandidates.push(parseColr(view, payload[0], payload[1]));
    else if (kind === 'irot') irotCode = parseIrot(view, payload[0], payload[1]);
    else if (kind === 'imir') imirAxis = parseImir(view, payload[0], payload[1]);
    else if (kind === 'pitm') pitmValue = payload;
    else if (kind === 'infe') itemCount += 1;
    else if (kind === 'ipma') ipmaEntries.push(payload);
    else if (kind === 'ipco-order') ipcoPropertyOrder.push(payload);
  }

  if (!ftypSeen) {
    throw new AvifError(ErrorCode.NOT_AVIF, 'no ftyp box found before image data');
  }
  if (mdatCount === 0) {
    throw new AvifError(ErrorCode.INVALID_BOX, 'no mdat box: AVIF has no coded image payload');
  }

  // --- frame / animation consistency -------------------------------------
  const animated = hasSequenceBrand || trakCount > 0;
  if (animated) {
    throw new AvifError(
      ErrorCode.ANIMATION_UNSUPPORTED,
      `animated/sequenced AVIF rejected (trak=${trakCount}, sequenceBrand=${hasSequenceBrand}); frame-level decode is not in this module's contract`,
      { details: { trakCount, hasSequenceBrand } },
    );
  }
  if (moovSeen && trakCount === 0) {
    throw new AvifError(ErrorCode.INVALID_BOX, 'moov present without any trak: inconsistent frame structure');
  }

  // --- dimensions ----------------------------------------------------------
  if (ispeCandidates.length === 0) {
    throw new AvifError(ErrorCode.DIMENSION_MISMATCH, 'no ispe box: spatial extent unknown');
  }

  // Multiple ispe boxes are legal when they describe different items (e.g. a
  // grid thumbnail plus the primary item). Resolve the authoritative extent via
  // the primary item's (pitm) ipma associations; ispe order inside ipco matches
  // the 1-based property indices. Only treat differing extents as a conflict
  // when they cannot be attributed to distinct items.
  let width;
  let height;
  const primaryId = pitmValue ?? ipmaEntries[0]?.itemId;
  const primaryAssoc = ipmaEntries.find((e) => e.itemId === primaryId);
  if (primaryAssoc && ispeCandidates.length > 1) {
    // ipcoPropertyOrder records every ipco child type in 1-based order. Build
    // a map from property index -> ispe candidate ordinal.
    const propertyIndexToIspeOrdinal = new Map();
    let ispeOrdinal = -1;
    ipcoPropertyOrder.forEach((type, i) => {
      if (type === 'ispe') {
        ispeOrdinal += 1;
        propertyIndexToIspeOrdinal.set(i + 1, ispeOrdinal);
      }
    });
    // All ispe boxes associated with the SAME primary item must agree; two
    // different extents on one item are a genuine conflict. Distinct items
    // (grid thumbnails) are legal and simply not selected here.
    const primaryIspe = primaryAssoc.indices
      .filter((propertyIndex) => propertyIndexToIspeOrdinal.has(propertyIndex))
      .map((propertyIndex) => ispeCandidates[propertyIndexToIspeOrdinal.get(propertyIndex)]);
    if (primaryIspe.length > 1) {
      const first = primaryIspe[0];
      for (const d of primaryIspe.slice(1)) {
        if (d.width !== first.width || d.height !== first.height) {
          throw new AvifError(
            ErrorCode.DIMENSION_MISMATCH,
            `conflicting ispe extents on primary item ${primaryId}: ${first.width}x${first.height} vs ${d.width}x${d.height}`,
            { details: { primaryId, extents: primaryIspe } },
          );
        }
      }
    }
    const chosen = primaryIspe[0] ?? ispeCandidates[0];
    ({ width, height } = chosen);
  } else {
    const first = ispeCandidates[0];
    for (const d of ispeCandidates) {
      if (d.width !== first.width || d.height !== first.height) {
        throw new AvifError(
          ErrorCode.DIMENSION_MISMATCH,
          `conflicting ispe extents on a single item: ${first.width}x${first.height} vs ${d.width}x${d.height}`,
          { details: { extents: ispeCandidates } },
        );
      }
    }
    ({ width, height } = first);
  }
  if (width === 0 || height === 0) {
    throw new AvifError(ErrorCode.DIMENSION_UNSUPPORTED, `zero dimension ${width}x${height}`, {
      details: { width, height },
    });
  }
  if (width > LIMITS.maxWidth || height > LIMITS.maxHeight) {
    throw new AvifError(
      ErrorCode.DIMENSION_UNSUPPORTED,
      `dimension ${width}x${height} exceeds ${LIMITS.maxWidth}x${LIMITS.maxHeight}`,
      { details: { width, height, maxWidth: LIMITS.maxWidth, maxHeight: LIMITS.maxHeight } },
    );
  }
  const pixels = width * height;
  if (pixels > LIMITS.maxPixels) {
    throw new AvifError(
      ErrorCode.MEMORY_LIMIT,
      `pixel count ${pixels} exceeds ${LIMITS.maxPixels}`,
      { details: { pixels, maxPixels: LIMITS.maxPixels } },
    );
  }

  // --- colour --------------------------------------------------------------
  let colour = { colourType: 'none' };
  if (colrCandidates.length > 0) {
    colour = colrCandidates[0];
    if (colour.colourType === 'nclx') {
      const accepted = ACCEPTED_CICP.some(
        ([cp, tc, mc]) =>
          cp === colour.colourPrimaries &&
          tc === colour.transferCharacteristics &&
          mc === colour.matrixCoefficients,
      );
      if (!accepted) {
        throw new AvifError(
          ErrorCode.COLOUR_SPACE_UNSUPPORTED,
          `CICP ${colour.colourPrimaries}/${colour.transferCharacteristics}/${colour.matrixCoefficients} is not in the accepted sRGB set`,
          {
            details: {
              colourPrimaries: colour.colourPrimaries,
              transferCharacteristics: colour.transferCharacteristics,
              matrixCoefficients: colour.matrixCoefficients,
            },
          },
        );
      }
    }
  }

  // --- orientation ---------------------------------------------------------
  const orientation = combineOrientation(irotCode, imirAxis);
  if (!SUPPORTED_ORIENTATIONS.has(orientation)) {
    throw new AvifError(ErrorCode.ORIENTATION_INVALID, `derived orientation ${orientation} is outside 1..8`, {
      details: { orientation },
    });
  }

  return Object.freeze({
    brands: Object.freeze(compatibleBrands),
    width,
    height,
    pixels,
    colour: Object.freeze(colour),
    orientation,
    hasTransform: orientation !== 1 || imirAxis !== undefined || irotCode !== undefined,
    primaryItem: pitmValue ?? 0,
    itemCount,
    trakCount,
    animated,
    mdatCount,
    byteLength: bytes.byteLength,
  });
}

/** Walk a meta box (handles both top-level and item-level locations). */
function walkMeta(view, payloadStart, payloadEnd, collect) {
  // meta is a fullbox: 4 bytes version/flags precede child boxes
  const childStart = payloadStart + 4;
  if (childStart > payloadEnd) {
    throw new AvifError(ErrorCode.TRUNCATED_BOX, 'meta fullbox header truncated');
  }
  walkBoxes(view, childStart, payloadEnd, (type, _h, rawStart, pEnd, _v, depth) => {
    // walkBoxes gives rawStart = offset right after the 8-byte box header.
    // For full boxes, rawStart..+4 is the version/flags prefix and the real
    // payload begins at rawStart+4 (== pStart).
    const FULL = type === 'iinf' || type === 'pitm' || type === 'ipma';
    const pStart = rawStart + (FULL ? 4 : 0);
    if (type === 'iprp') {
      walkBoxes(view, rawStart, pEnd, (t2, _h2, a2, b2) => {
        if (t2 === 'ipco') {
          walkBoxes(view, a2, b2, (t3, _h3, a3, b3) => {
            collect('ipco-order', t3, t3);
            // a3 is post-box-header; ispe is full, so its width/height start
            // after another 4-byte prefix. irot/imir/colr are non-full.
            if (t3 === 'ispe') collect('ispe', t3, [a3 + 4, b3]);
            else if (t3 === 'colr') collect('colr', t3, [a3, b3]);
            else if (t3 === 'irot') collect('irot', t3, [a3, b3]);
            else if (t3 === 'imir') collect('imir', t3, [a3, b3]);
          });
        } else if (t2 === 'ipma') {
          // a2 is post-box-header; ipma is a full box so its real payload
          // starts 4 bytes later.
          parseIpma(view, a2, a2 + 4, b2, collect);
        }
      });
    } else if (type === 'iinf') {
      // pStart = real payload. v0: entry_count(2); v1: entry_count(4).
      const version = view.getUint8(rawStart);
      let p;
      if (version === 0) {
        if (pEnd - pStart < 2) throw new AvifError(ErrorCode.TRUNCATED_BOX, 'iinf header truncated');
        p = pStart + 2;
      } else {
        if (pEnd - pStart < 4) throw new AvifError(ErrorCode.TRUNCATED_BOX, 'iinf v1 header truncated');
        p = pStart + 4;
      }
      while (p < pEnd) {
        if (pEnd - p < 8) throw new AvifError(ErrorCode.TRUNCATED_BOX, 'iinf entry truncated');
        const entrySize = view.getUint32(p);
        const entryType = readType(view, p + 4);
        if (entrySize < 8 || p + entrySize > pEnd) {
          throw new AvifError(ErrorCode.TRUNCATED_BOX, 'infe entry exceeds iinf container');
        }
        if (entryType === 'infe') collect('infe', entryType, null);
        p += entrySize;
      }
    } else if (type === 'pitm') {
      const version = view.getUint8(rawStart);
      const id = version === 0 ? view.getUint16(pStart) : view.getUint32(pStart);
      collect('pitm', type, id);
    }
    void depth;
  });
}

/**
 * Parse ipma associations so we can tell which ipco properties belong to the
 * primary item. `pStart` points at the payload AFTER the fullbox version/flags
 * prefix. v0 uses 1-byte property indices; v1 uses 2-byte. The high bit marks
 * an essential property.
 */
/**
 * Parse ipma associations.
 * @param rawStart offset right after the 8-byte box header (fullbox prefix here)
 * @param pStart   offset of the real payload, after the 4-byte version/flags
 */
function parseIpma(view, rawStart, pStart, pEnd, collect) {
  const version = view.getUint8(rawStart);
  const entryCount = view.getUint32(pStart);
  let p = pStart + 4;
  for (let entry = 0; entry < entryCount; entry++) {
    if (p + 4 > pEnd) throw new AvifError(ErrorCode.TRUNCATED_BOX, 'ipma entry truncated');
    const itemId = version < 1 ? view.getUint16(p) : view.getUint32(p);
    p += version < 1 ? 2 : 4;
    const assocCount = view.getUint8(p);
    p += 1;
    const indices = [];
    for (let a = 0; a < assocCount; a++) {
      if (version < 1) {
        if (p + 1 > pEnd) throw new AvifError(ErrorCode.TRUNCATED_BOX, 'ipma association truncated');
        indices.push(view.getUint8(p) & 0x7f);
        p += 1;
      } else {
        if (p + 2 > pEnd) throw new AvifError(ErrorCode.TRUNCATED_BOX, 'ipma association truncated');
        indices.push(view.getUint16(p) & 0x7fff);
        p += 2;
      }
    }
    collect('ipma', 'ipma', { itemId, indices });
  }
}
