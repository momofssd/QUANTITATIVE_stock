@echo off
rem Production-style run: build the React app if needed, then serve UI + API on http://127.0.0.1:8000
cd /d "%~dp0"
if not exist "frontend\node_modules" (pushd frontend & call npm install & popd)
if not exist "frontend\dist\index.html" (pushd frontend & call npm run build & popd)
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
