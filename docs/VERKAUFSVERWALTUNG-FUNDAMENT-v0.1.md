# Verkaufsverwaltung · Fundament v0.1

## 1. Zweck

Die Verkaufsverwaltung ist ein fest integrierter Grabenplaner-Fachbereich. Sie wird nicht als optionales Installationsmerkmal, zuschaltbares Modul oder gesondertes Kundenpaket geführt.

Die linke Hauptnavigation enthält:

- `Verkaufsverwaltung` als aufklappbaren Hauptbereich,
- `Verkaufsanalysen` als ersten Unterpunkt.

## 2. Freigegebener Umfang dieses Blocks

Dieser erste Block liefert ausschließlich:

- die feste Einordnung in die Hauptnavigation,
- die adressierbare Desktop-Ansicht `salesAnalytics`,
- eine leere Arbeitsfläche für spätere Tabellen und Grafiken,
- das Zugangsrecht `sales:analytics:access`,
- fail-closed Navigation bei fehlendem Zugangsrecht.

Das Zugangsrecht öffnet nur die leere Fachoberfläche. Es gibt keine Filial-, Unternehmens-, Onlineshop- oder sonstigen Verkaufsdaten frei.

## 3. Ausdrücklich nicht enthalten

Dieser Block enthält noch keine:

- Verkaufsdaten, Beispieldaten oder produktiven Datenbanktabellen,
- Kennzahlen, Berechnungen, Diagramme oder Auswertungstabellen,
- Importfunktion, Importprofile oder Gesamtdatenbank-Dumps,
- API-Endpunkte, Migrationen oder Hintergrundverarbeitung,
- Festlegung von Filial-, Unternehmens- oder Onlineshop-Datenrechten,
- mobile Fachansicht oder mobile Abnahme.

Die vorhandene allgemeine Grabenplaner-Navigation bleibt technisch unverändert nutzbar. Die Verkaufsanalyse selbst ist jedoch als Desktop-Arbeitsbereich mit einer Mindestbreite für spätere Tabellen und Grafiken ausgelegt.

## 4. Sicherheits- und Produktgrenze

`Verkaufsverwaltung` wird nicht in `installationFeatureCatalog` aufgenommen. Damit gehört der Fachbereich zum ausgelieferten Kernprodukt und kann nicht wie ein optionales Modul aus einem Installationsprofil entfernt werden.

Im geschützten Serverbetrieb bleibt der Hauptbereich verborgen, solange `sales:analytics:access` nicht ausdrücklich wirksam ist. Das Recht wird in diesem Fundament keiner eingebauten Rolle automatisch hinzugefügt. Rollen-, Bereichs- und Datenprojektionen werden erst in einem eigenen späteren Rechteblock festgelegt.

## 5. Nächste fachliche Entscheidungen

Vor dem Anschluss einer Datenquelle sind mindestens getrennt festzulegen:

1. zulässige Quellsysteme und Importvertrag,
2. Filial-, Unternehmens- und Onlineshop-Sichten,
3. Datenminimierung und Aufbewahrung,
4. Kennzahlen und fachliche Berechnungsregeln,
5. Bereichsrechte, Delegation und Auditierung.

## 6. Fortsetzung

Der ausdrücklich gestartete zweite Block ist im [Verkaufsanalysen-Datenkatalog v0.1](./VERKAUFSANALYSEN-DATENKATALOG-v0.1.md) dokumentiert. Er katalogisiert zulässige und ausgeschlossene Quelldaten, ohne bereits eine Datenübernahme oder einen späteren technischen Block freizugeben.
