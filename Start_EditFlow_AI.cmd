@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "RUNNER=%SCRIPT_DIR%tools\start_editflow.ps1"

if not exist "%RUNNER%" (
    echo EditFlow AI launcher could not find:
    echo   %RUNNER%
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%RUNNER%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo EditFlow AI launcher exited with code %EXIT_CODE%.
    pause
)

exit /b %EXIT_CODE%
