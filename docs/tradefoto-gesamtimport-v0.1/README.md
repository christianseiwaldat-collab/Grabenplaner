# TradeFoto-Gesamtimport · Block 1/6

Aktueller Umsetzungsstand vom 07.09.2026: [Kompakte Kasse funktional angebunden](KASSE-ANBINDUNG-ABSCHLUSS-2026-09-07.md). Auswertungsadapter, Rechte, festgehaltene Zuordnungen, Aktivierung und Rückkehr sind lokal implementiert und geprüft. Die nachstehenden früheren Inventur- und Vorprüfungsstände bleiben historische Nachweise; der VPS-Release und der produktive Erstimport sind der folgende Schritt.

Stand: 05.09.2026. Status: vollständige Strukturinventur, Qualitätsprüfung und Zielvorschlag; **kein Import in den Grabenplaner**.

Aktuelle Entscheidung vom 07.09.2026: **Gesamte Kasse im schlanken Prototyp, ohne 24-Monate-Grenze.**
TradeFoto bleibt ausdrücklich im vollständigen bisherigen Umfang; auf die dort möglichen 0,09 % Zeilenersparnis wird verzichtet.
Die frühere [24-Monate-Auswahl](24-MONATE-IMPORTUMFANG-2026-09-07.md) ist als Vorgabe aufgehoben und bleibt ein historischer Vergleich.
Der neue [GP-Prototyp für die gesamte Kasse](KASSE-VOLLBESTAND-GP-PROTOTYP-2026-09-07.md) verwendet die normale geschützte Importvorschau und kompakte Kassentabellen in der GP-Datenbank. Geschäftliche Aktivierung und VPS-Freigabe bleiben gesonderte Schritte.

Die anschließende [Kassen-Speicherprüfung](KASSE-SPEICHERARCHITEKTUR-2026-09-07.md) ist bestanden:
835,14 MB für die ganze Kassenquelle im isolierten verschlüsselten Prototyp und 481,95 MB für 24 Monate; alle 97 Quellfelder bleiben enthalten.
Das frühere 24-Monate-Archiv misst 267,70 MB, sein vollständiger Datei-/Werte-Restore bestand. Diese Werte sind Vergleichsmessungen des früheren isolierten Dateiprototyps. Den aktuellen gesamten GP-Kassenstand und seine gekoppelte Wiederherstellung dokumentiert der neue Prototypbericht.

Aktuelle Fortsetzung: [Produktivanbindung – Block 4/4: Betriebsvorprüfung](PRODUKTIV-BLOCK-4-BETRIEBSVORPRUEFUNG.md), nach bestandener
[Block-3-Vollabnahme](PRODUKTIV-BLOCK-3-TESTIMPORT.md),
aufbauend auf [Block 2/4](PRODUKTIV-BLOCK-2-ZUORDNUNGEN-ANSICHTEN.md) und
[Block 1/4](PRODUKTIV-BLOCK-1-IMPORTANBINDUNG.md).
Die geschützte Importoberfläche, Stammdaten-Zuordnung und vollständige Zeitraumsauswertung sind lokal angebunden;
1.477.330 Geschäftsdatenzeilen wurden isoliert importiert und vollständig zurückgenommen. Die unabhängig
bestätigte Quellzähler-Abweichung Q01 wurde am 05.09.2026 ausschließlich für den
geprüften Dateifingerabdruck [als Fehlertoleranz freigegeben](Q01-FEHLERTOLERANZ-2026-09-05.md).
Integritäts- und Fremdschlüsselprüfungen des vollständigen Zielimports und seiner Rücknahme sind bestanden.
Die Produktivvorprüfung verlangt noch eine tragfähige Großdaten-Sicherung und Kapazitätsplanung;
die [Großdaten-Backup-Strategie](GROSSDATEN-BACKUP-STRATEGIE.md) wurde dafür mit der inzwischen bestätigten Aufbewahrung von 20 Kalendertagen
überarbeitet, lokal hinter ausdrücklichem Opt-in eingebunden und mit synthetischen Archiv-/Rücksicherungstests geprüft.
Die neuere [Vollbestands- und Wiederherstellungsprüfung vom 07.09.2026](VOLLBESTAND-BETRIEB-RESTORE-2026-09-07.md)
ist abgeschlossen: 1.477.330 Zeilen, 11,60 GB kompaktierte Datenbank, 5,33 GB erste Archivbasis und zwei bestandene unabhängige lokale Restores.
Der frühere Lauf an der Speicherreserve bleibt als historischer Fehlversuch dokumentiert.
Die [Fortsetzung zur Begrenzung der Arbeitskopien](ARBEITSKOPIEN-UND-QUELLSTAENDE-2026-09-07.md) ergänzt lokal eine gemeinsame Sperre
und einen Archivexport ohne zweite Vollkopie auf demselben Laufwerk. Die Gesamt-Kapazitätsfreigabe bleibt offen.
Es gelten ausschließlich die zuletzt vom Nutzer bereitgestellten Quelldateien; auch wochenlang unveränderte Quellen sind zulässig.
Ein normales Backup verlangt keinen erneuten Import. Neue Geschäftsdaten werden erst mit einem neuen bereitgestellten Export geprüft.
Für die ausdrücklich historische Nutzung wurde anschließend der [lokale Einstieg in Block 4](LOKALER-BLOCK-4-START-2026-09-07.md) geprüft:
Auf C: besteht die Start-Platzprüfung; eine dauerhaft nutzbare lokale Installation ist noch einzurichten. Nur den Erstimport lokal auszuführen beseitigt den offenen VPS-Betriebsbedarf nicht.
Die letzte lesende VPS-Prüfung bestätigt getrennte lokale Sicherungsreihen und Google Drive als Offsite-Ziel.
Der lokale Kandidat ersetzt die bisherige 30-Punkte-Zählung durch den letzten vollständigen Stand je Kalendertag für 20 Tage je lokaler Reihe. Die später angesprochenen drei lokalen Stände sind noch keine ausgeführte Änderung. Google Drive behält seine getrennte Langzeitaufbewahrung. Produktiv wurde die Änderung noch nicht ausgeführt.
Kompression und transaktionale Fortschrittszähler sind zusätzlich implementiert; begrenzte Messungen und die vorbereitete vollständige Samstagsumstellung stehen im [Abschlussstand](ABSCHLUSS-VORBEREITUNG-2026-09-06.md).
Kapazitäts-, Laufzeit-, Runtime-/Offsite-Migrations- und produktive Wiederherstellungsabnahme bleiben offen.
Es wurden weder vorhandene Sicherungen entfernt noch produktive Archive aktiviert.
Produktive Übernahme und Veröffentlichung bleiben ausstehend. Die nachfolgenden
Inventurzahlen beziehen sich weiterhin auf den ursprünglichen Analyse-Snapshot.

