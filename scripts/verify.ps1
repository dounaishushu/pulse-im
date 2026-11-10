param([string]$GoBinary = "go")
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($env:PULSE_TEST_POSTGRES_DSN)) {
    throw "Set PULSE_TEST_POSTGRES_DSN to an isolated pulse_linyu_eval database before verification."
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $projectRoot ".local/verification"
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Push-Location (Join-Path $projectRoot "server")
$previousWork = $env:GOWORK
$env:GOWORK = Join-Path $projectRoot "server/go.legacy.work"
try {
    & $GoBinary test ./linyu-im/internal/ws ./linyu-basic-service/pkg/model -json -count=1 *> (Join-Path $outputRoot "tests.jsonl")
    if ($LASTEXITCODE -ne 0) { throw "Tests failed; inspect .local/verification/tests.jsonl" }
    $events = Get-Content -LiteralPath (Join-Path $outputRoot "tests.jsonl") | ForEach-Object {
        if ($_.StartsWith("{")) { $_ | ConvertFrom-Json }
    }
    if (@($events | Where-Object { $_.Test -and $_.Action -eq "skip" }).Count -gt 0) {
        throw "A required test was skipped."
    }
    & $GoBinary build -o (Join-Path $outputRoot "pulse-im-evaluation.exe") ./legacy-entry
    if ($LASTEXITCODE -ne 0) { throw "Core build failed." }
    Write-Output "Targeted tests and core build passed. This is not a load or production acceptance test."
} finally {
    $env:GOWORK = $previousWork
    Pop-Location
}
