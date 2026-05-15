$ErrorActionPreference = 'Stop'

$src = Resolve-Path 'F:\AI_VIDEO_AUTOMATION\EditFlow_AI_MultiProvider\cep-panel'
$root = Resolve-Path 'C:\Program Files\Adobe\Adobe Premiere Pro 2026\CEP\extensions'
$dst = Join-Path $root 'cep-panel'

$resolvedRoot = [System.IO.Path]::GetFullPath($root.Path)
$resolvedDst = [System.IO.Path]::GetFullPath($dst)
if (-not $resolvedDst.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside extension root: $resolvedDst"
}

if (Test-Path -LiteralPath $dst) {
    Remove-Item -LiteralPath $dst -Recurse -Force
}
Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force

$diffs = @()
foreach ($file in Get-ChildItem -LiteralPath $src -Recurse -File) {
    $rel = $file.FullName.Substring($src.Path.Length).TrimStart('\')
    $installed = Join-Path $dst $rel
    if (!(Test-Path -LiteralPath $installed)) {
        $diffs += "MISSING $rel"
    } elseif ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $installed).Hash) {
        $diffs += "DIFF $rel"
    }
}

if ($diffs.Count -gt 0) {
    $diffs | ForEach-Object { Write-Host $_ }
    throw "CEP deployment verification failed."
}

Write-Host "EditFlow AI CEP extension deployed and verified."
