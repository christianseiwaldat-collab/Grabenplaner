# Trade und Kassa: Optimierungsblöcke 1–3

Stand: 9. September 2026. Die drei beauftragten Blöcke sind lokal umgesetzt und geprüft. Grundlage ist `feature/schedule-pdf-day-separators` bei `3ec927412f79d1db4f8e346f65cd3f7572ab5f44`. Die Änderungen sind noch nicht veröffentlicht. Es gab in diesem Umsetzungslauf keinen produktiven Datenbankzugriff, Quellenimport, Dienst- oder VPS-Neustart.

## 1. Vorbereitete Trade-Artikelsuche

Die Artikelsuche liest eine vorbereitete Darstellung des jeweils aktuellen Artikels. Darin stehen Suchtext, Hauptkennung, Beschreibung, Aktivstatus, Herkunft und Sortierwerte. Die vorher für jeden Treffer wiederholte Zeichennormalisierung und Ermittlung der Hauptkennung entfallen aus der Listenabfrage.

Import, manuelle Neuanlage, Bearbeitung, Archivierung, Wiederherstellung und Importrücknahme aktualisieren diese Darstellung in derselben Transaktion wie den Artikel. Ein Fehler setzt beide Änderungen zurück. Datenbanktrigger markieren noch nicht nachgeführte Artikel; eine Suche mit einem solchen Zwischenstand wird abgewiesen. Die Schemaübernahme ergänzt fehlende oder veraltete Darstellungen atomar und wiederholbar.

Die bisherigen Suchregeln einschließlich Umlauten, Jokern, Wortreihenfolge, alternativen Kennungen, Filtern, Sortierung und Gesamtzahl bleiben erhalten. Ein direkter Vergleich mit den gesicherten bisherigen SQL-Abfragen prüft 140 Kombinationen aus Suchbegriff, Sortierung und Richtung.

Lokaler Versuch mit 19.024 synthetischen Artikeln, je einer Revision und Kennung; Median aus drei Messungen nach einem Aufwärmlauf. Listenabfrage und Trefferzählung sind enthalten, bei der Umsetzung außerdem Lesetransaktion und Prüfung offener Nachführungen:

| Suche | Bisherige Abfrage | Umgesetzte Abfrage |
|---|---:|---:|
| Ohne Suchbegriff | 40,142 ms | 12,741 ms |
| `Testkamera 17001` | 1.514,643 ms | 17,926 ms |
| Ohne Treffer | 757,419 ms | 9,882 ms |

Der erstmalige Aufbau der 19.024 Darstellungen dauerte im Versuch 556,173 ms. Dies sind keine Produktionsmessungen. Die zusätzlich im Messskript enthaltenen einfachen Index-/FTS-Prototypen sind ausdrücklich keine ausgelieferten Funktionen.

Messwerte: [TRADE-OPTIMIERUNG-BLOCK-1-MESSUNG-2026-09-09.json](TRADE-OPTIMIERUNG-BLOCK-1-MESSUNG-2026-09-09.json). Reproduktion: `node scripts/benchmark-sales-search.js`; das Skript verwendet ausschließlich eine fest vorgegebene synthetische In-Memory-Datenbank.

## 2. Kürzere Kassenabfragen mit überprüfbarem Bestand

Anstelle wiederholter vollständiger Tabellenzählungen liest die Anwendung kleine Bestandsnachweise. Sie enthalten je Kassentabelle die Zeilenzahl und einen Änderungszähler; für die bereitgestellten Zuordnungen gibt es einen entsprechenden Nachweis. Einfügen, Ändern und Löschen aktualisieren diese Werte durch Trigger in derselben Transaktion.

Die vollständige Quellprüfung bindet den Änderungsstand in ihre verschlüsselten Metadaten ein. Spätere Änderungen machen den Nachweis ungültig, auch wenn die Zahl der Zeilen gleich bleibt. Für bereits geprüfte Bestände legt die erstmalige Schemaübernahme einmalig einen Ausgangsstand mit Änderungszähler null an und vergleicht dessen Anzahl bei der Nutzung mit dem geschützten Prüfergebnis. Weitere Starts setzen diesen Stand nicht zurück. Fehlende Nachweise werden nicht stillschweigend neu angelegt.

Jede Suchtransaktion prüft außerdem erneut den aktiven Kassenstand. Eine Änderung zwischen dem Einstieg in die Anwendung und der eigentlichen Suche führt somit nicht zur Ausgabe veralteter Ergebnisse. Vollständige Wiederherstellungsprüfungen entschlüsseln und prüfen weiterhin sämtliche Quellwerte und Hashketten.

Die Kandidatensuche liefert nur Kennung und Datum. Belegkopf, Positionen und Zuordnungen werden innerhalb einer Anfrage wiederverwendet. Reine Lesewege einschließlich Schlüsselabfrage nutzen Lesetransaktionen ohne vorsorgliche Schreibreservierung.

Die instrumentierte Prüfung eines Belegs mit 60 Positionen bestätigt:

- keine vollständige Zählung der sieben Quelltabellen oder der Zuordnungstabelle;
- keine `BEGIN IMMEDIATE`-/`BEGIN EXCLUSIVE`-Transaktion im Leseweg;
- einen Belegkopfzugriff und einen gemeinsamen Positionszugriff;
- höchstens fünf einzelne Zuordnungsabfragen für diesen synthetischen Beleg.

Die einmalige Bestandsübernahme beim späteren Rollout benötigt Zeit für die tatsächlichen vorhandenen Tabellen. Ihre Dauer auf dem VPS wurde in diesem Lauf nicht gemessen. Ein vollständiger Neuimport ist dafür nicht vorgesehen.

## 3. Kompakte Belegzusammenfassungen und nachgeladene Details

