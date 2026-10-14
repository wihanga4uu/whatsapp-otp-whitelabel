@echo off
setlocal EnableDelayedExpansion
title WhatsApp V2.4 - Upgrade from V2.3
cd /d "%~dp0"

echo ============================================================
echo  WHATSAPP V2.4 WHITE-LABEL - UPGRADE FROM V2.3
echo ============================================================
echo.
set /p OLDPATH=Enter your V2.3 folder path: 

if not exist "%OLDPATH%\.env" (
  echo [ERROR] .env not found in that folder.
  pause
  exit /b 1
)

copy /Y "%OLDPATH%\.env" ".env" >nul

if exist "%OLDPATH%\baileys_auth_info" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Copy-Item -LiteralPath '%OLDPATH%\baileys_auth_info' -Destination '.\baileys_auth_info' -Recurse -Force"
)

if exist "%OLDPATH%\brand-settings.json" copy /Y "%OLDPATH%\brand-settings.json" "brand-settings.json" >nul

echo.
echo Session and configuration copied.
echo Run INSTALL.bat, then START-AUTO.bat.
pause
endlocal
