# VPS-Veröffentlichung v0.92.30-beta

Datum: 8. September 2026. Status: v0.92.30-beta produktiv installiert und vom
Updater bestätigt. Vollständige Wiederherstellungsprüfung bestanden;
Betriebsprüfung einschließlich gezielter Monitor-Nachprüfung abgeschlossen.
Abschlusszustand um 09:47:07 UTC bestätigt. Standort 11 bleibt ohne Leihfreigabe.

## Releaseumfang und Herkunft

- Mobile Portal-, Dienstplanungs- und Menüverbesserungen sowie persönlich
  entziehbares Standardrecht für die Leihe. Fachliche und visuelle Prüfung:
  [Mobilportal-Prüfbericht](MOBILPORTAL-PRUEFUNG-2026-09-08.md).
- Standort 11 bleibt ohne Leihfreigabe. Keine Änderung an Standortfreigaben,
  Datenimporten oder Verkaufs-/Kundenbeständen.
- Release-Commit: `ad5f353c53dbe9df3f15e06d241b2ea9ebf05fc7` auf
  `feature/schedule-pdf-day-separators`, committed und gepusht.
- Paket: `Grabenplaner-Server-v0.92.30-beta-linux-x64.zip`, 3.631.368 Bytes.
- SHA-256: `1b0208383d5703490c54850f3a8d44dd76bc5c0add8c6e8d95abb370640b9234`.
- Alle 518 Manifestdateien unabhängig geprüft; Version, Quellcommit,
  neue Mobil-CSS und SHA nach dem VPS-Upload bestätigt. Der ausschließlich
  zum Paketbau angelegte saubere Checkout wurde danach entfernt.

## Vorprüfung und notwendiger Archivabgleich

Vor dem Update: v0.92.29-beta, Quellcommit
`5d4a7ab52b51ee1bda6f375ce1ad8b287e1a4641`. App und Caddy aktiv; vier interne
und öffentliche Live-/Ready-Prüfungen HTTP 200. SQLite `integrity_check=ok`,
keine Fremdschlüsselfehler. Etwa 60,5 GB freier VPS-Speicher.

Die nächtliche Sicherungsvorbereitung war bereits vor dem Release nach einem
Zeitlimit beendet worden. Ihr Archivvorgang hinterließ eine authentifizierte
Sperre und einen unvollständig abgeschlossenen Aufbewahrungsbeleg. Der Besitzer
PID 1773018 existierte nicht mehr; das Restic-Repository hatte keine aktive
native Sperre.

Der vorhandene Verwaltungshelfer löste ausschließlich diese nachgewiesen
verwaiste Sperre. Unter der regulären Wartungs- und Backup-Arbeitsbereichssperre
verifizierte `reconcile` den abgebrochenen Vorgang. Abschluss gegen 06:13:35 UTC:
`reconciled=true`, `removedRaw=0`, `removedArchives=0`. Die folgende
Archivinspektion war erfolgreich. Der GP blieb während dieses Abgleichs aktiv.

Prüfbestand vor dem Programmaustausch:

- Kundenkarten: 30.503.
- Kompakte Kassenzeilen: 39.865 / 219.920 / 0 / 0 / 89.584 / 346.921 / 385.877.
- Kassenveröffentlichungen: 1; Verknüpfungen: 11.059.
- Leihfreigaben: ausschließlich Standort 18.

## Veröffentlichung und Abschluss

Der erste Start um 06:14:29 UTC brach nach erfolgreicher Paketprüfung sicher
vor dem App-Stopp ab, weil der reguläre Monitor die Wartungssperre belegte.
Für den erneuten Start wurde ausschließlich der Monitor-Timer vorübergehend
angehalten; der bereits laufende Monitor durfte regulär fertig werden. Ein
EXIT-Trap stellt den Timer wieder her. Es wurde kein Prozess beendet und
keine Wartungssperre umgangen.

Der unveränderte transaktionale Updater begann um 06:24:24 UTC erneut mit dem
verifizierten Paket und `--health-timeout 1500`. Nach Paket-, Abhängigkeits-
und ClamAV-Prüfung begann der kontrollierte App-Stopp um 06:30:19 UTC.
Die bisherige App beendete sich nach ihrer Abschlusssicherung um 06:44:46 UTC.
Um 06:45:01 UTC begann der zusätzliche gekoppelte Rückfallsicherungspunkt auf dem VPS.
Sicherungs- und Rückfallprüfungen bleiben wirksam. Es wurden keine Netzwerk-,
Zugangs- oder Sicherheitskonfigurationen geändert.

