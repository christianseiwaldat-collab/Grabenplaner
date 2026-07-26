[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DatabasePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$BackupDirectory,

    [ValidateRange(1, 1000)]
    [int]$Keep = 30,

    [string]$ServiceName = 'GrabenplanerServer',
    [string]$NodeExecutable = 'node',
    [string]$AppDirectory = 'C:\Program Files\Grabenplaner\app',
    [string]$AmuDirectory = 'C:\ProgramData\Grabenplaner\private\amu'
)

$ErrorActionPreference = 'Stop'

function Resolve-LocalPath([string]$Path, [switch]$MustExist, [switch]$Directory) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Ein erforderlicher Pfad fehlt.' }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\')) { throw "Netzpfade werden fuer diesen Vorgang nicht unterstuetzt: $fullPath" }
    if ($fullPath -eq [System.IO.Path]::GetPathRoot($fullPath)) { throw "Ein Laufwerksstamm ist nicht zulaessig: $fullPath" }
    if ($MustExist) {
        $pathType = if ($Directory) { 'Container' } else { 'Leaf' }
        if (-not (Test-Path -LiteralPath $fullPath -PathType $pathType)) { throw "Pfad nicht gefunden: $fullPath" }
    }
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

$database = Resolve-LocalPath -Path $DatabasePath -MustExist
$backupRoot = Resolve-LocalPath -Path $BackupDirectory -Directory
$appRoot = Resolve-LocalPath -Path $AppDirectory -MustExist -Directory
$amuRoot = Resolve-LocalPath -Path $AmuDirectory -Directory
$databaseDirectory = Split-Path -Parent $database
Assert-SeparateTrees $backupRoot $databaseDirectory 'Backup- und Datenbankordner'
Assert-SeparateTrees $backupRoot $appRoot 'Backup- und App-Ordner'
Assert-SeparateTrees $backupRoot $amuRoot 'Backup- und AUM-Ordner'
Assert-SeparateTrees $appRoot $databaseDirectory 'App- und Datenbankordner'
Assert-SeparateTrees $appRoot $amuRoot 'App- und AUM-Ordner'

$maintenanceMutex = [Threading.Mutex]::new($false, 'Global\GrabenplanerServerMaintenance')
$maintenanceMutexHeld = $false
try {
    if (-not $maintenanceMutex.WaitOne(0)) {
        throw 'Eine andere Grabenplaner-Wartung (Backup, Restore oder Update) ist bereits aktiv.'
    }
    $maintenanceMutexHeld = $true

    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
        throw "Der Dienst $ServiceName muss fuer dieses externe Backup beendet sein. Im laufenden Betrieb verwendet Grabenplaner seine integrierte Sicherung."
    }

    $databaseLockModule = Join-Path $appRoot 'lib\database-lock.js'
    $amuModule = Join-Path $appRoot 'lib\amu-storage.js'
    foreach ($module in @($databaseLockModule, $amuModule)) {
        if (-not (Test-Path -LiteralPath $module -PathType Leaf)) { throw "Backupmodul nicht gefunden: $module" }
    }

    $timestamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss-fff'
    $snapshotName = "dienstplan-$timestamp"
    $target = Join-Path $backupRoot "$snapshotName.db"
    $temporaryDatabase = Join-Path $backupRoot ".$snapshotName-$([Guid]::NewGuid().ToString('N')).partial.db"
    $amuBackupTarget = Join-Path $backupRoot "$snapshotName.amu"
    $temporaryAmuBackupTarget = Join-Path $backupRoot ".$snapshotName-$([Guid]::NewGuid().ToString('N')).partial.amu"

    $nodeScript = @'
