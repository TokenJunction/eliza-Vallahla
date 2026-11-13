@echo off
TITLE Update ValhallaOS Akershus
CD /D "%~dp0"
echo Akershus customer channel only. The overseer channel is not part of this update.
set "VALOS_URL=https://valhalla-app.xyz/os/"
set "VALOS_CODE="
for /f %%C in ('curl -sS -o NUL -w "%%{http_code}" --max-time 15 "%VALOS_URL%"') do set "VALOS_CODE=%%C"
if not "%VALOS_CODE%"=="200" (
  echo [!] Update check failed. HTTP %VALOS_CODE%. Not reported as online.
  pause
  exit /b 1
)
echo [OK] HTTP 200. Opening the public Akershus desk.
start "" "%VALOS_URL%"
exit /b 0
