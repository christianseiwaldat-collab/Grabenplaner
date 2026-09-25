# Trade-Ausbau: sechs Abnahmeblöcke

Ausgangsbasis: `b348c1f`, Branch `feature/trade-db-import-overview-20260925`.
Die Importübersicht und die ausgewählten WEUM-/Inventurprofile sind lokal vorhanden. Die Fachfunktionen der Blöcke 2 bis 5 sind inzwischen in den GP eingebunden. Die Umsetzung der empfohlenen Reihenfolge wurde am 25.09.2026 beauftragt; die visuelle Abnahme erfolgt anhand einer geöffneten Vorschau oder Screenshots.

| Block | Umfang | Abnahmeergebnis |
| --- | --- | --- |
| 1 – Oberfläche und Bedienung | Gemeinsame Navigation im bestehenden GP, Filter, Tabellen, Details, Datenstände, fehlende/uneindeutige Daten, heller/dunkler Modus und schmale Ansichten. | Klickbare Vorschau aller vier neuen Ansichten mit ausdrücklich synthetischen Beispielen; noch keine Fachintegration. |
| 2 – Historische Artikel | Aktive und archivierte Artikelreferenzen für historische Anzeigen verbinden. Quellen und Archivstatus sichtbar halten. Vorhandene Artikelsuche/Verkaufsansichten ergänzen; Mehrdeutigkeiten nicht automatisch auflösen. | Alte Positionen erhalten nachvollziehbare Bezeichnungen, ohne archivierte Artikel zu aktivieren oder Preise umzudeuten. |
| 3 – Warenbewegungen | WEUM-Journal mit Datum, Art, Menge, Artikel, Lieferant, Herkunft/Ziel sowie Bestell-/Belegverweisen. Einstieg aus Artikelansichten; bestehende Einkauf-/Filialversorgungsansichten verknüpfen. | Gefilterte Recherche, Detailansicht, gespeicherte Ergebnisse/PDF im bestehenden Muster; negative Mengen und ungesicherte Bezüge erkennbar. |
| 4 – Inventuren und Differenzen | Übersicht pro Inventurnummer und Filiale, Datum, Positionszahlen und Prüffälle. Detailfilter nach Fehl-/Mehrmengen und unvollständigen Mengen, Artikelreferenz und PDF. | Köpfe und Details gehören sicher zum gleichen Quellstand. Unveränderte Einzelzählungen werden nicht als vorhanden suggeriert. |
| 5 – Handlungsvorschläge | Bestehende Bestands-/Verkaufskennzahlen um erklärbare Hinweise auf mögliche Umlagerung, Nachbestellprüfung oder Abverkaufsprüfung ergänzen. | Jede Empfehlung zeigt Bestandsstichtag, Verkaufszeitraum, Mengen, Quellen und Grenzen. Keine automatische Bestellung/Umbuchung. |
| 6 – Gesamtabnahme | Zusammenspiel, Berechtigungen, Filialgrenzen, Suchleistung, Quellwechsel/Rücknahme, native PostgreSQL-Prüfung, PDF und visuelle Schlussprüfung. | Geprüfter lokaler Stand mit dokumentierten Nachweisen; Veröffentlichung folgt dem separat beauftragten Releaseablauf. |

## Regeln für alle Blöcke

- Fachlogik und visuelle Prüfung gehören zu jedem Funktionsblock, nicht erst zu Block 6. Je Block gibt es eine lokale Vorschau und einen knappen Prüfbericht.
- Bestehende GP-Komponenten, Themes, Rechte und gespeicherte Auswertungen erweitern. Die vier Reiter der Designvorschau isolieren nur die neuen Ansichten; bestehende GP-Reiter bleiben bei der Integration erhalten.
- Gebuchte Umlagerung ist keine gesonderte Empfangsbestätigung. Negative Mengen sind keine positiven Lieferungen. Nicht zugeordnete Belege bleiben sichtbar, nicht als offen oder erledigt erfunden.
- Historische Artikelauflösung darf aktive Stammdaten, Umsatzsummen, historische Preise und bestehende Referenzen nicht verändern. Kollidierende Kennungen und Gültigkeit müssen explizit behandelt werden.
- Mengenabweichung ist keine gesicherte Verlustbewertung. Dienstleistungen/Sachkonten und ungeprüfte Preiswerte nicht in physische Warenbewertung übernehmen.
- Vorschläge nur bei passender Abdeckung, eindeutigen Artikel-/Filialzuordnungen und bestätigter Lagerware. Reservierungen, offene Beschaffung und Mindestbestände berücksichtigen, soweit belastbar verfügbar; sonst nur Prüfhinweis ohne verfügbare Umlagerungsmenge.
- Datenalter transparent anzeigen. Für Block 5 gilt zunächst die im Detail angezeigte 7-Tage-Grenze; die vollständigen Vergleichsregeln stehen unten.
- Keine laufende Abnahme durch einen automatischen Produktivimport oder eine Veröffentlichung ersetzen.

