$ErrorActionPreference = 'Stop'

$repo = Resolve-Path 'F:\AI_VIDEO_AUTOMATION\EditFlow_AI_MultiProvider'
$taskName = 'EditFlow AI Backend'
$pythonCandidates = @(
    (Join-Path $repo '.venv\Scripts\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python314\python.exe'),
    'python'
)

$python = $null
foreach ($candidate in $pythonCandidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $python = (Resolve-Path -LiteralPath $candidate).Path
        break
    }
    try {
        $cmd = Get-Command $candidate -ErrorAction Stop
        $python = $cmd.Source
        break
    } catch {}
}

if (-not $python) {
    throw 'No Python executable found. Install Python or create .venv before registering the backend task.'
}

$action = New-ScheduledTaskAction -Execute $python -Argument 'run.py --prod' -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Starts EditFlow AI backend at Windows login.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Registered and started scheduled task: $taskName"
