@echo off
:: ============================================================================
:: EditFlow AI — Quick Bootstrap Installer
:: ============================================================================
:: Downloads the full installer from GitHub and runs it.
:: ============================================================================

setlocal

set "PS1=%TEMP%\editflow_bootstrap_%RANDOM%.ps1"

:: Extract PowerShell portion to temp file (everything after the marker line)
powershell -NoProfile -Command "$lines = Get-Content -LiteralPath '%~f0'; $marker = ($lines | Select-String -Pattern '^# PS_SCRIPT_START$' | Select-Object -First 1).LineNumber; if ($marker) { $lines[($marker)..($lines.Count-1)] | Set-Content -LiteralPath '%PS1%' -Encoding UTF8 } else { Write-Host 'ERROR: marker not found'; exit 1 }"

if not exist "%PS1%" (
    echo.
    echo  ERROR: Could not extract bootstrap script.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

del "%PS1%" 2>nul
exit /b %ERRORLEVEL%

:: ============================================================================
:: PowerShell script starts here (extracted to temp .ps1 at runtime)
:: ============================================================================
# PS_SCRIPT_START
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Write-Host ""
Write-Host "  EditFlow AI - Downloading installer..." -ForegroundColor Cyan
Write-Host ""

$installerUrl = "https://raw.githubusercontent.com/HassanArif-collab/EditFlowAI/feat/native-animated-captions/install-editflow.bat"
$tempPath = Join-Path $env:TEMP "editflow-full-installer.bat"

try {
    Invoke-WebRequest -Uri $installerUrl -OutFile $tempPath -UseBasicParsing
    Write-Host "  Download complete. Launching installer..." -ForegroundColor Green
    Write-Host ""
    Start-Process -FilePath $tempPath -Wait
    Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
} catch {
    Write-Host "  Download failed: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Please download the installer directly from:" -ForegroundColor Yellow
    Write-Host "  $installerUrl" -ForegroundColor White
    Write-Host ""
    pause
}
