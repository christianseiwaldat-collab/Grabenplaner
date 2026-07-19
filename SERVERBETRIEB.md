# Grabenplaner Serverbetrieb

Der HTTPS-Serverbetrieb ist für eine zentrale, von der Firmen-IT verwaltete Grabenplaner-Instanz vorgesehen. Die Node.js-Anwendung läuft ausschließlich auf `127.0.0.1`; Browser greifen nur über Caddy und eine freigegebene HTTPS-Adresse darauf zu. Lokalbetrieb und LAN-Host bleiben davon unabhängig.

Für neue Beta-Server wird **Ubuntu 26.04 LTS** empfohlen. Die vorhandenen Windows-Werkzeuge bleiben unterstützt. Auf beiden Plattformen gelten dieselben Sicherheitsgrenzen: eine lokale SQLite-Datenbank, genau eine aktive Grabenplaner-Instanz, Caddy als einziger öffentlicher Zugang sowie getrennte Programm-, Daten-, Schlüssel- und Backupbereiche.

Die bereitgestellten Werkzeuge ersetzen nicht die betriebliche Prüfung von Domain, DNS, Firewall, Zertifikat, Dienstkonten, Virenscanner, Backupziel und Wiederanlaufplan durch die verantwortliche IT.

## Zielaufbau unter Ubuntu 26.04 LTS

- Programmdateien: `/opt/grabenplaner/app`
- Datenbank, Branding und verschlüsselte Dokumente: `/var/lib/grabenplaner`
- geschützte Dienstkonfiguration: `/etc/grabenplaner/grabenplaner.env`
- Protokolle: systemd-Journal sowie `/var/log/grabenplaner/app` und `/var/log/grabenplaner/caddy`
- lokale Sicherungspunkte: `/var/backups/grabenplaner`; ein externes, verschlüsseltes Backupziel folgt getrennt
- Anwendung: `127.0.0.1:3000`
- öffentlicher Zugang: ausschließlich Caddy auf Port 443

Die Anwendung läuft als eigener, nicht interaktiv anmeldbarer Benutzer `grabenplaner`. Caddy bleibt davon getrennt und erhält keinen Zugriff auf SQLite, Branding, Schlüssel oder AUM-Dokumente. `systemd` ersetzt WinSW, UFW ersetzt die Windows-Firewallverwaltung und ClamAV übernimmt die lokale Prüfung hochgeladener Dokumente. Der Normalbetrieb verwendet `grabenplaner.service` und den von Ubuntu bereitgestellten `caddy.service`.

Die SQLite-Datenbank muss auf einem lokalen Linux-Dateisystem liegen. Netzlaufwerke, FUSE-Cloudmounts und synchronisierte Ordner sind als aktiver Datenbankpfad nicht zulässig.

### Voraussetzungen unter Ubuntu

- Ubuntu 26.04 LTS x86-64 mit allen Sicherheitsaktualisierungen
- Node.js gemäß `engines.node` in `package.json` und die dort festgeschriebene pnpm-Version
- Caddy, systemd, UFW, ClamAV und `unzip`
- feste Domain mit korrektem DNS-Eintrag und erreichbaren Ports 80/443
- lokales Backupziel sowie dokumentierter Wiederanlauf- und Wiederherstellungstest
- SSH-Zugang nur für die zuständige Administration, vorzugsweise mit Schlüsselanmeldung

Das Linux-Release ist bewusst ein **Quellpaket ohne `node_modules` und ohne gebündelte Node-Runtime**. Native Abhängigkeiten wie `sharp` müssen für Linux gebaut beziehungsweise aus den freigegebenen Linux-Paketen bezogen werden. Der Installationsablauf führt deshalb auf dem Ubuntu-Zielsystem exakt folgenden, durch den Lockfile gebundenen Produktionsinstall aus:

```bash
pnpm install --prod --frozen-lockfile --config.node-linker=hoisted
```

Dadurch gelangen keine unter Windows gebauten nativen Module auf den Linux-Server. Das Paket enthält keine Datenbank, Geheimnisse, realen Branding-Kits oder kundenspezifischen Dateien.

### Neutrales Linux-Serverpaket bauen

Der plattformneutrale Paketbauer kann auf dem Windows-Entwicklungsrechner in PowerShell ausgeführt werden:

```powershell
.\server-tools\package\New-GrabenplanerLinuxServerPackage.ps1 `
  -OutputDirectory '.\release\server-linux'
