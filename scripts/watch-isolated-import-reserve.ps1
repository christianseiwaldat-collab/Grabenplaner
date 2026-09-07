param(
  [Parameter(Mandatory = $true)][int]$ImportProcessId,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [long]$MinimumFreeBytes = 16106127360
)
$ErrorActionPreference = 'Stop'
$taskRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskReport = [IO.Path]::GetFullPath($ReportPath)
$taskTemporary = [IO.Path]::GetFullPath((Join-Path $taskRepository 'tmp')) + [IO.Path]::DirectorySeparatorChar
if (-not $taskReport.StartsWith($taskTemporary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Report must belong to an isolated repository test.' }
if (-not (Test-Path -LiteralPath $taskReport -PathType Leaf)) { throw 'Test report missing.' }
if ($MinimumFreeBytes -lt 10737418240) { throw 'The disk reserve must not be reduced.' }
$taskReportData = Get-Content -LiteralPath $taskReport -Raw | ConvertFrom-Json
if ($taskReportData.purpose -ne 'full-source-backup-measurement') { throw 'Unrelated test report.' }
$taskProcess = Get-Process -Id $ImportProcessId -ErrorAction Stop
$taskStarted = $taskProcess.StartTime.ToUniversalTime().Ticks
$taskExecutable = $taskProcess.Path
$taskCommand = (Get-CimInstance Win32_Process -Filter "ProcessId = $ImportProcessId").CommandLine
if (-not $taskCommand.Contains('scripts/verify-tradefoto-full-import.mjs') -or -not $taskCommand.Contains('--measure-backup')) { throw 'Unrelated process.' }
$taskDrive = [IO.Path]::GetPathRoot($taskReport)
$taskPreviousFreeGiB = -1
while ($true) {
  $taskCurrent = Get-Process -Id $ImportProcessId -ErrorAction SilentlyContinue
  if (-not $taskCurrent -or $taskCurrent.StartTime.ToUniversalTime().Ticks -ne $taskStarted -or $taskCurrent.Path -ne $taskExecutable) {
    Write-Output 'Isolated import ended; reserve monitoring finished.'
    break
  }
  $taskFree = ([IO.DriveInfo]::new($taskDrive)).AvailableFreeSpace
  $taskFreeGiB = [Math]::Floor($taskFree / 1073741824)
  if ($taskFreeGiB -ne $taskPreviousFreeGiB) {
    Write-Output ("Isolated import reserve: {0} GiB free." -f $taskFreeGiB)
    $taskPreviousFreeGiB = $taskFreeGiB
  }
  if ($taskFree -lt $MinimumFreeBytes) {
    # A Restic measurement child can otherwise outlive a killed Node parent and
    # keep consuming disk. Capture identities before terminating this exact tree.
    $taskProcessInventory = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
    $taskTreeIds = [Collections.Generic.HashSet[int]]::new()
    [void]$taskTreeIds.Add($ImportProcessId)
    do {
      $taskAdded = $false
      foreach ($taskEntry in $taskProcessInventory) {
        if ($taskTreeIds.Contains([int]$taskEntry.ParentProcessId) -and $taskTreeIds.Add([int]$taskEntry.ProcessId)) { $taskAdded = $true }
      }
    } while ($taskAdded)
    $taskTree = @($taskProcessInventory | Where-Object { $taskTreeIds.Contains([int]$_.ProcessId) })
    # Recheck exact process identity immediately before stopping this disposable
    # test only. No source, repository, backup or generated file is deleted here.
    $taskCurrent = Get-Process -Id $ImportProcessId -ErrorAction Stop
    if ($taskCurrent.StartTime.ToUniversalTime().Ticks -ne $taskStarted -or $taskCurrent.Path -ne $taskExecutable) { throw 'Process identity changed.' }
    $taskKillExecutable = Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe'
    & $taskKillExecutable /PID $ImportProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'ISOLATED_TEST_TREE_STOP_UNVERIFIED; taskkill did not confirm the exact tree.' }
    $taskStopDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      $taskRemaining = @($taskTree | Where-Object {
        $taskSurvivor = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$_.ProcessId)
        $taskSurvivor -and $taskSurvivor.CreationDate.ToUniversalTime().Ticks -eq $_.CreationDate.ToUniversalTime().Ticks
      })
      if ($taskRemaining.Count -eq 0) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $taskStopDeadline)
    if ($taskRemaining.Count -ne 0) { throw 'ISOLATED_TEST_TREE_STOP_UNVERIFIED; a captured process identity is still alive.' }
    Write-Output 'ISOLATED_TEST_TREE_STOPPED_FOR_DISK_RESERVE; no source or backup files removed.'
    exit 2
  }
  Start-Sleep -Seconds 1
}
