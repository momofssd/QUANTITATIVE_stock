# Production-style run: build the React app if needed, then serve UI + API on http://127.0.0.1:8000
Set-Location -Path $PSScriptRoot
if (-not (Test-Path "frontend\node_modules")) { Push-Location frontend; npm install; Pop-Location }
if (-not (Test-Path "frontend\dist\index.html") -or $args -contains "-Build") { Push-Location frontend; npm run build; Pop-Location }
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
