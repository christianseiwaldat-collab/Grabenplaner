# GP695: Nächtlicher Wiederherstellungstest vom 20.09.2026

## Ergebnis

Die zeitgesteuerte Automatik hat um 03:00 Uhr Europe/Vienna gestartet. Sicherung und vollständige Offsite-Repositoryprüfung waren erfolgreich. Die Wiederherstellung beider PostgreSQL-Datenbanken und die vorgelagerten Datenprüfungen wurden durchlaufen. Der Fehler trat erst bei der Initialisierung der isolierten Anwendung auf: `PERSISTENCE_TIMEOUT` um 04:21:56 Uhr. Die darüberliegende Steuerung meldete daraus `PG_RECOVERY_WORKER_FAILED`, anschließend `RESTORE_TEST_FAILED`.

Damit sind nicht zwei voneinander unabhängige Fehler von Restore und App-Start belegt. Der App-Start ist Bestandteil der vollständigen Restore-Prüfung; sein Fehlschlag verhindert auch den erfolgreichen Gesamtnachweis. Der HTTP-Listener, die Gesundheitsprüfung der isolierten Anwendung und der Berichtstest wurden nicht erreicht. Die Aussage, eine vollständig geprüfte Wiederherstellung sei erfolgreich, wäre deshalb ebenfalls falsch.

## Zeitlicher Nachweis

Alle Uhrzeiten in dieser Tabelle sind Europe/Vienna (UTC+02:00).

| Zeitpunkt | Ereignis |
| --- | --- |
| 03:00:00 | systemd startet `grabenplaner-offsite-assurance@scheduled-nightly.service`. |
| 03:01:34 | Signierter Lauf `0ba3dc2b-f808-4fb2-b035-ca41a89c53a6` beginnt. |
| 03:24:22 | `backup-passed`, Snapshotpräfix `9f4bc7f7bb44`. |
| 03:40:24 | `repository-check-passed`. |
| 03:48:16 | Privater PostgreSQL-Recovery-Dienst startet. |
| 03:49:16 | Fortschritt in `restore-core`. |
| 03:50:18–04:15:40 | Fortschritt in `restore-sales`; der Lauf arbeitet auch jenseits von 1500 Sekunden weiter. |
| 04:16:42–04:20:48 | Fortschritt in `verify-sales`. |
| 04:21:13 | Vorbereitung des isolierten Anwendungsstarts. |
| 04:21:24.219 | `initializing-application`. |
| 04:21:55.081 | `initialization-failed`, etwa 30,9 Sekunden nach Beginn der Initialisierung. |
| 04:21:56 | Workerjournal: `{"failed":true,"code":"PERSISTENCE_TIMEOUT","error":"PostgreSQL recovery failed"}`. |
| 04:22:12 | Gesamtlauf endet fehlgeschlagen, nach 1 Stunde 22 Minuten. |
| 04:22:14 | Zusätzlicher eigenständiger Restore-Timer überspringt seinen Lauf ausdrücklich, um den bereits ausgeführten Gesamttest nicht zu duplizieren. |

Der PostgreSQL-Testdienst hatte die Kennung `grabenplaner-pg-recovery-f189bddd-9c5d-4ff4-9a8c-ea9575c25661.service`. Sein Abschlussnachweis bestätigt `stopped: true` und `cleaned: true`. Der native Teil einschließlich App-Anlauf dauerte rund 33 Minuten 41 Sekunden.

Die Interpretation der abgeschlossenen Datenprüfungen stützt sich auch auf den installierten Kontrollfluss: `restorePair` erreicht den Callback für den App-Test erst nach Restore, Checkpointprüfung, Rollenprüfung und Prüfung geschützter Daten. Der installierte `paired-restore.js`-Hash entspricht dem lokal geprüften Code. Auch der tatsächlich installierte Recovery-Worker wurde gelesen; eine pauschale Gleichheit aller lokalen und installierten Dateien wird nicht vorausgesetzt.

## Ursache und verbleibende Grenze

