# Korrektur der 26 CI-Fehler vom 18.09.2026

## Ausgangsbefund

Der Linux-Gesamtlauf für `b2e09af` meldete 3699 Tests: 3595 bestanden,
26 fehlgeschlagen, 78 übersprungen. Dieselben 26 Testfälle waren bereits in den
vorangehenden Läufen betroffen. Ein bekannter Fehler bleibt ein offener Fehler;
dieser Stand war kein grüner Gesamtnachweis.

## Ursachen und Änderungen

| Anzahl | Ursache | Korrektur |
| --- | --- | --- |
| 8 | Berechtigungstests erwarteten eine Sitzungsverlängerung trotz Ablaufdatum 2099. Die zusammengefasste Verlängerung führte den Test-Trigger deshalb nicht mehr aus. | Die Test-Sitzung wird vor dem Auslösen erneuerungsbedürftig gemacht. Ein zusätzlicher Nachweis stellt sicher, dass die simulierte Rechteänderung tatsächlich erreicht wurde. Die Rechteprüfungen bleiben unverändert. |
| 11 | Architektur- und Katalogprüfungen verglichen historische Statementzahlen mit dem erweiterten Katalog. | Aktueller Vertrag: 1405 Statements, 44 SQLite-Basisfälle, 1361 Dialektvarianten, 1288 benannte Dollar-Parameter; PostgreSQL-Plan: 1280 Syntaxkandidaten und 125 Fälle mit notwendiger Anpassung. Eindeutigkeit, vollständige Bindungen und die geschlossene Abnahme bleiben geprüft. Historische Dokumentationsstände bleiben historisch. |
| 2 | Alter Offsite-Fingerprint und eine fehlende Standardvariable im isolierten Shell-Test. | Exakten Fingerprint des geprüften Moduls festgehalten; Test-Shell bildet den normalen leeren Übergangsparameter ab. |
| 1 | UI-Test verbot sogar die bereits vorhandene PostgreSQL-Anzeige in den Systeminformationen. | Nur die schreibfreie Informationsanzeige ist ausgenommen; Aktivierung und Datenbankauswahl über die Oberfläche bleiben ausgeschlossen. |
| 1 | Statische Sitzungsprüfung erwartete den direkten Aufruf vor Einführung der Verlängerungsfunktion. | Prüfung folgt der vorhandenen Delegation; Datenbank- und Cookie-Verlängerung bleiben geprüft. |
| 1 | Ein Export auf demselben Datenträger übernahm zu breite Dateirechte. | Exportierte Dateien erhalten 0600, Verzeichnisse 0700; Inhalt und Sicherungsprüfung bleiben erhalten. Rekursive Rechteprüfung ergänzt. |
| 1 | PDF-Rendering hing von Systemschriften ab; lokale PDF.js-Hilfsdateien wurden als `file:`-Zeichenfolgen an einen Dateileser übergeben. | Plattformunabhängige lokale Dateipfade und mitgelieferte Schriften. Zusätzlicher OCR-Test mit nicht eingebetteten Standardschriften. Die manuelle Bestätigung bleibt erforderlich. |
| 1 | Der isolierte SQLite-Wiederherstellungstest kannte verschlüsselte Lernnachweise noch nicht. | Die bekannte Tabelle samt Löschschutz wird nur in der isolierten Testkopie bereinigt. Test weist unveränderte Originaldatei, entfernte Testgeheimnisse, wiederhergestellte Trigger und Datenbankintegrität nach. Unbekannte geschützte Felder werden weiterhin abgewiesen. |

## Prüf- und Veröffentlichungsstand

Gemeinsamer lokaler Lauf mit Node 22.22.1: 206 Tests, 202 bestanden, kein Fehler,
vier unveränderte umgebungsabhängige Auslassungen. Darunter sind alle zuvor
betroffenen Testdateien und die Prüfung der Sitzungsverlängerung. Die
Architekturprüfung meldet keine unbekannten Datenbankzugriffe oder Grenzverletzungen.
Die Linux-/Windows-Gesamtprüfung wird vor einem abschließenden PASS ausgewertet.
Kein betroffener Test wurde entfernt oder deaktiviert.

Diese Korrekturen gehören nicht zum unveränderlichen Deployment-Paket `b2e09af`
für v0.92.57. Der geänderte Offsite-Fingerprint erfordert bei einer späteren
Installation den bestehenden expliziten Modul-Updateweg; ein App-Update allein
übernimmt ihn nicht automatisch.
