param(
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [string]$Model = "local-model",
    [string]$BaseUrl = "http://127.0.0.1:8080/v1",
    [ValidateSet(1, 2)]
    [int]$Concurrency = 1,
    [int]$Runs = 3,
    [int]$CaseLimit = 10,
    [string]$HardwareLabel = "i7-11800H; 16 GB RAM; RTX 3050 Laptop 4 GB"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$uvCommand = Get-Command uv -ErrorAction SilentlyContinue
if ($null -ne $uvCommand) {
    $uvExecutable = $uvCommand.Source
}
else {
    $localUv = Join-Path $repositoryRoot "tmp\tools\bin\uv.exe"
    if (-not (Test-Path -LiteralPath $localUv)) {
        throw "uv не найден ни в PATH, ни в tmp/tools/bin/uv.exe"
    }
    $uvExecutable = $localUv
}
Push-Location $repositoryRoot
$benchmarkExitCode = 1
try {
    & $uvExecutable run --package arm112-api python -m app.tools.llm_benchmark `
        --base-url $BaseUrl `
        --model $Model `
        --label $Label `
        --concurrency $Concurrency `
        --runs $Runs `
        --case-limit $CaseLimit `
        --hardware-label $HardwareLabel
    $benchmarkExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $benchmarkExitCode