Fortsetzung: [Block 2/6 – technisches Importfundament](BLOCK-2-IMPORTFUNDAMENT.md)
ist lokal umgesetzt und synthetisch geprüft. Dieses Dokument bleibt der
Inventurstand von Block 1; die Anwendung und die produktiven Fachadapter sind
dadurch noch nicht für den Gesamtimport aktiviert.

[Block 3/6 – Stammdaten und CRM](BLOCK-3-STAMMDATEN-CRM.md) ergänzt lokal
die geschützten Fachprofile und bestätigten GP-Zuordnungen. Auch dieser Stand
aktiviert noch keine produktive Gesamtübernahme; die folgenden Inventurbefunde
und offenen Entscheidungen bleiben unverändert nachvollziehbar.

## 1. Umfang und Ergebnis

Der neue Auftrag umfasst alle verfügbaren Geschäftsdaten, ausdrücklich einschließlich CRM, Kundenhistorie und Verkäuferzuordnung. Die engere, frühere Planung einer personenfreien Verkaufsanalyse ist kein Ausschluss dieser neuen Anforderungen. Ihre bestehenden Schnittstellen und Rechte werden aber nicht stillschweigend erweitert.

Beide bereitgestellten Desktop-Dateien wurden ausschließlich lesend ausgewertet. Erfasst wurden **135 Fachtabellen mit 1.363 Feldern** und **1.509.706 vom Leser gelieferte Fachzeilen**. Auch leere Tabellen wurden katalogisiert. Zwei Metadaten-/Lesezahldifferenzen bleiben ausdrücklich offen; deshalb ist dies noch kein Nachweis einer verlustfreien produktiven Übernahme.

Diese Zählung umfasst alle Nicht-Systemtabellen, also auch die getrennt gekennzeichneten Altprogramm-, Konfigurations- und Protokolltabellen. Die vorgeschlagenen Datenklassen sind Kataloghinweise, keine automatisch vergebenen GP-Berechtigungen.

| Artefakt | Inhalt |
| --- | --- |
| [Vollständiger Feldkatalog](FELDKATALOG.md) | Jedes Feld, Quelltyp, Belegung, Qualitätsmerkmale, vorhandenes oder vorgeschlagenes GP-Ziel und Behandlung |
| [Tabellen und Beziehungen](TABELLEN-UND-BEZIEHUNGEN.md) | Alle Tabellen, Schlüsselkandidaten, 62 deklarierte und 13 zusätzlich geprüfte Beziehungen |
| [Maschinenlesbarer Katalog](catalog.json) | Vollständige Metadaten, aggregierte Profile, Quellen-/Schema-Fingerprints und Prüfergebnisse |

