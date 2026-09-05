# Block 5 – Einzelverkäufe, Kassenhistorie und Kundenkäufe

Stand: 05.09.2026. Umsetzung lokal auf `feature/schedule-pdf-day-separators`, Ausgangs-HEAD `8e0131f3a036fdda2ebd4fcc6aaab45b8a359478`. Keine Versionierung, Veröffentlichung oder Produktivübernahme.

## Oberfläche

Unter **Verkauf → Verkaufsanalysen** ist ein eigener ausklappbarer Bereich **Einzelverkäufe & Kassenhistorie** vorbereitet. Bestehende PDF-Statistikberichte bleiben unverändert und getrennt.

- Explizite Suche nach Quelle, Datenart, Zeitraum und freigegebener Filiale; kein automatisches Laden aller Datensätze.
- Der bestehende Zeitraumkalender wird wiederverwendet. Standard: **Jahr bis Berichtsende**; ein Tag oder höchstens 366 Tage, keine Zukunftsauswertung.
- Optional: bestätigte GP-Personalnummer und ausdrücklich **Positionsverkäufer** oder **Belegverkäufer**. Kein Ersatz der einen Rolle durch die andere.
- Begrenztes Ergebnisfeld mit festen Tabellenüberschriften, Seitennavigation und als solche beschrifteter Seitensortierung. Aufklappbare Details zeigen Quelle, Quellstand, Zuordnung und Prüfstatus.
- Tagesaufschlüsselung, geprüfte Brutto-/Nettosummen sowie offene Artikel-, Filial- und optional Verkäuferzuordnungen. Fehlende Tage gelten als unbekannt, nicht als Umsatz null.
- Unter der Kundenkartei erscheint **Kundenkäufe** nur mit zusätzlicher Berechtigung. Es werden ausschließlich bestätigte CRM-Zielverknüpfungen berücksichtigt; Kundennummer `0` wird niemals zu einer Person.
- Keine Speicherung von Einzelverkäufen, Kundenkäufen oder Suchergebnissen im Browser-Speicher. Account-/Rechtewechsel und Abmeldung brechen offene Anfragen ab und leeren die Ansicht; verspätete Antworten werden verworfen.

Die Ansicht ist integriert, aber **absichtlich nicht an eine produktive Historienquelle angeschlossen**. Ohne später freigegebene, verwaltete Schlüssel- und Quellenkomposition erscheint ein sachlicher Hinweis. Die Komposition muss den Geschäftstag aus der geltenden App-Zeitzone ausdrücklich liefern; ein stiller UTC-Tageswechsel ist ausgeschlossen. Es gibt keinen Browser-Schalter, der Quellen registriert, Importgates entfernt oder Umsatzregeln genehmigt.

## Rechte und Datenschutz

Alle Zugriffe benötigen einen persönlichen Mitarbeiterzugang, den Verkaufsanalysezugang und einen vollständigen Filialbereich oder das Gesamtfirmenrecht.

| Neues Recht | Zusätzlicher Umfang |
| --- | --- |
| `sales:history:read` | Minimierte Einzelverkaufsdaten in freigegebenen Filialen |
| `sales:history:sellers:read` | Getrennte Verkäuferrollen und GP-Personalnummern |
| `crm:purchases:read` | Kundenkäufe; zusätzlich CRM-Zugang und Kundenleserecht |
| `sales:history:finance:read` | Getrennte Tagesberichte/Kassenjournale mit ausdrücklichem Quellstand |
| `sales:history:unassigned:read` | Datensätze ohne bestätigte Filialzuordnung; zusätzlich Gesamtfirmenrecht |

Die Kataloge und serverseitigen Abhängigkeiten sind ergänzt. Keine automatische Zuweisung an FL, Admin, IT, HR, AL oder Mitarbeiter. Die geschützte Developer-Rolle erhält weiterhin alle bekannten Anwendungsrechte. Ein Test am tatsächlichen App-Start prüft diese Grenze.

Entscheidend ist die **Verkaufsfiliale**, nicht ein eventuell anderer Lager-/Umlagerungsstandort der Position. Suche und entschlüsselte Detailprüfung erzwingen dieselbe Grenze. Persönliche Kundenschlüssel, Postleitzahlsnapshots, Provisionen und Einkaufskosten werden nicht als Nebenprodukt der allgemeinen Verkaufsansicht ausgeliefert. Belegprüfungen lesen erforderliche geschützte Felder intern; nach außen gelangt ausschließlich eine ausdrücklich ausgewählte Geschäftsprojektion.

## Auswertung und Grenzen

Umsatz entsteht nur aus einem vollständig abgeglichenen Beleg mit vertrauenswürdig registrierter fachlicher Regel und unabhängig ermittelter Quellmitgliedschaft. Bei Mitarbeiterfiltern wird nur der passende Positionsbetrag summiert, nicht nochmals der gesamte Beleg. Beträge werden dezimalgenau mit Ganzzahlarithmetik gerechnet; vorhandene Rabatte werden nicht ungeprüft ein zweites Mal abgezogen.

Pro Suchanfrage werden höchstens **5.000 passende importierte Datensätze** geprüft. Wird diese Grenze überschritten, sind Auswahl und offene Anteile ausdrücklich begrenzt; es gibt **keine Zeitraumssumme**. Dann muss die Suche eingegrenzt werden. Auch ein leeres Ergebnis beweist keinen Umsatz von null. Diese Schranke ersetzt keine spätere, für den Produktivbetrieb zu vermessende größere Analyseprojektion.

Tagesberichte und Kassenjournal sind eigene Datenarten, keine zusätzlichen Umsätze. Snapshot-Tabellen benötigen einen expliziten Quellstand; unterschiedliche Snapshots werden nicht addiert. Die Seite führt keine Zahlung, Lagerbewegung oder Artikelpreisänderung aus.

Seitencursor sind verschlüsselt und an Account, wirksame Rechte, Filter, Datenrevisionen und eine kurze Gültigkeit gebunden. Bei zwischenzeitlich geänderten Ergebnissen ist eine neue Suche erforderlich. Alle Antworten sind `private, no-store`; Such-POSTs benötigen zusätzlich CSRF.

## Technische Bestandteile

- `lib/sales-history-access.js`: getrennte Rechte, Projektion und Abhängigkeiten.
- `lib/sales-history-query.js`: strikter Filtervertrag und Geschäftstag.
- `lib/persistence/repositories/sales-history-workspace.js`: minimierende, transaktionale Abfrage-/Analysekomposition.
- `lib/sales-history-routes.js`: ausschließlich lesende, standardmäßig nicht aktivierte Quellenbrücke.
- `public/sales-history.js` / `public/sales-history.css`: gemeinsame Verkaufs-/Kundenkaufansicht und bestehende Themevariablen.
- Historien-DDL: authentifizierter Geschäftstag und Index; nun 21 benannte portable SQL-Verträge. Keine Registrierung der isolierten Importtabellen im App-Start.

Tests decken echte SQLite-Providerabfragen, fremde Verkaufs-/Lagerfilialen, Verkäuferrollen, Beträge, CRM-Verknüpfungen, Cursor, Analysegrenze, Rechteentzug, private HTTP-Antworten, CSRF, HTML-Escaping und verspätete Browserantworten ab. Browser-/Chrome-Steuerung und visuelle Freigabe wurden nicht durchgeführt. PostgreSQL ist auf Vertrags-/SQL-Compilerebene geprüft, nicht mit einem laufenden PostgreSQL-Server.

Weiterer Stand und noch offene fachliche Freigaben: [Block 6](BLOCK-6-PRUEFUNG-UND-ABNAHME.md).
