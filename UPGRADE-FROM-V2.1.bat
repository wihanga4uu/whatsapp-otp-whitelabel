@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title CROWN ASIA V2.2 Upgrade Helper

echo Enter your CURRENT working V2/V2.1 folder path.
echo Example: C:\CROWN-ASIA-WhatsApp-OTP-V2-BAILEYS
set /p OLD=Old folder: 

if not exist "!OLD!\.env" (
  echo ERROR: .env not found in !OLD!
  pause
  exit /b 1
)

copy /Y "!OLD!\.env" ".env" >nul

if exist "!OLD!\baileys_auth_info" (
  xcopy /E /I /Y "!OLD!\baileys_auth_info" "baileys_auth_info" >nul
  echo Session copied. QR should normally NOT be required.
) else (
  echo No baileys_auth_info folder found. A new QR may be required.
)

echo.
echo Upgrade data copied successfully.
echo Run INSTALL.bat once, then START-AUTO.bat.
pause
