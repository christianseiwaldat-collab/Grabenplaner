# Verkaufsanalysen: getrennte Gruppen, Vorlagen und Grafiken

Stand: 13.09.2026. Lokal umgesetzt und geprüft, noch nicht veröffentlicht.
Produktive Version bleibt v0.92.43-beta. Dieser Auftrag umfasst keinen Deploy,
keinen Commit/Push und keine Änderung produktiver Daten. Die bereits vorbereitete
Korrektur der beiden Nettoköpfe für MA 419 bleibt für den nächsten Deploy enthalten.

## Bedienung

- Reihenfolge: **Bericht erstellen**, **Berichte**, **Grafiken**, **PDF-Analysen**.
  PDF-Analysen wird auch beim späteren Ergänzen weiterer Register ganz rechts gehalten.
- **Warengruppen (WGR)** und **Sortimentsgruppen** haben getrennte durchsuchbare
  Auswahltabellen. Jeweils höchstens zehn auswählen. Beide Filter gelten gemeinsam;
  eine leere Auswahl bedeutet keine Eingrenzung für diese Dimension. Hersteller,
  Filialen und Positions-MA bleiben zusätzlich auswählbar.
- Unter **Meine Berichtsvorlagen** werden Titel und alle fachlichen Einstellungen
  persönlich gespeichert. Laden stellt auch Zeitraum-Auswahlmodus und individuellen
  Vergleich wieder her. Danach sind sämtliche Felder weiter bearbeitbar. Eine
  geladene Vorlage lässt sich aktualisieren oder als neue Vorlage speichern.
  Löschen betrifft die Vorlage; vorhandene PDFs und aktuelle Eingaben bleiben erhalten.
- `(Monat)` und `(Jahr)` im Titel werden erst beim PDF-Auftrag durch Monat und Jahr
  des Beginns des gewählten Zeitraums ersetzt. Die Vorlage behält die Platzhalter.
  Beispiel: `(Monat) (Jahr) Filiale18: Rohertrag nach MA` wird für August 2026 zu
  `August 2026 Filiale18: Rohertrag nach MA`. Gespeicherte Zeiträume werden beim Laden
  bewusst wiederhergestellt; der Benutzer kann anschließend den Monat ändern.
- Bestehende Kassenberichte bieten **Einstellungen laden**. Daraus entsteht bei
  erneuter Beauftragung ein neuer Bericht; das vorhandene PDF bleibt unverändert.
- **Grafiken** unterstützt Tages-, Wochen- oder Monatsabschnitte auf der X-Achse,
  alle persönlich erlaubten Berichtskennzahlen auf der Y-Achse sowie Hoch- und
  Querformat. Die Auswahl wird gemeinsam dargestellt oder auf eine eigene Seite
  je Filiale, MA, WGR, Sortimentsgruppe oder Hersteller aufgeteilt.
- Grafik-PDFs erscheinen in **Berichte**. Das Formular zeigt eine ausdrücklich
  bezeichnete Designvorschau mit Beispielwerten; die tatsächlichen Werte werden
  im Hintergrund für das PDF berechnet. Das PDF verwendet einen dunklen Hintergrund,
  ein blaues Raster und gelbe, unterteilte Balken entsprechend der Bildreferenz.

## Fachliche Datenbasis

`Umsatz_Kasse_Details.Sortiment` ist die historische Sortimentsnummer. Die belegte
Trade-Beziehung `ARTIKEL_Sortimente.Warengruppe` verweist auf
`ARTIKEL_Warengruppen.Warengruppe`. Eine WGR wird niemals aus dem Nummernpräfix
abgeleitet. Namen und diese Beziehung werden beim Auftrag aus dem geprüften
Trade-Katalog eingefroren. Historische Hersteller und Sortimente bleiben an den
Kassenpositionen orientiert. Spätere Änderungen der Sortimentszuordnung sind kein
Beleg für eine frühere WGR-Zuordnung; diese Einschränkung steht in den PDFs.

Die Grafiken nutzen dieselbe geprüfte Kassenberechnung wie die bestehenden Berichte,
einschließlich Retouren, Anzahlungen, Gutscheinen, UID-Zwischenbuchungen und
belegten Nettokopf-Ausnahmen. Rohertrag bleibt Kassen-Rohertrag je Stück mal
signierter Menge. Die Rohertragsquote wird aus den Summen des Rohertrags und
Nettoumsatzes je Zeitabschnitt berechnet, nicht als Mittelwert einzelner Quoten.
Bei Nettoumsatz von null oder darunter bleibt diese Quote nicht verfügbar.

Offene Belege, fehlender Rohertrag und Zeitabschnitte ohne Quelldaten werden nicht
als Nullwerte gezeichnet. Bei getrennten Filialgrafiken wird das Vorhandensein von
Quelldaten je Filiale geprüft. Bekannte Zeitabschnitte ohne passende Verkäufe können
Null ergeben. Das allein beweist keine vollständige Abdeckung aller Kalendertage
durch den Import. Wochen beginnen am Montag; Randwochen/-monate werden auf den
tatsächlich gewählten Zeitraum begrenzt.

## Speicherung und Betrieb

- Neue Aufträge verwenden Vertragsversion 4. Bestehende Versionen 2 und 3 behalten
  ihre bisherige Form und können weiter verarbeitet werden.