Die Artefakte enthalten keine Namen, Kontaktdaten, Kundennummern, Verkäufernummern, Freitexte, Passwortwerte, Rohpfade oder Bildinhalte. Personenbezogene Datumsbereiche werden ebenfalls nicht veröffentlicht. Zahlen sind aggregierte Quellenbefunde, keine Bewertung einzelner Kunden oder Mitarbeitender.

## 2. Quellen und Grenzen

| Quelle | Dateigröße | Fachtabellen / Felder | Gelesene Fachzeilen | Systemtabellen / Felder |
| --- | ---: | ---: | ---: | ---: |
| `Trade_Daten.accdb` | 188.649.472 Byte | 128 / 1.266 | 427.653 | 25 / 132 |
| `Kassen_Umsätze.accdb` | 330.928.128 Byte | 7 / 97 | 1.082.053 | 26 / 127 |

Beide Dateien haben den Dateisystem-Änderungszeitpunkt 04.09.2026, 15:26:42 UTC (17:26:42 in Wien). Er kennzeichnet die Datei, nicht zwingend den Zeitpunkt einer fachlich vollständigen Sicherung.

- Trade-SHA-256: `42a40cb19d867fcc5d6e6f3429065ba0ff77f65a7b9b7fcfaae3d0b61f8154f3`
- Kassen-SHA-256: `bffbfb81e6f79fe495b0746b36f1fff0abcb89eaf06ec99af16ec7e90add680a`
- Beide Dateihashes wurden nach dem Lesen erneut geprüft: unverändert.
- Die Kasse hat zusätzlich eine verknüpfte Tabelle `ARTIKEL_STAMM`. Der Abgleich verwendet ausdrücklich die bereitgestellte Trade-Datei, nicht ein automatisch geöffnetes Verknüpfungsziel.
- Access-Systemtabellen sind mit Schema und Metadatenzeilenzahl inventarisiert. Nur die Beziehungsmetadaten wurden gelesen. Interne Access-Objekte, Formulare, Makros und Programme werden nicht als GP-Geschäftstabellen importiert oder ausgeführt.

### Lesemethode

Lokaler `mdb-reader` 3.2.0; vollständige Tabellenlesung mit Spaltenprojektion, ohne Geheimnisfelder. Keine Access-Anwendung, kein Browser, kein Netzabruf und kein Zugriff auf eine GP-Anwendungsdatenbank. Der Reader verändert seinen Arbeitspuffer im Speicher; deshalb erfolgt der Quellenhash vor dem Erzeugen des Readers und nochmals am unveränderten Dateioriginal.

Die Bibliothek liefert keine Index-/Primärschlüsseldeklarationen. Eindeutige Schlüsselkandidaten sind daher keine behaupteten Primärschlüssel. Beziehungen werden anhand exakter getrimmter Textwerte geprüft; Access-Kollation, Groß-/Kleinschreibung und zukünftige Normalisierung müssen beim Import gesondert behandelt werden.

Access-Datum/Uhrzeit wird vom Reader als JavaScript-Date mit `Z` dargestellt. Das beweist keine UTC-Speicherung: die Geschäftszeiten sind zunächst lokale Zivilzeiten. Insbesondere ist `Bonzeit` mit Datum 30.12.1899 eine Uhrzeit, kein Verkauf von 1899. Umrechnung und Sommerzeit dürfen Daten nicht um einen Tag oder zwei Stunden verschieben.

## 3. Fachlicher Datenbestand

