# Grabenplaner Serverbetrieb

Der HTTPS-Serverbetrieb ist für eine zentrale, von der Firmen-IT verwaltete Grabenplaner-Instanz vorgesehen. Die Node.js-Anwendung läuft ausschließlich auf `127.0.0.1`; Browser greifen nur über Caddy und eine freigegebene HTTPS-Adresse darauf zu. Lokalbetrieb und LAN-Host bleiben davon unabhängig.

Unterstützt werden **Ubuntu 24.04 LTS und Ubuntu 26.04 LTS auf x86-64**; für neue Beta-Server wird Ubuntu 26.04 LTS empfohlen. Die vorhandenen Windows-Werkzeuge bleiben unterstützt. Auf beiden Plattformen gelten dieselben Sicherheitsgrenzen: eine lokale SQLite-Datenbank, genau eine aktive Grabenplaner-Instanz, Caddy als einziger öffentlicher Zugang sowie getrennte Programm-, Daten-, Schlüssel- und Backupbereiche.

Die bereitgestellten Werkzeuge ersetzen nicht die betriebliche Prüfung von Domain, DNS, Firewall, Zertifikat, Dienstkonten, Virenscanner, Backupziel und Wiederanlaufplan durch die verantwortliche IT.

## Zielaufbau unter Ubuntu 24.04/26.04 LTS

- Programmdateien: `/opt/grabenplaner/app`
- Datenbank, Branding und verschlüsselte Dokumente: `/var/lib/grabenplaner`
- geschützte Dienstkonfiguration: `/etc/grabenplaner/grabenplaner.env`
- Protokolle: systemd-Journal sowie `/var/log/grabenplaner/app` und `/var/log/grabenplaner/caddy`
- lokale Sicherungspunkte: `/var/backups/grabenplaner`
- optionaler Offsite-Status: `/var/lib/grabenplaner-offsite/status.json`; private Arbeitsdaten des Moduls liegen ebenfalls im gesonderten, root-verwalteten Modulpfad
- signierte Recovery-Assurance-Historie: `/var/lib/grabenplaner-assurance`; nur `root` schreibt, die Anwendung liest ausschließlich den redigierten Status
- redigierter Monitorstatus: `/var/lib/grabenplaner-monitor/status.json`; nur `root` schreibt, der App-Dienst besitzt ausschließlich Lesezugriff
- optionaler, redigierter Host-Sicherheitsstatus: `/var/lib/grabenplaner-host-security/status.json`; Transaktionsdaten bleiben davon getrennt root-only
- Anwendung: `127.0.0.1:3000`
- öffentlicher Zugang: ausschließlich Caddy auf Port 443

Die Anwendung läuft als eigener, nicht interaktiv anmeldbarer Benutzer `grabenplaner`. Caddy bleibt davon getrennt und erhält keinen Zugriff auf SQLite, Branding, Schlüssel oder AUM-Dokumente. `systemd` ersetzt WinSW, UFW ersetzt die Windows-Firewallverwaltung und ClamAV übernimmt die lokale Prüfung hochgeladener Dokumente. Der Normalbetrieb verwendet `grabenplaner.service` und den von Ubuntu bereitgestellten `caddy.service`.

Die SQLite-Datenbank muss auf einem lokalen Linux-Dateisystem liegen. Netzlaufwerke, FUSE-Cloudmounts und synchronisierte Ordner sind als aktiver Datenbankpfad nicht zulässig.

### Voraussetzungen unter Ubuntu

- Ubuntu 24.04 oder 26.04 LTS x86-64 mit allen Sicherheitsaktualisierungen
- Node.js gemäß `engines.node` in `package.json` und die dort festgeschriebene pnpm-Version
- Caddy, systemd, UFW, ClamAV und `unzip`
- für das optionale Offsite-Modul: von der IT bereitgestellte Restic-/rclone-Binaries samt geprüfter SHA-256-Prüfsummen, ein eigener Google-OAuth-Client mit `drive.file` und ein getrenntes Google-Drive-Ziel
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
  --package /pfad/Grabenplaner-Server-v0.80.4-beta-linux-x64.zip \
  --sha256 '<veröffentlichter SHA256-Wert>' \
  --public-url https://beta.example.at \
  --replace-caddy-config
```

Der Linux-Installer ist für einen dedizierten Grabenplaner-Server vorgesehen. Findet er ein nicht von Grabenplaner verwaltetes Caddyfile, bricht er ohne `--replace-caddy-config` ab. Mit dieser ausdrücklichen Option sichert er die bestehende Datei root-only unter `/etc/grabenplaner/caddy-backup/` und ersetzt sie erst danach. Eine gemeinsam mit anderen Anwendungen verwaltete Caddy-Konfiguration muss die IT außerhalb des Installers integrieren und prüfen.

Eine neue Installation erzeugt keine voreingestellten Zugangsdaten. Sie startet zunächst `grabenplaner-bootstrap.service` ausschließlich auf Loopback und gibt eine einmalige, nur für `root` lesbare Bootstrap-Adresse aus. Die erste Administration wird über einen SSH-Tunnel angelegt:

```bash
ssh -L 3000:127.0.0.1:3000 admin@server.example.at
```

Danach wird im lokalen Browser die vom Installer ausgegebene Adresse im Format `http://127.0.0.1:3000/?bootstrap=<einmaliger-token>` geöffnet. Nach dem Anlegen des eigenen Teammitglieds und des Admin-Zugangs schließt folgender Befehl die Ersteinrichtung ab:

