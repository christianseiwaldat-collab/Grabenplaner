# VPS-Veröffentlichung v0.92.32-beta

Datum: 9. September 2026. Status: v0.92.32-beta installiert und vom Updater bestätigt; vollständige Recovery Assurance fehlgeschlagen. Der erfolgreiche Abschluss der Veröffentlichung mit der Korrektur v0.92.33-beta ist im [anschließenden Prüfbericht](TRADE-KASSA-RELEASE-v09233.md) dokumentiert.

## Umfang

Die sechs Optimierungsblöcke für Trade und Kassa führen vorbereitete Artikelsuchwerte, indexgestützte Standardlisten, persistente Bestandsnachweise und verschlüsselte Belegzusammenfassungen ein. Persönliche Berichtsaufträge werden in begrenzten Schritten am Server verarbeitet; Eigentümerschaft, aktuelle Rechte, Abbruch und Wiederanlauf werden serverseitig geprüft. Die bestehende Datenbank bleibt SQLite.

Enthalten sind außerdem die vorbereiteten Standardrechte je Rolle und Position, der garantierte Developer-Vollzugriff, kompaktere Einstellungen, die Navigation der Verkaufsanalysen, die Kassenhistorie bei der Belegsuche, die Korrektur des Wochenwechsels, präzisierte Host-Sicherheitsmeldungen und die optimierte Sicherungskoordination.

Fachliche Nachweise:

- [Trade/Kassa, Blöcke 1–3](TRADE-KASSA-OPTIMIERUNG-BLOECKE-1-3-2026-09-09.md).
- [Trade/Kassa, Blöcke 4–6](TRADE-KASSA-OPTIMIERUNG-BLOECKE-4-6-2026-09-09.md).
- [Rechte und Einstellungen](RECHTE-STANDARDS-EINSTELLUNGEN-2026-09-09.md).
- [Sicherungsablauf](BACKUP-ABLAUF-OPTIMIERUNG-2026-09-08.md).
- [Ubuntu-Wartungskonzept](UBUNTU-WARTUNGSKONZEPT-2026-09-08.md).

Die älteren Fachberichte beschreiben ihren jeweiligen lokalen Prüfstand. Dieses Dokument ergänzt den Veröffentlichungsnachweis. Ein erneuter Quelldatenimport, eine PostgreSQL-Aktivierung oder ein vollständiger Ubuntu-Neustart gehören nicht zu dieser Veröffentlichung.

## Lokale Prüfung

Der fokussierte Release-Lauf umfasst 315 Tests. Nach Anpassung zweier isolierter Shutdown-Fixtures an den Berichtsworker und der Versionsprüfung sind alle 309 ausführbaren Tests bestanden; sechs Prüfungen sind plattformbedingt übersprungen. Die drei betroffenen Testdateien wurden gemeinsam erneut ausgeführt: 16 bestanden, keine Fehler. Der Datenbank-Kopplungsaudit meldet keine unklassifizierten Zugriffe oder Phasengrenzverletzungen; das Inventar enthält 1.348 Statements.

Die separaten Prüfungen der Optimierungsblöcke bestanden zuvor mit 136 Tests. Die echten kleinen Restic-Prüfungen und die isolierte Linux-Prüfung der Wartungssperre sind im Sicherungsbericht dokumentiert. Browserprüfungen verwendeten synthetische Benutzer und Daten. Diese Ergebnisse sind keine produktive Zeitmessung.

## Vorprüfung und Sicherungszustand

Die lesende Vorprüfung um 06:03 UTC bestätigte v0.92.31-beta mit Quelle `09f00ff40a7982e945a770c59b611f0ba45f9f13`, aktive App und Caddy, vier interne/öffentliche HTTP-200-Antworten, Listener ausschließlich auf `127.0.0.1:3000`, SQLite-Integrität und keine Fremdschlüsselfehler. Kundenkarten, kompakte Kassenbestände, Veröffentlichung und Verknüpfungen stimmen mit dem vorherigen Release überein. Leihfreigaben und Mail-Ereignisse sind unverändert.

Die nächtliche Offsite-Vorbereitung war zuvor am 30-Minuten-Limit abgebrochen. Die App wurde dabei wieder gestartet; ihre anschließende Startsicherung erreichte ebenfalls das bisherige Zeitlimit. In beiden lokalen Archiven blieben signierte Sperren und Aufbewahrungstransaktionen zurück. Beide Besitzerprozesse sind beendet; es bestehen keine Restic-Sperren. Ein exakt identifizierter leerer Offsite-Arbeitsordner blieb zurück.

