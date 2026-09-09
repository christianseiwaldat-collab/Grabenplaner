# Trade/Kassa: Optimierung, Blöcke 4–6

Stand: 09.09.2026. Lokal umgesetzt; kein Commit, Push oder Deployment. Die Produktivdatenbank wurde weder verändert noch neu importiert. Kein Dienst- oder Ubuntu-Neustart.

## Block 4: häufige Suchwege

Die Standardliste des Trade-Artikelstamms verwendet die vorhandene vorbereitete Suchprojektion mit einer direkten indexgestützten Sortierung nach Artikelnummer. Ohne Such-/Quellfilter wird die exakte Anzahl ausschließlich nach Aktivstatus gezählt. Andere Filter, Sortierungen, Wildcards und Alternativkennungen behalten ihre bisherigen Regeln. Ein Ausführungstest prüft ausdrücklich, dass die normalen Standardparameter diesen Pfad erreichen; der Abfrageplan benötigt dabei keinen temporären Sortierbaum.

Die Kassenabfrage für eine bestätigte Filiale ermittelt passende Quellkennungen über den Zielindex der Zuordnungstabelle. Die separate Abfrage für nicht zugeordnete Belege bleibt erhalten. SQLite darf entsprechend Zeitraum und Verteilung den Datums- oder Filialindex wählen; ein bestimmter Filialindex wird nicht erzwungen. Verkäufer-, Kunden-, Zeitraum- und Cursorfilter bleiben gleich.

| Lokale synthetische Messung | Bisheriger Vergleichspfad | Implementierter Pfad |
| --- | ---: | ---: |
| Trade: Standardliste mit exakter Anzahl, 19.024 Artikel | 40,695 ms | 0,415 ms |
| Trade: gezielte Textsuche, gleicher Datenbestand | 1.495,643 ms | 18,494 ms |
| Kassa: 50 Belege einer Filiale, Jahreszeitraum | 0,752 ms | 0,445 ms |
| Kassa: 50 Positionen einer Filiale, Jahreszeitraum | 0,789 ms | 0,593 ms |

Trade vergleicht den ursprünglichen Suchweg vor Block 1 mit dem Stand nach Block 4; die gezielte Textsuche wurde bereits in Block 1 beschleunigt. Kassa vergleicht den allgemeinen und neuen Filialpfad nach Block 3. Die Kassenmessung enthält 30.000 Belege, 120.000 Positionen und 20 Filialen, misst aber ausschließlich SQL in einer Speicher-Datenbank. Netzwerk, Entschlüsselung und Darstellung sind darin nicht enthalten. Die Resultate werden jeweils auf Gleichheit geprüft. Keine Produktiv-Latenzzusage.

FTS bleibt ein isolierter Vergleichsprototyp. Für die bereits kurze Trade-Suche rechtfertigt diese Messung keinen zusätzlichen produktiven Volltextindex mit eigenen Import-, Wiederaufbau- und Suchregeln.

Nachweise: [Trade-Messung](TRADE-OPTIMIERUNG-BLOCK-4-MESSUNG-2026-09-09.json), [Kassenmessung](KASSA-OPTIMIERUNG-BLOCK-4-MESSUNG-2026-09-09.json). Reproduzierbar mit `node scripts/benchmark-sales-search.js` und `node scripts/benchmark-cash-assigned-search.js`; beide öffnen ausschließlich fest vorgegebene synthetische Speicher-Datenbanken.

## Block 5: Betrieb und Wiederherstellung

Der Dateidatenbank-Test verarbeitet eine verifizierte Kassenquelle mit 205 Positionen über mehrere Schritte. Eine zweite SQLite-Verbindung hält während des ersten Leseschritts eine offene Schreibtransaktion. Die Auswertung bleibt lesbar und erreicht exakt 2.460,00 EUR. Nach einer isolierten SQLite-Sicherung und Öffnung mit frischem Provider und frischem Laufzeitcache ergeben sich dieselben 205 Positionen und dieselbe Summe. `quick_check` ist erfolgreich; `foreign_key_check` liefert keine Verletzungen.

Auch ein vor der Sicherung angelegter Berichtsauftrag ist in der wiederhergestellten Testdatenbank ausführbar. Die ursprüngliche Datenbank bleibt dabei unverändert. Bestehende Prüfungen für einmalige Inventarmigration, Quellenänderungen trotz gleicher Zeilenzahl und fehlende Verifikation bleiben aktiv.

Dies ist ein begrenzter lokaler Abnahmeversuch, kein erneuter Vollimport und kein Lasttest des VPS. Vor einem später ausdrücklich beauftragten Release sind vorgesehen:

1. Bestehende Release-Vorprüfungen, Speicherplatz, Versionsstand und verwaltete Sicherung einschließlich Schlüsselmaterial prüfen.
2. Auf einer isolierten Kopie mit dem vorgesehenen Server-Node-/SQLite-Stand Schemaöffnung, Inventare und repräsentative Suchwege prüfen; keinen erneuten Trade-/Kassen-Vollimport auslösen.
3. Im freigegebenen Wartungsablauf Anwendung ausrollen; anschließend Dienstbereitschaft, Abfragezeiten, Stichprobensummen und einen persönlichen Berichtsauftrag prüfen.
4. Bei Fehlern den bestehenden dokumentierten Rückweg verwenden. Berichte dürfen nach Ablauf einer übernommenen Arbeitsreservierung erneut von vorn beginnen; sie dürfen keine Teilsummen als fertiges Ergebnis veröffentlichen.

