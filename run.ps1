# Start the Quant Trading Model web app on http://127.0.0.1:8000
Set-Location -Path $PSScriptRoot
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
