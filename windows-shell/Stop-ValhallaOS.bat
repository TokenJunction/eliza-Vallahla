@echo off
title Stop ValhallaOS Citadel
echo Stopping leftover local ValhallaOS background services...
taskkill /f /im bun.exe >nul 2>nul
taskkill /f /fi "WINDOWTITLE eq ValhallaOS*" >nul 2>nul
taskkill /f /fi "WINDOWTITLE eq ValOS*" >nul 2>nul
echo Local leftover processes stopped. The public website is unchanged.
timeout /t 1 /nobreak >nul
exit /b 0
