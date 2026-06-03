#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Installs the EditFlow AI CEP panel for Adobe Premiere Pro on Windows.

.DESCRIPTION
    Creates a symbolic link (junction) from the Premiere Pro extensions directory
    to the cep-panel folder in this repository. Requires Administrator privileges.

.NOTES
    - Run PowerShell as Administrator
    - Close Premiere Pro before running
    - After installation, enable unsigned extensions in the registry
#>

param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

# Extension ID must match manifest.xml
$ExtensionId = "com.editflow.ai"
$ExtensionName = "EditFlow AI"

# Find the cep-panel directory relative to this script
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CepPanelDir = Join-Path $ScriptDir "cep-panel"

# Adobe CEP extensions directory
$AdobeCepDir = Join-Path $env:APPDATA "Adobe\CEP\extensions"

# Target symlink path
$TargetDir = Join-Path $AdobeCepDir $ExtensionId

Write-Host "=== EditFlow AI - CEP Panel Installer ===" -ForegroundColor Cyan

# Validate cep-panel directory
if (-not (Test-Path $CepPanelDir)) {
    Write-Error "cep-panel directory not found at: $CepPanelDir"
    exit 1
}

# Validate manifest.xml exists
$Manifest = Join-Path $CepPanelDir "CSXS\manifest.xml"
if (-not (Test-Path $Manifest)) {
    Write-Error "manifest.xml not found at: $Manifest"
    exit 1
}

if ($Uninstall) {
    Write-Host "Uninstalling $ExtensionName..." -ForegroundColor Yellow
    if (Test-Path $TargetDir) {
        # Check if it's a junction/symlink
        $item = Get-Item $TargetDir
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $item.Delete()
            Write-Host "Removed junction link: $TargetDir" -ForegroundColor Green
        } else {
            Remove-Item -Recurse -Force $TargetDir
            Write-Host "Removed directory: $TargetDir" -ForegroundColor Green
        }
    } else {
        Write-Host "Extension not installed." -ForegroundColor Yellow
    }
    exit 0
}

# Install
Write-Host "Installing $ExtensionName..." -ForegroundColor Cyan

# Create Adobe CEP extensions directory if it doesn't exist
if (-not (Test-Path $AdobeCepDir)) {
    New-Item -ItemType Directory -Path $AdobeCepDir -Force | Out-Null
    Write-Host "Created CEP extensions directory: $AdobeCepDir" -ForegroundColor Green
}

# Remove existing installation if present
if (Test-Path $TargetDir) {
    $item = Get-Item $TargetDir
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $item.Delete()
    } else {
        Remove-Item -Recurse -Force $TargetDir
    }
    Write-Host "Removed existing installation." -ForegroundColor Yellow
}

# Create junction (symlink for directories)
cmd.exe /c "mklink /J `"$TargetDir`" `"$CepPanelDir`"" | Out-Null

if (Test-Path $TargetDir) {
    Write-Host "Created junction: $TargetDir -> $CepPanelDir" -ForegroundColor Green
} else {
    Write-Error "Failed to create junction. Make sure you're running as Administrator."
    exit 1
}

# Enable unsigned extensions in the registry
Write-Host "`nEnabling unsigned CEP extensions..." -ForegroundColor Cyan

$RegPaths = @(
    "HKCU:\SOFTWARE\Adobe\CSXS.11",
    "HKCU:\SOFTWARE\Adobe\CSXS.10",
    "HKCU:\SOFTWARE\Adobe\CSXS.9"
)

foreach ($RegPath in $RegPaths) {
    if (-not (Test-Path $RegPath)) {
        New-Item -Path $RegPath -Force | Out-Null
    }
    Set-ItemProperty -Path $RegPath -Name "PlayerDebugMode" -Value 1 -Type String -Force
    Write-Host "  Set PlayerDebugMode=1 in $RegPath" -ForegroundColor Green
}

Write-Host "`n=== Installation Complete! ===" -ForegroundColor Green
Write-Host @"

Next steps:
1. (Re)start Adobe Premiere Pro
2. Go to Window > Extensions > EditFlow AI
3. The panel AUTO-STARTS the Python backend on open. The first open after a
   Premiere launch takes a few seconds to boot, then the panel reloads itself.
   (To start it manually instead, you can still run: python run.py)
4. The panel connects to http://127.0.0.1:8765

If auto-start cannot find Python, set it once from the panel's dev console:
   localStorage.editflow_python_path = 'C:\\path\\to\\python.exe'
   (and, if needed, localStorage.editflow_repo_root = 'C:\\path\\to\\EditFlowAI')

To uninstall: .\install_cep_junction.ps1 -Uninstall
"@ -ForegroundColor White
