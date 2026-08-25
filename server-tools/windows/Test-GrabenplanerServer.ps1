[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$PublicUrl,

    [string]$InternalLiveUrl = 'http://127.0.0.1:3000/api/health/live',
    [string]$InternalReadyUrl = 'http://127.0.0.1:3000/api/health/ready',
    [string]$DatabasePath = 'C:\ProgramData\Grabenplaner\data\dienstplan.db',
    [string]$BackupDirectory = 'D:\Grabenplaner-Backups',
    [string]$AppDirectory = 'C:\Program Files\Grabenplaner\app',
    [string]$NodeExecutable = 'node',
    [string]$AppServiceName = 'GrabenplanerServer',
    [string]$ProxyServiceName = 'GrabenplanerCaddy',
    [string]$CaddyExecutable,
    [string]$Caddyfile,
    [ValidateRange(1, 168)]
    [int]$MaximumBackupAgeHours = 6,
    [ValidateRange(1, 365)]
    [int]$MinimumCertificateRemainingDays = 14
)

$ErrorActionPreference = 'Stop'
$results = [System.Collections.Generic.List[object]]::new()

function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $results.Add([pscustomobject]@{ Check = $Name; Ok = $Ok; Detail = $Detail })
}

function Test-ExactCspDirectives([string]$Policy) {
    if ([string]::IsNullOrWhiteSpace($Policy)) { return $false }
    $directives = @($Policy -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    foreach ($required in @("object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'")) {
        if ($directives -notcontains $required) { return $false }
    }
    return $true
}

foreach ($serviceName in @($AppServiceName, $ProxyServiceName)) {
    try {
        $service = Get-Service -Name $serviceName -ErrorAction Stop
        Add-Check "Dienst $serviceName" ($service.Status -eq 'Running') "Status: $($service.Status)"
    } catch {
        Add-Check "Dienst $serviceName" $false 'Dienst nicht gefunden.'
    }
}

foreach ($healthTarget in @(
    @{ Name = 'Interne Liveness'; Url = $InternalLiveUrl },
    @{ Name = 'Interne Readiness'; Url = $InternalReadyUrl }
)) {
    try {
        $health = Invoke-RestMethod -Uri $healthTarget.Url -TimeoutSec 8
        Add-Check $healthTarget.Name ([bool]$health.ok) "Modus: $($health.mode), Version: $($health.version)"
    } catch {
        Add-Check $healthTarget.Name $false $_.Exception.Message
    }
}

$publicHealthUrl = "{0}/api/health/ready" -f $PublicUrl.TrimEnd('/')
try {
    $response = Invoke-WebRequest -Uri $publicHealthUrl -TimeoutSec 15 -UseBasicParsing
    $hsts = [string]$response.Headers['Strict-Transport-Security']
    $contentSecurityPolicy = [string]$response.Headers['Content-Security-Policy']
    $contentSecurityPolicyComplete = Test-ExactCspDirectives $contentSecurityPolicy
    Add-Check 'Oeffentlicher HTTPS-Healthcheck' ($response.StatusCode -eq 200) "HTTP $($response.StatusCode)"
    Add-Check 'HSTS' ($hsts -eq 'max-age=31536000; includeSubDomains') $(if ($hsts) { $hsts } else { 'Header fehlt.' })
    Add-Check 'Content-Security-Policy' $contentSecurityPolicyComplete $(if ($contentSecurityPolicy) { $contentSecurityPolicy } else { 'Header fehlt.' })
    Add-Check 'X-Content-Type-Options' ([string]$response.Headers['X-Content-Type-Options'] -eq 'nosniff') $(if ($response.Headers['X-Content-Type-Options']) { [string]$response.Headers['X-Content-Type-Options'] } else { 'Header fehlt.' })
    Add-Check 'X-Frame-Options' ([string]$response.Headers['X-Frame-Options'] -eq 'DENY') $(if ($response.Headers['X-Frame-Options']) { [string]$response.Headers['X-Frame-Options'] } else { 'Header fehlt.' })
    Add-Check 'Referrer-Policy' ([string]$response.Headers['Referrer-Policy'] -eq 'no-referrer') $(if ($response.Headers['Referrer-Policy']) { [string]$response.Headers['Referrer-Policy'] } else { 'Header fehlt.' })
    Add-Check 'Permissions-Policy' ([string]$response.Headers['Permissions-Policy'] -eq 'camera=(), microphone=(), geolocation=()') $(if ($response.Headers['Permissions-Policy']) { [string]$response.Headers['Permissions-Policy'] } else { 'Header fehlt.' })
    Add-Check 'Cross-Origin-Opener-Policy' ([string]$response.Headers['Cross-Origin-Opener-Policy'] -eq 'same-origin') $(if ($response.Headers['Cross-Origin-Opener-Policy']) { [string]$response.Headers['Cross-Origin-Opener-Policy'] } else { 'Header fehlt.' })
    Add-Check 'Cross-Origin-Resource-Policy' ([string]$response.Headers['Cross-Origin-Resource-Policy'] -eq 'same-origin') $(if ($response.Headers['Cross-Origin-Resource-Policy']) { [string]$response.Headers['Cross-Origin-Resource-Policy'] } else { 'Header fehlt.' })
    Add-Check 'X-Permitted-Cross-Domain-Policies' ([string]$response.Headers['X-Permitted-Cross-Domain-Policies'] -eq 'none') $(if ($response.Headers['X-Permitted-Cross-Domain-Policies']) { [string]$response.Headers['X-Permitted-Cross-Domain-Policies'] } else { 'Header fehlt.' })
} catch {
    Add-Check 'Oeffentlicher HTTPS-Healthcheck' $false $_.Exception.Message
    Add-Check 'HSTS' $false 'Antwort konnte nicht gelesen werden'
    Add-Check 'Content-Security-Policy' $false 'Antwort konnte nicht gelesen werden'
    Add-Check 'X-Content-Type-Options' $false 'Antwort konnte nicht gelesen werden'
    Add-Check 'X-Frame-Options' $false 'Antwort konnte nicht gelesen werden'
    Add-Check 'Referrer-Policy' $false 'Antwort konnte nicht gelesen werden'
    Add-Check 'Permissions-Policy' $false 'Antwort konnte nicht gelesen werden'
    Add-Check 'Cross-Origin-Opener-Policy' $false 'Antwort konnte nicht gelesen werden'
    Add-Check 'Cross-Origin-Resource-Policy' $false 'Antwort konnte nicht gelesen werden'
    Add-Check 'X-Permitted-Cross-Domain-Policies' $false 'Antwort konnte nicht gelesen werden'
}

try {
    $publicUri = [Uri]$PublicUrl
    $tcp = [Net.Sockets.TcpClient]::new()
    try {
        $tcp.Connect($publicUri.Host, $(if ($publicUri.IsDefaultPort) { 443 } else { $publicUri.Port }))
        $tls = [Net.Security.SslStream]::new($tcp.GetStream(), $false)
        try {
            $tls.AuthenticateAsClient($publicUri.Host)
            $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($tls.RemoteCertificate)
            $remaining = $certificate.NotAfter.ToUniversalTime() - [DateTime]::UtcNow
            Add-Check 'TLS-Zertifikat' ($remaining.TotalDays -ge $MinimumCertificateRemainingDays) ("gueltig bis {0:u}, noch {1:N1} Tage" -f $certificate.NotAfter.ToUniversalTime(), $remaining.TotalDays)
        } finally { $tls.Dispose() }
    } finally { $tcp.Dispose() }
} catch {
    Add-Check 'TLS-Zertifikat' $false $_.Exception.Message
}

try {
    $database = [System.IO.Path]::GetFullPath($DatabasePath)
    if ($database.StartsWith('\\')) { throw 'Datenbank liegt auf einem Netzpfad.' }
    $script = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const result = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
  process.stdout.write(JSON.stringify(result));
} finally { db.close(); }
'@
    $output = $script | & $NodeExecutable - $database
    if ($LASTEXITCODE -ne 0) { throw "Node-Exitcode $LASTEXITCODE" }
    $check = ($output | Select-Object -Last 1) | ConvertFrom-Json
    Add-Check 'SQLite quick_check' ($check.Count -eq 1 -and $check[0] -eq 'ok') ($check -join '; ')
} catch {
    Add-Check 'SQLite quick_check' $false $_.Exception.Message
}

