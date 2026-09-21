@echo off
rem ============================================================
rem  Kyoshin Steel Manager - DEV server (for coding on any PC)
rem  Port 3002 / DB: server\data-dev (separate from production)
rem  Open http://localhost:3002/ in your browser.
rem  Stop: Ctrl+C or close this window.
rem ============================================================
setlocal
cd /d "%~dp0"
if not exist "node_modules" (
  echo node_modules not found - running npm install...
  call npm install
)
node server\dev.js
pause
