# Verkaufsanalysen – Produktionshärtung v0.1

Stand: 03.08.2026<br>
Arbeitsstand: Block 9 im separaten Feature-Worktree umgesetzt und lokal geprüft<br>
Freigabestatus: nicht committed, nicht veröffentlicht und nicht auf dem VPS ausgerollt

## 1. Zweck und feste Grenzen

Dieser Block härtet den bereits angelegten Desktop-Arbeitsbereich
`Verkaufsverwaltung > Verkaufsanalysen` für große, fehlerhafte und wiederholt
eingelesene TradeFoto-PDF-Berichte. Er ändert die festgelegten Produktgrenzen
nicht:

- Verkaufsverwaltung bleibt ein fester Hauptbereich und kein optionales Modul.
- Es entsteht keine separate mobile Fachansicht.
- Es werden keine Access-Datenbank, keine Online-Schnittstelle und keine echten
  Produktionsdaten angebunden.
- Die ursprüngliche PDF und rohe Text- oder OCR-Inhalte werden nicht gespeichert.
- Berechtigungen und Filialprojektion bleiben serverseitig und fail-closed.

Das Dokument ergänzt die Verträge der Blöcke 1 bis 8. Deren damaliger
Freigabestatus bleibt historisch unverändert.

## 2. Harte Importgrenzen

Die Textschicht einer PDF wird vor der fachlichen Auswertung begrenzt. Eine
Überschreitung endet mit `TRADEFOTO_REPORT_COMPLEXITY_LIMIT` und HTTP 413.

| Grenze | Maximalwert |
|---|---:|
| PDF-Dateigröße | 15 MiB |
| Seiten mit Textschicht | 120 |
| Textelemente je Seite | 25.000 |
| Textelemente insgesamt | 300.000 |
| Zeichen je Textelement | 4.096 |
| Textzeichen insgesamt | 16 Mi Zeichen |
| Warengruppen je Bericht | 2.000 |
| Vorkommastellen je Kennzahl | 20 |

Die Zeilengruppierung arbeitet nach der Koordinatensortierung nur noch mit der
zuletzt geöffneten Zeile. Dadurch entfällt die zuvor mit der Zeilenzahl
quadratisch wachsende Gruppensuche.

Die strengeren OCR-Grenzen bleiben zusätzlich bestehen: höchstens 30
Rasterseiten, 8 Millionen Pixel je Seite, 3.200 Pixel Seitenbreite, 8.000 Wörter
je Seite und 60.000 Wörter insgesamt. OCR-Ergebnisse bleiben bearbeitbare
Vorschläge und benötigen eine menschliche Bestätigung.

## 3. Wiederholungs- und Konfliktvertrag

Ein Bericht erhält eine deterministische fachliche Identität aus Quellsystem,
Berichtsart, externer Filialkennung, GP-Filiale, Währung sowie Berichts-,
Vergleichs- und Jahreszeiträumen.

- Dieselbe Datei mit derselben Bestätigung ist idempotent: Der vorhandene
  Bericht wird mit `created: false` wiederverwendet.
- Dieselbe Datei mit abweichender Zuordnung oder abweichender fachlicher
  Grundlage wird mit `SALES_ANALYTICS_REPORT_REUSE_CONFLICT` und HTTP 409
  abgewiesen.
- Eine andere Datei für dieselbe fachliche Berichtsidentität wird mit
  `SALES_ANALYTICS_REPORT_PERIOD_CONFLICT` und HTTP 409 abgewiesen.
- SQLite und der vorbereitete PostgreSQL-Vertrag sichern diese natürliche
  Eindeutigkeit zusätzlich in der Datenbank ab.
- Vorhandene Berichte und Kennzahlen bleiben unveränderlich. Es gibt weder ein
  stilles Überschreiben noch zwei parallele Wahrheiten für denselben Zeitraum.

Eine fachliche Korrektur benötigt künftig einen ausdrücklich konzipierten
Storno-/Nachfolgeprozess. Sie darf nicht durch einen erneuten Import simuliert
werden.

## 4. Audit und Fehlerfälle

