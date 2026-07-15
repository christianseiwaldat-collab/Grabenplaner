[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$PublicUrl,

    [string]$AppDirectory = 'C:\Program Files\Grabenplaner\app',
    [string]$DataDirectory = 'C:\ProgramData\Grabenplaner',

    [Parameter(Mandatory = $true)]
    [string]$BackupDirectory,

    [ValidateRange(1, 65535)]
    [int]$Port = 3000,

    [ValidateRange(1, 1000)]
    [int]$BackupKeep = 30,

    [ValidateNotNullOrEmpty()]
    [string]$AmuKeyId = 'server-v1',
    [string]$AmuEncryptionKey,
    [string]$ServiceControlToken,

    [string]$NodeExecutable,
    [string]$WinSwExecutable,
    [string]$WinSwSha256,
    [string]$CaddyExecutable,
    [string]$CaddySha256,
    [switch]$RegisterServices,
    [switch]$StartServices
)

$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Die Einrichtung muss in einer als Administrator gestarteten PowerShell ausgefuehrt werden.'
    }
}

function Resolve-FullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Ein erforderlicher Pfad fehlt.' }
    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-LocalDirectory([string]$Path, [string]$Label) {
    if ($Path.StartsWith('\\')) { throw "$Label darf kein Netzpfad sein: $Path" }
    if ($Path -eq [System.IO.Path]::GetPathRoot($Path)) { throw "$Label darf kein Laufwerksstamm sein: $Path" }
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

function Assert-PinnedExecutable([string]$Path, [string]$ExpectedHash, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label wurde nicht gefunden: $Path" }
    if ($ExpectedHash -notmatch '^[A-Fa-f0-9]{64}$') { throw "Fuer $Label ist ein fester SHA256-Wert erforderlich." }
    $actualHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actualHash -ne $ExpectedHash.ToUpperInvariant()) {
        throw "$Label stimmt nicht mit dem freigegebenen SHA256-Wert ueberein. Erwartet: $ExpectedHash, gefunden: $actualHash"
    }
}

function ConvertTo-XmlText([string]$Value) {
    return [Security.SecurityElement]::Escape($Value)
}

function Set-RestrictedAcl([string]$Path, [string[]]$AdditionalGrants = @()) {
    $baseGrants = if (Test-Path -LiteralPath $Path -PathType Leaf) {
        @('*S-1-5-18:(F)', '*S-1-5-32-544:(F)')
    } else {
        @('*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)')
    }
    $grants = $baseGrants + $AdditionalGrants
    & icacls.exe $Path /inheritance:r /grant:r $grants | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Berechtigungen konnten nicht gesetzt werden: $Path" }
}

function Assert-SupportedScannerReady([string]$NodePath, [string]$AppRoot) {
    $amuModule = Join-Path $AppRoot 'lib\amu-storage.js'
    if (-not (Test-Path -LiteralPath $amuModule -PathType Leaf)) { throw "AUM-Pruefmodul nicht gefunden: $amuModule" }
    $probe = Join-Path ([System.IO.Path]::GetTempPath()) "grabenplaner-scanner-$([Guid]::NewGuid().ToString('N')).txt"
    try {
        [System.IO.File]::WriteAllText($probe, 'Grabenplaner scanner readiness probe', [Text.UTF8Encoding]::new($false))
        $script = @'
const [modulePath, probePath] = process.argv.slice(2);
const { scanWithAvailableEngine } = require(modulePath);
scanWithAvailableEngine(probePath, { requireScanner: true })
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => { console.error(error.message); process.exit(1); });
'@
        $result = $script | & $NodePath - $amuModule $probe
        if ($LASTEXITCODE -ne 0) { throw 'Kein unterstuetzter Virenscanner (Microsoft Defender oder ClamAV) ist einsatzbereit.' }
        $scan = $result | Select-Object -Last 1 | ConvertFrom-Json
        if (-not $scan.available -or -not $scan.clean) { throw 'Der Scanner-Preflight hat kein sauberes Ergebnis geliefert.' }
    } finally {
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    }
    return [string]$scan.engine
}

Assert-Administrator
$publicUri = [Uri]$PublicUrl
if ($publicUri.Scheme -ne 'https' -or -not $publicUri.Host -or $publicUri.AbsolutePath -ne '/' -or $publicUri.Query -or $publicUri.Fragment -or $publicUri.UserInfo) {
    throw 'PublicUrl muss eine vollstaendige HTTPS-Adresse ohne Pfad, Zugangsdaten, Abfrage oder Fragment sein.'
}

