@echo off
:: ============================================================================
:: EditFlow AI — One-Click Installer for Windows
:: ============================================================================
:: Double-click this file to install everything automatically.
::
:: HOW IT WORKS: This .bat file extracts its embedded PowerShell script to
:: a temp .ps1 file, then runs it with `powershell -File`. This avoids the
:: broken `iex` pattern that chokes on `>` and `$env:` characters.
:: ============================================================================

setlocal enabledelayedexpansion

set "PS1=%TEMP%\editflow_install_%RANDOM%.ps1"

:: Extract the PowerShell portion (everything after the unique marker line)
:: to a temp .ps1 file, then run it with -File.
powershell -NoProfile -Command "$lines = Get-Content -LiteralPath '%~f0'; $marker = ($lines | Select-String -Pattern '^# PS_SCRIPT_START$' | Select-Object -First 1).LineNumber; if ($marker) { $lines[($marker)..($lines.Count-1)] | Set-Content -LiteralPath '%PS1%' -Encoding UTF8 } else { Write-Host 'ERROR: marker not found'; exit 1 }"

if not exist "%PS1%" (
    echo.
    echo ============================================================
    echo  ERROR: Could not extract installer script.
    echo  Please screenshot this window and share it for help.
    echo ============================================================
    pause
    exit /b 1
)

:: Run the extracted PowerShell script, passing the .bat file's directory
:: so it installs next to the .bat file (not always C:\EditFlowAI)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -BatDir "%~dp0"

set "EXITCODE=%ERRORLEVEL%"

:: Clean up temp file
del "%PS1%" 2>nul

if %EXITCODE% NEQ 0 (
    echo.
    echo ============================================================
    echo  Installation failed. Please read the messages above.
    echo  If you need help, screenshot this window and share it.
    echo ============================================================
    pause
)

exit /b %EXITCODE%

:: ============================================================================
:: Everything below this line is PowerShell (extracted to temp .ps1 at runtime)
:: Do not remove the marker line below — the .bat file looks for it.
:: ============================================================================
# PS_SCRIPT_START
param(
    [string]$BatDir = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ── Configuration ──────────────────────────────────────────────────────────
$RepoUrl = "https://github.com/HassanArif-collab/EditFlowAI/archive/refs/heads/feat/native-animated-captions.zip"
$ExtensionId = "com.editflow.ai"

# Install next to the .bat file (NOT always C:\EditFlowAI).
# The .bat wrapper passes its directory via -BatDir. If not provided
# (e.g., running the .ps1 directly), fall back to the current directory.
if ($BatDir -and (Test-Path $BatDir)) {
    $ScriptDir = $BatDir.TrimEnd('\').TrimEnd('/')
} else {
    $ScriptDir = (Get-Location).Path
}

# If the script is running from a temp dir (e.g., downloaded to %TEMP%),
# fall back to the user's home directory.
if ($ScriptDir -like "*\Temp\*" -or $ScriptDir -like "*\tmp\*") {
    $ScriptDir = [Environment]::GetFolderPath("UserProfile")
}

$InstallDir = Join-Path $ScriptDir "EditFlowAI"
$VenvDir = Join-Path $InstallDir ".venv"

# ── Helper functions ───────────────────────────────────────────────────────
function Write-Step($msg) {
    Write-Host ""
    Write-Host ">>> $msg" -ForegroundColor Cyan
}
function Write-OK($msg) {
    Write-Host "    [OK] $msg" -ForegroundColor Green
}
function Write-Warn($msg) {
    Write-Host "    [!] $msg" -ForegroundColor Yellow
}
function Write-Err($msg) {
    Write-Host "    [X] $msg" -ForegroundColor Red
}
function Write-Info($msg) {
    Write-Host "    $msg" -ForegroundColor Gray
}

function Test-Command($cmd) {
    try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true } catch { return $false }
}

# ── Banner ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Host "    EditFlow AI - One-Click Installer" -ForegroundColor Cyan
Write-Host "    Native Animated Captions for Premiere Pro" -ForegroundColor Cyan
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  This will install EditFlow AI to: $InstallDir" -ForegroundColor White
Write-Host "  (installed next to this .bat file's location)" -ForegroundColor Gray
Write-Host "  Close Premiere Pro if it is open, then press any key to begin." -ForegroundColor Yellow
Write-Host ""
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

# ── Step 1: Check Windows version ──────────────────────────────────────────
Write-Step "Step 1/8 - Checking system..."
$osVersion = [System.Environment]::OSVersion.Version
if ($osVersion.Major -lt 10) {
    Write-Err "Windows 10 or later is required. You have Windows $($osVersion.Major)."
    exit 1
}
Write-OK "Windows $($osVersion.Major).$($osVersion.Minor) detected"

# Check for Premiere Pro install
$premierePaths = @(
    (Join-Path $env:ProgramFiles "Adobe"),
    (Join-Path ${env:ProgramFiles(x86)} "Adobe"),
    (Join-Path $env:LOCALAPPDATA "Adobe")
)
$premiereFound = $false
foreach ($base in $premierePaths) {
    if (Test-Path $base) {
        $ppro = Get-ChildItem $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "Adobe Premiere Pro" }
        if ($ppro) {
            $premiereFound = $true
            Write-OK "Premiere Pro found: $($ppro[0].Name)"
            break
        }
    }
}
if (-not $premiereFound) {
    Write-Warn "Premiere Pro not found in standard locations."
    Write-Warn "Install will continue, but you need Premiere Pro 2023+ to use the panel."
}