## Block 1 – Vorschau

Start: `node docs/prototypes/trade-insights/server.cjs`. Der Server bindet ausschließlich an `127.0.0.1`, gibt die URL aus und liefert nur fest erlaubte Vorschau-/Design-Dateien aus. Keine Datenbank, API-Schreiboperation oder externe Ressource.

Die Vorschau demonstriert Suche, Filter, sortierbare Tabellen, Detaildialoge, Querverweise, Dark Mode und leere/veraltete Beispielsituationen. Alle Artikel, Filialen und Belegnummern sind synthetisch. Die spätere PDF-Funktion ist spezifiziert, aber in Block 1 noch nicht implementiert.

Status: Blöcke 1 bis 3 vom Nutzer abgenommen. Für Blöcke 4 bis 6 hat der Nutzer die fachliche und visuelle Schlussprüfung ausdrücklich an Codex delegiert; keine Zwischenfreigabe erforderlich. Zeitraumkalender und sortierbare Spalten sind verbindlich.

Prüfung am 25.09.2026: JavaScript-Syntax geprüft; Browserprüfung von Bewegungsfilter, Artikeldetail mit Archivstatus, Querverweis zur gefilterten Bewegungsliste, Inventurdetails und Mengenprüffall, Vorschlagsbegründung, Zustand ohne Import sowie gesperrten Vorschlägen bei älterem Beispielstand. Heller/dunkler Modus, 1280-Pixel- und 390-Pixel-Layout sowie Reiterwechsel mit Pfeiltaste geprüft. Bei 390 Pixeln kein horizontaler Seitenüberlauf; keine JavaScript-Fehler im Browserprotokoll. Dies bestätigt die Bedienbarkeit des Entwurfs, keine Produktivintegration oder fachliche Berechnung der Beispieldaten.

## Block 2 – Historische Artikel

Die echte GP-Oberfläche enthält unter „Einkauf & Bestand“ den Reiter „Artikelhistorie“. Die Artikelsuche bietet einen direkten Einstieg und übernimmt den Suchbegriff. Aktuelle Referenzen aus `Trade_Daten / ARTIKEL_STAMM` und archivierte Referenzen aus `WEUM / ARTIKEL_STAMMGelöscht` lassen sich nach Kennung, Bezeichnung, Sortiment und Referenzstatus suchen. Die Tabelle ist sortierbar; schmale Ansichten verwenden Karten. Details zeigen beide Quellen bei einer Kollision sowie Anlage-, Lösch-, Quell- und Importdatum, soweit vorhanden. Fehlende Zeitangaben werden ausdrücklich benannt.

Die Kassenhistorie und die Beleganzeige erhalten ergänzende Artikelreferenzen. Der Originaltext bleibt erhalten. Nur ein leerer Belegtext wird mit einer zeitlich bestätigten Bezeichnung ergänzt. Mehrere passende Referenzen, unbekannte oder widersprüchliche Datumsgrenzen und Zeiträume außerhalb der Referenz erzeugen keine automatische Ersatzbezeichnung. Artikelkennungen bleiben exakt, einschließlich führender Nullen. Bestehende Artikelbindungen, aktive Artikel, Preise und Umsatzsummen werden nicht verändert. Der bestehende Beleg-PDF-Auszug verwendet weiterhin den Originaltext.

