@echo off
REM ============================================================================
REM  dsh-music-player - one-click install (Windows)
REM  Pure ASCII on purpose: PowerShell 5.1 reads .cmd/.ps1 as GBK and would
REM  garble any Chinese text here.
REM ============================================================================
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo [FAILED] see the messages above.
  pause
  exit /b 1
)
echo.
pause
endlocal
