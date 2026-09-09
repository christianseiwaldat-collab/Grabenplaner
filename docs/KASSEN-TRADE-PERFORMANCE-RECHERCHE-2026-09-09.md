# Ladezeiten von Kassenhistorie und Trade-Artikelstamm

Umsetzungsnachtrag vom 9. September 2026: Die beauftragten Blöcke 1–3 sind inzwischen lokal umgesetzt und geprüft. Maßnahmen, konkrete Messwerte und verbleibende Grenzen stehen im [Umsetzungsbericht](TRADE-KASSA-OPTIMIERUNG-BLOECKE-1-3-2026-09-09.md). Die folgende Recherche dokumentiert die ursprüngliche Untersuchung; eine produktive Veröffentlichung ist damit nicht behauptet.

Die größten nachweisbaren Verbesserungsmöglichkeiten liegen in den Lesewegen der Anwendung. Die Trade-Artikelsuche berechnet Suchtexte und Sortierschlüssel wiederholt während der Abfrage. Die Belegsuche prüft beim Einstieg erneut den gesamten bereitgestellten Kassenbestand und verarbeitet anschließend viele Einzelbelege einschließlich ihrer Positionen. Ein größerer Server oder ein Wechsel des Datenbanksystems allein würde diese Arbeit nicht beseitigen.

Empfohlen wird zuerst eine kompakte, vorbereitete Suchprojektion für Artikel und Belege, ergänzt um kürzere reine Lesetransaktionen und einen gezielten Umgang mit Bestandsnachweisen. Danach folgen Indexpflege, belastbare Messungen unter gleichzeitiger Nutzung und die Auslagerung langer Berichte in einen eigenen Prozess. Die verschlüsselten Quelldaten, geprüften Geldbeträge und personenbezogenen Zugriffsgrenzen bleiben dafür verbindlich.

## Untersuchungsbasis und Aussagegrenzen

Untersucht wurden die aktuelle Anwendung, ihre SQLite-Abfragen, die Quelle der Kassenbereitstellung und die Suchoberfläche. Zusätzlich erfolgte eine schreibgeschützte Prüfung des produktiven Datenbankschemas und seiner Abfragepläne. Die Verbindung wurde mit `readOnly:true` und `PRAGMA query_only=ON` geöffnet und der externe Prozess auf 25 Sekunden begrenzt. Es wurden keine Datenbankinhalte verändert, keine Statistiken geschrieben, keine Dienste neu gestartet und keine personenbezogenen Datensätze exportiert.

Die Produktionsaufnahme stammt vom 9. September 2026, 00:53 Uhr Wiener Zeit. Sie beschreibt diesen Zeitpunkt; sie ist kein kontinuierliches Lastprofil. Die vollständigen Metadaten und Abfragepläne stehen in [KASSEN-TRADE-ABFRAGEPLAENE-2026-09-09.json](KASSEN-TRADE-ABFRAGEPLAENE-2026-09-09.json). Die Produktivsuche wurde für diese Untersuchung nicht mit einer künstlichen Lastfolge belastet. Deshalb enthält der Bericht keine behauptete gemessene Produktivlatenz oder Auslastungsursache.

| Beobachtung am Server | Ergebnis | Einordnung |
|---|---:|---|
| Laufzeit | Node.js 22.22.1 | Anders als die lokale Versuchsumgebung |
| SQLite | 3.46.1 | Neuere Optimiererpflege mit `PRAGMA optimize` ist grundsätzlich verfügbar |
| Hauptdatei | 2.653.732.864 Bytes, etwa 2,47 GiB | Dateigröße allein belegt keinen Engpass |
| Journalmodus | WAL | Bereits aktiv |
| WAL-Datei bei Aufnahme | 5.145.912 Bytes | Eine Momentaufnahme, kein Nachweis eines dauerhaft wachsenden Journals |
| Freie Datenbankseiten | 0 | Aus dieser Aufnahme ergibt sich kein Platzgewinn durch bloßes Zusammenpacken |
| Artikel / Artikelrevisionen | 19.024 / 19.031 | Der Suchbestand ist überschaubar; wenige zusätzliche Revisionen |
| Artikelkennungen | 18.420 | Kennungen werden bei der Suche gesondert gelesen |
| Artikel-Importsnapshots | 2 | Kein Hinweis auf eine riesige Zahl alter Artikelrevisionen |
| Kompakte Kassendatensätze | 1 | Die Kasse nutzt die sieben kompakten Quelltabellen |
| Optimiererstatistiken | `sqlite_stat1` fehlt | SQLite muss ohne diese Verteilungsinformationen planen |

