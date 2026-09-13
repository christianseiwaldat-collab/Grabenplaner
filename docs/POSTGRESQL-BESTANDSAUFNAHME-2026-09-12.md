# PostgreSQL: Bestandsaufnahme und Migrationsplanung

Stand: 12.09.2026. Untersuchte Codebasis: `c6b8a112e79514f39bbd0ce9906c54f052e45e40`, Branch `feature/schedule-pdf-day-separators`. Status: Planung, keine Aktivierung oder Datenmigration.

Fortschreibung nach dem Folgeauftrag: Die Blöcke 1–4 der gewählten Zwei-Datenbank-Variante sind inzwischen isoliert implementiert und gezielt geprüft. Der [Umsetzungsstand mit Nachweisen](postgresql-migration/README.md) dokumentiert Ergebnisse und verbleibende Grenzen. Die nachfolgende ursprüngliche Bestandsaufnahme bleibt als Ausgangsbefund erhalten; der produktive GP verwendet weiterhin SQLite.

## Empfehlung und Aufwand

PostgreSQL ist für den weiteren Ausbau mit Importen, mehreren Benutzern und umfangreichen Berichten ein sinnvolles Ziel. Die vorliegenden Befunde beweisen aber nicht, dass SQLite allein die bisherigen Wartezeiten verursacht. Der Wechsel muss auch die Abfragen, Berichtverarbeitung und Betriebsabläufe verbessern.

Empfohlen werden **12 Umsetzungsblöcke** für zwei PostgreSQL-Datenbanken: `grabenplaner_core` und `grabenplaner_sales`. Innerhalb der Verkaufsdatenbank erhalten Kassa, TradeFoto und Berichte eigene Schemas und Zugriffsrechte. Das trennt die Dienstplanung von den großen Verkaufsbeständen und erhält gleichzeitig einfache, konsistente Verbindungen zwischen Kassa und TradeFoto.

**Drei echte Datenbanken sind ebenfalls möglich.** Für `grabenplaner_core`, `grabenplaner_kassa` und `grabenplaner_trade` sind **14 Blöcke** ein realistischer Plan. Die zwei zusätzlichen Blöcke betreffen die Synchronisierung zwischen Kassa und Trade sowie deren gesonderte Fehler- und Wiederherstellungsfälle. Sie werden vor der Gesamtprobe und dem Produktivwechsel eingefügt.

Grobe Aufwandsschätzung: **25–45 technische Arbeitstage für die empfohlene Variante**, bei drei Datenbanken etwa **30–55 Arbeitstage**, jeweils einschließlich Entwicklung, gezielter Tests, Probeläufen und Betriebsintegration. Das sind Planungsgrößen, keine gemessenen Codex-Laufzeiten oder Terminzusagen. Ein Block umfasst gegebenenfalls mehrere Arbeitssitzungen. Betriebsbeobachtung, Abnahme und vereinbarte Wartungsfenster kommen als Kalenderabhängigkeiten hinzu. Nach Block 1 und erneut nach den ersten vollständigen Fachbereichstests wird die Schätzung aktualisiert.

Der ursprüngliche Auftrag war die Bestandsaufnahme. Auch die inzwischen beauftragte isolierte Umsetzung der Blöcke 1–4 startet keine produktive Migration.

## 1. Tatsächlich festgestellter Bestand

Die aktuelle Prüfung bestand aus einem statischen Persistenzaudit, gezielten Quellcodeprüfungen und lesenden VPS-Metadatenabfragen. Keine vollständigen Tabellen- oder Integritätsscans wurden erneut auf dem Produktivserver gestartet.

