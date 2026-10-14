@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
echo This removes the saved Baileys WhatsApp session.
choice /C YN /M "Continue"
if errorlevel 2 exit /b 0
if exist ".otp-bot.lock" (set /p BOTPID=<".otp-bot.lock"& taskkill /PID !BOTPID! /T /F >nul 2>&1& timeout /t 2 /nobreak >nul)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -LiteralPath '.\baileys_auth_info' -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '.\.otp-bot.lock' -Force -ErrorAction SilentlyContinue"
echo Session reset complete.
pause