| Bereich | Verifizierter Bestand | Bedeutung / Grenze |
| --- | --- | --- |
| Kunden | 30.504 Stammsätze, 251 Bemerkungen, 7 Lieferadressen | CRM-Stamm und Kundenbeziehungen; Quelle enthält auch einen Nullnummer-Datensatz |
| Kundenkonditionen | u. a. 33 Preisgruppen, 14 Rabattgruppen, 43 Zahlungsart-Einträge | Preis-/Zahlungs-/Treueinformationen getrennt modellieren, nicht in einem allgemeinen Notizfeld verlieren |
| Artikel | 19.186 gelesene Artikel, 37.817 alternative Kennungen | Bestehenden zentralen Artikelkatalog weiterverwenden; Metadaten nennen einen Artikel mehr |
| Artikelmedien | 29.895 Einträge mit 29.788 unterschiedlichen Bildverweisen | Keine eingebetteten Bilder in dieser Tabelle; externe Dateien werden zusätzlich benötigt |
| Artikelbeziehungen | 500 Bundles, 999 Bundle-Positionen, 1.947 Zubehörbeziehungen | Produkte verbinden, keine doppelten Artikelstämme erzeugen |
| Filialbestände | 231.351 gelesene Artikel-Filial-Zeilen | Bestands-Snapshot, keine vollständige Bewegungsbuchhaltung; Metadaten nennen vier Zeilen mehr |
| Lieferanten | 910 Stammsätze, 967 Adressen, 1.363 Konditionssätze, 3.938 Zweitlieferantenbeziehungen | Eigenes Lieferanten-/Kontakt-/Konditionsmodell nötig |
| Organisation | 13 Filialen, 354 Mitarbeiter-Quellstammsätze | Zuordnung zu GP-Standorten und Personal; keine automatische Übernahme von Anmeldung, Rechten oder Dienstplanwerten |
| Verkäufe | 219.885 Belegköpfe, 385.798 Positionen | Einzelverkäufe vom 02.01.2024 bis 04.09.2026, einschließlich historischer Artikeltexte und Verkäufer-/Kundenverweisen |
| Tagesberichte | 346.921 Zeilen vom 02.01.2017 bis 03.09.2026 | Ältere Tagesaggregate vorhanden, aber daraus keine individuellen Kundenkäufe oder Verkäuferleistungen rekonstruieren |
| Kassenjournal | 39.865 Köpfe, 89.584 Positionen; Positionsdaten vom 16.04.2004 bis 02.09.2026 | Kassen-/Kontobewegungen; nicht gleichbedeutend mit lückenlosen Einzelverkäufen seit 2004 |
| Preis-/Bestandsprotokolle | 94 Preisänderungen am 04.09.2026; 406 aktuelle und 10.159 komprimierte Bestandsprotokollzeilen | Neu vorhanden, aber begrenzter Zeitraum ab 21.08.2026; keine vollständige historische Preisliste behaupten |
| Reparaturen / Exporte | 173 Reparatur-Exportsätze, 74 Werkstätten, 83 Rechnungs-Exportköpfe | Teilbestände; Rechnungsdetails-Export ist leer |
| Shop / Technik | u. a. 10.587 Shopware-Artikelzuordnungen und Altprogramm-Konfiguration | Produkt-/Kanalzuordnung, keine nachgewiesenen Shopbestellungen oder vollständigen Bestellarchive |

## 4. Vorhandene GP-Strukturen und benötigte Erweiterungen

Die letzte Codeprüfung erfolgte auf `feature/schedule-pdf-day-separators`, HEAD `8e0131f3a036fdda2ebd4fcc6aaab45b8a359478`, App v0.92.26-beta. Sie ist keine erneute Prüfung des VPS-Datenbestands.

| Zielbereich | Im GP vorhanden | Für den Gesamtimport noch erforderlich |
| --- | --- | --- |
| Zentraler Artikelstamm | Produktidentität, Quellbindungen, Kennungen, versionierte Preise und direkter Artikel-Access-Import | Erweiterte Artikelattribute, Taxonomie, Bundles/Zubehör, Medien, Lieferanten-/Kundenpreise und Bestands-Snapshots |
| CRM-Kartei | Name/Firma, Kundennummer, privat/gewerblich, eine Adresse, Telefon, E-Mail, Website, UID, Geburtstag, eigene Textfelder, geschütztes Foto, Revision/Audit | Importadapter, Quellbindung, Zusatzkontakte/-adressen, Herkunft von Feldern, Zuordnungsprüfung und Schutz manueller Änderungen |
| CRM-Konditionen / Finanzen | Kein entsprechender vollständiger Import-/Historienbereich | Kundenpreis-/Rabatt-/Zahlungsbedingungen, Treuepunkte, Bank-/Mandatsdaten und historische Salden getrennt und berechtigt ablegen |
| Lieferanten | Noch kein vollständiges Ziel für die hier erfassten Strukturen | Lieferantenstamm, Ansprechpartner, Adressen, Bestellkennungen, Konditionen und Filialbeziehungen |
| Personal / Standorte | Aktuelle GP-Stammdaten und Rechteverwaltung | Versionierte Trade-Quellzuordnung, historische Verkäufer/Filialen, explizite Konfliktauflösung; kein Überschreiben aktiver Personalregeln |
| Einzelverkäufe | Provider-neutraler früherer Modell-/Vorschauvertrag | Produktive Beleg-/Positionspersistenz, Kunde und Verkäufer als neue geschützte Verknüpfungen, deterministischer Import und Fachstatusregeln |
| Verkaufsanalysen | Aggregierte PDF-Berichtsimporte, Profile, Zuordnungen und vorhandene Analyseansichten | Tagesgenaue Einzelverkaufsbasis und Mitarbeiter-/Kundenprojektionen; alte PDF-Aggregate und Einzelbelege nicht doppelt summieren |
| Kassen-/Finanzhistorie | Kein vollständiges Ziel für diese Access-Tabellen | Journal, Tagesbericht, Konten-/Zahlungsreferenzen, Herkunft und Abgrenzung zu Umsätzen |
| Reparaturen / Altbelege | Kein vollständiger Import für diese Quelle | Geschützte historische Datensätze und später fachlich definierte Verknüpfungen; keine neuen operativen Vorgänge aus Exportresten erzeugen |
| Importsteuerung | Einzelne Artikel-/Berichtsimportmechanismen und Audit-Infrastruktur | Quellenunabhängiger Lauf-/Stagingvertrag, Vollständigkeitsmanifest, Prüfung aller Bereiche, wiederholbare Übernahme und kontrolliertes Rückgängigmachen |