Das vorhandene Kassenspeicherkonzept wurde nicht durch eine zweite vollständige Historienkopie ersetzt. Die aktive Kassenanbindung liest ihre unveränderlichen kompakten Tabellen unmittelbar. Vorschläge, eine vermeintlich doppelte universelle Kassenhistorie zu löschen, wären daher am tatsächlichen Leseweg vorbei geplant.

## Trade-Artikelstamm: Befunde

### Suchtexte werden für jeden Kandidaten neu aufgebaut

`lib/flexible-search.js` setzt flexible Suchbegriffe in bis zu zehn Bedingungen um. Artikelnummer, Bezeichnung und primäre Kennung werden dabei über `gp_unicode_casefold` sowie zahlreiche verschachtelte `REPLACE`-Aufrufe normalisiert. Die Logik berücksichtigt unter anderem Umlaute, Trennzeichen, unterschiedliche Reihenfolgen und Platzhalter. Sie ist funktional wertvoll, wird aber während jedes Suchdurchlaufs wiederholt ausgeführt.

Die Bedingungen verwenden Teilstringsuchen mit führendem `%`. Ein gewöhnlicher Index auf der unveränderten Artikelbezeichnung kann diese berechneten Suchtexte nicht einfach ersetzen. Auch ein zusätzlicher Index auf jeder beliebigen Quellspalte wäre daher keine ausreichende Maßnahme. Die wiederkehrende Normalisierung sollte beim Import beziehungsweise bei einer Artikeländerung einmal berechnet und zusammen mit der aktuellen Suchprojektion gespeichert werden.

### Barcodeauswahl und Sortierung erhöhen die Arbeit

Die Abfrage in `lib/persistence/sqlite/sales-article-catalog-catalog.js` ermittelt die primäre Kennung mit einer korrelierten Unterabfrage und eigener Sortierung. Derselbe Ausdruck erscheint in Suchbedingungen, Ergebnisprojektion und mehreren Sortierzweigen. Der produktive Abfrageplan enthält zahlreiche solche Unterabfragen und temporäre Sortierstrukturen.

Das ist ein struktureller Befund, keine Zählung tatsächlich ausgeführter Unterabfragen: Leere Suchparameter und nicht ausgewählte `CASE`-Zweige können zur Laufzeit Arbeit überspringen. Trotzdem muss der Optimierer einen sehr allgemeinen Ausdruck planen. Die äußere Artikelliste benötigt laut Plan eine temporäre Sortierung. SQLite kann passende mehrspaltige Indizes grundsätzlich gleichzeitig für Filterung und Reihenfolge nutzen; die aktuelle allgemeine `CASE`-Sortierung erschwert genau diesen einfachen Leseweg.[^1]

### Jede Seite zählt die gesamte Treffermenge zusätzlich

`salesArticleCatalogRepository.search()` ruft sowohl die Trefferliste als auch `countSearch` auf. Die zweite Abfrage wiederholt die Suchbedingungen, damit die Oberfläche eine exakte Gesamtzahl anzeigen kann. Die beiden JavaScript-Promises machen die synchronen Datenbankaufrufe nicht zu unabhängiger CPU-Arbeit. Auch bei 50 angezeigten Artikeln kann die Datenbank den gesamten Kandidatenbestand zweimal prüfen.