Vor dem App-Tausch werden die vorhandenen Verwaltungsfunktionen zur Freigabe der nachweislich verwaisten Sperren und zur vollständigen Transaktionsprüfung verwendet. Diese Prüfung löscht weder Sicherungspunkte noch Rohsicherungen. Der normale Updater muss danach seinen aktuellen Sicherungspunkt und die Offsite-Bestätigung erfolgreich abschließen. Der gespeicherte Fehlerstatus wird nicht manuell zurückgesetzt. Vollständige automatische Recovery Assurance und beide regulären Betriebsprüfungen bleiben erforderlich.

Die Verwaltungsprüfung beider Archive endete am 9. September um 06:19:56 UTC erfolgreich. Je Archiv sind drei Sicherungspunkte registriert. Beide Prüfbelege bestätigen `removedRaw=0` und `removedArchives=0`. Der nachweislich leere, genau identifizierte Arbeitsordner wurde unter Wartungs- und Repository-Sperre entfernt; die anschließende Staging-Prüfung bestätigte einen leeren Arbeitsbereich. Der Monitor-Timer wurde wieder aktiviert.

Eine erneute lesende Vorprüfung endete um 06:25:24 UTC mit unveränderten Datenbeständen, Integrität und Zugangsbedingungen. Die 23 bereits fehlgeschlagenen Units wurden als Vergleichsbasis gespeichert. Rund 51,50 GB sind auf dem VPS frei. Der offene historische Backup-Fehler muss durch die frische Offsite-Bestätigung des regulären Updaters behoben werden; es gab keinen manuellen Status-Reset.

## Paket und Veröffentlichungsauftrag

- Quelle: `a5d2a8ad2476e2b3b0865da0cbc458c3fcbaa430`, auf `feature/schedule-pdf-day-separators` committed und gepusht.
- Paket: `Grabenplaner-Server-v0.92.32-beta-linux-x64.zip`, 3.674.723 Bytes.
- SHA-256: `2b917dc593d20e4392d1ea593df08bd9ca5ea3b40b9f77afa4dba113f8c1ecd0`.
- Alle 534 Manifestdateien unabhängig nach Pfad, Größe, Prüfsumme und Quellinhalt geprüft; 66 geänderte Laufzeitdateien liegen vollständig im Commit-Umfang. Unveränderte Paketdateien behalten ihre bisherigen Bytes; reine lokale Zeilenendenunterschiede wurden vor dem Paketbau abgeglichen.
- Upload: `/tmp/grabenplaner-deploy-v09232-a5d2a8a`, ausschließlich ZIP und Prüfsummendatei. Realpfad, Eigentümer, reguläre Dateien, exakter Inhalt und Prüfsumme bestätigt; Ordner 0700, Dateien 0600.
- Normaler Updater mit `--health-timeout 1500`; Monitor-Timer zur Koordination pausiert, mit Wiederaktivierung im EXIT-Trap. Der bereits laufende Monitor endete regulär um 06:26:37 UTC.

Der erfolgreiche Updater-Beleg ist unten dokumentiert. Er ersetzt nicht den vollständigen Wiederherstellungsnachweis.

## Ablauf

Die Virenprüfung endete erfolgreich. Beim kontrollierten Stopp um 06:32:50 UTC meldete der alte App-Prozess noch seine im Speicher verbliebene Fehlermarkierung der nächtlichen Startsicherung (`BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED`) und beendete sich mit Status 1. Die zuvor geprüften Archivdateien waren bereits konsistent. Der reguläre Updater erzeugte deshalb wie vorgesehen seinen eigenen frischen gekoppelten Sicherungspunkt.

Dieser erste Sicherungspunkt, `dienstplan-2026-09-09T06-33-11-217008179-27b06167e48c`, wurde um 06:57:11 UTC vollständig abgeschlossen, einschließlich Archivierung und Aufbewahrungsprüfung. Dauer: 24 Minuten. Der bisherige App-Dienst startete danach regulär und bestand um 07:02:43 UTC die internen und öffentlichen Bereitschaftsprüfungen. Die Offsite-Vorbereitung verwendet genau diesen Sicherungspunkt und wartet während der zusätzlichen automatischen Startsicherung auf den gemeinsamen Sicherungsbereich.

