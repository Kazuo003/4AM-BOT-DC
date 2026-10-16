@echo off
title 4AM Bot & Auto Updater (PM2)
cd /d %~dp0
echo ==============================================
echo   4AM SHOP DISCORD BOT - WINDOWS VPS LAUNCHER
echo ==============================================
echo.
echo Dang kiem tra dependencies...
call npm install
echo Dang cap nhat Prisma Client...
call npx prisma generate
echo.
echo Dang khoi chay Bot va Auto-Updater bang PM2...
call pm2 start ecosystem.config.js
call pm2 save
echo.
echo ==============================================
echo   HOAN TAT! Bot va Auto-Updater da chay ngam!
echo   Xem danh sach:  pm2 list
echo   Xem log bot:    pm2 logs 4am-bot
echo   Xem log update: pm2 logs 4am-updater
echo ==============================================
pause
