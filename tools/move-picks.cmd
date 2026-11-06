@echo off
rem Drag a shoot folder onto this file (or a shortcut to it): shows what would move,
rem then asks before moving anything.
if "%~1"=="" (
  echo Drag a shoot folder onto this file.
  pause
  exit /b
)
set "SCRIPT=%~dp0move-picks.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" "%~1"
if errorlevel 1 (
  pause
  exit /b
)
echo.
choice /m "Move these files into Picks"
if errorlevel 2 exit /b
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" "%~1" -Apply
pause
