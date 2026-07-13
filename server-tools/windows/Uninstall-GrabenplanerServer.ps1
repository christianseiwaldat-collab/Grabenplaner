[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$DataDirectory = 'C:\ProgramData\Grabenplaner',
    [switch]$RemoveGeneratedServiceFiles
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Die Deinstallation muss in einer als Administrator gestarteten PowerShell ausgefuehrt werden.'
}

$dataRoot = [System.IO.Path]::GetFullPath($DataDirectory)
$serviceDirectory = Join-Path $dataRoot 'services'
$services = @(
    @{ Name = 'GrabenplanerCaddy'; Executable = (Join-Path $serviceDirectory 'Grabenplaner.Caddy.Service.exe') },
    @{ Name = 'GrabenplanerServer'; Executable = (Join-Path $serviceDirectory 'Grabenplaner.Service.exe') }
)

foreach ($item in $services) {
    $service = Get-Service -Name $item.Name -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped' -and $PSCmdlet.ShouldProcess($item.Name, 'Windows-Dienst beenden')) {
        Stop-Service -Name $item.Name -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    if ($service -and $PSCmdlet.ShouldProcess($item.Name, 'Windows-Dienst deregistrieren')) {
        if (-not (Test-Path -LiteralPath $item.Executable -PathType Leaf)) {
            throw "WinSW-Wrapper fuer $($item.Name) fehlt: $($item.Executable)"
        }
        & $item.Executable uninstall
        if ($LASTEXITCODE -ne 0) { throw "Dienst $($item.Name) konnte nicht deregistriert werden." }
    }
}

if ($RemoveGeneratedServiceFiles -and (Test-Path -LiteralPath $serviceDirectory) -and $PSCmdlet.ShouldProcess($serviceDirectory, 'Generierte Dienstdateien entfernen')) {
    Remove-Item -LiteralPath $serviceDirectory -Recurse -Force
}

Write-Host 'Dienste wurden entfernt. Datenbank, Branding, Konfiguration, Logs und Backups bleiben erhalten.'
