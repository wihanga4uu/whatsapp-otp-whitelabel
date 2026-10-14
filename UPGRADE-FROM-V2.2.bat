@echo off
setlocal EnableDelayedExpansion
title CROWN ASIA V2.3 - Upgrade from V2.2
cd /d "%~dp0"

echo ============================================================
echo  CROWN ASIA V2.3 - UPGRADE FROM V2.2
echo ============================================================
echo.
set /p OLDPATH=Enter your V2.2 folder path: 

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

findstr /B /C:"ADMIN_PASSWORD=" ".env" >nul 2>&1
if errorlevel 1 (
  for /f "delims=" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=New-Object byte[] 12; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b|ForEach-Object ToString x2)-join ''"') do set "ADMINPASS=%%A"
  echo ADMIN_PASSWORD=!ADMINPASS!>>".env"
  echo.
  echo New ADMIN_PASSWORD: !ADMINPASS!
  echo Save this password.
)

echo.
echo Session and .env copied.
echo Now run INSTALL.bat, then START-AUTO.bat.
pause
endlocal
