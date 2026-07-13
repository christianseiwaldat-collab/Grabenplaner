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

function Resolve-LocalPath([string]$Path, [switch]$MustExist) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Ein erforderlicher Pfad fehlt.' }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ([Uri]::IsWellFormedUriString($fullPath, [UriKind]::Absolute) -or $fullPath.StartsWith('\\')) {
        throw "Die SQLite-Datenbank darf nicht auf einem Netzpfad liegen: $fullPath"
    }
    if ($MustExist -and -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Datei nicht gefunden: $fullPath"
    }
    return $fullPath
}

$database = Resolve-LocalPath -Path $DatabasePath -MustExist
$backupRoot = [System.IO.Path]::GetFullPath($BackupDirectory)
if ($backupRoot -eq (Split-Path -Parent $database)) {
    throw 'Backup-Ordner und Datenbankordner muessen getrennt sein.'
}
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
    throw "Der Dienst $ServiceName muss fuer dieses externe Backup beendet sein. Im laufenden Betrieb verwendet Grabenplaner seine integrierte, upload-sichere Sicherung."
}

$timestamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss-fff'
$snapshotName = "dienstplan-$timestamp"
$target = Join-Path $backupRoot "$snapshotName.db"
$temporaryDatabase = Join-Path $backupRoot ".$snapshotName-$([Guid]::NewGuid().ToString('N')).partial.db"
$amuBackupTarget = Join-Path $backupRoot "$snapshotName.amu"
$temporaryAmuBackupTarget = Join-Path $backupRoot ".$snapshotName-$([Guid]::NewGuid().ToString('N')).partial.amu"
$nodeScript = @'
const { DatabaseSync } = require('node:sqlite');
const [source, target] = process.argv.slice(2);
const db = new DatabaseSync(source);
try {
  const escaped = target.replaceAll('\\', '/').replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally {
  db.close();
}
const check = new DatabaseSync(target, { readOnly: true });
try {
  const result = check.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
  if (result.length !== 1 || result[0] !== 'ok') throw new Error(`quick_check: ${result.join('; ')}`);
  process.stdout.write(JSON.stringify({ ok: true, target }));
} finally {
  check.close();
}
'@

if (-not $PSCmdlet.ShouldProcess($target, 'Verifiziertes SQLite-Backup erstellen')) { return }

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
try {
    $result = $nodeScript | & $NodeExecutable - $database $temporaryDatabase
    if ($LASTEXITCODE -ne 0) { throw "Backup-Prozess wurde mit Exitcode $LASTEXITCODE beendet." }
    $verification = $result | Select-Object -Last 1 | ConvertFrom-Json
    if (-not $verification.ok -or -not (Test-Path -LiteralPath $temporaryDatabase -PathType Leaf)) {
        throw 'Das erstellte Backup konnte nicht verifiziert werden.'
    }
    $databaseHash = (Get-FileHash -LiteralPath $temporaryDatabase -Algorithm SHA256).Hash.ToLowerInvariant()
    $amuFileCount = 0
    $amuModule = Join-Path ([System.IO.Path]::GetFullPath($AppDirectory)) 'lib\amu-storage.js'
    if (-not (Test-Path -LiteralPath $amuModule -PathType Leaf)) { throw "AMU-Backupmodul nicht gefunden: $amuModule" }
    $amuScript = @'
const [modulePath, sourceDirectory, targetDirectory, databaseFileName, databaseSha256] = process.argv.slice(2);
const { syncEncryptedFilesBackup } = require(modulePath);
const result = syncEncryptedFilesBackup({
  sourceDirectory,
  targetDirectory,
  manifestMetadata: { database: { fileName: databaseFileName, sha256: databaseSha256 } },
});
process.stdout.write(JSON.stringify({ ok: true, fileCount: result.fileCount }));
'@
    $amuResult = $amuScript | & $NodeExecutable - $amuModule ([System.IO.Path]::GetFullPath($AmuDirectory)) $temporaryAmuBackupTarget ([System.IO.Path]::GetFileName($target)) $databaseHash
    if ($LASTEXITCODE -ne 0) { throw 'Die verschlüsselten AMU-Dateien konnten nicht gesichert werden.' }
    $amuVerification = $amuResult | Select-Object -Last 1 | ConvertFrom-Json
    if (-not $amuVerification.ok) { throw 'Das AMU-Backup konnte nicht verifiziert werden.' }
    $amuFileCount = [int]$amuVerification.fileCount
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
        if (Test-Path -LiteralPath $oldAmuDirectory -PathType Container) {
            Remove-Item -LiteralPath $oldAmuDirectory -Recurse -Force
        }
    }
}

[pscustomobject]@{
    Ok       = $true
    Path     = $target
    Verified = $true
    AmuFiles = $amuFileCount
    AmuBackup = if (Test-Path -LiteralPath $amuBackupTarget -PathType Container) { $amuBackupTarget } else { $null }
    Created  = (Get-Date).ToString('o')
}
