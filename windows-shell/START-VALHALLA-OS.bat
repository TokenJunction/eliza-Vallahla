@echo off
TITLE ValhallaOS Sovereign Citadel Launcher
COLOR 0B
CD /D "%~dp0"

echo =======================================================================
echo   ValOS // public workstation
echo   https://valhalla-app.xyz/os/
echo =======================================================================
echo.

set "VALOS_URL=https://valhalla-app.xyz/os/"
if /I "%VALOS_NODE%"=="laptop" set "VALOS_URL=%VALOS_URL%?node=laptop"
if /I "%VALOS_NODE%"=="full-time" set "VALOS_URL=%VALOS_URL%?node=full-time"
set "VALOS_CODE="

echo [*] Checking the public OS. A production deploy is the update for every node.
for /f %%C in ('curl -sS -o NUL -w "%%{http_code}" --max-time 15 "%VALOS_URL%"') do set "VALOS_CODE=%%C"

if "%VALOS_CODE%"=="200" (
  echo [OK] Public OS returned HTTP 200. Opening that deployed workstation.
) else (
  echo [!] Public OS check failed. HTTP %VALOS_CODE%. Not reported as online.
  echo     The window will still try to open. Stay on this URL only when it answers.
)

echo.
start "" msedge --app="%VALOS_URL%" --window-size=1280,820 2>nul
if %errorlevel%==0 goto opened
start "" chrome --app="%VALOS_URL%" --window-size=1280,820 2>nul
if %errorlevel%==0 goto opened
start "" "%VALOS_URL%"

:opened
echo.
echo   Desk:     https://valhalla-app.xyz/os/
echo   Entrance: https://valhalla-app.xyz/
echo   volOS:    https://valhalla-app.xyz/volos/
echo   Sign-in:  https://valhalla-app.xyz/app/
echo.
echo   Same desk for a browser, a laptop, or a full-time node.
echo   Optional label: set VALOS_NODE=laptop or VALOS_NODE=full-time before launch.
echo   Installer accepts a ValOS tar/zip with valos-app.json. A Flatpak is not converted.
echo   This launcher does not put an email in the URL and does not start a local server.
echo =======================================================================
pause >nul
exit /b 0
