@echo off
cd /d "%~dp0"
if not exist ".otp-bot.lock" (echo Bot is not running.& pause& exit /b 0)
set /p BOTPID=<".otp-bot.lock"
taskkill /PID %BOTPID% /T /F
del /f /q ".otp-bot.lock" >nul 2>&1
pause
