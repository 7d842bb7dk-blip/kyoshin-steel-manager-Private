@echo off
rem ============================================================
rem  Kyoshin Steel Manager - update & deploy (run on server PC)
rem  1) git pull (fast-forward only)
rem  2) restart the node server (daemon auto-restarts it)
rem ============================================================
setlocal
cd /d "%~dp0"

echo === git pull ===
git pull --ff-only
if errorlevel 1 (
  echo.
  echo [ERROR] git pull failed. Check network or resolve conflicts first.
  pause
  exit /b 1
)

echo.
echo === restart server ===
powershell -NoProfile -Command "$l=Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue; if($l){Stop-Process -Id ($l.OwningProcess | Select-Object -First 1) -Force; Write-Host 'stopped old server'} else {Write-Host 'server was not running'}"
echo waiting for daemon to restart it (about 12 seconds)...
timeout /t 12 /nobreak >nul

powershell -NoProfile -Command "exit @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue).Count"
if "%errorlevel%"=="0" (
  echo daemon is not running - starting it now...
  start "" wscript.exe "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\kyoshin-steel.vbs"
  timeout /t 8 /nobreak >nul
)

echo.
echo === health check ===
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://localhost:3001/api/health' -UseBasicParsing -TimeoutSec 5).Content } catch { 'NG: ' + $_.Exception.Message }"
echo.
pause
