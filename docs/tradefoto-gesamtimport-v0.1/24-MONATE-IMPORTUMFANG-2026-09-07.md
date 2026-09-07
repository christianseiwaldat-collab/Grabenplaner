# Historischer Vergleich: Kasse mit 24 Monaten Geschäftshistorie

**Durch die anschließende ausdrückliche Entscheidung „Gesamte Kasse im schlanken Prototyp“ aufgehoben. Aktuell werden alle Kassenzeilen und alle Zeiträume beibehalten.** TradeFoto bleibt ebenfalls vollständig. Es wird kein 24-Monate-Filter eingebaut und keine ältere Historie entfernt. Aktueller Stand: [gesamte Kasse im GP-Prototyp](KASSE-VOLLBESTAND-GP-PROTOTYP-2026-09-07.md).

Die folgenden Regeln und Berechnungen beschreiben ausschließlich den früher untersuchten Vorschlag. Der unveränderte JSON-Messbericht bleibt als Nachweis dieses Vergleichs erhalten.

Stand: 07.09.2026, nach der anschließenden Klarstellung: **TradeFoto bleibt vollständig im bisherigen Importumfang. Die 24-Monate-Grenze gilt ausschließlich für die Kasse.** Auf die möglichen 370 weniger Trade-Zeilen wird ausdrücklich verzichtet. Zusätzlich soll die Kassenablage selbst vereinfacht werden, damit Import-/Historienverwaltung die Quelldaten nicht unnötig vervielfacht.

Der unten verlinkte ursprüngliche Messbericht bleibt unverändert als Vergleich beider Varianten erhalten. Seine rechnerische Trade-Einsparung ist keine aktuelle Importvorgabe.

Die lesende Quellenmessung ist abgeschlossen. **Ein Zeitraumfilter ist noch nicht im produktiven Import umgesetzt; es wurde kein Import oder Löschen ausgeführt.** Die folgenden Regeln beschreiben das begrenzte Ziel und seine Umsetzungsvoraussetzungen.

Die anschließend ausdrücklich beauftragte [Prüfung einer einfacheren Kassenablage](KASSE-SPEICHERARCHITEKTUR-2026-09-07.md) ist abgeschlossen. Der isolierte Prototyp speichert die vollständige Kasse auf 835,14 MB beziehungsweise 24 Monate auf 481,95 MB, einschließlich Verschlüsselung und gemessener Indizes. Der 24-Monate-Datei-/Werte-Restore bestand. Diese zusätzliche Messung erzeugte ausschließlich vorübergehende eigene Testdateien; der Produktivfilter bleibt ausstehend.

## Zeitbezug und fachliche Grenzen

- Kassen-Geschäftsvorgänge werden auf die 24 Monate vor dem ausdrücklich festgehaltenen bereitgestellten Datenstand begrenzt. Für diese Messung gilt der 04.09.2026: vom 04.09.2024 einschließlich bis zum Ende des 04.09.2026. Technisch ist die obere Grenze der 05.09.2026 ausschließlich. TradeFoto erhält keinen Zeitraumfilter.
- Nur neue vom Nutzer bereitgestellte Exporte können einen neuen Datenstand begründen. Ohne neuen Upload verkürzt sich die historische Auswertung nicht täglich. Trade und Kasse dürfen getrennt importiert werden; ihre jeweiligen Datenstände und Überschneidungen werden sichtbar geführt.
- Maßgeblich ist der Geschäfts-/Belegtag, nicht Dateiänderung, Uploadzeit, Artikelanlage oder Geburtstag. Das Access-Trägerdatum 30.12.1899 in `Bonzeit` ist kein Geschäftstag. Datumswerte behalten ihre lokalen Kalenderkomponenten.
- Artikel-, Kunden-, Personal-, Standort- und benötigte andere Stammdaten werden nicht aufgrund eines alten Anlage- oder Änderungsdatums abgeschnitten. Die vorhandenen zentralen GP-Artikel und bestätigten Quellbindungen werden weiterverwendet. Referenzdaten und aktuelle Bestands-Snapshots brauchen ebenfalls eine vom Bewegungsdatum getrennte Behandlung.
- Für diese konservative Rechnung bleiben sämtliche bisher vorgesehenen Stammdaten und aktuellen Bestands-Snapshots erhalten. Eine zusätzliche Reduktion auf nachweislich benötigte Referenzen wäre gesondert über beide Quellen abzugleichen; diese Einsparung ist hier nicht eingerechnet.
- Belegköpfe und Positionen müssen zusammenpassen. Journalgruppen bleiben vollständig, wenn ein aktueller Teil sie benötigt. Ältere unterstützende Zeilen dürfen nicht als Umsatz im gewählten Zeitraum zählen. Fehlende oder widersprüchliche Datumswerte bleiben Prüfbedarf und werden nicht still als alt und entbehrlich behandelt.
- Ältere Zeiträume stehen nach begrenzter Übernahme nicht als vollständige GP-Auswertung zur Verfügung. Access-Originale bleiben unverändert. Diese Zeitgrenze ändert weder die separat vereinbarte Backup-Aufbewahrung noch bestehende Sicherungen.