```bash
sudo grabenplaner-bootstrap-admin finish
```

Der Abschluss gilt erst als erfolgreich, wenn ein erster gekoppelter Datenbank-/Dokument-Sicherungspunkt erstellt wurde, die interne Ready-Prüfung grün ist, Caddy läuft, die öffentliche HTTPS-Ready-Prüfung erfolgreich war und der Bootstrap-Token atomar verbraucht wurde. Scheitert ein Schritt, bleibt Caddy ausgeschaltet und das Werkzeug kehrt in den lokalen Bootstrapmodus zurück. Der Bootstrap-Port darf niemals durch UFW oder eine Provider-/Cloud-Firewall öffentlich freigegeben werden.

### Servervariablen unter Ubuntu

Die vollständige neutrale Linux-Vorlage liegt in `server-tools/linux/grabenplaner.env.example`. Der Installer rendert sie nach `/etc/grabenplaner/grabenplaner.env`, setzt `root:root` und Modus `0600` und erzeugt alle Schlüssel und Tokens lokal. Der Dienst erhält die Werte über systemd, kann die Datei selbst aber nicht lesen. Für Ubuntu werden insbesondere lokale Linux-Pfade verwendet:

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
GRABENPLANER_BOOTSTRAP_TOKEN=<einmaliger, nach erfolgreichem Abschluss geleerter Token>
```

Schlüssel und Tokens gehören weder in SQLite noch in das Programmverzeichnis, ein Image, ein Git-Repository oder ein Serverpaket.

### Betrieb und Wartung unter Ubuntu

Die Installation stellt absichtlich kleine, mit `sudo` auszuführende Wartungsbefehle bereit:

```bash
sudo grabenplaner-backup
sudo grabenplaner-test
sudo grabenplaner-monitor
sudo grabenplaner-stop
sudo grabenplaner-update --package /pfad/neues-paket.zip --sha256 '<SHA256>'
sudo grabenplaner-uninstall --yes
```

- `grabenplaner-backup` erstellt und prüft einen gekoppelten Sicherungspunkt aus SQLite-Datenbank und verschlüsselter Dokumentablage.
- `grabenplaner-test` prüft Dienste, interne und öffentliche Erreichbarkeit, TLS, Caddy, Datenbankintegrität und Sicherungsalter.
- `grabenplaner-monitor` führt dieselbe freigegebene Betriebsprüfung für den systemd-Timer aus und veröffentlicht nur fest definierte Prüfergebnisse ohne URLs, Pfade oder Antwortinhalte.
- `grabenplaner-stop` beendet die Anwendung kontrolliert und prüft, dass der interne Listener geschlossen ist.
- `grabenplaner-update` lädt nichts selbst herunter. Es akzeptiert nur ein lokales Linux-Serverpaket samt SHA-256, sichert vor dem Austausch und rollt bei fehlgeschlagener Bereitschaftsprüfung automatisch zurück.
- `grabenplaner-uninstall --yes` entfernt App-Code, eigene systemd-Units und Befehlslinks. Daten, Schlüsselkonfiguration, Logs und Backups bleiben erhalten; Caddy selbst wird nicht deinstalliert und eine zuvor gesicherte, gültige Konfiguration wird wiederhergestellt.

`grabenplaner-monitor.timer` startet die Prüfung alle fünf Minuten. Ausschließlich drei aufeinanderfolgende Fehler des internen Live-Endpunkts dürfen `grabenplaner.service` einmalig neu starten; zwischen zwei solchen Versuchen liegen mindestens 30 Minuten. Fehler von Ready, HTTPS, Sicherungen, Offsite-Ziel, Speicherplatz oder Virenscanner erzeugen nur einen Wartungsalarm und niemals einen automatischen Neustart. Der Monitorstatus ist kein Bestandteil des Ready-Endpunkts und kann deshalb keine Rückkopplung erzeugen.

### Ubuntu-Host absichern

Das Linux-Paket enthält ein eigenständiges Host-Sicherheitsmodul. Die normale Grabenplaner-Installation aktiviert es nicht und verändert weder SSH noch UFW. Auch der Modulinstaller führt zunächst nur einen täglichen, lesenden Audit ein:

```bash
sudo bash server-tools/linux/hardening/install-grabenplaner-host-hardening.sh
sudo grabenplaner-host-security audit
```

Ein App-Update ersetzt ein bereits unter `/opt/grabenplaner-hardening/module` installiertes Sicherheitsmodul absichtlich nicht. Weicht dessen kryptografischer Vertragsfingerprint vom neuen Paket ab, ist deshalb folgende explizite Modulwartung erforderlich; ein noch ausstehender oder bestaetigter Hostzustand wird dabei niemals mit einem neuen Controller weiterverwendet. Modulversion 1 bleibt als Paketbruecke erhalten, waehrend Vertragsfingerprint und exakte Dateiliste jeden konkreten Modulstand eindeutig binden:

```bash
# Nur falls eine Transaktion noch aussteht oder bestaetigt aktiv ist:
sudo grabenplaner-host-security rollback --transaction 64HEX

