# Verkaufsanalysen · Datenmodell und Importfundament v0.1

Ergänzung 05.09.2026: Der neue [Gesamtimport-Auftrag, Block 1/6](tradefoto-gesamtimport-v0.1/README.md)
plant ausdrücklich auch CRM-, Kunden- und Verkäuferverknüpfungen. Das folgende
personenfreie v0.1-Modell beschreibt den bisherigen Vertrag; es wurde dadurch
nicht automatisch erweitert. Neue Verknüpfungen benötigen eigene versionierte
Modelle, Persistenz, Sichten und Berechtigungen in den freigegebenen Folgeblöcken.

## 1. Dokumentstatus und Blockgrenze

| Merkmal | Stand |
| --- | --- |
| Fachbereich | Verkaufsverwaltung → Verkaufsanalysen |
| Block | 4 · Datenmodell und Importfundament |
| Version | v0.1 |
| Stand | 03.08.2026 |
| Status | ausführbarer, provider-neutraler Modell- und Vorschauvertrag |

Dieser Block setzt auf dem [Datenkatalog v0.1](./VERKAUFSANALYSEN-DATENKATALOG-v0.1.md) und dem [Rechte- und Sichtkonzept v0.1](./VERKAUFSANALYSEN-RECHTE-SICHTEN-v0.1.md) auf. Er übersetzt die freigegebene fachliche Struktur in einen testbaren Vertrag, ohne bereits eine Quelle anzuschließen.

Block 4 enthält ausdrücklich keine produktive Datenbankmigration, keine Analyse-API, keinen Importendpunkt, keine Hintergrundverarbeitung, keine Kennzahl, keine neue Oberfläche und keinen echten Access-, CSV-, XLSX-, SQL-, API- oder OCR-Adapter. Während dieses Blocks wurde keine Quelldatei geöffnet und keine Echtdaten übernommen.

Der bestehende Desktop-Fachbereich bleibt unverändert eine leere, rechtegeschützte Arbeitsfläche. Eine mobile Fachansicht gehört weiterhin nicht zum vorgesehenen Umfang.

## 2. Ergebnis dieses Blocks

Der technische Stand besteht aus drei getrennten Ebenen:

| Ebene | Aufgabe | Block-4-Grenze |
| --- | --- | --- |
| Kanonisches Modell | stabile Namen, Typen, Datenklassen, Paketzuordnung und offene Entscheidungstore | noch keine Datenbanktabellen |
| Profilvertrag | explizite Zuordnung freigegebener Quellspalten auf genau eine Zielentität | keine freie Abfrage und kein ausführbarer Transformationscode |
| Vorschauvertrag | synthetische, bereits strukturierte Zeilen validieren, normalisieren und als Trockenlauf klassifizieren | `persistence: none`, `canCommit: false` |

Damit können spätere Quelladapter denselben sicheren Übergabevertrag verwenden. Ein Adapter darf erst strukturierte Zeilen an das Fundament übergeben, nachdem seine eigene Quellprüfung implementiert und freigegeben wurde.

## 3. Kanonisches Zielmodell

### 3.1 Kontrollentität

| Entität | Zweck | Importierbar |
| --- | --- | --- |
| `sales_import_run` | Fingerprints, Profil, Zielentität, Snapshot-Zeit, Status und datensparsame Zusammenfassung eines Laufs | nein; wird später durch die Importsteuerung erzeugt |

### 3.2 Fachentitäten

| Entität | Paket | Inhalt und Grenze |
| --- | --- | --- |
| `sales_receipt` | `historical_sales` | gehashte Quellidentität, zugeordneter Standort, Kasse, lokales Verkaufsdatum und lokale Verkaufszeit; kein Kunde und kein Verkäufer |
| `sales_line` | `historical_sales` | EAN, Menge, Soll-/Istpreis, Steuer und historische Artikeltexte; ungeklärte Rabatt-, Rohertrags- und Statuswerte bleiben Staging-/Prüffelder |
| `product_snapshot` | `product_snapshot` | zeitpunktbezogener Artikelstamm mit Bezeichnung, Marke, Sortiment, Taxonomie, Internetkennzeichen und fachlich noch zu bestätigenden Preisen |
| `inventory_snapshot` | `inventory_snapshot` | zeitpunktbezogener Filialbestand, bestellt, im Zulauf, Filialpreis und Datumsangaben; keine erfundene Bestandshistorie |
| `ean_alias` | `product_taxonomy` | alternative und primäre EAN mit Rang und Snapshot-Zeit |
| `taxonomy_member` | `product_taxonomy` | Sortiment, Warengruppe, Sparte oder Marke mit expliziter Hierarchie |
| `shop_product_mapping` | `shop_product_mapping` | EAN und technische Shop-Artikelkennung; keine Bestellung, kein Kunde und kein Umsatz |

