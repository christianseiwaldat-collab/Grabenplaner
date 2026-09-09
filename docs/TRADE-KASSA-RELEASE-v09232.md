# VPS-Veröffentlichung v0.92.32-beta

Datum: 9. September 2026. Status: Release vorbereitet, Veröffentlichung und produktive Abschlussprüfung noch ausstehend.

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

Quellcommit, Paketprüfsumme, Updater-Beleg und Abschlussnachweise werden nach erfolgreicher Veröffentlichung ergänzt.
