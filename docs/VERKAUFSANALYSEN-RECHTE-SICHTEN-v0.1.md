# Verkaufsanalysen · Rechte- und Sichtkonzept v0.1

## 1. Dokumentstatus und Blockgrenze

| Merkmal | Stand |
| --- | --- |
| Fachbereich | Verkaufsverwaltung → Verkaufsanalysen |
| Block | 3 · Rechte, Sichten und Datenschutz |
| Version | v0.1 |
| Stand | 03.08.2026 |
| Status | fachlich und als fail-closed Rechtefundament umgesetzt |

Dieses Konzept baut auf dem [Fundament v0.1](./VERKAUFSVERWALTUNG-FUNDAMENT-v0.1.md) und dem [Datenkatalog v0.1](./VERKAUFSANALYSEN-DATENKATALOG-v0.1.md) auf. Es trennt den Zugang zum Arbeitsbereich von den tatsächlich zulässigen Datenprojektionen.

Block 3 verbindet noch keine Datenquelle. Er enthält keine Verkaufsdatentabellen, Importprofile, Migrationen, Analyse-API, Kennzahlen, Diagramme, Tabelleninhalte, Exporte oder mobile Fachansicht. Rechte erzeugen deshalb in diesem Block noch keine Verkaufsdaten.

## 2. Verbindliche Grundsätze

1. **Arbeitsbereich ist nicht Datenzugriff.**<br>
   Das Öffnen von `Verkaufsanalysen` gibt allein keine Filial-, Unternehmens-, Onlineshop-, Bestands-, Kosten- oder Rohertragsdaten frei.

2. **Serverprojektion vor Abfrage und Aggregation.**<br>
   Spätere Datenendpunkte müssen den wirksamen Bereich serverseitig bestimmen, bevor Zeilen gelesen oder Kennzahlen aggregiert werden. Eine bloße Filterung oder Ausblendung im Browser ist unzulässig.

3. **Fail-closed.**<br>
   Fehlende, widersprüchliche oder leere Rechte und Bereiche ergeben keine Datenprojektion. Der Browser kann die vom Server gelieferte Projektion nicht erweitern.

4. **Filiale, Gesamtfirma und Onlineshop bleiben getrennt.**<br>
   Ein Recht auf die Gesamtfirma schließt Onlineshops nicht automatisch ein. Ein Onlineshop-Recht gibt umgekehrt keine Filialdaten frei.

5. **Bestand und Rohertrag sind Zusatzschichten.**<br>
   Bestand sowie Kosten/Rohertrag benötigen neben ihrem Zusatzrecht immer eine wirksame Filial- oder Gesamtfirmenprojektion.

6. **Nutzungsrecht und Rechtevergabe sind getrennt.**<br>
   Filialleitungen können Verkaufsrechte erhalten, dadurch aber keine Rechte an andere Personen weitergeben.

7. **Rollen allein öffnen keine Verkaufsdaten.**<br>
   Keine eingebaute Rolle erhält in Block 3 automatisch ein Verkaufsanalyse-Recht. Auch globale Verwaltungs- oder technische Rollen ersetzen keine ausdrückliche kaufmännische Datenfreigabe.

## 3. Berechtigungskatalog

| Recht | Zweck | Datenwirkung | Warnstufe |
| --- | --- | --- | --- |
| `sales:analytics:access` | geschützten Desktop-Arbeitsbereich öffnen | keine Datenwirkung | kritisch |
| `sales:analytics:location:read` | Verkaufsdaten vollständig zugewiesener Filialen lesen | nur sicher zugeordnete ganze Standorte | hoch |
| `sales:analytics:company:read` | Verkaufsdaten der Gesamtfirma lesen | alle sicher auf Grabenplaner-Standorte abgebildeten Filialen | kritisch |
| `sales:analytics:online:read` | Onlineshop-Verkaufsdaten lesen | ausschließlich eigene Onlineshop-Projektion | kritisch |
| `sales:analytics:inventory:read` | Bestände, bestellt und im Zulauf lesen | nur innerhalb wirksamer Filial-/Gesamtfirmenprojektion | hoch |
| `sales:analytics:margin:read` | Kosten und Rohertrag lesen | nur innerhalb wirksamer Filial-/Gesamtfirmenprojektion | kritisch |