Die erste benötigte Zusammenfassung eines Belegs prüft weiterhin alle zugehörigen Positionen und die exakten Geldbeträge. Danach kann die Trefferliste die geprüfte Zusammenfassung wiederverwenden. Vollständige Positionen werden beim Öffnen oder Export aus der Quelle geladen.

Der Zwischenspeicher enthält verschlüsselte Summen, Prüfstatus, Positionsanzahl, eine kurze Beschreibung sowie die für die vollständige Suche nötigen Artikel-/Beschreibungstexte und gegebenenfalls Verkäuferkennungen. Einzelmengen, Einzelpreise und vollständige Quellzeilen werden dort nicht abgelegt. Die internen Suchwerte erscheinen nicht in der Antwort an den Browser. Feldgrenzen bleiben erhalten, damit durch das Zusammenfügen keine zusätzlichen Treffer entstehen.

Jeder Eintrag ist an Benutzer, Rechte, bereitgestellten Kassenstand, Quellrevision und Bewertungsregel gebunden. Belegköpfe, Filialberechtigung und Kundendaten werden frisch gelesen. Ein Rechtewechsel kann keine Zusammenfassung mit früheren Rechten wiederverwenden. Änderungen an Quelle oder Zuordnungen sperren die Suche bis zu einem gültigen Nachweis.

Der Speicher ist pro Laufzeit auf 2.000 Einträge und 16 MiB begrenzt. Ein Eintrag lebt höchstens 15 Minuten und darf maximal 256 KiB belegen; größere Zusammenfassungen werden regulär berechnet, aber nicht zwischengespeichert. Nach einem Prozessneustart entsteht der Speicher bei Bedarf erneut. Deshalb ist dies eine Beschleunigung wiederholter Suchen; die erste Aufbereitung bleibt erforderlich. Es wurde kein Hintergrund-Berichtsdienst aus Block 6 vorgezogen.

Lokaler In-Memory-Versuch mit 30 Belegen und insgesamt 600 Positionen; jeweils drei vollständige Suchen, identische Ergebnisse:

| Messung | Erste Aufbereitung | Weitere Suche mit Zusammenfassungen |
|---|---:|---:|
| Median | 361,785 ms | 16,614 ms |
| SQL-Leseaufrufe | 83 | 50 |
| Positionsabfragen | 30 | 0 |
| Vollständige Tabellenzählungen | 0 | 0 |

Die Vergleichsbasis ist hier die bereits mit Block 2 optimierte Anwendung, jeweils mit leerem beziehungsweise gefülltem Zusammenfassungsspeicher. Es handelt sich nicht um einen Vorher-/Nachher-Versuch am Produktivserver. Ein weiterer Prüflauf bestätigte die Größenordnung mit rund 375 beziehungsweise 15 ms.

Messwerte: [KASSA-OPTIMIERUNG-BLOCK-3-MESSUNG-2026-09-09.json](KASSA-OPTIMIERUNG-BLOCK-3-MESSUNG-2026-09-09.json). Der zugehörige instrumentierte Test steht in `test/cash-publication-integration.test.js` und verwendet ausschließlich synthetische Daten.

## Prüfung und Einordnung

Insgesamt bestehen 243 unterschiedliche gezielte Tests: 93 Artikelprüfungen sowie 150 Kassen-, Import-, Schema-, Provider-, UI-Vertrags- und Inventarprüfungen. Im gemeinsamen Lauf bestanden zunächst 148 von 150; zwei veraltete Inventarzähler wurden nachgeführt und die beiden betroffenen Dateien anschließend mit allen zwölf enthaltenen Tests erfolgreich erneut geprüft. Die korrigierte Importprüfung bestätigt die bereits bestehende Trennung zwischen Kundenkonto und optionaler Kundennummer; die fachliche Kundenimportlogik wurde dafür nicht geändert.

Abgedeckt sind insbesondere Suchgleichheit, Geldbeträge, Import und Rücknahme, atomarer Rollback, alte Datenbestände, veränderte Daten trotz gleicher Zeilenzahl, fehlende Prüfnachweise, erneute Schemaöffnung, vollständige Prüfung nach einer kleinen echten Datenbankkopie, persönliche Rechte, Kunden- und Filialgrenzen, Verkäufer- und Positionsfilter, globale Sortierung, Paging, Cache-Verschlüsselung, Ablauf und Begrenzung sowie nachgeladene Details und PDF-Verträge.

Das Datenbank-Kopplungsinventar meldet `ok: true` ohne Grenzverletzungen. Der aktuelle Anwendungskatalog umfasst 1.335 Statements: 1.221 generierte PostgreSQL-Syntaxkandidaten und 114 offene Dialektübersetzungen. Die sechs neuen Statements dieser Optimierung und vier bereits vorhandene neue Rollenstandard-Statements sind mitgezählt. PostgreSQL bleibt ohne Produktivfreigabe bei 0/1.335 akzeptierten Vollanwendungsnachweisen; es fand kein PostgreSQL-Livetest statt.

Lokale Prüflogs:

- `tmp/trade-block1-all-tests.log`
- `tmp/database-blocks-1-3-final-tests.log`
- `tmp/database-blocks-1-3-inventory-recheck.log`
- `tmp/database-blocks-1-3-coupling.json`

Die lokale Umgebung verwendete Node.js 24.19.0 und SQLite 3.53.3. Die tatsächlichen Ladezeiten, der einmalige Schemaaufbau und gleichzeitige Nutzung auf dem Server bleiben Gegenstand des späteren Betriebsnachweises. Blöcke 4–6 mit weiterführenden Suchindizes, umfassender Last-/Rolloutprüfung und dauerhaften Berichtsaufträgen sind weiterhin offen.
