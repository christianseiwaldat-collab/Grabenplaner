[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3000,
    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
$token = [string]$env:GRABENPLANER_SERVICE_CONTROL_TOKEN
if ($token.Length -lt 32) { throw 'Der geheime Dienststeuerungs-Token fehlt.' }

$headers = @{ 'X-Grabenplaner-Service-Token' = $token }
$result = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/service/stop" -Headers $headers -TimeoutSec 10
if (-not $result.ok) { throw 'Der Grabenplaner-Prozess hat den kontrollierten Dienststopp abgelehnt.' }

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
    Start-Sleep -Milliseconds 250
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health/live" -TimeoutSec 2 | Out-Null
        $running = $true
    } catch {
        $running = $false
    }
} while ($running -and (Get-Date) -lt $deadline)

if ($running) { throw 'Der Grabenplaner-Prozess wurde nicht rechtzeitig beendet.' }
