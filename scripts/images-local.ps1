param([ValidateSet('start', 'stop', 'logs', 'verify')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$backendDirectory = Split-Path -Parent $PSScriptRoot
$dockerDirectory = 'C:\Program Files\Docker\Docker\resources\bin'
if (Test-Path -LiteralPath $dockerDirectory) { $env:Path += ";$dockerDirectory" }
$composeFile = Join-Path $backendDirectory 'deploy\compose.images.local.yaml'
switch ($Action) {
    'start' { & docker compose -f $composeFile up -d --build api }
    'stop' { & docker compose -f $composeFile stop api }
    'logs' { & docker compose -f $composeFile logs --tail 50 -f api }
    'verify' {
        $smokeScript = Join-Path $backendDirectory 'scripts\image-smoke.mjs'
        & docker compose -f $composeFile run --rm --no-deps -T -v "${smokeScript}:/app/scripts/image-smoke.mjs:ro" api node /app/scripts/image-smoke.mjs
    }
}
exit $LASTEXITCODE
