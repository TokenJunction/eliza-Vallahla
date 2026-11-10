@echo off
CD /D "%~dp0"
call "%~dp0Install-and-Launch.bat"
exit /b %errorlevel%
