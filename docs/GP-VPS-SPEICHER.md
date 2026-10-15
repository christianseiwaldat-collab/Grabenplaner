# VPS-Speicher

Unter Einstellungen → System & Backups öffnet „VPS-Speicher“ ein internes GP-Fenster. Es zeigt freien und belegten Speicher, Datenbanken, Suchindizes, lokale Sicherungspunkte, den Restore-Bedarf und die verbleibende Zusatzreserve. Größte Datenbankbereiche und grundlegende VPS-Informationen ergänzen die Übersicht. Ein Messzeitpunkt kennzeichnet jeden Stand.

Die Prüfung benötigt ein technisches Administrationskonto. Bereinigungen und Speicheroptionen benötigen zusätzlich das System-Schreibrecht. Autorisierung wird vor der Übergabe erneut geladen; schreibende Browseraufrufe benötigen CSRF-Schutz. Die vorhandene geschützte PostgreSQL-Steuerung führt die Arbeiten aus. Der Browser übergibt weder Dateipfade noch SQL.

## Sicherungsreste

Die Prüfung erkennt ausschließlich alte unversiegelte GP-Sicherungsverzeichnisse mit einer oder beiden erwarteten Dump-Dateien. Eigentümer, private Dateirechte, Pfade, Dateitypen, Dump-Kennung, Alter und unveränderte Dateiidentitäten werden geprüft. Unbekannte, jüngere oder zusätzlich belegte Verzeichnisse bleiben erhalten.

Ein Bereinigungsplan wird vor der Bestätigung angezeigt und durch einen SHA-256 gebunden. Unter der Wartungssperre werden mindestens zwei vollständige Sicherungspunkte einschließlich aller Dateiinhalte und der produktiven Clusterbindung bestätigt. Offene Dateiverwendungen, veränderte Pläne oder beschädigte Sicherungen sperren die Entfernung. Ein privater Beleg dokumentiert die Dateien vor der Entfernung.

## Optionen und Nachweise

- Die Zusatzreserve warnt oberhalb des unveränderten Mindestbedarfs der Assurance.
- Das Mindestalter unvollständiger Sicherungsreste ist zwischen 7 und 90 Tagen einstellbar.
- Während Sicherung, Assurance oder anderer Wartung wird kein konkurrierender Speicherauftrag begonnen.
- Ein Kontowechsel, Rechteentzug oder geschlossener Arbeitsbereich verwirft Browserantworten des früheren Kontexts.
- Synthetische Datei-, Berechtigungs- und Browsertests prüfen Schutz und Fensterverhalten. Die native SQL-Prüfung verwendet ausschließlich eigene temporäre Testtabellen und prüft gemeinsam genutzte Blöcke, Herkunftsverknüpfungen und eine unterbrochene Bereinigung.
