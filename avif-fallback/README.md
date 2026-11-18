# avif-fallback

A self-contained, offline-capable **AVIF decode fallback pipeline** delivered as
a side-package inside this sharp source tree. It adds a hardened fallback
decode path without modifying sharp's entry points or public behaviour.

## Why this package exists

When the native AVIF backend (sharp/libvips) is unavailable or cannot decode an
image, callers need a path that:

- rejects inconsistent or corrupt input with **stable error codes** and no
  half-finished output,
- decodes with **deterministic pixels** under any concurrency or chunk order,
- preserves orientation, straight alpha and colour semantics,
- publishes results atomically and records the backend actually used,
- never silently downgrades — a fallback is explicit and auditable.

The native and WASM backends are probed independently; the chosen backend is
stamped on every result and on every HTTP response header.

## Module boundaries

| File | Responsibility | May allocate pixels? |
| --- | --- | --- |
| `src/errors.js` | Stable `AvifError` taxonomy (`AVIF_*` codes), frozen details | no |
| `src/constants.js` | `RULES_VERSION`, hard limits, accepted CICP, orientations | no |
| `src/isobmff.js` | Read-only ISOBMFF structural validation and descriptor | **no** |
| `src/backend.js` | Locked WASM decode, mutex, independent buffer copies | yes (one RGBA buffer) |
| `src/capability.js` | Native vs WASM capability probe, frozen/cached result | probe only |
| `src/pixel.js` | Deterministic EXIF orientation, clamping, integer rounding | fresh output buffer |
| `src/png.js` | Zero-dependency RGBA→PNG writer (stored deflate blocks) | output buffer |
| `src/cache.js` | Content-addressed cache, versioned keys, atomic publish | no |
| `src/pipeline.js` | Six-stage orchestration (see below) | yes |
| `src/service.js` | HTTP service, non-blocking health, graceful shutdown | yes |
| `src/index.js` | Public entry; only stable exports | no |

`tools/` holds the **offline sample generator and acceptance harness**. The
ISOBMFF *builder* (`tools/boxes.mjs`) is deliberately kept out of `src/`:
production code can only read and validate containers, never synthesise them.

## Pipeline stages

`pipeline.run(input, options)` executes six stages; nothing is observable to
the caller before the final publish stage, so any failure leaves no partial
result:

1. `inspect` — structural validation, zero pixel allocation.
2. `probe` — select an already-certified backend (else fail closed).
3. `decode` — locked WASM call returning an independent RGBA copy.
4. `cross-check` — decoded geometry must equal the declared `ispe` geometry.
5. `orient` — deterministic integer EXIF transform into a fresh buffer.
6. `encode` + `publish` — build PNG/raw output, then atomically place in cache.

## Coordinate and pixel contract

- Origin `(0,0)` is the **top-left** pixel; `x` grows right, `y` grows down.
- Buffers are tightly packed **row-major RGBA**, stride `= width * 4`, no
  padding. All index math is integer; no floating point participates in
  addressing.
- Alpha is **straight (non-premultiplied)** 0..255. A fully transparent pixel
  keeps its RGB channels; they are never zeroed or expanded.
- Chunked orientation writes each output index exactly once, so reordered or
  parallel band execution produces byte-identical output.

## Entry points

```bash
# Generate every offline fixture deterministically
npm run samples

# Run the 61-test suite
npm test

# Run the acceptance harness (writes acceptance-report.json)
npm run acceptance

# Start the HTTP service (default 127.0.0.1:8790)
npm start
```

Programmatic use:

```js
import { createPipeline, probeCapabilities } from './src/index.js';

const cap = await probeCapabilities();          // { selected: 'wasm', degraded: true, ... }
const result = await createPipeline({ backend: 'wasm' }).run(avifBytes, { format: 'png' });
// result.backend, result.rulesVersion, result.orientation, result.output
```

HTTP:

- `GET /health` — readiness only; never invokes a codec.
- `POST /decode?format=png|rgba` — body is the AVIF byte sequence.
  Response headers include `x-backend`, `x-cache`, `x-rules-version`,
  `x-orientation`. Rejections are JSON with a stable `error.code`.

## Determinism and the cache key

Cache keys are `sha256` over a canonical JSON document containing
`RULES_VERSION`, the input hash, orientation, colour fingerprint, output
format and alpha policy. Bumping `RULES_VERSION` invalidates every prior entry,
and orientation/colour differences never share an entry. Writes go to a unique
temp file then an atomic rename; a crashed write only ever leaves a `*.tmp`
file that startup/shutdown sweeps.

## Locked dependency

The only runtime dependency is pinned exactly:

- `@jsquash/avif@2.1.1` (Apache-2.0), an AVM/AV1 WASM build from the Squoosh
  lineage, with transitive `wasm-feature-detect@1.10.1`.

Both are recorded with integrity hashes in `package-lock.json`. No network is
needed at runtime or test time after install.

## Compatibility-layer boundary

This package does **not** monkey-patch sharp, register globals or touch the
parent `lib/`, `src/` or `test/` trees. It is opt-in: a caller chooses to route
a request here. Importing it has no side effects beyond lazy WASM
initialisation on first decode. See `MIGRATION.md` for the version/dependency
record and `DIAGNOSTICS.md` for the assertion traceability matrix.