## Tatsächlich gezählter Umfang

Die zuletzt bereitgestellten Dateien wurden nacheinander ausschließlich lesend untersucht: 109 Tabellen des bestehenden Importplans, aktuelle Quellenhashes und alle Zeilenzahlen gegen die bestandene Vollmessung. Für die Messung wurden nur Geschäftsdatumsfelder und erforderliche Beleg-/Journal-Schlüssel projiziert. Geheimnisfelder, Namen, Kontakte, Beträge und Freitexte wurden nicht ausgelesen. Der Bericht enthält ausschließlich aggregierte Zähler und technische Metadaten.

| Quelle | Ursprüngliche Zeilen | Als ältere Vorgänge entbehrlich | Verbleibend einschließlich Prüfbedarf | Weniger Quellzeilen |
| --- | ---: | ---: | ---: | ---: |
| TradeFoto, ausdrücklich vollständig | 395.163 | 0 | 395.163 | 0 % |
| Kasse | 1.082.167 | 494.637 | 587.530 | 45,71 % |
| Zusammen, nach Klarstellung | 1.477.330 | 494.637 | 982.693 | 33,48 % |

Die Datumsprojektion dauerte 5,535 Sekunden. Es wurden keine Import-, Staging-, Audit- oder Historientabellen angelegt; das ist keine neue Laufzeitmessung des Imports.

TradeFoto enthält 133.733 Stammdatenzeilen und 231.363 aktuelle Bestandszeilen, davon 231.351 in `ARTIKEL_FILIALEN`. Die zuerst berechnete Eingrenzung hätte nur 370 ältere Zeilen aus Reparaturexport, Lagerumschlag und Wareneingangskontrolle entfernt. Auch diese bleiben nach der Klarstellung erhalten. Die Zeitgrenze und weitere Speichervereinfachung betreffen ausschließlich die Kasse.

| Kassentabelle | Ursprünglich | Entbehrliche ältere Zeilen | Verbleibend einschließlich Prüfbedarf |
| --- | ---: | ---: | ---: |
| `Umsatz_KASSE` | 219.920 | 55.868 | 164.052 |
| `Umsatz_Kasse_Details` | 385.877 | 95.082 | 290.795 |
| `Tagesbericht` | 346.921 | 259.455 | 87.466 |
| `KassenJournal` | 39.865 | 14.125 | 25.740 |
| `KassenJournal_Details` | 89.584 | 70.107 | 19.477 |

