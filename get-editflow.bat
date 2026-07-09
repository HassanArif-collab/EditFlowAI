<# :
@echo off
:: ============================================================================
:: EditFlow AI — Quick Installer (downloads and runs the full installer)
:: ============================================================================
:: This is a tiny bootstrap that downloads the real installer from GitHub
:: and runs it. Useful for sharing a short link.
:: ============================================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-Content '%~f0') -join \"`n\")"
if %ERRORLEVEL% NEQ 0 pause
exit /b
#>

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Write-Host ""
Write-Host "  EditFlow AI — Downloading installer..." -ForegroundColor Cyan
Write-Host ""

$installerUrl = "https://raw.githubusercontent.com/HassanArif-collab/EditFlowAI/feat/native-animated-captions/install-editflow.bat"
$tempPath = "$env:TEMP\editflow-full-installer.bat"

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