Historische Belegtexte und aktuelle Artikel-Snapshots bleiben getrennt. Ein neuer Produkt-Snapshot überschreibt keine historische Bezeichnung, Marke oder Sortimentsangabe aus einer Verkaufsposition.

## 4. Verbindliche Werttypen

| Typ | Regel |
| --- | --- |
| `identifier` | bleibt Text; führende Nullen werden nicht entfernt |
| `sha256` | 64-stelliger interner Fingerprint; rohe Belegschlüssel werden nicht als Analysemerkmal ausgegeben |
| `decimal4` | kanonische Dezimalzeichenfolge mit genau vier Nachkommastellen, zum Beispiel `1234.5000` |
| `date` | gültiges Kalenderdatum `YYYY-MM-DD` |
| `time` | lokale Geschäftszeit `HH:mm:ss` |
| `utc_timestamp` | technischer Zeitpunkt im ISO-Format mit Millisekunden und `Z` |
| `safe_integer` | ganzzahliger Wert innerhalb des verlustfreien JavaScript-Bereichs |
| `boolean` | echter boolescher Wert, kein mehrdeutiger Freitext |

Binäre JavaScript-Gleitkommazahlen sind für `decimal4` verboten. Ein Quelladapter muss Access-`Currency` oder andere Geld- und Mengenwerte verlustfrei als Zeichenfolge liefern. Es findet weder stilles Runden noch eine stillschweigende Währungsumrechnung statt.

Verkaufsdatum und Verkaufszeit werden als lokale Geschäftszeit in `Europe/Vienna` behandelt. Der lokale Verkaufstag darf nicht durch eine voreilige UTC-Umrechnung verändert werden.

## 5. Importprofil v1

Ein Profil bindet genau eine Zielentität und enthält nur:

- Vertragsversion, stabile Profil-ID und Name,
- Zielentität,
- SHA-256 des erwarteten strukturierten Zeilenschemas,
- explizite Feldzuordnungen,
- ausdrücklich bestätigte Filialzuordnungen,
- Referenzen auf bereits fachlich entschiedene Entscheidungstore.

Dateipfade, Passwörter, Zugangsdaten, Connection Strings und frei ausführbarer Code sind keine zulässigen Profilfelder. Unbekannte Profilfelder werden abgewiesen.

Jede Zielzuordnung nennt ihre Quellspalte oder Quellspalten und genau eine bekannte Transformation. Zulässig sind in dieser Version ausschließlich:

- Text- und Kennungsnormalisierung,
- gehashte zusammengesetzte Quellschlüssel,
- ISO- und deutsch formatierte Kalenderdaten,
- lokale Uhrzeiten,
- UTC-Zeitpunkte,
- kanonische beziehungsweise deutsch formatierte Dezimalwerte mit höchstens vier Nachkommastellen,
- sichere Ganzzahlen,
- deutsche boolesche Werte,
- explizite Filialzuordnung,
- typisierte Konstanten.

Es gibt kein `eval`, keine Skriptsprache, keine frei eingebettete SQL-Abfrage und keine automatische Feldübernahme. Sämtliche Pflichtfelder einer Zielentität müssen im Profil zugeordnet sein.

## 6. Fail-closed Schemaschutz

Der erwartete Zeilenvertrag wird aus den ausdrücklich zugeordneten Quellspalten gebildet und mit SHA-256 fixiert. Vor einer Vorschau müssen Profil, Quellbeschreibung und jede strukturierte Zeile genau diesem Vertrag entsprechen.

Zusätzliche oder unbekannte Spalten führen zur Abweisung der Zeile; sie werden nicht still ignoriert. Besonders schützenswerte Quellfelder wie Kunden-, Verkäufer-, Personal-, Provisions-, Bank-, Zugangs- oder Kontaktdaten dürfen bereits im Profil nicht zugeordnet werden. Fehlerberichte enthalten keine Quellwerte.