# Beide Befehle muessen ohne Ausgabe erfolgreich sein:
sudo test ! -e /var/lib/grabenplaner-host-security/pending-transaction
sudo test ! -e /var/lib/grabenplaner-host-security/active-transaction

sudo grabenplaner-host-security-uninstall
sudo bash server-tools/linux/hardening/install-grabenplaner-host-hardening.sh
sudo grabenplaner-host-security audit
```

Erst danach wird eine neue Host-Sicherheitstransaktion mit `plan` und `apply` begonnen. Die ausgegebene Transaktionskennung wird ausschliesslich aus einer neu geoeffneten zweiten SSH-Sitzung mit `confirm --transaction 64HEX` bestaetigt. Modulordner, Vertragsbeleg oder Transaktionsdateien duerfen nicht manuell geloescht oder zwischen Modulstaenden kopiert werden.

Das Modul lädt keine Programme aus dem Internet. `openssh-server`, `ufw` und `unattended-upgrades` müssen deshalb zuvor aus den freigegebenen Ubuntu-Paketquellen installiert und geprüft sein. Der Audit kontrolliert unter anderem Schlüssel-SSH, Firewall, öffentliche Ports, automatische Sicherheitsaktualisierungen, Kernel-Schutzwerte, Journalbegrenzung, Dienstkonten, Geheimnisdateien, fehlgeschlagene Units und Zeitsynchronisierung. Seine Statusdatei enthält ausschließlich fest definierte Wahrheitswerte und Zeitangaben; IP-Adressen, Benutzernamen, Ports, Pfade und Diagnosefreitext werden nicht an die Anwendung weitergegeben.

Vor einer Aktivierung wird aus einer bestehenden Schlüssel-SSH-Sitzung ein folgenloser Plan geprüft. `USER`, `PORT` und `CIDR` sind durch den tatsächlichen nicht privilegierten Sudo-Admin, den bereits verwendeten SSH-Port und einen möglichst engen administrativen Quellbereich zu ersetzen:

```bash
sudo grabenplaner-host-security plan \
  --admin USER \
  --ssh-port PORT \
  --source CIDR
```

Der Plan bricht ab, wenn die aktuelle SSH-Sitzung nicht zum Admin, Port und Quellbereich passt, kein sicherer `authorized_keys`-Zugang nachweisbar ist, Sudo-Rechte fehlen, `sshd -t` beziehungsweise die sitzungsbezogene effektive SSH-Konfiguration fehlschlagen oder UFW die vorgesehenen Regeln nicht akzeptiert.

Die tatsächliche Aktivierung bleibt ein bewusster Root-Vorgang im angekündigten Wartungsfenster:

```bash
sudo grabenplaner-host-security apply \
  --admin USER \
  --ssh-port PORT \
  --source CIDR
