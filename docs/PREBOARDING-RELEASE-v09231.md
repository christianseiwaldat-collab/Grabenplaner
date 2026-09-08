# VPS-Veröffentlichung v0.92.31-beta

Datum: 8. September 2026. Status: v0.92.31-beta installiert und vom Updater
bestätigt. Vollständige Wiederherstellungsprüfung und beide regulären
Betriebsprüfungen bestanden. Abschlusszustand um 16:10:12 UTC bestätigt.

## Umfang und Herkunft

Persönlich zugewiesene Bewerber- und Preboarding-Bewertungen erhalten auch in
einem bereits geöffneten Mitarbeiterportal einen sichtbaren Einstieg. Der
Abruf beim Sichtbarwerden und im vorhandenen 45-Sekunden-Takt unterbricht keine
laufende Eingabe. Bei einem Versionskonflikt bleiben Sterne und Kommentare für
dieselbe Bewertung erhalten; erneutes Absenden bleibt eine bewusste Aktion.

Die vollständige fachliche und mobile Prüfung ist im
[Prüfbericht](PREBOARDING-MOBILPRUEFUNG-2026-09-08.md) dokumentiert. Standort 11
bleibt ohne Leihfreigabe. Der Release ändert weder Serverlogik noch Schema,
Speicherstruktur, Importdaten, Mail-Ereignisse oder Zugangsregeln.

- Quellcommit: `09f00ff40a7982e945a770c59b611f0ba45f9f13`.
- Zweig: `feature/schedule-pdf-day-separators`, committed und gepusht.
- Paket: `Grabenplaner-Server-v0.92.31-beta-linux-x64.zip`, 3.632.526 Bytes.
- SHA-256: `5e9b4851fb1d99f7391893c79601f32f844e472b6b7ccf904dd50b48c96c70d0`.
- Alle 518 Manifestdateien wurden unabhängig mit ZIP-Pfaden, Größen und
  Prüfsummen verglichen. Gegenüber v0.92.30 ändern sich ausschließlich sechs
  Paketdateien: `package.json`, `README.md`, `public/portal.js`,
  `public/portal.html`, `public/portal.css` und `public/candidate-evaluation.js`.
- Der abschließende fokussierte Release-Lauf bestand mit 57 Tests. Die
  tatsächlichen API- und mobilen Browserabläufe wurden zuvor isoliert mit
  synthetischen Personen und Bewerbungen geprüft.

## Vorprüfung

Die lesende VPS-Vorprüfung endete am 8. September um 13:18:21 UTC erfolgreich.
Installiert war v0.92.30-beta mit Quellcommit
`ad5f353c53dbe9df3f15e06d241b2ea9ebf05fc7`. App, Caddy und Monitor-Timer waren
aktiv und aktiviert; interne und öffentliche Live-/Ready-Endpunkte lieferten
jeweils HTTP 200. Port 3000 war ausschließlich an `127.0.0.1` gebunden.

SQLite `integrity_check=ok`, keine Fremdschlüsselfehler. Das Personalmodul war
aktiviert. Prüfbestand: 30.503 Kundenkarten, zwei Bewerber und zwei Bewerbungen,
eine Kassenveröffentlichung und 11.059 Verknüpfungen. Kompakte Kassenzeilen:
39.865 / 219.920 / 0 / 0 / 89.584 / 346.921 / 385.877. Leihfreigabe weiterhin
ausschließlich für Standort 18. Mail-Ereignisse unverändert:
`branch_order,destination_verification,loan_document,password_reset,staff_assignment_request`.

Der Offsite-Status war `ok`; für Backup, vollständige Repository-Prüfung und
Wiederherstellung bestanden keine offenen Fehler. Der gespeicherte historische
Fehlereintrag `RESTORE_TEST_FAILED` wurde davon getrennt betrachtet. Die 23
bereits vorliegenden fehlgeschlagenen Units wurden nicht zurückgesetzt. Freier
VPS-Speicher: 61.427.904.512 Bytes, etwa 61,43 GB.

## Veröffentlichungsablauf

Upload in den ausschließlich für diesen Release verwendeten Ordner
`/tmp/grabenplaner-deploy-v09231-09f00ff`: Realpfad, Eigentümer, Dateitypen,
exakter Inhalt, Größe und SHA wurden geprüft. Der Ordner hat 0700, ZIP und
Prüfsummendatei jeweils 0600.

