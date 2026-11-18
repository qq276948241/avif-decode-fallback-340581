# Diagnostics and assertion traceability

Every required scenario is backed by a real assertion against real processing
(no pre-generated logs). This matrix maps each delivery requirement to the
sample, the function under test and the test that proves it. Run
`npm run acceptance` to regenerate `acceptance-report.json`; the summary is
stable across repeated runs.

## Requirement → sample → function → test

| Requirement | Sample / input | Production function | Test (file → test name) |
| --- | --- | --- | --- |
| Boundary sizes (1×1 … 256×128) | `samples/size-*.avif` | `pipeline.run` → `backend.decodeRgba` | `test/pixel.test.mjs` → "decodes WxH to the exact painted pixels" |
| Bit-exact decode | `size-*`, `alpha-zones` | `pixel` hash vs painter | same tests compare `sha256(output)` to `expectedRgbaSha256` |
| Rotation (90/180/270) | `orient-3/6/8-*.avif` | `pixel.applyOrientation` map 3/6/8 | `pixel.test.mjs` → "orientation N produces a self-consistent bijection", "all orientation fixtures decode…" |
| Mirror / mirror+rotate | `orient-2/4/5-*.avif` | `isobmff.combineOrientation`, `applyOrientation` | same suite, codes 2/4/5 |
| Transparent pixels / alpha semantics | `alpha-zones.avif` | straight alpha carried unchanged | `pixel.test.mjs` → "straight alpha 0/128/255 zones survive decode untouched" |
| Repeated submission / cache hit | `size-33x17.avif` | `cache.FileResultCache`, `pipeline` | `cache.test.mjs` → "repeating the same job returns a cache hit…" |
| Concurrent race (same input) | `size-256x128.avif` | `backend` mutex + independent copies | `concurrency.test.mjs` → "parallel decodes…converge on one hash" |
| Concurrent distinct inputs | `size-2x2`, `size-33x17` | fresh per-call buffers | "concurrent decodes of distinct inputs keep independent buffers" |
| Chunk/order independence | synthetic 130×70 grid | `applyOrientation` band visitor | "orientation output is independent of band scheduling" |
| Parallel cache writers | `alpha-zones.avif` | `cache.set` atomic rename | "parallel writers of one cache key converge without partial files" |
| Corrupt: truncated box | `corrupt-truncated.avif` | `isobmff.walkBoxes` | `validation.test.mjs` → "rejects each negative fixture…"; `concurrency` loop |
| Corrupt: fatal byte flip | `corrupt-byteflip.avif` | `backend` WASM decode | `concurrency.test.mjs` → "byte-flipped image…fails at decode" (`AVIF_DECODE_FAILED`) |
| Corrupt: ftyp only / not AVIF | `corrupt-ftyp-only.avif`, `corrupt-not-avif.png` | `isobmff` brand/box checks | validation negative-fixture test |
| Dimension conflict (same item) | `dimension-conflict.avif` | `isobmff` primary-item ispe resolution | validation negative-fixture test (`AVIF_DIMENSION_MISMATCH`) |
| Oversized dimension | `oversized-ispe.avif` | `isobmff` limit checks | `AVIF_DIMENSION_UNSUPPORTED` |
| Unsupported colour space | `colour-bt2020-reject.avif` | `isobmff` CICP allow-list | `AVIF_COLOUR_SPACE_UNSUPPORTED` |
| Animation / multi-frame rejected | `animated-sequence.avif` | `isobmff` trak/`avis` detection | `AVIF_ANIMATION_UNSUPPORTED` |
| No partial result on failure | animation fixture | pipeline stage ordering | "a rejected animation job leaves no cache entry" |
| Mid-run restart | `orient-6-rotate-90.avif` | `backend._resetBackend` + new pipeline | "resetting the backend…reproduces identical pixels" |
| Cold cache rebuild | `size-33x17.avif` | new `FileResultCache` | "a cold pipeline repopulates…same bytes" |
| Capability probe / no silent downgrade | runtime 1×1 probe | `capability.probeCapabilities` | `crossformat.test.mjs` → capability probe tests |
| Cross-format publish | `alpha-zones`, `size-33x17` | `png.encodePng` | "PNG output decodes back…", "rgba and png outputs share…" |
| Upstream sharp fixtures | `../test/fixtures/pitm.avif`, `sdr_cosmos…avif` | full pipeline | "upstream sharp fixtures remain decodable…" |
| Health never blocks on codec | service | `service` `/health` | `service.test.mjs` → "GET /health reports readiness…" |
| Graceful shutdown + temp cleanup | service | `service.shutdown` | "shutdown drains within the deadline…", "…waits for an in-flight request…" |
| Drain rejection | service | `SERVICE_SHUTDOWN` | "…while draining gets SERVICE_SHUTDOWN" |
| Cache key versioning | pure | `cache.buildCacheKey` | `cache.test.mjs` → cache key composition suite |

## Stable error codes (`src/errors.js`)

`AVIF_NOT_AVIF`, `AVIF_TRUNCATED_BOX`, `AVIF_INVALID_BOX`,
`AVIF_DIMENSION_MISMATCH`, `AVIF_DIMENSION_UNSUPPORTED`,
`AVIF_COLOUR_SPACE_UNSUPPORTED`, `AVIF_ORIENTATION_INVALID`,
`AVIF_ORIENTATION_MISMATCH`, `AVIF_ANIMATION_UNSUPPORTED`,
`AVIF_FRAME_CORRUPT`, `AVIF_MEMORY_LIMIT`, `AVIF_DECODER_UNAVAILABLE`,
`AVIF_DECODE_FAILED`, `AVIF_PUBLISH_FAILED`, `AVIF_INPUT_EMPTY`,
`AVIF_INPUT_TOO_LARGE`, `AVIF_SERVICE_SHUTDOWN`.

Each `AvifError` carries an immutable `code`, a human `message`, a frozen
`details` object and a `quality` (`reject` for bad input, `fail-closed` for
infrastructure). Messages are append-only; callers branch on `code`.

## Reading a failure

1. The HTTP layer maps `reject` → **422** and `fail-closed` → **502**; shutdown
   pressure → **503**. The JSON body is `err.toJSON()`.
2. A pipeline result includes a `trace` array with per-stage `ok`/`ms`, so a
   failure identifies the exact stage (`inspect`, `probe`, `decode`,
   `cross-check`, `orient`, `encode`, `publish`).
3. Structural rejections happen before any pixel allocation, so they cannot
   leave a buffer or cache artifact behind.

## Reproducing deterministically

```bash
npm run samples      # regenerate fixtures; manifest hashes must match
npm test             # 61 tests, exit 0
npm run acceptance   # writes acceptance-report.json; run twice and diff
```

The acceptance harness asserts that operational env vars
(`SHUTDOWN_TIMEOUT_MS`, `MAX_QUEUE_DEPTH`) do not change pixel hashes, proving
that non-pixel configuration cannot alter output.