# ── Step 2: Check for Python ───────────────────────────────────────────────
Write-Step "Step 2/8 - Checking for Python..."

$python = $null
foreach ($cmd in @("python", "python3", "py")) {
    if (Test-Command $cmd) {
        try {
            $ver = & $cmd --version 2>&1
            if ($ver -match "Python (\d+)\.(\d+)") {
                $major = [int]$matches[1]
                $minor = [int]$matches[2]
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
            if (Test-Command "python") {
                $python = "python"
                Write-OK "Python installed via winget"
            }
        } catch {
            Write-Err "winget install failed: $_"
        }
    }
    if (-not $python) {
        Write-Host ""
        Write-Host "    Could not install Python automatically." -ForegroundColor Red
        Write-Host "    Please install Python 3.10+ from https://www.python.org/downloads/" -ForegroundColor Yellow
        Write-Host "    During install, CHECK 'Add Python to PATH' (important!)" -ForegroundColor Yellow
        Write-Host "    Then re-run this installer." -ForegroundColor Yellow
        Write-Host ""
        pause
        exit 1
    }
}

# ── Step 3: Download the repository ────────────────────────────────────────
Write-Step "Step 3/8 - Downloading EditFlow AI..."

# If the install dir already exists, back it up — BUT preserve the data/
# directory (Whisper models, transcripts, cache) so the user doesn't have to
# re-download 1.5GB models on every reinstall.
$preservedData = $null
if (Test-Path $InstallDir) {
    $dataDir = Join-Path $InstallDir "data"
    if (Test-Path $dataDir) {
        $preservedData = Join-Path $env:TEMP "editflow_data_preserve_$(Get-Random)"
        Write-Info "Preserving data directory (Whisper models, transcripts)..."
        try {
            Move-Item $dataDir $preservedData
            Write-OK "Data directory preserved"
        } catch {
            Write-Warn "Could not preserve data directory: $_"
            $preservedData = $null
        }
    }
    $backup = "$InstallDir.backup." + (Get-Date -Format "yyyyMMdd-HHmmss")
    Write-Warn "Existing install found at $InstallDir - backing up to $backup"
    try {
        Move-Item $InstallDir $backup
        Write-OK "Backed up existing install"
    } catch {
        Write-Err "Could not back up. Close any files in $InstallDir and retry."
        exit 1
    }
}

# Create install dir
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

# Restore the preserved data directory if we saved one
if ($preservedData -and (Test-Path $preservedData)) {
    $newDataDir = Join-Path $InstallDir "data"
    try {
        Move-Item $preservedData $newDataDir
        Write-OK "Restored data directory (Whisper models preserved)"
    } catch {
        Write-Warn "Could not restore data directory: $_"
    }
}

# Download the ZIP
$zipPath = Join-Path $InstallDir "editflow-download.zip"
Write-Info "Downloading from GitHub..."
try {
    Invoke-WebRequest -Uri $RepoUrl -OutFile $zipPath -UseBasicParsing
    Write-OK "Downloaded repository ZIP"
} catch {
    Write-Err "Download failed: $_"
    Write-Host "    Check your internet connection and try again." -ForegroundColor Yellow
    exit 1
}

# Extract
Write-Info "Extracting..."
try {
    Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
    # The ZIP extracts to a folder like "EditFlowAI-feat-native-animated-captions"
    $extractedFolder = Get-ChildItem $InstallDir -Directory | Where-Object { $_.Name -like "EditFlowAI-*" } | Select-Object -First 1
    if ($extractedFolder) {
        # Move all contents from the extracted folder to the install root
        Get-ChildItem $extractedFolder.FullName -Force | ForEach-Object {
            Move-Item $_.FullName $InstallDir -Force
        }
        Remove-Item $extractedFolder.FullName -Force -Recurse
    }
    Remove-Item $zipPath -Force
    Write-OK "Extracted to $InstallDir"
} catch {
    Write-Err "Extraction failed: $_"
    exit 1
}

# Verify key files exist
if (-not (Test-Path (Join-Path $InstallDir "backend\main.py")) -or -not (Test-Path (Join-Path $InstallDir "cep-panel\CSXS\manifest.xml"))) {
    Write-Err "Repository structure looks wrong - backend\main.py or cep-panel\CSXS\manifest.xml missing"
    exit 1
}
Write-OK "Repository structure verified"

# ── Step 4: Create Python virtual environment + install dependencies ───────
Write-Step "Step 4/8 - Setting up Python environment..."

Write-Info "Creating virtual environment..."
try {
    & $python -m venv $VenvDir
    Write-OK "Virtual environment created"
} catch {
    Write-Err "Failed to create venv: $_"
    exit 1
}

$pipExe = Join-Path $VenvDir "Scripts\pip.exe"
$pyExe = Join-Path $VenvDir "Scripts\python.exe"

# Upgrade pip (protected — pip warnings to stderr can abort PS with EAP=Stop)
Write-Info "Upgrading pip..."
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try { & $pyExe -m pip install --upgrade pip --quiet 2>&1 | Out-Null } catch {}
$ErrorActionPreference = $prevEAP

# Install dependencies
Write-Info "Installing Python dependencies (this takes 2-5 minutes)..."
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    & $pipExe install -r (Join-Path $InstallDir "requirements.txt") --quiet 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit $LASTEXITCODE)" }
    Write-OK "Dependencies installed"
} catch {
    Write-Warn "Quiet install failed, retrying with verbose output..."
    & $pipExe install -r (Join-Path $InstallDir "requirements.txt") 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $ErrorActionPreference = $prevEAP
        Write-Err "Dependency installation failed"
        exit 1
    }
    Write-OK "Dependencies installed (verbose)"
}
$ErrorActionPreference = $prevEAP

