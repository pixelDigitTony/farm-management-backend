# Local Docker image processing

Start Docker Desktop with its Linux engine, then run these commands from the backend directory in PowerShell:

`npm start` and `npm run dev` now select this Docker setup automatically on Windows. They build/start the backend on port 4001 and return when the container starts. Run them again after code edits; Windows Docker development does not currently watch files. On Linux, the commands retain native compiled startup and TypeScript file watching respectively.

Do not run `node dist/server.js` directly on Windows with the Linux SSIMULACRA2 path. If a native backend is already running on port 4000, stop it with Ctrl+C in its terminal. The frontend local API setting should point to port 4001.

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File scripts/images-local.ps1 start
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File scripts/images-local.ps1 verify
```

The API is available at http://localhost:4001/api. Set the frontend's local `VITE_API_URL` to `http://localhost:4001/api` and restart Vite if it does not reload automatically. Port 4000 is left available for the existing Windows backend.

The local Compose service reads the backend's existing `.env`, including its database and authentication settings. It overrides the image executable/staging paths for Linux, enables development mode, and uses a named persistent staging volume. No separate worker is started. Use a development database for testing; this setup uses whichever database is configured in `.env`.

The `verify` command generates a temporary image, checks SSIMULACRA2 against an identical reference, and runs the actual encoder subprocess. It never connects to the database and removes its temporary files.

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File scripts/images-local.ps1 logs
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File scripts/images-local.ps1 stop
```

Run `start` again after backend code changes to rebuild the image. Keep the staging volume when stopping/restarting. This setup installs SSIMULACRA2 inside Docker; it does not provide a Windows executable for native `npm run dev`.

## Rust build and staging verification

The image Dockerfile now includes a pinned Rust build stage and packages both processors. The default remains `IMAGE_PROCESSOR=sharp`. For an isolated local Rust test, set `IMAGE_PROCESSOR=rust` and `IMAGE_RUST_BIN=/usr/local/bin/farm-image-processor` in the local backend configuration, drain existing jobs before switching, then rebuild using the existing local start command. The engine self-test must pass before uploads become ready. Preserve the staging volume.

Use `IMAGE_UPLOADS_ENABLED=false` to pause new uploads during a drain; it leaves the processing loop and image delivery running. Existing frontend API requests are compatible with either engine. See [IMAGES.md](IMAGES.md) for the offline comparison harness and [RUST-IMAGE-PROCESSING-SPEC.md](RUST-IMAGE-PROCESSING-SPEC.md) for acceptance and rollback requirements.

`deploy/Dockerfile.images-test` builds a verification layer over the locally built `farm-images-rust:verification` production image, with development dependencies and integration fixtures. It runs the three image suites as the non-root `node` user. Direct Windows upload tests cannot validate POSIX staging permissions; use this Linux runner.

The default database fixture uses Testcontainers. For a runner without Docker-daemon access, the host can provision a fresh MongoDB 8.0.16 replica set on an internal network under alias `image-test-mongo`. Initialize replica set `rs0` with member `image-test-mongo:27017`, then insert `{kind:'farm-image-test-fixture/v1',nonce:'<32 lowercase hex characters>'}` into `admin.farm_image_test_context`. Mount a matching JSON context read-only at `/tmp/farm-image-test-context.json` and set `TEST_IMAGE_DATABASE_CONTEXT` to that exact path. The helper verifies this marker before creating indexes and chooses a fresh random test database per suite; it accepts no external connection URI. Do not use an existing application MongoDB instance for this mode. Keep the runner and MongoDB on the private network, publish no database ports, and remove the disposable network/container afterward.