$appRoot = Resolve-FullPath $AppDirectory
$dataRoot = Resolve-FullPath $DataDirectory
$backupRoot = Resolve-FullPath $BackupDirectory
Assert-LocalDirectory $dataRoot 'Datenordner'
Assert-LocalDirectory $backupRoot 'Backup-Ordner'
Assert-LocalDirectory $appRoot 'App-Ordner'
Assert-SeparateTrees $appRoot $dataRoot 'App- und Datenordner'
Assert-SeparateTrees $backupRoot $dataRoot 'Backup- und Datenordner'
Assert-SeparateTrees $backupRoot $appRoot 'Backup- und App-Ordner'

$serverScript = Join-Path $appRoot 'server.js'
if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) { throw "server.js wurde nicht gefunden: $serverScript" }
if (-not $NodeExecutable) {
    $bundledNode = Join-Path $appRoot 'runtime\node.exe'
    $NodeExecutable = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
}
$nodePath = Resolve-FullPath $NodeExecutable
if ($nodePath.StartsWith('\\') -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "NodeExecutable muss eine vorhandene lokale Datei sein: $nodePath"
}
if ((Test-SameOrChildPath $nodePath $dataRoot) -or (Test-SameOrChildPath $nodePath $backupRoot)) {
    throw 'Die Node-Runtime darf nicht im Daten- oder Backupordner liegen.'
}

