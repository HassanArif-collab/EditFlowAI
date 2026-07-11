@echo off
title EditFlow AI AE Backend
echo ==================================================
echo   EditFlow AI AE - Starting Backend Server
echo ==================================================
echo.

:: Kill existing backend on port 8765
echo Checking for existing backend...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765 " ^| findstr "LISTENING"') do (
    echo Killing existing backend (PID %%a)...
    taskkill /F /PID %%a >nul 2>&1
    timeout /t 1 /nobreak >nul
)

echo Starting EditFlow AI AE backend...
echo.
echo Keep this window open while you use the panel in After Effects.
echo.
cd /d "F:\AI_VIDEO_AUTOMATION\EditFlowAI"
"F:\AI_VIDEO_AUTOMATION\EditFlowAI\.venv\Scripts\python.exe" run.py --prod
pause
