@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Installing the LTS version with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Node.js installed. Close this window and double-click BUILD-INSTALLER.bat again.
  pause
  exit /b
)
call npm install
if errorlevel 1 goto fail
call npm run dist
if errorlevel 1 goto fail
echo.
echo DONE. Your installer is in the "release" folder.
start "" release
pause
exit /b
:fail
echo.
echo Build failed. Check your internet connection and try again (right-click this file, Run as administrator, if it still fails).
pause