Ein Ubuntu-Sicherheitsneustart bleibt ein eigener, später freizugebender Wartungsvorgang. Dieser Block führt ihn nicht aus.

## Block 6: persönliche Hintergrundberichte

Unter **Bericht erstellen** lassen sich Titel, Zeitraum und Filiale für eine Umsatzauswertung angeben. Der erste Berichtstyp umfasst höchstens 366 Kalendertage und die geprüfte Kassendatenquelle. Freie natürlichsprachliche Analysen, Warengruppenlogik und weitere Berichtstypen sind nicht vorgetäuscht.

**Berichte** zeigt persönliche Aufträge, Status, verarbeitete Positionen, Wiederanläufe und fertige Ergebnisse. Unterstützt werden Abbrechen, erneutes Beauftragen nach Fehler/Abbruch, Entfernen abgeschlossener Aufträge sowie Download. Das Ergebnis ist ein eigenständiger druckbarer HTML-Bericht mit Tageswerten und Kennzeichnung unbestätigter Kennzahlen; die bestehenden PDF-Analysen bleiben ein eigener Menüpunkt.

Technischer Betrieb:

- Die Warteschlange liegt in SQLite. Antrag, Auftraggeber, Rechteabdruck und fertiges Dokument sind mit verwalteten Schlüsseln verschlüsselt. Klartext-Metadaten enthalten nur zufällige ID, pseudonymisierten Eigentümerindex, Status, Zeiten und Arbeitsreservierung.
- Der Server verarbeitet maximal einen begrenzten Auswertungsschritt von 200 Positionen pro Sekundentakt. Ein begonnener Auftrag wird bevorzugt fortgeführt. Der Browser muss nicht geöffnet bleiben. Die Verarbeitung läuft kooperativ im bestehenden Serverprozess, nicht in einem separaten Rechenprozess.
- Rechte und aktive persönliche Zugänge werden vor jedem Schritt aus der aktuellen Datenbank neu aufgelöst. Es werden keine Browser-Cookies oder Sitzungstokens gespeichert. Download und API prüfen die aktuellen persönlichen Rechte erneut.
- Der Auftrag bindet sich an den bei Auftragserteilung verfügbaren Quellen-/Regelstand. Ein geänderter Stand beendet den Auftrag mit einer nachvollziehbaren Fehlermeldung; eine neue Auswertung muss erneut beauftragt werden.
- Eine 30-Sekunden-Reservierung und Revisionsvergleich schützen gegen parallele Übernahme und verspätete Abschlüsse. Nach Prozessverlust beginnt der betroffene Auftrag wieder bei null; nach drei Wiederanläufen wird kein weiterer automatischer Versuch begonnen.
- Abbruch gewinnt auch gegen einen bereits berechneten, aber noch nicht gespeicherten Abschluss. Beschädigte Aufträge blockieren die nachfolgenden Aufträge nicht. Fertige Hintergrundanalysen geben ihre temporären Prüfpunkte frei.
- Pro Person höchstens drei offene und insgesamt 50 gespeicherte Aufträge; abgeschlossene Aufträge können entfernt werden. Es werden keine Rohbelege oder Kunden-/Mitarbeiterdetails in den Bericht übernommen.

## Prüfung und Grenzen

Die gezielte Testsammlung besteht vollständig: **136/136 Tests**, keine Fehler oder übersprungenen Tests. Sie umfasst Artikelabfragen, exakte Kassenwerte, Dateidatenbank-Wiederherstellung, persönliche Eigentümerschaft, Rechteentzug, CSRF, geschützte Downloads, Übernahme nach Prozessverlust, Abbruchrennen, beschädigte Aufträge und Freigabe temporärer Prüfpunkte nach 66 aufeinanderfolgenden Berichten. Zusätzlich sind Katalog, Dialektgrenzen und Provider-Vertrag geprüft. Abschlussprotokoll: `tmp/database-block4-6-final-tests.log`. Syntaxprüfungen und `git diff --check` sind ebenfalls erfolgreich.

Die echte neue Formular-/Listenoberfläche wurde mit synthetischen Antworten im lokalen Browser geprüft: Standardansicht und 390-Pixel-Mobilansicht, lange Titel, Auftragsschaltfläche und Suchfilter; kein horizontaler Seitenüberlauf, keine Browserfehler. Dies ersetzt keinen späteren Produktivtest mit Anmeldung.

Der Katalog enthält nun 1.348 Statements: 1.233 generierte PostgreSQL-Syntaxkandidaten und 115 erforderliche Overrides. Die neue Principal-Abfrage benötigt ebenfalls einen expliziten PostgreSQL-Override. Die produktive PostgreSQL-Freigabe bleibt geschlossen (0/1.348); diese Arbeit aktiviert keinen anderen Datenbankprovider.