```

Er akzeptiert ausschließlich einen sauberen Git-Checkout, übernimmt nur freigegebene versionierte Laufzeitdateien und erzeugt ein deterministisches `linux-x64.zip` samt SHA256-Datei. Im Archivroot liegt `grabenplaner-server-manifest.json` mit Dateiprüfsummen, Quellcommit, Mindestversionen und `dependenciesMode: source-install`. Vor der Installation müssen ZIP und veröffentlichte SHA256-Prüfsumme miteinander verglichen werden.

Die kontrollierte Erstinstallation verwendet das geprüfte Paket und seine veröffentlichte Prüfsumme:

```bash
sudo bash server-tools/linux/install-grabenplaner-server.sh \
  --package /pfad/Grabenplaner-Server-v0.72.0-beta-linux-x64.zip \
  --sha256 '<veröffentlichter SHA256-Wert>' \
  --public-url https://beta.example.at
```

Eine neue Installation erzeugt keine voreingestellten Zugangsdaten. Sie startet zunächst `grabenplaner-bootstrap.service` ausschließlich auf Loopback. Die erste Administration wird über einen SSH-Tunnel angelegt:

```bash
ssh -L 3000:127.0.0.1:3000 admin@server.example.at
```

Nach der Ersteinrichtung beendet `sudo grabenplaner-bootstrap-admin finish` den Bootstrapmodus und aktiviert den abgesicherten HTTPS-Betrieb. Der Bootstrap-Port darf niemals durch UFW oder eine Contabo-Firewall öffentlich freigegeben werden.

### Servervariablen unter Ubuntu

Die vollständige neutrale Vorlage liegt in `server-tools/server.env.example`. Für Ubuntu werden insbesondere lokale Linux-Pfade verwendet:

```text
NODE_ENV=production
GRABENPLANER_OPERATION_MODE=server
GRABENPLANER_DEPLOYMENT_KIND=production
GRABENPLANER_PUBLIC_URL=https://beta.example.at
GRABENPLANER_HOST=127.0.0.1
GRABENPLANER_TRUST_PROXY=loopback
GRABENPLANER_DATA_DIR=/var/lib/grabenplaner
DB_PATH=/var/lib/grabenplaner/data/dienstplan.db
BACKUP_DIR=/var/backups/grabenplaner
GRABENPLANER_AMU_KEY_ID=server-v1
GRABENPLANER_AMU_KEY=<geheimer 32-Byte-Schlüssel als Base64>
GRABENPLANER_INTEGRATION_KEY_ID=server-v1
GRABENPLANER_INTEGRATION_KEY=<separater geheimer 32-Byte-Schlüssel als Base64>
GRABENPLANER_SERVICE_CONTROL_TOKEN=<geheimer zufälliger Dienststeuerungs-Token>
```

Die Datei `/etc/grabenplaner/grabenplaner.env` darf ausschließlich für `root` und den Grabenplaner-Dienst lesbar sein. Schlüssel und Tokens gehören weder in SQLite noch in das Programmverzeichnis, ein Image, ein Git-Repository oder ein Serverpaket.

## Zielaufbau unter Windows

- Programmdateien: `C:\Program Files\Grabenplaner\app`
- Datenbank, Branding und Logs: `C:\ProgramData\Grabenplaner`
- Backups: getrenntes lokales Laufwerk oder von der IT gesichertes Ziel
- Anwendung: `127.0.0.1:3000`
- öffentlicher Zugang: ausschließlich Caddy auf Port 443

Die SQLite-Datenbank darf nicht auf einem Netzlaufwerk oder synchronisierten Cloudordner liegen. Es läuft genau eine Grabenplaner-Instanz.

Der Datenfluss bleibt bewusst eindeutig:

1. Caddy nimmt öffentliche HTTPS-Verbindungen auf Port 443 an.
2. Caddy leitet ausschließlich intern an `127.0.0.1:3000` weiter.
3. Grabenplaner prüft die konfigurierte öffentliche Adresse, den vertrauenswürdigen Loopback-Proxy und die Herkunft schreibender Anfragen.
4. SQLite, Branding, verschlüsselte AUM-Dokumente, Schlüsselkonfiguration und Logs liegen außerhalb des Programmordners.

### Dienstidentitäten und Dateirechte

Der Einrichtungsassistent trennt Reverse-Proxy und Anwendung auch auf Betriebssystemebene:

- **Grabenplaner Server:** läuft als `LOCAL SERVICE` und erhält nur die für Programm, Daten, Logs und Backupziel erforderlichen Rechte.
- **Grabenplaner HTTPS Proxy:** läuft als `NETWORK SERVICE` und erhält Zugriff auf Caddy-Konfiguration, Zertifikatsdaten und Proxy-Logs, nicht aber auf Datenbank, Branding oder AUM-Speicher.
- **Administratoren und SYSTEM:** behalten die erforderlichen Wartungsrechte.

Die erzeugten Dienstkonfigurationen enthalten Schlüssel beziehungsweise Dienststeuerungswerte und werden deshalb mit eingeschränkten ACLs gespeichert. Die Firmen-IT muss die gesetzten Rechte vor der Freigabe kontrollieren und darf den Datenordner nicht allgemein für Benutzer oder Netzwerkfreigaben öffnen.

## Voraussetzungen unter Windows

- Windows-Server oder dauerhaft verfügbarer Windows-PC
- feste Domain und passende DNS-/Firewallfreigabe
- bereits eingerichteter Grabenplaner-Admin
- Caddy und WinSW in zuvor freigegebenen, fest gepinnten Versionen
- SHA256-Prüfsummen der freigegebenen Binärdateien
- separates, regelmäßig von der IT gesichertes Backupziel
- lokal installierter und von Grabenplaner erreichbarer Virenscanner für AUM-Uploads
- dokumentierter Wiederanlauf- und Wiederherstellungstest

Grabenplaner lädt Caddy oder WinSW nicht selbst herunter. Die Beispiele unter `server-tools` enthalten keine Firmenwerte, Zertifikate oder Zugangsdaten.

## Vorbereitung unter Windows

1. Grabenplaner vollständig in den vorgesehenen Programmordner kopieren.
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

## Servervariablen unter Windows

Die vollständige neutrale Vorlage liegt in `server-tools/server.env.example`. Wesentlich sind:

```text
NODE_ENV=production
GRABENPLANER_OPERATION_MODE=server
GRABENPLANER_DEPLOYMENT_KIND=production
GRABENPLANER_PUBLIC_URL=https://plan.example.at
GRABENPLANER_HOST=127.0.0.1
GRABENPLANER_TRUST_PROXY=loopback
GRABENPLANER_DATA_DIR=C:\ProgramData\Grabenplaner
DB_PATH=C:\ProgramData\Grabenplaner\data\dienstplan.db
BACKUP_DIR=D:\Grabenplaner-Backups
GRABENPLANER_AMU_KEY_ID=server-v1
GRABENPLANER_AMU_KEY=<geheimer 32-Byte-Schlüssel als Base64>
GRABENPLANER_INTEGRATION_KEY_ID=server-v1
GRABENPLANER_INTEGRATION_KEY=<separater geheimer 32-Byte-Schlüssel als Base64>
GRABENPLANER_SERVICE_CONTROL_TOKEN=<geheimer zufälliger Dienststeuerungs-Token>
```

### Optionale externe Besetzungswarnungen

Die interne Warnung in der mobilen App funktioniert ohne externen Dienst. Für E-Mail, SMS oder WhatsApp richtet die Firmen-IT mindestens einen Versandweg über Umgebungsvariablen ein. Empfänger und früheste Versandzeit werden anschließend von der berechtigten Leitung im Portal gepflegt. Externe Meldungen enthalten nur den neutralen Hinweis, sich wegen einer Besetzungswarnung in der App anzumelden; Gesundheitsdaten werden nicht versendet.

Ein neues oder geändertes Warnziel wird erst nach Eingabe eines sechsstelligen Einmalcodes aktiviert. Der Code läuft nach zehn Minuten ab; in der Datenbank liegen nur ein gesalzener Hash, Ablaufzeit und Fehlversuchszähler. Ohne erfolgreiche Bestätigung wird für dieses Ziel keine Besetzungswarnung eingereiht.

E-Mail kann über einen vorhandenen HTTPS-Benachrichtigungsdienst angebunden werden:

```text
GRABENPLANER_EMAIL_WEBHOOK_URL=https://notify.example.at/email
GRABENPLANER_EMAIL_WEBHOOK_TOKEN=<geheimer Provider-Token>
```

SMS und WhatsApp verwenden jeweils einen von der IT betriebenen oder freigegebenen HTTPS-Webhook:

```text
GRABENPLANER_SMS_WEBHOOK_URL=https://notify.example.at/sms
GRABENPLANER_SMS_WEBHOOK_TOKEN=<geheimer Provider-Token>
GRABENPLANER_WHATSAPP_WEBHOOK_URL=https://notify.example.at/whatsapp
GRABENPLANER_WHATSAPP_WEBHOOK_TOKEN=<geheimer Provider-Token>
```

Alternativ unterstützt Grabenplaner SMTP, sobald das optionale Runtime-Paket `nodemailer` in der kontrollierten Serverinstallation vorhanden ist. Die Variablen heißen `GRABENPLANER_SMTP_HOST`, `GRABENPLANER_SMTP_PORT`, `GRABENPLANER_SMTP_SECURE`, `GRABENPLANER_SMTP_USER`, `GRABENPLANER_SMTP_PASSWORD` und `GRABENPLANER_SMTP_FROM`. Provider-Tokens und SMTP-Zugangsdaten gehören ausschließlich in die ACL-geschützte Dienstkonfiguration und niemals in SQLite, Branding-Kits oder das Repository.

Der Einrichtungsassistent erzeugt den AMU-Schlüssel bei einer neuen, leeren Installation zufällig in der ACL-geschützten Dienstkonfiguration. Sind bereits AMU-Dateien vorhanden, wird niemals still ein neuer Schlüssel erzeugt: Die Einrichtung verlangt den bestehenden Schlüssel und prüft ihn an den vorhandenen Dokumenten. Die IT muss diesen Recovery-Schlüssel zusätzlich getrennt und geschützt sichern; ohne ihn können verschlüsselte AMU-Dokumente nicht wiederhergestellt werden.

Auch der Dienststeuerungs-Token wird zufällig erzeugt und bei einer erneuten Einrichtung beibehalten. WinSW verwendet ihn ausschließlich über den lokalen Stop-Helfer, damit der Server vor dem Dienstende ein Abschlussbackup und einen WAL-Checkpoint ausführt. Der normale Browserzugriff kann diesen Endpunkt nicht verwenden.

Der Servermodus wird nicht im Browser aktiviert. Auch die öffentliche Adresse, Proxy-Vertrauen und Produktionskennung können dort nicht verändert werden. Updates, Neustarts und Datenbankimporte erfolgen ausschließlich in einem Wartungsfenster am Server.

## Betriebsbereitschaft und Überwachung

Grabenplaner stellt zwei getrennte Prüfungen bereit:

- `/api/health/live` bestätigt ausschließlich, dass der Anwendungsprozess antwortet. Caddy verwendet diesen Endpunkt für seine aktive Upstream-Prüfung.
- `/api/health/ready` bestätigt die Betriebsbereitschaft einschließlich Produktionskonfiguration, Datenbankintegrität, Instanzschutz, Daten-/Backupziel, verschlüsseltem AUM-Speicher und Virenscanner.

Eine laufende, aber noch nicht betriebsbereite Instanz darf deshalb beim Ready-Check einen Fehlerstatus liefern. Monitoring und Freigabeprüfungen müssen den Ready-Endpunkt verwenden; ein erfolgreicher Live-Check allein genügt nicht.

In Grabenplaner zeigt **Einstellungen → Datenbank → Server-Betriebsprüfung** berechtigten administrativen Rollen zusätzliche Wartungsdetails einschließlich relevanter Speicherziele. Geheimnisse und Schlüssel werden nicht an den Browser ausgegeben; die öffentlichen Live-/Ready-Endpunkte bleiben auf einen minimalen Status ohne interne Pfade beschränkt.

## Prüfung, Backup und Wiederherstellung

`Test-GrabenplanerServer.ps1` prüft Dienste, interne und öffentliche Live-/Ready-Endpunkte, TLS-Zertifikat, HSTS und weitere Sicherheitsheader, SQLite sowie die Aktualität der Backups. Das Caddyfile kann zusätzlich mit der bereitgestellten Caddy-Version validiert werden. Diese Prüfung gehört nach Einrichtung, Update und Wiederherstellung zum Wartungsablauf.

`Backup-Grabenplaner.ps1` arbeitet nur bei gestopptem Grabenplaner-Dienst. Es erstellt mit SQLite `VACUUM INTO` einen konsistenten Sicherungspunkt, prüft ihn mit `quick_check` und koppelt die Datenbank über Dateiname und SHA256 fest an ihr eigenes AMU-Manifest. Datenbank und verschlüsselte AMU-Dateien werden gemeinsam veröffentlicht und gemäß Aufbewahrung auch gemeinsam aufgeräumt. Im laufenden Betrieb übernimmt die integrierte Grabenplaner-Sicherung upload-sichere, ebenfalls gekoppelte Sicherungspunkte.

`Restore-Grabenplaner.ps1` arbeitet nur bei vollständig gestopptem Grabenplaner-Dienst. Es akzeptiert ausschließlich zusammengehörige Datenbank-/AMU-Sicherungspunkte, prüft Integrität, Kopplung und den Recovery-Schlüssel, erstellt Sicherheitskopien des aktuellen Stands, tauscht beides kontrolliert aus und setzt bei einem Fehler automatisch zurück. Standardmäßig wird der gleichnamige `.amu`-Ordner neben der gewählten `.db`-Datei verwendet; der Schlüssel wird aus der geschützten Dienstkonfiguration gelesen oder ausdrücklich übergeben. Ein Dienststart nach erfolgreicher Wiederherstellung ist optional.

## Kontrollierte Updates und Rollback

Im HTTPS-Serverbetrieb ist das Portable-Update im Browser deaktiviert. `Update-GrabenplanerServer.ps1` führt ein von der IT gestartetes Wartungsupdate aus:

1. Release-ZIP und ausdrücklich angegebene SHA256-Prüfsumme werden vor dem Entpacken geprüft.
2. Vor jeder Änderung entsteht ein verifiziertes, mit der AUM-Ablage gekoppeltes Backup.
3. Die neue Version wird zunächst in einem getrennten Staging-Ordner validiert.
4. Caddy und Grabenplaner werden kontrolliert gestoppt; Datenordner, Dienstkonfiguration, Schlüssel und Backups bleiben unangetastet.
5. Nach dem Austausch der Programmdateien müssen Dienststart sowie Live- und Ready-Prüfung erfolgreich sein.
6. Schlägt die Prüfung fehl, wird automatisch auf den vorherigen Programmstand zurückgerollt und dieser erneut geprüft.

Ein neutrales Serverpaket wird ausschließlich aus einem sauberen Git-Checkout erstellt. Der Paketbauer installiert die festgeschriebenen Produktionsabhängigkeiten neu, prüft sie nach einem vollständigen ZIP-Rundlauf und erzeugt zusätzlich eine SHA256-Datei:

```powershell
.\server-tools\windows\New-GrabenplanerServerPackage.ps1 `
  -OutputDirectory '.\release\server' `
  -NodeRuntimeDirectory '.\runtime'