Die zusätzliche Startsicherung endete um 07:23:55 UTC erfolgreich, innerhalb ihres Zeitlimits. Die Offsite-Vorbereitung endete um 07:24:50 UTC; externe Sicherung, Repository-Prüfung und Aufbewahrung 14/8/12 wurden um 07:28:11 UTC bestätigt. Danach beendete die alte App ihre normale Abschlusssicherung und stoppte um 07:45:00 UTC mit `Result=success` und Exit-Code 0.

Der zweite aktuelle Rollback-Punkt, `dienstplan-2026-09-09T07-45-21-479036408-62fcaa4081c4`, wurde um 08:06:09 UTC vollständig abgeschlossen. Die neue App startete anschließend und war um 08:16:56 UTC bereit. Bereits während der Initialisierung waren alle sechs neuen Tabellen sowie 19.024 Einträge in der Artikelsuchprojektion lesend nachgewiesen.

Der normale Updater bestätigte die Veröffentlichung mit dem erfolgreichen Beleg `/var/lib/grabenplaner/maintenance/history/update-2026-09-09T08-17-15-264779880.json`, Abschlusszeit `2026-09-09T08:17:15.632Z`, exakter Paketprüfsumme und dem zweiten Sicherungspunkt. Der Monitor-Timer wurde um 08:17:22 UTC wieder aktiviert. Der Updater endete mit Exit-Code 0.

Genau ein automatischer vollständiger Recovery-Assurance-Lauf wurde um 08:17:25.505 UTC gestartet: `3e5adbf6-1f9d-489e-a2fa-0d781a5febe9`. Die signierte Ereigniskette bestätigt die externe Sicherung um 09:00:04.456 UTC und die vollständige Repository-Prüfung um 09:03:20.156 UTC für Snapshot `31ca9a160b34`. Der Lauf endete um 09:06:22.848 UTC mit `RESTORE_TEST_FAILED`; der isolierte App-Test wurde nicht erreicht.

## Erkannte Übergangsfehler

Beim ersten Einspielen war noch der bisherige Updater aktiv. Die zusätzliche Startsicherung endete um 08:27:37 UTC erfolgreich, hatte aber einen Teil des gemeinsamen Zeitbudgets des unmittelbar anschließenden Dienststopps verbraucht. Die Abschlusssicherung erreichte um 08:40:50 UTC dieses Zeitlimit. Ihr vollständig beendeter Besitzerprozess und der genaue offene Archivvorgang wurden identifiziert; die vorhandene Archivverwaltung wird zur signierten Prüfung und zum Abschluss dieses Vorgangs verwendet. Die neue Updater-Koordination übernimmt bei folgenden Updates die zusätzlichen App-Sicherungen bereits beim Start.

Der automatische Ablauf erstellte danach seinen eigenen vollständigen gekoppelten Sicherungspunkt `dienstplan-2026-09-09T08-40-55-217727778-7f5ef62d41bf`. Dieser war um 08:49:03 UTC bestätigt. Die App startete um 08:50:53 UTC und war um 08:56:25 UTC bereit; ihre Startsicherung wies den noch offenen lokalen Archivvorgang ab.

Die Ursache des anschließenden Recovery-Fehlers wurde getrennt lesend reproduziert: Der neue Eintrag `developer-permission-defaults-v1` enthält in `schema_migrations.app_version` den Platzhalter `local`. Der unveränderte Versionsvergleich weist diesen Wert als nicht vergleichbar ab. Die Korrektur v0.92.33 speichert und repariert genau diesen Metadatenwert, ohne die Rechtevergabe erneut auszuführen. Bestehende unveränderliche Sicherungen aus v0.92.32 erhalten eine auf genau diesen Eintrag und diese Quellversion begrenzte Kompatibilitätsregel. Andere ungültige Versionsangaben bleiben Fehler.

Die ergänzten Prüfungen zu Migration, erhaltenen Rechten, ursprünglichem Migrationszeitpunkt, alten Sicherungen und weiterhin abgewiesenen unbekannten Versionen sind zusammen mit den betroffenen Release-, Recovery- und Persistenzprüfungen mit 41 Tests bestanden. Der Kopplungsaudit bleibt mit 1.348 Statements ohne unbekannte Zugriffe oder Phasengrenzverletzungen bestanden. Ein vollständiger Ubuntu-Neustart wurde nicht durchgeführt.
