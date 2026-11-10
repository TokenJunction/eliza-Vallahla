@echo off
title Stop ValhallaOS Akershus
echo Stopping leftover local bun.exe only. The public website is unchanged.
echo This does not stop the overseer channel and does not change DNS or secrets.
taskkill /f /im bun.exe >nul 2>nul
exit /b 0