```

Für dieses Wartungsfenster gilt eine klare Betriebsgrenze: Nur der verantwortliche, vertrauenswürdige Root-Administrator arbeitet an der Hostkonfiguration. SSH-, UFW-, APT-, sysctl- und Journald-Dateien dürfen bis zum Abschluss von Bestätigung oder Rollback nicht parallel durch andere Root-Prozesse geändert werden. Das Modul prüft seine Zielzustände unmittelbar vor atomaren Ersetzungen und bricht bei Fremddrift ab; gegen ein bereits kompromittiertes Root-Konto kann es den Host selbst nicht absichern.

Vor der ersten Änderung werden die verwalteten Hostdateien samt Prüfsummen gesichert und ein persistenter Zehn-Minuten-Rollback aktiviert. UFW erhält zuerst die eingeschränkte Freigabe für den bereits verwendeten SSH-Port, danach die öffentlichen Caddy-Ports 80 und 443. Eingehende und weitergeleitete Verbindungen sind standardmäßig gesperrt, ausgehende Verbindungen erlaubt; die Firewall wird nicht zurückgesetzt. Das Modul ergänzt und entfernt im normalen Ablauf ausschließlich seine eigenen Regeln und löscht fremde Regeln nicht gezielt. Erkennt der Rollback nachträgliche Änderungen an der gesicherten UFW-Konfiguration, verweigert er die automatische Wiederherstellung, statt diese Änderungen zu überschreiben. Port 3000 bleibt intern und darf weder in UFW noch in der Provider-/Cloud-Firewall freigegeben werden.

Die erste SSH-Sitzung bleibt geöffnet. Erst nach erfolgreichem `apply` wird eine **neue zweite Schlüssel-SSH-Sitzung** geöffnet. In dieser zweiten Sitzung wird die ausgegebene 64-stellige Transaktionskennung bestätigt:

```bash
sudo grabenplaner-host-security confirm --transaction 64HEX
```

Nur eine nach der Änderung geöffnete, ebenfalls zur freigegebenen Quelle passende und technisch eigenständige SSH-Verbindung darf bestätigen. Öffne sie ohne SSH-Multiplexing, beispielsweise mit `ssh -o ControlMaster=no -o ControlPath=none ...`; ein zusätzlicher Kanal derselben TCP-Verbindung wird serverseitig abgewiesen. Ohne Bestätigung setzt der Sicherheitstimer die verwalteten SSH-, UFW-, APT-, sysctl- und Journald-Werte automatisch zurück. Ein bestätigter Stand kann später weiterhin bewusst mit `rollback --transaction 64HEX` zurückgenommen werden; erst danach darf das Modul deinstalliert werden.

Das SSH-Profil deaktiviert Root- und Passwortanmeldung, behält aber lokales TCP-Forwarding für den geschützten Bootstrap-Tunnel. Ubuntu-Sicherheitsaktualisierungen werden automatisch installiert, ein Serverneustart jedoch niemals automatisch ausgelöst. `/run/reboot-required` erscheint stattdessen als Wartungshinweis. Journald bleibt persistent, komprimiert und mengen- sowie zeitlich begrenzt. Die Kernelwerte vermeiden bewusst Eingriffe in IPv6, Routing oder Cloud-Netzwerkfunktionen.

Die erstmalige Aktivierung auf dem realen Zielsystem, die Provider-/Cloud-Firewall, DNS, Caddy-Zertifikat und ein echter Rücksetztest gehören zum anschließenden Go-live-Block und werden nicht auf dem Entwicklungs-PC simuliert.

Das Deployment-Schema der Linux-Laufzeit wurde für v0.74 von 1 auf 2 angehoben. Ein bestehender v0.73-Server darf daher nicht mit einem stillen In-place-Update auf v0.74 wechseln: `grabenplaner-update` beendet den Vorgang mit `migration-required`. Die verantwortliche IT verwendet im Wartungsfenster ausschließlich das im geprüften v0.74-Linux-Paket enthaltene root-only Werkzeug `server-tools/linux/migrate-grabenplaner-runtime-v2.sh`. Aufruf, Sicherheitsprüfungen und Fehlerbehandlung sind in [`server-tools/linux/RUNTIME-MIGRATIONS.md`](server-tools/linux/RUNTIME-MIGRATIONS.md) beschrieben; ein erneuter Admin-Bootstrap ist weder nötig noch zulässig.

Die lokalen Sicherungspunkte schützen vor fehlerhaften Updates und ermöglichen einen kontrollierten Wiederanlauf. Das folgende optionale Modul ergänzt sie um eine räumlich getrennte, verschlüsselte Kopie; es ersetzt die lokalen Sicherungen nicht.

### Verschlüsseltes Offsite-Backup mit Restic/rclone

Das Offsite-Modul ist Bestandteil des neutralen Ubuntu-Serverpakets, bleibt nach der normalen Serverinstallation aber vollständig inaktiv. Es wird ausschließlich durch eine bewusste Root-Einrichtung aktiviert. Der Grabenplaner-Dienst benötigt keinen Zugriff auf Google-Zugangsdaten oder das Restic-Passwort.

Der Datenfluss ist fest getrennt:

1. `grabenplaner-backup` erstellt unter `/var/backups/grabenplaner` einen vollständigen, gekoppelten Sicherungspunkt aus SQLite-Datenbank, verschlüsselter Dokumentablage und Abschlussmanifest.
2. Das Offsite-Modul prüft diesen Sicherungspunkt erneut und übernimmt ausschließlich das vollständige Tripel in den privaten Staging-Bereich `/var/lib/grabenplaner-offsite/staging/current`.
3. Restic verschlüsselt den Staging-Inhalt und überträgt das Repository über rclone zu Google Drive.
4. Die Live-Datenbank unter `/var/lib/grabenplaner` wird weder direkt durch Restic gelesen noch auf ein Cloud-, FUSE- oder Netzlaufwerk verschoben.

#### Google Drive und Recovery vorbereiten

Für das Backup ist ein separates Google-Konto oder ein eigener, ausschließlich für Grabenplaner freigegebener Drive-Bereich zu verwenden. In der [Google Cloud Console](https://console.cloud.google.com/) wird dafür ein eigener OAuth-Client angelegt; der gemeinsam verwendete rclone-Standardclient ist nicht zulässig. Bei der [rclone-Einrichtung für Google Drive](https://rclone.org/drive/) muss außerdem der enge OAuth-Umfang `drive.file` gesetzt sein. Fehlende explizite Client-ID/Client-Secret, andere Backendtypen oder andere Drive-Umfänge weist das Modul zurück. Technisch lässt sich damit der gemeinsam genutzte rclone-Standardclient ausschließen; die organisatorische Eigentümerschaft des explizit eingetragenen OAuth-Clients muss die verantwortliche IT zusätzlich direkt in der Google Cloud Console bestätigen und dokumentieren. Die rclone-Konfiguration wird auf einem geschützten Administrationsgerät erstellt, mit einem eigenen Konfigurationspasswort verschlüsselt und anschließend als Datei bereitgestellt. Die Einrichtung speichert keine Zugangsdaten in SQLite oder im App-Verzeichnis.

Vor der Aktivierung muss ein getrenntes Offline-Recovery-Set angelegt und probeweise gelesen werden. Es umfasst mindestens:

- das Restic-Passwort;
- die verschlüsselte rclone-Konfiguration und ihr Konfigurationspasswort;
- die zur Anmeldung beziehungsweise Wiederherstellung des separaten Google-Kontos nötigen Informationen;
- die Grabenplaner-Schlüssel aus der geschützten Dienstkonfiguration, insbesondere den Schlüssel der verschlüsselten Dokumentablage;
- die öffentliche Repository- und Installationskennung sowie eine kurze Wiederherstellungsanleitung;
- die vollständige signierte Recovery-Assurance-Historie samt signiertem Kopf, öffentlichem Prüfschlüssel und privatem Fortsetzungsschlüssel;
- die geprüften Binary-Pins und den installierten Offsite-Modulvertrag.

Dieses Recovery-Set darf nicht im Restic-Repository, im Release-ZIP, in SQLite oder ausschließlich auf demselben VPS liegen.

Nach der Offsite-Einrichtung kann die IT den vollständigen root-only Zwischenstand erzeugen und vor beziehungsweise nach der Übertragung prüfen:

```bash
sudo grabenplaner-offsite-recovery-set export \
  --output /root/grabenplaner-recovery-set-DATUM --yes
