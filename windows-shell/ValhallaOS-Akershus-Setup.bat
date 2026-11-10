@echo off
TITLE ValhallaOS Akershus Setup
CD /D "%~dp0"
echo Akershus customer setup. This does not install the overseer channel.
call "%~dp0START-VALHALLA-OS.bat"
exit /b %errorlevel%
