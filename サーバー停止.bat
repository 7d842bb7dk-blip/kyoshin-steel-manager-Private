@echo off
rem ============================================================
rem  Kyoshin Steel Manager - stop the server (port 3001)
rem  Kills the node server AND its daemon loop, so it stays
rem  stopped until next logon (or until server-daemon.bat is run).
rem ============================================================
setlocal
echo Stopping Kyoshin Steel Manager server (port 3001) ...
powershell -NoProfile -Command "$l = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue; if (-not $l) { Write-Host 'Server is not running.'; exit 0 }; foreach ($p in @($l.OwningProcess | Sort-Object -Unique)) { try { $par = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p)).ParentProcessId; if ($par) { $pp = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $par); if ($pp -and $pp.CommandLine -like '*server-daemon*') { Stop-Process -Id $par -Force -ErrorAction SilentlyContinue } } } catch {}; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; Write-Host 'Server stopped.'"
pause
