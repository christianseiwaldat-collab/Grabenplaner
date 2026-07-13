# Grabenplaner Serverbetrieb

Der Serverbetrieb ist für eine zentrale Instanz vorgesehen. Die Anwendung läuft ausschließlich auf `127.0.0.1`; Browser greifen über einen HTTPS-Reverse-Proxy darauf zu. Lokalbetrieb und LAN-Host bleiben davon unabhängig.

## Pilotaufbau unter Windows

- Programmdateien: `C:\Program Files\Grabenplaner\app`
- Datenbank, Branding und Logs: `C:\ProgramData\Grabenplaner`
- Backups: getrenntes lokales Laufwerk oder von der IT gesichertes Ziel
- Anwendung: `127.0.0.1:3000`
- öffentlicher Zugang: ausschließlich Caddy auf Port 443

Die SQLite-Datenbank darf nicht auf einem Netzlaufwerk oder synchronisierten Cloudordner liegen. Es läuft genau eine Grabenplaner-Instanz.

## Voraussetzungen

- Windows-Server oder dauerhaft verfügbarer Windows-PC
- feste Domain und passende DNS-/Firewallfreigabe
- bereits eingerichteter Grabenplaner-Admin
- Caddy und WinSW in zuvor freigegebenen, fest gepinnten Versionen
- SHA256-Prüfsummen der freigegebenen Binärdateien
- separates, regelmäßig von der IT gesichertes Backupziel

Grabenplaner lädt Caddy oder WinSW nicht selbst herunter. Die Beispiele unter `server-tools` enthalten keine Firmenwerte, Zertifikate oder Zugangsdaten.

## Vorbereitung

1. App vollständig in den vorgesehenen Programmordner kopieren.
2. Admin zunächst im Lokal- oder LAN-Betrieb einrichten.
3. Caddy- und WinSW-Binärdateien samt freigegebenen SHA256-Werten bereitstellen.
4. Konfiguration zunächst ohne Dienstregistrierung erzeugen:

```powershell
.\server-tools\windows\Install-GrabenplanerServer.ps1 `
  -PublicUrl 'https://plan.example.at' `
  -BackupDirectory 'D:\Grabenplaner-Backups' `
  -WhatIf
```

Danach erfolgt der kontrollierte Durchlauf mit `-RegisterServices`. Dabei müssen die lokal bereitgestellten Dateien und ihre zuvor freigegebenen SHA256-Werte ausdrücklich angegeben werden:

```powershell
.\server-tools\windows\Install-GrabenplanerServer.ps1 `
  -PublicUrl 'https://plan.example.at' `
  -BackupDirectory 'D:\Grabenplaner-Backups' `
  -WinSwExecutable 'C:\IT-Freigabe\WinSW-x64.exe' `
  -WinSwSha256 '<freigegebener SHA256-Wert>' `
  -CaddyExecutable 'C:\IT-Freigabe\caddy.exe' `
  -CaddySha256 '<freigegebener SHA256-Wert>' `
  -RegisterServices
```

`-StartServices` startet beide Dienste nur auf ausdrücklichen Wunsch. Der Assistent lädt nichts herunter.

## Servervariablen

Die vollständige neutrale Vorlage liegt in `server-tools/server.env.example`. Wesentlich sind:

```text
GRABENPLANER_OPERATION_MODE=server
GRABENPLANER_PUBLIC_URL=https://plan.example.at
GRABENPLANER_HOST=127.0.0.1
GRABENPLANER_TRUST_PROXY=loopback
GRABENPLANER_DATA_DIR=C:\ProgramData\Grabenplaner
DB_PATH=C:\ProgramData\Grabenplaner\data\dienstplan.db
BACKUP_DIR=D:\Grabenplaner-Backups
GRABENPLANER_AMU_KEY_ID=server-v1
GRABENPLANER_AMU_KEY=<geheimer 32-Byte-Schlüssel als Base64>
GRABENPLANER_SERVICE_CONTROL_TOKEN=<geheimer zufälliger Dienststeuerungs-Token>
```

Der Einrichtungsassistent erzeugt den AMU-Schlüssel bei einer neuen, leeren Installation zufällig in der ACL-geschützten Dienstkonfiguration. Sind bereits AMU-Dateien vorhanden, wird niemals still ein neuer Schlüssel erzeugt: Die Einrichtung verlangt den bestehenden Schlüssel und prüft ihn an den vorhandenen Dokumenten. Die IT muss diesen Recovery-Schlüssel zusätzlich getrennt und geschützt sichern; ohne ihn können verschlüsselte AMU-Dokumente nicht wiederhergestellt werden.

Auch der Dienststeuerungs-Token wird zufällig erzeugt und bei einer erneuten Einrichtung beibehalten. WinSW verwendet ihn ausschließlich über den lokalen Stop-Helfer, damit der Server vor dem Dienstende ein Abschlussbackup und einen WAL-Checkpoint ausführt. Der normale Browserzugriff kann diesen Endpunkt nicht verwenden.

Der Servermodus wird nicht im Browser aktiviert. Updates, Neustarts und Datenbankimporte erfolgen ausschließlich in einem Wartungsfenster am Server.

## Prüfung, Backup und Wiederherstellung

`Test-GrabenplanerServer.ps1` prüft Dienste, interne und öffentliche Healthchecks, HSTS, SQLite und die Aktualität der Backups. Das Caddyfile kann zusätzlich mit der bereitgestellten Caddy-Version validiert werden.

`Backup-Grabenplaner.ps1` arbeitet nur bei gestopptem App-Dienst. Es erstellt mit SQLite `VACUUM INTO` einen konsistenten Sicherungspunkt, prüft ihn mit `quick_check` und koppelt die Datenbank über Dateiname und SHA256 fest an ihr eigenes AMU-Manifest. Datenbank und verschlüsselte AMU-Dateien werden gemeinsam veröffentlicht und gemäß Aufbewahrung auch gemeinsam aufgeräumt. Im laufenden Betrieb übernimmt die integrierte Grabenplaner-Sicherung upload-sichere, ebenfalls gekoppelte Sicherungspunkte.

`Restore-Grabenplaner.ps1` arbeitet nur bei vollständig gestopptem App-Dienst. Es akzeptiert ausschließlich zusammengehörige Datenbank-/AMU-Sicherungspunkte, prüft Integrität, Kopplung und den Recovery-Schlüssel, erstellt Sicherheitskopien des aktuellen Stands, tauscht beides kontrolliert aus und setzt bei einem Fehler automatisch zurück. Standardmäßig wird der gleichnamige `.amu`-Ordner neben der gewählten `.db`-Datei verwendet; der Schlüssel wird aus der geschützten Dienstkonfiguration gelesen oder ausdrücklich übergeben. Ein Dienststart nach erfolgreicher Wiederherstellung ist optional.

## Pilotgrenzen

- Domain, Zertifikat, Firewall, Dienstkonto und Backupziel werden gemeinsam mit der Firmen-IT freigegeben.
- Die Beispiele führen keine automatische produktive Bereitstellung durch.
- Die öffentliche Auslieferung bleibt neutral; Firmenlogos und Voreinstellungen gehören ausschließlich in separate Branding-Kits.
- SQLite eignet sich für den kleinen Pilotbetrieb mit einer Instanz. Mehrere App-Server erfordern später eine andere Datenbankarchitektur.