Die empfohlene Listenantwort liefert zunächst 51 Zeilen für eine sichtbare Seite von 50: Daraus ergibt sich zuverlässig, ob weitere Treffer existieren. Eine exakte Gesamtzahl kann bei Bedarf separat, verzögert und an denselben Datenstand gebunden ermittelt werden. Die Oberfläche muss eine noch unbekannte Gesamtzahl entsprechend kennzeichnen. Ein begrenzter Durchlauf darf keine unvollständige Zahl als Gesamtbestand ausgeben.

### Geeignete Suchprojektion

Eine kleine Tabelle für den aktuellen Artikelstand sollte Produktkennung, Artikelnummer, Bezeichnung, freigegebene primäre Kennung, Status, Quellsystem, normalisierte Suchfelder und feste Sortierschlüssel enthalten. Historische Revisionen und Preisdetails bleiben in den bestehenden Tabellen. Die Projektion wird innerhalb derselben Import- oder Änderungstransaktion aktualisiert. Import-Rücknahme, Archivierung, manuelle Bearbeitung und Wechsel der primären Kennung müssen sie ebenfalls aktualisieren.

Für feste, erlaubte Sortierungen werden getrennte vorbereitete SQL-Varianten verwendet. Benutzereingaben wählen eine Variante aus einer Liste; sie werden niemals direkt als SQL-Bezeichner eingesetzt. Sinnvolle Indexkandidaten sind beispielsweise `(active, article_number_sort, product_id)` und entsprechend die häufig genutzte Bezeichnungssortierung. Die konkrete Reihenfolge muss anschließend mit realen Filtern und Datenverteilungen geprüft werden.

Die primäre Barcodeauswahl sollte nicht während jeder Trefferprüfung neu stattfinden. Für die Suche nach alternativen Kennungen bleibt eine eigene indexierte Zuordnung nötig: Die primäre Anzeige ist keine vollständige Liste sämtlicher EAN-/GTIN-Identitäten.

## Kassenberichte und Belegsuche: Befunde

### Bestandszählungen liegen im Einstieg jeder Anfrage

`createManagedSalesHistoryRuntime.run()` lädt für jede Anfrage die aktive Kassenbereitstellung. `cash-publications.load()` ruft dafür `candidate()` auf. Diese Funktion zählt sämtliche Zeilen aller sieben kompakten Kassentabellen und gleicht sie mit den erwarteten Mengen ab. Zusätzlich wird die Anzahl der veröffentlichten Bindungen geprüft. Der bereits bestätigte Importumfang wird damit beim normalen Lesen wiederholt kontrolliert.

Das ist ein besonders wichtiger Optimierungsansatz, weil die Kosten mit dem Gesamtbestand wachsen und nicht mit den 50 sichtbaren Treffern. Ein Abgleich nach jedem Import und vor jeder Veröffentlichung ist sinnvoll. Für normale Leseanfragen braucht es einen an den unveränderlichen Datensatz gebundenen, verifizierbaren Nachweis, der kostengünstig gelesen werden kann.

Ein bloßes Weglassen der Zählung wäre fachlich unzureichend. Vor einer Umstellung müssen Unveränderlichkeit, Integritätsprüfung, Veröffentlichung und Rücknahme sauber zusammenpassen. Ein Cache darf erst nach erfolgreicher Verifikation gefüllt werden und muss mindestens Datensatzkennung, Revision, aktive Veröffentlichung, Regelfingerprint und Integritätszustand berücksichtigen. Ein beschädigter, ausgetauschter oder nicht vollständig freigegebener Bestand darf dadurch nicht als vollständiger Bestand erscheinen. Dazu gehören gezielte Negativtests mit fehlenden und manipulierten Quellzeilen.

### Für Suchzeilen werden ganze Belege verarbeitet

