@echo off
:: ============================================================================
::  EditFlow AI AE — ONE-CLICK: installs (first time) + starts the backend
:: ============================================================================
::  Double-click this file. Every time. That's the whole routine.
::   - First run: checks Python, sets everything up, connects the panel to
::     your After Effects (any version 2022+, including 2026), then starts.
::   - Every later run: skips straight to starting the backend.
::  Keep the black window open while you use the panel in After Effects.
:: ============================================================================

title EditFlow AI AE
setlocal enabledelayedexpansion

set "PS1=%TEMP%\editflow_ae_oneclick_%RANDOM%.ps1"

:: Extract the PowerShell portion of this file to a temp script
powershell -NoProfile -Command "$lines = Get-Content -LiteralPath '%~f0'; $marker = ($lines | Select-String -Pattern '^# PS_SCRIPT_START$' | Select-Object -First 1).LineNumber; if ($marker) { $lines[($marker)..($lines.Count-1)] | Set-Content -LiteralPath '%PS1%' -Encoding UTF8 } else { Write-Host 'ERROR: marker not found'; exit 1 }"

if not exist "%PS1%" (
    echo.
    echo  ERROR: Could not extract the setup script.
    pause
    exit /b 1
)

:: NOTE: "%~dp0." — the trailing dot stops the path's final backslash from
:: escaping the closing quote (classic cmd->PowerShell quoting trap).
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -BatDir "%~dp0." -BatFile "%~f0"

set "EXITCODE=%ERRORLEVEL%"
del "%PS1%" 2>nul

echo.
if %EXITCODE% NEQ 0 (
    echo  Something went wrong. Read the messages above, then you can
    echo  close this window and double-click EditFlow-AE.bat to try again.
)
pause
exit /b %EXITCODE%

:: ============================================================================
# PS_SCRIPT_START
param(
    [string]$BatDir = "",
    [string]$BatFile = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoUrl = "https://github.com/HassanArif-collab/EditFlowAI/archive/refs/heads/feat/ae-animated-captions.zip"
$ExtensionId = "com.editflow.ae"

function Write-Step($msg) { Write-Host ""; Write-Host ">>> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    [X] $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "    $msg" -ForegroundColor Gray }
function Test-Command($cmd) { try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true } catch { return $false } }

# ── Where are we? ─────────────────────────────────────────────────────────
$BatDir = ($BatDir -replace '"', '').TrimEnd('.')   # undo the quoting-trap dot
if ($BatDir -and (Test-Path $BatDir)) { $ScriptDir = $BatDir.TrimEnd('\').TrimEnd('/') }
else { $ScriptDir = (Get-Location).Path }
if ($ScriptDir -like "*\Temp\*" -or $ScriptDir -like "*\tmp\*") {
    $ScriptDir = [Environment]::GetFolderPath("UserProfile")
}

# Repo mode: this .bat sits inside a checkout (dev PC) → use it in place.
# Download mode: fresh PC → install into EditFlowAI-AE next to the .bat.
if (Test-Path (Join-Path $ScriptDir "backend\main.py")) {
    $InstallDir = $ScriptDir
    $Mode = "repo"
} else {
    $InstallDir = Join-Path $ScriptDir "EditFlowAI-AE"
    $Mode = "download"
}
$VenvDir = Join-Path $InstallDir ".venv"
$pyExe = Join-Path $VenvDir "Scripts\python.exe"
$pipExe = Join-Path $VenvDir "Scripts\pip.exe"

Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Host "    EditFlow AI AE - Animated Captions" -ForegroundColor Cyan
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Info "Folder: $InstallDir"

# ── Step 1: After Effects check (informational, never blocks) ─────────────
Write-Step "Checking After Effects..."
$aeNames = @()
foreach ($base in @((Join-Path $env:ProgramFiles "Adobe"), (Join-Path ${env:ProgramFiles(x86)} "Adobe"))) {
    if ($base -and (Test-Path $base)) {
        $aeNames += (Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "Adobe After Effects" } | ForEach-Object { $_.Name })
    }
}
if ($aeNames.Count -gt 0) {
    $newest = ($aeNames | Sort-Object)[-1]
    Write-OK "Found: $newest (panel supports AE 2022 and newer)"
} else {
    Write-Warn "After Effects not found in the usual folders. Setup continues;"
    Write-Warn "install AE 2022+ to actually use the panel."
}

# ── Step 2: Get the code (download mode, first time only) ─────────────────
if (-not (Test-Path (Join-Path $InstallDir "backend\main.py"))) {
    Write-Step "Downloading EditFlow AI AE (first time only)..."
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    $zipPath = Join-Path $env:TEMP "editflow-ae-download.zip"
    try {
        Invoke-WebRequest -Uri $RepoUrl -OutFile $zipPath -UseBasicParsing
        Write-OK "Downloaded"
    } catch {
        Write-Err "Download failed: $_"
        Write-Info "Check your internet connection, then double-click this file again."
        exit 1
    }
    Write-Info "Extracting..."
    Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
    $extracted = Get-ChildItem $InstallDir -Directory | Where-Object { $_.Name -like "EditFlowAI-*" } | Select-Object -First 1
    if ($extracted) {
        Get-ChildItem $extracted.FullName -Force | ForEach-Object { Move-Item $_.FullName $InstallDir -Force }
        Remove-Item $extracted.FullName -Force -Recurse
    }
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Write-OK "Extracted"
}

# ── Step 3: Python + environment (skipped when already set up) ────────────
if (-not (Test-Path $pyExe)) {
    Write-Step "Setting up Python (first time only)..."
    $python = $null
    foreach ($cmd in @("python", "python3", "py")) {
        if (Test-Command $cmd) {
            try {
                $ver = & $cmd --version 2>&1
                if ($ver -match "Python (\d+)\.(\d+)") {
                    if ([int]$matches[1] -ge 3 -and [int]$matches[2] -ge 10) { $python = $cmd; break }
                }
            } catch {}
        }
    }
    if (-not $python) {
        Write-Warn "Python 3.10+ not found. Installing it for you (winget)..."
        if (Test-Command "winget") {
            try {
                & winget install Python.Python.3.12 --accept-source-agreements --accept-package-agreements --silent
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
                if (Test-Command "python") { $python = "python"; Write-OK "Python installed" }
            } catch { Write-Err "Automatic Python install failed: $_" }
        }
        if (-not $python) {
            Write-Err "Please install Python 3.10+ from https://www.python.org/downloads/"
            Write-Err "IMPORTANT: tick 'Add Python to PATH' during install, then run this file again."
            exit 1
        }
    }
    Write-OK "Python found ($python)"
    Write-Info "Creating environment + installing dependencies (2-5 minutes, one time)..."
    & $python -m venv $VenvDir
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & $pyExe -m pip install --upgrade pip --quiet 2>&1 | Out-Null
    & $pipExe install -r (Join-Path $InstallDir "requirements.txt") --quiet 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & $pipExe install -r (Join-Path $InstallDir "requirements.txt") 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; Write-Err "Dependency install failed."; exit 1 }
    }
    $ErrorActionPreference = $prevEAP
    Write-OK "Environment ready"
} else {
    Write-OK "Python environment already set up"
}