try {
    $latestBackup = Get-ChildItem -LiteralPath $BackupDirectory -Filter 'dienstplan-*.db' -File |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $latestBackup) { throw 'Kein Backup gefunden.' }
    $age = [DateTime]::UtcNow - $latestBackup.LastWriteTimeUtc
    Add-Check 'Backup-Aktualitaet' ($age.TotalHours -le $MaximumBackupAgeHours) ("{0}, {1:N1} Stunden alt" -f $latestBackup.Name, $age.TotalHours)

    $backupCheckScript = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const result = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
  process.stdout.write(JSON.stringify(result));
} finally { db.close(); }
'@
    $backupCheckOutput = $backupCheckScript | & $NodeExecutable - $latestBackup.FullName
    if ($LASTEXITCODE -ne 0) { throw "Backup quick_check: Node-Exitcode $LASTEXITCODE" }
    $backupCheck = ($backupCheckOutput | Select-Object -Last 1) | ConvertFrom-Json
    Add-Check 'Backup SQLite quick_check' ($backupCheck.Count -eq 1 -and $backupCheck[0] -eq 'ok') ($backupCheck -join '; ')

    $amuBackupDirectory = Join-Path $latestBackup.DirectoryName "$($latestBackup.BaseName).amu"
    $amuManifestPath = Join-Path $amuBackupDirectory 'manifest.json'
    if (-not (Test-Path -LiteralPath $amuManifestPath -PathType Leaf)) { throw "Gekoppeltes AUM-Manifest fehlt: $amuManifestPath" }
    $amuManifest = Get-Content -LiteralPath $amuManifestPath -Raw | ConvertFrom-Json
    $backupHash = (Get-FileHash -LiteralPath $latestBackup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $pairOk = [string]$amuManifest.database.fileName -eq $latestBackup.Name -and [string]$amuManifest.database.sha256 -eq $backupHash
    Add-Check 'Backup DB+AUM-Kopplung' $pairOk $(if ($pairOk) { "Manifest und SHA256 stimmen fuer $($latestBackup.Name)." } else { 'Dateiname oder SHA256 im AUM-Manifest stimmt nicht.' })

    $amuModule = Join-Path ([System.IO.Path]::GetFullPath($AppDirectory)) 'lib\amu-storage.js'
    if (-not (Test-Path -LiteralPath $amuModule -PathType Leaf)) { throw "AUM-Pruefmodul fehlt: $amuModule" }
    $amuCheckScript = @'
const { DatabaseSync } = require('node:sqlite');
const [modulePath, backupDirectory, databasePath] = process.argv.slice(2);
const { readAndVerifyBackup, verifyBackupReferences } = require(modulePath);
const database = new DatabaseSync(databasePath, { readOnly: true });
const requiredStorageKeys = [];
try {
  const hasTable = (name) => Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
  const hasColumn = (table, column) => hasTable(table)
    && Boolean(database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column));
  for (const reference of [
    { table: 'amu_documents', where: "WHERE status = 'active'" },
    { table: 'personnel_record_documents', where: "WHERE status = 'active'" },
    { table: 'candidate_document_versions', where: '' },
    { table: 'loan_documents', where: '' },
    { table: 'loan_photo_attachments', where: '' },
    {
      table: 'loan_photos',
      where: hasColumn('loan_photos', 'original_retained')
        ? 'WHERE original_retained = 1'
        : '',
    },
  ]) {
    if (!hasTable(reference.table)) continue;
    requiredStorageKeys.push(...database.prepare(
      `SELECT storage_key FROM ${reference.table} ${reference.where}`,
    ).all().map((row) => row.storage_key));
  }
} finally {
  database.close();
}
const result = readAndVerifyBackup(backupDirectory);
verifyBackupReferences({ backupDirectory, requiredStorageKeys });
process.stdout.write(JSON.stringify({
  ok: true,
  fileCount: result.verified.length,
  requiredStorageKeys: requiredStorageKeys.length,
}));
'@
    $amuCheckOutput = $amuCheckScript | & $NodeExecutable - $amuModule $amuBackupDirectory $latestBackup.FullName
    if ($LASTEXITCODE -ne 0) { throw 'AUM-Manifest- oder Blob-Integritaetspruefung fehlgeschlagen.' }
    $amuCheck = $amuCheckOutput | Select-Object -Last 1 | ConvertFrom-Json
    Add-Check 'Backup AUM-Blob-Integritaet' ([bool]$amuCheck.ok) ("{0} verschluesselte Dateien verifiziert" -f [int]$amuCheck.fileCount)
} catch {
    Add-Check 'Backup-Aktualitaet' $false $_.Exception.Message
}

if ($CaddyExecutable -and $Caddyfile) {
    try {
        & $CaddyExecutable validate --config $Caddyfile --adapter caddyfile | Out-Null
        Add-Check 'Caddy-Konfiguration' ($LASTEXITCODE -eq 0) "Exitcode $LASTEXITCODE"
    } catch {
        Add-Check 'Caddy-Konfiguration' $false $_.Exception.Message
    }
}

$results | Format-Table -AutoSize
if ($results.Where({ -not $_.Ok }).Count -gt 0) { exit 1 }
exit 0
