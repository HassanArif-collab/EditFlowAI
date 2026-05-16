$ErrorActionPreference = 'Stop'

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-RepoRoot {
    $scriptPath = Split-Path -Parent $PSCommandPath
    return (Resolve-Path (Join-Path $scriptPath '..')).Path
}

function Find-PremiereCepExtensionsRoot {
    $adobeRoot = Join-Path $env:ProgramFiles 'Adobe'
    if (-not (Test-Path -LiteralPath $adobeRoot)) {
        throw "Adobe folder was not found under Program Files: $adobeRoot"
    }

    $premiereDirs = Get-ChildItem -LiteralPath $adobeRoot -Directory -Filter 'Adobe Premiere Pro *' |
        Sort-Object Name -Descending

    if (-not $premiereDirs -or $premiereDirs.Count -eq 0) {
        throw "No Adobe Premiere Pro installation was found under: $adobeRoot"
    }

    foreach ($dir in $premiereDirs) {
        $cepRoot = Join-Path $dir.FullName 'CEP\extensions'
        if (Test-Path -LiteralPath $cepRoot) {
            return (Resolve-Path -LiteralPath $cepRoot).Path
        }
    }

    $latest = $premiereDirs[0].FullName
    $created = Join-Path $latest 'CEP\extensions'
    New-Item -ItemType Directory -Path $created -Force | Out-Null
    return (Resolve-Path -LiteralPath $created).Path
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory=$true)][string]$Root,
        [Parameter(Mandatory=$true)][string]$Child
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    $resolvedChild = [System.IO.Path]::GetFullPath($Child)
    if (-not $resolvedChild.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside CEP extensions root: $resolvedChild"
    }
}

function Remove-ExtensionIfExists {
    param(
        [Parameter(Mandatory=$true)][string]$ExtensionsRoot,
        [Parameter(Mandatory=$true)][string]$Name
    )

    $target = Join-Path $ExtensionsRoot $Name
    Assert-ChildPath -Root $ExtensionsRoot -Child $target
    if (Test-Path -LiteralPath $target) {
        Write-Host "Removing old extension: $target"
        $item = Get-Item -LiteralPath $target -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            [System.IO.Directory]::Delete($target)
        } else {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
    }
}

function Copy-ExtensionFresh {
    param(
        [Parameter(Mandatory=$true)][string]$Source,
        [Parameter(Mandatory=$true)][string]$ExtensionsRoot,
        [Parameter(Mandatory=$true)][string]$Name
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "CEP panel source folder was not found: $Source"
    }

    $target = Join-Path $ExtensionsRoot $Name
    Assert-ChildPath -Root $ExtensionsRoot -Child $target
    Remove-ExtensionIfExists -ExtensionsRoot $ExtensionsRoot -Name $Name

    Write-Host "Copying CEP panel:"
    Write-Host "  From: $Source"
    Write-Host "  To:   $target"
    Copy-Item -LiteralPath $Source -Destination $target -Recurse -Force

    $sourceFiles = Get-ChildItem -LiteralPath $Source -Recurse -File
    $diffs = @()
    foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($Source.Length).TrimStart('\')
        $installed = Join-Path $target $relative
        if (-not (Test-Path -LiteralPath $installed)) {
            $diffs += "MISSING $relative"
            continue
        }
        $sourceHash = (Get-FileHash -LiteralPath $file.FullName).Hash
        $installedHash = (Get-FileHash -LiteralPath $installed).Hash
        if ($sourceHash -ne $installedHash) {
            $diffs += "DIFF $relative"
        }
    }

    if ($diffs.Count -gt 0) {
        $diffs | ForEach-Object { Write-Host $_ }
        throw "CEP copy verification failed."
    }

    Write-Host "CEP panel copied and verified."
    return $target
}

function Find-Python {
    param([Parameter(Mandatory=$true)][string]$RepoRoot)

    $candidates = @(
        (Join-Path $RepoRoot '.venv\Scripts\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Python\bin\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python314\python.exe')
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    foreach ($name in @('python', 'py')) {
        try {
            $cmd = Get-Command $name -ErrorAction Stop
            return $cmd.Source
        } catch {}
    }

    throw 'No Python executable was found. Install Python or create a .venv first.'
}

function Ensure-PythonDependencies {
    param(
        [Parameter(Mandatory=$true)][string]$Python,
        [Parameter(Mandatory=$true)][string]$RepoRoot
    )

    Write-Host "Checking Python dependencies..."
    & $Python -c "import fastapi, uvicorn, pydantic_settings" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Python dependencies are ready."
        return
    }

    $requirements = Join-Path $RepoRoot 'requirements.txt'
    if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) {
        throw "requirements.txt was not found: $requirements"
    }

    Write-Host "Installing Python dependencies from requirements.txt..."
    & $Python -m pip install -r $requirements
    if ($LASTEXITCODE -ne 0) {
        throw "Dependency installation failed."
    }
}

