# Sinnvolle BWL-Erweiterungen für Verkauf und Warenwirtschaft

Stand: 09.10.2026. ABC-Analyse, Abverkaufs-Simulation und Maßnahmenliste sind im lokalen GP implementiert und mit synthetischen Daten geprüft. Diese Dokumentation belegt keinen produktiven Einsatz oder Deploy und keine Prüfung produktiver Kennzahlen.

## Ausgangspunkt im GP

Verkaufsanalysen liefern bereits Umsatz, Menge, Kundenanzahl und – mit eigenem Recht – Rohertrag. Einkauf & Bestand bietet gespeicherte Auswertungen zu Bestandswert, Nettoabsatz, rechnerischer Reichweite, Warenfluss, Bestellungen, Lieferantenrechnungen und Inventuren. Umlagerungs-, Beschaffungs- und Abverkaufshinweise sind bereits vorhanden. Dafür empfiehlt sich eine gezielte Erweiterung der vorhandenen Abläufe.

## Umgesetzte Werkzeuge

### ABC-Analyse

- Verkauf → BWL-Werkzeuge → ABC-Analyse: Zeitraum, eine oder mehrere erlaubte Filialen, Kennzahl und A-/B-Grenzen auswählen. Standardgrenzen: 80 und 95 Prozent. Höchstens 366 Tage und 5.000 Artikel-Filial-Gruppen.
- Die Auswertung liest veröffentlichte Kassenpositionen in begrenzten Stapeln. Retouren wirken mit ihrem Vorzeichen. Nicht zuordenbare und ungeklärte Positionen werden getrennt ausgewiesen; fehlende Werte werden nicht als Null behandelt.
- Klassen beruhen auf positiven, geprüften Beiträgen. Ein Artikel, der eine Grenze überschreitet, bleibt in der Klasse, in der sein Beitrag beginnt. Nichtpositive und ungeklärte Beiträge bekommen keinen irreführenden A-/B-/C-Rang.
- Rohertrag benötigt die bestehenden eigenen Freigaben und eine bestätigte historische Grundlage. Der heutige Durchschnitts-EK ersetzt keinen historischen Einstand.
- Pareto-Diagramm, Klassensummen, Prüfhinweise und anpassbare Tabelle; PDF enthält alle geprüften Ergebniszeilen mit dem verwendeten Datenstand.

### Abverkaufs-Simulation

- Auswahl nach Artikel, Sortiment, importiertem Bestand und erlaubten Filialen. Preisnachlass, angenommene Abverkaufsquote, Zeitraum bis 365 Tage und einmalige Zusatzkosten sind Szenarioannahmen.
- Aktuell akzeptierte Artikelpreise und Bestandswerte bilden die Grundlage. Netto-/Bruttobasis und Umsatzsteuer bleiben getrennt. Fehlende Kosten oder ungeklärte Bestände bleiben sichtbar; unvollständige Summen zeigen ihren bekannten Teilbetrag.
- Höchstens 10.000 Artikel-Filial-Zeilen. Die Simulation ist keine Nachfrageprognose und ändert keine Artikelpreise.
- Bis zu 20 benannte persönliche Varianten werden geschützt dauerhaft gespeichert. Exakte Versionen können geladen, verglichen, umbenannt, ausdrücklich ersetzt oder gelöscht werden. Alte Varianten behalten ihren ursprünglichen Datenstand.
- PDF des aktuellen geprüften Szenarios oder einer konkreten gespeicherten Variante, wahlweise mit Vergleich. Geänderte Eingaben erfordern eine neue Berechnung, auch nach dem Umbenennen einer Variante.

### Maßnahmenliste

- Gemeinsame Liste je erlaubter Filiale: Titel, Artikel, Priorität, Status, Fälligkeit, verantwortliche Personalnummer, Quellhinweis und Notiz/Ergebnis. Suche, Filter, Sortierung und geschützte persönliche Spaltenansicht.
- Manuelle Anlage oder gezielte Übernahme einer Zeile aus der ABC-Analyse bzw. aus einer aktuellen Simulation. Der Server prüft die Quelle bei der Speicherung erneut; historische Simulationsvarianten erzeugen keine vermeintlich aktuellen Quellhinweise.
- Verantwortliche werden nur unter aktiven Mitarbeitenden der gewählten Filiale angeboten; Personalnummer und Vorname genügen der Auswahl. Finanzwerte werden nicht in die Maßnahme kopiert.
- Schreiben benötigt eine berechtigte organisatorische Rolle, die bestehende Lesefreigabe für die ganze Filiale und das ausdrückliche Zusatzrecht `sales:bwl:actions:write`. Es gibt keine automatische neue Schreibfreigabe für FL oder AL.
- Gleichzeitige Teamänderungen werden über Versionsvergleich erkannt. Ein Konflikt erhält den Entwurf und verlangt ausdrücklich den aktuellen Stand. Erledigen, Verwerfen oder erneutes Öffnen verlangt eine neue Ergebnis-/Begründungsnotiz.
- Höchstens 500 Maßnahmen je Filiale, mit geschützter Speicherung und neutralem Änderungsprotokoll. PDF exportiert alle zur gestarteten Suche passenden gespeicherten Einträge einschließlich langer Notizen.

