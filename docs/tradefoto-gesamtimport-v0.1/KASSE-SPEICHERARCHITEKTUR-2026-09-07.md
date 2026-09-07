# Kassenhistorie: einfachere Speicherarchitektur

Stand: 07.09.2026. Ergebnis: **Für die historische Kassenauswertung ist der bisherige universelle Import-/Rücknahmeaufbau nicht erforderlich. Ein verschlüsselter, separat geprüfter Kassen-Datenstand ist im isolierten Speicherexperiment wesentlich kompakter.** TradeFoto bleibt auf ausdrücklichen Wunsch vollständig im bisherigen Umfang und wird in diesem Umbau nicht verändert.

Anschließende ausdrückliche Entscheidung: **Auch die Kasse bleibt vollständig. Die 24-Monate-Grenze entfällt.** Der [aktuelle GP-Prototyp](KASSE-VOLLBESTAND-GP-PROTOTYP-2026-09-07.md) übernimmt den schlanken Aufbau in eigene Tabellen innerhalb der vorhandenen GP-Datenbank. Dadurch sind Daten und verwalteter Import-Key-Umschlag Bestandteil desselben gekoppelten GP-Backups. Die folgende Messung und ihr JSON-Bericht bleiben der frühere Vergleich separater Testdateien; die damalige 24-Monate-Auswahl ist keine aktuelle Vorgabe.

Der Prototyp und die Messung sind abgeschlossen; dies ist noch keine produktive Integration oder VPS-Betriebsfreigabe. Keine GP-Datenbank, kein Trade-Import, keine Quelle, keine Sicherung und kein produktiver Schlüssel wurden verändert.

## Ursache der Vergrößerung

Die ursprüngliche gemeinsame Messung ergab 519,58 MB Access-Quellen und 11,6 GB kompaktierte GP-Testdatenbank: Faktor 22,33. Das betrifft Trade und Kasse zusammen. Eine separat kompaktierte Kassen-Datenbank wurde im alten Lauf nicht vermessen; deshalb wird kein erfundener Kassen-Byteanteil von der gemeinsamen Größe abgezogen.

Für 1 082 167 Kassen-Quellzeilen sind im alten Vollmessungsbericht bereits folgende Bestände nachweisbar:

| Ablage | Zeilen allein durch Kasse |
| --- | ---: |
| Dauerhafte Import-/Prüfzeilen | 1 082 167 |
| Quellverknüpfungen mit gespeichertem Ausgangsdatensatz | 1 082 167 |
| Rücknahmedaten | 1 082 167 |
| Historienidentitäten | 1 082 167 |
| Historienversionen | 1 082 167 |
| Schutzreferenzen auf Stammdaten | 2 140 395 |
| Summe dieser sechs Bereiche | 7 551 230 |

Weitere Historiensegmente, Verweistabellen und Indizes sind in dieser Untergrenze nicht enthalten. Die Zahl ist keine Behauptung, jede Zeile enthalte einen vollständigen Beleg. Der Code zeigt aber zusätzlich mehrfache große Werte:

- Der normalisierte Importdatensatz enthält sowohl Quellfelder als auch Zielfelder. Der dauerhaft gespeicherte Prüfplan enthält diesen Datensatz und die vorgesehene Änderung sowie gegebenenfalls den vorherigen Zielstand.
- Die Quellverknüpfung speichert den normalisierten Datensatz erneut. Die Rücknahme enthält Vorher-/Nachher-Zielwerte und gegebenenfalls die bisherige Verknüpfung.
- Die eigentliche Historie besitzt zusätzliche Versionen, geschützte Datensegmente, Herkunftsmetadaten, Verweise und Schutzreferenzen. Viele lange Identitäten stehen in mehreren Tabellen und Indizes.

Codeanker: [Importplan und Übernahme](../../lib/data-import-engine.js), [Historienablage](../../lib/persistence/repositories/import-history.js), [Importschema](../../lib/persistence/sqlite/operations/data-import-schema.js), [Historienschema](../../lib/persistence/sqlite/operations/import-history-schema.js). Dieser Aufbau kann für bearbeitbare Stammdaten mit feldweiser Konfliktlösung und Rücknahme sinnvoll sein. Für eine unveränderliche, selten neu bereitgestellte Kassenquelle reicht eine Prüfung und Rücknahme des gesamten Datenstands. Die bestehende Trade-/CRM-Umsetzung wird daraus nicht pauschal geändert.

## Gemessener schlanker Aufbau

