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

function Set-RestrictedAcl([string]$Path) {
    & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' '*S-1-5-19:(OI)(CI)(M)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Berechtigungen konnten nicht gesetzt werden: $Path" }
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
if ($dataRoot -eq $backupRoot -or $backupRoot.StartsWith($dataRoot + [IO.Path]::DirectorySeparatorChar)) {
    throw 'Backup-Ordner und Datenordner muessen getrennt sein.'
}

$serverScript = Join-Path $appRoot 'server.js'
if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) { throw "server.js wurde nicht gefunden: $serverScript" }
if (-not $NodeExecutable) {
    $bundledNode = Join-Path $appRoot 'runtime\node.exe'
    $NodeExecutable = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
}
$nodePath = Resolve-FullPath $NodeExecutable

$configDirectory = Join-Path $dataRoot 'config'
$databaseDirectory = Join-Path $dataRoot 'data'
$databasePath = Join-Path $databaseDirectory 'dienstplan.db'
$logDirectory = Join-Path $dataRoot 'logs'
$appLogDirectory = Join-Path $logDirectory 'app'
$proxyLogDirectory = Join-Path $logDirectory 'caddy'
$serviceDirectory = Join-Path $dataRoot 'services'
$caddyDirectory = Join-Path $dataRoot 'caddy'
$caddyfile = Join-Path $configDirectory 'Caddyfile'
$appServiceXml = Join-Path $serviceDirectory 'Grabenplaner.Service.xml'
$proxyServiceXml = Join-Path $serviceDirectory 'Grabenplaner.Caddy.Service.xml'
$appServiceExe = Join-Path $serviceDirectory 'Grabenplaner.Service.exe'
$proxyServiceExe = Join-Path $serviceDirectory 'Grabenplaner.Caddy.Service.exe'
$installedCaddy = Join-Path $caddyDirectory 'caddy.exe'
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

if ($RegisterServices) {
    if (-not $WinSwExecutable -or -not $CaddyExecutable) { throw 'Fuer die Dienstregistrierung muessen WinSwExecutable und CaddyExecutable angegeben werden.' }
    Assert-PinnedExecutable $WinSwExecutable $WinSwSha256 'WinSW'
    Assert-PinnedExecutable $CaddyExecutable $CaddySha256 'Caddy'
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

foreach ($directory in @($configDirectory, $databaseDirectory, $appLogDirectory, $proxyLogDirectory, $serviceDirectory, $caddyDirectory, $backupRoot)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
Set-RestrictedAcl $dataRoot
Set-RestrictedAcl $backupRoot

$caddyContent = (Get-Content -LiteralPath $caddyTemplate -Raw)
$caddyContent = $caddyContent.Replace('{{PUBLIC_HOST}}', $publicUri.Authority)
$caddyContent = $caddyContent.Replace('{{UPSTREAM}}', "127.0.0.1:$Port")
$caddyContent = $caddyContent.Replace('{{CADDY_LOG_PATH}}', (Join-Path $proxyLogDirectory 'access.log').Replace('\', '/'))
Set-Content -LiteralPath $caddyfile -Value $caddyContent -Encoding utf8

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

$proxyXml = Get-Content -LiteralPath $proxyServiceTemplate -Raw
$proxyReplacements = @{
    '{{CADDY_EXECUTABLE}}' = ConvertTo-XmlText $installedCaddy
    '{{CADDYFILE}}' = ConvertTo-XmlText $caddyfile
    '{{CADDY_DIRECTORY}}' = ConvertTo-XmlText $caddyDirectory
    '{{SERVICE_LOG_DIRECTORY}}' = ConvertTo-XmlText $proxyLogDirectory
}
foreach ($entry in $proxyReplacements.GetEnumerator()) { $proxyXml = $proxyXml.Replace($entry.Key, $entry.Value) }
Set-Content -LiteralPath $proxyServiceXml -Value $proxyXml -Encoding utf8

if ($RegisterServices) {
    Copy-Item -LiteralPath $WinSwExecutable -Destination $appServiceExe -Force
    Copy-Item -LiteralPath $WinSwExecutable -Destination $proxyServiceExe -Force
    Copy-Item -LiteralPath $CaddyExecutable -Destination $installedCaddy -Force
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
}