Belegt ist eine Datenbank-Zeitüberschreitung während der Anwendungsinitialisierung. Das damalige Fehlerobjekt und sein Stacktrace werden vom installierten Stand nicht dauerhaft aufbewahrt. `PERSISTENCE_TIMEOUT` kann sowohl vom Provider-Verbindungstimer als auch von abgebrochenen beziehungsweise zu lange laufenden Datenbankabfragen stammen. Der Nachtlauf allein erlaubt deshalb keine sichere Zuordnung zu einem bestimmten Timer oder SQL-Statement.

Die installierte Anwendung ist weiterhin **0.92.61-beta**, Release-Manifest SHA-256 `e0304e2827187ced93565b2661d72ead95318be606c9303fe64618dc6d383960`. Die Korrektur `355bca2` und die zusätzliche Diagnose `acf4bb4` sind nicht installiert. Der installierte Core-/Sales-Verbindungsaufbau enthält weiterhin die Schemaqualifizierung innerhalb des begrenzten Verbindungserwerbs; die neue `prepareClient`-Trennung fehlt. Das wurde am tatsächlich installierten Code geprüft.

Der GP694-Befund ist daher ein konkreter, zum Nachtfehler passender Reparaturkandidat. Er ist noch kein Beweis, dass exakt dieser Mechanismus den Nachtlauf ausgelöst hat. Ebenso bleibt der ältere `IMPORT_REPORT_FAILED` ein gesonderter Vorfall; der Nachtlauf darf nicht nachträglich als dessen sichere Erklärung ausgegeben werden.

## Abgrenzung von Wartung und Ressourcen

- Kein OOM-, I/O-Fehler- oder Kernel-Blockierungsereignis im geprüften Nachtfenster gefunden. Das schließt Last- und Zeitlimitprobleme nicht aus. Der Recovery-Dienst erreichte laut systemd etwa 1,5 GiB Speicherspitze unter seiner vorhandenen Begrenzung.
- Die Paketwartung endete um 03:01:57, der Sicherheitscheck um 03:00:34, der Monitor um 03:01:25. Der Host-Cron-Sammellauf kam erst nach dem Assurance-Ende um 04:22:13 zum Zug. Kein Beleg für einen Wartungsabbruch des Recovery-Workers.
- Der produktive GP wurde um 03:02:58 kontrolliert für die lokale Sicherung gestoppt und um 03:17:50 wieder als Dienst gestartet; der Listener meldete Bereitschaft um 03:19:15. Dies entspricht dem gelesenen Sicherungsskript und liegt deutlich vor dem späteren isolierten App-Start. Die etwa 16-minütige nächtliche Unterbrechung ist ein eigener möglicher Optimierungspunkt, nicht der nachgewiesene Auslöser des Fehlers um 04:21 Uhr.
- Die abschließende Live-/Ready-Prüfung lieferte jeweils HTTP 200 und `ok: true`. Rund 72,75 GB sind frei; keine verbliebenen Recovery-Datenbankverzeichnisse. Der Fehlerstatus wurde nicht gelöscht oder auf Erfolg gesetzt.
- Die nächsten regulären Wartungstimer stehen auf 21.09.2026 um 03:00 Uhr. Keine Änderung an Zeitplan, Diensten, produktivem Code oder Daten in dieser Untersuchung.

## Fortsetzung

### Nachtrag: tatsächlich installierte Zeitlimits

Auf Nachfrage wurden die installierten Dateien erneut direkt gelesen. Die Initialisierung über `initializeApplicationPersistence()` hat im Recovery-App-Test keinen eigenen festen Minuten-Countdown. Der übergeordnete Aktivitätswächter meldet `PG_RECOVERY_STALLED` nach zehn Minuten ohne hinreichende CPU-/I/O-Aktivität oder Phasenfortschritt. Die private Recovery-Unit hat `RuntimeMaxSec=infinity`; die Assurance-Unit hat ebenfalls keine feste Laufzeitgrenze und einen systemd-Startzeitrahmen von 40 Stunden. Diese äußeren Grenzen haben den protokollierten `PERSISTENCE_TIMEOUT` nicht erzeugt.

