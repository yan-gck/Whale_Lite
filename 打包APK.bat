@echo off
rem ============================================================
rem  Build Android APK (double-click to run)
rem
rem  Kept pure ASCII on purpose: cmd.exe parses .bat files using the
rem  console OEM codepage, and non-ASCII text can make the parser lose
rem  its position (garbled "not recognized" errors). All Chinese
rem  messages come from tools\launcher.ps1.
rem
rem  Prerequisites: JDK 17 + Android SDK
rem  Output: <workspace>\Whale-Lite-<suffix>\listening-player-lite.apk
rem          (the suffix is Chinese: "shou-ji-ban" = mobile edition; kept out
rem           of this file on purpose -- see the ASCII note above)
rem          (see tools\paths.js -- deliverables live outside the project folder
rem           because a Chinese path inside this project would break the temp
rem           .bat files the build script uses to call aapt2/apksigner)
rem ============================================================

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [error] Node.js not found. Please install it from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if exist "tools\launcher.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launcher.ps1" apk

if not exist "node_modules" (
  echo   Installing dependencies...
  call npm install --no-audit --no-fund
)

echo   Building... this can take a few minutes with a large audio library.
echo.

node tools\build-apk.js %*

echo.
pause