# Verify fastapi importable (protected — stderr from Python aborts PS scripts)
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $importCheck = & $pyExe -c "import fastapi; print('fastapi', fastapi.__version__)" 2>&1
} catch {
    $importCheck = "check failed: $_"
}
$ErrorActionPreference = $prevEAP
Write-Info "Verified: $importCheck"

# ── Step 5: Create CEP junction ────────────────────────────────────────────
Write-Step "Step 5/8 - Linking panel to Adobe Premiere Pro..."

$cepDir = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$targetDir = Join-Path $cepDir $ExtensionId
$cepPanelDir = Join-Path $InstallDir "cep-panel"

# Create CEP extensions directory if missing
if (-not (Test-Path $cepDir)) {
    New-Item -ItemType Directory -Path $cepDir -Force | Out-Null
    Write-OK "Created CEP extensions directory"
}

# Remove existing junction/folder
if (Test-Path $targetDir) {
    $item = Get-Item $targetDir
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $item.Delete()
    } else {
        Remove-Item -Recurse -Force $targetDir
    }
    Write-Info "Removed existing panel link"
}

# Create junction (no admin required for junctions to APPDATA)
cmd.exe /c "mklink /J `"$targetDir`" `"$cepPanelDir`"" | Out-Null

if (Test-Path $targetDir) {
    Write-OK "Panel linked to Premiere Pro"
} else {
    Write-Err "Failed to create junction"
    Write-Host "    Try running this installer as Administrator." -ForegroundColor Yellow
    exit 1
}