function Test-BackendAlreadyRunning {
    try {
        $response = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/ping' -TimeoutSec 2
        return $response.server -eq 'running'
    } catch {
        return $false
    }
}

function Get-BackendPortOwners {
    $owners = @()
    $lines = netstat -ano | Select-String '127\.0\.0\.1:8765\s+0\.0\.0\.0:0\s+LISTENING'
    foreach ($line in $lines) {
        $parts = ($line.ToString() -split '\s+') | Where-Object { $_ }
        if ($parts.Count -ge 5) {
            $pidText = $parts[$parts.Count - 1]
            $pidValue = 0
            if ([int]::TryParse($pidText, [ref]$pidValue)) {
                $owners += $pidValue
            }
        }
    }
    return $owners | Sort-Object -Unique
}

function Repair-StaleBackendPort {
    if (Test-BackendAlreadyRunning) {
        return
    }

    $owners = Get-BackendPortOwners
    if (-not $owners -or $owners.Count -eq 0) {
        return
    }

    Write-Host "Port 8765 is occupied, but the backend is not responding. Stopping stale process(es): $($owners -join ', ')"
    foreach ($pidValue in $owners) {
        & taskkill.exe /PID $pidValue /F | Out-Host
    }

    Start-Sleep -Seconds 1
    $remaining = Get-BackendPortOwners
    if ($remaining -and $remaining.Count -gt 0) {
        throw "Port 8765 is still occupied by process(es): $($remaining -join ', ')"
    }
}

function Start-Backend {
    param(
        [Parameter(Mandatory=$true)][string]$Python,
        [Parameter(Mandatory=$true)][string]$RepoRoot
    )

    if (Test-BackendAlreadyRunning) {
        Write-Host "Backend is already running at http://127.0.0.1:8765"
        Write-Host "Open Premiere Pro, then Window > Extensions > EditFlow AI."
        Read-Host "Press Enter to close this window"
        return
    }

    Write-Host ""
    Write-Host "Starting EditFlow AI backend..."
    Write-Host "Backend URL: http://127.0.0.1:8765"
    Write-Host "Keep this window open while using the extension."
    Write-Host ""
    Push-Location $RepoRoot
    try {
        $env:EDITFLOW_DEBUG = 'false'
        $env:PYTHONUNBUFFERED = '1'
        & $Python (Join-Path $RepoRoot 'run.py') --prod
        if ($LASTEXITCODE -ne 0) {
            throw "Backend exited with code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

try {
    if (-not (Test-IsAdministrator)) {
        Write-Host "Requesting administrator permission to copy the CEP extension into Program Files..."
        $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
        Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
        exit 0
    }

    $repoRoot = Find-RepoRoot
    $sourcePanel = Join-Path $repoRoot 'cep-panel'
    $extensionsRoot = Find-PremiereCepExtensionsRoot

    Write-Host "EditFlow AI launcher"
    Write-Host "Project: $repoRoot"
    Write-Host "Premiere CEP extensions: $extensionsRoot"
    Write-Host ""

    Remove-ExtensionIfExists -ExtensionsRoot $extensionsRoot -Name 'cep-panel'
    $installedPath = Copy-ExtensionFresh -Source $sourcePanel -ExtensionsRoot $extensionsRoot -Name 'editflow-ai'

    Write-Host ""
    Write-Host "Installed extension:"
    Write-Host "  $installedPath"
    Write-Host ""

    $python = Find-Python -RepoRoot $repoRoot
    Write-Host "Python: $python"
    Ensure-PythonDependencies -Python $python -RepoRoot $repoRoot
    Repair-StaleBackendPort
    Start-Backend -Python $python -RepoRoot $repoRoot
} catch {
    Write-Host ""
    Write-Host "EditFlow AI launcher failed:"
    Write-Host "  $($_.Exception.Message)"
    Write-Host ""
    Read-Host "Press Enter to close this window"
    exit 1
}
