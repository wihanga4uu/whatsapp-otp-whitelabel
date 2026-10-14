@echo off
setlocal EnableExtensions EnableDelayedExpansion
title WhatsApp V2.4 White-Label - Installer
cd /d "%~dp0"
echo ============================================================
echo  WHATSAPP V2.4 - WHITE-LABEL TEMPLATES
echo  OTP + MESSAGES + BRANDING + TEMPLATES
echo ============================================================
where node >nul 2>&1
if %errorlevel% neq 0 (echo [ERROR] Node.js is not installed.& pause& exit /b 1)
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set NODEMAJOR=%%V
if !NODEMAJOR! LSS 20 (echo [ERROR] Node.js 20+ required.& node -v& pause& exit /b 1)
node -v
call npm.cmd install --no-fund
if %errorlevel% neq 0 (echo [ERROR] npm install failed.& pause& exit /b 1)
node --check server.mjs
if %errorlevel% neq 0 (echo [ERROR] server.mjs syntax error.& pause& exit /b 1)
if not exist ".env" (
  for /f "delims=" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=New-Object byte[] 12; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b|ForEach-Object ToString x2)-join ''"') do set "ADMINPASS=%%A"
 for /f "delims=" %%K in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b|ForEach-Object ToString x2)-join ''"') do set "KEY=%%K"
 >".env" (
  echo PORT=3000
  echo BIND_HOST=127.0.0.1
  echo API_KEY=!KEY!
    echo ADMIN_PASSWORD=!ADMINPASS!
  echo BUSINESS_NAME=CROWN ASIA
  echo BUSINESS_WEBSITE=
  echo SUPPORT_CONTACT=
  echo OTP_EXPIRY_SECONDS=300
  echo OTP_RESEND_SECONDS=60
  echo MAX_VERIFY_ATTEMPTS=5
  echo AUTO_RECONNECT=true
  echo RECONNECT_MIN_SECONDS=3
  echo RECONNECT_MAX_SECONDS=60
  echo HEALTH_CHECK_SECONDS=30
  echo STALE_CONNECTION_SECONDS=180
 )
)
echo.
echo INSTALL COMPLETE
echo Admin panel: http://127.0.0.1:3000/admin
if defined ADMINPASS echo Generated ADMIN_PASSWORD: !ADMINPASS!
echo Keep API_KEY and ADMIN_PASSWORD private.
pause