Codeanker: [CRM-Schema](../../lib/persistence/sqlite/operations/crm-schema.js), [CRM-Validierung](../../lib/crm-customers.js), [CRM-Repository](../../lib/persistence/repositories/crm-customers.js), [Artikel-Quellprofil](../../lib/tradefoto-article-source-profile.js), [bisheriger Analysevertrag](../../lib/sales-analytics-model.js).

### CRM-Feldregeln

- Die 12 direkt vorgeschlagenen Zuordnungen betreffen vorhandene CRM-Felder; sie sind noch kein fertiger Kundenimport.
- `KUND_NR` bleibt die externe Kundennummer. GP verwendet zusätzlich seine eigene stabile Identität und eine Quellbindung. Gleiche E-Mail-Adressen, Namen oder Telefonnummern sind keine ausreichende Grundlage für automatisches Zusammenführen.
- `NACHNAME` darf Firmenbezeichnungen enthalten. „Privat/gewerblich“ und Firmenname sind nicht zuverlässig allein aus einem leeren Vornamen oder einem Großhandelskennzeichen bestimmbar.
- `KUNDEN.Internet` ist ein Boolean und **keine Website-Adresse**. Keine Website erfinden. Zusätzliche Telefonnummern, Rechnungs-E-Mail und Fax brauchen eigene Kontaktfelder.
- Lieferadressen gehören über `KID` zum Kunden. Alle sieben Werte des zusätzlichen Felds `KUND_NR` sind 0; dieses Feld darf nicht als Zuordnung verwendet werden.
- Quellnotizen, freie GP-Textfelder und importierte Zusatzattribute erhalten getrennte Herkunft. Ein Folgeimport darf manuell ergänzte GP-Felder und Fotos nicht ersetzen.
- Salden, Bonusstände und das Feld `Umsatz` sind Quell-Snapshots, keine aus Einzelverkäufen bestätigten Kontostände oder neue Finanzbuchungen.

### PostgreSQL-kompatible Richtung, noch keine Aktivierung

Neue Verträge müssen unabhängig vom Datenbankanbieter sein: stabile interne IDs plus eindeutige `(source_system, entity, source_key)`-Bindungen; Kennungen als Text; getrennte lokale Datums-/Zeitfelder und technische UTC-Zeitpunkte; echte Booleans; exakte Dezimalwerte für Geld, Mengen und Prozente. Access-Currency wird als Dezimalzeichenfolge übernommen; spätere SQL-Persistenz verwendet geeignete `NUMERIC`-Typen, keine Float-Geldsummen. Bereits als Float gespeicherte Quellbeträge müssen mit expliziten Rundungs- und Abstimmungsregeln behandelt werden.

Keine fachliche Identität aus SQLite-`rowid`, kein SQLite-only-JSON für zentrale Beziehungen und keine ungetestete Provider-Aktivierung. CRM ist aktuell im SQLite-Anwendungsslice vorhanden; PostgreSQL-Parität ist ein später zu prüfendes Ergebnis, noch kein vorhandenes Gesamtimportmerkmal.

## 5. Qualitätsbefunde und offene Entscheidungen

Die folgenden Tore sperren jeweils die betroffenen Import-/Auswertungsfunktionen, nicht die weitere Bestandsaufnahme. Originale Werte bleiben nachvollziehbar; fehlende oder widersprüchliche Daten werden nicht still ergänzt, gelöscht oder als gültige Kennzahl verwendet.