- Vorlagen liegen verschlüsselt in der vorhandenen Core-Tabelle
  `portal_user_preferences`, Schlüsselpräfix `sales_report_template_v1:`.
  Es ist keine neue PostgreSQL-Tabelle oder Übertragung von Kassen-/Trade-Daten nötig.
  Die authentifizierte Verschlüsselung bindet Scope, persönlichen Eigentümer und ID.
  Höchstens 50 Vorlagen pro Person; Revision und serialisierbare Transaktion verhindern
  das stille Überschreiben zwischen zwei gleichzeitig geöffneten Ansichten.
- Eigene HTTP-Routen `/api/sales-report-templates` verwenden die bestehenden
  persönlichen Rechte, CSRF-Prüfung, erneute Sitzungsprüfung und `private, no-store`.
  Beim Laden und Speichern wird die Abfrage gegen die aktuellen Rechte und Filialen
  validiert. Speichern startet keinen Berichtsauftrag.
- Die vorhandene Warteschlange und der getrennte Berichtsworker erzeugen auch die
  Grafik-PDFs. Es gibt keinen neuen langen Berechnungspfad im HTTP-Prozess. Grafiken
  benötigen keinen Vergleichszeitraum-Durchlauf. Bestehende Auftrags-, Laufzeit-,
  Speicher- und PDF-Größenbegrenzungen bleiben wirksam.
- Vorerst weiterhin höchstens 366 Tage je Zeitraum, höchstens 50 getrennte
  Grafikgruppen und 12 MB je PDF. Keine automatische Zusammenlegung oder stilles
  Abschneiden darüber hinaus. Die PDF endet mit Auswahl, Datenstand und Rechenhinweisen.

## Lokale Prüfung

- 66 Tests in `sales-report-model`, `cash-publication-integration` und
  `sales-timeline-pdf` bestanden: gemeinsamer WGR-/Sortimentsfilter, unveränderte
  ältere Verträge, präzise Beträge, gewichtete Quote, Datumsgrenzen, getrennte
  Filialabdeckung, verschlüsselte Vorlagen, Eigentümertrennung, Rechteentzug,
  Revisionskonflikte und vollständiger Hintergrundauftrag bis zum PDF.
- HTTP-/CSRF- und Trade-Dictionary-Tests bestanden (38 Tests). WGR-Namen können
  auch aus dem geprüften Quellarchiv gelesen werden, ohne Stammdaten zu aktivieren;
  manipulierte Quelldaten und unzulässige Felder bleiben abgewiesen.
- 10 Tests für bisherige Berichts-PDFs einschließlich neuer Vertragsversion 4
  bestanden; außerdem fünf Grafik-PDF-Varianten mit Text-/Seitenbegrenzungen.
  Endgültige Vorschau und relevante Varianten gerendert und visuell geprüft.
- Navigation, Funktionssuche, Berichtsworker, Checkpoints und PostgreSQL-Verträge:
  40 Tests bestanden, fünf explizite Live-PostgreSQL-Tests mangels konfigurierter
  Testdatenbank übersprungen. Keine produktive PostgreSQL-Funktionsprüfung oder
  Lastmessung für diese neuen Funktionen behauptet.
- Synthetischer lokaler Chrome-Test: zwölf Abläufe einschließlich Speichern ohne
  Auftrag, Neuladen der Seite, Wiederherstellen/Ändern/Kopieren von Vorlagen,
  Registerwechsel, Übernehmen bestehender Berichte, Browser-Zurück, mobile Breite
  und Löschen ohne Verlust der PDF. Keine JavaScript-Fehler. Die Berichts-APIs waren
  in diesem UI-Test bewusst simuliert; die echten Dienste wurden separat geprüft.
- Persistenz-Kopplungsaudit: OK, keine Schichtverstöße. `git diff --check`: sauber.

Nachweise im ignorierten `tmp/`:

- `sales-graphics-final-runtime-tests.log`, `sales-timeline-layout-tests.log`
- `sales-graphics-pdf-routes-tests-20260913.log` (erste Layoutprüfung fand zusätzliche
  Leerseiten; anschließend behoben und in den endgültigen PDF-Prüfungen bestätigt)
- `sales-analysis-pdf-final-tests.log`, `sales-graphics-navigation-contracts.log`
- `sales-graphics-browser-qa.cjs`, `sales-graphics-browser-1789335670144/result.json`
- Grafikvarianten und gerenderte Seiten unter `tmp/pdfs/sales-timeline/`.

Benutzervorschau mit ausschließlich synthetischen Daten:
`output/pdf/Verkaufsanalyse-Grafik-Beispiel-2026-09-13.pdf`.

## Nächster ausdrücklich beauftragter Deploy

Neue Module `sales-report-templates.js`, `sales-report-title.js` und
`sales-timeline-pdf.js` sowie den neuen Grafik-PDF-Test mit einschließen.
Die separate MA-419-Korrektur aus
`VERKAUFSBERICHTE-GEPRUEFTE-TEILWERTE.md` bleibt Bestandteil dieses Arbeitsstands.
Beim späteren installierten Funktionstest WGR-/Sortimentskatalog, persönliche
Vorlage und einen begrenzten Grafikauftrag gegen PostgreSQL prüfen. Bereits
gespeicherte PDFs werden nicht nachträglich geändert. Die bekannte Browsergrenze
für automatisierte Downloads gilt weiterhin nicht als fachlicher PDF-Fehler.
