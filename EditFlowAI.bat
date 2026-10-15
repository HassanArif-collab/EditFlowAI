@echo off
:: ============================================================================
::  EditFlow AI - ONE-CLICK: installs (first time) + starts the backend
:: ============================================================================
::  Double-click this file. Every time. That's the whole routine.
::   - First run: checks Python, sets everything up, connects the panel to
::     your Premiere Pro (any version 2023+, including 2026), then starts.
::   - Every later run: skips straight to starting the backend.
::  Keep the black window open while you use the panel in Premiere Pro.
:: ============================================================================

title EditFlow AI
setlocal enabledelayedexpansion

set "PS1=%TEMP%\editflow_oneclick_%RANDOM%.ps1"

:: Extract the PowerShell portion of this file to a temp script
powershell -NoProfile -Command "$lines = Get-Content -LiteralPath '%~f0' -Encoding UTF8; $marker = ($lines | Select-String -Pattern '^# PS_SCRIPT_START$' | Select-Object -First 1).LineNumber; if ($marker) { $lines[($marker)..($lines.Count-1)] | Set-Content -LiteralPath '%PS1%' -Encoding UTF8 } else { Write-Host 'ERROR: marker not found'; exit 1 }"

if not exist "%PS1%" (
    echo.
    echo  ERROR: Could not extract the setup script.
    pause
    exit /b 1
)

:: NOTE: "%~dp0." - the trailing dot stops the path's final backslash from
:: escaping the closing quote (classic cmd->PowerShell quoting trap).
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -BatDir "%~dp0." -BatFile "%~f0"

set "EXITCODE=%ERRORLEVEL%"
del "%PS1%" 2>nul