Die derzeit vorgesehenen Empfängerrollen sind `manager`, `admin` und `developer`. Das ist nur eine technische Zulässigkeitsgrenze. Keine dieser Rollen erhält die Rechte automatisch. Für normalen fachlichen Zugriff ist die Filialleitung (`manager`) vorgesehen; ein technischer Zugang darf nicht allein wegen seiner technischen Rolle auf Verkaufsdaten zugreifen.

`employee`, `location_planner`, `department_manager`, `hr`, `it_admin` und Organisationskonten sind für diese Rechte in Block 3 nicht freigegeben. Eine spätere Änderung wäre eine neue, ausdrücklich zu begründende Rechteentscheidung.

## 4. Abhängigkeiten

Die Rechteverwaltung muss folgende Kombinationen erzwingen:

| Zusatzrecht | zwingende Voraussetzung |
| --- | --- |
| jedes Datenrecht | `sales:analytics:access` |
| `sales:analytics:inventory:read` | zusätzlich `sales:analytics:location:read` oder `sales:analytics:company:read` |
| `sales:analytics:margin:read` | zusätzlich `sales:analytics:location:read` oder `sales:analytics:company:read` |

Weitere Wirkungsregeln:

- `sales:analytics:company:read` kann ohne `sales:analytics:location:read` vergeben werden und erzeugt dann unmittelbar die Gesamtfirmenprojektion.
- Die Gesamtfirmenprojektion ersetzt für die Abfrage die Liste einzelner Standortbereiche, erweitert aber nicht die Onlineshop-Projektion.
- `sales:analytics:online:read` kann eigenständig neben dem Arbeitsbereich vergeben werden. Solange keine Shop-Bestellquelle angeschlossen ist, bleibt diese Projektion fachlich leer.
- Ein isoliertes Bestands- oder Rohertragsrecht bleibt unwirksam, selbst wenn es aufgrund eines veralteten Zustands technisch in einer Sitzung auftauchen sollte.
- Wird `sales:analytics:access` entzogen, werden sämtliche Verkaufsprojektionen sofort unwirksam.

## 5. Filialprojektion

Für `sales:analytics:location:read` gelten ausschließlich die wirksamen organisatorischen Bereiche der Sitzung:

- Berücksichtigt werden nur Bereichseinträge mit einer Standortkennung und ohne Abteilungseinschränkung.
- Ein reiner Abteilungsbereich darf nicht zur vollständigen Filialauswertung hochgestuft werden, weil die Kassendaten nicht sicher auf Grabenplaner-Abteilungen aufgeteilt werden können.
- Mehrere vollständig zugewiesene Standorte ergeben genau diese Standortmenge.
- Doppelte Standortzuweisungen werden vereinheitlicht.
- Fehlt ein vollständiger Standortbereich, bleibt die Filialprojektion leer.
- Quellkennungen werden erst nach der im Datenkatalog geforderten, geprüften Filialzuordnung berücksichtigt. Unbekannte Kennungen sowie die ungeklärten Sonderwerte `0` und `99` bleiben unsichtbar.

Eine spätere API darf bei einer nicht freigegebenen angeforderten Filiale weder Daten noch deren Existenz bestätigen. Sie muss die Anfrage mit einer allgemeinen Bereichsverweigerung ablehnen.

## 6. Gesamtfirmenprojektion

`sales:analytics:company:read` erlaubt standortübergreifende Auswertungen über alle sicher zugeordneten Filialen. Das Recht ist ausdrücklich auch für eine Filialleitung zulässig, wenn sie die relevante Gesamtfirma sehen soll.

Die Projektion umfasst nicht automatisch:

- Onlineshop-Umsätze,
- Bestand oder Zulauf,
- Kosten- und Rohertragswerte,
- nicht zugeordnete Quellfilialen,
- Kunden- oder Mitarbeiterdaten.

Spätere Gesamtwerte dürfen keine ausgeblendeten Daten über Differenzrechnungen offenlegen. Wer nur Filialrechte besitzt, erhält deshalb keine Gesamtfirmensumme, von der andere Filialen indirekt ableitbar wären.

## 7. Onlineshop-Projektion

