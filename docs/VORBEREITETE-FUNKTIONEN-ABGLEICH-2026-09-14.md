# Abgleich vorbereiteter Funktionen mit dem produktiven GP

Stand: 14.09.2026, 19:12 CEST. Auftrag: vollständig prüfen, welche bereits
vorbereiteten Funktionen noch fehlen. Veröffentlichung ausdrücklich zurückgestellt.

Fortschreibung: Der Benutzer hat anschließend alle sechs Integrationsblöcke und
den Deploy bei bestandener Abnahme ausdrücklich freigegeben. Der folgende Text
beschreibt den damaligen Prüfstand; aktueller Nachweis in
`INTEGRATION-SECHS-BLOECKE-2026-09-14.md` und `DEPLOY-RELEASE-v09246.md`.

Die vollständige Übergabe aus **„Trade-DatenBestell prüfen“** enthält mehr als
die später veröffentlichten grundlegenden Suchfunktionen. Die Preis-/RE-Rechner,
erweiterten Artikeldetails, zusätzlichen Belegfilter und ZA-Anträge des
Filialkontos wurden noch nicht in den aktuellen GP integriert. Die Pakete sind
erhalten; es handelt sich um fehlende Integration, nicht um verlorenen Code.

## Prüfbasis und Aussage

- Hauptcheckout: `Grabenplaner-v0927-function-search`, Branch
  `feature/schedule-pdf-day-separators`, HEAD
  `c987bcf8233677edba4d4d0790ee449715c636ad`.
- Direkter lesender VPS-Abgleich am 14.09.2026 um 17:12:17 UTC:
  **v0.92.45-beta**, untersuchte installierte Dateien entsprechen nach
  Normalisierung der Zeilenenden dem veröffentlichten Quellcommit
  `ebeadc74a0e9cbeb54ba6f302048200a8a62901e`.
- 23 konkrete Programmdateien auf Vorhandensein und gegebenenfalls Hash geprüft.
  Zusätzlich Routen, Kontorechte und sichtbare Formulare im Hauptcheckout gelesen.
  Eine fehlende Datei allein wurde nicht als Beweis einer fehlenden Funktion
  gewertet; insbesondere verwendet der Bestellimport bereits den neueren
  gemeinsamen Importpfad.
- Beide maßgeblichen Vorbereitungspakete erneut mit Manifest, Quellen-ZIP und
  Arbeitsverzeichnis verglichen: **61 Bestell- und 41 Filialkonto-Quelldateien
  unverändert bestätigt**.
- Originalaufträge und Abschlussantworten der archivierten Aufgabe
  `Trade-DatenBestell prüfen` (`01a09745-cb50-7ef3-8931-1dd0e139174d`), Gesamtübergabe,
  Übernahmebestätigung, vier Filialkonto-Dokumente, Bestell-Abschluss und
  Releaseberichte v43/v44/v45 berücksichtigt.
- Neue technische Evidenz: `tmp/prepared-feature-audit-20260914.json`;
  zugehöriger lesender Prüfer: `tmp/prepared-feature-audit-20260914.py`.
- Keine neue Funktions-/Lastprüfung und kein produktiver Import in diesem Audit.
  Frühere lokale Testergebnisse sind kein aktueller Nachweis einer nativen
  PostgreSQL-Integration der noch fehlenden Funktionen.

## Filialkonto: lokal implementiert, im aktuellen GP noch nicht integriert

Alle Zeilen dieser Tabelle betreffen ausdrücklich das **Filialkonto**. Vorhandene
Funktionen im persönlichen Artikelstamm, CRM oder Mitarbeiterportal sind damit
nicht automatisch auch dem Filialkonto zugänglich.