sudo grabenplaner-offsite-recovery-set verify \
  --input /root/grabenplaner-recovery-set-DATUM
```

Der Exportordner ist noch kein dauerhaft sicher abgelegtes Recovery-Set. Er enthält bewusst auch die vollständige signierte Historie und deren privaten Fortsetzungsschlüssel. Er muss daher unmittelbar stark verschlüsselt auf ein getrenntes Administrationsgerät übertragen, dort erneut geprüft und anschließend vom Server gelöscht werden. Google-Kontowiederherstellung, zuständige IT-Kontakte und der betriebliche Zugriff auf das Administrationsgerät werden bewusst außerhalb des automatischen Exports dokumentiert.

#### Gepinnte Werkzeuge installieren und Modul aktivieren

Restic und rclone werden nicht automatisch aus dem Internet geladen und nicht im Grabenplaner-Paket gebündelt. Die verantwortliche IT lädt freigegebene Versionen aus den offiziellen [Restic-Releases](https://github.com/restic/restic/releases) beziehungsweise [rclone-Downloads](https://rclone.org/downloads/), prüft die Hersteller-Prüfsummen beziehungsweise Signaturen und übergibt dem Installer zusätzlich die konkret erwartete SHA-256-Prüfsumme. Der Installer übernimmt nur reguläre Root-Dateien, deren Hash exakt übereinstimmt.

Die folgenden Dateien werden vor dem Aufruf root-only gespeichert und mit Modus `0600` geschützt:

- Restic-Passwort;
- rclone-Konfiguration;
- rclone-Konfigurationspasswort.

Eine erstmalige, ausdrücklich gewünschte Initialisierung sieht beispielsweise so aus:

```bash
sudo server-tools/linux/offsite/install-grabenplaner-offsite.sh \
  --restic /root/grabenplaner-setup/restic \
  --restic-sha256 '<64-stelliger-SHA256-Wert>' \
  --rclone /root/grabenplaner-setup/rclone \
  --rclone-sha256 '<64-stelliger-SHA256-Wert>' \
  --restic-password /root/grabenplaner-setup/restic-password \
  --rclone-config /root/grabenplaner-setup/rclone.conf \
  --rclone-config-password /root/grabenplaner-setup/rclone-config-password \
  --repository 'rclone:gpdrive:grabenplaner/<stabile-installationskennung>' \
  --initialize-repository
```

`--initialize-repository` darf nur für ein neues, dafür bestimmtes und leeres Ziel verwendet werden. Bei einer Neuinstallation des Servers oder bei einer Wiederanbindung an ein vorhandenes Repository wird die Option weggelassen. Ein Authentifizierungs-, Netzwerk- oder Passwortfehler darf niemals durch eine automatische Neuinitialisierung übergangen werden.

Die Installation legt die gepinnten Binaries unter `/opt/grabenplaner-offsite/bin`, die Root-Konfiguration unter `/etc/grabenplaner/offsite` und den privaten Betriebszustand unter `/var/lib/grabenplaner-offsite` ab. Repository-Adresse, Zugangsdaten und interne Dateipfade werden nicht in die Browserdiagnose übernommen.

Der eingerichtete Zustand wird mit folgendem Befehl geprüft:

```bash
sudo grabenplaner-offsite-test
```

#### Recovery Assurance und System-Center v0.78

Das Recovery-Assurance-Fundament zeichnet jeden vollständigen Prüfablauf in einer Ed25519-signierten, über SHA-256 verketteten Historie auf. Nur `root` darf neue Ereignisse schreiben; der private Signaturschlüssel bleibt root-only. Öffentlicher Prüfschlüssel, Historie und signierter Kopf sind für den App-Dienst ausschließlich lesbar. Die Anwendung prüft die gesamte Kette und gibt nur einen redigierten Status ohne Geheimnisse, interne Pfade oder vollständige Snapshot-Kennung aus.

Ein erfolgreich signierter Volltest gilt höchstens 100 Tage als aktueller Recovery-Nachweis. Danach bleiben Historie und Signaturen weiterhin prüfbar, der Vertrauensindex wertet Volltest, Test-Restore und Anwendungsprüfung jedoch als unbekannt statt weiterhin grün. Die Frist deckt den quartalsweisen Restore-Test mit einer kleinen Betriebsreserve ab.

Ein beaufsichtigter vollständiger Lauf wird bewusst gestartet mit:

```bash
sudo grabenplaner-offsite-assurance --trigger manual-cli
```

Der Lauf prüft OAuth-Richtlinie, neuen Sicherungspunkt und Upload, vollständige Repository-Lesbarkeit, die isolierte Datenwiederherstellung sowie den Start der installierten Anwendung mit einer isolierten Kopie der wiederhergestellten Daten. Der App-Smoke-Test läuft getrennt vom Live-System unter dem unprivilegierten Offsite-Dienstkonto, ausschließlich auf Loopback, ohne externen Netzwerkzugang und mit eigener temporärer Datenbank sowie Datenablage. Live-Daten, produktive Schlüssel und öffentliche Ports bleiben unzugänglich. Erfolg und Fehler werden als `application-smoke-passed` beziehungsweise `application-smoke-failed` signiert; ein fehlgeschlagener Teil erzeugt einen festen Fehlercode und niemals einen fälschlich erfolgreichen Gesamtstatus.

Eine neue, vollständig vorbereitete rclone-Konfiguration kann transaktional angebunden werden. Der Befehl prüft vor dem Austausch insbesondere den eigenen OAuth-Client, `drive.file`, Repository-Identität und Testzugriff; bei einem Fehler bleibt die bisherige Konfiguration aktiv:

```bash
sudo grabenplaner-offsite-rebind-rclone \
  --rclone-config /root/geschuetzt/rclone.conf \
  --rclone-config-password /root/geschuetzt/rclone-config-password \
  --yes