## Gemeinsamer GP-Standard

Alle drei Werkzeuge erhalten ihre Eingaben und Ergebnisse bei gewöhnlicher Navigation innerhalb des GP. Persönliche Tabellenansichten werden dauerhaft und kontogebunden gespeichert. Benannte Simulationsvarianten und gespeicherte Maßnahmen sind dauerhaft; ungespeicherte Formulare werden nicht als Neustart-sichere Speicherung ausgegeben. Konto- und Rechtewechsel räumen nicht mehr erlaubte Inhalte auf.

Die PDF-Ausgaben verwenden das gemeinsame [GP-Druckfenster](GP-DRUCKFENSTER.md): Titel, Dateiname, Hoch-/Querformat, Spaltenauswahl, echte PDF-Seitenzahl, Seitenwechsel und Zoom. Vorschau und Download nutzen dieselben serverseitig geprüften Bytes. Die neue Developer-Seite zeigt Fenster-, Druck-, Tabellen-, Ansichts- und Designstandards; der Eintrag öffnet über „Developer“ in der Sidebar.

## Spätere Ergänzungen

| Werkzeug und Nutzen | Vorhandene Grundlage | Voraussetzung |
| --- | --- | --- |
| Lieferantenübersicht: Offene Mengen, Teillieferungen und Bestell-/Rechnungsabweichungen bündeln. | Bestellpositionen, Warenbewegungen und Lieferantenrechnungen. | Eindeutige Belegverknüpfung, Storno und Abschlussstatus. Lieferpünktlichkeit erst mit vereinbartem Liefertermin messen; das Bestelldatum genügt nicht. |
| Lagerumschlag und GMROI: Kapitalbindung und Ertrag eines Sortiments über die Zeit bewerten. | Aktueller Bestand und Bestandswert als Ausgangspunkt. | Regelmäßige, lückenlos zugeordnete Bestands- und Kostenstände über die ganze Periode sowie konsistenter Periodenrohertrag. Ein aktueller Bestand ist kein durchschnittlicher Lagerbestand. |
| XYZ-Ergänzung zur ABC-Analyse. | Artikelbezogene erfasste Verkaufspositionen. | Genügend vollständige vergleichbare Zeitreihen; derzeit nicht umgesetzt. |

## Fachliche Einordnung und Quellen

ABC ordnet Artikel nach ihrem Wertbeitrag; XYZ ergänzt die Schwankung des Absatzes. Dies entspricht dem beschriebenen Verfahren in [SAP: Manage ABC/XYZ Segmentation Rules](https://help.sap.com/docs/SAP_INTEGRATED_BUSINESS_PLANNING/feae3cea3cc549aaa9d9de7d363a83e6/a325b74b416b4edabe25f131a3ec5a32.html). Die Priorisierung für den GP ist eine eigene Empfehlung anhand der vorhandenen Daten.

Preisreduzierungen, Lieferantenabweichungen und Lagerkennzahlen sind etablierte Handelsanalysen. Lieferantenpünktlichkeit setzt geplante Termine voraus; Bestandswerte sind über die Zeit nicht einfach addierbar. [Oracle Retail Insights 26.1: Metrics](https://docs.oracle.com/en/industries/retail/retail-insights-cloud/26.1.101.0/rinug/metrics1.htm), Abschnitte „Markdowns and Markups“, „Supplier Invoice“, „Supplier Compliance“ und „Inventory Position Analysis“.

## Datenlücken, die die Anzeige berücksichtigen muss

- „Ohne Verkauf“ bedeutet im GP keinen erfassten Verkauf im ausgewählten Zeitraum. Es belegt kein tatsächliches Lageralter.
- „Bestellt“ und „im Zulauf“ werden in den Bestands-Hinweisen als ungeprüfte Quellwerte behandelt. Auch das Alter des Importstands ist kein Alter einzelner physischer Artikel.
- Der aktuelle Durchschnitts-EK ist kein nachgewiesener historischer Einstand jeder Verkaufsposition. Ein neuer Ertragsbericht darf diese Größen nicht gleichsetzen.
- Ein Nullbestand belegt noch keinen entgangenen Umsatz. Saison, Öffnungstage, Mindestpräsentationsbestand und Artikelstatus müssten bei einer späteren Bedarfsprognose berücksichtigt werden.

Codegrundlage: `lib/persistence/repositories/trade-stock.js`, `lib/persistence/repositories/trade-suggestions.js`, `lib/persistence/repositories/trade-insights.js`, `lib/sales-analytics-access.js` und `public/sales-dashboard-metrics.js`.