Der Monitor-Timer wurde um 13:23:13 UTC ausschließlich zur Update-Koordination
pausiert. Der bereits laufende Monitor durfte regulär enden; der Wrapper
sicherte die Wiederherstellung des Timers per EXIT-Trap. Der unveränderte transaktionale
Updater begann um 13:23:15 UTC mit `--health-timeout 1500`. Nach ZIP-,
Abhängigkeits- und Virenprüfung begann der kontrollierte App-Stopp um
13:29:01 UTC.

Die erste Abschlusssicherung endete erfolgreich; um 13:46:51 UTC war die App
`inactive/dead`, `Result=success`, `ExecMainStatus=0`. Um 13:46:55 UTC begann
der zusätzliche gekoppelte VPS-Sicherungspunkt. Sein Abschlussbeleg ist auf
13:49:17.760 UTC datiert. Nach Archivierung und Beginn der Aufbewahrungsprüfung
wurde der ohnehin folgende Start der bisherigen App um 13:57:46 UTC
vorgezogen. Dazu wurden der exakte erste Sicherungspunkt, sein Archivbeleg,
die aktuelle Prozesskette einschließlich Updater/Paket, die neue
Aufbewahrungssperre, installierte Version und vier Helper-Prüfsummen geprüft.
Um 14:03:35 UTC war die bisherige App öffentlich wieder bereit: HTTP 200.
Diese Vorziehung betrifft ausschließlich die erste Sicherungsphase. Offsite-
Übertragung und der unmittelbar vor dem Austausch nochmals erzeugte aktuelle
Sicherungspunkt bleiben unverändert erforderlich.

Der erste VPS-Sicherungspunkt war um 14:13:40 UTC vollständig fertig
(26 Minuten 45 Sekunden). Der Updater begann um 14:13:42 UTC die
Offsite-Vorbereitung. Die zwischenzeitlich gestartete automatische App-Sicherung
wartete am gemeinsamen Sicherungsarbeitsbereich. Wegen ihres gemeinsamen
Zeitbudgets für Warten und Ausführen wurde ein zusätzlicher Wiederanlauf geprüft.
Dessen Schutzprüfung stoppte jedoch vor jeder Änderung: Der wartende Prozess
war bereits beendet, die Sicherung arbeitete inzwischen an den Daten. Es wurde
deshalb kein zusätzlicher Dienststopp oder Neustart ausgeführt.

Die App-Startsicherung wurde um 14:25:09.291 UTC erfolgreich abgeschlossen,
etwa 22 Minuten 13 Sekunden nach ihrem Prozessstart und innerhalb des
23-Minuten-20-Sekunden-Gesamtbudgets. Archivoperationssperre und offene
Archivtransaktion waren anschließend beide abwesend. Eine Archiv-Reparatur war
nicht nötig. Der öffentliche Bereitschaftstest lieferte um 14:26:29 UTC HTTP 200.
Die vorgezogene Wiederaufnahme verkürzte die erste Unterbrechung, ließ für die
Startsicherung aber nur begrenzte Zeitreserve. Eine solche Vorziehung darf
deshalb nicht ohne Prüfung der verbleibenden Sicherungszeit wiederholt werden.

Die exakte Offsite-Vorbereitung war um 14:27:17 UTC fertig. Um 14:31:19 UTC
bestätigte der Updater Sicherung, Repository-Prüfung und die unveränderte
Aufbewahrung 14/8/12 auf Google Drive. Danach begann um 14:31:19 UTC der zweite
kontrollierte App-Stopp für den aktuellen Rückfallsicherungspunkt unmittelbar
vor dem Programmaustausch. In dieser abschließenden Sicherungs-/Austauschphase
wurde kein manueller Wiederanlauf vorgenommen.

Der zweite App-Stopp endete um 14:48:18.811 UTC erfolgreich, nach rund
17 Minuten. `Result=success`, `ExecMainStatus=0` und `inactive/dead` wurden
unabhängig bestätigt. Um 14:48:35 UTC begann der aktuelle gekoppelte externe
Rückfallsicherungspunkt unmittelbar vor dem Programmaustausch.

Dieser Sicherungspunkt wurde um 15:11:17 UTC bestätigt, nach 22 Minuten
42 Sekunden. Die neue App wurde um 15:11:22 UTC gestartet. Um 15:13:14.759 UTC
wurden v0.92.31-beta, der erwartete Quellcommit und der neue laufende
App-Prozess unabhängig aus der Installation nachgelesen.

Der Updater bestätigte nach erfolgreichen internen und öffentlichen
Bereitschaftsprüfungen den Release mit `status=success` um 15:15:33.830 UTC.
Beleg: `/var/lib/grabenplaner/maintenance/history/update-2026-09-08T15-15-33-486734730.json`.
Version, Paket-Hash und letzter Rückfallsicherungspunkt stimmen. Der Updater
endete mit Exitcode 0. Der Monitor-Timer wurde um 15:15:40 UTC wieder gestartet;
`active/waiting` und `enabled` wurden um 15:16:04 UTC unabhängig bestätigt.