Die globale Artikelhistorie benötigt persönliche Historien- und Artikel-Leserechte. Bei einzelnen Belegen gelten weiterhin die bestehenden Filial- und Belegrechte. Laufende Teilimporte werden zurückgehalten. Suche und Fortsetzung sind an Berechtigungen und Datenstand gebunden; Filteränderung, Seitenwechsel und Abmeldung verwerfen verspätete Antworten. Die neue Freigabe verändert nicht die Berechtigungssignatur bestehender gespeicherter Auswertungen. Es gibt eine zusätzliche Leseabfrage, aber keine neue Datenbanktabelle oder unverschlüsselte Artikelkopie.

### Lokaler Nachweis

- Fach- und Integrationstests: exakte Kennungen, mehrere Referenzen, Datumsgrenzen, fehlende Zeitangaben, Suche über mehrere Seiten, Quellnachweise, Import/Rücknahme, Teilimporte, geänderte Berechtigungen und Datenstände; unveränderte Belegtexte, Artikelbindungen, Quellpreise und Umsatzsummen.
- UI-Tests: Filterwechsel, Suchabbruch, Fortsetzung, Seitenwechsel und verspätete Antworten. Bestehende Prüfungen für Einkauf, Belegsuche, Kassenhistorie und gespeicherte Auswertungen bestanden.
- Datenbankverträge: neue Abfrage für SQLite und PostgreSQL kompiliert; aktualisierte Katalogzahlen und Providervertragstests bestanden. `node scripts/audit-persistence-coupling.js`: Ergebnis OK, keine unklassifizierten Dateien oder Phasengrenzverletzungen.
- Browser: echte GP-Oberfläche mit synthetischen Importen; direkter Einstieg aus der Artikelsuche, Archiv- und Prüffallfilter, Quellen-Dialog, Desktop (1280 Pixel), Dark Mode und Mobilansicht (390 Pixel) geprüft. Kein horizontaler Seitenüberlauf in der Mobilansicht.

Reproduzierbare Vorschau: `node docs/prototypes/trade-articles/server.cjs`. Sie legt eine neue synthetische Datenbank ausschließlich unter `tmp/article-history-preview-*` an und bindet an `127.0.0.1`. Die ausgegebene `/start`-Adresse öffnet den echten GP mit einem zeitlich begrenzten lokalen Demo-Zugang. Quelldateien und produktive Datenbanken werden nicht eingelesen oder verändert. Der Sicherungshinweis in dieser leeren Testinstallation betrifft ausschließlich die Vorschau.

Screenshots liegen außerhalb des Repositorys unter `C:\Users\chris\Documents\Lamprechter\output\Trade-Block2-2026-09-25`.

Grenzen: Die vollständige Suchleistungsprüfung mit großen Echtdatenbeständen und die native PostgreSQL-Gesamtprüfung bleiben Teil von Block 6. Keine Veröffentlichung oder Änderung am VPS. Block 2 wurde mit dem Auftrag für Block 3 vom Nutzer abgenommen.


## Block 3 – Warenbewegungen

Unter „Einkauf & Bestand“ ist das WEUM-Journal integriert. Es zeigt Buchungsdatum, Bewegungsart, Artikelreferenz, unveränderte Menge, Herkunft/Ziel, Lieferant und Belegverweise. Filter: freie Suche, exakte Artikelnummer, Filiale, Lieferant, Zeitraum, Bewegungsart, Prüfhinweise, negative Mengen und fehlendes Buchungsdatum. Der erste Aufruf verwendet 30 Tage; Artikelsprünge übernehmen die exakte Kennung ohne vorherige Zeit- oder Prüffilter. „Ohne Buchungsdatum“ hebt den Zeitraumfilter auf. Ergebnisse lassen sich sortieren, dauerhaft speichern, umbenennen und als PDF ausgeben. Nach dem Öffnen eines gespeicherten Journals sind Filter und Ergebnisarchiv einklappbar. Auf schmalen Geräten erscheinen Buchungskarten; Desktop und Dark Mode verwenden die bestehenden GP-Farben.

