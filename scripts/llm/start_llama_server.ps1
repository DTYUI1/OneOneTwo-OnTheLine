param(
    [Parameter(Mandatory = $true)]
    [string]$ModelRepo,
    [string]$Alias = "local-model",
    [int]$Port = 8080,
    [int]$Threads = 8,
    [int]$Context = 4096,
    [ValidateSet(1, 2)]
    [int]$Parallel = 1,
    [switch]$CpuOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker недоступен. Запустите Docker Desktop и повторите команду."
}

$image = if ($CpuOnly) {
    "ghcr.io/ggml-org/llama.cpp:server"
} else {
    "ghcr.io/ggml-org/llama.cpp:server-cuda"
}

$arguments = @(
    "run", "--rm", "--pull", "missing",
    "--name", "arm112-llm-test",
    "-p", "127.0.0.1:${Port}:8080",
    # The -hf downloader uses Hugging Face's cache, not the legacy llama.cpp path.
    "-v", "arm112-llama-cache:/root/.cache/huggingface"
)
if (-not $CpuOnly) {
    $arguments += @("--gpus", "all")
}
$arguments += @(
    $image,
    "-hf", $ModelRepo,
    "--alias", $Alias,
    "--host", "0.0.0.0",
    "--port", "8080",
    "--ctx-size", $Context,
    "--threads", $Threads,
    "--threads-batch", $Threads,
    "--parallel", $Parallel,
    "--cont-batching",
    "--cache-prompt",
    "--metrics",
    "--no-webui"
)
if ($CpuOnly) {
    $arguments += @("--device", "none", "--n-gpu-layers", "0")
} else {
    $arguments += @("--n-gpu-layers", "auto", "--fit-target", "512")
}

Write-Host "Model: $ModelRepo"
Write-Host "Runtime: $image; CPU threads=$Threads; parallel slots=$Parallel"
Write-Host "Endpoint: http://127.0.0.1:$Port/v1"
Write-Host "Остановить сервер: Ctrl+C"
& docker @arguments
exit $LASTEXITCODE