```

Nach einer erfolgreich abgeschlossenen OAuth-Neuanbindung und nach einem erfolgreichen App-Update wird automatisch ein neuer Assurance-Lauf über systemd in die Warteschlange gestellt. Zusätzlich startet `grabenplaner-offsite-assurance.timer` täglich die feste Instanz `grabenplaner-offsite-assurance@scheduled-nightly.service`. Der persistente Timer holt einen verpassten Lauf nach und verteilt den Start über eine zufällige Verzögerung. Eine globale Assurance-Sperre sowie die bestehenden Wartungssperren verhindern Parallelbetrieb mit Update, Upload oder Wiederherstellung.

Die nächtliche Ausführung bedeutet keine automatische produktive Wiederherstellung. Sie arbeitet nur im isolierten Testbereich, besitzt harte Zeitgrenzen und entfernt temporäre Laufdaten auch nach einem Fehler. Eine echte Rücksicherung in den Live-Pfad bleibt weiterhin ein ausdrücklich beaufsichtigter Root-Vorgang.

Das System-Center liest ausschließlich redigierte Diagnosen und die vollständig verifizierte Signaturkette. Sein technischer Vertrauensindex bewertet acht fest definierte Bereiche mit transparenter Punktegewichtung und Evidenzabdeckung. Unbekannte Prüfungen erhalten keine Punkte; kritische Befunde und unzureichende Nachweise begrenzen den Gesamtwert. Der Index ist weder eine Verfügbarkeitsgarantie noch eine statistische Ausfallwahrscheinlichkeit.

#### Pilot und Abnahme ab v0.84

Der Produktreife-Bereich im System-Center verbindet den vorhandenen technischen Status mit nachvollziehbaren Desktop-, Mobilbrowser-, Bedienungs- und Performanceprüfungen. Security und Recovery können dort nicht manuell grün geschaltet werden, sondern werden ausschließlich aus den aktuellen System-Center- und Recovery-Assurance-Nachweisen abgeleitet.

Eine betriebliche Freigabe erfordert sechs bestandene Gates sowie eine getrennte technische und fachliche Abnahme. Beide Entscheidungen gelten nur für die konkrete App-Version und den SHA-256-Fingerabdruck des angezeigten Prüfstands. Ein neuer Nachweis oder ein geänderter technischer Status macht bestehende Abnahmen unaktuell. Die vollständige Checkliste und die ausdrücklich begrenzte Aussagekraft stehen in [Pilot und Abnahme](docs/PILOT-UND-ABNAHME.md).

Zusätzlich speichert die Anwendung eine begrenzte technische Messreihe für Vertrauensindex, Datenbankgröße sowie Sicherungs- und Wiederherstellungsdauer. Die Darstellung enthält keine Personal-, Empfänger-, Pfad- oder Zugangsdaten. Fehlgeschlagene oder überfällige Recovery-Nachweise erzeugen deduplizierte interne Warnungen für IT-Admin und Developer; der Status zeigt ausschließlich Anzahl und Zeitpunkt, niemals Empfängeridentitäten.

Ein manueller Lauf aus der Weboberfläche erfordert neben technischer Diagnoseberechtigung das gesonderte kritische Recht `system:recovery:run`. Dieses Recht gehört standardmäßig nur IT-Admin und Developer; ein Admin kann es ausdrücklich erhalten. Die Node.js-Anwendung besitzt weder `sudo`- noch Shell-Rechte. Sie übermittelt stattdessen eine fest formatierte lokale Anfrage über einen root-eigenen Unix-Socket. Der kurzlebige systemd-Broker akzeptiert ausschließlich die freigegebene Startaktion, prüft Socketrechte, Schema, Parallelbetrieb und eine root-seitige Sperrfrist und startet nur die feste Assurance-Unit. Browserwerte können weder Unitnamen noch Pfade, Befehle oder Auslöser bestimmen.

Vor der betrieblichen Freigabe werden einmalig ein Upload, die vollständige Datenprüfung und danach der isolierte Restore-Test ausgeführt. Die Befehle warten jeweils auf den Abschluss und müssen ohne Fehler enden:

```bash
sudo systemctl start grabenplaner-offsite-upload.service
sudo grabenplaner-offsite-test
sudo systemctl start grabenplaner-offsite-check.service
sudo systemctl start grabenplaner-offsite-restore-test.service
sudo grabenplaner-offsite-test
```

Timer und technische Protokolle kontrolliert die IT beispielsweise mit `systemctl list-timers 'grabenplaner-offsite-*'` und `journalctl -u grabenplaner-offsite-upload.service`. Protokolle dürfen nicht zusammen mit Geheimdateien oder einer unredigierten rclone-Konfiguration weitergegeben werden.

Eine bewusste Deaktivierung und Entfernung des Moduls erfolgt getrennt vom Grabenplaner-Kern:

```bash
sudo grabenplaner-offsite-uninstall --yes
```

Der Offsite-Uninstaller löscht keine lokalen Grabenplaner-Nutzdaten und kein entferntes Restic-Repository. Die geschützte Repository-Konfiguration, Zugangsdaten und vorhandene Stagingdaten bleiben für eine kontrollierte Wiederanbindung beziehungsweise Wiederherstellung erhalten. Recovery-Geheimnisse und das entfernte Repository werden ausschließlich nach dem freigegebenen betrieblichen Löschkonzept behandelt.

#### Zeitplan, Aufbewahrung und Prüfungen

Die systemd-Dienste verwenden einen gemeinsamen Wartungs- und Repository-Lock. Es findet keine automatische Restic-Entsperrung statt.

| Aufgabe | systemd-Einheit | Standardzeit |
|---|---|---|
| verifizierten Sicherungspunkt vorbereiten | `grabenplaner-offsite-prepare.service` | durch Upload oder Vorab-Update ausgelöst |
| verschlüsselt hochladen und Aufbewahrung anwenden | `grabenplaner-offsite-upload.timer` | täglich etwa 02:35 Uhr, mit zufälliger Verzögerung |
| Repository vollständig lesen und prüfen | `grabenplaner-offsite-check.timer` | monatlich am 1. etwa 04:15 Uhr, mit zufälliger Verzögerung |
| isolierte Testwiederherstellung | `grabenplaner-offsite-restore-test.timer` | quartalsweise am 2. Januar, April, Juli und Oktober etwa 05:15 Uhr, mit zufälliger Verzögerung |
| vollständiger Recovery-Assurance-Lauf samt App-Smoke | `grabenplaner-offsite-assurance.timer` | täglich, persistent und mit zufälliger Verzögerung |

Die feste Restic-Aufbewahrung beträgt **14 tägliche, 8 wöchentliche und 12 monatliche Sicherungsstände**. Upload, Vollprüfung und Restore-Test sind getrennte Dienste. Ein fehlgeschlagener Upload löst keine Aufräumaktion aus. Prüffehler werden nicht automatisch repariert; vor einem manuellen `unlock`, `forget`, `prune` oder einer Wiederherstellung muss ausgeschlossen sein, dass noch ein anderer Vorgang läuft.

Der monatliche Vollcheck liest die Repository-Daten vollständig und kann abhängig von Datenmenge und Verbindung längere Zeit dauern. Der quartalsweise Restore-Test wählt den neuesten exakt gebundenen Snapshot, stellt ihn in einen isolierten, anschließend schreibgeschützten Bereich unter `/var/lib/grabenplaner-offsite` wieder her und prüft Repository-/Installationsbindung, Hashes, SQLite, Dokumentmanifest und Recovery-Schlüssel. Er verändert keine produktiven Daten. Der tägliche Assurance-Lauf ergänzt diese Datenprüfung um einen nebenwirkungsfreien, zeitlich begrenzten App-Smoke-Test in einem eigenen temporären Bereich.

#### Updates und Statusdiagnose

Ist das Offsite-Modul eingerichtet, erstellt `grabenplaner-update` zunächst bei kurz gestopptem Dienst einen verifizierten lokalen Sicherungspunkt. Anschließend wird die bisherige App wieder gestartet und bleibt während der unter Umständen längeren Google-Drive-Übertragung erreichbar. Erst wenn diese Offsite-Kopie bestätigt ist, stoppt der Updater den Dienst erneut, erstellt unmittelbar vor dem App-Tausch einen zweiten aktuellen lokalen Rollback-Sicherungspunkt und ersetzt die Programmdateien. Ist Google Drive nicht erreichbar oder scheitert die Repository-Prüfung, wird der Austausch nicht begonnen; die bisherige App bleibt beziehungsweise wird wieder in Betrieb genommen.

Mit v0.86 steigt der eigenständige Offsite-Modulvertrag auf Version 5. Ein bereits eingerichtetes Modul der Versionen 1 bis 4 wird nicht still durch das Kernupdate verändert: `grabenplaner-update` beendet den Vorgang andernfalls mit `migration-required`. Das alte Modul wird für diesen Übergang **nicht deinstalliert**.

Im beaufsichtigten Wartungsfenster wird zuerst das neue Linux-Paket vollständig verifiziert und getrennt entpackt. Danach wird dessen v5-`install-grabenplaner-offsite.sh` gegen die noch laufende bisherige App ausgeführt. Verwendet werden dieselben geprüften Restic-/rclone-Binaries, Geheimdateien, Repository-Adresse und Installationskennungen wie bisher; `--initialize-repository` darf bei dieser Migration keinesfalls gesetzt werden. Der Installer verifiziert den bestehenden Vertrag der Versionen 1 bis 4, pausiert die betroffenen Timer, migriert Modul und systemd-Units transaktional und stellt bei einem Fehler den vorherigen Zustand wieder her.

Erst wenn `sudo grabenplaner-offsite-test` und der ausgelöste vollständige Assurance-Lauf einschließlich App-Smoke erfolgreich abgeschlossen sind, wird das Kernupdate gestartet. Der Updater findet dann bereits Modulversion 5 vor und darf fortfahren. Repository, Repository-ID, Installations-ID, Geheimdateien, lokales Staging und vorhandene Sicherungsstände bleiben dabei erhalten. Version 5 übernimmt den bisherigen Assurance-Vertrag und ergänzt für die nächtliche Sicherung einen begrenzten Wartepfad auf den Wartungslock.

Der neutrale Status liegt unter `/var/lib/grabenplaner-offsite/status.json`. `grabenplaner-test` und die berechtigte Serverdiagnose zeigen daraus insbesondere:

- ob das Modul eingerichtet ist;
- Zeitpunkt und Ergebnis des letzten Uploads;
- Zeitpunkt und Ergebnis der letzten vollständigen Prüfung;
- Zeitpunkt und Ergebnis des letzten Restore-Tests;
- das Alter dieser Betriebsbelege sowie einen neutralen Fehlercode.

Die Hauptanwendung bleibt bei einem vorübergehenden Offsite-Fehler erreichbar. Der Fehler ist dennoch ein Wartungsalarm und muss behoben werden, bevor Updates oder der sichere Wiederanlauf als vollständig abgesichert gelten.

#### Wiederherstellung und Schutzgrenze

Eine echte Wiederherstellung wird nie direkt in den Live-Pfad gestartet und ist nicht über den Browser möglich. Nach Einrichtung des Offsite-Moduls steht der Root-Befehl `grabenplaner-recovery` bereit. Die IT verwendet stets eine vollständige Snapshot-ID und eine selbst erzeugte, noch nicht verwendete 64-stellige Recovery-ID:

```bash
sudo grabenplaner-recovery list
sudo grabenplaner-recovery prepare --snapshot '<64_HEX>' --recovery-id '<64_HEX>'
sudo grabenplaner-recovery verify  --snapshot '<64_HEX>' --recovery-id '<64_HEX>'
sudo systemctl stop caddy.service grabenplaner.service
sudo grabenplaner-recovery apply \
  --snapshot '<64_HEX>' --recovery-id '<64_HEX>' \
  --confirm-snapshot '<64_HEX>' --confirm-recovery '<64_HEX>'