| ID | Fehlender Umfang | Vorbereiteter Stand |
| --- | --- | --- |
| FIL-01 | RE-Anzeige und beide Rechner | Unter Filial-VK und Internet-VK RE in Prozent und Netto-Euro; positive/negative Werte grün/rot. Brutto-Wunschpreis → RE sowie Ziel-RE → Brutto-VK, ohne gespeicherte Preise zu ändern. Verbindliche Grundlage ist `ARTIKEL_STAMM.DurchschnittEK` netto, ohne Ersatz durch NNPreis/DEK_A. |
| FIL-02 | Kompakte aufklappbare Artikelkarten | Sechsstellige Artikelnummer vor der Bezeichnung; Quellstatus wie Stamm, keine LW, Abverkauf, EOL oder Auslauf; Preise in eigener rechter Spalte. Nicht passende längere/alphanumerische Kennungen bleiben vollständig. |
| FIL-03 | Bestand, Bild und Produktlinks im Filialkonto | Eigener Filialbestand mit Datenstand; andere Filialbestände per Hover, Klick oder Tastatur; vorhandenes GP-Produktbild und vorhandene Produkt-/Geizhals-/Idealo-Links. Kein automatischer Abruf von Geizhals-Bildern. |
| FIL-04 | Erweiterte Filial- und Verkäuferfilter für Belege | Eigene Filiale als Vorgabe; einzelne/mehrere Quell-Filialen, Bestandsgruppe 05/11/13/18/77/99 und Internetgruppe 00/03/70/90; bis zu 20 Personalnummern mit Beistrich, exakte Oder-Suche nach Belegverkäufer im Kassenkopf. |
| FIL-05 | Kundensuche und zugeordnete Daten bei Filialbelegen | Genau ein Feld für Name, Adresse, Nummern, Telefon/Handy und E-Mail; zugeordnete Kunden- und Belegverkäuferdaten in Treffer, Detail und PDF. Vorhandene CRM-Korrekturen bleiben maßgeblich. |
| FIL-06 | ZA-Anträge über das Filialkonto | Eigene, standardmäßig ausgeschaltete Freigabe; zuerst Mitarbeiterauswahl der Stammfiliale, dann stunden-/ganz-/mehrtägiger ZA. Dienstplan der Antragswoche und Monatsübersicht, bestehende Zuständigkeitsprüfung und Genehmigung, nachvollziehbarer Filialkonto-Akteur. |

Belegsuche und Artikelsuche haben bereits ihre getrennten Freischaltungen.
Die zusätzliche ZA-Freischaltung fehlt noch. Die aktuellen Filial-Belegrouten
akzeptieren nur Zeitraum, Artikeltext, Belegreferenz und Fortsetzung; andere
Filialen, Verkäufer und Kunden sind dort noch nicht angeschlossen.

Maßgebliche Vorbereitung:
`Grabenplaner-filialkonto-za-20260913/output/filialkonto-belegfilter-uebergabe`.
Die Dokumente `filialkonto-artikel-details-2026-09-13.md`,
`filialkonto-belegfilter-2026-09-13.md` und `filialkonto-za-2026-09-13.md`
enthalten die Einzelheiten. Die jüngste Fassung ersetzt ausdrücklich die
Beschränkungen des frühen Suchpakets.

## Bestell-, Bestands- und Reparaturvorbereitung

Die zwölf damaligen Blöcke waren **Vorbereitungsblöcke** für Import, Lesemodule,
Auswertungsregeln und eine lokale Vorschau. Sie sind nicht zwölf fehlende
PostgreSQL-Migrationsblöcke; die Hauptmigration ist abgeschlossen.

