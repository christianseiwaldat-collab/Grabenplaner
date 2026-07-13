[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$PublicUrl,

    [string]$InternalHealthUrl = 'http://127.0.0.1:3000/api/health',
    [string]$DatabasePath = 'C:\ProgramData\Grabenplaner\data\dienstplan.db',
    [string]$BackupDirectory = 'D:\Grabenplaner-Backups',
    [string]$NodeExecutable = 'node',
    [string]$AppServiceName = 'GrabenplanerServer',
    [string]$ProxyServiceName = 'GrabenplanerCaddy',
    [string]$CaddyExecutable,
    [string]$Caddyfile,
    [ValidateRange(1, 168)]
    [int]$MaximumBackupAgeHours = 6
)

$ErrorActionPreference = 'Stop'
$results = [System.Collections.Generic.List[object]]::new()

function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $results.Add([pscustomobject]@{ Check = $Name; Ok = $Ok; Detail = $Detail })
}

foreach ($serviceName in @($AppServiceName, $ProxyServiceName)) {
    try {
        $service = Get-Service -Name $serviceName -ErrorAction Stop
        Add-Check "Dienst $serviceName" ($service.Status -eq 'Running') "Status: $($service.Status)"
    } catch {
        Add-Check "Dienst $serviceName" $false 'Dienst nicht gefunden.'
    }
}

try {
    $health = Invoke-RestMethod -Uri $InternalHealthUrl -TimeoutSec 8
    Add-Check 'Interner Healthcheck' ([bool]$health.ok) "Modus: $($health.mode), Version: $($health.version)"
} catch {
    Add-Check 'Interner Healthcheck' $false $_.Exception.Message
}

$publicHealthUrl = "{0}/api/health" -f $PublicUrl.TrimEnd('/')
try {
    $response = Invoke-WebRequest -Uri $publicHealthUrl -TimeoutSec 15 -UseBasicParsing
    $hsts = [string]$response.Headers['Strict-Transport-Security']
    Add-Check 'Oeffentlicher HTTPS-Healthcheck' ($response.StatusCode -eq 200) "HTTP $($response.StatusCode)"
    Add-Check 'HSTS' ($hsts -match 'max-age=') $(if ($hsts) { $hsts } else { 'Header fehlt.' })
} catch {
    Add-Check 'Oeffentlicher HTTPS-Healthcheck' $false $_.Exception.Message
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