`receipt-workspace.scan()` liest pro Schritt höchstens 100 Kandidaten, begrenzt über Datum und erlaubte Filiale. Danach lädt `document()` den Belegkopf, Kundenreferenzen, alle Positionen und die Prüfung des Belegs. Die Kopfprüfung kann bestimmte Kandidaten früh ausscheiden. Eine allgemeine Artikel- oder Bezeichnungssuche wird aber erst nach der Positionsverarbeitung ausgewertet.

Für einen angenommenen Beleg mit fünf Positionen bedeutet die derzeitige Verarbeitung: Kopf lesen, Positionen lesen, die Positionen für die Betragsprüfung erneut lesen sowie Referenzen für Kopf und Positionen nachladen. `cash-history-backend` hält zwar dekodierte Datensätze innerhalb eines Lesers im Cache; die Referenzauflösung und der zweite Positionsabruf werden dadurch nicht vollständig vermieden. Die beiden Aufrufe `children()` und `receipt()` lassen sich aus demselben verifizierten Positionssatz bedienen.

Die Trefferliste benötigt eine separate, kompakte Zusammenfassung: Belegkennung, Datum, Filiale, Kasse, erlaubte Suchkennungen, Positionsanzahl, kurze Beschreibung, geprüfte Summe und Prüfstatus. Die ausführlichen Positionen gehören in das Öffnen oder Exportieren eines Belegs. Für diese Zusammenfassung müssen die bestehende exakte Geldarithmetik und der Regelfingerprint erhalten bleiben. Eine ungeprüfte Quellsumme darf keinen geprüften Betrag ersetzen.

### Die vorhandenen Indizes helfen bereits – aber nicht allen Filtern

Die schreibgeschützten Abfragepläne zeigen die Verwendung der vorhandenen Datumsindizes. Es handelt sich somit nicht um einen generellen Mangel an Kassenindizes. Die Filialauswahl wird derzeit über einen Join mit der Bindungstabelle ausgewertet. Der Plan kann dennoch einen Datumsbereich durchlaufen und die Filialzuordnung anschließend prüfen.

Zu untersuchen ist eine vorab verifizierte Auflösung erlaubter Filialen zu ihren Quellschlüsseln. Danach kann die Suche direkt die vorhandene Kombination aus Datensatz, Filialschlüssel, Datum und Quellzeile benutzen. Die Bindungsprüfung und Rechteprüfung müssen davor stattfinden. Verkäufer- und Kundenfilter benötigen entsprechend eigene zulässige Varianten; „nicht zugeordnet“ bleibt ein eigener Fall. Nicht jeder Datensatz benötigt neue Indizes: zuerst die vorhandenen gezielt ansprechen.

Die gegenwärtige Suche selektiert außerdem alle Spalten der kompakten Zeile, obwohl `backend.search()` anschließend nur Kennung und Geschäftsdatum verwendet. Ein schmaler Kandidatenabruf reduziert unnötige verschlüsselte Payloads und erlaubt eher einen abdeckenden Index. Ob dieser Schritt allein relevant ist, wird über gelesene Zeilen, Datenmenge und Zeit vor und nach der Änderung gemessen.

### Lesetransaktionen reservieren derzeit einen Schreibzugriff

Die Kassenarbeitsbereiche verwenden Transaktionen mit `isolation: 'serializable'`, aber ohne `readOnly: true`. Der SQLite-Provider beginnt solche Transaktionen mit `BEGIN IMMEDIATE`. Reine Leseanfragen reservieren damit die Schreibseite. Der Provider unterstützt bereits einen expliziten Nur-Lese-Modus mit `BEGIN` und `query_only`.

Die Umstellung muss jeden Callback darauf prüfen, ob er wirklich ausschließlich liest. Die Bereitstellung eines Datensatzes oder das Erzeugen von Schlüsseln gehört weiterhin in eine Schreibtransaktion. WAL erlaubt parallele Leser und einen Schreiber, aber weiterhin nur einen Schreiber gleichzeitig. Lange Lesetransaktionen können außerdem Checkpoints aufhalten. Deshalb sind kurze Leseschritte auf einer eigenen Leseverbindung sinnvoller als ein lang offener Snapshot für eine ganze Recherche.[^2]