| ID | Bereich | Aktueller Stand und fehlender Anschluss |
| --- | --- | --- |
| BEST-01 | Dritte ACCDB-Quelle und geschützte Importhistorie | Bereits integriert/veröffentlicht: 21 Geschäftstabellen, zentrale Importseite, verschlüsselte versionierte Quellstände und Wiederaufnahme. Der alte Vorschlag mit vier weiteren Speichertabellen wurde durch den vorhandenen gemeinsamen Importpfad ersetzt und muss nicht zusätzlich eingebaut werden. Ein veröffentlichter Importweg beweist nicht, dass der letzte Benutzerimport vollständig übernommen wurde. |
| BEST-02 | Einkauf und Filialversorgung | Lokale Projektionen für Bestellmengen, kumulierte Lieferstände, Lieferantenprüflisten und vermerkte Umlagerungen vorhanden; zugehörige GP-Ansichten und Anbindung an aktuelle Quellen fehlen. Die vorhandene allgemeine GP-Filialbestellung ist eine andere Funktion. |
| BEST-03 | Filialpreisvergleich und Absatz-/Bestandsverknüpfung | Lokale Monats- und Preisprojektionen vorhanden. Allgemeine Kassen-Zeitverläufe sind im GP bereits über Berichte/Grafiken verfügbar; der neue Vergleich gebuchter Artikelpreise zwischen Filialen und die gemeinsame Bestands-/Versorgungssicht fehlen noch. |
| BEST-04 | Langsamdreher, Reichweite und Klassifikation | Berechnungsgrundlage und bedienbarer Gruppenentwurf lokal vorhanden. Produktive Kennzahlen, Pflege der Klassifikation und native Datenanbindung fehlen. Bestätigte Grundregeln: Lagerware/Dienstleistungen/Buchungsartikel/Sonderfälle, Artikel-Ausnahmen, Vorrang Sachkonto/OhneBestand, 90/180 Tage bei positivem Filialbestand. Konkrete ungeklärte Gruppen und fehlende Verkaufsabdeckung bleiben ausdrücklich ungeklärt. |
| BEST-05 | Gemeinsame Kunden- und Gerätehistorie | Lokale Verknüpfungen von Rechnung, Teilzahlung, Angebot, Auftrag, Reparatur und Kassenbezug sowie Seriennummernsuche vorhanden. Produktive Einbindung in GP/CRM einschließlich größerer Historien und aktueller Rechte-/Quellbindung fehlt. Der vorhandene CRM-Kundenstamm bleibt davon zu unterscheiden. |
| BEST-06 | Reparatursuche, Details und Auswertungen | Lokale Suche, Seitenwechsel, Details und Projektionen dokumentierter Reparaturstände vorhanden. Produktive Reparaturansicht fehlt. Der Erhalt importierter Reparaturen bei später fehlenden Quellzeilen ist dagegen bereits im gemeinsamen Importpfad abgesichert und veröffentlicht. |

Im produktiven `lib/tradefoto-bestell` sind `metadata.json` und `profiles.js`
enthalten. Die vorbereiteten Fachmodule `purchasing.js`, `analytics.js`,
`classification.js`, `customer-history.js`, `repairs.js` und `read-service.js`
sind im aktuellen Hauptstand nicht angeschlossen. Ihre alten Reader-/Store-
Prototypen dürfen den inzwischen weiterentwickelten Hintergrundimport nicht
ersetzen.

Maßgebliche Vorbereitung:
`output/GP-Bestell-Vorbereitung-2026-09-13`, insbesondere
`ABSCHLUSSBERICHT.md`, `UEBERGABE-GP1.md` und `Dokumentation/INTEGRATION.md`.

## Weiter offen, aber noch keine fertige vergessene Erweiterung

- **Eigene GP-Reparaturstatus „abholbereit“ und „abgeholt“:** fachlich vereinbart,
  noch zu entwickeln. TradeRepair `erledigt` bedeutet abholbereit, nicht bezahlt
  oder abgeholt; auch abgelehnte Reparaturen können erledigt sein. Die KVA-
  Pauschale bleibt bei Ablehnung bestehen. Die späteren Hauptchat-Entscheidungen
  in [BESTELL-BESTAETIGTE-FACHREGELN-2026-09-13.md](BESTELL-BESTAETIGTE-FACHREGELN-2026-09-13.md)
  ersetzen die älteren offenen Fragen des Vorbereitungspakets.
- **Vollständiges Wareneingangsjournal und echtes Lageralter:** die zusätzliche
  Quelle zu `WEID`/`WEID_Wien` fehlt weiterhin in den bereitgestellten drei
  Datenbanken. Bestell-/Liefermengen ersetzen einzelne Wareneingangsbuchungen
  nicht. Diese Lücke verhindert den Artikelrechner mit Durchschnitts-EK nicht.
- **Allgemeine Online-Gruppe:** Berichte behalten 00/70/90. Nur für die explizit
  vorbereitete Filial-Belegsuche wurde zusätzlich 03 vereinbart.
