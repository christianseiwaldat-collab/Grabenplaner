[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$BackupFile,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DatabasePath,

    [string]$ServiceName = 'GrabenplanerServer',
    [string]$NodeExecutable = 'node',
    [string]$InternalHealthUrl = 'http://127.0.0.1:3000/api/health/ready',
    [string]$AppDirectory = 'C:\Program Files\Grabenplaner\app',
    [string]$AmuBackupDirectory,
    [string]$AmuDirectory = 'C:\ProgramData\Grabenplaner\private\amu',
    [string]$AmuKeyId,
    [string]$AmuEncryptionKey,
    [string]$ServiceXmlPath,
    [switch]$StartServiceAfterRestore
)

$ErrorActionPreference = 'Stop'

function Assert-LocalFile([string]$Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\')) { throw "SQLite-Dateien auf Netzpfaden werden nicht unterstuetzt: $fullPath" }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Datei nicht gefunden: $fullPath" }
    return $fullPath
}

function Test-SameOrChildPath([string]$Candidate, [string]$Parent) {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
    return $candidatePath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
        $candidatePath.StartsWith($parentPath + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SeparateTrees([string]$First, [string]$Second, [string]$Label) {
    if ((Test-SameOrChildPath $First $Second) -or (Test-SameOrChildPath $Second $First)) {
        throw "$Label muessen vollstaendig getrennte Ordnerbaeume sein."
    }
}

function Test-SqliteDatabase([string]$Path) {
    $script = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const result = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
  if (result.length !== 1 || result[0] !== 'ok') throw new Error(result.join('; '));
  process.stdout.write('ok');
} finally { db.close(); }
'@
    $output = $script | & $NodeExecutable - $Path
    if ($LASTEXITCODE -ne 0 -or ($output | Select-Object -Last 1) -ne 'ok') {
        throw "SQLite-Integritaetspruefung fehlgeschlagen: $Path"
    }
}

function New-SafetyBackup([string]$Source, [string]$Target) {
    $script = @'
const { DatabaseSync } = require('node:sqlite');
const [source, target] = process.argv.slice(2);
const db = new DatabaseSync(source);
try {
  const escaped = target.replaceAll('\\', '/').replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally { db.close(); }
'@
    $script | & $NodeExecutable - $Source $Target
    if ($LASTEXITCODE -ne 0) { throw 'Sicherheitsbackup vor der Wiederherstellung fehlgeschlagen.' }
    Test-SqliteDatabase -Path $Target
}

function Invoke-AmuStorage([string]$Action, [string]$ModulePath, [string]$Source, [string]$Target) {
    $script = @'
const [action, modulePath, source, target] = process.argv.slice(2);
const storage = require(modulePath);
const result = action === 'backup'
  ? storage.syncEncryptedFilesBackup({ sourceDirectory: source, targetDirectory: target })
  : storage.restoreEncryptedFilesBackup({ backupDirectory: source, targetDirectory: target });
process.stdout.write(JSON.stringify({ ok: true, fileCount: result.fileCount }));
'@
    $result = $script | & $NodeExecutable - $Action $ModulePath $Source $Target
    if ($LASTEXITCODE -ne 0) { throw "AMU-Dateivorgang '$Action' ist fehlgeschlagen." }
    $verification = $result | Select-Object -Last 1 | ConvertFrom-Json
    if (-not $verification.ok) { throw "AMU-Dateivorgang '$Action' konnte nicht verifiziert werden." }
    return $verification
}

function Start-DatabaseMaintenanceLock([string]$Path, [string]$AppRoot, [string]$WorkingDirectory) {
    $lockModule = Join-Path $AppRoot 'lib\database-lock.js'
    if (-not (Test-Path -LiteralPath $lockModule -PathType Leaf)) { throw "Datenbanksperrmodul nicht gefunden: $lockModule" }
    $helperPath = Join-Path $WorkingDirectory ".database-maintenance-lock-$([Guid]::NewGuid().ToString('N')).js"
    $script = @'
const [modulePath, databasePath] = process.argv.slice(2);
const { acquireDatabaseLock, releaseDatabaseLock } = require(modulePath);
const lock = acquireDatabaseLock({ databasePath, kind: 'backup', appVersion: 'server-restore-probe' });
let released = false;
function release() {
  if (released) return;
  released = true;
  try { releaseDatabaseLock(lock); } finally { process.exit(0); }
}
process.stdout.write('LOCKED\n');
process.stdin.setEncoding('utf8');
process.stdin.once('data', release);
process.stdin.once('end', release);
process.on('SIGTERM', release);
setInterval(() => {}, 60_000);
'@
    [System.IO.File]::WriteAllText($helperPath, $script, [Text.UTF8Encoding]::new($false))
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $NodeExecutable
    $startInfo.Arguments = '"{0}" "{1}" "{2}"' -f $helperPath.Replace('"', '\"'), $lockModule.Replace('"', '\"'), $Path.Replace('"', '\"')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Der Datenbank-Wartungslock konnte nicht gestartet werden.' }
        $lineTask = $process.StandardOutput.ReadLineAsync()
        if (-not $lineTask.Wait(10000) -or $lineTask.Result -ne 'LOCKED') {
            if (-not $process.HasExited) { $process.Kill() }
            $detail = $process.StandardError.ReadToEnd()
            throw "Die Datenbank wird noch verwendet oder der Wartungslock ist fehlgeschlagen. $detail"
        }
        return [pscustomobject]@{ Process = $process; HelperPath = $helperPath }
    } catch {
        $process.Dispose()
        Remove-Item -LiteralPath $helperPath -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Stop-DatabaseMaintenanceLock($Handle) {
    if (-not $Handle) { return }
    try {
        if (-not $Handle.Process.HasExited) {
            $Handle.Process.StandardInput.WriteLine('release')
            $Handle.Process.StandardInput.Flush()
            $Handle.Process.StandardInput.Close()
            if (-not $Handle.Process.WaitForExit(10000)) { $Handle.Process.Kill() }
        }
    } finally {
        $Handle.Process.Dispose()
        Remove-Item -LiteralPath $Handle.HelperPath -Force -ErrorAction SilentlyContinue
    }
}

$maintenanceMutex = [Threading.Mutex]::new($false, 'Global\GrabenplanerServerMaintenance')
$maintenanceMutexHeld = $false
try {
if (-not $maintenanceMutex.WaitOne(0)) {
    throw 'Eine andere Grabenplaner-Wartung (Backup, Restore oder Update) ist bereits aktiv.'
}
$maintenanceMutexHeld = $true

$service = Get-Service -Name $ServiceName -ErrorAction Stop
if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
    throw "Der Dienst $ServiceName muss vor der Wiederherstellung vollstaendig beendet sein. Aktueller Status: $($service.Status)."
}

$source = Assert-LocalFile -Path $BackupFile
Test-SqliteDatabase -Path $source
$target = [System.IO.Path]::GetFullPath($DatabasePath)
if ($target.StartsWith('\\')) { throw 'Die Zieldatenbank darf nicht auf einem Netzpfad liegen.' }
if ($source -eq $target) { throw 'Backup-Datei und Zieldatenbank duerfen nicht identisch sein.' }
$resolvedAppDirectory = [System.IO.Path]::GetFullPath($AppDirectory)
if ($resolvedAppDirectory.StartsWith('\\') -or $resolvedAppDirectory -eq [System.IO.Path]::GetPathRoot($resolvedAppDirectory)) {
    throw 'Der App-Ordner muss ein lokaler Ordner unterhalb des Laufwerksstamms sein.'
}

$targetDirectory = Split-Path -Parent $target
$timestamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss-fff'
$temporary = Join-Path $targetDirectory ".restore-$timestamp.tmp.db"
$rawPrevious = Join-Path $targetDirectory ".pre-restore-$timestamp.raw.db"
$safetyBackup = Join-Path $targetDirectory "dienstplan-pre-restore-$timestamp.db"
$walPath = "$target-wal"
$shmPath = "$target-shm"
$amuRestored = $false
$amuSafetyBackup = Join-Path $targetDirectory ".amu-pre-restore-$timestamp"
$amuTarget = [System.IO.Path]::GetFullPath($AmuDirectory)
$amuTargetKeyCheck = Join-Path $amuTarget 'key-check.amu'
$hadAmu = Test-Path -LiteralPath $amuTargetKeyCheck -PathType Leaf
if ((Test-Path -LiteralPath $amuTarget -PathType Container) -and -not $hadAmu) {
    $allowedEmptySkeletonDirectories = @('blobs', 'tmp')
    $unexpectedAmuEntry = Get-ChildItem -LiteralPath $amuTarget -Force | Where-Object {
        if (-not $_.PSIsContainer -or
            ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $_.Name -notin $allowedEmptySkeletonDirectories) {
            return $true
        }
        return [bool](Get-ChildItem -LiteralPath $_.FullName -Force | Select-Object -First 1)
    } | Select-Object -First 1
    if ($unexpectedAmuEntry) {
        throw 'Das vorhandene AMU-Ziel ist nicht initialisiert und nicht leer. Eine sichere Wiederherstellung würde vorhandene Dateien überschreiben.'
    }
}
$amuModule = Join-Path ([System.IO.Path]::GetFullPath($AppDirectory)) 'lib\amu-storage.js'
if (-not $AmuBackupDirectory) {
    $AmuBackupDirectory = Join-Path (Split-Path -Parent $source) "$([System.IO.Path]::GetFileNameWithoutExtension($source)).amu"
}
$amuSource = [System.IO.Path]::GetFullPath($AmuBackupDirectory)
$amuPaths = @($amuSource, $amuTarget)
if ($amuPaths.Where({ $_.StartsWith('\\') -or $_ -eq [System.IO.Path]::GetPathRoot($_) }).Count -gt 0) {
    throw 'AUM-Backup und AUM-Ziel muessen lokale Ordner unterhalb des Laufwerksstamms sein.'
}
Assert-SeparateTrees $amuSource $amuTarget 'AUM-Backup und AUM-Ziel'
$amuManifestPath = Join-Path $amuSource 'manifest.json'
if (-not (Test-Path -LiteralPath $amuManifestPath -PathType Leaf)) { throw "Das zum Datenbank-Backup gehörende AMU-Manifest wurde nicht gefunden: $amuSource" }
if (-not (Test-Path -LiteralPath $amuModule -PathType Leaf)) { throw "AMU-Backupmodul nicht gefunden: $amuModule" }
if ($amuTarget -eq [System.IO.Path]::GetPathRoot($amuTarget)) { throw 'Das AMU-Zielverzeichnis darf kein Laufwerksstamm sein.' }
$amuManifest = Get-Content -LiteralPath $amuManifestPath -Raw | ConvertFrom-Json
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($amuManifest.database.fileName -ne [System.IO.Path]::GetFileName($source) -or $amuManifest.database.sha256 -ne $sourceHash) {
    throw 'Datenbank und AMU-Dateien gehören nicht zum selben verifizierten Sicherungspunkt.'
}
if (-not $ServiceXmlPath) {
    $dataRoot = Split-Path -Parent (Split-Path -Parent $target)
    $ServiceXmlPath = Join-Path $dataRoot 'services\Grabenplaner.Service.xml'
}
if ((-not $AmuEncryptionKey -or -not $AmuKeyId) -and (Test-Path -LiteralPath $ServiceXmlPath -PathType Leaf)) {
    [xml]$serviceXml = Get-Content -LiteralPath $ServiceXmlPath -Raw
    $serviceKey = $serviceXml.service.env | Where-Object { $_.name -eq 'GRABENPLANER_AMU_KEY' } | Select-Object -First 1
    $serviceKeyId = $serviceXml.service.env | Where-Object { $_.name -eq 'GRABENPLANER_AMU_KEY_ID' } | Select-Object -First 1
    if (-not $AmuEncryptionKey -and $serviceKey.value) { $AmuEncryptionKey = [string]$serviceKey.value }
    if (-not $AmuKeyId -and $serviceKeyId.value) { $AmuKeyId = [string]$serviceKeyId.value }
}
if (-not $AmuEncryptionKey -or -not $AmuKeyId) {
    throw 'Für die Wiederherstellung ist der gesicherte AMU-Recovery-Schlüssel erforderlich.'
}
$keyValidationScript = @'
const { DatabaseSync } = require('node:sqlite');
const [modulePath, sourceDirectory, keyId, key, databasePath] = process.argv.slice(2);
const { validateEncryptionKeyForStorage, verifyBackupReferences } = require(modulePath);
const database = new DatabaseSync(databasePath, { readOnly: true });
let requiredStorageKeys = [];
try {
  const hasTable = (name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  for (const reference of [
    { table: 'amu_documents', where: "WHERE status = 'active'" },
    { table: 'personnel_record_documents', where: "WHERE status = 'active'" },
    { table: 'loan_documents', where: '' },
    { table: 'loan_photos', where: '' },
  ]) {
    if (!hasTable(reference.table)) continue;
    requiredStorageKeys.push(...database.prepare(
      `SELECT storage_key FROM ${reference.table} ${reference.where}`,
    ).all().map((row) => row.storage_key));
  }
} finally { database.close(); }
verifyBackupReferences({ backupDirectory: sourceDirectory, requiredStorageKeys });
const result = validateEncryptionKeyForStorage({ sourceDirectory, encryptionKeys: { [keyId]: key }, activeKeyId: keyId });
process.stdout.write(JSON.stringify({ ...result, requiredStorageKeys: requiredStorageKeys.length }));
'@
$keyValidationScript | & $NodeExecutable - $amuModule $amuSource $AmuKeyId $AmuEncryptionKey $source | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Der Recovery-Schlüssel kann den gewählten AMU-Sicherungspunkt nicht entschlüsseln.' }

if (-not $PSCmdlet.ShouldProcess($target, "Mit verifiziertem Backup $source wiederherstellen")) { return }

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$hadDatabase = Test-Path -LiteralPath $target -PathType Leaf
$databaseLockHandle = $null
$transactionCommitted = $false
$restoreResult = $null

try {
    $databaseLockHandle = Start-DatabaseMaintenanceLock -Path $target -AppRoot $resolvedAppDirectory -WorkingDirectory $targetDirectory
    if ($hadDatabase) { New-SafetyBackup -Source $target -Target $safetyBackup }
    Copy-Item -LiteralPath $source -Destination $temporary -Force
    Test-SqliteDatabase -Path $temporary
    Remove-Item -LiteralPath $walPath, $shmPath -Force -ErrorAction SilentlyContinue
    if ($hadDatabase) { Move-Item -LiteralPath $target -Destination $rawPrevious -Force }
    Move-Item -LiteralPath $temporary -Destination $target -Force
    Test-SqliteDatabase -Path $target

    if ($AmuBackupDirectory) {
        if ($hadAmu) {
            Invoke-AmuStorage -Action 'backup' -ModulePath $amuModule -Source $amuTarget -Target $amuSafetyBackup | Out-Null
        }
        Invoke-AmuStorage -Action 'restore' -ModulePath $amuModule -Source $amuSource -Target $amuTarget | Out-Null
        $amuRestored = $true
    }

    Stop-DatabaseMaintenanceLock $databaseLockHandle
    $databaseLockHandle = $null

    if ($StartServiceAfterRestore) {
        Start-Service -Name $ServiceName
        $deadline = (Get-Date).AddSeconds(45)
        $healthy = $false
        while ((Get-Date) -lt $deadline) {
            try {
                $health = Invoke-RestMethod -Uri $InternalHealthUrl -TimeoutSec 5
                if ($health.ok) { $healthy = $true; break }
            } catch {}
            Start-Sleep -Seconds 2
        }
        if (-not $healthy) { throw 'Der Dienst wurde nach der Wiederherstellung nicht rechtzeitig betriebsbereit.' }
    }

    $transactionCommitted = $true
    $restoreResult = [pscustomobject]@{
        Ok             = $true
        Database       = $target
        SafetyBackup   = if ($hadDatabase) { $safetyBackup } else { $null }
        ServiceStarted = [bool]$StartServiceAfterRestore
        AmuRestored    = $amuRestored
    }
} catch {
    $restoreError = $_
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    if (-not $databaseLockHandle) {
        $databaseLockHandle = Start-DatabaseMaintenanceLock -Path $target -AppRoot $resolvedAppDirectory -WorkingDirectory $targetDirectory
    }
    Remove-Item -LiteralPath $target, $temporary, $walPath, $shmPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $safetyBackup -PathType Leaf) {
        Copy-Item -LiteralPath $safetyBackup -Destination $target -Force
    } elseif (Test-Path -LiteralPath $rawPrevious -PathType Leaf) {
        Move-Item -LiteralPath $rawPrevious -Destination $target -Force
    }
    $amuRollbackReady = -not $amuRestored
    $amuRollbackError = $null
    if ($amuRestored -and $AmuBackupDirectory) {
        if ($hadAmu -and (Test-Path -LiteralPath (Join-Path $amuSafetyBackup 'manifest.json') -PathType Leaf)) {
            try {
                Invoke-AmuStorage -Action 'restore' -ModulePath $amuModule -Source $amuSafetyBackup -Target $amuTarget | Out-Null
                $amuRollbackReady = $true
            } catch { $amuRollbackError = $_.Exception.Message }
        } elseif (-not $hadAmu) {
            try {
                if (Test-Path -LiteralPath $amuTarget -PathType Container) {
                    Remove-Item -LiteralPath $amuTarget -Recurse -Force
                }
                $amuRollbackReady = -not (Test-Path -LiteralPath $amuTarget)
            } catch { $amuRollbackError = $_.Exception.Message }
        }
    }
    Remove-Item -LiteralPath $rawPrevious -Force -ErrorAction SilentlyContinue
    Stop-DatabaseMaintenanceLock $databaseLockHandle
    $databaseLockHandle = $null
    $databaseRollbackReady = if ($hadDatabase) {
        Test-Path -LiteralPath $target -PathType Leaf
    } else {
        -not (Test-Path -LiteralPath $target)
    }
    if ($StartServiceAfterRestore -and $hadDatabase -and $databaseRollbackReady -and $amuRollbackReady) {
        Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
    }
    $rollbackHint = if (-not $databaseRollbackReady -or -not $amuRollbackReady) {
        " Der Sicherheitsrollback ist unvollstaendig (AUM: $amuRollbackError); sofortiger manueller IT-Eingriff ist erforderlich."
    } else { '' }
    $rollbackState = if ($hadDatabase) {
        'die vorherige gekoppelte Sicherung wurde zurueckgesetzt'
    } else {
        'das frische Ziel wurde in den leeren Ausgangszustand zurueckgesetzt'
    }
    throw "Wiederherstellung fehlgeschlagen; $rollbackState. $($restoreError.Exception.Message)$rollbackHint"
} finally {
    Stop-DatabaseMaintenanceLock $databaseLockHandle
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
if ($transactionCommitted) {
    Remove-Item -LiteralPath $rawPrevious -Force -ErrorAction SilentlyContinue
    if ($hadAmu -and $amuRestored -and (Test-Path -LiteralPath $amuSafetyBackup -PathType Container)) {
        $resolvedSafety = [System.IO.Path]::GetFullPath($amuSafetyBackup)
        if ($resolvedSafety.StartsWith($targetDirectory + [IO.Path]::DirectorySeparatorChar)) {
            try { Remove-Item -LiteralPath $resolvedSafety -Recurse -Force -ErrorAction Stop } catch {}
        }
    }
    $restoreResult
}
} finally {
    if ($maintenanceMutexHeld) { $maintenanceMutex.ReleaseMutex() }
    $maintenanceMutex.Dispose()
}