Onlineshops bilden eine eigene fachliche Sicht. Sie werden nicht als normale Filiale in vorhandene Standortbereiche hineingedeutet.

Das Recht `sales:analytics:online:read` erlaubt später ausschließlich Daten einer ausdrücklich angeschlossenen und katalogisierten Shop-Bestellquelle. Die bisher untersuchte Tabelle `Shopware_Artikel` enthält nur Produktzuordnungen und erzeugt auch mit diesem Recht noch keine Bestellungen oder Umsätze.

Wenn eine spätere Kennzahl Filialen und Onlineshops zusammenfasst, muss ihre Zusammensetzung sichtbar sein. Ohne Onlineshop-Recht darf weder ein Shop-Einzelwert noch eine shopinklusive Gesamtsumme ausgegeben werden.

## 8. Datenklassen innerhalb einer Projektion

| Datenklasse | Basisrecht | Zusatzrecht | Grenze |
| --- | --- | --- | --- |
| Umsatz, Menge, Soll-/Istpreis, Rabatt, Steuer | Filiale oder Gesamtfirma | keines | nur freigegebene organisatorische Projektion |
| Artikelbezeichnung, EAN, Marke, Sortiment und freigegebene Taxonomien | Filiale oder Gesamtfirma | keines | historische und aktuelle Snapshots bleiben getrennt |
| Bestand, bestellt, im Zulauf | Filiale oder Gesamtfirma | `sales:analytics:inventory:read` | nur als gekennzeichneter Snapshot |
| Kostenbasis und Rohertrag | Filiale oder Gesamtfirma | `sales:analytics:margin:read` | erst nach fachlicher Feld- und Währungsentscheidung |
| Onlineshop-Umsatz und -Bestellungen | Onlineshop | `sales:analytics:online:read` | erst nach eigener freigegebener Bestellquelle |

Unabhängig von allen Verkaufsrechten bleiben Kundenkennungen, Kundendaten, Verkäuferkennungen, Mitarbeiterleistung, Provisionen, Benutzer- und Zugangsdaten ausgeschlossen. Es gibt kein Recht, das diese Ausschlüsse aus dem Datenkatalog aufhebt.

## 9. Rollen- und Vergabegrenze

| Akteur | Verkaufsrechte nutzen | Verkaufsrechte vergeben |
| --- | --- | --- |
| Filialleitung | nach ausdrücklicher Zuweisung | nein |
| Admin | nach ausdrücklicher Zuweisung | ja |
| Developer | nicht automatisch; nur in ausdrücklich autorisiertem fachlichen Prüfkontext | ja, aber kein automatisches Datennutzungsrecht |
| IT-Admin | nein | ja, im Rahmen der bestehenden technischen Zusatzrechteverwaltung; Zielrollen und Abhängigkeiten bleiben bindend |
| Personalleitung | nein | nein; Verkaufsrechte gehören nicht zur PL-Delegation |
| Abteilungsleitung/Planungsverantwortung/Mitarbeiter | nein | nein |

Die vorhandenen Rechteverwalter müssen weiterhin Zielrolle, individuelle Freigabe, individuellen Entzug und Abhängigkeiten prüfen. Eine Person mit einem Nutzungsrecht erhält dadurch niemals `rights:write`, `roles:write` oder ein anderes Delegationsrecht.

## 10. Typische Freigabeszenarien

| Szenario | Rechtekombination | Ergebnis |
| --- | --- | --- |
| Arbeitsbereich ohne Daten | `access` | Seite sichtbar, keine Datenprojektion |
| Eigene Filiale | `access` + `location:read` und vollständiger Standortbereich | ausschließlich zugewiesene Filiale(n) |
| Eigene Filiale mit Bestand | vorherige Kombination + `inventory:read` | zusätzlich Bestand im freigegebenen Standort |
| Eigene Filiale mit Rohertrag | `access` + `location:read` + `margin:read` | zusätzlich Kosten/Rohertrag im freigegebenen Standort |
| Relevante Gesamtfirma | `access` + `company:read` | alle zugeordneten Filialen, noch ohne Onlineshop |
| Gesamtfirma einschließlich Onlineshops | `access` + `company:read` + `online:read` | Filial- und Shopprojektion, später getrennt und kombiniert darstellbar |
| Nur Onlineshop | `access` + `online:read` | ausschließlich Shopprojektion; derzeit mangels Bestellquelle leer |
| Abteilungsbereich mit Filialrecht | `access` + `location:read`, aber nur Abteilungsscope | keine Filialdaten |