$configDirectory = Join-Path $dataRoot 'config'
$databaseDirectory = Join-Path $dataRoot 'data'
$databasePath = Join-Path $databaseDirectory 'dienstplan.db'
$internalBackupDirectory = Join-Path $dataRoot 'backups'
$brandingKitsDirectory = Join-Path $dataRoot 'branding-kits'
$logDirectory = Join-Path $dataRoot 'logs'
$appLogDirectory = Join-Path $logDirectory 'app'
$proxyLogDirectory = Join-Path $logDirectory 'caddy'
$serviceDirectory = Join-Path $dataRoot 'services'
$caddyDirectory = Join-Path $dataRoot 'caddy'
$caddyConfigDirectory = Join-Path $caddyDirectory 'config'
$caddyDataDirectory = Join-Path $caddyDirectory 'data'
$caddyfile = Join-Path $configDirectory 'Caddyfile'
$appServiceXml = Join-Path $serviceDirectory 'Grabenplaner.Service.xml'
$proxyServiceXml = Join-Path $serviceDirectory 'Grabenplaner.Caddy.Service.xml'
$appServiceExe = Join-Path $serviceDirectory 'Grabenplaner.Service.exe'
$proxyServiceExe = Join-Path $serviceDirectory 'Grabenplaner.Caddy.Service.exe'
$installedCaddy = Join-Path $caddyDirectory 'caddy.exe'
$privateDirectory = Join-Path $dataRoot 'private'
$amuBlobDirectory = Join-Path $dataRoot 'private\amu\blobs'
$amuStorageRoot = Split-Path -Parent $amuBlobDirectory
$hasExistingAmuState = (Test-Path -LiteralPath (Join-Path $amuStorageRoot 'key-check.amu') -PathType Leaf) -or [bool](Get-ChildItem -LiteralPath $amuBlobDirectory -Filter '*.amu' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)
$suppliedAmuKey = $PSBoundParameters.ContainsKey('AmuEncryptionKey') -and -not [string]::IsNullOrWhiteSpace($AmuEncryptionKey)
$createdAmuKey = $false
if (Test-Path -LiteralPath $appServiceXml -PathType Leaf) {
    try {
        [xml]$existingService = Get-Content -LiteralPath $appServiceXml -Raw
        $existingKey = $existingService.service.env | Where-Object { $_.name -eq 'GRABENPLANER_AMU_KEY' } | Select-Object -First 1
        $existingKeyId = $existingService.service.env | Where-Object { $_.name -eq 'GRABENPLANER_AMU_KEY_ID' } | Select-Object -First 1
        if ($suppliedAmuKey -and $existingKey.value -and $AmuEncryptionKey -ne [string]$existingKey.value) {
            throw 'Ein bestehender AMU-Schlüssel darf nicht durch eine Neuinstallation ersetzt werden.'
        }
        if (-not $AmuEncryptionKey -and $existingKey.value) { $AmuEncryptionKey = [string]$existingKey.value }
        if (-not $PSBoundParameters.ContainsKey('AmuKeyId') -and $existingKeyId.value) { $AmuKeyId = [string]$existingKeyId.value }
    } catch { throw 'Der bestehende AMU-Schlüssel konnte nicht sicher aus der Dienstkonfiguration gelesen werden.' }
}
if (-not $AmuEncryptionKey) {
    if ($hasExistingAmuState) {
        throw 'Es sind bereits verschlüsselte AMU-Dateien vorhanden, aber der zugehörige Schlüssel fehlt. Die Einrichtung wurde ohne Änderung abgebrochen.'
    }
    $AmuEncryptionKey = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $createdAmuKey = $true
}
try { $amuKeyBytes = [Convert]::FromBase64String($AmuEncryptionKey) } catch { throw 'AmuEncryptionKey muss ein gültiger Base64-Schlüssel sein.' }
if ($amuKeyBytes.Length -ne 32) { throw 'AmuEncryptionKey muss genau 32 Byte enthalten.' }
if ($hasExistingAmuState) {
    $amuModule = Join-Path $appRoot 'lib\amu-storage.js'
    if (-not (Test-Path -LiteralPath $amuModule -PathType Leaf)) { throw "AMU-Prüfmodul nicht gefunden: $amuModule" }
    $keyValidationScript = @'
const [modulePath, sourceDirectory, keyId, key] = process.argv.slice(2);
const { validateEncryptionKeyForStorage } = require(modulePath);
const result = validateEncryptionKeyForStorage({ sourceDirectory, encryptionKeys: { [keyId]: key }, activeKeyId: keyId });
process.stdout.write(JSON.stringify(result));
'@
    $keyValidationScript | & $nodePath - $amuModule $amuStorageRoot $AmuKeyId $AmuEncryptionKey | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Der angegebene AMU-Schlüssel kann die vorhandenen Dokumente nicht entschlüsseln. Die Einrichtung wurde abgebrochen.' }
}
$createdServiceControlToken = $false
if (-not $ServiceControlToken -and (Test-Path -LiteralPath $appServiceXml -PathType Leaf)) {
    try {
        [xml]$existingServiceControl = Get-Content -LiteralPath $appServiceXml -Raw
        $existingToken = $existingServiceControl.service.env | Where-Object { $_.name -eq 'GRABENPLANER_SERVICE_CONTROL_TOKEN' } | Select-Object -First 1
        if ($existingToken.value) { $ServiceControlToken = [string]$existingToken.value }
    } catch { throw 'Der bestehende Dienststeuerungs-Token konnte nicht sicher gelesen werden.' }
}
if (-not $ServiceControlToken) {
    $ServiceControlToken = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $createdServiceControlToken = $true
}
if ($ServiceControlToken.Length -lt 32) { throw 'ServiceControlToken muss mindestens 32 Zeichen lang sein.' }

if ($StartServices -and -not $RegisterServices) {
    throw 'StartServices setzt RegisterServices voraus.'
}
if ($RegisterServices) {
    if (-not $WinSwExecutable -or -not $CaddyExecutable) { throw 'Fuer die Dienstregistrierung muessen WinSwExecutable und CaddyExecutable angegeben werden.' }
    Assert-PinnedExecutable $WinSwExecutable $WinSwSha256 'WinSW'
    Assert-PinnedExecutable $CaddyExecutable $CaddySha256 'Caddy'
}
$scannerEngine = $null
if ($RegisterServices -or $StartServices) {
    $scannerEngine = Assert-SupportedScannerReady -NodePath $nodePath -AppRoot $appRoot
}

$templates = $PSScriptRoot
$caddyTemplate = Join-Path (Split-Path -Parent $templates) 'caddy\Caddyfile.example'
$appServiceTemplate = Join-Path $templates 'Grabenplaner.Service.xml.example'
$proxyServiceTemplate = Join-Path $templates 'Caddy.Service.xml.example'
$stopScript = Join-Path $templates 'Stop-GrabenplanerServer.ps1'
foreach ($template in @($caddyTemplate, $appServiceTemplate, $proxyServiceTemplate, $stopScript)) {
    if (-not (Test-Path -LiteralPath $template -PathType Leaf)) { throw "Vorlage fehlt: $template" }
}