Die sieben Kassentabellen behalten alle 97 Quellfelder nach den bestehenden typisierten Normalisierungsregeln. Gespeichert wird je Quellzeile ein einziges verschlüsseltes Wertefeld; Feldschema, Quellenhash, Zeitraum und Herkunft liegen einmal pro Datenstand vor. Ursprüngliche Quellzeilennummern bleiben erhalten. Beleg- und Journalpositionen haben echte Fremdschlüssel auf ihre Köpfe.

Die Messung enthält Indizes für Datum, Kopfbezug sowie vorhandene Filial-, Verkäufer-, Kunden- und Artikelkennungen. Identifikationswerte sind dort HMAC-Digests. Die bereits vorhandene AES-GCM-Verschlüsselung und Kompression werden weiterverwendet; auch Indizes und Zeilenmetadaten sind an den authentifizierten Kontext gebunden. Detailrechte und Standortberechtigungen sind in der produktiven Serviceanbindung weiterhin zu prüfen. Der private Prüfleser dieses Experiments ist keine Benutzer-API.

| Messgröße | Ganze Kassenquelle | Kasse mit 24 Monaten |
| --- | ---: | ---: |
| Gespeicherte Quellzeilen einschließlich Prüfbedarf | 1 082 167 | 587 530 |
| Kompaktierte verschlüsselte SQLite-Datei | **835,14 MB** | **481,95 MB** |
| Davon Tabellen einschließlich Metadaten | 639,04 MB | 362,3 MB |
| Indizes und übrige SQLite-Seiten | 196,1 MB | 119,65 MB |
| Aufbau und Kompaktierung auf diesem PC | 6,29 min | 4,19 min |
| Vollständiges Rücklesen und Wertevergleich | 83,29 s | 45,23 s |

Die vollständige neue Kassenablage benötigt damit Faktor **2,52** der 330,93 MB großen Access-Quelle, einschließlich Verschlüsselung und der hier gemessenen Indizes. Allein der zusätzliche Zeitraumfilter senkt die Größe dieses bereits vereinfachten Aufbaus um **42,29 %**. Dieser Unterschied ist nun an Dateien gemessen, nicht aus Zeilenprozenten hochgerechnet.

Für den 24-Monate-Stand entstand ein 267,7 MB großes gzip-Archiv der bereits verschlüsselten SQLite-Datei. Archivbildung: 6,95 s. Das Archiv wurde in eine separate Datei zurückgelesen, ihre SHA-256-Gleichheit geprüft und nochmals jede der 587 530 Zeilen vollständig entschlüsselt und verglichen; einschließlich dieser Prüfung dauerte die Rücksicherung 48,79 s. Dies ist ein isolierter Datei-/Werte-Restore mit flüchtigem Testschlüssel, kein Nachweis produktiver Vault-Wiederherstellung, Restic-Aufbewahrung oder Offsite-Kapazität.

Der gesamte Vergleich dauerte 13,61 min. Die beobachtete gemeinsame Dateispitze lag bei 1 231,6 MB. Messdatenbanken, Archiv, Restore und Testschlüssel wurden anschließend entfernt. Es bleiben ausschließlich Code, aggregierte Berichte und Testprotokolle. Die Laufzeiten gelten für diesen PC und den Speicherprototyp; bestehende fachliche Zuordnungs- und Summenprüfungen sind darin nicht als neue Laufzeitmessung enthalten.

## Empfohlene Umsetzung für die Kasse

Zur Dateispitze: Die Stichproben umfassen die ausdrücklich erfassten Datenbank-, WAL-/SHM-, Archiv- und Restore-Dateien. Weitere interne temporäre SQLite-Dateien sind kein separat vermessener Bestandteil dieser Zahl.

