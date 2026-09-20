@echo off
rem ============================================================
rem  Download open listening resources (double-click to run)
rem
rem  Kept pure ASCII on purpose: cmd.exe parses .bat files using the
rem  console OEM codepage, and non-ASCII text can make the parser lose
rem  its position (garbled "not recognized" errors). All Chinese
rem  messages come from launcher.ps1.
rem
rem  Only sources whose licence clearly allows redistribution are
rem  included. See docs\resources.md for why CET/IELTS/TOEFL past-paper
rem  audio and TED are deliberately excluded.
rem
rem  Note on control flow: this script avoids "goto <label>" for the
rem  cancel path. A label placed on the very last line of a .bat can
rem  fail with "The system cannot find the batch label specified",
rem  because cmd needs something after the label. Handling "q" with an
rem  early exit keeps the flow linear and label-free.
rem ============================================================

setlocal
cd /d "%~dp0\.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [error] Node.js not found. Please install it from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if exist "tools\launcher.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launcher.ps1" download

set CHOICE=
set /p CHOICE=Select:

if /i "%CHOICE%"=="q" (
  echo.
  echo   Cancelled.
  echo.
  pause
  exit /b 0
)

set TARGET=
if "%CHOICE%"=="" set TARGET=all
if "%CHOICE%"=="1" set TARGET=amenglish
if "%CHOICE%"=="2" set TARGET=librivox
if "%CHOICE%"=="3" set TARGET=librispeech
if "%CHOICE%"=="4" set TARGET=voa

if not defined TARGET (
  echo.
  echo   Unrecognized choice: %CHOICE%
  echo   Valid values: 1, 2, 3, 4, or just press Enter for all.
  echo.
  pause
  exit /b 1
)

echo.
echo   Downloading (%TARGET%) ...
echo.

node tools\fetch-resources.js %TARGET%

if exist "tools\launcher.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launcher.ps1" download-done

pause
