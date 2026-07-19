@echo off
:: ============================================================================
:: EditFlow AI AE — One-Click Installer for After Effects
:: ============================================================================
:: Installs next to this .bat file. Creates a CEP extension for After Effects.
:: ============================================================================

setlocal enabledelayedexpansion

set "PS1=%TEMP%\editflow_ae_install_%RANDOM%.ps1"

:: Extract PowerShell portion to temp file
powershell -NoProfile -Command "$lines = Get-Content -LiteralPath '%~f0'; $marker = ($lines | Select-String -Pattern '^# PS_SCRIPT_START$' | Select-Object -First 1).LineNumber; if ($marker) { $lines[($marker)..($lines.Count-1)] | Set-Content -LiteralPath '%PS1%' -Encoding UTF8 } else { Write-Host 'ERROR: marker not found'; exit 1 }"

if not exist "%PS1%" (
    echo.
    echo  ERROR: Could not extract installer script.
    pause
    exit /b 1
)

:: Run the extracted PowerShell script, passing the .bat file's directory.
:: "%~dp0." — trailing dot stops the final backslash escaping the quote.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -BatDir "%~dp0."

set "EXITCODE=%ERRORLEVEL%"

del "%PS1%" 2>nul

if %EXITCODE% NEQ 0 (
    echo.
    echo  Installation failed. Please read the messages above.
    pause
)

exit /b %EXITCODE%

