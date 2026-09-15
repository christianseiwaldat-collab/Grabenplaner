# Datenbankimporte: Prüfung vom 15.09.2026

Die Prüfung am Produktivserver bestätigte um 07:01 UTC: Keiner der drei neuen
Dateistände war vollständig übernommen. Die aktuelle Trade-Quelle hatte
134.896 von 396.466 Zeilen und 66 von 102 Tabellen übernommen. Das ist eine
Teilübernahme, kein vollständiger Import. Die Bestelldatei war verschlüsselt
bereitgestellt, wartete aber auf Trade. Die neue Kassendatei konnte über den
verfügbaren Drive-Zugriff noch nicht übertragen werden. Der ältere Kassenstand
wurde dafür nicht ersatzweise aktiviert.

## Gemessene Ursache

Die Wiederprüfung von `ARTIKEL_FILIALEN` betrifft 233.197 Zeilen. Der
SQL-Übersetzer ergänzte `NULLS FIRST`, während die bestehenden PostgreSQL-Indizes
aufsteigend mit `NULLS LAST` angelegt sind. Obwohl die betroffenen Spalten
`NOT NULL` sind, verwendete PostgreSQL eine parallele vollständige Tabellenlesung
mit Sortierung für jeden nächsten Eintrag.

Eine ausschließlich lesende Messung auf dem VPS ergab für die installierte
Abfrage 2.250,584 ms und 119.677 gelesene Datenbankblöcke. Dieselbe Auswahl mit
der bei diesen Spalten gleichwertigen Indexsortierung benötigte 96,559 ms und
2.232 gelesene Blöcke. Dies ist eine Einzelmessung, keine garantierte Gesamtdauer
des Imports. Stichproben laufender Abfragen zeigten dieselbe Arbeitsliste als
vorherrschenden Verursacher von Lesezugriffen.

Die Korrektur beschränkt sich auf die Arbeitslisten der Importzeilen und
Rücknahmebelege. Historische Migrationskataloge, Schema-Prüfsummen, Sperren,
Berechtigungsprüfungen und Prüfentscheidungen werden nicht verändert.

## Wiederaufnahme

Der installierte PostgreSQL-Treiber erzeugt für sein konfiguriertes
Client-Lesezeitlimit `Error('Query read timeout')` ohne SQLSTATE. Dieser konkrete
Fehler wurde bisher als unbekannter Datenbankfehler eingestuft. Er wird nun als
Lesezeitlimit zugeordnet, damit die bestehende Import-Wiederholung greift.
Andere Fehler werden nicht pauschal wiederholbar. Ein Test prüft Zeitlimit,
gespeicherten Zwischenstand, Prozesswechsel und anschließenden Abschluss.

Im Serverprotokoll um 01:17 UTC standen mehrere Datenbank-Zeitüberschreitungen
und `IMPORT_OPERATION_FAILED`. Der gespeicherte allgemeine Fehlercode alleine
beweist nicht die genaue ursprüngliche Ausnahme; die fehlende Treiberzuordnung
wurde unabhängig davon anhand des installierten Treibercodes bestätigt.

## Transfer und laufende Wiederaufnahme

Die erste Korrektur ist seit 07:37 UTC als v0.92.50 auf dem VPS installiert.
Eine anschließende Messung verwendete den erwarteten Index ohne Sortierung
(0,112 ms bei warmem Cache). Der Trade-Auftrag arbeitet weiter; um 07:59 UTC
waren in der großen Tabelle 36.237 Zeilen erneut geprüft. Dies bezeichnet
Prüffortschritt und noch keinen vollständigen Übernahmeabschluss.

Die aktuelle Kassendatei wurde über das bereits authentifizierte Drive-Laufwerk
des PCs per SSH direkt an den VPS gestreamt und dort verschlüsselt gespeichert.
Die vollständige Entschlüsselungs- und Hashprüfung bestätigte 331.485.184 Byte,
SHA-256 `2046785de1e3459ea586573e0bfd07b0f3a274d94bd3974ae3d7db4774071f10`.
Der Transfer benötigt keine Chrome-Bestätigung und keine neuen OAuth-Rechte.
Ein Timeout der Übertragungsverbindung war kein Anlass für einen doppelten Upload;
der vollständige serverseitige Stand wurde unabhängig verifiziert.

Bestell wartet auf den vollständigen Trade-Abschluss. Kasse wartet auf Bestell.
Beide Einmal-Aufträge verwenden die bestehenden Importprüfungen, eine frische
Berechtigungsprüfung und die gemeinsame Wartungssperre. Eine wartende Unit
oder ein hochgeladener Dateistand ist kein Erfolgsnachweis. Der bisher aktive
Kassenstand vom 04.09.2026 bleibt bis zur atomaren Freigabe des neuen Stands aktiv.

## Zweiter Engpass: Kassenfreigabe

Ein lesender VPS-Test des bisherigen Freigabeplans benötigte 87,534 Sekunden
für 11.059 Zuordnungen, davon 11.036 Artikel. Einzelne Quellpositionen und
Artikelziele wurden dafür tausendfach separat gelesen. Eine neue, begrenzte
Paketverarbeitung benötigt auf denselben Daten 8,982 Sekunden. Dies ist eine
Messung der Planung, keine Zeitgarantie für den gesamten Dateiimport.

Die neue Verarbeitung prüft und entschlüsselt weiterhin jede Quellposition,
liest Ziele im aktuellen Transaktionsstand und bindet die Vorschau an die
vollständigen Zuordnungen. Die Speicherung in Paketen bleibt eine gemeinsame
Transaktion mit der abschließenden Aktivierung. Ein synthetischer Test bestätigt
identische Pläne, die Ablehnung zwischenzeitlich geänderter Ziele und vollständige
Rücknahme nach einem Fehler im zweiten Schreibpaket. Der native INSERT-Plan
wurde ausschließlich mit EXPLAIN ohne ANALYZE in einer lesenden Transaktion geprüft.

Der zusätzliche lange Vergleichslauf der alten Abfragen öffnete eine zu lange
inaktive Core-Lesetransaktion. Diese wurde vom vorhandenen Zeitlimit beendet;
die gleichzeitig laufende Abschlussprüfung meldete `PG_OPERATIONS_CONNECTION_STATE`.
Sicherung, isolierte Wiederherstellung und Anwendungstest waren erfolgreich,
der gesamte Assurance-Lauf wurde trotzdem korrekt als fehlgeschlagen protokolliert.
Der GP blieb erreichbar. Die abschließende Wiederholung nach Veröffentlichung
der Paketverarbeitung muss ohne parallele Datenbankdiagnosen stattfinden.
