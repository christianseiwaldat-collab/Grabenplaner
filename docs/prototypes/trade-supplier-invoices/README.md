# Lieferantenrechnungen: Datenprüfung und lokale Vorschau

Stand: 28. September 2026. Die Quellen-Vorschau bleibt als fachlicher Prüfnachweis erhalten. Die Lieferantenrechnungssuche ist jetzt zusätzlich in den GP integriert; dieser Stand ist lokal geprüft, noch nicht veröffentlicht. Quellenprüfung und Vorschau senden keine Nachrichten.

## Start

Im Repository `node docs/prototypes/trade-supplier-invoices/server.cjs` ausführen und den ausgegebenen Startlink öffnen. Die Vorschau bindet ausschließlich an `127.0.0.1`, verlangt eine zufällige Sitzungskennung und liefert keine Quellarchive aus. Der Startlink steht auch in der ignorierten Datei `tmp/supplier-invoice-preview.json`.

Standardquelle ist `../output/Trade-Ergaenzungsanalyse-2026-09-22`; über `TRADE_ANALYSIS_DIRECTORY` lässt sich ein anderer vollständiger, entsprechend qualifizierter Analyseordner angeben. Erforderlich sind die gehashten ACCDB-Kopien, der Quellenbeleg und die damaligen Jackcess/SQLite-Exporte. Die tatsächlich benutzten Rechnungsfelder werden beim Start vollständig mit einem unabhängigen Access-Leser verglichen. Geschäftsdatensätze und Startkennungen gehören nicht ins Repository.

Prüfung: `node --test test/trade-supplier-invoice-preview.test.js`. Der ergänzende, ausschließlich lesende Quellencheck `node docs/prototypes/trade-supplier-invoices/qualify.cjs` schreibt den Nachweis nach `../output/Trade-Lieferantenrechnungen-2026-09-27`.

## Fachliche Zuordnung

- `Rechnung_A` enthält 12.342 Köpfe; `Rechnungsdetails_A` enthält 74.967 Positionen zu 9.761 Artikelkennungen. Alle Positionen haben genau einen passenden Kopf.
- Die verlässliche Verbindung lautet **Rechnungsnr + Suchname**, ohne Unterscheidung der Groß-/Kleinschreibung. `ID` der Position ist nicht die Kopf-ID. Rechnungsnummern allein sind nicht lieferantenübergreifend eindeutig.
- Es sind Lieferantenbelege: 12.339 von 12.342 Köpfen sind dem damaligen Lieferantenstamm zugeordnet. 69.771 Positionen passen über `we_id` zu Wareneingängen, mit identischer Artikelkennung. Die Beleganzeige hängt nicht davon ab, ob der historische Wareneingang noch vorhanden ist.
- Anlegedatum und Buchdatum werden auf ausdrücklichen Nutzerwunsch beide angezeigt. Keines wird ohne fachlichen Beleg in „Rechnungsdatum“ umbenannt. 11 Köpfe haben kein Buchdatum; sie bleiben ohne Datumsfilter sichtbar.
- Eine Zeile je Artikel und Lieferantenrechnung, mit Summe der Positionsmengen. Unterschiedliche Preise bleiben als Spanne und über Positionsdetails sichtbar. Negative Mengen werden nicht automatisch als Gutschrift oder Storno klassifiziert.
- EK je Rechnung ist `Rechnungspreis`; `NNPreis` bleibt in den Positionsdetails separat. Bei 12.236 von 12.342 Rechnungen entspricht Menge × Rechnungspreis einschließlich Positions-Umsatzsteuer dem Kopf-Rechnungsbetrag mit weniger als 0,10 EUR Abweichung. Das ist eine Plausibilisierung, keine Zusage für jeden einzelnen Beleg. Keine Neuberechnung von Buchhaltungsbeträgen.
- VK brutto und durchschnittlicher EK netto stammen aus dem aktuellen bereitgestellten Artikelstamm. Für nur historisch bekannte Artikel bleiben aktuelle Preise leer. 2.207 Rechnungspositionen haben keine Entsprechung im aktuellen Stamm.

## PDF-Befund

Die Rechnungsdatei enthält keine Binär-/Anhangsspalten. Auch im Rechnungs-Memofeld `Info` wurden keine PDF- oder Dokumentpfade gefunden. `DF` enthält die Kürzel `Rin` und `Lom`, keine Dateipfade.

In `TRADE_EMAIL_DATEN.accdb` enthalten 36.601 E-Mail-Zeilen PDF-Verweise in `Attachment1`, teilweise mehrere getrennt durch Semikolon. Es sind externe Pfade, keine eingebetteten Dateien. Sie liegen überwiegend unter `C:\tradefoto\pdf\Anforderung`, `C:\tradefoto\Emails` und `T:\Bestellung_Dokumente`. Ein Verweis lautet `C:\Tradefoto\Rechnungen\Rechnungsnr_60645.pdf`; daraus ist eine Lieferantenrechnungszuordnung nicht nachgewiesen. Die referenzierten Laufwerke/Ordner stehen lokal nicht zur Verfügung.