Die beiden übrigen Kassentabellen des Importplans sind leer. Alle 385.877 Belegpositionen haben vorhandene Köpfe; auch die Stichtagsauswahl erzeugt keine verwaisten Positionen. Die 89.584 Journalpositionen haben ebenfalls vorhandene Köpfe. 22.194 Journalgruppen bleiben außerhalb der eindeutig ausgewählten oder eindeutig alten Gruppen zur Prüfung erhalten; darunter Köpfe ohne Datum oder mit einem Datum nach dem Datenstand. Deshalb bleiben 345 ältere Journalpositionen in der vorsichtigen Rechnung enthalten. Diese Prüfmenge ist keine freigegebene Umsatzbasis.

## Speicher und nächste Umsetzung

**33,48 % weniger Quellzeilen sind keine gemessene Ersparnis von 33,48 % Datenbank- oder Archivplatz.** Unterschiedliche Tabellen erzeugen unterschiedlich große Inhalte, Verknüpfungen, Versionen, Prüf- und Rücknahmedaten. Die frühere kompaktierte Datenbankgröße von 11,60 GB und der VPS-Betriebsbedarf dürfen nicht proportional heruntergerechnet oder als neu qualifiziert ausgegeben werden. Die neue Kassenprüfung untersucht deshalb zusätzlich die eigentliche Ablagearchitektur.

Die Auswahl muss vor dem Speichern vollständiger Nutzdaten in Staging und Historie greifen. Ein Oberflächenfilter allein spart diesen Speicher nicht. Für den begrenzten Import sind erforderlich:

1. Getrennte Nachweise für vollständig gelesene Quelle, beabsichtigte Zeitraum-Auswahl und tatsächlich übernommene Zeilen. Die bisherigen Lesedeckungs- und Beziehungstore bleiben erhalten.
2. Stabile Identitäten mit ursprünglicher Quellzeilennummer sowie eine explizite Zeitbereichs-/Regelversion. Identische Uploads erzeugen keine Duplikate; ein geänderter Zeitraum wird nicht mit einem alten Lauf verwechselt.
3. Abgleich vollständiger Beleggruppen, Referenzen, fachlichen Prüfbedarfs und zeitlicher Abdeckung. Daten außerhalb des Fensters sind nicht Nullumsatz und kein Importfehler.
4. Ein begrenzter gefilterter Import mit Messung der kompaktierten Größe, Archivgröße und Wiederherstellung. Erst diese Werte tragen die neue Kapazitätsfreigabe. Späteres Entfernen bereits gespeicherter abgelaufener Historie braucht einen geprüften Ablauf einschließlich Versionen, Staging und Wiederherstellung; ein täglicher Löschauftrag ist nicht Bestandteil dieser Entscheidung.

Diese Fortsetzung ergänzt ausschließlich Analysewerkzeug, Nachweis, fünf gezielte Prüfungen und Planungsverweise. Anwendungsgates, installierte GP-Datenbank, Quellen und Sicherungen sind unverändert. Kein Commit, Push oder Deploy.

## Nachweise

- [Aggregierte Quellenmessung](24-MONATE-QUELLENMESSUNG-2026-09-07.json): Quellenhashes, Tabellenbilanz, Zeitfenster, Referenzprüfungen, unveränderte Originale und Prüfsummen der Messgrundlage.
- [Analysewerkzeug](../../scripts/measure-tradefoto-history-window.mjs): ausschließlich lesend, keine Datenbank-/Importausführung, maximal 10.000 projizierte Zeilen je Leseseite.
- [Gezielte Prüfungen](../../test/tradefoto-history-window-measurement.test.js): Stichtagsgrenzen, Schaltjahr, ungültige Datumswerte und vollständige Journalgruppen; 5/5 bestanden.

```text
node --test test/tradefoto-history-window-measurement.test.js
node --expose-gc --max-old-space-size=768 scripts/measure-tradefoto-history-window.mjs TRADE.accdb CASH.accdb 2026-09-04 NEW-REPORT.json
```

Der Messhelfer ist an Quellenhashes und Tabellenzählungen des vorhandenen Vollmessungsberichts gebunden, überschreibt keine Berichte und verweigert unbekannte Quellstände. Er ist kein allgemeiner bereits aktivierter Importfilter.
