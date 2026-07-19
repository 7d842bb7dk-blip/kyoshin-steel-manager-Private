@echo off
rem ============================================================
rem  Kyoshin Steel Manager - server daemon (keeps it running)
rem  Restarts server\index.js if it ever exits (crash etc.).
rem  Launched hidden at logon by kyoshin-steel.vbs (shell:startup).
rem  To stop: run saabaa-teishi (server stop) .bat in this folder.
rem ============================================================
setlocal
cd /d "%~dp0"
title KyoshinSteelServerDaemon

rem Already running? Then exit (prevents double start).
powershell -NoProfile -Command "exit @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue).Count"
if not "%errorlevel%"=="0" exit /b 0

:loop
"C:\Program Files\nodejs\node.exe" server\index.js >> server\data\server.log 2>&1
rem Server exited - wait 10s and restart.
timeout /t 10 /nobreak >nul
rem If some other process took port 3001 meanwhile, give up.
powershell -NoProfile -Command "exit @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue).Count"
if not "%errorlevel%"=="0" exit /b 0
goto loop