:: ============================================================================
# PS_SCRIPT_START
param(
    [string]$BatDir = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ── Configuration ──────────────────────────────────────────────────────────
$RepoUrl = "https://github.com/HassanArif-collab/EditFlowAI/archive/refs/heads/feat/ae-animated-captions.zip"
$ExtensionId = "com.editflow.ae"

# Install next to the .bat file
$BatDir = ($BatDir -replace '"', '').TrimEnd('.')   # undo the quoting-trap dot
if ($BatDir -and (Test-Path $BatDir)) {
    $ScriptDir = $BatDir.TrimEnd('\').TrimEnd('/')
} else {
    $ScriptDir = (Get-Location).Path
}
if ($ScriptDir -like "*\Temp\*" -or $ScriptDir -like "*\tmp\*") {
    $ScriptDir = [Environment]::GetFolderPath("UserProfile")
}

$InstallDir = Join-Path $ScriptDir "EditFlowAI-AE"
$VenvDir = Join-Path $InstallDir ".venv"

# ── Helpers ───────────────────────────────────────────────────────────────
function Write-Step($msg) { Write-Host ""; Write-Host ">>> $msg" -ForegroundColor Cyan }
function Write-OK($msg) { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "    [X] $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "    $msg" -ForegroundColor Gray }
function Test-Command($cmd) { try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true } catch { return $false } }

# ── Banner ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Host "    EditFlow AI AE - One-Click Installer" -ForegroundColor Cyan
Write-Host "    Animated Captions for After Effects" -ForegroundColor Cyan
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  This will install EditFlow AI AE to: $InstallDir" -ForegroundColor White
Write-Host "  (installed next to this .bat file's location)" -ForegroundColor Gray
Write-Host "  Close After Effects if it is open, then press any key to begin." -ForegroundColor Yellow
Write-Host ""
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

# ── Step 1: Check for After Effects ────────────────────────────────────────
Write-Step "Step 1/7 - Checking system..."
$aePaths = @(
    (Join-Path $env:ProgramFiles "Adobe"),
    (Join-Path ${env:ProgramFiles(x86)} "Adobe")
)
$aeFound = $false
foreach ($base in $aePaths) {
    if (Test-Path $base) {
        $ae = Get-ChildItem $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "Adobe After Effects" }
        if ($ae) {
            $aeFound = $true
            Write-OK "After Effects found: $($ae[0].Name)"
            break
        }
    }
}
if (-not $aeFound) {
    Write-Warn "After Effects not found in standard locations."
    Write-Warn "Install will continue, but you need AE 2022+ to use the panel."
}

# ── Step 2: Check for Python ──────────────────────────────────────────────
Write-Step "Step 2/7 - Checking for Python..."
$python = $null
foreach ($cmd in @("python", "python3", "py")) {
    if (Test-Command $cmd) {
        try {
            $ver = & $cmd --version 2>&1
            if ($ver -match "Python (\d+)\.(\d+)") {
                $major = [int]$matches[1]; $minor = [int]$matches[2]
                if ($major -ge 3 -and $minor -ge 10) {
                    $python = $cmd
                    Write-OK "Python $major.$minor found ($cmd)"
                    break
                }
            }
        } catch {}
    }
}
if (-not $python) {
    Write-Warn "Python 3.10+ not found. Attempting to install via winget..."
    if (Test-Command "winget") {
        try {
            & winget install Python.Python.3.12 --accept-source-agreements --accept-package-agreements --silent
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            if (Test-Command "python") { $python = "python"; Write-OK "Python installed via winget" }
        } catch { Write-Err "winget install failed: $_" }
    }
    if (-not $python) {
        Write-Host "    Please install Python 3.10+ from https://www.python.org/downloads/" -ForegroundColor Yellow
        Write-Host "    CHECK 'Add Python to PATH' during install." -ForegroundColor Yellow
        pause; exit 1
    }
}

# ── Step 3: Download the repository ───────────────────────────────────────
Write-Step "Step 3/7 - Downloading EditFlow AI AE..."
$preservedData = $null
if (Test-Path $InstallDir) {
    $dataDir = Join-Path $InstallDir "data"
    if (Test-Path $dataDir) {
        $preservedData = Join-Path $env:TEMP "editflow_ae_data_preserve_$(Get-Random)"
        Write-Info "Preserving data directory (Whisper models)..."
        try { Move-Item $dataDir $preservedData; Write-OK "Data preserved" } catch { $preservedData = $null }
    }
    $backup = "$InstallDir.backup." + (Get-Date -Format "yyyyMMdd-HHmmss")
    Write-Warn "Existing install found - backing up to $backup"
    try { Move-Item $InstallDir $backup; Write-OK "Backed up" } catch { Write-Err "Could not back up: $_"; exit 1 }
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

if ($preservedData -and (Test-Path $preservedData)) {
    try { Move-Item $preservedData (Join-Path $InstallDir "data"); Write-OK "Restored data" } catch {}
}

$zipPath = Join-Path $InstallDir "editflow-ae-download.zip"
Write-Info "Downloading from GitHub..."
try {
    Invoke-WebRequest -Uri $RepoUrl -OutFile $zipPath -UseBasicParsing
    Write-OK "Downloaded"
} catch {
    Write-Err "Download failed: $_"
    exit 1
}

Write-Info "Extracting..."
try {
    Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
    $extractedFolder = Get-ChildItem $InstallDir -Directory | Where-Object { $_.Name -like "EditFlowAI-*" } | Select-Object -First 1
    if ($extractedFolder) {
        Get-ChildItem $extractedFolder.FullName -Force | ForEach-Object { Move-Item $_.FullName $InstallDir -Force }
        Remove-Item $extractedFolder.FullName -Force -Recurse
    }
    Remove-Item $zipPath -Force
    Write-OK "Extracted to $InstallDir"
} catch {
    Write-Err "Extraction failed: $_"
    exit 1
}

# ── Step 4: Python environment ────────────────────────────────────────────
Write-Step "Step 4/7 - Setting up Python environment..."
Write-Info "Creating virtual environment..."
& $python -m venv $VenvDir
Write-OK "Virtual environment created"

$pipExe = Join-Path $VenvDir "Scripts\pip.exe"
$pyExe = Join-Path $VenvDir "Scripts\python.exe"

$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
Write-Info "Upgrading pip..."
try { & $pyExe -m pip install --upgrade pip --quiet 2>&1 | Out-Null } catch {}
Write-Info "Installing dependencies (2-5 minutes)..."
try {
    & $pipExe install -r (Join-Path $InstallDir "requirements.txt") --quiet 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "pip failed" }
    Write-OK "Dependencies installed"
} catch {
    Write-Warn "Retrying verbose..."
    & $pipExe install -r (Join-Path $InstallDir "requirements.txt") 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; Write-Err "Failed"; exit 1 }
    Write-OK "Dependencies installed (verbose)"
}
$ErrorActionPreference = $prevEAP