Dieser Zeilenschema-Fingerprint ersetzt später nicht die native Schemaprüfung eines Access-, SQL-, API- oder Dokumentadapters. Der jeweilige Adapter muss zusätzlich Tabellen, Spalten, Datentypen und erwartete Berichtsstruktur gegen seinen eigenen freigegebenen Vertrag prüfen.

## 7. Trockenlauf und Qualitätszustände

Die ausführbare Vorschau nimmt höchstens 1.000 bereits strukturierte Zeilen entgegen. Sie öffnet selbst keine externe Datei und liefert immer:

- `mode: dry_run`,
- `persistence: none`,
- `canCommit: false`,
- einen deterministischen Idempotenzschlüssel aus Modell, Profil und Quellfingerprints,
- ausschließlich kanonisch normalisierte Vorschauwerte,
- eine datensparsame Liste aus Zeilennummer, Fehlerklasse und Zielfeld.

Die Zeilenzustände sind:

| Zustand | Bedeutung |
| --- | --- |
| `accepted` | technisch gültig und ohne unmittelbaren Prüfhinweis; noch nicht importierbar |
| `needs_review` | technisch lesbar, aber zum Beispiel ohne Filialzuordnung oder mit einem Staging-/Prüffeld |
| `rejected` | Pflichtwert, Typ oder Schema ist ungültig |
| `duplicate` | derselbe kanonische Quellschlüssel kommt im Vorschaupaket erneut vor |

`accepted` bedeutet nicht fachlich freigegeben. Offene Entscheidungstore werden getrennt ausgegeben und eine Persistenz ist in Block 4 grundsätzlich unmöglich.

## 8. Offene fachliche Entscheidungstore

Das Modell führt die bereits bekannten offenen Punkte explizit:

- `branch_mapping`,
- `sales_currency`,
- `sales_price_basis`,
- `return_storno_semantics`,
- `tax_mapping`,
- `margin_semantics`,
- `snapshot_policy`,
- `retention_policy`.

Eine Profilreferenz auf eine spätere Entscheidung ist nur ein technischer Verweis. Die tatsächliche Entscheidung benötigt einen versionierten fachlichen Nachweis und kann nicht durch Manipulation eines Browserfelds oder einer Importdatei ersetzt werden.

## 9. Adapterkatalog und spätere Partnerimporte

| Adapter-ID | Stand in Block 4 | Besondere Grenze |
| --- | --- | --- |
| `structured_rows` | Fundament bereit | liest keine externe Quelle; nur für den gemeinsamen Zeilenvertrag |
| `access_snapshot` | Adapter ausständig | keine Access-Datei wird geöffnet |
| `csv_file` | Adapter ausständig | noch kein Dateiimport |
| `xlsx_file` | Adapter ausständig | noch kein Dateiimport |
| `sql_view` | Adapter ausständig | später nur kontrollierte Leseansicht; kein Schreiben in Fremdsysteme |
| `https_api` | Adapter ausständig | später eigener Verbindungs-, Secret- und Fehlervertrag |
| `report_ocr` | Quellbeispiel erforderlich | nur Vorschläge; menschliche Bestätigung zwingend |

### 9.1 Reservierter OCR-Berichtsweg

Der angekündigte Bericht aus dem bisherigen Warenwirtschaftsprogramm wird erst untersucht, wenn die echte PDF-Datei vorliegt. Vorher werden weder Seitenstruktur noch Feldpositionen, Gruppierungen oder Zahlenbedeutungen geraten.

`report_ocr` ist deshalb lediglich reserviert und technisch gesperrt. Ein späterer Partneradapter muss mindestens:

1. unterscheiden, ob die PDF bereits verlässlichen Text enthält oder tatsächlich OCR benötigt,
2. Berichtsart, Zeitraum, Filiale, Warengruppe und Verdichtungsstufe explizit erkennen,
3. jeden erkannten Wert mit Seite, Fundstelle und Konfidenz als Vorschlag führen,
4. Zwischen- und Gesamtsummen gegeneinander abstimmen,
5. Korrekturen ermöglichen und vor jeder Übernahme menschlich bestätigt werden,
6. den Originalbericht per SHA-256 referenzieren, aber nicht ungefragt im Repository speichern,
7. aggregierte Wochen-, Monats- oder Quartalswerte nicht als einzelne Kassenbelege ausgeben.