| Tor | Beleg / Problem | Vorgeschlagene sichere Behandlung | Vor welchem Schritt klären? |
| --- | --- | --- | --- |
| Q01 Lesedeckung | Artikel 19.187 laut Metadaten gegenüber 19.186 gelesen; Artikel-Filialen 231.355 gegenüber 231.351 | Gegen unabhängigen Access-Leser/Export oder belegte Löschsatzsemantik prüfen. Keine Quellreparatur und keine behauptete Vollständigkeit ohne Erklärung | Block 2: Import-Vorprüfung |
| Q02 Umsatzsemantik | 18.735 negative Mengen; `AStorno` 151.222-mal true, andere Storno-/Retourenflags überwiegend durchgängig false; Rabatte/Status nicht selbsterklärend | Fachlich bestätigte Muster für Verkauf, Retoure, Storno, Bundle, Rabatt und Steuer; Soll-/Istpreise erhalten, Rabatte nicht doppelt abziehen. Journal und Tagesbericht separat | Block 4 vor Kennzahlenfreigabe |
| Q03 Kundentyp / Qualitätsfälle | 815 Stammsätze ohne Vor- und Nachname; aktuelle Feldvalidierung beanstandet 183 E-Mails, 44 UID-Werte sowie einzelne Namens-/Adresswerte | Vollständig im geschützten Prüfbestand behalten; keine erfundenen Personen, kein stilles Weglassen. Firmenzuordnung und Reparaturen gezielt bestätigen. 596 Gruppen geteilter E-Mail-Adressen nicht automatisch zusammenführen | Block 3 |
| Q04 Verkäuferzuordnung | 71 Kennungen einschließlich 0; 51.526 Positionen haben weder im Kopf noch in der Position eine bekannte Kennung. 1.378 Positionen mit verschiedenen nicht-null Verkäuferkennungen; 5.097 mit Positionskennung, aber Kopfkennung 0 | Beide Rollen erhalten. Vorschlag: Positionskennung für Warenumsatz, Kopfkennung separat als Belegverkäufer; 0 bleibt „nicht zugeordnet“. Keine Gleichsetzung mit GP-Personalnummer ohne Mapping. Regeln und Sichtrechte bestätigen | Block 3/4, Auswertung Block 5 |
| Q05 Fehlende historische Stammdaten | 7.625 Belege mit 6.040 Kundennummern ohne aktuellen Kundenstamm; 7.755 Positionen mit 1.253 Artikelschlüsseln ohne aktuellen Artikel | Historische Quellidentität und Belegtexte erhalten. Gezielte Altstamm-Zuordnung oder expliziter historischer Platzhalter; nicht verwerfen oder auf einen beliebigen aktiven Datensatz umhängen | Block 3/4 |
| Q06 Nicht eindeutige / leere Identitäten | `LIEFERANTEN.Lieferant_ID` einmal doppelt, `Suchname` im Snapshot eindeutig. Vorgeschlagener Tagesbericht-Kompositschlüssel hat 192.271 zusätzliche Dubletten und einen NULL-Fall | Deklarierte Schlüssel unabhängig prüfen. Keine Deduplizierung anhand unbewiesener Schlüssel; identische Rohzeilen dürfen echte Mehrfachvorkommen sein. Snapshot-/Zeilenherkunft und zulässige Folgelaufstrategie definieren | Block 2/3/4 |
| Q07 Historische Datums-/Standortwerte | Tagesberichte haben 28.683 Zeilen zu drei nicht aktuellen Filialcodes; Journalpositionen 9.467 zu fünf. Journalköpfe enthalten 22.193 leere Datumswerte und ein Datum bis 30.12.2026 | Historische Filialen gesondert zuordnen. Kopf-/Positionsdatum getrennt; keine Zukunftswerte ungeprüft als erfolgten Umsatz buchen. Zeitzonen-/Tagesgrenzentests festlegen | Block 3/4 |
| Q08 Medien / weitere Quellen | 29.895 Artikelbildverweise, aber keine eingebetteten Bilddaten. Kunden-Dokumente und Rechnungsdetail-Export sind leer; viele weitere Altvorgangstabellen ebenfalls | Bildordner und gegebenenfalls separate Beleg-/Reparatur-/Bestelldateien später ausdrücklich bereitstellen lassen. Kein automatisches Öffnen lokaler/UNC-Pfade oder URLs | Block 3, ergänzende Quellen vor Block 6 |
| Q09 Rechte / Geheimnisse | Drei Passwortfelder sowie alte Menü-/Zugangsregeln; daneben geschäftliche Kundenbank-, Mandats- und Personalinformationen | Passwortwerte werden nicht inventarisiert oder in GP-Auth übernommen. Altzugangsregeln nur als isolierte Referenz; Finanz-/CRM-/Personaldaten mit eigener Berechtigung. Keine automatische Rechteausweitung, insbesondere keine Developer-Rechte aus Altrollen | Block 2/3 |
| Q10 Ungeklärte Zusatzfelder | 992 Felder als vorgeschlagene Zielerweiterung, 297 als getrennte Alt-/Prüfablage, 10 mit explizitem Fachregel-Tor | Jedes Feld ist einem Bereich zugeordnet; `source_fields[...]` bedeutet verlustbewahrende typisierte Herkunft, nicht bereits finalisierte Fachsemantik. Bereichsweise konkretisieren, statt unbekannte Werte zu verwerfen | Jeweiliger Folgeblock |
| Q11 Konflikte / Rückgängigmachen | Bestehende GP-Artikel, manuelle CRM-Änderungen und spätere Vorgänge dürfen durch Folgeimporte nicht verloren gehen | Quell-/Feldherkunft und Revisionen; Dubletten-/Konfliktvorschau, transaktionale Batches, protokollierte Änderungen. Rücknahme nur bei unveränderter Folgerevision und ohne widersprechende abhängige Vorgänge; sonst Konflikt anzeigen | Block 2, Endprüfung Block 6 |
| Q12 Weitere verwaiste Beziehungen | 588 Artikel mit zwei unbekannten Lieferantenschlüsseln; 130 Zweitlieferantenzeilen mit drei; vier Kunden mit unbekannter Kundengruppe | Quelldefinitionen nachfordern oder Beziehungen als ungeklärt erhalten. Keine stillen Standardzuordnungen | Block 3 |

