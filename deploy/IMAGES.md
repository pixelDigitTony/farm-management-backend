# Adaptive image uploads

The catalog product editor, shared menu media controls (Menu and Sales & cooking), and landing-page hero/gallery editor now accept local photos. Existing HTTPS URLs, Drive links and video embeds stay supported. Upload completion only updates the open form. The existing authorized Save/Apply/Save draft/Publish actions remain responsible for attaching and publishing images; the processor never edits application records.

References use `/api/images/<imageId>` in the existing media URL fields. This retains existing record/API shapes while referencing an ObjectId in the separate `storedimages` collection. Binary is excluded from normal queries. There is no original-media migration.

## Processing and defaults

`POST /api/images/jobs?scope=catalog|menu|landing-page&profile=photo|display|avatar|preserve` accepts the original file as `application/octet-stream`. The API authenticates the user, checks current module permissions, serializes upload admission, streams into a server-generated private file, fsyncs the file and directory, and writes a journaled majority-acknowledged compact MongoDB job. Only then does it return 202 and a job ID. Real format/pixel/frame validation and all decoding run in the processor, so an invalid upload can transition from queued to failed rather than fail synchronously at HTTP admission.

`GET /api/images/jobs/:id` is restricted to the uploading user and tenant. States are queued, processing, ready and failed. `DELETE` cancels pending work without modifying the saved record. The UI previews the original locally, blocks submitting its form while unresolved, polls at 1–10 second intervals for at most 60 checks, stops on unmount/cancellation/newer selection, and offers retry. Ready references are checked for tenant ownership and existence in the existing save routes.

