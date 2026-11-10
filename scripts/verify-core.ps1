param(
    [string]$GoBinary = "go",
    [switch]$Race,
    [string]$OutputDirectory
)
$ErrorActionPreference = "Stop"
if (-not $env:PULSE_CORE_TEST_DSN -or -not $env:PULSE_CORE_TEST_REDIS_URL) {
    throw "Set PULSE_CORE_TEST_DSN (localhost/pulse_core_test) and PULSE_CORE_TEST_REDIS_URL for isolated test services."
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$startedAt = [DateTime]::UtcNow
$runID = $startedAt.ToString("yyyyMMddTHHmmssfffZ")
$outputRoot = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $projectRoot ".local/core-verification/$runID" }
if ((Test-Path -LiteralPath $outputRoot) -and @(Get-ChildItem -LiteralPath $outputRoot -Force).Count -gt 0) {
    throw "Use an empty verification output directory; previous evidence must not be overwritten."
}
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$sourcePaths = @("server/main.go", "server/go.mod", "server/go.sum", "server/go.work", "server/go.work.sum", "scripts/verify-core.ps1")
$sourcePaths += @(Get-ChildItem -LiteralPath (Join-Path $projectRoot "server/internal") -Recurse -File | ForEach-Object { $_.FullName.Substring($projectRoot.Length + 1).Replace('\', '/') })
$sourceManifest = @($sourcePaths | Sort-Object | ForEach-Object {
    [pscustomobject]@{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $projectRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$sourceManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $outputRoot "sources.json") -Encoding utf8
function Read-TestEvents([string]$Path) {
    @(Get-Content -LiteralPath $Path | Where-Object { $_.StartsWith("{") } | ForEach-Object { $_ | ConvertFrom-Json })
}
$previousOS = $env:GOOS
$previousArch = $env:GOARCH
$previousCGO = $env:CGO_ENABLED
$previousWork = $env:GOWORK
$env:GOWORK = Join-Path $projectRoot "server/go.work"
Push-Location (Join-Path $projectRoot "server")
try {
    Remove-Item Env:GOOS -ErrorAction SilentlyContinue
    Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
    $env:CGO_ENABLED = "0"
    & $GoBinary test ./... -json -count=1 *> (Join-Path $outputRoot "tests.jsonl")
    if ($LASTEXITCODE -ne 0) { throw "Core tests failed: $outputRoot/tests.jsonl" }
    $events = Get-Content -LiteralPath (Join-Path $outputRoot "tests.jsonl") | Where-Object { $_.StartsWith("{") } | ForEach-Object { $_ | ConvertFrom-Json }
    $passed = @($events | Where-Object { $_.Test -and $_.Action -eq "pass" }).Count
    $skipped = @($events | Where-Object { $_.Test -and $_.Action -eq "skip" }).Count
    if ($skipped -ne 0 -or $passed -lt 36) { throw "Incomplete test run: required integration tests may not be skipped." }
    $racePassed = 0
    if ($Race) {
        $env:CGO_ENABLED = "1"
        & $GoBinary test -race ./... -json -count=1 *> (Join-Path $outputRoot "race-tests.jsonl")
        if ($LASTEXITCODE -ne 0) { throw "Race tests failed: $outputRoot/race-tests.jsonl" }
        $raceEvents = @(Read-TestEvents (Join-Path $outputRoot "race-tests.jsonl"))
        $racePassed = @($raceEvents | Where-Object { $_.Test -and $_.Action -eq "pass" }).Count
        $expectedTests = @($events | Where-Object { $_.Test -and $_.Action -eq "pass" } | ForEach-Object { "$($_.Package):$($_.Test)" } | Sort-Object)
        $actualTests = @($raceEvents | Where-Object { $_.Test -and $_.Action -eq "pass" } | ForEach-Object { "$($_.Package):$($_.Test)" } | Sort-Object)
        if (@($raceEvents | Where-Object { $_.Test -and $_.Action -eq "skip" }).Count -ne 0 -or (Compare-Object $expectedTests $actualTests)) {
            throw "Race run did not verify the same named tests."
        }
        $env:CGO_ENABLED = "0"
    }
    & $GoBinary vet ./...
    if ($LASTEXITCODE -ne 0) { throw "go vet failed." }
    & $GoBinary build -trimpath -o (Join-Path $outputRoot "pulse-im.exe") .
    if ($LASTEXITCODE -ne 0) { throw "Windows build failed." }
    $env:GOOS = "linux"
    $env:GOARCH = "amd64"
    & $GoBinary build -trimpath -o (Join-Path $outputRoot "pulse-im-linux-amd64") .
    if ($LASTEXITCODE -ne 0) { throw "Linux cross-build failed." }
    & $GoBinary list -deps . > (Join-Path $outputRoot "dependencies.txt")
    if ($LASTEXITCODE -ne 0) { throw "Dependency graph check failed." }
    if (Select-String -Path (Join-Path $outputRoot "dependencies.txt") -Pattern "rocketmq|weaviate|chromem|livekit|linyu-ai|linyu-cloud-drive|linyu-application") {
        throw "Unneeded optional modules entered the active binary."
    }
    foreach ($source in $sourceManifest) {
        if ((Get-FileHash -LiteralPath (Join-Path $projectRoot $source.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $source.sha256) {
            throw "Source changed during verification: $($source.path); evidence would not describe one build."
        }
    }
    $artifactNames = @("pulse-im.exe", "pulse-im-linux-amd64", "tests.jsonl", "dependencies.txt", "sources.json")
    if ($Race) { $artifactNames += "race-tests.jsonl" }
    $artifacts = @($artifactNames | ForEach-Object {
        $artifactPath = Join-Path $outputRoot $_
        [pscustomobject]@{ name = $_; bytes = (Get-Item -LiteralPath $artifactPath).Length; sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    [ordered]@{
        run_id = $runID; started_at_utc = $startedAt.ToString("o"); completed_at_utc = [DateTime]::UtcNow.ToString("o")
        go_version = (& $GoBinary version); source_manifest = "sources.json"; source_unchanged_during_run = $true
        tests_passed_including_subtests = $passed; named_tests_skipped = $skipped; race_requested = [bool]$Race; race_passed_including_subtests = $racePassed
        vet = "passed"; windows_build = "passed"; linux_cross_build = "passed; not a runtime test"; dependency_check = "passed"
        artifacts = $artifacts; production_changed = $false; ten_thousand_online = "not tested"; old_frontend_integration = "not tested"
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputRoot "verification.json") -Encoding utf8
    Write-Output "PASS: $passed named test events, no skips; vet and both builds passed; race passed: $racePassed. Evidence: $outputRoot"
} finally {
    Pop-Location
    $env:GOOS = $previousOS
    $env:GOARCH = $previousArch
    $env:CGO_ENABLED = $previousCGO
    $env:GOWORK = $previousWork
}
