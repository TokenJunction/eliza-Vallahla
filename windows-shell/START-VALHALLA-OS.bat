@echo off
TITLE ValhallaOS Akershus
COLOR 0B
CD /D "%~dp0"
echo Akershus customer channel only. This launcher does not install the overseer channel.
set "VALOS_URL=https://valhalla-app.xyz/os/"
set "VALOS_CODE="
for /f %%C in ('curl -sS -o NUL -w "%%{http_code}" --max-time 15 "%VALOS_URL%"') do set "VALOS_CODE=%%C"
if "%VALOS_CODE%"=="200" (
  echo [OK] Public desk returned HTTP 200.
) else (
  echo [!] Public desk check failed. HTTP %VALOS_CODE%. Not reported as online.
)
start "" msedge --app="%VALOS_URL%" 2>nul
if %errorlevel%==0 goto opened
start "" chrome --app="%VALOS_URL%" 2>nul
if %errorlevel%==0 goto opened
start "" "%VALOS_URL%"
:opened
echo Sign-in is the public gate at https://valhalla-app.xyz/app/
echo This file does not put an email in the URL.
pause >nul
exit /b 0
