@echo off
setlocal
cd /d "%~dp0"
title WhatsApp V2.4 White-Label - AUTO RECONNECT

:loop
node server.mjs
set EXITCODE=%ERRORLEVEL%

echo.
echo [WATCHER] Bot process exited with code %EXITCODE%.
echo [WATCHER] Restarting in 5 seconds. Press Ctrl+C to stop.
timeout /t 5 /nobreak >nul
goto loop