Der eigene Uploadordner wurde nach erneuter Prüfung von Realpfad, Typen,
Eigentümer, Rechten, exakten Einzeldateien, Größe und SHA entfernt. Gelöscht
wurden ausschließlich die eigene ZIP-Datei, ihre SHA-Datei und der anschließend
leere Ordner. Seine Abwesenheit wurde bestätigt.

## Automatische Wiederherstellungsprüfung

Der Updater startete genau einen automatischen Lauf
`grabenplaner-offsite-assurance@app-updated.service`. Ein zusätzlicher
vollständiger Assurance-Lauf wurde nicht ausgelöst. Beim kontrollierten App-Stopp
für diesen Lauf trat um 15:15:49 UTC erneut der bekannte Abbruch der bereits
gestarteten Hintergrundsicherung auf: `BACKGROUND_BACKUP_FAILED` und
`BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED`. Der App-Prozess endete mit
Exitcode 1. Die bestehende Unit verwendet `KillMode=control-group`; der Befund
entspricht dem bereits beim vorigen Release beobachteten Ablauf.

Um 15:17:16 UTC waren im App-Archiv weder eine offene Archivtransaktion noch
eine Archivoperationssperre vorhanden. Es wurde kein Reparatur- oder
Entsperrbefehl ausgeführt. Die automatische Vorbereitung lief weiter;
ihr gekoppelter Sicherungspunkt begann um 15:16:06 UTC und war um 15:28:48 UTC
fertig. Die exakte Offsite-Vorbereitung endete um 15:29:15 UTC. Die reguläre
Bereinigung dieses Ablaufs startete die App anschließend wieder; sie war seit
15:29:16 UTC aktiv. `active/running` und `Result=success` wurden um 15:30:08 UTC
bestätigt. Der zuvor fehlerhafte Dienstzustand wurde durch den tatsächlichen
Wiederanlauf abgelöst. Ein `reset-failed` wurde nicht ausgeführt. Ein ausschließlich
lesender Beobachter erfasste den isolierten App-Startnachweis dieses
Laufs, bevor dieser regulär bereinigt wurde.

Um 15:35:22 UTC meldeten interne und öffentliche Bereitschaft wieder
`ok=true`; um 15:35:53 UTC wurde öffentlich HTTP 200 bestätigt. Die neue
Startsicherung der App wurde um 15:49:03.754 UTC erfolgreich abgeschlossen:
`dienstplan-2026-09-08T15-34-36-379Z-ad67f2b10ab8.db`. Damit liegt eine neue
erfolgreiche App-Sicherung nach dem zuvor fehlerhaften Dienststopp vor. Der
isolierte App-Start lieferte einen tatsächlich erfassten Beleg mit
`ok=true`, `live=true`, `ready=true`, `reason=null`.

Der installierte Historienhelfer verifizierte anschließend die Signaturkette
mit 1.065 Ereignissen. Der genau einmal gestartete Lauf
`27581967-8d96-4be9-bfeb-baf853e18628` für v0.92.31-beta endete am
8. September 2026 um 15:56:59.879 UTC mit `full-assurance-passed`.
OAuth-Richtlinie, Backup, vollständige Repository-Prüfung, tatsächliche
Wiederherstellung und isolierter App-Start haben positive signierte Einzelbelege.
Snapshot: `1c2870ea800b`; Wiederherstellungsbeleg SHA-256:
`d2065754cf4d0d251500474401cc1e8c1276e7be9f5e5010827debd5d2c5d0f6`.
Assurance- und App-Smoke-Unit endeten mit `Result=success`, `ExecMainStatus=0`.

## Lesende Produktions- und Betriebsprüfung

Die Produktionsprüfung nach dem erfolgreichen Gesamtlauf bestand:

- Installierte Version und Quellcommit stimmen. Serverdatei und sieben
  ausgelieferte App-/Portaldateien stimmen mit den Manifest-Hashes überein,
  einschließlich Bewertungs-JavaScript und Portal-CSS.
- App, Caddy und Monitor-Timer aktiv und aktiviert; App und Caddy ohne
  automatische Neustarts. Listener ausschließlich `127.0.0.1:3000`.
