@echo off
title 4AM Discord Bot
color 0b
echo ==============================================
echo       4AM DISCORD BOT - STARTING SYSTEM
echo ==============================================
echo.
cd /d "%~dp0"
node src/bot.js
pause