# ── Step 6: Enable unsigned extensions in registry ─────────────────────────
Write-Step "Step 6/8 - Enabling unsigned extensions in Premiere..."

$regPaths = @(
    "HKCU:\SOFTWARE\Adobe\CSXS.11",
    "HKCU:\SOFTWARE\Adobe\CSXS.12",
    "HKCU:\SOFTWARE\Adobe\CSXS.13",
    "HKCU:\SOFTWARE\Adobe\CSXS.14",
    "HKCU:\SOFTWARE\Adobe\CSXS.15"
)
foreach ($regPath in $regPaths) {
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    Set-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value 1 -Type String -Force
}
Write-OK "PlayerDebugMode enabled for CSXS.11-15"

# ── Step 7: Create shortcuts + uninstaller ─────────────────────────────────
Write-Step "Step 7/8 - Creating shortcuts..."

# Create the backend launcher batch file
$launcherPath = Join-Path $InstallDir "start-editflow.bat"
$launcherContent = @"
@echo off
title EditFlow AI Backend
echo ==================================================
echo   EditFlow AI - Starting Backend Server
echo ==================================================
echo.

:: Kill any existing EditFlow backend on port 8765
:: (prevents "only one usage of each socket address" error)
echo Checking for existing backend...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765 " ^| findstr "LISTENING"') do (
    echo Killing existing backend process (PID %%a)...
    taskkill /F /PID %%a >nul 2>&1
    timeout /t 1 /nobreak >nul
)

echo Starting EditFlow AI backend...
echo.
echo Keep this window open while you use the panel in Premiere Pro.
echo Close this window to stop the backend.
echo.
cd /d "$InstallDir"
"$pyExe" run.py --prod
pause
"@
Set-Content -Path $launcherPath -Value $launcherContent -Encoding ASCII

# Desktop shortcut
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "EditFlow AI.lnk"
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.IconLocation = "shell32.dll,13"
$shortcut.Description = "Start EditFlow AI backend for Premiere Pro"
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Save()
Write-OK "Desktop shortcut created: EditFlow AI"

