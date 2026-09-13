# Bestätigte Reparatur- und Bestandsregeln

Stand: 13.09.2026. Vom Benutzer im GP-Verlauf bestätigt. Diese Entscheidungen
ersetzen die offenen Fragen in der vorherigen Einstellungsdokumentation.
Die Veröffentlichung bleibt zurückgestellt. Die spätere Reparaturübersicht
und neue Bestandskennzahlen sind damit fachlich festgelegt, noch nicht als
fertige Oberfläche implementiert.

## Reparaturen: Quellsignal, Abholung und Abrechnung

| Wert beziehungsweise Vorgang | Bestätigte Bedeutung im GP |
| --- | --- |
| TradeRepair `erledigt = true` | Für TradeRepair ist die Bearbeitung beendet; der Fall ist abholbereit. Die Reparatur kann auch abgelehnt worden sein. |
| TradeRepair `erledigt = false` oder fehlend | Keine bestätigte Abholbereitschaft aus diesem Kennzeichen. Daraus entsteht keine verlässlich aktuelle Liste offener Fälle. |
| `AbzuholenDatum` und `AbgeholtDatum` | Werden im Betrieb nicht verwendet. Vorhandene Quellwerte bleiben unverändert archiviert, sind aber keine Grundlage für den späteren eigenen GP-Abholstatus. |
| Abrechnung | Kann später erfolgen. `erledigt` beweist weder Abrechnung noch Bezahlung oder Warenabholung. |
| Abgelehnte Reparatur | Der TradeRepair-Fall ist ebenfalls erledigt. Die bereits berechnete KVA-Pauschale von 75,00 EUR wird nicht zurückerstattet. |

Für die spätere GP-Reparaturübersicht werden **eigene Felder „abholbereit“ und
„abgeholt“** vorgesehen. Sie werden von GP-Benutzern gesetzt, getrennt vom
importierten TradeRepair-Kennzeichen gespeichert und mit Zeitpunkt und
Änderungsnachweis geführt. Ein späterer Import darf diese eigenen Felder weder
überschreiben noch zurücksetzen. „Laut TradeRepair abholbereit“ kann als separater
Quellhinweis erscheinen; es ersetzt keinen eigenen GP-Abholnachweis.

Die Kassendaten bleiben die Grundlage für Umsatz und Rohertrag. Eine abgelehnte
Reparatur erzeugt keine automatische Erstattung und keine zusätzliche Buchung
der schon kassierten 75 EUR. Eine tatsächlich gebuchte spätere Gegenrechnung
bei ausgeführter Reparatur wird anhand der Kassenposition verarbeitet. Der
Reparaturstatus allein erzeugt weder diese Gegenrechnung noch einen geschätzten
Rohertrag. Bestehende bestätigte Kassenregeln wurden dafür nicht verändert.

## Reparaturen bei späteren Importen erhalten

Die vorhandene versionierte GP-Importhistorie speichert Bestell-Reparaturen
unabhängig von später gelieferten Dateiinhalten. Ihre Identität umfasst die
Quelle `tradefoto-bestell`, den GP-Datenbereich, Reparaturnummer und Filial-ID.
Dieselbe Reparaturnummer in zwei Filialen bezeichnet zwei verschiedene Fälle.

- Ein in einer neuen ACCDB-Datei fehlender Fall wird nicht gelöscht oder
  automatisch abgeschlossen.
- Auch eine vollständig leere Reparaturtabelle ist keine Löschanweisung.
- Der Fall bleibt lesbar, einschließlich seines bisherigen Quellstands.
- Beim Wiederauftauchen wird derselbe Fall versioniert aktualisiert. Eine
  ältere Fassung bleibt lesbar; es wird kein Duplikat angelegt.
- Die Rücknahmefrist für Importvorgänge ist keine automatische Löschfrist
  für die Reparaturhistorie.

Diese Eigenschaft ist im bestehenden Importpfad vorhanden und wurde mit einem
neuen Integrationstest abgesichert: zwei Filialen mit gleicher Reparaturnummer,
vier aufeinanderfolgende Dateistände, fehlender Fall, leere Reparaturtabelle,
Wiederauftauchen, unveränderte ursprüngliche Herkunft und Zugriff auf alte
Versionen. Der Test prüft außerdem, dass `erledigt` keine Abhol- oder Bezahldaten
erfindet. Alle drei gezielt ausgeführten Bestell-Integrationstests bestanden.
Nachweis: `tmp/repair-retention-tests-20260913.txt`.

Die neue Oberfläche mit eigenen GP-Statusfeldern ist weiterhin der vom Benutzer
ausdrücklich für später vorgesehenen Reparaturübersicht zugeordnet. Es wurden
keine produktiven Reparaturdaten verändert oder importiert.

## Bestandskennzahlen: freigegebene Grundregeln

Der Benutzer stimmt der vorgeschlagenen Einteilung und den Schwellenwerten zu:

1. **Lagerware:** physische, bestandsgeführte Artikel.
2. **Dienstleistungen:** bleiben in Umsatz und Kassen-Rohertrag enthalten,
   zählen aber nicht zu physischen Bestandskennzahlen.
3. **Buchungsartikel:** beispielsweise Anzahlungen, Gutscheine, Rabatte oder
   Verrechnungsartikel; keine physischen Warenbestände.
4. **Ungeklärte Sonderfälle:** bleiben ausdrücklich ungeklärt und werden
   nicht stillschweigend in Lagerkennzahlen aufgenommen.

Warengruppen erhalten Vorgaben, einzelne Artikel können davon abweichen.
Die Artikelkennzeichen `Sachkonto` und `OhneBestand` haben Vorrang. Eine
Warengruppenvorgabe darf dadurch ausgeschlossene Artikel nicht als physischen
Bestand behandeln.

**Langsamdreher:** positiver Bestand der jeweiligen Filiale ohne bestätigten
Verkauf seit mindestens **90 beziehungsweise 180 Tagen**. Fehlende oder
unvollständige Verkaufsabdeckung darf nicht als bestätigtes „kein Verkauf“
ausgegeben werden. Diese Zeit seit dem letzten Verkauf ist kein tatsächliches
Lageralter; das vollständige Wareneingangsjournal fehlt weiterhin.

Die Zustimmung bestätigt diese Grundregeln. Sie ist keine pauschale Zuordnung
aller bislang nicht einzeln klassifizierten Warengruppen im alten Entwurf.
Ungeklärte Gruppen beziehungsweise Artikel bleiben in der vierten Kategorie,
bis die konkrete Zuordnung feststeht.
