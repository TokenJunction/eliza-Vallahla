@echo off
TITLE ValhallaOS Install and Launch
COLOR 0B
CD /D "%~dp0"

echo =======================================================================
echo   ValOS // desktop shortcut to the public OS
echo =======================================================================

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "LAUNCHER=%HERE%\START-VALHALLA-OS.bat"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $desk = [Environment]::GetFolderPath('Desktop'); $s = $ws.CreateShortcut((Join-Path $desk 'ValhallaOS Citadel.lnk')); $s.TargetPath = '%LAUNCHER%'; $s.WorkingDirectory = '%HERE%'; $s.Description = 'ValOS public workstation'; $s.Save()"

echo [OK] Desktop shortcut 'ValhallaOS Citadel' starts the public OS.
echo     Laptops and full-time nodes use this same launcher.
call "%LAUNCHER%"