```

Für den Paketbau wird die in `package.json` festgelegte pnpm-Version benötigt. Liegt pnpm nicht im `PATH`, kann die freigegebene `pnpm.cmd` mit `-PnpmExecutable` ausdrücklich angegeben werden. Unversionierte Dateien und kundenspezifische Assets führen zum Abbruch und gelangen nicht in das neutrale Paket.

Das geprüfte Paket wird am Server in einer als Administrator gestarteten PowerShell zusammen mit seiner veröffentlichten Prüfsumme eingespielt:

```powershell
$package = 'C:\IT-Freigabe\Grabenplaner-Server-v0.71.0-beta-windows-x64.zip'
$sha256 = ((Get-Content "$package.sha256" -Raw).Trim() -split '\s+')[0]

.\server-tools\windows\Update-GrabenplanerServer.ps1 `
  -PackageZip $package `
  -PackageSha256 $sha256
```

Gleiche oder ältere Versionen werden standardmäßig abgewiesen. Ein bewusstes Wiederholen beziehungsweise Zurückstufen ist nur als dokumentierter IT-Sonderfall mit `-AllowDowngradeOrReinstall` möglich.

Updates sollen zuerst in einer getrennten Testumgebung geprüft und anschließend in einem angekündigten Wartungsfenster eingespielt werden. Release-ZIP, Prüfsumme, Ergebnis und verwendeter Sicherungspunkt gehören in das betriebliche Änderungsprotokoll.

## Betrieb und Grenzen

- Domain, Zertifikat, Firewall, Dienstkonto und Backupziel werden gemeinsam mit der Firmen-IT freigegeben.
- Die Werkzeuge führen keine unbeaufsichtigte Cloud- oder Internetbereitstellung durch; Einrichtung und Freigabe bleiben bewusste IT-Schritte.
- Die öffentliche Auslieferung bleibt neutral; Firmenlogos und Voreinstellungen gehören ausschließlich in separate Branding-Kits.
- Der produktive Aufbau verwendet genau eine Grabenplaner-Instanz mit lokaler SQLite-Datenbank. Hochverfügbarkeit, mehrere aktive Anwendungsserver und horizontale Skalierung sind nicht Bestandteil dieser Version.
- Caddy übernimmt HTTPS und Zertifikatsverwaltung, ersetzt aber keine Firewall, Systemaktualisierung, Endpoint-Security oder externe Überwachung.
- Der derzeitige Smartphone-Zugang verwendet das Webportal. Nativer Token-Login und Gerätesitzungen für den eigenständig versionierten Android-/iOS-Client folgen in einem eigenen Sicherheitsblock.