Details stammen aus dem gespeicherten Ergebnis. WEDatum und AkWeDatum werden getrennt ausgewiesen; ein fehlendes WEDatum wird nicht ersetzt. Negative Mengen bleiben negativ, ohne einen Korrektur- oder Rücknahmegrund zu erfinden. Nur eindeutige Quellkennzeichen ergeben Wareneingang oder Umlagerung; bei ungeklärter Art bleiben Herkunft/Ziel in der Tabelle ungeklärt. Die Rohfilialen werden im Detail neutral als Filiale 1/2 gezeigt. Bestellköpfe werden über BestellNr und Lieferant geprüft; dies bestätigt keine Bestellposition. Der Bestellkorb wird über den zusammengesetzten Schlüssel KorbID + KEAN gelesen und zusätzlich auf Filialrichtung geprüft. Liefer-/Rechnungsnummern bleiben ungeprüfte Quellverweise. Es gibt keine gesonderte physische Empfangsbestätigung.

Direkte Einstiege bestehen aus der Artikelsuche und dem Detail der Artikelhistorie. Gefundene Bezüge führen zu Einkauf bzw. Filialversorgung; von deren Ergebnissen ist das Journal zum Artikel erreichbar. Historische Artikelauflösung aus Block 2 bleibt rein ergänzend. Mengen werden weder in Bestände umgebucht noch über verschiedene Artikel zu einem vermeintlichen Gesamtbestand summiert.

### Technik und Nachweise

- Bestehende persönliche Historien-, Bestands- und Einkaufsrechte gelten weiter. Nicht freigegebene Gegenfilialen einer sichtbaren Umlagerung werden ausgeblendet. Fremde Bestell-/Korbdetails werden nicht über die Verknüpfung offengelegt. Quellpreise werden im Journal nicht ausgegeben.
- Vier begrenzte Leseabfragen pro Seite, höchstens 200 entschlüsselte WEUM-Positionen pro Verarbeitungsschritt; Datumsgrenzen werden bereits in SQL angewendet. Eine weitere Abfrage schützt vor teilweise übernommenen oder gerade zurückgenommenen WEUM-/Bestellquellen. Keine zusätzliche Datentabelle, keine unverschlüsselte Kopie produktiver Daten.
- Cursor und gespeicherte Hintergrundaufträge sind an Berechtigungen und Datenrevision gebunden. Bei Änderungen wird eine laufende Suche abgelehnt. Fertige Ergebnisse behalten ihren damaligen Stand und die beteiligten WEUM-Quellstände. Bestehende Berechtigungssignaturen bleiben kompatibel. Die vorhandenen Ergebnisgrenzen von 20.000 Zeilen und 16 MiB gelten weiterhin; größere Recherchen sind nach Zeitraum oder Artikel einzugrenzen.
- Fachtests bestanden: Vorzeichen und Dezimalgenauigkeit, Null-/fehlende Mengen, unklare Kennzeichen, getrennte Datumsfelder, exakte Artikelkennungen, Filialfilter und Ausblendung, passende/widersprüchliche Bezüge, 200er-Seiten, geänderte Daten/Cursor, Teilimporte, Rücknahme und unveränderte gespeicherte Ergebnisse.
- UI-/HTTP-Prüfungen bestanden: Rechte, CSRF, bestehende Auswertungen, Kontextwechsel, Filterübergabe, Artikelsprünge und eingeklappte gespeicherte Ergebnisse. Browsernachweis im vollständigen GP: Umlagerungsdetail, Querverweis zur Filialversorgung und zurück, Negativmengenfilter sowie Archivartikel → historische Bewegung. Desktop 1280 Pixel, Mobil 390 Pixel und Dark Mode geprüft; Mobilseite 375 Pixel Inhaltsbreite bei 390 Pixel Viewport, kein seitlicher Überlauf.
- PDF: Auszug mit acht synthetischen Buchungen strukturell und als gerenderte Seite geprüft. Zusätzlicher Mehrseitentest mit langen Bezeichnungen prüft alle Zeilen, Archivstatus, negative Dezimalmengen und Seitenränder.
- Datenbankinventar OK; 1.433 Statements, 1.389 Dialektvarianten, 1.316 Statements mit benannten Dollarparametern, 1.307 portable PostgreSQL-Dialekte. Alle fünf neuen Abfragen im PostgreSQL-Reportingkatalog kompiliert; zugehörige Vertrags- und Regressionstests grün. Keine native PostgreSQL-Laufzeitabnahme in diesem Block.

