@echo off
rem ============================================================
rem  Listening Player - Windows launcher (double-click to run)
rem
rem  Why this file is pure ASCII:
rem    cmd.exe parses a .bat file byte-by-byte using the console's
rem    OEM codepage. If the file contains non-ASCII text (Chinese),
rem    the parser can lose its position and end up executing garbled
rem    fragments such as "'o' is not recognized" or
rem    "'http:' is not recognized" - which is exactly the bug that
rem    made this launcher fail.
rem    All user-facing Chinese text is printed by a PowerShell helper
rem    instead, so cmd never has to parse a non-ASCII byte.
rem
rem  Optional first argument: port number (default 4180)
rem ============================================================

setlocal
cd /d "%~dp0"

if exist "tools\launcher.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launcher.ps1" welcome

rem ---------- 1. check Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  if exist "tools\launcher.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launcher.ps1" nonode
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo   Node.js %NODEV%

rem ---------- 2. check dependencies ----------
if not exist "node_modules" (
  echo.
  echo   Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 echo   [warn] dependency install failed - PDF text extraction will be unavailable.
)

rem ---------- 3. check audio assets ----------
rem
rem  Bug fixed here: the previous version did
rem      set HAS_AUDIO=0
rem      if exist "audio" (
rem        for /f %%c in (...) do set DIRCNT=%%c
rem        if !DIRCNT! GTR 0 set HAS_AUDIO=1
rem      )
rem      if "%HAS_AUDIO%"=="0" ( ...generate demo... )
rem  Two problems: %HAS_AUDIO% is expanded at parse time (so it never
rem  sees the value set inside the block), and `setlocal` here does NOT
rem  enable delayed expansion. Net effect: the demo generator ran even
rem  though the audio library was already full.
rem  Now uses `dir` exit codes via || / && , which need no variables.
set NEED_DEMO=0
dir /b /ad "audio" >nul 2>nul || set NEED_DEMO=1
if "%NEED_DEMO%"=="1" (
  dir /b /a-d "audio" >nul 2>nul || set NEED_DEMO=2
)

if "%NEED_DEMO%"=="2" (
  echo.
  echo   No listening material found. Generating the demo pack...
  echo   This uses the built-in Windows speech engine and takes 1-3 minutes.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "tools\make-demo.ps1"
  if errorlevel 1 (
    echo.
    echo   [warn] demo generation failed. The player will still start.
    echo.
  )
) else (
  echo   Audio library found - skipping demo generation.
)

rem ---------- 4. pick port ----------
set PORT=4180
if not "%~1"=="" set PORT=%~1

if exist "tools\launcher.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launcher.ps1" starting %PORT%

rem ---------- 5. start server, then open the browser ----------
rem
rem  History of this line - it used to be:
rem    start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:!PORT!"
rem  Two separate bugs:
rem    a) cmd strips only one layer of quotes after /c, so the inner ""
rem       was swallowed as an empty title and the URL became a *filename*,
rem       producing "Windows cannot find 127.0.0.1:4180".
rem    b) "timeout" reads stdin inside a batch context, which is fragile.
rem  Now each step has a single layer of quoting.
start "" /b node server.js

rem wait ~2s for the server to come up
ping -n 3 127.0.0.1 >nul

rem URL MUST stay quoted, or Windows treats it as a file to open
start "" "http://127.0.0.1:%PORT%/"

if exist "tools\launcher.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launcher.ps1" ready %PORT%

rem keep this window alive so node's log keeps streaming
pause >nul