Die tatsächlich wirksamen Core-/Sales-Einstellungen sind:

| Grenze | Wert | Bedeutung |
| --- | --- | --- |
| Verbindungserwerb | 5 Sekunden | Pool-/Verbindungsaufbau; im installierten Provider umfasst die vorgelagerte Poolfunktion auch die Schemaqualifizierung. |
| PostgreSQL-Statement | 10 Sekunden | Je einzelne SQL-Anweisung. |
| Treiber-Abfrage | 12 Sekunden | Je einzelne Abfrage im Node-Treiber. |
| Leerlauf einer offenen Transaktion | 30 Sekunden | `idle_in_transaction_session_timeout`; ausdrücklich keine maximale Gesamtdauer einer aktiv arbeitenden Transaktion und kein Limit für den gesamten App-Start. |

Die allgemeinen Policy-Standardwerte 30/32/60 Sekunden werden für Core/Sales ausdrücklich durch 10/12/30 Sekunden überschrieben. Die Werte sind im installierten JavaScript festgelegt; für diese Grenzen gibt es im geprüften Konfigurationsweg keinen Umgebungs- oder Einstellungsparameter. Eine Erhöhung über systemd würde diese inneren Grenzen nicht ändern; eine PostgreSQL-Servervorgabe ersetzt insbesondere den JavaScript-Verbindungstimer nicht.

Eine Änderung im installierten Code wäre ein Hotfix und damit trotzdem eine Codeaktualisierung, auch ohne vollständigen Releaseprozess. Für einen isolierten Diagnosekandidaten können die Grenzen getrennt vom produktiven GP variiert werden. Eine solche Variation muss ausdrücklich als Diagnose gelten und darf nicht einen unveränderten produktiven Stand als erfolgreich qualifiziert ausgeben. Bei dieser Auslese wurden keine Limits geändert.

Die vorrangige Untersuchung des Nachtlaufs ist damit abgeschlossen. Die angeforderte spätere automatische Fortsetzung ist als Thread-Automation `gp-fr-here-deploy-fehlerdiagnose-fortsetzen` eingerichtet. Sie soll die frühere Deploydiagnose einmalig fortsetzen, anschließend pausieren und weder einen Deploy noch eine Wiederholungsschleife auslösen.

Für den nächsten notwendigen vollständigen isolierten Test sind der korrigierte Kandidat, die zusätzliche Fehlerdiagnose und ein frischer Preflight zu verwenden. Vorher sicherstellen, dass Datenbank-Zeitüberschreitungen im Test ausreichend unterschieden werden können; eine erneute bloße Sammelmeldung wäre unzureichend. Keine identische Wiederholung des unveränderten 0.92.61-Laufs. Keine weiteren Windows-Tests, keine produktive Installation als Ersatz für einen isolierten Test.

Die alten Hilfsskripte zur Liveprüfung aus GP694 enthalten teilweise die damalige Prozesskennung. Sie dürfen nicht ungeprüft wiederverwendet werden: der geplante Sicherungsneustart hat die produktive Prozesskennung geändert. Jede Fortsetzung muss den aktuellen Zustand neu lesen.

## Belege

Im übergeordneten Aufgabenverzeichnis `output/deploy/gp695-nightly-analysis`:

- `nightly-initial.json`: signierter Verlauf, Dienststatus, Restore-Abschlussnachweise und Gesamtlaufjournal.
- `nightly-worker.log`: originaler technischer Fehlercode im isolierten Workerjournal.
- `nightly-cause-check.json`: installierter Stand, Kernelprüfung, Wartungszeiten und aktuelle Gesundheit.
- `reviewed-source.json`, `installed-code.json`: Hashvergleich und tatsächlich gelesene relevante Kontrollflüsse.

Diese Untersuchung war serverseitig ausschließlich lesend. Es wurde kein neuer Restore, kein App-Test und kein Deploy gestartet.