const crypto = require('node:crypto');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [source, target, lockModulePath, amuModulePath, amuSource, amuTarget, databaseFileName] = process.argv.slice(2);
const { acquireDatabaseLock, releaseDatabaseLock } = require(lockModulePath);
const { syncEncryptedFilesBackup, verifyBackupReferences } = require(amuModulePath);
const lock = acquireDatabaseLock({ databasePath: source, kind: 'backup', appVersion: 'server-maintenance' });
try {
  const sourceDb = new DatabaseSync(source);
  try {
    const escaped = target.replaceAll('\\', '/').replaceAll("'", "''");
    sourceDb.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    sourceDb.close();
  }
  const check = new DatabaseSync(target, { readOnly: true });
  const requiredStorageKeys = [];
  try {
    const result = check.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
    if (result.length !== 1 || result[0] !== 'ok') throw new Error(`quick_check: ${result.join('; ')}`);
    const hasTable = (name) => Boolean(check.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name));
    for (const reference of [
      { table: 'amu_documents', where: "WHERE status = 'active'" },
      { table: 'personnel_record_documents', where: "WHERE status = 'active'" },
      { table: 'loan_documents', where: '' },
      { table: 'loan_photos', where: '' },
    ]) {
      if (!hasTable(reference.table)) continue;
      requiredStorageKeys.push(...check.prepare(
        `SELECT storage_key FROM ${reference.table} ${reference.where}`,
      ).all().map((row) => row.storage_key));
    }
  } finally {
    check.close();
  }
  const databaseSha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const amu = syncEncryptedFilesBackup({
    sourceDirectory: amuSource,
    targetDirectory: amuTarget,
    manifestMetadata: { database: { fileName: databaseFileName, sha256: databaseSha256 } },
  });
  verifyBackupReferences({ backupDirectory: amuTarget, requiredStorageKeys });
  process.stdout.write(JSON.stringify({
    ok: true,
    target,
    databaseSha256,
    fileCount: amu.fileCount,
    requiredStorageKeys: requiredStorageKeys.length,
  }));
} finally {
  releaseDatabaseLock(lock);
}
'@

    if (-not $PSCmdlet.ShouldProcess($target, 'Verifiziertes SQLite- und AUM-Backup erstellen')) { return }
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    try {
        $result = $nodeScript | & $NodeExecutable - $database $temporaryDatabase $databaseLockModule $amuModule $amuRoot $temporaryAmuBackupTarget ([System.IO.Path]::GetFileName($target))
        if ($LASTEXITCODE -ne 0) { throw "Backup-Prozess wurde mit Exitcode $LASTEXITCODE beendet." }
        $verification = $result | Select-Object -Last 1 | ConvertFrom-Json
        if (-not $verification.ok -or -not (Test-Path -LiteralPath $temporaryDatabase -PathType Leaf)) {
            throw 'Das erstellte Backup konnte nicht verifiziert werden.'
        }
        if (Test-Path -LiteralPath $temporaryAmuBackupTarget -PathType Container) {
            Move-Item -LiteralPath $temporaryAmuBackupTarget -Destination $amuBackupTarget
        }
        Move-Item -LiteralPath $temporaryDatabase -Destination $target
    } catch {
        Remove-Item -LiteralPath $temporaryDatabase, $target -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $temporaryAmuBackupTarget, $amuBackupTarget -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }

    $oldBackups = Get-ChildItem -LiteralPath $backupRoot -Filter 'dienstplan-*.db' -File |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -Skip $Keep
    foreach ($oldBackup in $oldBackups) {
        if ($PSCmdlet.ShouldProcess($oldBackup.FullName, 'Altes Backup gemaess Aufbewahrung loeschen')) {
            Remove-Item -LiteralPath $oldBackup.FullName -Force
            $oldAmuDirectory = Join-Path $backupRoot "$($oldBackup.BaseName).amu"
            $resolvedOldAmu = [System.IO.Path]::GetFullPath($oldAmuDirectory)
            if ($resolvedOldAmu.StartsWith($backupRoot + [IO.Path]::DirectorySeparatorChar) -and (Test-Path -LiteralPath $resolvedOldAmu -PathType Container)) {
                Remove-Item -LiteralPath $resolvedOldAmu -Recurse -Force
            }
        }
    }

    [pscustomobject]@{
        Ok        = $true
        Path      = $target
        Sha256    = [string]$verification.databaseSha256
        Verified  = $true
        AmuFiles  = [int]$verification.fileCount
        AmuBackup = if (Test-Path -LiteralPath $amuBackupTarget -PathType Container) { $amuBackupTarget } else { $null }
        Created   = (Get-Date).ToString('o')
    }
} finally {
    if ($maintenanceMutexHeld) { $maintenanceMutex.ReleaseMutex() }
    $maintenanceMutex.Dispose()
}