- Interne und öffentliche Live-/Ready-Endpunkte jeweils HTTP 200.
- SQLite `integrity_check=ok`; keine Fremdschlüsselfehler.
- Personalmodul aktiviert; zwei Bewerber und zwei Bewerbungen.
- `loans:self:use` in den drei geprüften Standardrollen vorhanden;
  Leihfreigabe weiterhin ausschließlich für Standort 18.
- 30.503 Kundenkarten; Kassenzeilen, Veröffentlichung und Verknüpfungen
  entsprechen vollständig dem Vorprüfbestand. Datenbank: 2.653.720.576 Bytes.
- Mail-Ereignisse unverändert; keine Testmail versandt.
- Freier VPS-Speicher: 60.605.685.760 Bytes, etwa 60,61 GB.

Die regulären CLI-Betriebsprüfungen liefen nacheinander, mit aktivem
Monitor-Timer:

- `grabenplaner-test`: 16:03:49 bis 16:08:36 UTC, Exitcode 0. Dienste,
  Erreichbarkeit, HTTPS und Sicherheitsheader, Zertifikat, SQLite `quick_check`,
  Sicherungsaktualität, DB-/Dokumentkopplung, Virenscanner, Caddy-Konfiguration
  und Offsite-Selbsttest bestanden. Auch der Monitor-Timer bestand unmittelbar
  in diesem Lauf; eine Nachprüfung wegen eines pausierten Timers war nicht nötig.
- `grabenplaner-offsite-test`: 16:08:36 bis 16:08:57 UTC, Exitcode 0.
  Modul- und Binärintegrität, Providerbindung, verschlüsselte Konfiguration,
  Kontentrennung, Timer, Steuerungssockets, signierte Historie, Statusschema,
  Repository-Erreichbarkeit und isolierter App-Testbetrieb bestanden.

Der abschließende Zustandsabgleich endete um 16:10:12 UTC mit Exitcode 0.
App, Caddy und Monitor-Timer sind aktiv und aktiviert; App und Caddy ohne
automatische Neustarts. Die aktuelle Assurance-Unit ist erfolgreich beendet.
Alle vier internen und öffentlichen Live-/Ready-Prüfungen liefern HTTP 200.
Der exakte Uploadordner ist weiterhin abwesend. Freier VPS-Speicher:
60.605.636.608 Bytes, etwa 60,61 GB. Die bereits bestandene vollständige
Integritäts- und Fremdschlüsselprüfung wurde nicht nochmals wiederholt.

Der Offsite-Status ist `ok`; für Backup, vollständige Repository-Prüfung und
Wiederherstellung stehen alle `unresolvedFailures` auf `false`. Das gespeicherte
Feld `lastError=RESTORE_TEST_FAILED` bleibt als historischer Eintrag erhalten;
der neue positive signierte Gesamtlauf wird davon getrennt ausgewiesen.
Der exakte Abgleich der fehlgeschlagenen Units mit der Vorprüfung ergab dieselben
23 historischen Einträge, keine hinzugefügten oder entfernten Units. Historische
Fehler wurden nicht zurückgesetzt oder durch Bearbeiten von Statusdateien gelöscht.

## Bekannter Betriebsbedarf

Der bestehende Sicherungsablauf und seine langen Laufzeiten bleiben unverändert.
Die beim vorangegangenen Release belegten Einschränkungen sind im
[Betriebsnachweis v0.92.30](MOBILPORTAL-RELEASE-v09230.md) beschrieben: das
30-Minuten-Zeitlimit der separaten nächtlichen Prepare-Unit und das Abbrechen
laufender Hintergrundsicherungen beim Dienststopp bleiben Verbesserungsbedarf.
Der erfolgreiche automatische Gesamtlauf ruft das Vorbereitungsskript direkt
auf und unterliegt nicht dem kürzeren Zeitlimit dieser separaten Unit. Dieser
Release hat einen eigenen positiven Wiederherstellungsnachweis; der frühere
Gesamtlauf wurde nicht als Ersatz verwendet.

Lokale Arbeitsbelege: `tmp/v09231-release-tests.log`,
`tmp/v09231-package-verification.json`, `tmp/v09231-preflight.log`,
`tmp/v09231-upload-verification.log`, `tmp/v09231-deploy.log`,
`tmp/v09231-installed-receipt.log`, `tmp/v09231-stage-cleanup.log`,
`tmp/v09231-automatic-smoke-observer.log`, `tmp/v09231-verified-assurance.log`,
`tmp/v09231-postverify.log`, `tmp/v09231-operational-tests.log`,
`tmp/v09231-final-state.log` und `tmp/v09231-failed-unit-comparison.json`.
Der Abschlussnachweis ist eine reine Dokumentation auf demselben Releasezweig;
er verändert das bereits installierte Paket nicht.