# ── Step 4: Connect the panel to After Effects (idempotent) ───────────────
Write-Step "Connecting the panel to After Effects..."
$cepDir = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$targetDir = Join-Path $cepDir $ExtensionId
$aePanelDir = Join-Path $InstallDir "cep-panel-ae"
if (-not (Test-Path $cepDir)) { New-Item -ItemType Directory -Path $cepDir -Force | Out-Null }
if (Test-Path $targetDir) {
    $item = Get-Item $targetDir
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $item.Delete() }
    else { Remove-Item -Recurse -Force $targetDir }
}
cmd.exe /c "mklink /J `"$targetDir`" `"$aePanelDir`"" | Out-Null
if (Test-Path $targetDir) { Write-OK "Panel linked (Window > Extensions > EditFlow AI)" }
else { Write-Err "Could not link the panel into $cepDir"; exit 1 }

# Allow the unsigned panel in every AE version's CEP runtime (2022 → future).
foreach ($v in 11..15) {
    $regPath = "HKCU:\SOFTWARE\Adobe\CSXS.$v"
    if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
    Set-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value 1 -Type String -Force
}
Write-OK "Extension allowed for your After Effects version"

# ── Step 5: Desktop shortcut to THIS file (so it's always one click) ──────
try {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktop "EditFlow AI AE.lnk"
    if (-not (Test-Path $shortcutPath)) {
        $ws = New-Object -ComObject WScript.Shell
        $sc = $ws.CreateShortcut($shortcutPath)
        $sc.TargetPath = $BatFile
        $sc.WorkingDirectory = $ScriptDir
        $sc.IconLocation = "shell32.dll,13"
        $sc.Description = "EditFlow AI AE - install/start with one click"
        $sc.Save()
        Write-OK "Desktop shortcut created: EditFlow AI AE"
    }
} catch { Write-Warn "Could not create a desktop shortcut (not important)." }

# ── Step 6: Start the backend ─────────────────────────────────────────────
Write-Step "Starting the backend..."
# Free the port if an old backend is still running.
try {
    Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
} catch {}

if (-not (Test-Path (Join-Path $InstallDir "data\models"))) {
    Write-Warn "First time: open the panel's Settings and download a Whisper model"
    Write-Warn "before your first transcription."
}

Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Green
Write-Host "    EditFlow AI AE is running." -ForegroundColor Green
Write-Host "  ==================================================" -ForegroundColor Green
Write-Host "    1. Open After Effects" -ForegroundColor White
Write-Host "    2. Window > Extensions > EditFlow AI" -ForegroundColor White
Write-Host "    3. KEEP THIS WINDOW OPEN while you work" -ForegroundColor Yellow
Write-Host ""

# Agent bridge: lets a coding agent on THIS computer test the panel inside
# AE automatically (localhost only — not reachable from the internet).
$env:EDITFLOW_AGENT_BRIDGE = "1"
Set-Location $InstallDir
& $pyExe run.py --prod