### Andere Sortierungen benötigen bisher einen vollständigen Suchlauf

Für Datum absteigend existiert bereits eine Cursor-Suche. Andere Sortierungen laufen über `receipt-result-store.js`: Treffer werden schrittweise gesammelt, verschlüsselt im Speicher gehalten und erst bei vollständigem Ergebnis sortiert. Die Grenzen von 10.000 Zeilen, 16 MiB je Ergebnis und 64 MiB insgesamt sind echte Schutzgrenzen. Bei großen Zeiträumen führt dieses Verfahren nachvollziehbar zu einer längeren Wartezeit.

Häufige Sortierungen sollten auf vorbereiteten Belegzusammenfassungen direkt in der Datenbank erfolgen. Für verbleibende große Auswertungen eignet sich der geplante Bereich „Berichte“: Auftrag annehmen, Fortschritt anzeigen, Arbeit serverseitig fortsetzen und fertiges Ergebnis bereitstellen. Ein unvollständig gesammeltes Ergebnis darf weiterhin nicht als vollständig sortierte Gesamtliste erscheinen.

## Lokaler Suchversuch

Ein reproduzierbarer Versuch verwendet dieselbe aktuelle Artikel-SQL-Abfrage und 19.024 ausschließlich künstliche Artikel. Jeder Artikel hat genau eine Revision und eine Kennung. Verglichen werden die bisherige Suche, eine vorbereitete Suchprojektion und zusätzlich ein Trigrammindex. Alle Varianten liefern für die geprüften Suchfälle identische erste 50 Kennungen und identische Trefferzahlen.

| Suchfall | Bisheriges SQL | Vorbereitete Suchprojektion | Zusätzlich FTS5 | Treffer |
|---|---:|---:|---:|---:|
| Ohne Suchbegriff | 33,940 ms | 0,140 ms | nicht benötigt | 19.024 |
| `Testkamera 17001` | 1.503,653 ms | 7,051 ms | 0,603 ms | 1 |
| `unauffindbar` | 766,590 ms | 3,921 ms | 0,016 ms | 0 |

Gemessen wurde jeweils Liste einschließlich Gesamtzählung, nach einem Aufwärmlauf als Median aus drei Wiederholungen. Umgebung: Windows, Node.js 24.19.0, SQLite 3.53.3, Datenbank im Arbeitsspeicher. Das Schema bildet die von dieser Abfrage verwendeten Tabellen und Indizes ab, nicht den gesamten Produktionsbestand. Kein Netzwerk, keine konkurrierenden Benutzer und keine realen Kassenpayloads waren beteiligt.

Die absoluten Werte und Faktoren dürfen deshalb nicht als Serverversprechen verwendet werden. Der Versuch isoliert jedoch den Effekt der wiederholten Suchtextberechnung und zeigt, dass bereits die vorbereitete Projektion einen erheblichen Teil der Arbeit vermeidet. Die Unterschiede der Node-/SQLite-Versionen müssen bei einer späteren produktionsnahen Abnahme berücksichtigt werden.

Reproduktion: `node scripts/benchmark-sales-search.js`. Ergebnis: [KASSEN-TRADE-SUCHVERSUCH-2026-09-09.json](KASSEN-TRADE-SUCHVERSUCH-2026-09-09.json).

## Suchtechnik, Schutz und Hintergrundverarbeitung

FTS5 mit Trigrammen ist für Teilstrings ein sinnvoller Kandidat. Die vorhandene `LIKE ... ESCAPE '!'`-Form kann jedoch nicht unverändert auf einen Trigrammindex übertragen werden: SQLite dokumentiert, dass eine `ESCAPE`-Klausel diese LIKE-Optimierung verhindert. Sehr kurze Begriffe und reine Platzhaltermuster brauchen außerdem einen begrenzten Ersatzpfad. Für `MATCH` müssen Benutzereingaben als Literale behandelt werden; sie dürfen keine FTS-Abfragesyntax einschleusen.[^3]