```

Es gibt absichtlich kein implizites `latest` für eine produktive Wiederherstellung. `prepare` bindet Repository, Installation, Host, Tag, Quellpfad und exakten Snapshot, prüft freien Speicher und friert den geladenen Baum root-only ein. `verify` kontrolliert den unveränderten Stand erneut, einschließlich Manifest, Hashes, SQLite-Integrität sowie Entschlüsselbarkeit der geschützten Dokumente und Integrationsdaten. `apply` verlangt zwei identische Bestätigungen, aktive Wartungs- und Repository-Sperren sowie vollständig beendete App- und Caddy-Dienste. Vor dem Austausch entsteht ein dauerhafter, root-only Vorab-Sicherheitsbeleg; der bisherige Live-Stand bleibt zusätzlich unter der Recovery-ID erhalten.

Nach `apply` werden weder Grabenplaner noch Caddy automatisch gestartet. Die IT prüft zuerst die Belege und Daten lokal, startet anschließend bewusst `grabenplaner.service`, führt `sudo grabenplaner-test` aus und gibt erst danach mit `caddy.service` den öffentlichen Zugriff wieder frei. Der quartalsweise Restore-Test ersetzt diese ausdrückliche Freigabe nicht.

Google Drive ist ein räumlich getrenntes und durch Restic verschlüsseltes Backupziel, aber **kein WORM- oder Object-Lock-Speicher**. Netzwerkzugriffe des Moduls laufen unter einem eigenen, nicht interaktiven Benutzer und über einen fest installierten rclone-Wrapper. Für die Aufbewahrung benötigt das hinterlegte Drive-Credential dennoch Schreib- und Löschzugriff. Ein Angreifer mit vollständiger Root-Kontrolle über den VPS könnte rclone außerhalb dieses Ablaufs verwenden und entfernte Sicherungen löschen. Für Schutz gegen dieses Szenario ist ein getrennt administriertes Backup-Gateway oder ein technisch unveränderliches Ziel mit eigener Berechtigungsgrenze erforderlich.

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
$package = 'C:\IT-Freigabe\Grabenplaner-Server-v0.80.4-beta-windows-x64.zip'
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
