@echo off
TITLE ValhallaOS Citadel Quick Patch Updater
COLOR 0B
CD /D "%~dp0"

echo =======================================================================
echo   ValOS // open the current public workstation
echo =======================================================================

set "VALOS_URL=https://valhalla-app.xyz/os/"
set "VALOS_CODE="

echo [Patch] Stopping a leftover local Bun server if one is still running...
taskkill /f /im bun.exe >nul 2>nul

echo [Patch] Checking the live OS...
for /f %%C in ('curl -sS -o NUL -w "%%{http_code}" --max-time 15 "%VALOS_URL%"') do set "VALOS_CODE=%%C"
if not "%VALOS_CODE%"=="200" (
  echo [!] Update check failed. HTTP %VALOS_CODE%. The public OS was not reachable.
  echo     Not reported as online. Fix the network, then run this updater again.
  pause
  exit /b 1
)

echo [Patch] HTTP 200. Opening the current production workstation.
start "" msedge --app="%VALOS_URL%" --window-size=1280,820 2>nul
if %errorlevel%==0 goto done
start "" chrome --app="%VALOS_URL%" --window-size=1280,820 2>nul
if %errorlevel%==0 goto done
start "" "%VALOS_URL%"

:done
echo [OK] This node is pointed at the live OS. The website files were not changed here.
timeout /t 2 /nobreak >nul
exit /b 0
