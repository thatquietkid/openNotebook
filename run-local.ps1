param(
    [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSCommandPath
$pythonExe = Join-Path $projectRoot '.venv\Scripts\python.exe'
$venvPath = Join-Path $projectRoot '.venv'
$requirementsPath = Join-Path $projectRoot 'backend\requirements-local.txt'
$env:UV_CACHE_DIR = Join-Path $projectRoot '.uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $projectRoot '.uv-python'

$needsInstall = -not (Test-Path -LiteralPath $pythonExe)
if (-not $needsInstall) {
    & $pythonExe -c 'import fastapi, httpx, multipart, uvicorn, dotenv' 2>$null
    $needsInstall = $LASTEXITCODE -ne 0
}

if ($needsInstall) {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        throw 'uv is required for first-time local setup. Install uv, then rerun this script.'
    }

    uv venv $venvPath --python 3.12
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the local Python environment.' }

    uv pip install --python $pythonExe --requirement $requirementsPath
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install the local backend dependencies.' }
}

Push-Location (Join-Path $projectRoot 'backend')
try {
    & $pythonExe -m uvicorn app.main:app --host 127.0.0.1 --port $Port
}
finally {
    Pop-Location
}