Reproduzierbare Vorschau: `node docs/prototypes/trade-movements/server.cjs`. Neue synthetische Datenbank unter `tmp/movement-preview-*`, ausschließlich an `127.0.0.1` gebunden. Die `/start`-Adresse öffnet den echten GP mit lokalem Demo-Zugang. Die Vorschau enthält den bestehenden Hintergrundauftragsspeicher und dessen echten Worker. Alle Artikel, Belege und Buchungen sind synthetisch. Der Sicherungshinweis betrifft die leere Testinstallation.

Abnahme-PDF und Screenshots: `C:\Users\chris\Documents\Lamprechter\output\Trade-Block3-2026-09-25`. Testprotokolle: `tmp/block3-*-tests.txt`, Datenbankinventar: `tmp/block3-persistence-audit.txt`.

Status: Block 3 vom Nutzer mit dem Folgeauftrag für Blöcke 4 bis 6 abgenommen. Die folgenden Abschnitte dokumentieren die Gesamtabnahme. Die Umsetzung erfolgte zunächst ohne Commit, Push, produktiven Import oder VPS-Release. Der anschließende Nutzerauftrag autorisiert den lokalen Commit dieses geprüften Standes.


## Block 4 - Inventuren und Differenzen

Der Reiter „Inventuren & Differenzen“ zeigt Inventurdatum, Nummer, Filiale und vollständige Positionszahlen einschließlich unveränderter Zählungen. In den Details erscheinen ausschließlich die beim Import ausgewählten Abweichungen und Mengenprüffälle. Mehrbestand, Minderbestand, fehlende Mengen und widersprüchliche Mengenrechnungen lassen sich filtern. Quellabweichung und rechnerische Abweichung bleiben getrennt; historische Artikel werden mit ihrer zum Inventurdatum passenden Referenz angezeigt. Mengen unterschiedlicher Artikel werden nicht zu einem Verlust addiert und nicht ungeprüft in Euro bewertet. „Gebucht“ bezeichnet nur das Quellkennzeichen.

Köpfe und Details müssen zur selben Inventurdatei und demselben Stichtag gehören. Auch bei unveränderten Werten erhält eine neue Datei den neuen Quellenbezug. Der Import verweigert Details mit einem anders versionierten Kopf. Laufende Importe/Rücknahmen sperren die Analyse. Detailaufrufe binden Inventur-ID, Revision und Quellhash; ein alter Übersichtslink wird nach Quellwechsel abgelehnt. Filialrechte gelten auch beim direkten Detailaufruf. Je Verarbeitungsschritt werden höchstens 200 Positionen entschlüsselt. Vier begrenzte Leseabfragen verwenden den Inventurkopf bereits in SQL.

Übersicht und Details werden über die bestehende Auftragsverwaltung dauerhaft gespeichert. Eine spätere Suche verändert alte Ergebnisse und deren PDF nicht. Alle Datenspalten und die Liste gespeicherter Ergebnisse sind sortierbar. PDF-Export übernimmt die aktuelle Sortierung; Übersicht und Detail verwenden jeweils eine gültige Standardsortierung.

## Block 5 - Handlungsvorschläge

Der Reiter verbindet den zuletzt vollständig übernommenen Filialbestand mit ausdrücklich freigegebenen, geprüften Kassenpositionen. Er unterscheidet „Umlagerung prüfen“, „Nachbeschaffung prüfen“, „Zulauf abgleichen“, „Bestandsabbau prüfen“ und „Datengrundlage prüfen“. Voraussetzung für operative Prüfhinweise sind bestätigte physische Lagerware, eindeutige zeitliche Artikelreferenz und eindeutige Artikel-/Filialzuordnungen. Führende Nullen bleiben relevant; numerische Kennungsvarianten werden nicht ungeprüft zusammengezählt. Retouren vermindern den Nettoabsatz. Ein auffälliger oder unvollständiger Datenstand ergibt einen Datenprüfhinweis ohne belastbare Absatz-/Reichweitenzahl.

