# Rust image processor implementation verification

Updated: 2026-10-16 (Asia/Manila)

The experimental Rust executable and backend integration are implemented. `IMAGE_PROCESSOR=sharp` remains the default. The normal Sharp compression policy and legacy fingerprint are preserved; tuned Sharp is currently an offline comparison option.

Implemented: bounded one-request native executable; libvips C++ ownership bridge; cached normalized reference/composites; best-candidate retention; pinned SSIMULACRA2 CLI; engine startup self-test; executable/metric/native-build fingerprint; independent output hash/size/format/dimension checks; process-tree termination; one-second job ownership/cancellation observation; admission pause/drain configuration; both-engine Docker packaging; locked Rust toolchain/dependencies; fixture and benchmark tooling.

Local environment: Windows host with bundled Node 24.19.0 and a temporary Rust 1.90.0 toolchain in Ubuntu 22.04 WSL. Docker Desktop was initially unavailable; verification resumed with Docker Engine 29.8.1 on 2026-10-16. The final Rust build links Sharp's exact package-lock-pinned Linux native bundle (libvips 8.18.6 and its codecs), using `FARM_VIPS_BUNDLE_ROOT`. The supplied Dockerfile packages this same shared native stack. Installed libvips headers provide the stable API declarations; system codec libraries are not linked into the bundled build.

Backend build/test typecheck and architecture check pass; 137 backend unit tests pass with two metric-dependent skips on Windows. Rust release compilation, formatting and strict Clippy checks pass. Three Rust tests pass, including real JPEG/PNG/WebP/AVIF round trips, animation/spoof rejection and malformed headers. Changed TypeScript/JavaScript files pass Biome. Repository-wide Biome reports 105 existing formatting errors (mostly CRLF versus LF) and 17 warnings outside the focused check; those unrelated files were not reformatted.

Initial diagnostic builds linked distribution libvips 8.12.1/codecs and exposed an 8-pixel AVIF failure plus alpha-resize/CMYK differences. The fix is to share Sharp's pinned bundle and match Sharp's ICC conversion and alpha-cast ordering. The final codec tests cover both 8- and 64-pixel images; startup uses the 8-pixel fixture so incompatible native stacks fail readiness. A candidate that cannot be encoded/decoded is rejected while verified alternatives remain eligible; a metric failure is still fatal.

The final normalization audit passes all seven cases: EXIF orientation, P3/ICC, CMYK, grayscale, 16-bit PNG, transparent resizing and tiny PNG preservation. Dimensions, alpha and every normalized pixel match Sharp exactly; each common-reference SSIMULACRA2 score is 100. This is a small synthetic audit rather than full customer-media acceptance.

The exact libjxl 0.11.1 commit `794a5dcf0d54f9f0b20d288a12e87afb91d20dfc` was fetched and its SSIMULACRA2 executable compiled in temporary WSL storage. The Rust codec/metric startup self-test passes. Nine real-metric Sharp tests pass in an isolated Linux dependency workspace, including matching baseline/tuned candidate scores and output bytes on the transparent fixture, preserve behavior, exact-alpha rejection and configured output-limit failure.

## Docker and database verification

The production `app` target builds successfully as `farm-images-rust:verification`, including locked Rust release compilation, three Rust tests, formatting, strict Clippy, backend TypeScript compilation and production dependency pruning. The production container passes its eight-pixel codec/metric startup self-test as the non-root `node` user. All seven normalization cases also pass inside this production image with exact pixels and scores of 100. These runs use 2 CPUs, 2304 MiB memory and a 128-PID limit.

The test image in `deploy/Dockerfile.images-test` adds only test dependencies/configuration and keeps the runner non-root. Each engine passes **19 integration tests across three suites**:

| Suite | Sharp | Rust | Coverage |
| --- | --- | --- | --- |
| `images.test.ts` | 9 passed | 9 passed | Durable admission, ready attachment, private/public delivery, tenant checks, deduplication, leases, retries, cleanup and backpressure |
| `media-library.test.ts` | 6 passed | 6 passed | Permissions, library reuse, trash/restore, cache/output trash checks and tenant isolation |
| `image-worker.test.ts` | 4 passed | 4 passed | Actual native processing and source-cache reuse; active cancellation and work-file cleanup; paused admission with readiness/delivery intact; queued-source recovery across API restarts |

The Linux runs use a fresh MongoDB 8.0.16 replica set on an internal Docker network with no published ports or persistent volumes. The host provisions the fixture; the runner receives only a read-only nonce context and the private database connection. No Docker-control socket is shared. `startTestDatabase` verifies the fixture's admin marker and constructs a new random `farm_test_...` database for every suite. Its existing Testcontainers route remains the default outside this explicit fixture mode; neither route consumes the application `MONGODB_URI`.

Earlier direct Windows-host runs reached MongoDB but had four upload failures because Windows reports staging-directory mode `0666`, which does not satisfy the Linux `0700` check. The Linux-container runs above resolve this verification gap without weakening the staging policy. Native Windows ACL/directory-sync support remains outside the supported runtime.

The suites emit existing Mongoose deprecation/activity-log teardown warnings. Active cancellation also logs the expected aborted image attempt. All 38 engine-specific test cases pass. The disposable test database/network are removed after verification; application databases and deployed configuration are not used. The local machine-readable result and verified image ID are recorded in `artifacts/rust-image-docker-verification.json` (gitignored).

## Matched-library diagnostic comparison

Two generated fixtures, all four profiles, one measured pass after warm-up: eight measured samples per engine. Identical input hashes, common Sharp-normalized quality oracle, and pinned native bundle. Results are processing timings, not upload/network/queue/database/UI timings.

| Engine | p50 | p95 | Quality/alpha failures |
| --- | --- | --- | --- |
| Baseline Sharp | 255.3 ms | 1259.4 ms | 0 |
| Tuned Sharp | 234.4 ms | 1254.2 ms | 0 |
| Rust | 161.9 ms | 954.6 ms | 0 |

Rust p95 improved about 24% against baseline, below the required 30% gate. Output-size checks passed on this sample. This run also falls below the required corpus size and repeat count. **Adoption is not approved by these measurements; Sharp remains the default.** Sharp benchmark modes run inside the harness, whereas Rust timings include child startup and independent output validation; a target deployment comparison must include equivalent supervision and all resource measurements.

Local detailed artifacts (gitignored): `artifacts/rust-image-matched-smoke.json` and `artifacts/rust-image-normalization.json`. A preceding five-fixture report, `artifacts/rust-image-smoke.json`, used the obsolete distribution-codec build, contained failures and is not evidence for the final engine. The generator produced 100 synthetic fixtures for repeatable future runs. Add authorized real photographs and boundary fixtures before release calibration.

Pending release acceptance: representative authorized photography and near-limit parity; expanded ICC/CMYK/16-bit coverage; the full 100-fixture/five-pass/four-profile performance gate on target hardware; child-inclusive cgroup peak memory and steady-state load; remaining fault-injection cases such as encoder OOM/disk exhaustion; actual frontend upload/edit/reuse/cancel/save/publish checks against the selected engine; staging deployment and full engine-switch rollback rehearsal. Docker packaging, real API processing, cancellation, draining, and restart recovery are now verified. The offline harness explicitly does not claim network/queue/database/UI or total process-tree resource measurements.

No application database credentials, customer records, deployed settings, or stored image references are changed by the offline verification commands.