Empfohlen wird ein zweistufiges Verfahren: Ein Index liefert eine nachweislich vollständige Kandidatenmenge für ausreichend lange feste Teilstücke, anschließend prüft die bestehende Suchsemantik exakt. Tests müssen Umlaute, ß, Leerzeichen, Trennzeichen, `*`, `?`, `%`, `_`, `!`, mehrere Wörter in vertauschter Reihenfolge sowie kurze Kennungen abdecken. Ein schnellerer Index ist nur brauchbar, wenn er keine bisher gültigen Treffer verliert.

Für Kunden- und Beleginformationen entsteht eine zusätzliche Anforderung: Die Kassenquelle ist verschlüsselt. Eine allgemeine Klartext-FTS-Tabelle über Namen, Adressen oder vollständige Belegtexte würde diese Schutzgrenze erweitern. Zunächst sollten nicht personenbezogene Artikelsuchdaten und bereits zugelassene Metadaten optimiert werden. Für personenbezogene Belegsuche sind getrennte berechtigte Suchprojektionen, geeigneter Schutz der gespeicherten Suchdaten und eine ausdrückliche Datenklassifizierung erforderlich. Ein Hashindex eignet sich für exakte Identitäten, nicht automatisch für beliebige Teilstringsuchen.

Alle Suchcaches und Berichtsergebnisse müssen an Benutzer beziehungsweise Konto, effektive Rechte, Geltungsbereiche, aktive Veröffentlichung und Datenstand gebunden sein. Rechteentzug, Filialwechsel oder Rücknahme eines Imports müssen alte Ergebnisse ungültig machen. Auch beim Herunterladen fertiger Berichte wird die aktuelle Berechtigung erneut geprüft. CRM-Kundennummer, Trade-Quellkonto und weiteres Quellkontofeld bleiben getrennte Identitäten; fehlende Verknüpfungen werden nicht durch unscharfe Namenszuordnung ersetzt.

`DatabaseSync` führt seine Datenbankoperationen synchron aus. Lange Abfragen oder umfangreiche Entschlüsselung können deshalb den Node-Prozess während der Arbeit aufhalten.[^4] Für große Berichte ist ein eigener Worker-Prozess mit eigener begrenzter Verbindung und einer dauerhaften Auftragswarteschlange sinnvoll. Die HTTP-Anfrage speichert den Auftrag und liefert eine Auftragskennung; sie wartet nicht auf die komplette Auswertung.

Der Auftrag benötigt Status `wartend`, `in Arbeit`, `fertig`, `fehlgeschlagen` oder `abgebrochen`, einen Wiederaufnahme- beziehungsweise Wiederholungsvertrag, einen Ablaufzeitpunkt und eine eindeutige Datenrevision. Ein Neustart darf keinen Auftrag dauerhaft in „in Arbeit“ hängen lassen. Gleichzeitig sind doppelte Ausführung, unbegrenzte Parallelität und unkontrolliertes Wachstum von Ergebnisdateien zu verhindern. Ein Pool sollte zunächst nur einen großen Bericht gleichzeitig bearbeiten; die geeignete Grenze ergibt sich später aus CPU-, Speicher- und I/O-Messungen. Worker Threads sind eine verfügbare Alternative für CPU-Arbeit, müssen aber ebenfalls mit eigenen Ressourcen und einem Pool betrieben werden.[^5]

## Priorisierte Umsetzung und Abnahme

