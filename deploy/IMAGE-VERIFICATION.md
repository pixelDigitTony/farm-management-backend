# Image-upload verification — 2026-09-13

Both repositories started clean on `main`. No commits, pushes, deployments or production database actions were performed.

## Automated checks

- Backend: **113/113 unit tests passed**, including the real SSIMULACRA2 quality case.
- Backend: **45/45 integration tests passed** across five suites. Each database fixture started a new disposable MongoDB 8.0.16 replica-set Testcontainer. Nine added image integration tests cover queue/storage/access/recovery and the actual executable worker.
- Frontend: **32/32 unit/component tests passed**, including upload failure, pending-save protection, newer selection cancellation, ready attachment and existing embed behavior.
- Both builds, Biome/type checks and test type checks passed.
- Architecture checks: backend 99 modules, frontend 83 modules, zero violations.
- Pinned Node 24 production Docker image built. Its native Sharp 0.35.4/SSIMULACRA2 preservation smoke check produced valid PNG with score 100, correct dimensions and alpha.
- Sharp was upgraded from the initial 0.34.5 implementation to 0.35.4 after a dependency audit reported native-library advisories. The final install reported no high-severity advisories; existing moderate advisories in unrelated dependencies remain outside this upload change.

## Authenticated browser check

Chromium was connected to a newly started disposable Testcontainer API plus the separate worker. Logged in as the seeded test owner, uploaded a local PNG through the actual catalog editor, observed the Ready state and canonical image reference, saved successfully, and reopened the record to confirm the saved reference and a fully decoded 390 × 844 saved-image preview. Checked the dialog at 1440 × 1000 and 390 × 844. Captures are in the frontend `output/playwright/image-upload-desktop.png` and `image-upload-mobile.png`. Initial fixture startup/CORS errors were corrected in the test environment before the successful flow; no production endpoint was contacted.

The gallery/menu integrations are covered by shared component and validation tests; a separate full browser journey through every menu/landing variant was not performed.

## Local benchmark

Actual machine: Apple M3, macOS arm64. Encoder benchmark used Node 20.19.0 and Sharp 0.35.4; repository tests used bundled Node 24.19.0. SSIMULACRA2 ran locally in Docker from pinned libjxl 0.11.1. No hosted compression service or API was used.

Only three pre-existing local UI screenshots were available in the workspace. These are **not representative farming/catalog photographs**. They were intentionally tested with the photo profile to measure the algorithm, not to establish text legibility; use preservation mode for actual text/diagrams. All samples were already below the profile size cap, so this set cannot calibrate resizing losses.

| Screenshot suffix | Dimensions | Original bytes | WebP 80 bytes / score | Adaptive bytes / score | Saving vs WebP 80 | Adaptive time |
| --- | --- | ---: | --- | --- | ---: | ---: |
| 16-03-04-249Z | 1200 × 728 | 110,473 | 22,276 / 79.00 | 12,658 / 84.89 | 43.2% | 30.91 s |
| 16-03-34-941Z | 390 × 844 | 60,823 | 20,832 / 83.13 | 10,744 / 83.88 | 48.4% | 9.05 s |
| 16-06-06-954Z | 390 × 844 | 62,593 | 22,120 / 82.11 | 11,364 / 84.39 | 48.6% | 10.14 s |

All selected outputs were AVIF. All scores use identical reference dimensions and the lower light/dark score. The first fixed WebP 80 result failed the threshold, demonstrating why fixed quality alone is insufficient.

The measured Node high-water RSS was 87,808 KiB (85.75 MiB), cumulative across the run. The metric container high-water allocation was 135,057,408 bytes (128.80 MiB), also a cumulative maximum. Adding these gives a conservative 214.55 MiB component-peak sum, **not a measured simultaneous whole-machine peak**; Docker Desktop/VM overhead is excluded. The Docker metric had a 768 MiB cap. Production worker/children are jointly capped at 1536 MiB.

Adaptive timings include normalization, both codec searches, metric execution, and per-score Docker launch overhead. The JSON also records fixed WebP encoding-only times; those exclude diagnostic metric evaluation and must not be treated as equivalent end-to-end timing. The machine was also running verification/build work, so these timings are not isolated performance capacity estimates. Representative photographs and controlled load calibration remain necessary before changing defaults or increasing concurrency.

Full candidate sizes, scores, quality settings and machine details are in `benchmark-images.json`.

## Verification boundaries

Actual worker/codec/metric/database tests and the native Linux smoke test passed locally. Production credentials, real customer images, hosted persistent-disk behavior, backup restoration and production traffic were not exercised. The same-server deployment configuration is supplied, not deployed. Stored-image garbage collection is deliberately deferred; staged-file cleanup and bounded terminal-job retention are implemented.
