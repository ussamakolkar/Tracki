@echo off
REM Start Tracki. Double-click this file, or make a desktop shortcut to it.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
echo Starting Tracki...
node server\index.js
pause