| Priorität | Arbeitspaket | Erwarteter Nutzen | Nachweis vor Übernahme |
|---|---|---|---|
| 1 | Artikelprojektion mit vorbereiteten Such- und Sortierwerten | Entfernt wiederholte Textarbeit; schnellere erste Seite | Identische Treffer und Reihenfolge; Import, Bearbeitung, Archivierung und Undo aktuell |
| 1 | Kassenlisten von vollständigen Belegdetails trennen | Weniger Entschlüsselung, Abfragen und Betragsprüfungen je Suchseite | Zusammenfassungen stimmen exakt mit geprüften Belegen überein |
| 1 | Verifizierten Kassenbestand günstig wiederverwenden | Vermeidet sieben Gesamtzählungen beim normalen Einstieg | Fehlender/ersetzter Bestand bleibt gesperrt; Veröffentlichung/Rücknahme invalidiert |
| 1 | Nur-Lese-Transaktionen und schmale Kandidatenabfragen | Weniger Schreibreservierungen und Payloadübertragung | Gleichzeitige Suche und Schreibvorgänge; keine unerlaubten Schreibpfade |
| 2 | Statistiken und tatsächlich benötigte Indexvarianten | Bessere Auswahl bestehender Indizes | Abfragepläne und Laufzeiten vor/nachher; kein pauschaler Vollscan im Request |
| 2 | Cursor statt tiefer OFFSET-Seiten; Gesamtzahl entkoppeln | Konstante Arbeit beim Weiterblättern | Keine ausgelassenen/doppelten Treffer; eindeutiger Tiebreaker und Revisionsbindung |
| 2 | Doppelte Positions-/Referenzauflösung vermeiden | Weniger wiederholte Belegarbeit | Berechtigung und Integrität pro Leser weiterhin geprüft |
| 3 | Trigrammsuche für geeignete Suchfelder | Beschleunigt selektive Teilstringsuchen | Vollständigkeit aller unterstützten Suchmuster und Schutzklassen |
| 3 | Dauerhafte Aufträge und separater Berichtsprozess | Lange Auswertungen blockieren die Oberfläche nicht | Wiederanlauf, Abbruch, Rechteentzug, Downloadprüfung und begrenzte Parallelität |

Für die Statistiken empfiehlt SQLite `PRAGMA optimize`, nach Schemaänderungen und bei länger laufenden Verbindungen regelmäßig. Seit SQLite 3.46.0 begrenzt es seine Analysearbeit automatisch. Die auf dem Server festgestellte Version erfüllt diese Voraussetzung. Dennoch ist die Änderung zuerst mit Abfrageplänen und Laufzeiten zu prüfen; bessere Statistiken garantieren nicht für jede einzelne Abfrage einen besseren Plan.[^6] In dieser Untersuchung wurde dieser schreibende Befehl bewusst nicht produktiv ausgeführt.

Vorgeschlagene Abnahmekriterien sind eine erste normale Suchseite unter einer Sekunde und ein weiterer Cursor-Schritt unter 500 Millisekunden als p95 bei realistischer gleichzeitiger Nutzung. Diese Werte sind Ziele, keine heute nachgewiesenen Eigenschaften. Große oder seltene Freitextsuchen dürfen einen sichtbaren Fortschritt beziehungsweise einen Hintergrundauftrag benötigen. Die Oberfläche muss innerhalb kurzer Zeit Rückmeldung geben und einen Abbruch erlauben.

Für die Abnahme werden mindestens leere Suche, exakte Artikel-/Belegkennung, zwei Suchwörter, kein Treffer, Kundenfilter, einzelne Filiale, Gesamtfirma, Monats- und Mehrjahreszeitraum sowie jede unterstützte Sortierung getrennt gemessen. Erfasst werden p50/p95, Datenbankzeit, Wartezeit auf Verbindungen, gelesene Kandidaten, entschlüsselte Köpfe/Positionen, Gesamtzählungen, Antwortbytes und Ereignisschleifenverzögerung. Eine einzelne Gesamtzeit ohne diese Unterteilung reicht für die weitere Priorisierung nicht aus.

Parallel müssen eine normale Buchung beziehungsweise administrative Änderung und eine zweite Suche ausgeführt werden. So wird sichtbar, ob eine schnellere Einzelabfrage nur Arbeit auf andere Benutzer verschiebt. Integritäts-, Rechte- und Revisionsprüfungen gehören zur Abnahme, insbesondere der sofortige Entzug eines bereits geöffneten Suchergebnisses.