Die lange Laufzeit liegt im vorhandenen Sicherungsablauf. Dieser enthält
mehrere vollständige Datenprüfungen und Wiederherstellungen für Archivierung
und Aufbewahrung. Während dieser lokalen Schritte ist die App beendet.
Eine Beschleunigung dieses Ablaufs ist nicht Teil der Mobilveröffentlichung.

Um 07:10:04 UTC wurde der ohnehin nächste Start der bisherigen v0.92.29
vorgezogen: Der exakte erste Rückfallsicherungspunkt hatte bereits einen
verifizierten Abschlussbeleg, sein laufender Prozess befand sich nachweislich
nur noch in der externen Archivaufbewahrung. Damit konnte die bisherige App
wieder anlaufen, während diese Prüfung unverändert weiterlief. Offsite-Upload
und der unmittelbar vor dem Austausch nochmals erzeugte aktuelle
Rückfallsicherungspunkt bleiben Teil des Updaters. Dieser vorgezogene Start
gilt ausschließlich für die erste Sicherungsphase vor dem Offsite-Upload.

Die erste zusätzliche VPS-Sicherung wurde um 07:12:36 UTC bestätigt (27 Minuten
35 Sekunden ab Beginn). Um 07:14:59 UTC bestätigte der Updater die interne
und öffentliche Bereitschaft der bisherigen App und begann die
Offsite-Vorbereitung. Eine eigene öffentliche Prüfung um 07:15:58 UTC
lieferte ebenfalls HTTP 200.

Eine weitere Wartezeit entstand durch die automatische App-Sicherung beim
Wiederanlauf. Die Offsite-Vorbereitung wartete anschließend am gemeinsamen
`dienstplan.db.backup-workspace.lock`; der Hintergrund-Backupworker arbeitete
währenddessen weiter. Die Wartungssperren wurden nicht umgangen.

Um 07:31:45 UTC war der exakte Sicherungspunkt zur Offsite-Übertragung
vorbereitet. Um 07:35:30 UTC bestätigte der Updater den Upload nach Google
Drive, die Repository-Prüfung und die unveränderte Aufbewahrung 14/8/12.
Der Status meldete `state=ok` und für Backup, vollständige Repository-Prüfung
und Wiederherstellung keine offenen Fehler. Das weiterhin gespeicherte
`lastError=PREPARE_FAILED` ist hier der historische Fehlereintrag.

Der zweite kontrollierte App-Stopp lief von 07:35:30 bis 07:51:25 UTC
(15 Minuten 55 Sekunden). Um 07:51:39 UTC begann der aktuelle gekoppelte
VPS-Rückfallsicherungspunkt unmittelbar vor dem Programmaustausch.

Die letzte VPS-Rückfallsicherung wurde um 08:16:02 UTC bestätigt (24 Minuten
23 Sekunden). Die neue App wurde um 08:16:07 UTC gestartet. Version
`0.92.30-beta` und Quellcommit `ad5f353c53dbe9df3f15e06d241b2ea9ebf05fc7`
wurden unabhängig am installierten Paket nachgelesen.

Der Updater bestätigte nach erfolgreichen internen und öffentlichen
Bereitschaftsprüfungen den Release mit `status=success` um 08:22:00.249 UTC.
Beleg: `/var/lib/grabenplaner/maintenance/history/update-2026-09-08T08-21-59-888049338.json`.
Der Beleg enthält den erwarteten Paket-Hash und den letzten geprüften
Sicherungspunkt. Der Updater endete mit
Exitcode 0. Der Monitor-Timer wurde um 08:22:06 UTC wieder eingeschaltet;
`active/waiting` und `enabled` wurden unabhängig bestätigt.

Der exakte Uploadordner `/tmp/grabenplaner-deploy-v09230-ad5f353` wurde nach
Prüfung von Realpfad, Typen, Eigentümer, Rechten, Einzeldateien und SHA entfernt.
Es wurden ausschließlich die eigene ZIP-Datei, ihre SHA-Datei und danach der
leere Ordner gelöscht; seine Abwesenheit wurde bestätigt. Die hochgeladenen
Dateien hatten 0664 innerhalb des ausschließlich für den Eigentümer
zugänglichen Ordners 0700. Eine zunächst strengere Prüfannahme stoppte vor jeder
Löschung und wurde nach Prüfung genau dieses beobachteten Zustands korrigiert.