`Shopware.accdb.ScanDoc` und `Trade_Daten.accdb.Kunden_Dokumente` sind leer. Der einzelne Shopware-Dokumentdatensatz und Gutschein-PDF-Speicherpfade belegen kein Lieferantenrechnungsarchiv. Für Original-PDFs muss als nächster Schritt der tatsächliche Dokumentbestand des Lagers bzw. der Buchhaltung geprüft werden. Keine erfundenen PDF-Downloads und keine Rekonstruktion als angebliche Originalrechnung.

## Integration im GP

Unter **Einkauf & Bestand → Lieferantenrechnungen**: Suche nach Nummer oder Bezeichnung im vorhandenen GP-Artikelkatalog, aktuelle Preise im Artikelkopf, beide Datumsfelder, Zeitraumkalender mit wählbarer Datumsbasis sowie sortierbare Rechnungs- und Positionstabellen. Historische Artikel ohne Katalogeintrag sind mit ihrer exakten Quellartikelnummer erreichbar. Führende Nullen bleiben erhalten. Die Kopierfunktion bietet einen Textdialog, falls der Browser die Zwischenablage nicht freigibt.

**Einstellungen → Datenbankimporte** akzeptiert jetzt `TRADE_AusgangsRech.accdb`. Ein minimiertes Profil übernimmt sechs Kopf- und elf Positionsfelder. Teilzahlungen, Zahlungsstatus, Bank-/Adress- und Personaldaten bleiben ausgeschlossen. Der Datenstand berücksichtigt Anlege- und Buchdatum. Prüfung, Übernahme und Wiederaufnahme nutzen den bestehenden Importablauf.

Die Beleganzeige ist firmenweit einschließlich Zentrallager, aber ausdrücklich an das persönliche Recht `sales:supplier-invoices:read` gebunden. Zusätzlich gelten der bestehende Historien- und Analysenzugriff sowie eine Filial- oder Firmenfreigabe. Für Rechnungs-EK, NN-Preis und Durchschnitts-EK ist separat `sales:supplier-invoices:costs:read` nötig. Allgemeine Finanzrechte werden nicht erweitert.

Der verschlüsselte Historienbestand verwendet einen authentifizierten, gehashten Artikelindex unabhängig von aktuellen Stammdatenbindungen. Pro Artikel werden nur dessen Positionen geladen, höchstens 10.000; bei Überschreitung gibt es keine irreführende Teilliste. Kopf und Positionen müssen aus derselben vollständig übernommenen Quelldatei stammen. Unterschiedliche Importstände und laufende Übernahmen werden blockiert. Entfallene Positionen bleiben in der technischen Historie, erscheinen aber nicht im aktuellen Belegstand.

Die bestehende Rücknahmesicherung bleibt wirksam: Ein Erstimport kann in umgekehrter Tabellenreihenfolge vollständig zurückgenommen werden. Historische Positionsversionen können bei späteren Korrekturimporten die Rücknahme des Kopfes blockieren. Ein dadurch unvollständiger Quellstand wird nicht angezeigt. Diese Grenze wird getestet; abhängige Historie wird nicht gelöscht oder umgeschrieben.

## Lokale Abnahme und Nachweise

- SHA-geprüfter Access-Lesedurchlauf: alle 12.342 Köpfe und 74.967 Positionen normalisiert, Teilzahlungen ausgeschlossen. Keine echte Geschäftsdatenbank verändert.
- SQLite-Integration: Import, Wiederholung, Erst-Rücknahme, geänderte Quellen, zusammengesetzte Schlüssel, historische Artikel, Mengen/Preise, Datumsfilter, minimale Filialrechte, Preisredaktion und Rechteentzug geprüft.
- Native PostgreSQL-Integration mit echtem Reporting-Worker: Import, Artikelindex, Text-/Nummernsuche, Quellwechsel und Rechteentzug grün; bestehende Trade-Auswertungen ebenfalls geprüft.
- Regressionen für Importübersicht, API/CSRF, Artikelhistorie, Warenbewegungen, Inventuren und UI-Lebenszyklus geprüft.
- Browser-Abnahme der echten GP-Seite mit synthetischen Daten: Suche, Kalender, beide Datumsfilter, Sortierung, Positionen, Kopierdialog und mobile Darstellung. Lokale Nachweise unter `../output/Trade-Lieferantenrechnungen-2026-09-28`.

GP-Vorschau: `node docs/prototypes/trade-supplier-invoices/gp-preview.cjs`. Sie erzeugt eine eigene synthetische Datenbank, bindet nur an Loopback und speichert den zufälligen Startlink in `tmp/supplier-invoice-gp-preview.json`. Die unabhängige Quellen-Vorschau bleibt unter `server.cjs` verfügbar.

Kein Push, VPS-Import oder Deployment gehört zu diesem Umsetzungsschritt.
