@echo off
rem Development launcher: runs dev.ps1 without needing a changed PowerShell execution policy.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1"