Zusatzbefunde:

- Sämtliche 385.798 Verkaufspositionen haben einen passenden Belegkopf; zwei Belegköpfe haben keine Positionen. Dies muss im Laufbericht sichtbar bleiben.
- 192.648 Belege haben Kundennummer 0. Daraus entsteht keine gemeinsame personenbezogene Kaufhistorie eines vermeintlichen Kunden „0“.
- 19.612 Belege sind direkt einem vorhandenen, nicht-null Kunden zuordenbar. Fehlende Stammdaten verhindern nicht die Erhaltung der übrigen Belege.
- Alle nicht-null Verkäuferkennungen der aktuellen Einzelverkäufe sind im Trade-Mitarbeiterstamm vorhanden. Das ist noch kein Mapping auf aktuelle GP-Accounts oder GP-Personalnummern.
- 115 Positionen haben gebrochene Mengen. Keine globale Umwandlung in ganzzahlige Stückzahlen.
- Die beiden Bestandsprotokolltabellen haben im Snapshot keine gemeinsame `ID`. Das beweist keine fachliche Überschneidungsfreiheit bei unterschiedlich vergebenen IDs.
- Die alternative Artikelkennung löst in dieser Quelle keine zusätzlichen historischen Verkaufspositionen auf; fehlende Altschlüssel bleiben ein eigener Befund.

## 6. „Alle Daten“ und bewusst getrennte Ablagen

Jede Fachtabelle und jedes Feld bekommt eine dokumentierte Behandlung: vorhandenes GP-Feld, fachliche Erweiterung, typisierte Prüf-/Herkunftsablage oder begründete Ausnahme. Auch aktuell leere Tabellen bleiben Teil des Schemas. Es gibt kein stilles Verwerfen unbekannter Spalten.

„Alle Geschäftsdaten“ bedeutet nicht, alte Passwörter, ausführbare Makros, Zugangskonfigurationen oder Programmfehlerprotokolle als aktive GP-Einstellungen anzuwenden. Geheimnisse bleiben Ausnahme; Access-interne Strukturen bleiben Quellmetadaten. Eine gegebenenfalls später aufbewahrte Originaldatei benötigt einen separaten geschützten Speicher- und Löschplan und gehört niemals in Git, öffentliche Downloads oder normale App-Logs.

Kundenfinanzdaten dürfen im vorgesehenen Gesamtumfang erhalten werden, sind aber von einer gewöhnlichen CRM-Leseberechtigung zu trennen. Alte Newsletter-/Internetkennzeichen lösen weder Versand noch eine neue Einwilligung aus. Diese Inventur ist keine rechtliche Bewertung von Aufbewahrungs- oder Nutzungsbefugnissen.

## 7. Vorgesehene Abfolge ab Block 2