| Befund | Festgestellt am 12.09.2026 | Bedeutung |
|---|---|---|
| Produktiver GP-Provider | SQLite; Konfiguration erlaubt nur `sqlite` | PostgreSQL ist kein vorhandener umlegbarer Produktschalter |
| GP-Datei | `/var/lib/grabenplaner/data/dienstplan.db`, 2.590.732.288 Bytes, ca. 2,41 GiB | GP, CRM, Trade und Kassa liegen gemeinsam darin |
| SQLite-Metadaten | WAL; 248 Tabellen, 267 explizite Indizes, 369 Trigger, 1 View | Nicht nur Datensätze, auch Schutz- und Geschäftsregeln müssen übertragen werden |
| PostgreSQL auf dem VPS | 18.6; Cluster `18/main` online, bereits von Lebensatlas genutzt | Software ist vorhanden; dieser Betrieb ist keine GP-Freigabe |
| GP-Datenbanken in PostgreSQL | Keine in der gelesenen Datenbankliste | Noch kein produktiver GP-Zielbestand |
| Server | 4 logische CPUs, ca. 7,75 GiB RAM, ca. 46,94 GiB freier Plattenplatz | Momentaufnahme, keine Kapazitätszusage für gleichzeitige Probe, Backup und Berichte |
| GP-Dienst | `active` | Die Bestandsaufnahme erforderte keine Unterbrechung |

Die vorhandenen Kassa-/Trade-Mengen wurden bereits im abgeschlossenen Deploy geprüft; diese Bestandsaufnahme hat sie nicht erneut vollständig gezählt. Entscheidend für die Migration ist das vollständige vorhandene Archiv, nicht eine neue Beschränkung auf die letzten Jahre.

### Vorhandene PostgreSQL-Vorarbeit

Das frisch ausgeführte `node scripts/audit-persistence-coupling.js --check` meldet **OK**:

- 1.354 katalogisierte Anwendungsstatements; 1.239 generierte PostgreSQL-Syntaxkandidaten und 115 noch explizit zu bearbeitende Dialektfälle.
- Der Vollanwendungskatalog hat **0/1.354 akzeptierte Freigaben**. Diese Zahl bedeutet nicht, dass alles neu geschrieben werden muss; sie bedeutet, dass die vollständige Anwendung noch nicht nachgewiesen ist.
- Fünf ausführbare Entwicklungsslices mit insgesamt 38 Statements, darunter 29 für Sales Analytics. Keine produktive PostgreSQL-Aktivierung.
- Zehn Anwendungsmigrationsoperationen im Manifest; **0/10 produktive PostgreSQL-Implementierungen**. Das sind grobe Ablaufstufen, nicht lediglich zehn kleine Tabellenänderungen.
- Vorbereiteter Pool, Fehlerabbildung, Transaktionen, Migrationsadapter sowie Dump-/Restore-/Monitoringverträge. Dokumentierte isolierte Live-Nachweise existieren, ersetzen aber keine Prüfung des aktuellen Gesamtbestands.
- Keine rohen Fachzugriffe außerhalb der vorgesehenen Schichten. Dennoch verbleiben 22 produktive/betriebliche Dateien mit direktem SQLite-Treiberbezug; Serverstart, Wartung und Berichtsworker sind noch an SQLite gebunden.

Die 115 Dialektfälle betreffen unter anderem JSON, Sortierung/Großschreibung, Datumsrechnung, Integerkonvertierung und SQLite-spezifische Einfügeoperationen. Auch die 1.239 generierten Kandidaten brauchen reale PostgreSQL-Ausführung und Ergebnisvergleich. Die Quellcodezählungen von `CREATE TABLE` oder `CREATE TRIGGER` dürfen nicht mit der oben gemessenen Live-Schemaanzahl verwechselt werden.

## 2. Aufteilung der Daten

### Empfohlene Variante: zwei Datenbanken, getrennte Fachbereiche

| Datenbank / Schema | Führende Daten und Zuständigkeit |
|---|---|
| `grabenplaner_core` | Personal, Positionen/Rollen, Rechte und persönliche Ausnahmen, Dienstplanung, Zeiten, Urlaub, Workflows, Einstellungen, Audit, CRM, Filialbestellungen und Leihvorgänge |
| `grabenplaner_sales.kassa` | Unveränderte Kassenquellen, Köpfe/Positionen/Journal, Quellbeziehungen, Veröffentlichungen, Belegprüfung und fachliche Regeln |
| `grabenplaner_sales.trade` | TradeFoto-Quellen, Artikel und Revisionen, Kennungen, Preise, Hersteller, WGR, eigene Artikelbilder |
| `grabenplaner_sales.reporting` | Aufträge, Quellenstände, geprüfte Auswertungsprojektionen, Ergebnisreferenzen und Fortschritt |
| `grabenplaner_sales.integration` | Verkaufsbezogene Importläufe, verschlüsselte Payloadblöcke, Quellen- und Zuordnungsrevisionen |