Die firmenweite Historienfreigabe ist für den Vergleich der Filialen erforderlich. Eingeschränkte Benutzer erhalten keine Gegenfilialdaten. Ein Filialfilter grenzt die angezeigten Zielfilialen ein; die Prüfung der Gegenfilialen bleibt an die firmenweite Freigabe gebunden. Einkaufslinks sind nur mit Einkaufsleserecht sichtbar.

Die anfänglichen Berechnungsregeln sind explizit festgelegt und im Hinweisdetail nachlesbar:

| Regel | Einstellung |
| --- | --- |
| Alter des Bestands | Höchstens 7 Tage; Zukunftsdaten ausgeschlossen |
| Verkaufsende | Höchstens 7 Tage vor dem Bestandsstand, niemals danach |
| Beobachtung | Mindestens 28 Tage; Standard 90 Tage bis zum gemeinsamen Datenende |
| Knapper Bestand | Bestand 0 oder weniger als 14 Tage rechnerische Reichweite bei positivem Nettoabsatz |
| Mögliche Gegenfiliale | Positiver Bestand, kein erfasster Verkauf oder mehr als 60 Tage Reichweite |
| Bestandsabbau | Positiver Bestand, kein erfasster Verkauf oder mehr als 180 Tage Reichweite |
| Bereits vermerkter Zulauf | Positive Quellwerte „Bestellt“ oder „im Zulauf“ führen zur Prüfung dieses Zulaufs |

Die Reichweite ist Bestand × Beobachtungstage ÷ Nettoabsatz und keine Nachfrageprognose. Beginn und Ende der Kassenquelle beweisen keine lückenlose tägliche Datenabdeckung. „Reserviert“ und „Mindestbestand“ existieren im globalen Artikelstamm; eine belastbare Zuordnung dieser Werte je Filiale ist aus den ausgewählten Daten nicht gesichert. Deshalb gibt es keine berechnete freie Umlagerungsmenge. Bestellungen und Zulauf bleiben ungeprüfte Quellwerte. Die Funktion erzeugt keine Bestellung und keine Bestandsumbuchung.

## Gemeinsame Bedienung

Die neuen datumsbezogenen Ansichten verwenden den vorhandenen GP-Zeitraumkalender mit klaren Beginn-/Endfeldern, einem gemeinsamen Monatsraster, Monatswechsel, Tages- und Wochenbereichen sowie aufklappbarer direkter Datumseingabe. Eine zurückgesetzte Auswahl lässt die jeweilige Standardregel gelten. Die Vorschläge erklären ihre 90-Tage-Vorgabe direkt auf der Seite. Nach dem Öffnen eines Ergebnisses werden die tatsächlich verwendeten Daten gezeigt.

Alle fachlichen Datenspalten sind sortierbar. Das gilt auch für die Kartenansichten auf kleinen Geräten und jetzt für die Artikelhistorie. Filter und gespeicherte Ergebnislisten lassen sich einklappen. Desktop und Mobilansicht verwenden die bestehenden GP-Farben in hellem und dunklem Modus. Die Kalenderabstände sind für schmale Geräte angepasst.

## Block 6 - Gesamtnachweis

### Funktion und Datenbankverträge

- 112 unterschiedliche Fach-, HTTP-, PDF- und Oberflächenprüfungen: 111 im gemeinsamen Lauf bestanden; das eine ältere Testbeispiel für sämtliche Importprofile verwendete unterschiedliche Dateien für Inventurkopf und Details. Das Beispiel wurde auf eine gemeinsame Inventurdatei korrigiert und separat erfolgreich wiederholt. Testprotokolle: `tmp/block6-final-regression-tests.txt` und `tmp/block6-history-profile-tests.txt`.
- Enthalten sind 5.001 geprüfte Verkäufe für den Jahres-/CRM-Vergleich, 450 Inventurdetails über mehrere Seiten, 220 zusätzliche Kassenpositionen samt Retoure, Quellwechsel, vollständige Rücknahme, Teilimporte, Berechtigungswechsel, Filialgrenzen, CSRF, gespeicherte Ergebnisse, PDF-Sortierung und verspätete UI-Antworten.
- 56 Vertragstests für Provider, SQL-Dialekte und Datenbankinventar bestanden. Aktueller Katalog: 1.437 Statements, 1.393 Dialektvarianten, 1.320 Statements mit benannten Dollarparametern und 1.311 portable PostgreSQL-Dialekte. Kein neues produktives Datenbankschema. `tmp/block6-contract-tests.txt`.
- `node scripts/audit-persistence-coupling.js`: OK; keine unklassifizierten Dateien und keine Phasengrenzverletzungen. `tmp/block6-final-persistence-audit.txt`.

