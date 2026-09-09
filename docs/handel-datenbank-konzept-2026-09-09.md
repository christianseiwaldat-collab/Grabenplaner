# Kassa, Einkaufspreise und eine getrennte Handelsdatenbank

Stand: 09.09.2026. Bestandsaufnahme und Architekturvorschlag, keine umgesetzte
Datenbanktrennung. Die Prüfung der Access-Quelle war ausschließlich lesend und
beschränkte sich auf Tabellen, Spalten und Zeilenzahlen.

## Welche Einkaufsdaten liegen vor?

Die lokal vorliegende `Kassen_Umsätze.accdb` enthält sieben Tabellen:

| Tabelle | Zeilen | Einordnung anhand der Spalten |
| --- | ---: | --- |
| `Umsatz_KASSE` | 219.920 | Verkaufsköpfe / Belege |
| `Umsatz_Kasse_Details` | 385.877 | Verkaufspositionen |
| `KassenJournal` | 39.865 | Kassenjournal |
| `KassenJournal_Details` | 89.584 | Ein-/Auszahlungen und Kontenzuordnung |
| `Tagesbericht` | 346.921 | Tagesberichte mit Einnahmen-/Ausgabenangaben |
| `EigeneKonten` | 0 | Kontenstruktur ohne Datensätze |
| `ExportRichtTabelle` | 0 | Exportstruktur ohne Datensätze |

Die Datei enthält somit mehr als Verkäufe. Es wurde aber keine Tabelle mit
Waren-Einkaufspositionen gefunden, die Artikel, eingekaufte Menge und den
tatsächlichen Einkaufspreis zusammen enthält. Eine Auszahlung im Kassenjournal
ist noch kein solcher Wareneinkauf.

Die Verkaufspositionen enthalten `DEK_A` und `TDEK`. Ihre fachliche Bedeutung ist
noch nicht bestätigt; allein aus dem Feldnamen lässt sich weder ein tatsächlicher
Einkauf noch dessen Bewertungsbasis ableiten. Bestätigt ist dagegen
`RohertragDM × VKMenge` als Positionsrohertrag. Dieser Kassenwert bleibt die Quelle
für den Rohertrag der Berichte.

Im vorhandenen Trade-Feldkatalog gibt es bereits
`ARTIKEL_STAMM.DurchschnittEK`. Das Artikelprofil übernimmt diesen Wert als
`average_purchase`; Netto-/Bruttobasis und Qualität stehen noch auf
`unknown`/`unresolved`. Dieser Quellwert sollte zuerst mit einem nachvollziehbaren
Trade-Beispiel abgeglichen werden. Das könnte eine zusätzliche Einkaufsdatenbank
für die reine Anzeige des von Trade berechneten Durchschnitts überflüssig machen.
Es ersetzt keine eigene historische Einkaufsanalyse.

`WE_Kontrolle` im Trade-Feldkatalog enthält zwar Mengen, Datum und
Lieferscheinbezüge, aber keinen Einkaufspreis und nur einen kleinen historischen
Ausschnitt. Diese Tabelle genügt ebenfalls nicht für einen belastbaren
Einkaufsdurchschnitt. Die Trade-Aussagen beruhen auf dem vorhandenen Feldkatalog
und dem aktuellen Importprofil, nicht auf einer neuen vollständigen Trade-Prüfung.

Für einen selbst berechneten, mengengewichteten Einkaufs-EK wären vollständige
Wareneingangs- oder Eingangsrechnungspositionen nötig: Artikelnummer, Datum,
Filiale/Lager, Menge, Währung und tatsächlicher Netto-Einstand einschließlich der
festgelegten Behandlung von Rabatten, Nebenkosten, Retouren und Gutschriften.
Ein Durchschnitt des Einkaufszeitraums ist außerdem etwas anderes als der
gleitende Durchschnitt des aktuellen Lagerbestands.

Als zusätzliche spätere Auswertung käme ein verkaufsgewichteter historischer
Kostenwert infrage: Nettoverkaufswert abzüglich Kassenrohertrag, geteilt durch die
zugehörige Menge. Das ist nur zulässig, wenn die genaue Rohertragsdefinition diese
Rückrechnung bestätigt. Es wäre kein Nachweis tatsächlich getätigter Einkäufe und
wird derzeit nicht als Einkaufs-EK ausgegeben.

## Wo werden die importierten Daten gespeichert?

Der aktuelle Server verwendet für die fachlich genutzten Kassa-/Trade-Importe,
Artikel, Verkaufsdaten und Berichtsaufträge denselben `persistenceProvider` wie
für die GP-Anwendung. Der Standardpfad ist `dienstplan.db`; `DB_PATH` kann ihn
überschreiben. Die Daten sind darin auf eigene Tabellen bzw. geschützte
Importbereiche verteilt. Die Access-Dateien werden nicht als unmittelbar
abfragbare Access-Datenbank innerhalb von SQLite betrieben.