## Einordnung eines PostgreSQL-Wechsels

PostgreSQL bietet mit `pg_trgm` indexierte Ähnlichkeits- und Teilstringsuchen, unter anderem über GIN/GiST.[^7] Das macht es zu einer ernsthaften Option für einen späteren gemeinsamen Such- und Berichtsbestand mit höherer Parallelität. Ein bloßer Systemwechsel würde jedoch die jetzigen wiederholten Textberechnungen, Belegverarbeitung und Bestandsprüfungen nicht automatisch beseitigen.

Die Anwendung besitzt bereits eine Persistenzabstraktion und Teile eines PostgreSQL-Vertrags. Daraus folgt noch keine vollständige produktive Gleichwertigkeit aller hier benutzten Kassen- und Rechtepfade. Ein Wechsel wäre ein eigenes Vorhaben mit Vertragsabdeckung, Datenübernahme, exakter Dezimalarithmetik, Identitätszuordnung, Backup/Restore, Rückfallweg und Betriebsnachweis.

Für den aktuellen Artikelumfang ist zuerst die Verbesserung des Lesewegs sinnvoll. Nach diesen Maßnahmen sollte erneut gemessen werden, ob SQLite unter der tatsächlichen gleichzeitigen Last Grenzen erreicht. Erst dann lässt sich zwischen weiterem SQLite-Ausbau, einem getrennten Analysebestand und einer vollständigen Migration belastbar entscheiden.

## Quellen

Die Projektbefunde beruhen auf `server.js` (Artikelrouten und Rechteprüfung), `lib/flexible-search.js`, `lib/persistence/repositories/sales-article-catalog.js`, `lib/persistence/sqlite/sales-article-catalog-catalog.js`, `lib/persistence/repositories/sales-history-runtime.js`, `cash-publications.js`, `cash-history-backend.js`, `receipt-workspace.js`, `lib/receipt-result-store.js`, dem SQLite-Provider und den Kassen-Schema-/Abfragekatalogen. Produktionsmetadaten und synthetisches Messergebnis sind oben als eigenständige Artefakte verlinkt. Die folgenden Primärquellen wurden für die technischen Empfehlungen geprüft.

[^1]: SQLite, [Query Planning](https://www.sqlite.org/queryplanner.html), insbesondere Suche und Sortierung mit mehrspaltigen sowie abdeckenden Indizes; ergänzend [EXPLAIN QUERY PLAN](https://sqlite.org/eqp.html) zur Bedeutung der Planangaben.
[^2]: SQLite, [Write-Ahead Logging](https://www.sqlite.org/wal.html), Abschnitte Concurrency und Performance Considerations.
[^3]: SQLite, [FTS5: The Trigram Tokenizer](https://www.sqlite.org/fts5.html#the_trigram_tokenizer), einschließlich Mindestlängen, LIKE/GLOB und ESCAPE-Einschränkung.
[^4]: Node.js 22, [SQLite: DatabaseSync](https://nodejs.org/docs/latest-v22.x/api/sqlite.html#class-databasesync). Die Dokumentation beschreibt die auf dem Server verwendete Hauptversion; der dortige aktuelle Patchstand kann abweichen.
[^5]: Node.js, [Worker threads](https://nodejs.org/api/worker_threads.html), CPU-Arbeit und Wiederverwendung über einen Worker-Pool. Verwendbare Details sind vor Umsetzung gegen Node 22 zu prüfen.
[^6]: SQLite, [ANALYZE: Recommended usage patterns](https://www.sqlite.org/lang_analyze.html#recommended_usage_patterns), `PRAGMA optimize` und Grenzen von Planänderungen.
[^7]: PostgreSQL, [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html), Index Support. Hier als spätere Architekturvariante eingeordnet, nicht als Freigabe einer Migration.
