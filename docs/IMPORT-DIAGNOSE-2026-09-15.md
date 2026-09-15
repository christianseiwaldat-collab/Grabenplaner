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

## Ausstehende Betriebsprüfung

Die Korrektur muss auf dem VPS veröffentlicht und die tatsächlichen
Importabschlüsse danach separat überprüft werden. Für Bestell zählt erst ein
vollständig übernommener Quellstand als Abschluss; die wartende Einmal-Unit ist
kein Erfolgsnachweis. Für Kassen_Umsätze.accdb bleibt ein erlaubter Transferweg
für die 331.485.184 Byte große Datei erforderlich: Der verfügbare Connector ist
auf 256 MiB begrenzt, der bestehende Serverzugang mit `drive.file` kann diese
manuell hochgeladene Datei nicht lesen. OAuth-Berechtigungen wurden nicht geändert.