Erfolgreiche Erstimporte und idempotente Wiederverwendungen behalten getrennte
Auditaktionen. Abgewiesene Bestätigungen, Zuordnungsfehler und
Berichtszeitraumkonflikte erzeugen zusätzlich `sales.report.pdf.rejected`.

Der Ablehnungsnachweis enthält ausschließlich minimierte Metadaten:

- standardisierten Ablehnungsgrund,
- SHA-256 der Quelldatei,
- GP- und externe Filialkennung,
- Berichtsanfang und -ende,
- Extraktionsart und den Nachweis `originalRetained: false`.

Dateipfad, PDF-Inhalt, erkannter Rohtext, einzelne Artikel oder Kennzahlen werden
nicht in den Ablehnungsnachweis übernommen. Nicht auflösbare Zeitraum- und
Wiederverwendungskonflikte verwerfen außerdem die kurzlebige Importsitzung.

## 5. Begrenzte Abfragen und Mengennachweis

Die öffentliche Berichtsliste liefert höchstens 200 Einträge je Anfrage; der
Repositoryvertrag akzeptiert höchstens 500. Berichtsköpfe besitzen weiterhin
den Filial-/Zeitraumindex. Ein Berichtsbündel ist über Primärschlüssel auf genau
einen Bericht und dessen Kennzahlen begrenzt.

Der automatisierte Mengentest belegt lokal:

- 500 gespeicherte Berichtsköpfe für eine Filiale,
- 2.000 Warengruppen mit zwei Horizonten, also 4.000 Kennzahlenzeilen, in einem
  Bericht,
- genau 200 Ergebnisse an der API-nahen Listengrenze,
- vollständigen Abruf der 4.000 Kennzahlenzeilen innerhalb der großzügigen
  Zehn-Sekunden-Sicherheitsgrenze.

Die Laufzeitgrenze ist ein Regressionstor und keine allgemeine
Hardware-Leistungszusage.

## 6. Backup- und Restore-Nachweis

Der Test verwendet die bestehende atomare GP-Sicherungsfunktion. Er erstellt
einen verifizierten, mit Abschlussmarker versehenen Datenbank-/Dokumentspeicher-
Sicherungspunkt und prüft anschließend:

1. `PRAGMA integrity_check = ok` in der Sicherungsdatenbank,
2. keine Treffer bei `PRAGMA foreign_key_check`,
3. Berichtskopf, Warengruppen- und Summenkennzahlen in der Sicherung,
4. dieselben Daten nach Kopie in eine getrennte Wiederherstellungsdatenbank,
5. den weiterhin wirksamen Unveränderlichkeitstrigger nach Wiederherstellung.

Dieser automatisierte Nachweis schützt das Datenmodell. Er ersetzt keinen
regelmäßigen betrieblichen Restore-Drill des vollständigen verschlüsselten
VPS-/Offsite-Sicherungspfads.

## 7. Lokaler Prüfstand

Der gezielte Block-9-Lauf umfasst Importparser, OCR-Vertrag, Persistenz,
Mengentest, Backup/Restore und beide Architekturwächter. Ergebnis: 31 Tests
bestanden, 0 fehlgeschlagen. Der erweiterte Verkaufs-/Provider-Slice bestand
83 von 83 Tests.

Der vollständige serielle GP-Regressionslauf ergab:

- 1.771 Tests insgesamt,
- 1.731 bestanden,
- 40 bewusst übersprungen,
- 0 fehlgeschlagen.

Der Persistenzkopplungs-Audit meldete `Ergebnis: OK`, weiterhin 979/979/979
Anwendungsstatements, 29/29 Sales-Analytics-Statements, 24/24 zugehörige
DDL-Verträge, 0 unklassifizierte Dateien und 0 Phasengrenzverletzungen.

Diese Nachweise erzeugen keine automatische Release- oder Deploymentfreigabe.

## 8. Abschlussgrenze

Block 9 ist der letzte Block des bisher ausdrücklich freigegebenen Fahrplans.
Eine direkte TradeFoto-/Access-Anbindung, weitere Berichtsarten, ein produktiver
Import echter Daten oder ein Rollout benötigen einen neuen, ausdrücklich
gestarteten Arbeitsblock. Bis dahin bleibt der bestätigungspflichtige
PDF-/OCR-Import die vorbereitete Übergangslösung.
