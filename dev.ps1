# Development: backend (auto-reload) in its own window + Vite dev server (hot reload) in this one.
# Open http://127.0.0.1:5173  (Vite proxies /api and /ws to the backend on :8000)
Set-Location -Path $PSScriptRoot

if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Backend already running on :8000"
} else {
    Write-Host "Starting backend on :8000 (separate window)..."
    Start-Process -FilePath "python" -WorkingDirectory $PSScriptRoot -ArgumentList @(
        "-m", "uvicorn", "backend.app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"
    )
    # Wait (up to 20 s) so Vite's first requests don't hit a closed port.
    for ($i = 0; $i -lt 40 -and -not (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue); $i++) {
        Start-Sleep -Milliseconds 500
    }
    if (-not (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)) {
        Write-Warning "Backend did not start - check its window for the error."
    }
}

if (-not (Test-Path "frontend\node_modules")) { Push-Location frontend; npm install; Pop-Location }
Push-Location frontend
npm run dev
Pop-Location