1. Die zuletzt bereitgestellte Kassenquelle vollständig lesen, speichern und prüfen. Alle Zeiträume und Datensätze ohne eindeutiges Datum bleiben enthalten. Datenstand und Herkunft werden explizit geführt; ohne neuen Upload gibt es keinen täglichen Neuimport oder Ablauf.
2. Einen eigenen verschlüsselten Kassen-Datenstand im Hintergrund aufbauen. Der aktuelle Prototyp nutzt dafür kompakte Tabellen innerhalb der GP-Datenbank; es entstehen keine dauerhaften zweiten Vollinhalte als universelle Prüf-, Link- und Rücknahmekopie.
3. Herkunft, Quellenhash, Regel- und Zuordnungsversion, Importeur, Freigabe und Prüfprotokoll auf Ebene des Datenstands festhalten. Die Quellzeile bleibt vom einzelnen Datensatz aus nachvollziehbar. Filialen, Mitarbeitende, Kunden und Artikel werden über bestätigte Zuordnungen zum vorhandenen GP-/Trade-Bestand gelesen, ohne dessen Stammdaten erneut zu kopieren oder Nummerngleichheit als Bindung anzunehmen. Eine spätere Zuordnungsänderung darf einen früheren ausgewiesenen Auswertungsstand nicht unbemerkt verändern.
4. Erst nach vollständiger Quellen-, Beziehungs-, Rechte- und Summenprüfung den aktiven Datenstand atomar umschalten. Laufende Auswertungen bleiben an einen eindeutigen Stand gebunden. Fehlerhafte Kandidaten verändern die bisherige Auswertung nicht; Rückkehr bedeutet Auswahl des vorherigen geprüften Gesamtstands. Es sind keine manuellen Einzeländerungen an historischen Quellwerten vorgesehen; Korrekturen kommen über einen neuen geprüften Export.
5. Den unveränderlichen Kassenstand zusammen mit der GP-Datenbank und deren bestehender Schlüsselverwaltung sichern. Unveränderte verschlüsselte Kassenzeilen bleiben für die vorhandene Archiv-Deduplizierung wiederverwendbar; ein Backup erfordert keinen Neuimport. Behaltefristen, vorherige Datenstände und tatsächlicher Restore-Platz bleiben explizit zu qualifizieren; drei lokale Kopien oder eine bestimmte Offsite-Ersparnis sind damit nicht automatisch zugesagt.

Die bewusste Änderung gegenüber dem universellen Import ist die **Rücknahme eines ganzen Kassenstands statt feld- oder zeilenweiser Rücknahme**. Einzelverkäufe, Tagesaggregate und Journal bleiben fachlich getrennt; vollständige Belegpositionen, Originalpräzision, Verkäuferrollen und geschützte Kundenbezüge bleiben erhalten. Unklare Journalgruppen und ältere unterstützende Zeilen sind Prüfbedarf, keine freigegebenen Umsätze. Vorhandene Prüfdaten oder Produktivbestände werden nicht gelöscht.

SQLite kann für diese Ablage bleiben. Die Herstellerdokumentation nennt Datenanalyse und dateibasierte Datencontainer ausdrücklich als geeignete Einsätze. Die gemessene Vereinfachung wurde bereits mit SQLite erreicht; ein Wechsel zu PostgreSQL ist dafür keine Voraussetzung. [SQLite: geeignete Einsätze](https://www.sqlite.org/whentouse.html). Der geplante Datenstandswechsel benötigt einen eigenen, geprüften Veröffentlichungsvertrag; eine SQLite-Transaktion allein beweist noch keine korrekte Veröffentlichung mehrerer Archivdateien. [SQLite: atomare Transaktionen](https://www.sqlite.org/atomiccommit.html).

## Prüfstand und verbleibende Arbeit

Vier gezielte Tests bestehen: alle Werte und ursprüngliche Quellzeile nach erneutem Öffnen, fehlender Belegkopf samt Transaktionsrollback, manipulierte Datumsindizes sowie falscher Datenstand oder Schlüssel. Im echten Vergleich wurden alle ausgewählten Zeilen geprüft; es gibt keine Stichproben-Hochrechnung. Die Originalquelle ist vor und nach der Messung in Hash und Dateimetadaten unverändert.

Noch umzusetzen sind produktive Schlüsselverwaltung, Konto-/Standort-/Datenklassenrechte, bestätigte Trade-Zuordnungen, Regel-/Belegabgleich, aktiver Datenstandswechsel einschließlich Folgeimport, dauerhafte Wiederherstellung und die angepasste Backup-/Release-Integration. Deshalb bleiben die bisherigen Produktivgates geschlossen. Diese Punkte ändern nichts am gemessenen Befund, dass die Kassenwerte ohne die bisherige Vervielfachung abgelegt werden können.

Nachweise: [Messbericht](KASSE-SCHLANKER-SNAPSHOT-MESSUNG-2026-09-07.json), [Architekturvergleich](KASSE-SPEICHERARCHITEKTUR-2026-09-07.json), [isolierter Prototyp](../../test-support/cash-history-snapshot-prototype.js), [Messhelfer](../../scripts/measure-cash-history-snapshot.mjs), [gezielte Tests](../../test/cash-history-snapshot-prototype.test.js). Kein Commit, Push, Deploy oder produktiver Kassenimport.