## Automatische Wiederherstellungsprüfung

Der Updater startete genau einen automatischen Lauf
`grabenplaner-offsite-assurance@app-updated.service`. Ein zusätzlicher
vollständiger Prüflauf wurde nicht angefordert.

Bei dessen App-Stopp um 08:22:15 UTC brach die bereits laufende automatische
Hintergrundsicherung ab. Der Dienststopp meldete Exitcode 1 und
`BACKGROUND_BACKUP_FAILED` / `BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED`.
Die bestehende Unit verwendet `KillMode=control-group`; der zeitgleiche
Stopp der laufenden Sicherung ist mit einem SIGTERM an diese Prozessgruppe
vereinbar. Der konkrete Kindprozessfehler wurde nicht separat protokolliert.
Im App-Archiv lagen anschließend weder eine offene Archivtransaktion noch
eine Archivoperationssperre vor. Die Assurance-Vorbereitung lief weiter.

Die Prüfsicherung wurde um 08:49:58 UTC bestätigt und um 08:54:16 UTC für
die Offsite-Übertragung vorbereitet. Die reguläre Bereinigung der Vorbereitung
startete die App um 08:54:16 UTC wieder. Die öffentliche Bereitschaft war um
08:57:17 UTC bestätigt. Der vorherige Fehlerstatus des App-Dienstes wurde
durch diesen tatsächlichen erfolgreichen Wiederanlauf abgelöst; es wurde
kein `reset-failed` zur Bereinigung der Historie verwendet.

Die anschließende lesende Produktionsprüfung bestand:

- App und Caddy aktiv, aktiviert und ohne automatische Neustarts; Monitor-Timer
  aktiv und aktiviert. Listener ausschließlich `127.0.0.1:3000`.
- Interne und öffentliche Live-/Ready-Endpunkte jeweils HTTP 200.
- Installierte Version und Quellcommit stimmen. Serverdatei sowie ausgelieferte
  App-/Portaldateien und neue Mobil-CSS stimmen mit den Manifest-Hashes überein.
- `loans:self:use` ist in den drei geprüften Standardrollen employee,
  department_manager und manager vorhanden. Leihfreigabe unverändert nur für 18.
- Kunden-, Kassen-, Veröffentlichungs- und Verknüpfungszahlen entsprechen
  vollständig dem Vorprüfbestand. Datenbankdatei: 2.653.704.192 Bytes.
- Mail-Ereignisse unverändert: branch_order, destination_verification,
  loan_document, password_reset, staff_assignment_request. Keine Testmail versandt.
- Freier VPS-Speicher zum Prüfzeitpunkt: 56.356.847.616 Bytes, etwa 56,36 GB.

Die erneute Offsite-Sicherung des automatischen Prüflaufs wurde um 08:58:57 UTC
bestätigt; die vollständige Datenprüfung des Repositorys bestand um
09:02:24 UTC. Die anschließende Wiederherstellung wartete auf den gemeinsamen
Backup-Arbeitsbereich. Die Startsicherung der neuen App wurde um 09:19:07 UTC
erfolgreich abgeschlossen (22 Minuten 35 Sekunden innerhalb des Zeitlimits
von 25 Minuten). Damit ist auch eine neue erfolgreiche App-Sicherung nach dem
zuvor fehlerhaften Dienststopp belegt. Eine Archiv-Reparatur war dafür nicht
erforderlich. Anschließend begann das Laden der Wiederherstellungskopie.

Die tatsächliche Wiederherstellung des Snapshots `a023e4297a50` und der
isolierte App-Start waren erfolgreich. Ein ausschließlich lesender Beobachter
erfasste den neuen Startprüfbeleg vor dessen regulärer Bereinigung:
`ok=true`, `live=true`, `ready=true`, `reason=null`.

Der installierte Prüfhelfer verifizierte anschließend die Signaturkette der
Assurance-Historie. Der genau einmal gestartete Lauf
`d92d565a-6d6f-4215-8736-ca9beb791a82` für v0.92.30-beta endete am
8. September 2026 um 09:27:55.599 UTC mit `full-assurance-passed`.
OAuth-Richtlinie, Backup, vollständige Repository-Prüfung, Datenwiederherstellung
und isolierter App-Start haben positive signierte Einzelbelege. Der
Wiederherstellungsbeleg trägt SHA-256
`dc5e3640c1b8d9bbe50a8d67362cf9eb2d57f8d174f348ba43e360909349c43a`.
Die Assurance-Unit endete mit `Result=success`, `ExecMainStatus=0`.

