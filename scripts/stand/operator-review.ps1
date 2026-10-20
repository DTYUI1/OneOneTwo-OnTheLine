# Локальный стенд и чек-лист OP-11–19. PowerShell 5.1+, запуск из любой папки.
param(
    [switch]$Build,
    [switch]$Tests,
    [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$reviewRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$reviewEnv = Join-Path $PSScriptRoot '.local/arm112-operator/stand.env'
$reviewOverride = Join-Path $PSScriptRoot '.local/arm112-operator/compose.override.yml'
if (!(Test-Path -LiteralPath $reviewEnv) -or !(Test-Path -LiteralPath $reviewOverride)) {
    throw 'Сначала подготовьте стенд: scripts/stand/up.sh --project arm112-operator --ports 8080:8443'
}
$reviewCompose = @('compose', '-p', 'arm112-operator', '-f', 'deploy/docker-compose.yml', '-f', $reviewOverride, '--env-file', $reviewEnv)
function Invoke-ReviewCompose {
    & docker @reviewCompose @args
    if ($LASTEXITCODE -ne 0) { throw "Ошибка docker compose (код $LASTEXITCODE)." }
}
Push-Location $reviewRoot
try {
    if ($Build) {
        Invoke-ReviewCompose build api
        Invoke-ReviewCompose build web
    }
    Invoke-ReviewCompose up -d --wait db
    Invoke-ReviewCompose run --rm --no-deps migrate
    Invoke-ReviewCompose run --rm --no-deps api python -m app.seed
    Invoke-ReviewCompose run --rm --no-deps api python -m app.seed.training
    Invoke-ReviewCompose up -d --wait --wait-timeout 180 api worker web
    $reviewHealth = & curl.exe -ksSf 'https://localhost:8443/api/health'
    if ($LASTEXITCODE -ne 0 -or ($reviewHealth | ConvertFrom-Json).status -ne 'ok') {
        throw 'Стенд не отвечает. Проверьте контейнеры проекта arm112-operator.'
    }
    Write-Host 'Стенд готов: https://localhost:8443/app/login'
    Write-Host 'Учётки: trainee01, teacher, admin. Пароль — DEMO_PASSWORD в локальном stand.env.'
    if ($Tests) {
        $reviewNames = @('DEMO_PASSWORD', 'E2E_DATABASE', 'E2E_BASE_URL', 'OPERATOR_SHOTS', 'OPERATOR_SHOTS_OUT', 'OPERATOR_DEMO')
        $reviewPrevious = @{}
        foreach ($reviewName in $reviewNames) {
            $reviewPrevious[$reviewName] = [Environment]::GetEnvironmentVariable($reviewName, 'Process')
        }
        try {
            $reviewPasswordLine = Get-Content -LiteralPath $reviewEnv -Encoding UTF8 | Where-Object { $_ -match '^DEMO_PASSWORD=' } | Select-Object -First 1
            $env:DEMO_PASSWORD = $reviewPasswordLine.Substring('DEMO_PASSWORD='.Length)
            $env:E2E_DATABASE = '1'
            $env:E2E_BASE_URL = 'https://localhost:8443'
            $env:OPERATOR_SHOTS = '1'
            $env:OPERATOR_DEMO = '0'
            foreach ($reviewBrowser in @('chromium', 'firefox')) {
                $env:OPERATOR_SHOTS_OUT = "docs/operator_112_review/stage4/op11-19/$reviewBrowser"
                & pnpm exec playwright test -c qa/playwright.config.ts 'operator-.*\.spec\.ts' "--project=$reviewBrowser" --workers=1 --reporter=line
                if ($LASTEXITCODE -ne 0) { throw "Браузерные проверки не прошли (код $LASTEXITCODE). Трассы — qa/results." }
            }
        } finally {
            foreach ($reviewName in $reviewNames) {
                [Environment]::SetEnvironmentVariable($reviewName, $reviewPrevious[$reviewName], 'Process')
            }
        }
    }
    if (!$NoOpen) {
        Start-Process -FilePath (Join-Path $reviewRoot 'docs/operator_112_review/acceptance.html')
    }
} finally {
    Pop-Location
}
