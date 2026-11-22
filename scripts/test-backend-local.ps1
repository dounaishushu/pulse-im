param(
    [ValidateSet('Start','Stop','Status','Test')]
    [string]$Action = 'Test',
    [string]$Run = ''
)
$ErrorActionPreference = 'Stop'
$labPython = 'C:\Python314\python.exe'
if (-not (Test-Path -LiteralPath $labPython)) {
    $labPython = (Get-Command python.exe -ErrorAction Stop).Source
}
$labArguments = @((Join-Path $PSScriptRoot 'backend_local_env.py'), $Action.ToLowerInvariant())
if ($Run) { $labArguments += @('--run', $Run) }
& $labPython @labArguments
exit $LASTEXITCODE
