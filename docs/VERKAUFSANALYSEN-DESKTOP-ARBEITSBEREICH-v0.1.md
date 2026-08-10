# Verkaufsanalysen – Desktop-Analysearbeitsbereich v0.1

**Stand:** 03.08.2026<br>
**Arbeitsblock:** 8 – Desktop-Oberfläche für Verkaufsanalysen<br>
**Produktbereich:** Verkaufsverwaltung > Verkaufsanalysen<br>
**Status:** Entwicklungsstand im separaten Verkaufsverwaltungs-Worktree; nicht veröffentlicht oder ausgerollt

## 1. Ziel und Einordnung

Dieser Block baut den fest integrierten Desktop-Bereich zu einem auswertbaren
Arbeitsplatz für die bereits bestätigten aggregierten TradeFoto-Berichte aus.
Er ergänzt keine neue Datenquelle und verändert die unveränderlich gespeicherten
Berichtsdaten nicht.

Die Darstellung nutzt ausschließlich die serverseitig für die aktuelle Sitzung
projizierten Berichte und Kennzahlen. Der Browser erhält weder ausgeblendete
Filialberichte noch geschützte Rohertragsfelder, um sie anschließend nur optisch
zu verbergen.

## 2. Analyseauswahl

Die Berichtsliste kann nach folgenden Kriterien eingegrenzt werden:

- freigegebene GP-Filiale;
- frühestes Berichtsende;
- spätestes Berichtsende;
- konkreter Statistikbericht;
- Berichtszeitraum oder Jahr bis Berichtsende.

Die Datumsfilter beziehen sich ausdrücklich auf das Ende des importierten
Berichts. Ein widersprüchlicher Von-/Bis-Bereich liefert keine Daten und wird
sichtbar beanstandet. „Alle freigegebenen Filialberichte“ ist eine gemeinsame
Auswahlliste, jedoch keine künstlich berechnete Unternehmenssumme.

## 3. Kennzahlen

Für den ausgewählten Bericht und Horizont werden angezeigt:

- Nettoumsatz;
- Menge;
- Kundenanzahl;
- Umsatz je Kunde;
- Rohertrag nur bei wirksamem Recht `sales:analytics:margin:read`.

Jede Karte zeigt aktuellen Wert, Vergleichswert und prozentuale Veränderung.
Ist der Vergleichswert null, wird keine mathematisch unbestimmte Prozentzahl
erzeugt, sondern „Kein Prozentvergleich“ ausgewiesen. Die Anzeige rechnet mit
den bereits kanonisch gespeicherten Dezimalwerten; sie schreibt keine
Gleitkomma-Ergebnisse in die Persistenz zurück.

## 4. Diagramm

Das Warengruppendiagramm kann zwischen Nettoumsatz, Menge, Kundenanzahl,
Umsatz je Kunde und – bei entsprechender Berechtigung – Rohertrag umgeschaltet
werden. Für bis zu zwölf Warengruppen werden aktueller und zugehöriger
Vergleichszeitraum als getrennte Balken dargestellt. Negative Werte bleiben als
solche erkennbar und werden nicht in positive Umsätze umgedeutet.

Die Legende nennt die beiden tatsächlich im Bericht enthaltenen Zeiträume. Das
Diagramm erzeugt keine Hochrechnung und kombiniert keine Berichte verschiedener
Filialen oder Zeiträume.

## 5. Detailtabelle

Die breite Desktop-Tabelle enthält je Warengruppe:

- aktuelle und verglichene Menge;
- aktuellen und verglichenen Nettoumsatz einschließlich Umsatzabweichung;
- aktuellen und verglichenen Rohertrag nur bei wirksamem Recht;
- aktuelle und verglichene Kundenanzahl;
- aktuellen und verglichenen Umsatz je Kunde.

Warengruppennummer und Bezeichnung können lokal innerhalb des bereits
projizierten Berichts durchsucht werden. Sortierungen stehen für Umsatz,
Umsatzabweichung, Menge, Kunden, Warengruppe sowie berechtigungsabhängig
Rohertrag zur Verfügung. Suche und Sortierung verändern weder Quelldaten noch
den gespeicherten Bericht.

## 6. Rechte- und Datenschutzgrenzen

Es gelten unverändert die Rechte und serverseitigen Sichten aus Block 3 sowie
die Ausgaberegeln aus Block 6 und 7:

- ohne `sales:analytics:access` bleibt der gesamte Arbeitsbereich geschlossen;
- Filialberichte werden bereits vor der Ausgabe auf den wirksamen Bereich
  begrenzt;
- ohne Rohertragsrecht fehlen Rohertragswerte in der API-Antwort und damit auch
  Kennzahlenkarte, Diagrammauswahl, Tabellenspalten und Sortierung;
- technische Administration gewährt weiterhin keinen automatischen
  Verkaufsdatenzugriff;
- die Oberfläche protokolliert oder persistiert keine Suchbegriffe.

## 7. Bewusste Grenzen

Nicht Bestandteil dieses Blocks sind:

- direkte Access-Datenbankanbindung oder Hintergrundsynchronisation;
- selbst berechnete Unternehmenssummen über mehrere PDF-Berichte;
- Onlineshopumsätze ohne katalogisierte Bestell- oder Umsatzquelle;
- weitere TradeFoto-Berichtsarten;
- Export-, Freigabe- oder Planungsfunktionen;
- keine mobile Fachansicht oder mobile Abnahme;
- Commit, Push, Release oder VPS-Deployment.

## 8. Prüfvertrag

Der Block wird mindestens durch folgende Prüfungen abgesichert:

- statischer Vertrag für Filter, KPI-Bereich, Diagrammumschaltung,
  Vergleichstabelle und reine Desktop-Grenze;
- JavaScript-Syntaxprüfung;
- bestehende Rechte-, PDF-, OCR-, Persistenz- und Regressionsprüfungen;
- Persistenzkopplungs-Audit;
- visuelle Desktop-Prüfung, soweit ein verbundener Browser zur Verfügung steht.

Der nächste ursprüngliche Fahrplanblock ist die Produktionshärtung. Sie beginnt
erst nach ausdrücklicher Freigabe und umfasst insbesondere große Datenmengen,
Performance, Auditvollständigkeit, Backup/Restore sowie fehlgeschlagene oder
wiederholte Importe. Dieses Dokument gibt diesen Block nicht automatisch frei.

### 8.1 Lokaler Prüfstand am 03.08.2026

- vollständige GP-Regressionssuite: 1.768 Tests, 1.728 bestanden,
  40 bewusst übersprungen, 0 fehlgeschlagen;
- Persistenzkopplungs-Audit: `OK`, SQLite-/PostgreSQL-Katalogvertrag
  `979/979/979`, keine unklassifizierten Dateien und keine Phasengrenzverletzung;
- JavaScript-Syntax und Diff-Prüfung: fehlerfrei;
- kein Browser verbunden; deshalb wird keine visuelle Browserabnahme behauptet.
