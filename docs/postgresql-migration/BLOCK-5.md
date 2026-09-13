# Block 5: Kassenbestand und Beleglogik

Stand 12.09.2026. Isoliert implementiert und geprüft; keine produktive Aktivierung oder historische Datenübernahme.

Die Sales-Datenbank enthält jetzt das Schema `kassa` mit sämtlichen 13 zugeordneten Tabellen, 21 expliziten Quellindizes und 26 Triggern. Alle sieben Quelltabellen bleiben vollständig erhalten, einschließlich Journalen, Tagesberichten, Null-Datumswerten und ungeklärten Belegen. Originalwerte bleiben verschlüsselt und an ihre bisherigen Identitäten, Schlüssel und Kontextinformationen gebunden. Es gibt keine Umrechnung gespeicherter Preis-/Rohertragstexte über JavaScript-Fließkommazahlen.

Alle 70 Kassenstatements sind auf PostgreSQL vorbereitet und im [Katalogvertrag](block-5-catalog.json) an Quellschema und SQL gebunden. SQLite-Indexhinweise werden durch reguläre PostgreSQL-Abfragen über die übernommenen Indizes ersetzt. Inventarstände und Änderungsgenerationen werden weiterhin transaktional aktualisiert. Die spätere Lastprüfung muss die tatsächlich gewählten Pläne messen; eine übernommene Indexdefinition ist dafür allein kein Nachweis. [PostgreSQL-Mehrspaltenindizes](https://www.postgresql.org/docs/18/indexes-multicolumn.html)

## Geprüfte Fachabläufe

- Ganze Quelle einspielen, jeden gespeicherten Wert wieder entschlüsseln und vergleichen, anschließend denselben Import wiederholen: keine zusätzlichen Zeilen, gleiche Quellidentität und gleiche Zusammenfassung wie SQLite.
- Fehlender Belegkopf, doppelte Position und Rechteentzug: kein teilweise gespeicherter Importbatch. Falsche Schlüssel und veränderte Suchindizes werden erkannt; die Originalpayloads werden nicht überschrieben.
- Datenstand bereitstellen, gegen eine zweite Quelle wechseln und den vorigen Stand wieder auswählen. Veraltete Vorschauen werden abgewiesen; beide Quellen bleiben erhalten.
- Gespeicherte vollständige Belege über denselben Fachadapter auswerten: Sony-Verkauf mit getrenntem Rabatt, Gutscheineinlösung, Gutscheinausgabe, Bücher mit 10 %, negative Mengen, bestätigte Gebrauchtware mit 0 % sowie weiterhin ungeklärtes Steuerkennzeichen. PostgreSQL und SQLite liefern gleiche Belegprüfungen. Der Kassen-Rohertrag bleibt entsprechend den bestätigten Regeln erhalten und wird mit der vorzeichenbehafteten Menge gerechnet.

Die fünf neuen Prüfungen bestanden: zunächst drei erfolgreiche Prüfungen, anschließend die beiden nach korrigierten synthetischen Tabellen-/Artikeldaten gezielt wiederholten Prüfungen. Der erste Gesamtlauf war nicht durchgehend erfolgreich; seine fehlgeschlagenen Tests waren Fixture-Fehler, kein erfolgreicher Gesamtnachweis. Zusätzlich bestanden alle 17 bestehenden Tests der bestätigten Kassenregeln, die SQL-Auflösung aller 26 Trigger und der Persistenzaudit. Der unveränderte Core-Schemalauf wurde ebenfalls erfolgreich wiederholt.

Lokale Laufprotokolle: `tmp/postgresql-block5-test.txt`, `tmp/postgresql-block5-focused-test.txt`, `tmp/postgresql-block5-rules-test.txt`, `tmp/postgresql-block5-triggers.json` und `tmp/postgresql-block5-audit.txt`.

Abschlusskontrolle nach den Optimierungen aus Block 8: Alle fünf nativen Kassenprüfungen bestanden nochmals gemeinsam, einschließlich vollständiger Quelle, Wiederholung, Veröffentlichung, Manipulations- und Schlüsselprüfung.

## Grenze zu den nächsten Blöcken

Die Veröffentlichungstests dieses Blocks verwenden feste synthetische Standort-/Personalreferenzen. Die tatsächliche Validierung über beide Datenbanken, veränderte Rechte und verbindliche Revisionsübergaben gehören zu Block 7. Die Quellübernahme hier ist eine synthetische Probe; der vollständige historische Umzug mit allen Schlüsseln, Dateien und kanonischen Inhaltsvergleichen bleibt Block 9. Block 6 führt zunächst TradeFoto und den Artikelbestand weiter.
