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
