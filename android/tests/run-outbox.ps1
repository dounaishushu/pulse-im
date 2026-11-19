param([string]$JavaHome = $env:JAVA_HOME, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$javac = if ($JavaHome) { Join-Path $JavaHome 'bin/javac.exe' } else { (Get-Command javac -ErrorAction Stop).Source }
$java = Join-Path (Split-Path -Parent $javac) 'java.exe'
if (-not (Test-Path -LiteralPath $javac) -or -not (Test-Path -LiteralPath $java)) { throw 'Set JavaHome to a JDK 17 or newer.' }
$outputRoot = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $projectRoot ('.local/android-outbox-tests/' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')) }
if ((Test-Path -LiteralPath $outputRoot) -and @(Get-ChildItem -LiteralPath $outputRoot -Force).Count -gt 0) { throw 'Use an empty test output directory.' }
$classes = Join-Path $outputRoot 'classes'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$sources = @('OutboxAttachments.java', 'OutboxPersistence.java', 'OutboxCodec.java', 'DurableMediaOutbox.java') | ForEach-Object { Join-Path $projectRoot "android/app/src/main/java/com/pulseim/android/$_" }
$sources += Join-Path $PSScriptRoot 'OutboxAttachmentsChecks.java'
& $javac -encoding UTF-8 -d $classes @sources 2>&1 | Tee-Object -LiteralPath (Join-Path $outputRoot 'compile.log')
if ($LASTEXITCODE -ne 0) { throw 'Attachment checks did not compile.' }
& $java '-Dfile.encoding=UTF-8' -cp $classes com.pulseim.android.OutboxAttachmentsChecks 2>&1 | Tee-Object -LiteralPath (Join-Path $outputRoot 'checks.log')
if ($LASTEXITCODE -ne 0) { throw 'Attachment checks failed.' }
Write-Output "Evidence: $outputRoot"