# ── Step 5: CEP junction ──────────────────────────────────────────────────
Write-Step "Step 5/7 - Linking panel to After Effects..."
$cepDir = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$targetDir = Join-Path $cepDir $ExtensionId
$aePanelDir = Join-Path $InstallDir "cep-panel-ae"

if (-not (Test-Path $cepDir)) {
    New-Item -ItemType Directory -Path $cepDir -Force | Out-Null
}
if (Test-Path $targetDir) {
    $item = Get-Item $targetDir
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $item.Delete() }
    else { Remove-Item -Recurse -Force $targetDir }
}
cmd.exe /c "mklink /J `"$targetDir`" `"$aePanelDir`"" | Out-Null
if (Test-Path $targetDir) {
    Write-OK "Panel linked to After Effects"
} else {
    Write-Err "Failed to create junction"
    exit 1
}

# ── Step 6: Registry + shortcuts ──────────────────────────────────────────
Write-Step "Step 6/7 - Enabling unsigned extensions + creating shortcuts..."
$regPaths = @(
    "HKCU:\SOFTWARE\Adobe\CSXS.11", "HKCU:\SOFTWARE\Adobe\CSXS.12",
    "HKCU:\SOFTWARE\Adobe\CSXS.13", "HKCU:\SOFTWARE\Adobe\CSXS.14",
    "HKCU:\SOFTWARE\Adobe\CSXS.15"
)
foreach ($regPath in $regPaths) {
    if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
    Set-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value 1 -Type String -Force
}
Write-OK "PlayerDebugMode enabled"

# Backend launcher
$launcherPath = Join-Path $InstallDir "start-editflow-ae.bat"
$launcherContent = @"
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
cd /d "$InstallDir"
"$pyExe" run.py --prod
pause
"@
Set-Content -Path $launcherPath -Value $launcherContent -Encoding ASCII

# Desktop shortcut
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "EditFlow AI AE.lnk"
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.IconLocation = "shell32.dll,13"
$shortcut.Description = "Start EditFlow AI AE backend"
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Save()
Write-OK "Desktop shortcut created"

# ── Step 7: Verify ────────────────────────────────────────────────────────
Write-Step "Step 7/7 - Verifying installation..."
$checks = @(
    @{Name="Install dir"; Path=$InstallDir},
    @{Name="AE panel"; Path=(Join-Path $InstallDir "cep-panel-ae\CSXS\manifest.xml")},
    @{Name="AE ExtendScript"; Path=(Join-Path $InstallDir "cep-panel-ae\extendscript\index.jsx")},
    @{Name="Backend code"; Path=(Join-Path $InstallDir "backend\main.py")},
    @{Name="Python venv"; Path=$pyExe},
    @{Name="Panel link"; Path=$targetDir},
    @{Name="Desktop shortcut"; Path=$shortcutPath}
)
foreach ($check in $checks) {
    if (Test-Path $check.Path) { Write-OK "$($check.Name) - present" }
    else { Write-Err "$($check.Name) - MISSING" }
}

# ── Success ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Green
Write-Host "    Installation Complete!" -ForegroundColor Green
Write-Host "  ==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  NEXT STEPS:" -ForegroundColor White
Write-Host ""
Write-Host "  1. Double-click 'EditFlow AI AE' shortcut on Desktop" -ForegroundColor White
Write-Host "     (black window opens - leave it running)"
Write-Host ""
Write-Host "  2. Open Adobe After Effects" -ForegroundColor White
Write-Host ""
Write-Host "  3. Go to: Window > Extensions > EditFlow AI" -ForegroundColor White
Write-Host ""
Write-Host "  4. Import an audio file and add it to a comp" -ForegroundColor White
Write-Host ""
Write-Host "  5. Click 'Transcribe Audio' in the panel" -ForegroundColor White
Write-Host ""
Write-Host "  6. Pick a preset (Pop-in recommended) and click Generate" -ForegroundColor White
Write-Host ""
Write-Host "  FIRST TIME: Download a Whisper model via Settings" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Press any key to open the install folder..." -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
Start-Process explorer.exe $InstallDir
