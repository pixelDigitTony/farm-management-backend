# Rust image-processing feasibility and implementation specification

Date: 2026-10-15 (Asia/Manila)  
Status: Experimental implementation available; Sharp remains default; release gates pending  
Scope: Farm-management backend image uploads and their existing frontend consumers

## 1. Decision

**Yes, the processing portion of image uploads can be rewritten in Rust.** Prototype a Rust executable launched and supervised by the existing Node backend, inside the same deployment. Keep HTTP upload admission, authorization, MongoDB jobs, leases, storage, and image delivery in TypeScript.

Production adoption is conditional on measured improvement over both the current implementation and a tuned Sharp implementation. A full HTTP/backend rewrite is technically possible but is not justified by the evidence gathered here.

Sharp already delegates image processing to native libvips. Its documentation explains native thread pools and codec throughput constraints; changing the orchestration language alone does not establish a speedup. [Sharp performance](https://sharp.pixelplumbing.com/performance/)

The proposed Rust implementation initially retains libvips and the pinned SSIMULACRA2 algorithm. Its opportunities are fewer repeated decodes, fewer temporary PNG round trips, bounded buffer reuse, and lower process startup overhead. These are hypotheses to measure. Network transfer, serialized admission, queue wait, and database storage will not automatically improve with Rust.

The follow-up implementation provides the Rust executable, engine adapter, cancellation supervision, admission switch, Docker packaging, tests and offline comparison tools. See [the implementation verification record](RUST-IMAGE-VERIFICATION.md) for actual checks and remaining release gates. Production adoption still requires the measurements below.

## 2. Current implementation, verified from source

Paths below are relative to the backend unless explicitly marked frontend.

| Area | Current implementation |
| --- | --- |
| Upload UI | Frontend `src/hooks/useImageUpload.ts` sends a file as `application/octet-stream`, polls up to 60 times with delays capped at 10 seconds, and requests cancellation on failure/unmount. `ImageUpload.tsx` and `MediaPicker.tsx` own preview and selection. |
| HTTP contract | `src/routes/image.routes.ts`: POST `/api/images/jobs`, GET/DELETE `/api/images/jobs/:id`, library/trash/restore, private delivery, public delivery, and owner health. |
| Admission | `src/images/queue.ts`: global `image-admission` lock; 30-second receipt deadline; streaming SHA-256; private staging; file/directory fsync; durable MongoDB job before HTTP 202. Concurrent receipt can return 429. |
| Scheduling | `src/images/service.ts`: backend-owned loop, singleton `image-worker` lease, job ownership tokens and renewal, retry/recovery, and cleanup. Started/stopped by `src/server.ts`. |
| Process boundary | `src/images/process.ts` forks `encode-process.ts` once per attempt. The child writes `output` and returns metadata over Node IPC. The parent enforces a deadline and kills the process tree on abort. |
| Image processing | `src/images/compress.ts`: Sharp 0.35.4; cache disabled; Sharp concurrency 1; format/pixel/frame checks; orientation and sRGB conversion; resizing; PNG/AVIF/WebP candidates; exact alpha comparison and external SSIMULACRA2. |
| Storage | `src/models/image.models.ts` and `queue.ts`: output bytes in `StoredImage`; unique `(businessId, sha256)`; source cache includes business, source hash, profile, and pipeline version. Stored images survive upload-job expiry. |
| Hosting | `deploy/Dockerfile.images` builds pinned libjxl 0.11.1. `deploy/compose.images.yaml` runs one API service with persistent staging, 2 CPUs, 2304 MiB combined memory, PID limit 128, and 45-second graceful stop. These are supplied deployment settings, not verified live limits. |

### Existing policy to preserve

| Setting | Current default |
| --- | --- |
| Input formats | Still JPEG, PNG, WebP, AVIF; HEIC/HEVC is not accepted |
| Input limits | 20 MiB; 24,000,000 decoded pixels; one frame |
| Output limit | 12 MiB; configurable ceiling 14 MiB |
| Profiles | `avatar`: 512 px; `photo`: 1600 px; `display`: 2400 px longest edge; `preserve`: no resize |
| Geometry | Apply orientation once; preserve aspect ratio; do not upscale |
| Quality | Minimum SSIMULACRA2 score 80 on both white and `#111111` backgrounds; exact alpha equality against normalized reference |
| Search | Up to three trials each for AVIF quality 45–75 and WebP quality 70–92; effort 6 |
| Preserve profile | Normalized lossless PNG; no lossy trials. This is not preservation of original metadata or original file bytes. |
| Queue/resources | 40 queued/processing jobs; one active encoder globally; 1 GiB staging budget |
| Recovery | 60-second leases; 180-second encode deadline per attempt; three attempts; terminal files cleaned before seven-day job TTL |

Code is the authority when older documentation differs. For example, current routes also support `media-library`, and quality comparison uses `#111111`, not pure black.

### Likely costs and evidence limits

1. A non-preserve job can evaluate eight candidates: one reference PNG, six lossy trials, and one eligible normalized original. Alpha mismatch may reject a candidate early; otherwise each assessment runs the metric twice, up to sixteen metric subprocesses.
2. Each assessment decodes the reference and candidate to RGBA, then separately prepares flattened PNGs for each background. Reference decoding, flattening, PNG encoding, file writes, and metric-side decoding repeat across candidates.
3. `candidates` retains every encoded buffer until selection. Only the current best passing bytes and compact metadata are necessary once a trial has been assessed.
4. One encoder and serialized upload admission intentionally bound resource use. A Rust child does not remove these throughput limits. Polling can also delay when a completed result becomes visible.
5. Current DELETE cancellation marks a job failed. The service checks ownership before storage/completion, but does not immediately abort a running child solely because DELETE changed the job state. Preserve the completion fence and add prompt cancellation observation in the proposed supervisor.

`deploy/benchmark-images.json` records approximately 30.91, 9.05, and 10.14 seconds for three screenshots on an Apple M3 with Node 20.19.0. Its note says timings include Docker metric invocation overhead, Node RSS excludes the metric, and screenshots are not representative product photography. It is historical evidence that full-pipeline cost deserves profiling, not a current production baseline or proof of a particular bottleneck. The isolated WebP encode timings in that file exclude most pipeline work and are not an equivalent comparison.

## 3. Options and research

| Option | Assessment | Decision |
| --- | --- | --- |
| Tune current TypeScript + Sharp | Can cache normalized reference data and background images, reduce retained candidates, and instrument expensive stages. Lowest integration cost. | Required comparison baseline. |
| Rust executable + native libraries | Reuses the existing killable process boundary and deployment ownership. Can optimize orchestration and buffers while retaining proven codecs. | Recommended prototype. |
| Rust via NAPI-RS inside API process | Supports off-main-thread CPU work, but running native work cannot be forcibly cancelled by Node-API alone. Native crashes and allocations share the API process. | Defer; existing process isolation is valuable. |
| Rust HTTP service/full upload rewrite | Adds HTTP/auth/database/deployment parity work without evidence that these stages dominate. | Out of scope for this optimization. |
| Rust-first codec and resize stack | Possible, but requires explicit codec, color, orientation, alpha, and format-limit parity. | Optional later experiment if profiling justifies it. |

NAPI-RS documents `AsyncTask` execution on libuv threads and explicitly distinguishes cancelling queued work from stopping an already-running `compute` callback. The process-boundary recommendation is an architectural inference from that limitation and this application's existing deadlines. [NAPI-RS AsyncTask](https://napi.rs/docs/concepts/async-task)

Rust libvips bindings expose image operations, HEIF-buffer encoding options, and ICC conversion operations. This makes a compatible Rust wrapper feasible, but the installed libvips build must actually include JPEG/PNG/WebP/AVIF codecs. An API symbol is not proof that a deployment has its codec. Select and pin a tested binding/native-library combination during the prototype. [Rust libvips](https://docs.rs/libvips/latest/libvips/), [operation reference](https://docs.rs/libvips/latest/libvips/ops/index.html)

The `image` crate provides Rust image buffers, decoding/encoding APIs, and limits. Format support is feature-dependent; its project documents native AVIF dependencies as an option. Do not assume a single crate provides identical lossy WebP/AVIF behavior, ICC handling, or a native-dependency-free replacement. [image API](https://docs.rs/image/latest/image/), [image features](https://github.com/image-rs/image#feature-flags)

`fast_image_resize` offers SIMD resize paths, but documents that linear-light conversion must be handled explicitly when desired. It also addresses alpha-aware resizing. Its component benchmarks do not predict this application's total encode-plus-quality-check latency. Changing resampling/color policy while migrating would complicate parity, so retain current normalized reference behavior initially. [fast_image_resize](https://docs.rs/crate/fast_image_resize/latest)

Upstream SSIMULACRA2 exposes a C++ image-bundle interface under libjxl tools. That suggests an in-memory adapter is feasible, but does not establish a stable C ABI. Inspect the repository's exact pinned commit before implementing a shim; the upstream main-branch header reviewed here is not verification of that pinned interface. [SSIMULACRA2 header](https://github.com/libjxl/libjxl/blob/main/tools/ssimulacra2.h)

## 4. Proposed architecture

```text
Existing React editor/picker
  -> Existing Express upload endpoint
  -> Durable staged source + tenant-scoped MongoDB job
  -> Existing Node image service acquires lease
  -> Node supervisor launches one Rust child for this attempt
  -> Rust validates / normalizes / encodes / assesses / writes output
  -> Node validates result and rechecks ownership
  -> Existing StoredImage insertion + fenced job completion
  -> Existing polling, attachment checks, and image delivery
```

Rust owns CPU-heavy image processing only. It has no MongoDB client, HTTP listener, publication logic, tenant lookup, or application-record writes. Node provides paths and resolved policy; Rust never receives database credentials. The executable is packaged in the API image and managed by the backend lifecycle, with no separately operated worker service.

Start with Rust + libvips + the existing metric CLI for correctness. Then measure reference reuse and optional in-memory metric integration separately. Keep a narrow native FFI module; document ownership, pixel layouts, error mapping, and thread constraints. Rust does not make C/C++ dependencies memory-safe.

Do not add a persistent child pool, parallel encoders, a new queue, object storage, or frontend WebAssembly in the initial implementation.

## 5. Internal executable contract

Proposed executable: `farm-image-processor`. Node launches it with an argument array, `shell: false`, and hidden windows on Windows. One request per process, followed by process exit.

Request: one UTF-8 JSON object on stdin, maximum 16 KiB, then EOF:

| Field | Contract |
| --- | --- |
| `protocolVersion` | Integer `1`; reject unsupported versions. |
| `jobId`, `attemptId` | Server-generated correlation identifiers; no authorization authority. |
| `pipelineVersion` | Exact expected pipeline fingerprint. |
| `sourcePath`, `workDir` | Absolute paths created by Node within private staging. Source is read-only; writes are confined to this attempt directory. |
| `profile` | `avatar`, `photo`, `display`, or `preserve`. |
| `policy` | Fully resolved byte/pixel/frame/output/dimension/quality/search/effort/deadline limits from Node; child validates ranges and consistency. |

Success: exit 0 and exactly one JSON response on stdout, maximum 64 KiB. Required fields: `protocolVersion`, `ok: true`, `pipelineVersion`, `mime`, `width`, `height`, `byteLength`, `sha256`, finite `score`, and numeric per-stage `timingsMs`. Optional bounded candidate diagnostics contain format, quality, length and pass/fail reason, never bytes. Logs go to bounded stderr.

Write `output.tmp` privately, finish and close it, then atomically rename it to `output` in the same work directory before emitting success. No image bytes or base64 cross stdout. Node requires successful process termination as well as a valid response, so a success message followed by a crash cannot complete the job.

Failure: nonzero exit with `ok: false`, a machine-readable code, and a short safe message. Codes include `INVALID_INPUT`, `UNSUPPORTED_FORMAT`, `ANIMATION`, `LIMIT_EXCEEDED`, `QUALITY_REJECTED`, `METRIC_UNAVAILABLE`, `TIMEOUT`, and `INTERNAL`. Node handles missing/malformed/oversized responses, signals and crashes as failures. Public errors remain compatible and exclude local paths/native stack traces. Preserve existing retry behavior initially; any permanent/transient retry change is a separate tested policy decision.

Parent checks before storage:

- Validate response schema, fingerprint, MIME allowlist, dimensions, score threshold and configured output bound.
- Require a regular non-symlink `output` within the expected attempt directory. Check size before bounded reading; recompute hash and inspect encoded format/dimensions with a bounded independent validator.
- Recheck job token, lease, cancellation and backend shutdown state before storing and again through existing fenced completion. Rust cannot choose an image ID or business ID.
- Reject paths outside staging and symlink escapes; the user-supplied filename must never determine paths or executable arguments. Use a private service-owned staging tree and exclusive attempt directories.

Add a `--self-test` command that exercises required codec paths and the configured metric with tiny known fixtures, reports protocol/build/native dependency versions, and exits within a short bounded deadline. Readiness requires a passing self-test, not just file existence.

## 6. Processing algorithm and compatibility

1. Inspect actual file content with bounded parsing. Reject unsupported formats, truncated/corrupt data, APNG, animated WebP/AVIF and multi-frame images. Enforce checked dimension arithmetic, decoded pixel limit, compressed byte limit, and allocation budgets before large allocations. Treat decoder warnings consistently with the current rejection policy.
2. Decode and normalize once where library behavior permits. Apply EXIF orientation once, produce sRGB, strip metadata, resize inside the profile boundary without enlargement, and preserve transparency. Verify ICC/CMYK/grayscale/16-bit behavior against current Sharp fixtures; do not silently reinterpret color or bit depth.
3. Materialize a bounded reference and reuse its RGBA/alpha representation and white/dark composites. Explicitly release unneeded buffers; native lazy pipelines must not unexpectedly decode the source for every trial.
4. Evaluate the normalized PNG and the same bounded AVIF/WebP search. Retain the original candidate only under the current metadata-free, sRGB, orientation-free, correctly sized checks; `preserve` allows only PNG candidates. Preserve exact quality rounding, tie ordering, effort mapping and search updates during parity work.
5. Decode each candidate once where feasible. Check matching dimensions and exact alpha against the normalized reference before scoring. Reuse candidate pixels for both background composites. Choose the minimum of the two finite SSIMULACRA2 scores.
6. Retain only the smallest passing encoded candidate and compact diagnostics; free losing buffers promptly. Select among evaluated candidates without assuming monotonic score or byte size. No claim is made that three trials find a globally optimal quality setting.
7. Fail if no candidate satisfies quality and size limits. Do not lower the threshold, silently change to fixed-quality WebP, or bypass the metric for PNG/preserve paths.

For the first prototype, cache the reference background PNGs and retain the pinned metric executable. For an optional C++/Rust in-memory metric adapter, build from libjxl commit `794a5dcf0d54f9f0b20d288a12e87afb91d20dfc`, prove buffer/color equivalence, and compare its scores with that CLI. Proposed tolerance: absolute difference at most 0.01 and zero pass/fail disagreements around the configured threshold; near-threshold cases must use the reference CLI if numerical equivalence is uncertain. Do not substitute an unrelated Rust metric implementation on name similarity alone.

Compatibility must be assessed against the original Sharp-normalized reference, not only Rust's own reference; otherwise incorrect normalization could score well against itself. Geometry and alpha must match the baseline exactly. Investigate any color/reference differences before acceptance.

## 7. Lifecycle, limits, and deployment

- Keep the global `image-worker` lock and concurrency 1. Keep durable source/job behavior, business-scoped deduplication, trash checks, retry leases, and cleanup ordering.
- Extend the supervisor to observe cancellation/ownership at most every second while encoding. DELETE remains idempotent under current semantics; a cancelled job must not become ready. Proposed stop target: process tree gone within two seconds of observing cancellation, including metric descendants.
- Enforce the existing 180-second attempt deadline in the parent; metric invocations remain bounded by the lesser of 30 seconds and remaining time. Kill the entire process group on timeout, lease loss or shutdown, reap children, and only then remove work files. Late success is discarded.
- Keep the supplied 2-CPU/2304-MiB container envelope initially. Explicitly bound native/Rayon/codec thread counts and buffers; do not let all libraries independently use every CPU. Start with one processing thread where supported, then calibrate within the same CPU allowance.
- Account for the API, Rust child, native codecs and metric together. Container-wide limits alone can still allow an encoder OOM to affect the API; use measured headroom, allocation checks and a tested child resource limit where supported. Do not promise API survival from process separation alone.
- Add a pinned Rust multi-stage build, committed `Cargo.lock`, pinned toolchain, and `cargo build --release --locked`. Pin compatible libvips/codecs and the existing libjxl source; record native versions and binary checksum in build metadata. Check license obligations and native dependency updates as part of ordinary release maintenance.
- Linux Docker is the primary supported runtime, including development through Docker Desktop on Windows. A native Windows executable needs separate codec packaging, permission/ACL, directory-sync and process-tree tests; producing an `.exe` alone does not establish native workflow support.
- Preserve staging volumes, non-root execution, existing graceful stop, and health reporting. Existing images remain deliverable if processing is unavailable. New uploads return 503 if the selected processor is not ready.

Proposed configuration additions: `IMAGE_PROCESSOR=sharp|rust` (default `sharp`), `IMAGE_RUST_BIN` (absolute packaged executable), and `IMAGE_UPLOADS_ENABLED=true|false` (default `true`). The admission flag rejects new jobs while allowing existing jobs to drain; it must not stop processing or delivery. Health may add engine/build/protocol fields without removing current fields.

The current fingerprint hashes operational settings as well as compression policy. Preserve the existing Sharp fingerprint algorithm exactly for compatibility. Define a separate Rust fingerprint covering engine/build/native-codec/metric versions and output-affecting policy. Exclude executable paths and the admission switch from the new fingerprint. A job must never be processed under a different fingerprint or silently fall back to another engine.

## 8. API, tenant, and UI invariants

- Preserve POST 202 after durable admission and the existing query parameters, response shapes, job states and image URLs. Keep user-and-business restrictions on job polling/cancellation and business/module permissions on media operations.
- Rust processing never attaches or publishes an image. Existing authorized form/save/draft/publish workflows remain responsible for references.
- Existing image delivery and publication checks remain authoritative. Draft images stay private; unpublishing revokes public access under existing behavior.
- Trash removes discovery/new reuse while retaining existing references. Edit-a-copy creates a new upload; it never mutates stored source bytes. Do not introduce stored-image garbage collection.
- Preserve preview, crop/rotate/resize/editor output, preserve-detail control, pending-form blocking, error/retry behavior and stale-selection protection. No frontend rewrite is required to select the new backend engine.

## 9. Benchmark plan and adoption gates

These are proposed acceptance targets, not measured results.

### Experiment design

Compare A: current pipeline; B: tuned Sharp with reference reuse and bounded candidate retention; C: Rust with matching policy/native codecs; D: optional Rust with in-memory metric. Separate the effect of language/process startup from algorithm and codec changes. Record actual Sharp native versions from its runtime, not just npm version; test same-codec builds when attributing gains.

Use at least 100 authorized or generated fixtures with a fixed manifest and hashes: farm/product/food photos; foliage/noise/low-light; fine text/screenshots; transparent logos and gradients; oriented phone JPEGs; ICC/CMYK/grayscale/16-bit inputs; PNG/WebP/AVIF; tiny inputs and inputs near byte/pixel limits. Include a separate malformed/animation/oversized rejection corpus. Do not copy private production media without authorization.

Measure all four profiles on identical hardware, container CPU/memory limits, source files, threshold, native versions, warm/cold conditions and trial policy. Randomize implementation order; perform at least five measured passes after warm-up, with confidence intervals and per-category results. Report cold-start subprocess overhead separately. Benchmark uncached source processing separately from source/output-cache hits; a cache hit must not be counted as faster encoding.

Capture receipt time, queue wait, process startup, decode/normalize, each encode, alpha/composite work, each metric, temporary I/O, storage, total upload-to-ready, and frontend ready-detection delay. Record p50/p95/p99, CPU-seconds/job, throughput, combined process-tree/cgroup peak memory, temporary bytes, subprocess count, output sizes/formats/scores, rejection reasons, retries and failures. The existing `scripts/benchmark-images.mjs` is a starting point; it does not currently provide this coverage or full-process memory.

Run single-job, queued-burst and steady-state load with existing admission semantics. Separately measure 429 admission rates, queue saturation and API responsiveness. Test long-running load for memory growth. Use disposable MongoDB for API benchmarks; codec-only benchmarks need no database.

### Release gates

| Gate | Proposed requirement |
| --- | --- |
| Correctness | All supported-input, quality, alpha, normalization, permission, lifecycle and recovery checks pass; no previously passing corpus item newly fails. |
| Processing latency | Rust p95 at least 30% below A and 20% below B on the fixed weighted corpus; p50 and each major input category/profile must not regress more than 5%. If gains are smaller, retain tuned Sharp and record the no-go result. |
| Delivered latency | End-to-end upload-to-ready p95 does not regress under identical network/admission/load conditions; report separately whether queue/network/polling hides processing gains. |
| Output quality/size | Every output meets the configured score and exact-alpha policy against the common reference; average bytes at most 3% above A, no individual increase over 10%, and never above configured output limit. Exceptions require an explicit policy revision. |
| Resources | No OOM or growing steady-state memory; combined peak no higher than B and below 80% of the 2304-MiB envelope (about 1843 MiB) on the target corpus/load. No silent input-limit reduction to pass. |
| API impact | Non-image API p95 under image load at most 5% worse than B, with no increase in unexpected errors. |
| Cancellation/recovery | No ready completion after cancellation/lease loss; process-tree termination target met; restart preserves queued sources; duplicate completion cannot duplicate logical output. |

If the metric or encoder dominates despite reuse, evaluate the cost of further native integration before broadening the rewrite. If network, receipt serialization or queue wait dominates user experience, record that as a separate optimization proposal rather than claiming Rust solved upload latency.

## 10. Implementation plan and affected files

| Phase | Deliverable | Exit condition |
| --- | --- | --- |
| 0: Establish baseline | Stage timings, representative manifest, current/tuned Sharp benchmark reports. | Identify expensive stages and quantify safe resource envelope. |
| 1: Contract and prototype | `native/image-processor/{Cargo.toml,Cargo.lock,rust-toolchain.toml,src/}`; Rust CLI, self-test, bounded protocol; current native metric. | Deterministic contract tests and supported format/profile parity. |
| 2: Reduce repeated work | Reference/composite reuse, incremental candidate retention; optional metric shim with oracle comparisons. | Equivalent quality behavior and measured stage-level improvements. |
| 3: Backend integration | `src/images/process.ts` engine adapter; `config.ts` engine/fingerprint policy; `service.ts` readiness/cancellation; `queue.ts` admission flag/readiness integration. | Existing durable job and lifecycle tests pass for both engines. |
| 4: Packaging and validation | Dockerfile/build scripts; Compose environment documentation; benchmark harness; fault injection. | Full gates in section 9 pass on target hardware. |
| 5: Controlled rollout | Isolated staging verification, drain-and-switch production procedure, rollback rehearsal. | Real upload/edit/reuse/private/public flows verified and monitored. |

Update `deploy/.env.images.example`, `deploy/IMAGES.md`, `deploy/LOCAL-IMAGES.md` and image verification notes during implementation. Extend the health response in `src/routes/image.routes.ts` only as needed. Avoid a schema migration for basic engine selection; the existing job/image `pipelineVersion` fields can hold the engine-specific fingerprint. Preserve Sharp and its adapter for rollback.

### Required validation

- Rust: formatting, Clippy, unit/contract tests; malformed/truncated input and header-size fuzzing; overflow, allocation and path-escape cases; invalid response and missing codec/metric cases.
- Image parity: use and extend `tests/image-compression.test.ts` and `tests/image-quality.test.ts`; test EXIF orientations, metadata stripping, ICC/color edges, transparency over both backgrounds, preserve mode, no upscaling, exact limits, and quality near threshold. Real metric execution is mandatory for release acceptance.
- Backend: extend `tests/image-service.test.ts`, `tests/integration/image-worker.test.ts`, `tests/integration/images.test.ts`, and `tests/integration/media-library.test.ts` for both engines. Include child crash, hung metric, parent shutdown, cancellation on another API replica, lease expiry, partial output, disk full, duplicate source/output, trash races and incompatible pipeline versions.
- Isolation: tenant A cannot poll/cancel/read/reuse tenant B's private media. Job access remains user-scoped; library access remains business/permission-scoped. Public image visibility still follows published references.
- Frontend: existing `tests/unit/image-upload.test.tsx`, `image-editor.test.ts`, and `media-library.test.tsx`; real browser checks of upload, edited copy, cancellation, failed replacement, library reuse and save/publish on desktop/mobile.
- Run backend build, typecheck, test typecheck, architecture checks and applicable existing suites. Integration tests must retain their disposable database harness and never use configured application databases. Record skipped tests and distinguish mock checks from actual codec/browser/deployment checks.

## 11. Rollout and rollback

1. Ship both engines with Sharp selected. Validate Rust self-test, offline comparisons and staging behavior before any production switch. Run shadow comparisons offline or in isolated staging so they cannot consume production queue capacity or attach images.
2. Set `IMAGE_UPLOADS_ENABLED=false` through the deployment configuration while keeping processing enabled. Wait for all queued/processing jobs, including retry-delayed jobs, to finish. Preserve staging and stored images.
3. Stop the backend gracefully; verify the old processor/descendants have exited. Start the same service with Rust selected and a new fingerprint. Verify readiness, then enable admission and perform an authorized test upload.
4. Monitor latency, failures, CPU, combined memory, queue age, cancellation and delivery. Scope any production canary to a deployment with its own queue/staging; do not mix incompatible global processors against the same queue. Tenant-level mixed-engine canaries need explicit per-job engine routing, outside this first version.
5. To roll back normally, disable admission, drain Rust jobs, stop, switch to Sharp, self-test, then reopen admission. Existing image bytes and URLs remain valid regardless of the engine that created them.
6. If Rust cannot drain, disable admission and stop it while retaining sources. Prefer a fixed Rust-compatible build to finish those jobs. If unavailable, explicitly mark remaining incompatible jobs failed with a safe reupload message under a controlled recovery procedure; do not relabel them with the Sharp fingerprint or silently reprocess them. Retain files for ordinary terminal cleanup.

Never delete image documents, reference fields, drafts, published snapshots or the staging volume during rollback. A switch must not rely on the current generic pipeline-mismatch failure as its normal migration mechanism.

## 12. Remaining uncertainties

- Current deployed hardware, codec builds, traffic mix, queue delays and production upload timings were not inspected.
- The historical screenshot benchmark is too small and confounded by Docker invocation overhead to estimate Rust's benefit.
- Rust/libvips packaging and the pinned SSIMULACRA2 in-memory integration need a compiling proof of concept. Dependencies must be locked after that compatibility check, rather than selecting versions from latest-documentation URLs alone.
- A pure-Rust codec stack could improve or worsen speed, quality and memory. It is not a prerequisite for the recommended Rust orchestration design.

The research supports feasibility and a bounded prototype. Only the benchmark and compatibility gates support a decision to replace the production processor.