echo.
if %EXITCODE% NEQ 0 (
    echo  Something went wrong. Read the messages above, then you can
    echo  close this window and double-click EditFlowAI.bat to try again.
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

$RepoUrl = "https://github.com/HassanArif-collab/EditFlowAI/archive/refs/heads/main.zip"
$ExtensionId = "com.editflow.ai"

function Write-Step($msg) { Write-Host ""; Write-Host ">>> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    [X] $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "    $msg" -ForegroundColor Gray }
function Test-Command($cmd) { try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true } catch { return $false } }

# -- Where are we? ---------------------------------------------------------
$BatDir = ($BatDir -replace '"', '').TrimEnd('.')   # undo the quoting-trap dot
if ($BatDir -and (Test-Path $BatDir)) { $ScriptDir = $BatDir.TrimEnd('\').TrimEnd('/') }
else { $ScriptDir = (Get-Location).Path }
if ($ScriptDir -like "*\Temp\*" -or $ScriptDir -like "*\tmp\*") {
    $ScriptDir = [Environment]::GetFolderPath("UserProfile")
}

# Repo mode: this .bat sits inside a checkout (dev PC) -> use it in place.
# Download mode: fresh PC -> install into EditFlowAI next to the .bat.
if (Test-Path (Join-Path $ScriptDir "backend\main.py")) {
    $InstallDir = $ScriptDir
    $Mode = "repo"
} else {
    $InstallDir = Join-Path $ScriptDir "EditFlowAI"
    $Mode = "download"
}
$VenvDir = Join-Path $InstallDir ".venv"
$pyExe = Join-Path $VenvDir "Scripts\python.exe"
$pipExe = Join-Path $VenvDir "Scripts\pip.exe"

Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Host "    EditFlow AI - Premiere Pro" -ForegroundColor Cyan
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Info "Folder: $InstallDir"

# -- Step 1: Premiere Pro check (informational, never blocks) --------------
Write-Step "Checking Premiere Pro..."
$pproNames = @()
foreach ($base in @((Join-Path $env:ProgramFiles "Adobe"), (Join-Path ${env:ProgramFiles(x86)} "Adobe"))) {
    if ($base -and (Test-Path $base)) {
        $pproNames += (Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "Adobe Premiere Pro" } | ForEach-Object { $_.Name })
    }
}
if ($pproNames.Count -gt 0) {
    $newest = ($pproNames | Sort-Object)[-1]
    Write-OK "Found: $newest (panel supports Premiere Pro 2023 and newer)"
} else {
    Write-Warn "Premiere Pro not found in the usual folders. Setup continues;"
    Write-Warn "install Premiere Pro 2023+ to actually use the panel."
}

# -- Step 2: Get the code (download mode, first time only) -----------------
if (-not (Test-Path (Join-Path $InstallDir "backend\main.py"))) {
    Write-Step "Downloading EditFlow AI (first time only)..."
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    $zipPath = Join-Path $env:TEMP "editflow-download.zip"
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

# -- Step 3: Python + environment (skipped when already set up) ------------
if (-not (Test-Path $pyExe)) {
    Write-Step "Setting up Python (first time only)..."
    $python = $null
    $candidatePythons = @("python", "python3", "py")
    foreach ($pv in @("313", "312", "311", "310")) {
        $candidatePythons += (Join-Path $env:LOCALAPPDATA "Programs\Python\Python$pv\python.exe")
        $candidatePythons += (Join-Path $env:ProgramFiles "Python$pv\python.exe")
    }
    foreach ($cmd in $candidatePythons) {
        if ((Test-Path $cmd) -or (Test-Command $cmd)) {
            try {
                $ver = & $cmd --version 2>&1
                if ($ver -match "Python (\d+)\.(\d+)") {
                    if ([int]$matches[1] -ge 3 -and [int]$matches[2] -ge 10) { $python = $cmd; break }
                }
            } catch {}
        }
    }
    if (-not $python) {
        Write-Warn "Python 3.10+ not found in PATH or standard folders. Attempting automatic installation..."
        if (Test-Command "winget") {
            try {
                Write-Info "Trying winget install Python.Python.3.12..."
                & winget install Python.Python.3.12 --accept-source-agreements --accept-package-agreements --silent
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
                if (Test-Command "python") { $python = "python"; Write-OK "Python installed via winget" }
            } catch { Write-Warn "Winget install failed: $_" }
        }
        if (-not $python) {
            try {
                Write-Info "Downloading official Python 3.11 installer from python.org..."
                $pyInstaller = Join-Path $env:TEMP "python-installer.exe"
                Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe" -OutFile $pyInstaller -UseBasicParsing
                Write-Info "Running silent installation..."
                Start-Process -FilePath $pyInstaller -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_pip=1" -Wait
                Remove-Item $pyInstaller -Force -ErrorAction SilentlyContinue
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
                $pyCheck = Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"
                if (Test-Path $pyCheck) { $python = $pyCheck; Write-OK "Python installed successfully" }
                elseif (Test-Command "python") { $python = "python"; Write-OK "Python installed successfully" }
            } catch {
                Write-Warn "Direct installer fallback failed: $_"
            }
        }
        if (-not $python) {
            Write-Err "Please install Python 3.10+ from https://www.python.org/downloads/"
            Write-Err "IMPORTANT: tick 'Add Python to PATH' during install, then run this file again."
            exit 1
        }
    }
    Write-OK "Python found ($python)"
    Write-Info "Creating virtual environment ($VenvDir)..."
    & $python -m venv $VenvDir
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    Write-Info "Upgrading pip..."
    & $pyExe -m pip install --upgrade pip --quiet 2>&1 | Out-Null
    Write-Info "Installing dependencies (showing download progress)..."
    & $pipExe install -r (Join-Path $InstallDir "requirements.txt") --no-warn-script-location
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Retrying dependency install..."
        & $pipExe install -r (Join-Path $InstallDir "requirements.txt")
        if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; Write-Err "Dependency install failed."; exit 1 }
    }
    $ErrorActionPreference = $prevEAP
    Write-OK "Environment ready"
} else {
    Write-OK "Python environment already set up"
}

# Check for NVIDIA GPU and ensure CUDA libraries are installed for maximum efficiency
$nvidiaInstalled = Test-Path (Join-Path $VenvDir "Lib\site-packages\nvidia\cublas")
if (-not $nvidiaInstalled) {
    $hasNvidiaGpu = $false
    try {
        $videoControllers = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
        if ($videoControllers -and ($videoControllers -match "NVIDIA").Count -gt 0) {
            $hasNvidiaGpu = $true
        }
    } catch {
        try {
            $wmiControllers = Get-WmiObject Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
            if ($wmiControllers -and ($wmiControllers -match "NVIDIA").Count -gt 0) {
                $hasNvidiaGpu = $true
            }
        } catch {}
    }
    if ($hasNvidiaGpu) {
        Write-Step "NVIDIA GPU detected! Enabling 10x faster CUDA acceleration..."
        & $pipExe install "nvidia-cublas-cu12" --no-warn-script-location --quiet
        if ($LASTEXITCODE -eq 0) {
            Write-OK "CUDA GPU acceleration enabled"
        } else {
            Write-Warn "Could not install nvidia-cublas-cu12; Whisper will use CPU fallback."
        }
    }
}

# -- Step 4: Connect the panel to Premiere Pro (idempotent) ----------------
# -- FFmpeg (bundled, no admin rights needed) ------------------------------
$ffmpegOk = $false
try { if (Get-Command ffmpeg -ErrorAction Stop) { $ffmpegOk = $true } } catch {}
$bundledFfmpeg = Get-ChildItem (Join-Path $InstallDir "data\tools") -Filter "ffmpeg.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($bundledFfmpeg) { $ffmpegOk = $true }

if (-not $ffmpegOk) {
    Write-Step "Getting FFmpeg (one time, ~30 MB)..."
    $toolsDir = Join-Path $InstallDir "data\tools\ffmpeg-bundled\bin"
    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
    $zip = Join-Path $env:TEMP "ffmpeg-essentials.zip"
    $extract = Join-Path $env:TEMP "ffmpeg-extract-$(Get-Random)"
    try {
        Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" `
            -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $extract -Force
        Get-ChildItem $extract -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1 |
            ForEach-Object { Copy-Item $_.FullName $toolsDir -Force }
        Get-ChildItem $extract -Filter "ffprobe.exe" -Recurse | Select-Object -First 1 |
            ForEach-Object { Copy-Item $_.FullName $toolsDir -Force }
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path (Join-Path $toolsDir "ffmpeg.exe")) { Write-OK "FFmpeg ready" }
        else { Write-Warn "FFmpeg extract failed - transcription may not work." }
    } catch {
        Write-Warn "Could not download FFmpeg: $_"
        Write-Warn "Transcription needs it. Install with: winget install Gyan.FFmpeg"
    }
} else {
    Write-OK "FFmpeg found"
}