- **Android/Drive-Dateidialog und neuer großer Live-Import:** die Mobil- und
  Hintergrundkorrekturen sind veröffentlicht; die damalige offene praktische
  Abnahme ist keine fehlende Codeübernahme. Dieses Audit hat keine neue Datei
  hochgeladen und keinen erfolgreichen Folgeimport behauptet.

## Bereits im Hauptcheckout vorbereitet, Veröffentlichung noch ausstehend

Die Beschleunigung der Dienst-/Urlaubsplanung und des Wochen-/Jahreswechsels
liegt in `server.js`, `public/app.js` und zwei neuen Testsuiten. Der vorhandene
Nachweis umfasst 40 bestandene Tests; im heutigen Abgleich ist die Änderung
auf dem VPS noch nicht enthalten. Die endgültige produktive Ladezeit ist nach
einer späteren Veröffentlichung zu messen. Details:
[PLANUNG-LADEZEITEN-2026-09-14.md](PLANUNG-LADEZEITEN-2026-09-14.md).

## Bereits veröffentlicht und nicht erneut als fehlend einplanen

- Grundlegende Artikel-/Belegsuche im Filialkonto samt getrennter Freigaben
  und Beleg-PDF: v44.
- Getrennte WGR-/Sortimentsauswahl, gespeicherte Berichtsvorlagen und
  Grafik-PDF-Zeitverläufe: v44.
- Bestätigte Anzahlungsregel: v43; die zwei Nettobelegköpfe bei MA 419: v44.
  Frühere Entscheidungen zu Kassen-Rohertrag, Gutscheinen, Rabatten, Rücknahmen,
  UID und Steuerkennzeichen bleiben bestehen. Alte PDFs werden nicht nachträglich
  überschrieben; korrigierte Auswertungen benötigen eine neue Berichtserstellung.
- Aufgeräumte Einstellungen, zentrale drei ACCDB-Importe, PostgreSQL-Version
  in der Fußzeile und aufbewahrte Reparatur-Quellhistorien: v43.
- Dauerhafte Hintergrundprüfung nach abgeschlossenem Upload, befristete
  verschlüsselte Dateiablage, begrenzte automatische Wiederholungen und
  Mobilkorrekturen: v45.
- Zwei PostgreSQL-Datenbanken, zwei lokale Sicherungspaare und gemeinsamer
  Nachtlauf: bereits eingerichtet; kein erneuter Migrationsauftrag offen.
- Eigene Artikelbilder im persönlichen Artikelstamm, größenveränderliche
  Trefferliste und GP-Navigation per Browser-Zurück sind bereits implementiert.
  Die noch fehlende Filialkonto-Bildanzeige ist ein eigener Anschluss.

## Ursache und weitere Integration

Die vollständige Gesamtübergabe wurde am 13.09.2026 angenommen. Beim späteren
Suchfreigaben-Block wurde nur der frühere grundlegende Suchumfang in v44
übernommen. Das ist im damaligen Releasebericht ausdrücklich dokumentiert;
die neueren Filialkonto-Erweiterungen wurden dadurch nicht automatisch
mitgeliefert. Bei der Bestellvorbereitung wurde bisher der Importanschluss,
aber noch nicht der gesamte Analyse-/Bedienumfang integriert.

Für die Fortsetzung ist die jüngste vollständige Übergabe maßgeblich. Die
schon veröffentlichten Worker-, Rechte- und Importkorrekturen sowie die lokalen
Planungsoptimierungen müssen beim Zusammenführen erhalten bleiben. Alte
Gesamtpatches nicht ungeprüft über den weiterentwickelten Hauptstand legen.
ZA benötigt eine gezielte native PostgreSQL-Prüfung des Antrag-/Genehmigungswegs;
Artikel-/Belegerweiterungen benötigen insbesondere Tests der aktuellen Quellen,
Kontorechte und Laufzeiten. Ein früheres lokales PASS ersetzt diesen Anschluss
nicht.

Dieser Auftrag hat ausschließlich den Abgleich und diese Bestandsliste erstellt.
Keine Funktion wurde neu aktiviert, kein Antrag gestellt und keine produktive
Datei oder Datenbank geändert. Kein Commit, Push, Deploy oder Neustart.