Ob solche Berichte später eine eigene kanonische Aggregatentität benötigen oder nur zur Gegenprüfung granularer Quelldaten dienen, wird erst anhand des tatsächlichen Berichts entschieden. Der OCR-Platzhalter ist keine Freigabe für eine automatische Übernahme.

## 10. Datenschutz- und Sicherheitsgrenzen

- Der Vertrag kennt keine Kunden-, Verkäufer-, Mitarbeiter-, Provisions-, Benutzer- oder Zugangsentität.
- Quelldateien, lokale Pfade und Zugangsdaten sind kein Bestandteil von Profil, Vorschau oder Laufmodell.
- Quellwerte erscheinen nicht in technischen Fehlerobjekten.
- Sonderfilialen wie `0` oder `99` werden nur nach ausdrücklicher Zuordnung auf einen Grabenplaner-Standort übernommen.
- Ein Texttreffer erzeugt keine automatische EAN-Zuordnung.
- Ein identischer Inhalt mit demselben Profil erhält denselben Idempotenzschlüssel.
- Direkte Schreibvorgänge in Quelldatenbanken und direkte ungeprüfte Schreibvorgänge in spätere Analysetabellen bleiben ausgeschlossen.

Die in Block 3 festgelegten Datenrechte werden durch dieses Importfundament nicht erweitert. Auch ein technischer Administrator erhält dadurch keinen Verkaufsdatenzugriff.

## 11. Bewusste Persistenzgrenze

Die bestehende Grabenplaner-Persistenz besitzt einen streng gebundenen Anwendungs- und Dialektvertrag. Eine vorschnelle SQLite-only-Erweiterung würde das geplante PostgreSQL-Zielmodell unterlaufen. Deshalb definiert Block 4 zuerst den provider-neutralen Fach- und Importvertrag.

Vor einer produktiven Speicherung ist ein eigener Folgeschritt erforderlich. Dieser muss mindestens gemeinsam entwerfen und migrieren:

- Importprofile und deren Revisionen,
- Importläufe, Idempotenz und Rücknahmebezug,
- temporäre, fristgebundene Stagingbereiche,
- Filialzuordnungen mit Gültigkeit und Audit,
- kanonische Beleg-, Positions- und Snapshot-Tabellen,
- SQLite- und PostgreSQL-Dialektbindungen,
- serverseitige Rechteprüfung für Importverwaltung und Datenprojektion.

Dieser Folgeschritt beginnt nicht automatisch durch das vorliegende Dokument.

## 12. Technischer Lieferumfang

Block 4 ergänzt:

- `lib/sales-analytics-model.js` als tief eingefrorenen kanonischen Modellvertrag,
- `lib/sales-analytics-import.js` als fail-closed Profil-, Quell- und Trockenlaufvertrag,
- synthetische Vertragstests ohne Zugriff auf die untersuchten Datenbankdateien,
- dieses versionierte Architektur- und Grenzdokument.

Nicht ergänzt wurden Serverrouten, Browsercode, Datenbanktabellen, Migrationen, Produktivprofile oder Importrechte.

## 13. Abschluss und nächstes Entscheidungstor

Block 4 schafft ein überprüfbares Datenmodell und ein gemeinsames Importfundament, ohne die offenen Fachregeln zu übergehen. Vor einer ersten echten Quellanbindung müssen die jeweils betroffenen Entscheidungstore fachlich dokumentiert und der konkrete Adapter separat freigegeben werden.

Für den angekündigten PDF-Bericht ist der nächste sinnvolle Schritt eine reine Strukturprüfung der tatsächlichen Datei. Erst danach kann entschieden werden, ob Textauslese genügt, OCR erforderlich ist und welche Berichtskennzahlen überhaupt sicher in ein Partnerprofil gehören.

Der anschließend ausdrücklich gestartete Block 5 ist im [Persistenz- und Revisionsfundament v0.1](./VERKAUFSANALYSEN-PERSISTENZ-REVISIONEN-v0.1.md) dokumentiert. Er speichert ausschließlich Profile, Trockenlauf-Nachweise, fristgebundenes kanonisches Staging und Filialzuordnungen in einem nicht aktivierten Entwicklungsslice.