Write-Step "Connecting the panel to Premiere Pro..."
$cepDir = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$targetDir = Join-Path $cepDir $ExtensionId
$panelDir = Join-Path $InstallDir "cep-panel"
if (-not (Test-Path $cepDir)) { New-Item -ItemType Directory -Path $cepDir -Force | Out-Null }

$needLink = $true
if (Test-Path $targetDir) {
    try {
        $item = Get-Item $targetDir
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $existingTarget = (Get-Item $targetDir).Target
            if ($existingTarget -and ($existingTarget -eq $panelDir -or $existingTarget -eq ($panelDir + "\"))) {
                $needLink = $false
            } else {
                $item.Delete()
            }
        } else {
            Remove-Item -Recurse -Force $targetDir
        }
    } catch {
        Remove-Item -Recurse -Force $targetDir -ErrorAction SilentlyContinue
    }
}
if ($needLink) {
    cmd.exe /c "mklink /J `"$targetDir`" `"$panelDir`"" | Out-Null
}
if (Test-Path $targetDir) { Write-OK "Panel linked (Window > Extensions > EditFlow AI)" }
else { Write-Err "Could not link the panel into $cepDir"; exit 1 }

# Allow the unsigned panel in Premiere Pro CEP runtimes (CSXS 9 -> 20).
foreach ($v in 9..20) {
    $regPath = "HKCU:\SOFTWARE\Adobe\CSXS.$v"
    if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
    Set-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value 1 -Type String -Force
}
Write-OK "Extension allowed for your Premiere Pro version"

# -- Step 5: Desktop shortcut to THIS file (so it's always one click) ------
try {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktop "EditFlow AI.lnk"
    if (-not (Test-Path $shortcutPath)) {
        $ws = New-Object -ComObject WScript.Shell
        $sc = $ws.CreateShortcut($shortcutPath)
        $sc.TargetPath = $BatFile
        $sc.WorkingDirectory = $ScriptDir
        $sc.IconLocation = "shell32.dll,13"
        $sc.Description = "EditFlow AI - install/start with one click"
        $sc.Save()
        Write-OK "Desktop shortcut created: EditFlow AI"
    }
} catch { Write-Warn "Could not create a desktop shortcut (not important)." }

# -- Step 6: Start the backend ---------------------------------------------
Write-Step "Starting the backend..."
# Free the port if an old backend is still running.
try {
    Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
} catch {}

try {
    $gpuName = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>&1)
    if ($LASTEXITCODE -eq 0 -and $gpuName) {
        Write-OK "Hardware Acceleration: $gpuName (CUDA enabled)"
    } else {
        Write-Info "Hardware Acceleration: CPU mode (throttled to 50% cores, UI responsive)"
    }
} catch {
    Write-Info "Hardware Acceleration: CPU mode (throttled to 50% cores, UI responsive)"
}

if (-not (Test-Path (Join-Path $InstallDir "data\hf-cache"))) {
    Write-Warn "First time: open the panel's Settings and download a Whisper model"
    Write-Warn "before your first transcription."
}

Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Green
Write-Host "    EditFlow AI is running." -ForegroundColor Green
Write-Host "  ==================================================" -ForegroundColor Green
Write-Host "    1. Open Premiere Pro" -ForegroundColor White
Write-Host "    2. Window > Extensions > EditFlow AI" -ForegroundColor White
Write-Host "    3. KEEP THIS WINDOW OPEN while you work" -ForegroundColor Yellow
Write-Host ""

# Add bundled NVIDIA CUDA/cuBLAS DLL directories from .venv to PATH
$nvidiaDir = Join-Path $VenvDir "Lib\site-packages\nvidia"
if (Test-Path $nvidiaDir) {
    Get-ChildItem $nvidiaDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $binDir = Join-Path $_.FullName "bin"
        if (Test-Path $binDir) { $env:PATH = "$binDir;$env:PATH" }
    }
}

Set-Location $InstallDir
& $pyExe run.py --prod
