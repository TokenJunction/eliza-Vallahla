@echo off
TITLE ValhallaOS Akershus Master Installer
CD /D "%~dp0"
echo Akershus customer installer. This does not install the overseer channel.
call "%~dp0START-VALHALLA-OS.bat"
exit /b %errorlevel%