if (-not $PSCmdlet.ShouldProcess($dataRoot, 'Neutrale Grabenplaner-Serverkonfiguration erzeugen')) { return }

foreach ($directory in @($configDirectory, $databaseDirectory, $internalBackupDirectory, $brandingKitsDirectory, $appLogDirectory, $proxyLogDirectory, $serviceDirectory, $caddyDirectory, $caddyConfigDirectory, $caddyDataDirectory, $privateDirectory, $amuStorageRoot, $amuBlobDirectory, $backupRoot)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
# S-1-5-19 = LOCAL SERVICE (App), S-1-5-20 = NETWORK SERVICE (Caddy).
# Am Datenstamm erhalten beide Konten nur Traversierrechte. Leserechte werden
# ausschliesslich an den jeweils benoetigten Unterordnern vergeben.
Set-RestrictedAcl $dataRoot @('*S-1-5-19:(RX)', '*S-1-5-20:(RX)')
Set-RestrictedAcl $appRoot @('*S-1-5-19:(OI)(CI)(RX)')
& icacls.exe (Join-Path $appRoot '*') /reset /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Die App-Berechtigungen konnten nicht rekursiv uebernommen werden.' }
Set-RestrictedAcl $configDirectory @('*S-1-5-20:(OI)(CI)(RX)')
Set-RestrictedAcl $databaseDirectory @('*S-1-5-19:(OI)(CI)(M)')
Set-RestrictedAcl $internalBackupDirectory @('*S-1-5-19:(OI)(CI)(M)')
Set-RestrictedAcl $brandingKitsDirectory @('*S-1-5-19:(OI)(CI)(M)')
Set-RestrictedAcl $logDirectory @('*S-1-5-19:(RX)', '*S-1-5-20:(RX)')
Set-RestrictedAcl $appLogDirectory @('*S-1-5-19:(OI)(CI)(M)')
Set-RestrictedAcl $proxyLogDirectory @('*S-1-5-20:(OI)(CI)(M)')
Set-RestrictedAcl $serviceDirectory @('*S-1-5-19:(RX)', '*S-1-5-20:(RX)')
Set-RestrictedAcl $caddyDirectory @('*S-1-5-20:(RX)')
Set-RestrictedAcl $caddyConfigDirectory @('*S-1-5-20:(OI)(CI)(M)')
Set-RestrictedAcl $caddyDataDirectory @('*S-1-5-20:(OI)(CI)(M)')
Set-RestrictedAcl $privateDirectory @('*S-1-5-19:(OI)(CI)(M)')
Set-RestrictedAcl $backupRoot @('*S-1-5-19:(OI)(CI)(M)')

$caddyContent = (Get-Content -LiteralPath $caddyTemplate -Raw)
$caddyContent = $caddyContent.Replace('{{PUBLIC_HOST}}', $publicUri.Authority)
$caddyContent = $caddyContent.Replace('{{UPSTREAM}}', "127.0.0.1:$Port")
$caddyContent = $caddyContent.Replace('{{CADDY_LOG_PATH}}', (Join-Path $proxyLogDirectory 'access.log').Replace('\', '/'))
Set-Content -LiteralPath $caddyfile -Value $caddyContent -Encoding utf8
Set-RestrictedAcl $caddyfile @('*S-1-5-20:(R)')

$appXml = Get-Content -LiteralPath $appServiceTemplate -Raw
$appReplacements = @{
    '{{NODE_EXECUTABLE}}' = ConvertTo-XmlText $nodePath
    '{{SERVER_SCRIPT}}' = ConvertTo-XmlText $serverScript
    '{{APP_DIRECTORY}}' = ConvertTo-XmlText $appRoot
    '{{SERVICE_LOG_DIRECTORY}}' = ConvertTo-XmlText $appLogDirectory
    '{{PUBLIC_URL}}' = ConvertTo-XmlText $PublicUrl.TrimEnd('/')
    '{{PORT}}' = [string]$Port
    '{{DATA_DIRECTORY}}' = ConvertTo-XmlText $dataRoot
    '{{DATABASE_PATH}}' = ConvertTo-XmlText $databasePath
    '{{BACKUP_DIRECTORY}}' = ConvertTo-XmlText $backupRoot
    '{{APP_LOG_DIRECTORY}}' = ConvertTo-XmlText $appLogDirectory
    '{{BACKUP_KEEP}}' = [string]$BackupKeep
    '{{AMU_KEY_ID}}' = ConvertTo-XmlText $AmuKeyId
    '{{AMU_KEY}}' = ConvertTo-XmlText $AmuEncryptionKey
    '{{SERVICE_CONTROL_TOKEN}}' = ConvertTo-XmlText $ServiceControlToken
    '{{STOP_SCRIPT}}' = ConvertTo-XmlText $stopScript
}
foreach ($entry in $appReplacements.GetEnumerator()) { $appXml = $appXml.Replace($entry.Key, $entry.Value) }
Set-Content -LiteralPath $appServiceXml -Value $appXml -Encoding utf8
Set-RestrictedAcl $appServiceXml @('*S-1-5-19:(R)')

$proxyXml = Get-Content -LiteralPath $proxyServiceTemplate -Raw
$proxyReplacements = @{
    '{{CADDY_EXECUTABLE}}' = ConvertTo-XmlText $installedCaddy
    '{{CADDYFILE}}' = ConvertTo-XmlText $caddyfile
    '{{CADDY_DIRECTORY}}' = ConvertTo-XmlText $caddyDirectory
    '{{CADDY_CONFIG_DIRECTORY}}' = ConvertTo-XmlText $caddyConfigDirectory
    '{{CADDY_DATA_DIRECTORY}}' = ConvertTo-XmlText $caddyDataDirectory
    '{{SERVICE_LOG_DIRECTORY}}' = ConvertTo-XmlText $proxyLogDirectory
}
foreach ($entry in $proxyReplacements.GetEnumerator()) { $proxyXml = $proxyXml.Replace($entry.Key, $entry.Value) }
Set-Content -LiteralPath $proxyServiceXml -Value $proxyXml -Encoding utf8
Set-RestrictedAcl $proxyServiceXml @('*S-1-5-20:(R)')

if ($RegisterServices) {
    Copy-Item -LiteralPath $WinSwExecutable -Destination $appServiceExe -Force
    Copy-Item -LiteralPath $WinSwExecutable -Destination $proxyServiceExe -Force
    Copy-Item -LiteralPath $CaddyExecutable -Destination $installedCaddy -Force
    Set-RestrictedAcl $appServiceExe @('*S-1-5-19:(RX)')
    Set-RestrictedAcl $proxyServiceExe @('*S-1-5-20:(RX)')
    Set-RestrictedAcl $installedCaddy @('*S-1-5-20:(RX)')
    & $installedCaddy validate --config $caddyfile --adapter caddyfile
    if ($LASTEXITCODE -ne 0) { throw 'Caddy hat die erzeugte Konfiguration abgelehnt.' }
    & $appServiceExe install
    if ($LASTEXITCODE -ne 0) { throw 'Der Grabenplaner-Dienst konnte nicht registriert werden.' }
    try {
        & $proxyServiceExe install
        if ($LASTEXITCODE -ne 0) { throw 'Der Caddy-Dienst konnte nicht registriert werden.' }
    } catch {
        & $appServiceExe uninstall | Out-Null
        throw
    }
    if ($StartServices) {
        & $appServiceExe start
        if ($LASTEXITCODE -ne 0) { throw 'Der Grabenplaner-Dienst konnte nicht gestartet werden.' }
        & $proxyServiceExe start
        if ($LASTEXITCODE -ne 0) { throw 'Der Caddy-Dienst konnte nicht gestartet werden.' }
    }
}

[pscustomobject]@{
    PublicUrl          = $PublicUrl.TrimEnd('/')
    AppDirectory       = $appRoot
    DataDirectory      = $dataRoot
    DatabasePath       = $databasePath
    BackupDirectory    = $backupRoot
    Caddyfile          = $caddyfile
    ServicesRegistered = [bool]$RegisterServices
    ServicesStarted    = [bool]($RegisterServices -and $StartServices)
    AmuKeyId           = $AmuKeyId
    AmuRecoveryKeyCreated = $createdAmuKey
    ServiceControlTokenCreated = $createdServiceControlToken
    ScannerEngine      = $scannerEngine
}
