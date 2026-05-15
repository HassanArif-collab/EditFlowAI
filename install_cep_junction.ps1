$ErrorActionPreference = 'Stop'

$src = Resolve-Path 'F:\AI_VIDEO_AUTOMATION\EditFlow_AI_MultiProvider\cep-panel'
$root = Resolve-Path 'C:\Program Files\Adobe\Adobe Premiere Pro 2026\CEP\extensions'
$dst = Join-Path $root 'editflow-ai'

$resolvedRoot = [System.IO.Path]::GetFullPath($root.Path)
$resolvedDst = [System.IO.Path]::GetFullPath($dst)
if (-not $resolvedDst.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside extension root: $resolvedDst"
}

if (Test-Path -LiteralPath $dst) {
    Remove-Item -LiteralPath $dst -Recurse -Force
}

New-Item -ItemType Junction -Path $dst -Target $src | Out-Null
Write-Host "Created CEP junction:"
Write-Host "  $dst"
Write-Host "  -> $src"