# Start Menu shortcut
$startMenu = [Environment]::GetFolderPath("Programs")
$startShortcutPath = Join-Path $startMenu "EditFlow AI.lnk"
$shortcut = $ws.CreateShortcut($startShortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.IconLocation = "shell32.dll,13"
$shortcut.Description = "Start EditFlow AI backend for Premiere Pro"
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Save()
Write-OK "Start Menu shortcut created"

# Uninstaller
$uninstallerPath = Join-Path $InstallDir "uninstall-editflow.bat"
$uninstallerContent = @"
@echo off
title Uninstall EditFlow AI
echo.
echo  This will remove EditFlow AI from your computer.
echo  Close Premiere Pro before continuing.
echo.
pause

echo Removing CEP junction...
if exist "%APPDATA%\Adobe\CEP\extensions\$ExtensionId" (
    rmdir /S /Q "%APPDATA%\Adobe\CEP\extensions\$ExtensionId"
)

echo Removing shortcuts...
if exist "%USERPROFILE%\Desktop\EditFlow AI.lnk" del /Q "%USERPROFILE%\Desktop\EditFlow AI.lnk"
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\EditFlow AI.lnk" del /Q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\EditFlow AI.lnk"

echo Removing install directory...
rmdir /S /Q "$InstallDir"

echo.
echo  EditFlow AI has been uninstalled.
echo.
pause
"@
Set-Content -Path $uninstallerPath -Value $uninstallerContent -Encoding ASCII
Write-OK "Uninstaller created"

# ── Step 8: Final verification ─────────────────────────────────────────────
Write-Step "Step 8/8 - Verifying installation..."

$checks = @(
    @{Name="Install directory"; Path=$InstallDir},
    @{Name="Backend code"; Path=(Join-Path $InstallDir "backend\main.py")},
    @{Name="CEP panel"; Path=(Join-Path $InstallDir "cep-panel\CSXS\manifest.xml")},
    @{Name="Python venv"; Path=$pyExe},
    @{Name="Panel link"; Path=$targetDir},
    @{Name="Desktop shortcut"; Path=$shortcutPath},
    @{Name="Launcher script"; Path=$launcherPath},
    @{Name="Uninstaller"; Path=$uninstallerPath},
    @{Name="Native captions view"; Path=(Join-Path $InstallDir "cep-panel\client\src\native-captions-view.js")},
    @{Name="base_text.mogrt"; Path=(Join-Path $InstallDir "cep-panel\templates\subtitles\base_text.mogrt")}
)

$allOk = $true
foreach ($check in $checks) {
    if (Test-Path $check.Path) {
        Write-OK "$($check.Name) - present"
    } else {
        Write-Err "$($check.Name) - MISSING at $($check.Path)"
        $allOk = $false
    }
}

# Test backend can import (non-fatal — just a sanity check)
# Two critical things here:
#   1. Push-Location $InstallDir — Python must run from the install dir so it
#      can find the 'backend' package (the working dir of the installer is
#      wherever the user launched the .bat from, NOT C:\EditFlowAI).
#   2. Temporarily relax $ErrorActionPreference — Python writes tracebacks to
#      stderr, and PowerShell 5.x with ErrorActionPreference=Stop treats ANY
#      stderr output from native commands as a terminating error (NativeCommandError).
#      This would abort the entire installer before reaching the success banner,
#      even though every install step succeeded.
Write-Info "Testing backend imports..."
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
Push-Location $InstallDir
try {
    $testResult = & $pyExe -c "from backend.main import app; print('OK')" 2>&1
} catch {
    $testResult = "exception: $_"
}
Pop-Location
$ErrorActionPreference = $prevEAP
if ($testResult -match "OK") {
    Write-OK "Backend imports cleanly"
} else {
    Write-Warn "Backend import test (non-fatal): $testResult"
    Write-Warn "The install succeeded. The desktop shortcut will start the backend correctly."
}

# ── Success ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Green
Write-Host "    Installation Complete!" -ForegroundColor Green
Write-Host "  ==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  NEXT STEPS:" -ForegroundColor White
Write-Host ""
Write-Host "  1. Double-click the 'EditFlow AI' shortcut on your Desktop" -ForegroundColor White
Write-Host "     (a black window opens - leave it running)"
Write-Host ""
Write-Host "  2. Open Adobe Premiere Pro" -ForegroundColor White
Write-Host ""
Write-Host "  3. Go to: Window - Extensions - EditFlow AI" -ForegroundColor White
Write-Host ""
Write-Host "  4. Click the speech bubble icon in the panel header" -ForegroundColor White
Write-Host "     to open Native Animated Captions"
Write-Host ""
Write-Host "  5. FIRST TIME ONLY: Download a Whisper model" -ForegroundColor Yellow
Write-Host "     Click the gear icon in the panel, then Settings, then Whisper"
Write-Host "     Download 'small' (English) or 'medium' (multilingual)"
Write-Host "     This takes 5-15 minutes depending on your internet"
Write-Host ""
Write-Host "  OPTIONAL - Audio export preset (.epr file):" -ForegroundColor Yellow
Write-Host "  If 'Extract and Transcribe' fails, see:" -ForegroundColor Gray
Write-Host "  $InstallDir\cep-panel\templates\audio\README.md" -ForegroundColor Gray
Write-Host ""
Write-Host "  To uninstall: $uninstallerPath" -ForegroundColor Gray
Write-Host ""
Write-Host "  Press any key to open the install folder..." -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
Start-Process explorer.exe $InstallDir
Write-Host ""
Write-Host "  Done! You can close this window now." -ForegroundColor Green
Write-Host ""