CRM bleibt als vom GP bearbeiteter Kundenbestand im Core; Quellkunden und Quellkonten bleiben ihrem Import zugeordnet. Für Verkaufsberichte werden nur notwendige, geschützte Referenzen bereitgestellt. Rechteprüfung bleibt aktuell im GP. Trade-Updates dürfen persönliche Artikelbilder und manuelle Ergänzungen nicht überschreiben.

Schemas sind getrennte Namens- und Rechtebereiche innerhalb einer Datenbank. Verbindungen und Transaktionen können dort auf mehrere Schemas zugreifen. Eine normale PostgreSQL-Verbindung ist dagegen an eine einzelne Datenbank gebunden. Deshalb ist eine Aufteilung auf mehrere Datenbanken aufwendiger als eine Tabellenumsortierung. [PostgreSQL: Schemas](https://www.postgresql.org/docs/18/ddl-schemas.html)

### Drei echte Datenbanken

Bei dieser Variante liegen Kassa und Berichtaufträge in `grabenplaner_kassa`, Artikel/Trade-Quellen und Bilder in `grabenplaner_trade`. Die Kassa erhält eine kleine versionierte Kopie der benötigten Trade-Merkmale; keine zweite vollständige Trade-Datenbank und keine pauschale Klartextkopie von Kundendaten.

Eine Veröffentlichung nennt dann mindestens Kassenstand, Trade-Revision, Zuordnungsrevision und Regelversion. Sie wird erst sichtbar, wenn alle Teile verifiziert vorhanden sind. Ein Import mit halbfertiger Übertragung darf keinen neuen Berichtsstand freigeben. Aktualisierungen benötigen ein dauerhaftes Übertragungsjournal, wiederholbare Verarbeitung und erkennbare Rückstände. Ein reiner Zeitstempel oder ein Cache mit Ablaufzeit reicht dafür nicht.

Normale datenbankinterne Fremdschlüssel und Transaktionen werden an der Datenbankgrenze durch explizite Fachverträge ersetzt. FDW/dblink wären kein pauschaler Ersatz für diese Konsistenzgarantie. Daher ist diese Variante technisch machbar, bringt für den derzeitigen gemeinsamen Analysebedarf aber zusätzliche Komplexität.

### Konkrete vorhandene Verbindungen

- `loan_items` verweist auf `sales_article_revisions(product_id, revision)`. Bei Core/Sales-Trennung braucht der Core eine unveränderliche, nachweisbare lokale Artikelrevision für den Leihvorgang. Der Fremdschlüssel darf nicht ersatzlos verschwinden.
- `sales_branch_mapping_revisions` und alte aggregierte Berichte verweisen auf GP-Standorte. Standort- und Personalzuordnungen benötigen versionierte Referenzen, einschließlich historischer Einträge.
- `import_history_references` verweist auf `import_master_records`. Generische Importtabellen dürfen nicht allein anhand ihres Namens auf Kassa oder Trade verteilt werden. Importlauf, Änderungen, Rücknahmeinformationen und verschlüsselte Payloadblöcke müssen zusammenhängend zugeordnet werden.
- Die aktuelle Berichterstellung liest Kassenbestand und Trade-Wörterbücher über denselben Transaktionszugriff. Der Datenstand wird über Epochen/Revisionen geprüft. Diese Garantie muss die neue Architektur mindestens erhalten.
- Der Berichtsworker öffnet heute ausdrücklich eine read-only SQLite-Verbindung. Er benötigt eine PostgreSQL-Komposition, getrennte Rechte, Abbruch- und Wiederanlaufbehandlung.

## 3. Leistung und Betriebsgrenzen

PostgreSQL ermöglicht einen geeigneten asynchronen Datenbankzugriff, bessere gleichzeitige Verarbeitung und gezielte Suchindizes. Für die Artikelsuche ist `pg_trgm` mit geeigneten GIN/GiST-Indizes ein Kandidat; die vorhandene Suchsemantik einschließlich Umlauten, Kurzbegriffen und Platzhaltern muss erhalten bleiben. Das ist durch Vergleichstests nachzuweisen. [PostgreSQL: pg_trgm](https://www.postgresql.org/docs/18/pgtrgm.html)

Die Berichte verarbeiten heute chargenweise Positionen, entschlüsseln Daten und prüfen Belege. Ein Providerwechsel entfernt diese Arbeit nicht. Eine neue, versionierte Auswertungsprojektion soll geprüfte Beträge und benötigte Dimensionen vorbereitet anbieten. Ungeklärte Positionen bleiben dabei sichtbar ausgeschlossen beziehungsweise gesondert ausgewiesen. Schutzklassen und Zugriffsrechte gelten auch für diese abgeleiteten Daten.

Nachweisbare weitere Kosten: Der SQLite-Startpfad enthält weiterhin `PRAGMA quick_check`; im letzten Release wurden rund 332 Sekunden für den neuen Anwendungsstart protokolliert. Das ist ein beobachteter Startwert, keine hier erneut gemessene alleinige Laufzeit dieses einen Statements. Archivierung, Virenscan, Dokumentprüfung und Offsite-Sicherung haben zusätzliche Kosten unabhängig vom Datenbankprodukt.

Vorgeschlagene Abnahmeziele: normale erste Suchseite p95 unter 1 Sekunde, Folgeseite unter 500 ms, zügige Auftragsannahme für PDF-Berichte sowie keine wesentliche Verschlechterung von Dienstplanung und Zeiterfassung während eines großen Berichts. Dies sind Zielwerte; Messnetz, Datenumfang und Parallelität werden in Block 1 festgelegt. Kein versprochener Beschleunigungsfaktor ohne Vergleichslauf.

Zwei oder drei Datenbanken auf demselben VPS teilen weiterhin CPU, RAM und Datenträger. Deshalb zunächst ein großer Bericht gleichzeitig, begrenzte Pools, Abfrage-/Sperrzeitlimits und Speichergrenzen. Erforderliche Kapazität wird unter gleichzeitiger Nutzung einschließlich Lebensatlas gemessen.

Für GP wird eine **eigene PostgreSQL-Instanz mit eigenem Datenverzeichnis und Betriebsvertrag** empfohlen. Die bereits installierte PostgreSQL-Software kann wiederverwendet werden; die laufende Lebensatlas-Instanz wird dadurch nicht umgestellt. Auch eine eigene Instanz auf demselben VPS ist keine Hardware- oder Ausfallisolierung. Ein eigener Server ist eine spätere Option, keine bereits begründete Kaufempfehlung.

## 4. Sichere und vollständige Übernahme

1. **Vollständige Eigentümerliste:** Jede der 248 Tabellen, jeder Trigger, Index und die View erhält Ziel, Konvertierung und Prüfregel. Zusätzlich werden Dateien, Schlüssel, Betriebsdatenbanken und Konfiguration inventarisiert. Auch leere, historische oder derzeit ungenutzte Tabellen werden ausdrücklich behandelt.
2. **Konsistenter Ausgangsbestand:** Zunächst auf einer verifizierten isolierten Sicherung arbeiten. Wiederholbare Übernahme in leere Zielbestände mit Migrationskennung und Manifest. Ein abgebrochener Lauf wird geprüft fortgesetzt oder verworfen, niemals still doppelt eingespielt.
3. **Typen und Identitäten:** Artikel-, Kunden-, Filial- und Personalnummern bleiben Zeichenketten einschließlich führender Nullen. Dezimalwerte bleiben exakt; kein Zwischenschritt über JavaScript-Fließkommazahlen. Beispielsweise existiert für Artikelpreise bereits ein Vertrag `NUMERIC(30,12)`. IDs, Revisionen, Binärschlüssel, Nullwerte, Datums-/Zeitzonenlogik und Sequenzen werden ausdrücklich geprüft.
4. **Verschlüsselung:** Verschlüsselte Inhalte samt Kontextbindung, IDs und Schlüsselversion unverändert erhalten, soweit der bestehende Vertrag dies ermöglicht. Falls ein Kontext wechseln muss, erfolgt eine explizite geprüfte Neuverschlüsselung. Datenbankdump allein ersetzt weder Schlüssel noch Dokument-/Bilddateien. Eigene Artikelbilder liegen aktuell als BLOB in `sales_article_own_images`; CRM-Fotos besitzen dagegen externe Dateireferenzen.
5. **Fachliche Gleichheit:** Pro Tabelle Zeilenzahl, stabile Schlüssel und kanonische Inhaltsnachweise; zusätzlich vollständiger Abgleich der Beziehungen und Belegsummen. Entschlüsselbarkeit und Dokumentzugriff testen. Abweichungen werden als Fehlerliste dokumentiert; es gibt keine automatische Löschung zur Herstellung passender Summen.
6. **Funktionale Gleichheit:** Rechteentzug, Developer-Vollzugriff, Personal-/Planungsänderungen, Import und Rücknahme, CRM, Leihen, Bestellung, Belegsuche und PDF-Erstellung prüfen. Ergebnis und Reihenfolge der Abfragen müssen dem jeweils freigegebenen Fachvertrag entsprechen.

Die bestätigten Kassenregeln bilden verpflichtende Vergleichsfälle: `RohertragDM` pro Stück, `KalkRohertrag` für die Position; Retouren mit negativem Vorzeichen; Sofortrabatte mit Umsatzminderung bei erhaltener Artikelmarge; Gutscheinausgabe ohne Warenumsatz/Marge und Einlösung als Zahlungsmittel; Netto-Belegkopf mit Bruttopositionen; UID-Zwischenbuchungen; Gebrauchtware mit gespeichertem 0%-Satz; normale Verkäufe für Sofortdruck und Ausarbeitung HD. Auch Online `00/70/90` und die besondere Bedeutung von `0` bleiben erhalten. Bestehende ungeklärte Fälle werden nicht bei der Migration umgedeutet.

## 5. Backup, Wiederherstellung und Rückkehr

Der vorhandene nicht produktive PostgreSQL-Dump-/Restorevertrag wird ausgebaut. Logische Dumps dienen der portablen Übernahme und Einzelprüfung; `pg_dump` sichert jeweils eine Datenbank konsistent, aber kein gemeinsames beliebiges Zeitfenster mehrerer unabhängiger Dumps. Rollen und weitere globale Objekte benötigen eine eigene Sicherungsstrategie. [PostgreSQL: pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)

Für die Rückkehr zu einem bestimmten Zeitpunkt sind zusätzlich physische Basissicherungen und lückenlose WAL-Archivierung vorgesehen. PostgreSQL-PITR stellt eine ganze Instanz wieder her. Deshalb wird ein solcher Restore immer isoliert geprobt und darf den Lebensatlas-Cluster nicht berühren. Konfigurationsdateien und externe GP-Dateien brauchen einen ergänzenden gekoppelten Sicherungsvertrag. [PostgreSQL: Continuous Archiving und PITR](https://www.postgresql.org/docs/18/continuous-archiving.html)

Bei mehreren Datenbanken gibt es einen gemeinsamen Sicherungsmanifeststand. Für logische, anwendungsübergreifend konsistente Sicherungen werden die relevanten Schreibvorgänge kurz angehalten und alle Datenbank-/Dateistände gebunden. Ob diese Pause durch immutable Revisionen und Snapshotexport weiter verkürzt werden kann, wird praktisch nachgewiesen. Drei nacheinander gestartete Dumps sind allein kein solcher Nachweis.

Die freigegebene Deployaufteilung bleibt bestehen: frischer Rückkehrpunkt, Paketprüfung und kurze Funktionsprüfungen beim normalen kompatiblen Deploy; umfangreiche Restore-/Archivnachweise nachts. **Der erste Datenbankwechsel ist eine eigene Migration mit vollständiger Generalprobe**, kein gewöhnlicher kurzer Deploy. RPO/RTO werden vorgeschlagen und gemessen, bevor sie zugesagt werden. Als Planungsziel: keine verlorenen freigegebenen Änderungen beim Cutover; für den laufenden Betrieb beispielsweise höchstens 15 Minuten Datenverlust bei einem Totalausfall, vorbehaltlich nachgewiesenem Offsite-WAL-Stand und abgestimmter Dateisicherung.

Produktivwechsel: Schreibvorgänge, Importe, Berichte und Hintergrundmutationen kontrolliert drainen und sperren; letzte Sicherung; finale Übernahme; Vollständigkeitsnachweis; neue Anwendung zunächst geschützt prüfen; erst danach Schreiben freigeben. Keine improvisierten parallelen Schreibpfade nach SQLite und PostgreSQL.

**Rückkehrgrenze:** Vor neuen PostgreSQL-Schreibvorgängen kann auf den unveränderten SQLite-Ausgangsstand zurückgegangen werden. Danach wäre ein bloßes Zurückschalten Datenverlust. Für diesen Fall braucht es vor Freigabe einen geprüften Änderungsabgleich beziehungsweise Rückmigrationsweg oder einen verbindlichen Reparatur-/Restoreplan auf PostgreSQL. Die Entscheidung und ihre Wiederanlaufzeit gehören zur Generalprobe. Die Umschaltpause wird erst nach gemessenen Wiederholungsläufen beziffert.

## 6. Umsetzungsblöcke und Abnahme

| Block | Inhalt | Fertig, wenn … |
|---|---|---|
| 1 | Vollständiges Daten-/Dateiinventar, Abhängigkeiten, Lastbaseline, Zielaufteilung und Erfolgskriterien | Alle Live-Objekte und fachlichen Beziehungen zugeordnet; reproduzierbarer Vergleich und aktualisierte Schätzung vorhanden |
| 2 | Isolierte GP-PostgreSQL-Umgebung, Rollen, Verbindungen, Ressourcen- und Secretkonzept | Entwicklung/Probe getrennt vom Produktivbetrieb; sichere Pool- und Verbindungsgrenzen getestet |
| 3 | Core-Schema, Trigger/Constraints und historische Migrationen | GP-/CRM-Datenmodell einschließlich Schutzregeln und historischer Bestände auf PostgreSQL ausführbar |
| 4 | Core-Anwendung und SQL-Katalog | Alle betreffenden Lese-/Schreibpfade einschließlich Planung, Zeiten, Rechte und Workflows fachlich vergleichbar |
| 5 | Kassenbestand und Beleglogik | Vollständige Quellen, Veröffentlichungen und Belegprüfungen auf PostgreSQL gleichwertig; kein Quellenverlust |
| 6 | TradeFoto, Artikel, Preise und Bilder | Import, Suche, Änderungen und Rücknahme funktionieren; manuelle Bilder/Ergänzungen bleiben erhalten |
| 7 | Core/Sales-Verbindungen und Importzuständigkeiten | Artikelrevisionen für Leihen, Kunden-/MA-/Filialbezüge und revisionsgebundene Übergaben ausfallsicher; Rechte werden aktuell geprüft |
| 8 | Berichtsworker, Auswertungsprojektion und Suchleistung | PDF und Kennzahlen stimmen; große Berichte beeinträchtigen die GP-Kernfunktionen im definierten Lasttest nicht unzulässig |
| 9 | Wiederholbares Werkzeug zur gesamten Datenübernahme | Mehrfacher isolierter Import liefert identische geprüfte Daten, Beziehungen, Dateien und Schlüsselzuordnungen |
| 10 | PostgreSQL-Backup, Offsite, Wiederherstellung, Monitoring und Updater | Isolierter vollständiger Restore samt Dateien/Schlüsseln bestanden; kurzer Deploypfad und Nachtprüfungen providerfähig |
| 11 | Gesamtprobe mit realitätsnahem Datenbestand, Störungen und Rückkehr | Vollanwendungsnachweise vollständig; Abbruch/Neustart, Importkonflikt, Rechteentzug und Rückkehr geprüft; Dauer gemessen |
| 12 | Separat freigegebener Produktivwechsel und Nachkontrolle | Finaler Datenabgleich, GP-Funktionen, Kassa/Trade, PDF-Berichte und erste PostgreSQL-Sicherung produktiv bestätigt |

Block 10 kann konzeptionell früh beginnen; seine endgültige Abnahme benötigt den vollständigen Zielbestand. Bis einschließlich Block 11 bleibt die produktive SQLite-Quelle maßgeblich. Block 12 benötigt die ausdrückliche Freigabe des konkreten Migrationsstands und Wartungsfensters.

Für **drei echte Datenbanken** werden zwischen Block 8 und den abschließenden Übernahme-/Betriebsblöcken zwei zusätzliche Pakete eingefügt:

- **Zusatz A:** Kassa/Trade-Verbindungsvertrag, dauerhafte Übertragungen, versionierte Teilkopien, gemeinsamer Veröffentlichungsstand und Fehlerbehandlung.
- **Zusatz B:** Betriebs- und Paritätsnachweise für unterbrochene Übertragungen, unterschiedliche Datenstände, Rücknahme und koordinierte Wiederherstellung aller drei Datenbanken.

Die Reihenfolge wird dann auf 1–14 neu nummeriert; der Produktivwechsel bleibt der letzte Block. Allein das Anlegen einer dritten Datenbank rechtfertigt die Zusatzblöcke nicht – ihr Aufwand liegt in den entstehenden Verbindungen.

## 7. Noch gezielt zu klären, ohne die Bestandsaufnahme zu blockieren

- Exakte Größenverteilung auf Tabellen, verschlüsselte Importblöcke, Dateien und abgeleitete Projektionen; Messung auf isolierter Sicherung.
- Tatsächliche Parallelitäts- und Wartezeitanteile nach den bisherigen Optimierungen; keine Übernahme alter Vorher-Messungen als aktueller Istwert.
- Vollständige Triggerportierung, Datenabweichungen bei strengeren PostgreSQL-Typen sowie historische Sonderfälle.
- Zielreserve für Probe, endgültige Daten, Indizes, temporäre Sortierung, Basissicherung und WAL; aktueller freier Speicher allein ist kein ausreichender Nachweis.
- Messbares Wartungsfenster, gewünschtes RPO/RTO und Rückkehrentscheidung nach den ersten neuen Schreibvorgängen.

## Prüfnachweise und Codeanker

- Aktueller Persistenzaudit: `scripts/audit-persistence-coupling.js --check`, Ergebnis OK, 12.09.2026. Keine komplette Testsuite oder erneuter PostgreSQL-Live-Test in dieser Bestandsaufnahme.
- Lesende VPS-Metadaten: lokale Arbeitsdatei `tmp/postgresql-assessment-live.json`; nur Struktur-/Betriebsmetadaten, keine Kunden-/Personalinhalte.
- Providerfreigabe: `lib/persistence/configuration.js`; Startkomposition und SQLite-Wartung: `server.js`.
- Dialektumfang: `lib/persistence/dialects/application-manifest.js`; Migrationsstufen: `lib/persistence/migrations/application-manifest.js`.
- Berichte: `lib/sales-report-worker.js`, `lib/persistence/repositories/sales-report-workspace.js`, `sales-master-data.js` und `cash-history-backend.js`.
- Beziehungen: `lib/persistence/sqlite/operations/central-article-loan-migration.js`, `import-history-schema.js` und `cash-snapshots-schema.js`.
- Bildbestand: `lib/persistence/sqlite/operations/sales-article-images-schema.js`; Preisvertrag: `lib/persistence/postgresql/sales-article-catalog-schema.js`.
- Vorarbeiten: [Provider](DATENBANK-POSTGRESQL-PROVIDER.md), [Betrieb und Recovery](DATENBANK-POSTGRESQL-BETRIEB-UND-RECOVERY.md). Deren historische Abschnittszahlen sind vom aktuellen Audit zu unterscheiden.
- Letzter geprüfter Release: [Deploy v0.92.37](DEPLOY-RELEASE-v09237.md). Frühere Suchforschung: [Recherche vom 09.09.2026](KASSEN-TRADE-PERFORMANCE-RECHERCHE-2026-09-09.md), ausdrücklich kein neuer Lastnachweis.