### Native PostgreSQL-Prüfung

Zwei Integrationstests wurden auf einem eigens angelegten lokalen PostgreSQL-18.6-Cluster gegen getrennte Core-/Sales-Datenbanken ausgeführt, ohne übersprungene Tests. Echte Migrationen, SQL-Ausführung und Reporting-Worker wurden verwendet. Historische Artikel, Warenbewegungen, Inventuren, Handlungshinweise, Quellwechsel, gespeicherte Ergebnisse, Klassifikation, Reparaturen und Rechteentzug sind geprüft. Der erste Lauf deckte fehlende Artikel-Leserechte in der engen Berechtigungsweitergabe an den Reporting-Worker auf; die Weitergabe wurde korrigiert. Der erneute Lauf bestand vollständig in rund 25 Sekunden. Beide Laufprotokolle bleiben erhalten (`tmp/block6-native-tests.txt`, `tmp/block6-native-tests-2.txt`).

Das portable Laufzeitsystem stammte vom über die [offizielle PostgreSQL-Seite](https://www.postgresql.org/download/windows/) verlinkten [Windows-Binärangebot von EDB](https://www.enterprisedb.com/download-postgresql-binaries). Der Cluster war ausschließlich an Loopback-Port 55484 gebunden, mit privaten lokalen Dateien und getrennten Rollen. Es wurde kein Windows-Dienst installiert. Nach den Tests wurde der eigene Cluster gestoppt und der geschlossene Listen-Port geprüft. Keine VPS-Verbindung oder Produktivmigration.

### Visuelle Prüfung und Vorschau

Die vollständige GP-Vorschau enthält ausschließlich synthetische Artikel, Inventuren, Buchungen und Vorschläge. Geprüft wurden Übersicht → Inventurdetails → Artikelherkunft, Hinweisbegründung/Gegenfilialen, Quelldaten ohne ausreichende Freigabe, Sortierung und PDF-Link, Wochenbereich und eintägige Tastatureingabe im gemeinsamen Kalender, Desktop mit 1280 Pixeln, Mobilansicht mit 390 Pixeln und Dark Mode. Bei 390 Pixeln beträgt die Seitenbreite 375 Pixel ohne horizontalen Seitenüberlauf. Datenprüfung und verfügbare Mengen werden nicht als bestätigte Dispositionsfreigabe gestaltet.

Start: `node docs/prototypes/trade-final/server.cjs`. Die Ausgabe nennt die `/start`-Adresse mit lokalem Demo-Zugang. Bindung ausschließlich an `127.0.0.1`; eigene synthetische Datenbank unter `tmp/trade-final-preview-*`. Der Sicherungshinweis des GP betrifft diese leere Testinstallation. Die Vorschau wird für die Nachschau offengelassen.

Aktuelle Anwendungs-PDFs und Screenshots: `C:\Users\chris\Documents\Lamprechter\output\Trade-Block6-2026-09-25`. Die PDFs wurden gerendert und auf Lesbarkeit, Zeilenumbrüche und erhaltene Archiv-/Mengenkennzeichen geprüft. Frühere Nachweise aus Block 4 und 5 bleiben in deren Ausgabeordnern erhalten.

### Volumenprüfung

Die Messung verwendet ausschließlich zuvor analysierte lokale Arbeitskopien von Trade_Daten, WEUM und InventurProtokoll. Deren SHA-256 wird vor und nach dem Lauf gegen den Analysenachweis geprüft. Die Reporting-Testdatenbank liegt in einem privaten lokalen Verzeichnis und enthält authentifizierte verschlüsselte Fachdatensätze. Sie dient der Leseleistungsprüfung, nicht der Messung der vollständigen Upload-/Importpipeline. Die originale Access-Datei und der VPS bleiben unberührt. Die abgeschlossene Prüfung und unabhängige Metadatenzählung liegen in `Volumenpruefung.json`. Alle sechs Fachabfragen wurden vollständig gelesen. Die sechs importierten Datengruppen stimmen mit den erwarteten Mengen überein.


### Abschließende Suchoptimierung und Ergebnis

Die Volumenmessung zeigte, dass eine freie Artikelkennungssuche die verschlüsselten Kataloge vollständig lesen muss. Daher bietet die Artikelhistorie jetzt die ausdrückliche Suchart „Artikelnummer exakt“, die aktuelle und archivierte Kennungen über vorhandene HMAC-Indizes auflöst. Herkunft ist ebenfalls sortierbar. Handlungsvorschläge unterstützen zusätzlich das exakte Artikelfeld; zugeordnete Filialbestände werden gezielt geladen. Bei ungebundenen oder übermäßig vielen Referenzen bleibt die sichere begrenzte Seitensuche erhalten. Freie Textsuche und exakte Kennung bleiben bewusst unterschiedliche Sucharten.

| Vollständig gelesene Abfrage | Ergebnis | Lokale Dauer |
| --- | --- | --- |
| Inventurübersicht | 438 Zeilen / 3 Schritte | 0,231 s |
| Größte ausgewählte Inventur | 419 Prüffälle / 3 Schritte | 0,890 s |
| Artikelhistorie, exakte Kennung | 1 Referenz / 1 Schritt | 4 ms |
| Warenbewegungen 01.–18.09.2026 | 2.234 Zeilen / 12 Schritte | 12,780 s |
| Handlungshinweise, exakte Kennung 1 | Keine Hinweise / 1 Schritt | 4,076 s |
| Handlungshinweise, exakte Kennung 2 | 12 Datenprüfhinweise / 1 Schritt | 3,875 s |

Die identischen Kennungen der ersten Artikel-/Hinweisabfrage benötigten zuvor als freie Suche 49,740 bzw. 375,827 Sekunden. Die freie Textsuche bleibt langsamer und wird nicht als gleich schnelle Alternative dargestellt. Basismessung: `Volumenpruefung-Freitext-Basis.json`. Messung lokaler Reporting-Fachabfragen, kein Upload-Benchmark und keine VPS-Leistungszusage. Im echten Großbestand fehlt eine freigegebene vollständige Kassenpublikation; die zwölf Hinweise sind folglich Datenprüffälle. Operative Vorschläge sind mit synthetischen freigegebenen Kassenfällen geprüft.

Die abschließend geprüften Such-/UI-Fälle bestanden (24 Fälle sowie der ergänzte UI-Test; Wiederholung der UI-Datei mit 11 grünen Fällen). Exakte Identität, führende Nullen, Archivkonflikte, Kassenfortsetzung über mehrere Seiten und Filterübergabe wurden geprüft. Die zwei nativen PostgreSQL-Tests bestanden erneut, diesmal einschließlich der exakten Suchpfade. Der eigene Cluster wurde danach gestoppt; Port 55484 ist geschlossen.

**Status:** Blöcke 4, 5 und 6 lokal umgesetzt und eigenständig geprüft. Vorschau mit synthetischen Daten: `http://127.0.0.1:53515/start`. Abschlussbericht, Anwendungs-PDFs, Screenshots und Protokolle liegen im Ausgabeordner. Der anschließend beauftragte lokale Commit umfasst den geprüften Ausbau einschließlich Tests und Vorschauquellen. Push und VPS-Deployment sind nicht Teil dieses Auftrags.

Bei exakten Handlungshinweisen zählt die Fortschrittsanzeige alle tatsächlich geprüften Filialpositionen. Die Korrektur dieser Anzeige wurde mit fünf Fachtests und beiden nativen Tests erneut bestätigt.
