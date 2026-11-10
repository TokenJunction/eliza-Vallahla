@echo off
CD /D "%~dp0"
call "%~dp0START-VALHALLA-OS.bat"
exit /b %errorlevel%