## 11. Server- und Browserschnittstelle

Der Server erzeugt aus wirksamen Sitzungsrechten und vollständigen Standortbereichen eine minimierte Projektion mit:

- `workspace`: Arbeitsbereich darf geöffnet werden,
- `locationMode`: `none`, `scoped` oder `company`,
- `locationIds`: freigegebene Standorte nur bei `scoped`,
- `company`: Gesamtfirmenprojektion ist wirksam,
- `onlineShop`: Onlineshop-Projektion ist wirksam,
- `inventory`: Bestandszusatz ist innerhalb einer Filialprojektion wirksam,
- `grossMargin`: Kosten-/Rohertragszusatz ist innerhalb einer Filialprojektion wirksam,
- `hasDataProjection`: mindestens eine fachliche Datenprojektion ist wirksam.

Diese Projektion wird als `user.salesAnalytics` an den Browser gegeben. Sie dient dort ausschließlich der Darstellung und Navigation. Spätere Datenendpunkte müssen dieselbe Projektion serverseitig neu auswerten und dürfen keine vom Browser übermittelten Freigabefelder übernehmen.

## 12. Auditierung und Datenschutz

Für Rechteänderungen gelten die vorhandenen, nachvollziehbaren Rechte-Audits. Spätere Datenzugriffe benötigen zusätzlich mindestens:

- Akteur und Zeitpunkt,
- verwendete Projektionsart (`scoped`, `company`, `online`),
- angeforderter Zeitraum,
- interne Kennzahlen-/Berichtskennung,
- verwendeter Datenstand beziehungsweise Importlauf,
- Ergebnisstatus und Fehlerklasse.

Das Audit protokolliert keine vollständigen Ergebniszeilen, keine Kunden- oder Mitarbeiterdaten und keine unnötigen Suchtexte. Ein späterer Export benötigt ein eigenes Recht und einen eigenen Auditentscheid; Block 3 führt bewusst kein Exportrecht ein.

## 13. Technischer Stand dieses Blocks

Block 3 ergänzt:

- einen gemeinsamen, testbaren Berechtigungskatalog für Verkaufsanalysen,
- serverseitige Abhängigkeitsprüfungen bei der Rechtevergabe,
- Rollenbeschränkungen für kaufmännische Verkaufsrechte,
- den Ausschluss eines automatischen Verkaufsdatenzugriffs für die IT-Administration bei unveränderter technischer Zusatzrechteverwaltung,
- eine fail-closed Sitzungsprojektion für Filiale, Gesamtfirma, Onlineshop, Bestand und Rohertrag,
- die reduzierte Projektion `user.salesAnalytics` für Navigation und spätere Darstellung,
- die sichtbare Kennzeichnung des Rechtefundaments in der weiterhin leeren Desktop-Arbeitsfläche.

Es wurden keine Verkaufsdaten verarbeitet oder gespeichert.

## 14. Abschluss und nächstes Entscheidungstor

Block 3 endet mit der Rechte- und Sichtentrennung. Vor einem Import oder einer ersten Kennzahl bleiben insbesondere die offenen Fachentscheidungen aus Abschnitt 12 des Datenkatalogs bestehen: Retouren/Storno, Währung und `_DM`-Felder, Brutto/Netto, Rohertragsbasis, Filialmapping, Steuerzuordnung, Snapshot-Frequenz und Aufbewahrung.

Ein weiterer Block beginnt erst nach ausdrücklicher Freigabe. Dieses Rechtefundament erteilt keine automatische Freigabe für Datenmodell, Importassistent, Analyse-API, Kennzahlen oder Oberflächeninhalte.

Der anschließend ausdrücklich gestartete Block 4 ist im [Datenmodell und Importfundament v0.1](./VERKAUFSANALYSEN-DATENMODELL-IMPORTFUNDAMENT-v0.1.md) dokumentiert. Er verwendet diese Rechte- und Datenschutzgrenzen, ohne bereits Verkaufsdaten anzuschließen oder zu speichern.
