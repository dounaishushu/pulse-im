param(
 [Parameter(Mandatory=$true)][int[]]$ProcessIds,
 [int]$Seconds=60,
 [int]$IntervalSeconds=2,
 [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
if($Seconds -lt 1 -or $Seconds -gt 3600 -or $IntervalSeconds -lt 1){throw 'Invalid sampling bounds'}
$outputPath=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $outputPath){throw 'Output directory already exists; preserve prior evidence'}
New-Item -ItemType Directory -Path $outputPath | Out-Null
$started=[DateTime]::UtcNow
$identities=@{}
foreach($targetId in $ProcessIds){$p=Get-Process -Id $targetId;$identities[$targetId]=$p.StartTime.ToUniversalTime().ToString('o')}
$recorded=New-Object System.Collections.Generic.List[object]
while(([DateTime]::UtcNow-$started).TotalSeconds -lt $Seconds){
 $sample=@{utc=[DateTime]::UtcNow.ToString('o');processes=@()}
 foreach($targetId in $ProcessIds){
  $p=Get-Process -Id $targetId -ErrorAction SilentlyContinue
  if($p -and $p.StartTime.ToUniversalTime().ToString('o') -eq $identities[$targetId]){
   $sample.processes+=@{pid=$targetId;name=$p.ProcessName;working_set_bytes=$p.WorkingSet64;private_bytes=$p.PrivateMemorySize64;peak_working_set_bytes=$p.PeakWorkingSet64;cpu_seconds=$p.TotalProcessorTime.TotalSeconds;handles=$p.HandleCount;threads=$p.Threads.Count}
  }else{$sample.processes+=@{pid=$targetId;exited=$true}}
 }
 ($sample | ConvertTo-Json -Depth 6 -Compress) | Add-Content -LiteralPath (Join-Path $outputPath 'samples.jsonl') -Encoding UTF8
 $recorded.Add($sample)
 Start-Sleep -Seconds $IntervalSeconds
}
$maxRSS=0L
foreach($sample in $recorded){$total=0L;foreach($p in $sample.processes){$total+=[long]$p.working_set_bytes};$maxRSS=[Math]::Max($maxRSS,$total)}
@{started_at=$started.ToString('o');completed_at=[DateTime]::UtcNow.ToString('o');samples=$recorded.Count;processes=$ProcessIds;max_aggregate_working_set_bytes=$maxRSS;logical_processors=[Environment]::ProcessorCount;capacity_acceptance=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputPath 'summary.json') -Encoding UTF8