Damit liegt für diesen Release und Snapshot ein aktueller positiver
Wiederherstellungsnachweis vor. Der frühere fehlgeschlagene Starttest wurde
nicht pauschal als behoben erklärt; der neue Erfolg ist tatsächlich gemessen.

## Betriebsprüfung und verbleibender Betriebsbedarf

Die regulären CLI-Prüfungen wurden nacheinander ausgeführt:

- `grabenplaner-test` endete um 09:41:05 UTC mit Exitcode 1. Sein einziger
  fehlgeschlagener Prüfpunkt war der zuvor zur Koordination pausierte
  Monitor-Timer. Dies war ein Fehler in der Vorbereitung dieses Prüflaufs.
  Alle übrigen Kriterien bestanden: Dienste, Erreichbarkeit, HTTPS und
  Sicherheitsheader, SQLite `quick_check`, Sicherungsaktualität, gekoppelte
  Backup-Daten und Dokumente, Virenscanner, Caddy und Offsite-Selbsttest.
- `grabenplaner-offsite-test` endete um 09:41:26 UTC mit Exitcode 0. Modul- und
  Binärintegrität, Providerbindung, Kontentrennung, Timer, Steuerungssockets,
  signierte Historie, Statusschema und Repository-Erreichbarkeit bestanden.
- Der Monitor-Timer war seit 09:32:11 UTC wieder aktiv. Die Abschlussroutine
  bestätigte die Wiederherstellung um 09:41:26 UTC. Der exakt zuvor
  fehlgeschlagene Prüfpunkt wurde um 09:46:53 UTC unabhängig nachgeprüft:
  `is-active` und `is-enabled` beide erfolgreich. Es wurde kein unveränderter
  vollständiger Datenbank- oder Sicherungslauf wiederholt. Der ursprüngliche
  CLI-Exitcode 1 bleibt im Nachweis erhalten.

Die abschließende lesende Zustandsprüfung endete um 09:47:07 UTC mit Exitcode 0:
App, Caddy und Monitor-Timer aktiv und aktiviert; keine automatischen Neustarts
von App oder Caddy. Die aktuelle Assurance-Unit ist regulär beendet mit
`Result=success`, `ExecMainStatus=0`. Alle vier internen und öffentlichen
Live-/Ready-Prüfungen liefern HTTP 200; die laufende Datenbank hat keine
Fremdschlüsselfehler. Der Uploadordner ist weiterhin entfernt. Freier
VPS-Speicher: 61.430.919.168 Bytes, etwa 61,43 GB.

Der Offsite-Status steht auf `ok`; für Backup, vollständige Repository-Prüfung
und Wiederherstellung sind alle `unresolvedFailures` auf `false`. Das Feld
`lastError` enthält weiterhin `RESTORE_TEST_FAILED`; dieser gespeicherte
Fehlereintrag wird getrennt vom aktuellen Status und dem positiven signierten
Gesamtlauf ausgewiesen. Er wurde nicht durch manuelles Bearbeiten entfernt.

Die Mobilveröffentlichung ändert den Sicherungsablauf nicht. Seine langen
Laufzeiten, das 30-Minuten-Limit der separaten nächtlichen Prepare-Unit und das
Abbrechen einer laufenden Hintergrundsicherung beim Dienststopp bleiben
technischer Verbesserungsbedarf. Der erfolgreiche automatische Gesamtlauf
ruft das Vorbereitungsskript direkt auf; er unterliegt nicht dem kürzeren
Zeitlimit dieser separaten Unit. Historische fehlgeschlagene Units wurden
nicht gelöscht oder pauschal zurückgesetzt.

Die Arbeitsbelege liegen lokal unter `tmp/`: `v09230-deploy-retry.log`,
`v09230-installed-receipt.log`, `v09230-postverify.log`,
`v09230-verified-assurance.log`, `v09230-automatic-smoke-observer.log`,
`v09230-operational-tests.log`, `v09230-final-state.log` und
`v09230-stage-cleanup.log`. Der Abschlussnachweis wird als reine Dokumentation
auf demselben Releasezweig gesichert; er verändert das installierte Paket nicht.
