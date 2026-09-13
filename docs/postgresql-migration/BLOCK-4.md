# Block 4: Core-Anwendung und SQL-Katalog

Stand 12.09.2026. Ausführbare Core-Komposition in der getrennten Entwicklungsumgebung. Die produktive Serverkomposition und die produktiven PostgreSQL-Gates bleiben unverändert.

## Umsetzung

`openCoreDevelopmentApplication` verbindet die vorhandenen Anwendungs-Repositories mit dem PostgreSQL-Provider. Planung, Rechte, Zeiten, Workflows, CRM und weitere Core-Bereiche verwenden damit ihre bestehenden Fachverträge. Transaktionen erhalten dieselben Repository-Schnittstellen; ein Rückgriff auf SQLite ist nicht vorgesehen.

Der vollständige zugeordnete Core-Katalog umfasst **1.125 Statements: 632 Lesewege und 493 Schreibwege**. Alle wurden mit gebundenen Parametern auf der PostgreSQL-Testinstanz vorbereitet. Die 228 Sales-Statements und das datenbankübergreifende Statement `import-master.crm.dependents` bleiben ausdrücklich außerhalb dieser Core-Komposition. Die gemeinsame HTTP-Anwendung und ihre Core/Sales-Verbindungen benötigen Block 7 und die Gesamtprüfung in Block 11.

Jede neu verwendete physische Verbindung prüft Entwicklungsmarker, Anwendungsrolle, Migrationsledger, Quellschema-/Planfingerprint und den tatsächlichen Schemafingerprint. Der [Katalogvertrag](block-4-catalog.json) bindet jedes Statement an seine Quellverträge, übersetztes SQL und die geprüften Parametertypen. Veränderte oder unvollständige Kataloge werden abgewiesen. Die bisherigen Freigabeanzeigen des vollständigen produktiven PostgreSQL-Providers werden dadurch nicht geöffnet.

## Erhaltene Feld- und Abfrageverträge

- Ergebnisse von `SELECT t.*` werden nach Spaltennamen zugeordnet. Die historische SQLite-Spaltenreihenfolge nach `ALTER TABLE` muss nicht der heutigen Vertragsreihenfolge entsprechen.
- Bestehende numerische 0/1-Werte und echte boolesche Rückgabefelder bleiben unterscheidbar; ebenso SQL-NULL, JSON-NULL und JSON-Boolsche Werte.
- SQLite-ASCII-Groß-/Kleinschreibung, maskierte LIKE-Sonderzeichen sowie die vorhandene Unicode-Suche erhalten getrennte Konvertierungen. Für letztere wird die eingebaute PostgreSQL-Unicode-Kollation verwendet. [PostgreSQL-Kollationen](https://www.postgresql.org/docs/18/collation.html)
- Führende Nullen bleiben bei Personal-/Kundennummern erhalten. Die vorhandene numerische Sortierung berücksichtigt auch nichtnumerische Textwerte nach dem bisherigen SQLite-Vertrag.
- NULL-Abteilungen, Datumsgrenzen, Reihenfolge in JSON-Aggregaten und idempotente Einfügungen werden ausdrücklich behandelt. Constraint-Verletzungen werden nicht pauschal als Duplikate verschluckt.
- `portal_notifications` erhält einen eigenen dauerhaften Cursor anstelle des impliziten SQLite-rowid. Lücken durch zurückgewiesene Doppeleinträge sind zulässig. Block 9 muss die historischen rowid-Werte übernehmen und die Identity anschließend über den übernommenen Höchstwert setzen.
- Die Systemauskunft zeigt die 191 übernommenen Core-Tabellen. Sales-Tabellen und interne PostgreSQL-Migrationsobjekte erscheinen dort nicht als lokale Anwendungstabellen.

## Nachweise

Alle **632 Leseabfragen** wurden mit gebundenen synthetischen Eingaben tatsächlich über beide Provider ausgeführt und verglichen: **632 gleiche Ergebnisse, keine Abweisungen oder Fehler**. Davon lieferten 135 mindestens eine Ergebniszeile; die übrigen decken insbesondere leere Listen und fehlende Treffer ab. Die SQLite-Systemauskunft wird für diesen Vergleich ausdrücklich auf die zugeordneten Core-Tabellen begrenzt. Das vollständige Protokoll steht in [block-4-read-parity.json](block-4-read-parity.json).

Die zehn Anwendungstests prüfen den Katalogvertrag sowie echte Repository-Aufrufe für:

- Organisations- und Planungsansichten, Benachrichtigungsseiten einschließlich Duplikaten und Cursorfortsetzung sowie Urlaubsfreigaben;
- gleichzeitige Änderungen mit Revisionsprüfung, Lock-Timeout und anschließender Nutzbarkeit;
- individuelle Rechte, Rollen-/Positionsstandards und garantierten Developer-Vollzugriff;
- mehrtägige Abwesenheiten, nullable Abteilungen, Einstellungen und Rücknahme unvollständiger Transaktionen;
- Zeitbuchungen mit eindeutiger Client-Anfrage, Workflows mit Revisionen und idempotenten Schritten;
- CRM-Nummern mit führenden Nullen, Unicode-/Sonderzeichensuche und veralteten Änderungsständen.

Die synthetische Ausgangsprobe verwendet identische historische Zeitstempel. Nur neu erzeugte Zeitwerte werden beim Vergleich um die unvermeidliche Ausführung zu unterschiedlichen Sekunden bereinigt. Hinzu kommen 55 bestehende gezielte Provider-, Dialekt- und Fachbereichstests; alle bestanden. Die allgemeine Persistenzprüfung bleibt erfolgreich.

## Grenzen und Fortsetzung

Die Vorbereitung aller 493 Schreibstatements belegt SQL-Auflösung und Parametertypen, nicht jeden fachlichen Zweig jeder Schreiboperation. Die aufgeführten Fachtests ergänzen diesen Nachweis mit tatsächlichen Änderungen und Rücknahmen. Vollständige historische Daten, seltene Datenkombinationen, alle HTTP-Abläufe und konkurrierende Verkaufsimporte benötigen die weiteren Migrationsblöcke. Ein bestandener synthetischer Vergleich ist keine produktive Migrationsfreigabe.

Die Implementierung der Blöcke 1–4 ist damit in der isolierten Umgebung vorhanden und gezielt geprüft. Block 5 beginnt mit dem Kassenbestand; Übernahme aller Daten/Dateien/Schlüssel folgt in Block 9, vollständige Abnahme in Block 11 und der separat freigegebene Wechsel in Block 12.
