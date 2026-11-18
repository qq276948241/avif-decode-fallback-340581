# Migration and version record

This package introduces a **new, additive fallback path**; it does not replace
or alter sharp's existing native pipeline. During migration both the old
(upstream) samples and the new generated format are verified together.

## Old vs new behaviour

| Aspect | Before (upstream sharp only) | After (this package) |
| --- | --- | --- |
| AVIF decode | Native libvips/heif through sharp's binding | Native when available, else a locked WASM backend selected by an explicit probe |
| Backend selection | Implicit inside the native module | Explicit `probeCapabilities()`, result frozen and cached; every result stamps `backend` and `degraded` |
| Structural validation | Handled inside libvips; errors surface as generic native errors | Pure-JS `isobmff.inspectAvif` runs first with stable `AVIF_*` codes and zero pixel allocation |
| Orientation | Applied by libvips | Explicit integer EXIF map (`pixel.applyOrientation`) with a documented top-left coordinate contract |
| Concurrency safety | Native module guarantees | Added JS mutex plus mandatory copy out of the WASM heap; no shared mutable output buffers |
| Result cache | None in this scope | Versioned content-addressed file cache with atomic publish |
| Failure signalling | Native error strings | Stable codes, `reject` vs `fail-closed` quality, per-stage trace |
| Silent downgrade | N/A | Impossible: fallback is recorded (`degraded: true`, `x-backend: wasm`); an uncertified backend throws `AVIF_DECODER_UNAVAILABLE` |

## Dependency and lockfile changes

The parent project's dependencies are untouched. All changes are scoped to
`avif-fallback/package.json` and `avif-fallback/package-lock.json`
(lockfileVersion 3):

| Package | Version | Pin | Purpose |
| --- | --- | --- | --- |
| `@jsquash/avif` | `2.1.1` | exact (`--save-exact`) | AVM/AV1 WASM encode + decode (Squoosh lineage) |
| `wasm-feature-detect` | `1.10.1` | transitive, locked | WASM feature probing (encoder only) |

Integrity hashes are recorded in the lockfile, so a compromised or altered
tarball fails installation. The WASM binaries
(`codec/dec/avif_dec.wasm`, `codec/enc/avif_enc.wasm`) ship inside the pinned
package and are loaded from disk via `WebAssembly.compile` — no `fetch`, no
network at runtime.

There are no changes to the root `package.json`, `package-lock.json`, `lib/`,
`src/` or `test/` of sharp.

## Compatibility-layer boundary

- The package exposes its own entry (`avif-fallback/src/index.js`) and named
  sub-paths. It never modifies `require('sharp')`, global objects, prototypes
  or module loaders.
- Importing it performs no work until the first decode (lazy WASM init).
- A host application opts in explicitly, for example:

  ```js
  import { probeCapabilities, createPipeline } from './avif-fallback/src/index.js';
  const cap = await probeCapabilities();
  const result = await createPipeline({ backend: cap.selected }).run(bytes);
  ```

- `RULES_VERSION` (`avif-fb-1.0.0`) names the pixel-rule generation. It is part
  of every cache key, so any future rule change invalidates old cache entries
  rather than serving stale pixels.

## Dual verification during migration

Both worlds are exercised by the same test run:

- **Old / upstream samples**: `test/crossformat.test.mjs` decodes the original
  sharp fixtures `test/fixtures/pitm.avif` (a grid image with multiple `ispe`
  boxes) and `sdr_cosmos12920_cicp1-13-6_yuv444_full_qp10.avif`, asserting
  geometry and a stable repeat hash.
- **New generated format**: `tools/generate-samples.mjs` builds 22 offline
  fixtures with the locked encoder and a pure-JS box builder, covering
  boundary sizes, alpha, all eight orientations, colour rejection, dimension
  conflicts, animation rejection and corruption. Their expected hashes and
  error codes live in `samples/manifest.json`.

Lossless AVIF round-trips are bit-exact (verified during generator authoring:
0 differing bytes), so the new fixtures need no external reference images.

## No silent downgrade policy

1. `probeCapabilities` records the success/failure reason of **both** backends.
2. Auto-selection prefers native; WASM is chosen only when native is not
   certified, and the result is marked `degraded: true`.
3. Forcing a backend that the probe did not certify throws
   `AVIF_DECODER_UNAVAILABLE` rather than falling through.
4. Every decode result and HTTP response names the backend used, so a fallback
   event is always observable in logs and headers.

## Conditions not covered

Listed honestly rather than claimed complete:

- **Animated / image-sequence AVIF playback** is intentionally rejected
  (`AVIF_ANIMATION_UNSUPPORTED`); per-frame timing and multi-frame assembly are
  outside this module's contract.
- **ICC-profile colour management** (`prof`/`rICC`) records profile presence
  but does not apply a colour-managed transform; only the documented CICP
  sRGB-equivalent set is validated for pixel correctness.
- **10/12-bit output** is accepted by the backend but the pipeline publishes
  8-bit RGBA; high-bit-depth preservation is a future `RULES_VERSION` change.
- **Grid (tile) reconstruction** is not performed; the primary item's extent is
  resolved correctly, but composite grid assembly is out of scope.
