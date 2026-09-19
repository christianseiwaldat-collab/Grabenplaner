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
Der Linux-Gesamtlauf für `e354d60` ist grün: 3701 Tests, 3623 bestanden, kein
Fehler, 78 unveränderte umgebungsabhängige Auslassungen. Ein Einzelabgleich der
alten Fehlerliste mit dem neuen Protokoll bestätigt 26/26 ausgeführte und
bestandene Fälle. Zusätzlich bestehen alle 50 Mindest-Node-Vertragstests und
alle 125 PostgreSQL-Vertragstests. Kein betroffener Test wurde entfernt oder
deaktiviert.

## Zusätzliche Windows-Befunde

Der Windows-Lauf des Ausgangsstands `b2e09af` enthielt 52 Fehler. Nach der obigen
Korrektur verbleiben dort 27 andere, bereits vorhandene Plattformbefunde:

- 24 Importtests verwendeten `TEMP` mit der Windows-Kurzschreibweise. Der
  bewusst strenge Spool-Pfadschutz wies dieses nicht kanonische Verzeichnis ab.
  Die Fixture löst jetzt den tatsächlichen temporären Elternpfad auf. Der
  Produktionsschutz gegen Pfadumleitungen bleibt unverändert. Eine lokale
  Prüfung mit einem umgeleiteten TEMP-Verzeichnis reproduziert die alte
  Ablehnung und bestätigt danach alle 24 Tests.
- Drei PostgreSQL-Prüfungen scheiterten an CRLF-Konvertierung im Windows-
  Checkout. Git hält jetzt die bereits qualifizierten JSON-Verträge, deren
  Referenzquellen und die eingebundene SQL-Datei ausdrücklich bei LF.
  Die bestehenden Hashes und Katalogfreigaben wurden nicht geändert. Ein
  Checkout mit `core.autocrlf=true` bestätigt die identischen Bytes aller
  19 betroffenen Quelldateien; eine weitere Regression prüft die Git-Regeln.

Der gemeinsame lokale Windows-Lauf dieser Dateien umfasst 44 Tests:
31 bestanden, kein Fehler, 13 unveränderte umgebungsabhängige Auslassungen.
Der vollständige CI-Lauf für `e5b2166` ist auf beiden Plattformen grün:
Linux 3702 Tests, 3624 bestanden und 78 umgebungsabhängig übersprungen;
Windows 3702 Tests, 3602 bestanden und 100 umgebungsabhängig übersprungen.
Beide Läufe melden null Fehler. Mindest-Node und PostgreSQL-Vertrag sind
ebenfalls vollständig grün.

Auch der Runtime-Commit `736cc4d` für v0.92.58 ist vollständig grün:
Linux 3705 Tests, 3627 bestanden und 78 übersprungen; Windows 3705 Tests,
3605 bestanden und 100 übersprungen. Zusätzlich bestehen alle 50 Tests der
Mindest-Node-Version und alle 125 PostgreSQL-Vertragstests. Die drei neuen
Tests für das konsistente Wiederherstellungs-Zeitlimit sind enthalten.
Nachweis: [vollständiger Release-CI-Lauf](https://github.com/christianseiwaldat-collab/Grabenplaner/actions/runs/35291872375).

Diese Korrekturen gehören nicht zum unveränderlichen Deployment-Paket `b2e09af`
für v0.92.57. Sie sind im Paket `736cc4d` für v0.92.58 enthalten. Der geänderte
Offsite-Fingerprint wurde am VPS über den bestehenden expliziten Modul-Updateweg
installiert; Provider, Repository und Zugangsdaten blieben unverändert.
Die öffentliche v0.92.58-Ansicht wurde am 18.09.2026 um 00:56 UTC überprüft.
Die vollständige Wiederherstellungsprüfung scheiterte anschließend am äußeren
30-Minuten-Limit; siehe [Release-Bericht](DEPLOY-RELEASE-v09258.md). Die dafür
ergänzten gestaffelten Budgets gehören zu [v0.92.59](DEPLOY-RELEASE-v09259.md).

## Zusätzlich aufgedeckter zeitabhängiger Test

Der erste Linux-Lauf für `5f45382` hatte einen anderen Fehler im Test
`one absolute deadline includes queue time and prevents the second child from
starting late`: Innerhalb eines realen 50-Millisekunden-Fensters startete der
zweite simulierte Prozess noch, bevor die gemeinsam verwendete Uhr die
absolute Frist erreicht hatte. Das Ergebnis hängt damit von der Auflösung
und Ausführung der echten Timer ab.

Diese Prüfung und die gleich aufgebaute Prüfung verkürzter Shutdown-Fristen
verwenden jetzt eine kontrollierte Uhr für Zeitstempel und Timer. Sie prüfen
die laufende Warteschlange vor Ablauf sowie die Ablehnung beider Aufträge
nach Ablauf. Der Produktions-Scheduler und seine Fristkontrollen bleiben
unverändert. Alle 16 Tests der Datei bestehen lokal mit Node 22.22.1 und
Node 24.19.0.

## Abschließender CI-Nachweis für v0.92.59

Der Runtime-Commit `de63e729b8e2692801029fec423f866c352d5a1b` besteht alle
vier Jobs im [abschließenden CI-Lauf](https://github.com/christianseiwaldat-collab/Grabenplaner/actions/runs/35300292490):

- Linux: 3705 Tests, 3627 bestanden, kein Fehler, 78 umgebungsabhängig übersprungen.
- Windows: 3705 Tests, 3605 bestanden, kein Fehler, 100 umgebungsabhängig übersprungen.
- Mindest-Node: 50 von 50 bestanden.
- PostgreSQL-Vertrag: 125 von 125 bestanden.

Der erneute Einzelabgleich des Linux-Protokolls für diesen exakten Commit
bestätigt alle ursprünglichen 26 Fälle als ausgeführt und bestanden.
Keiner dieser Fälle wurde übersprungen. Der Windows-Lauf endete am
18.09.2026 um 03:07 UTC erfolgreich. Der VPS-Veröffentlichungsstand ist
separat im [Release-Bericht](DEPLOY-RELEASE-v09259.md) dokumentiert.
