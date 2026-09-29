param([ValidateSet('verify', 'load')][string]$Action = 'verify')
$ErrorActionPreference = 'Stop'
$bundleRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $bundleRoot 'manifest.json') | ConvertFrom-Json
foreach ($item in $manifest.files) {
    $path = Join-Path $bundleRoot ($item.path -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing: $($item.path)" }
    $file = Get-Item -LiteralPath $path
    if ($file.Length -ne $item.size) { throw "Size mismatch: $($item.path)" }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $item.sha256) { throw "Hash mismatch: $($item.path)" }
}
$actualFiles = @(Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -Force)
if ($actualFiles.Count -ne ($manifest.files.Count + 1)) { throw 'Bundle contains missing or extra files' }
Write-Host 'Bundle files verified.'
if ($Action -eq 'load') {
    for ($index = 0; $index -lt $manifest.images.PSObject.Properties.Count; $index++) {
        $archiveName = '{0:D2}.tar' -f $index
        $archive = Join-Path $bundleRoot (Join-Path 'images' $archiveName)
        docker load -i $archive
        if ($LASTEXITCODE -ne 0) { throw "Docker load failed: $archiveName" }
    }
    foreach ($property in $manifest.images.PSObject.Properties) {
        $actual = docker image inspect --format '{{.Id}}' $property.Name
        if ($LASTEXITCODE -ne 0 -or $actual.Trim() -ne $property.Value) {
            throw "Image ID mismatch: $($property.Name)"
        }
    }
    Write-Host 'Docker image IDs verified.'
}