1. **Block 2 – Importfundament:** allgemeiner Importlauf, Quellenmanifest, Schema-/Zeilenprüfung, Staging, Vorschau, wiederholbare Quellidentitäten, Konflikte, Audit und kontrollierte Rücknahme. TradeFoto ist ein Adapter, kein exklusiv für einen Betrieb gebauter Importkern. Keine ungeprüfte „alles übernehmen“-Schaltfläche.
2. **Block 3 – Stammdaten / CRM:** zuerst Referenzen und explizite Standort-/Personalzuordnung, danach Lieferanten und erweiterter zentraler Artikelstamm, Kundenstamm, Kontakte, Adressen und Konditionen. Alle Altidentitäten bleiben nachverfolgbar.
3. **Block 4 – Verkaufs-/Kassenhistorie:** Belegköpfe vor Positionen, historische Kunden-/Artikelverweise, Verkäuferrollen und Statusregeln; Journale und Tagesberichte als eigene Datenarten. Bestands-/Preisprotokolle nicht als vollständige Historie ausgeben.
4. **Block 5 – GP-Ansichten:** Tages-/Zeitraum- und Mitarbeiteranalysen, Kundenkäufe, nachvollziehbare Filter, Quellabdeckung und sichtbare „nicht zugeordnet“-Anteile; Berechtigungen und datensparsame Projektionen.
5. **Block 6 – Testimport und Abschlussprüfung:** gesicherte Testumgebung, Vorher-/Nachherzahlen, Detail-/Summenabgleich gegen bestätigte Quellberichte, Wiederholungsimport ohne Doppelzählung, Konfliktfälle, Abbruch/Wiederaufnahme, Rücknahme, Rechte- und Provider-Vertragstests. Produktionsübernahme und Veröffentlichung nur nach gesondertem Auftrag.

Der tatsächliche Gesamtumfang zusätzlicher Dokumente, Bilder und Vorgangsarchive kann erst nach Bereitstellung dieser Quellen zugesagt werden. Die aktuelle Inventur deckt die zwei genannten Datenbanken ab, nicht pauschal sämtliche Dateien des alten Systems.

## 8. Reproduktion und Prüfnachweis

Die Analysewerkzeuge schreiben ausschließlich Katalog-/Dokumentationsartefakte. Die Quellpfade werden als Argumente übergeben; sie sind weder fest einprogrammiert noch Bestandteil des veröffentlichten Berichts.

```text
node --check scripts/inspect-tradefoto-catalog.mjs
node --check scripts/render-tradefoto-catalog.mjs
node --max-old-space-size=4096 scripts/inspect-tradefoto-catalog.mjs TRADE.accdb CASH.accdb docs/tradefoto-gesamtimport-v0.1/catalog.json
node scripts/render-tradefoto-catalog.mjs docs/tradefoto-gesamtimport-v0.1/catalog.json --write
node scripts/render-tradefoto-catalog.mjs docs/tradefoto-gesamtimport-v0.1/catalog.json --check
git diff --check
```

Ein vorhandener, vom Werkzeug erzeugter JSON-Bericht wird nur mit dem ausdrücklich angegebenen Zusatz `--replace-report` ersetzt. Die Quellen werden nie beschrieben. Generierte Markdown-Dateien werden nur ersetzt, wenn sie den passenden Generatorvermerk tragen.

Prüfungen: Schema-/Feldabdeckung, Profilzeilenzahlen, NULL-/Vorzeichen-/Boolean-/Datumszählungen, Beziehungsbilanz, Schlüsselbilanz, Verkäuferrollenbilanz, Schutz von Geheimnis-/Personendatumsfeldern, drei negative Regressionstests sowie Übereinstimmung der generierten Dokumentation. Geldsummen wurden bewusst nicht mit JavaScript-Floatarithmetik als geprüft ausgegeben.

Im Rahmen von Block 1 wurden keine App-Funktionen, produktiven Datenbanktabellen, Migrationen, Versionen oder Zugänge verändert. Die damalige App-Vollsuite wurde für die reine Dokumentations-/Offlineanalyse nicht erneut ausgeführt. Die ausdrücklich freigegebenen Fortsetzungen sind in [Block 2](BLOCK-2-IMPORTFUNDAMENT.md), [Block 3](BLOCK-3-STAMMDATEN-CRM.md), [Block 4](BLOCK-4-VERKAUFS-KASSENHISTORIE.md), [Block 5 – GP-Ansichten](BLOCK-5-GP-ANSICHTEN.md) und [Block 6 – Prüfung/Abnahme](BLOCK-6-PRUEFUNG-UND-ABNAHME.md) festgehalten. Block 5 ist lokal implementiert; Block 6 enthält den abgesicherten Testimport und Prüfstand, aber noch keine fachliche Summen-/Produktivfreigabe. Kein produktiver Import, Commit, Push oder Deploy.