Sharp is pinned to **0.35.4**. SSIMULACRA2 is libjxl **0.11.1**, commit `794a5dcf0d54f9f0b20d288a12e87afb91d20dfc`. The Dockerfile checks out that commit and its pinned submodules, then builds the `ssimulacra2` target. See the [upstream build approach](https://github.com/cloudinary/ssimulacra2/blob/main/build_ssimulacra_from_libjxl_repo) and [Sharp documentation](https://sharp.pixelplumbing.com/api-input/).

| Setting | Initial value |
| --- | --- |
| Upload / decoded pixels / frames | 20 MiB / 24 million / 1 |
| Final encoded document payload | At most 12 MiB, below BSON document limit |
| Avatar / photo / display | 512 / 1600 / 2400 px longest edge |
| Display rationale | Full-width landing hero/gallery and larger desktop display; no existing separate zoom viewer |
| Photo SSIMULACRA2 threshold | 80, calibration default |
| AVIF search | Quality 45–75, effort 6, at most 3 trials |
| WebP search | Quality 70–92, effort 6, at most 3 trials |
| Queue / active encodes | 40 pending jobs / 1 |
| Staging budget | 1 GiB total; admission reserves at least 256 MiB for processing headroom |
| Upload receive / encode deadline | 30 seconds / 180 seconds |
| Lease / renewal | 60 seconds / every 20 seconds |
| Retry | At most 3 attempts, exponential delay starting at 4 seconds |
| Failed/orphan grace / terminal-job retention | 1 hour / 7 days after explicit filesystem cleanup |

Orientation is applied once, appearance normalized to sRGB, metadata removed, aspect ratio retained and upscaling prohibited. One resized PNG reference feeds both codecs independently. Each codec starts at its midpoint and searches downward after a passing score or upward after a failing score, retaining every evaluated candidate. The smallest tested passing representation wins; neither score nor size is assumed perfectly monotonic.

Every candidate is decoded and checked at the reference dimensions. Alpha bytes must match exactly, then SSIMULACRA2 scores are measured against light and dark composites; the lower score must pass. A metadata-free, correctly sized sRGB original can compete when it satisfies profile policy. The normalized lossless PNG is the fallback if it fits the output cap. The threshold is never lowered to force success. Missing/broken native tools fail clearly rather than skipping validation.

For labels, diagrams and text, select **Preserve exact detail before choosing the file**. This profile keeps the original dimensions and uses PNG preservation instead of lossy photo trials. The photo profile is not a guarantee of small-text readability. Resizing must be reviewed separately: an encoding score against a resized reference cannot measure the detail removed by resizing.

Source-cache keys contain tenant, source hash, profile and pipeline version. Cache hits verify that the same tenant still owns the image. The processor also checks the cache when processing queued duplicate sources. Output SHA-256 has a tenant-scoped unique index, with duplicate-insert recovery. Pipeline identity includes the Sharp/metric version and configuration fingerprint.

## Access and cleanup

Private `GET /api/images/:id` requires current authentication, an image-related view permission and the same tenant. Public `GET /api/public/images/:id` checks the current published snapshot and the same public catalog/menu rules used by the site. Draft-only images are not public. Disabling/unpublishing a page revokes public access on the next request. Responses use the actual Content-Type, nosniff, ETag and private revalidation caching. Do not configure a proxy/CDN to cache these endpoints as permanently public.

MongoDB atomic claims, ownership tokens and expiring leases fence stale completion. A singleton processor lease keeps active compression at one across restarts. Each encode runs in a killable child process with a deadline; cancelling or stopping cannot update application records. A crash after output insertion is safe because an identical output insert reuses the unique image. The processor removes successful source files after durable completion and intermediate directories after each attempt. Cleanup sweeps terminal and abandoned files; it does not remove files for active jobs. TTL is set only after filesystem cleanup, never as a substitute for it.

**Stored images are intentionally not automatically garbage-collected**, including unattached completed uploads. This avoids racing drafts, orders, pending forms and concurrent saves. Monitor collection growth. Any future stored-image reclamation must implement an atomic reference/retirement protocol across all those consumers. Do not delete image documents or the staging volume during rollback.

## Development

Use Node 24 (the shell's Node 20 is too old for installed testing tools). Keep test commands separate from any production credentials.

Build the pinned metric in Docker:

```sh
docker build -f deploy/Dockerfile.images --target metric -t farm-image-metric:0.11.1 .
```

For native same-host development, install CMake, Ninja, a C++ compiler and PNG/JPEG/GIF/WebP/Brotli/LCMS development libraries. Follow the exact checkout/submodule/CMake commands in `Dockerfile.images`. Keep the build tree available with its libraries. Set `SSIMULACRA2_BIN` to the absolute executable path.

In the backend shell, configure the development MongoDB, persistent `IMAGE_STAGING_DIR`, and settings from `.env.images.example`; use a private directory owned by the service account, mode 0700. Then:

```sh
npm ci
npm run build
npm run dev          # HTTP API and image processing together
```

Production executable commands are `npm start` (API and processing together). The API and processor both use the application's `MissVBusiness` database in normal operation. The executable processor test uses only the fresh Testcontainer URI supplied by its harness.

## Same-server deployment (configuration supplied, not deployed)

A single `npm start` now starts HTTP and the image processor using the same database connection. The supplied Compose configuration runs one API service with persistent staging. An always-running backend and durable staging are required. Multiple API replicas must share staging; otherwise use durable source storage such as GridFS before scaling. Ephemeral or request-only hosting cannot guarantee queued-upload recovery.

1. Copy `deploy/.env.images.example` to `deploy/.env.images` and supply the real application configuration privately. It is gitignored and excluded from the Docker build context. Preserve existing email and public-site settings too.
2. Build with `docker compose -f deploy/compose.images.yaml build api`.
3. Start with `docker compose -f deploy/compose.images.yaml up -d api --remove-orphans`.
4. Configure the existing HTTPS reverse proxy to the loopback API port. Allow at least the configured upload bytes, do not buffer large uploads in API memory, and allow at least 35 seconds for receipt. Keep image endpoint cache revalidation intact.
5. Verify authenticated `GET /api/images/health` reports a recent processor heartbeat. Check `docker compose -f deploy/compose.images.yaml logs api` and a disposable uploaded test record before enabling the feature for users.

Compose provides `restart: unless-stopped`, an init process, 45-second graceful stops, a combined 2304 MiB API memory limit and 2 CPU limit. Encoder children share the API's cgroup, so native allocations are bounded as well as the JS heap. The persistent volume is initialized for UID 1000, private mode 0700. Back up MongoDB and the persistent staging volume together; preserve queued sources through restarts. Never use `compose down -v` for an application restart. Concurrency is intentionally restricted to 1; increase capacity through calibration rather than spawning additional encoders.

All configurable values are enumerated in `.env.images.example`. Configuration changes create a new pipeline fingerprint. Drain jobs before changing compression settings; old jobs encountered by an incompatible pipeline fail and can be reuploaded. The Docker base is digest-pinned. Package-lock and the SSIMULACRA2 source commit pin the implementation; OS package mirrors still determine exact system package revisions at rebuild time.

## Verification

All DB tests call `startTestDatabase`, which starts a new MongoDB 8.0.16 replica-set Testcontainer and constructs its URI itself. It never uses `MONGODB_URI` from `.env`. Processor test processes receive only that freshly allocated database address. Do not replace this fixture with an existing development or production database.

With the pinned metric available:

```sh
npm run build
SSIMULACRA2_BIN=/absolute/path/to/ssimulacra2 npm test
SSIMULACRA2_BIN=/absolute/path/to/ssimulacra2 npm run test:integration
npm run check
npm run typecheck:tests
npm run test:architecture
```

`tests/image-quality.test.ts` skips its native metric case only when running ordinary unit tests without `SSIMULACRA2_BIN`; the separate executable-processor integration suite fails clearly when it is missing. Unit tests cover pixel/animation/orientation/resize/alpha rules, non-monotonic candidate selection and missing-tool failure. Disposable integration covers durable admission, ready attachment, access and publishing, concurrent deduplication, expired leases, stale completion, retry exhaustion, insertion-before-completion recovery, safe cleanup and failed replacements. The actual processor tests exercise codec/metric execution and restart recovery. Frontend tests exercise pending-save blocking, stale selection, failed upload retention and existing URL/embed handling. One stale checkout query mock was repaired so existing checkout tests support both query chaining and awaiting.

For a manual browser fixture, build first, then run `FRONTEND_URL=http://127.0.0.1:5179 NODE_ENV=test EMAIL_PROVIDER=console JWT_SECRET=isolated-test-secret-not-for-production SSIMULACRA2_BIN=/absolute/path/to/ssimulacra2 npx tsx tests/support/image-server.ts`. It creates a new disposable database, seeds test credentials from `tests/support/seed.ts`, starts the processor and API on 4139, and cleans up on SIGTERM/SIGINT. Point Vite at `VITE_API_URL=http://127.0.0.1:4139/api`. This fixture must never be exposed publicly.

Benchmark command (no database):

```sh
SSIMULACRA2_BIN=/absolute/path/to/ssimulacra2 node scripts/benchmark-images.mjs /path/to/authorized-image.png
```

See `benchmark-images.json` and `IMAGE-VERIFICATION.md` for actual local evidence and sample limitations. Production deployment, live credentials, real customer data, device/browser coverage beyond the recorded checks, and representative farm-photo calibration are not implied by local tests.

## Rollback

On startup, missing staging or SSIMULACRA2 disables new uploads with HTTP 503; the API and existing image delivery remain available. Fix the configuration and restart the backend to enable processing. The owner-only image health endpoint reports local readiness, the global lease heartbeat, queue counts, and recent failures for the current business.

When migrating from the old two-service deployment, stop the old worker first, retain the staging volume and database, then start the updated API. Keep the existing `image-worker` lock identifier and pipeline fingerprint so queued jobs and source-cache entries remain compatible. The Compose `--remove-orphans` option removes the obsolete service; never pass `-v` when restarting.

Stop new upload admission by removing the image configuration from the API environment, while keeping the image delivery code deployed. Drain pending jobs before disabling uploads, or stop the backend gracefully and retain staged sources until processing is enabled again. Revert frontend upload controls if necessary, but retain support for existing `/api/images/<id>` references. A complete rollback to code predating image delivery will break those references: retain a compatibility delivery service or first migrate affected references through an explicitly authorized migration. Do not delete collections, documents, drafts, snapshots or the persistent volume. Existing URL/embed-only records need no migration.
