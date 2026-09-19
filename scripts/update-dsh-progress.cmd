@echo off
chcp 65001 >nul
rem ---------------------------------------------------------------------------
rem  update-dsh-progress.cmd -- upgrade the dsh runtime, with a progress bar.
rem
rem  Wraps scripts\update-dsh-progress.ps1 (which wraps the official
rem  data\downloads\update-dsh.mjs). Shows a bar + percentage + current stage.
rem
rem  IMPORTANT: fully quit the app first (tray icon -> Exit). The official
rem  script refuses to swap runtime\dsh while the app is running, to avoid
rem  corrupting files that are still in use.
rem
rem  Usage:
rem    update-dsh-progress.cmd                upgrade to the latest version
rem    update-dsh-progress.cmd -DryRun        probe only, change nothing
rem    update-dsh-progress.cmd -Version 0.1.6-alpha.2
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
if exist "%HERE%update-dsh-progress.ps1" (
  set "PS1=%HERE%update-dsh-progress.ps1"
) else if exist "%HERE%..\scripts\update-dsh-progress.ps1" (
  set "PS1=%HERE%..\scripts\update-dsh-progress.ps1"
) else (
  echo [ERROR] update-dsh-progress.ps1 not found next to this script.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"
echo.
echo exit code: %RC%
pause
exit /b %RC%