Die neuen eigenen Artikelbilder liegen ebenfalls dort, in
`sales_article_own_images`, getrennt von den Trade-Snapshots und über die exakte
Artikelnummer verbunden. Sie gehören zu den vom Benutzer gepflegten Daten und
dürfen bei einer Importbereinigung oder späteren Migration nicht als
wiederherstellbarer Importcache behandelt werden.

Quellnachweise im Repository: `server.js` (DB-Pfad, Provider und Laufzeitverdrahtung),
`lib/tradefoto-article-source-profile.js`,
`docs/tradefoto-gesamtimport-v0.1/FELDKATALOG.md` und
`lib/persistence/sqlite/operations/sales-article-images-schema.js`.

## Empfohlene Zielaufteilung

| Datenbank | Zuständigkeit |
| --- | --- |
| `dienstplan.db` | Personal, Planung, Konten, Rollen, Rechte und GP-Konfiguration |
| `handel.db` | Trade-/Kassa-Importstände, Artikel, eigene Bilder, Preise, Belege, Suchprojektionen, Verkaufsanalysen und Berichtsaufträge/-dateien |

Eine gemeinsame Handelsdatenbank hält die eng verknüpften Artikel- und
Kassendaten zusammen. Die Zuordnung importierter Kunden, Mitarbeitender und
Filialen sowie die Zuständigkeit für CRM, Audit und Importverwaltung müssen vor
der Umsetzung tabellengenau festgelegt werden. Rechte bleiben in GP maßgeblich;
die Handelsabfragen erhalten geprüfte, aktuelle Berechtigungen und stabile
Zuordnungskennungen. Ein Ausfall oder Rechteentzug darf keine erweiterten
Handelszugriffe ermöglichen.

Die Trennung kann konkurrierende Schreibvorgänge und Wartungsarbeiten von GP
entkoppeln: SQLite erlaubt jeweils einen Schreiber je Datenbankdatei. Das allein
verkürzt aber keine langsame Abfrage und beseitigt auch keine gemeinsame
CPU-Auslastung im Serverprozess. Die vorhandenen Indizes, Suchprojektionen,
begrenzten Verarbeitungsschritte und gezielte Laufzeitmessungen bleiben nötig.
Für eine weitergehende Entkopplung wären separate Berichts-/Importprozesse zu
prüfen. Grundlage: [SQLite-Einsatzempfehlungen](https://www.sqlite.org/whentouse.html).

## Vorgehen für einen eigenen Umsetzungsauftrag

1. Alle Tabellen, Schlüssel, Geheimnisverweise, Abhängigkeiten und Größen erfassen;
   Zuständigkeit verbindlich zuordnen. Repräsentative Such-, Berichts- und
   GP-Schreibzeiten als Vergleich messen.
2. Einen eigenen Handelsprovider mit identischen Rechteschranken einführen.
   Datenbankübergreifende Änderungen über überprüfbare Aufträge, Versionsstände
   und Wiederholbarkeit koordinieren. Keine vermeintlich atomaren Schreibvorgänge
   über beide Dateien voraussetzen.
3. Die Migration zuerst auf einer isolierten, vollständigen Sicherung proben.
   IDs, Artikelnummern einschließlich führender Nullen, Bildrevisionen,
   verschlüsselte Inhalte und Berichtszuordnungen unverändert erhalten.
4. Zeilenzahlen, Prüfsummen, Fremdbezüge, Stichprobenberichte und Berechtigungen
   vergleichen. Eigene Bilder, Importwiederholung und Prozessabbrüche ausdrücklich
   testen; Laufzeiten mit dem Ausgangsstand vergleichen.
5. Für die spätere Umschaltung ein Wartungsfenster mit angehaltenen Schreib- und
   Hintergrundaufträgen verwenden. Beide Datenbanken als zusammengehörigen Stand
   sichern und einen Rückweg auf den vorherigen vollständigen Stand bereithalten.
6. Sicherung und Wiederherstellung beider Dateien inklusive benötigter Schlüssel
   und Konfiguration gemeinsam nachweisen. Importierbare Quelldaten und eigene
   Ergänzungen erhalten unterschiedliche Aufbewahrungsregeln; Bilder werden
   nicht durch erneutes Einspielen von Trade ersetzt.

Bei SQLite mit WAL besteht über mehrere per `ATTACH` verbundene Datenbanken
keine garantierte gemeinsame Transaktionsatomarität. Zwei unabhängig erzeugte
Sicherungen sind deshalb nicht automatisch ein konsistentes Paar. Die Anwendung
braucht einen gemeinsamen Sicherungsstand bzw. eine kurzzeitige Schreibpause und
ein Wiederherstellungsprotokoll. Grundlage:
[SQLite-Dokumentation zu ATTACH](https://www.sqlite.org/lang_attach.html).

Dieser Vorschlag ändert weder den laufenden Datenbankpfad noch die Produktion.
Er gehört in einen gesonderten Auftrag nach der Abnahme der Verkaufsanalysen und
Artikelbilder.
