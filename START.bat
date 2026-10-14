@echo off
title CROWN ASIA WhatsApp OTP V2 - BAILEYS
cd /d "%~dp0"
if not exist ".env" (echo Run INSTALL.bat first.& pause& exit /b 1)
node server.mjs
pause
