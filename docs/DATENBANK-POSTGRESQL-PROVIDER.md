# PostgreSQL-Provider und Betriebspfad im nicht produktiven Status

**Status:** Verbindlicher Block-5-Providerstand und lokal abgenommener
Block-6-Betriebsvertrag; keine Produktiv-, Support- oder Cutoverfreigabe<br>
**Stand:** 13.08.2026<br>
**Experimentelles Profil:** `development-contract`<br>
**Produktiver Datenbankpfad:** weiterhin ausschließlich SQLite

## 1. Zweck und verbindliche Grenze

Dieses Dokument legt für Block 5/7 die Sicherheits-, Pool- und
Transaktionsgrenzen des vorbereiteten PostgreSQL-Providers fest und hält den
in Block 6/7 ergänzten, nicht produktiven Betriebs- und Recovery-Pfad fest. Es
konkretisiert Phase 5 sowie den technischen Zwischenstand von Phase 6 der
[Datenbank-Provider-Strategie](DATENBANK-PROVIDER-STRATEGIE.md), ohne
PostgreSQL für den Produktivbetrieb freizugeben.

Der aktuelle Slice stellt einen providerneutralen PostgreSQL-Adapter, eine
streng begrenzte Poolrichtlinie und einen ausschließlich experimentellen
Öffnungspfad bereit. Die normale Grabenplaner-Startkonfiguration bleibt
geschlossen: `DB_PROVIDER=postgresql` ist weiterhin nicht verfügbar. Es gibt
keinen automatischen Providerwechsel, keine Datenübernahme und keinen Cutover.

Block 6 ergänzt eigenständige Entwicklungsbausteine für Custom-Dump,
Backup-Bundle v2, isolierten Restore, Monitoring und Recovery Assurance. Diese
Bausteine sind lokal gegen PostgreSQL 18.4 geprüft, aber weder in `server.js`
noch in Produktkonfiguration, System-Center oder einen geplanten Serverjob
eingebunden. Der verbindliche Betriebsstand steht in
[PostgreSQL-Betrieb und Recovery im nicht produktiven Status](DATENBANK-POSTGRESQL-BETRIEB-UND-RECOVERY.md).

Die Implementierung ist insbesondere kein Nachweis für:

- vollständige Ausführbarkeit aller Anwendungsstatements auf PostgreSQL;
- erfolgreiche Anwendungsmigrationen auf einem realen PostgreSQL-Server;
- produktive Betriebsreife oder einen installierten, geplanten Backup-,
  Restore- und Recovery-Assurance-Betrieb;
- Mehrinstanzfähigkeit, Hochverfügbarkeit oder horizontale Skalierung;
- einen unterstützten PostgreSQL-Produktstand.

## 2. Verbindliche Module und Oberflächen

| Modul | Verantwortung |
| --- | --- |
| [`lib/persistence/postgresql/policy.js`](../lib/persistence/postgresql/policy.js) | unveränderliche Poolgrenzen, TLS-Modi, Rollenabsichten und sichere Poolkonfiguration |
| [`lib/persistence/postgresql/provider.js`](../lib/persistence/postgresql/provider.js) | Poolinjektion, Parameter- und Ergebnisnormalisierung, Fehlerabbildung, Transaktionen und Poollebenszyklus |
| [`lib/persistence/postgresql/pool.js`](../lib/persistence/postgresql/pool.js) | ausschließlich experimenteller Öffnungspfad mit Profil-Gate |
| [`lib/persistence/postgresql/dialect-compiler.js`](../lib/persistence/postgresql/dialect-compiler.js) | Compiler v2 für konservative PostgreSQL-Syntaxkandidaten, benannte Parameterbindungen und weiterhin geschlossene Overrides |
| [`lib/persistence/postgresql/catalog-contract.js`](../lib/persistence/postgresql/catalog-contract.js) | fail-closed Katalogvertrag für Provenienz, Teil-Slices und das geschlossene 1119er-Acceptance-Gate |
| [`lib/persistence/postgresql/ui-preferences-catalog.js`](../lib/persistence/postgresql/ui-preferences-catalog.js) | eigenständiger ausführbarer `development-contract`-Teilslice für genau vier UI-Präferenzstatements |
| [`lib/persistence/postgresql/planning-settings-catalog.js`](../lib/persistence/postgresql/planning-settings-catalog.js) | eigenständiger ausführbarer `development-contract`-Teilslice für genau zwei Planning-Settings-Statements |
| [`lib/persistence/postgresql/organization-departments-catalog.js`](../lib/persistence/postgresql/organization-departments-catalog.js) | eigenständiger ausführbarer `development-contract`-Teilslice für genau zwei Abteilungsstatements |
| [`lib/persistence/postgresql/system-center-metrics-catalog.js`](../lib/persistence/postgresql/system-center-metrics-catalog.js) | eigenständiger ausführbarer `development-contract`-Teilslice für genau ein `oldestIntervalKeys`-Statement |
| [`lib/persistence/postgresql/migrations/adapter.js`](../lib/persistence/postgresql/migrations/adapter.js) | generischer, nicht aktivierter PostgreSQL-Migrationsadapter mit Session-Lock, einer serialisierbaren Transaktion, gehärtetem Ledger, geprüfter Least-Privilege-Rolle und adapter-eigenen versionierten SQL-Artefakten |
| [`lib/backup-bundle.js`](../lib/backup-bundle.js) | providergebundener Backup-Bundle-v2-Vertrag mit atomarem Commitmarker, kanonischem Hash, sicherer Komponentenprüfung und getrennter v1/v2-Retention |
| [`lib/persistence/operations/contract.js`](../lib/persistence/operations/contract.js) | providerneutraler Capability-Report und enge Betriebsfassade ohne Raw-Handle |
| [`lib/persistence/operations/mutation-quiesce.js`](../lib/persistence/operations/mutation-quiesce.js) | begrenztes Quiesce-Fenster für geschützte Dokumentmutationen |
| [`lib/persistence/operations/recovery-assurance.js`](../lib/persistence/operations/recovery-assurance.js) | provider- und methodengebundener, Ed25519-signierbarer Recovery-Assurance-Belegvertrag v2 |
| [`lib/persistence/postgresql/operations/tools.js`](../lib/persistence/postgresql/operations/tools.js) | gepinnte `pg_dump`-/`pg_restore`-Policy, private Service-Credentials, Prozessgrenzen und Toolausführung |
| [`lib/persistence/postgresql/operations/snapshot.js`](../lib/persistence/postgresql/operations/snapshot.js) | exportierter `REPEATABLE READ READ ONLY`-Snapshot mit Quell-Evidence und Dokumentreferenzen |
| [`lib/persistence/postgresql/operations/evidence.js`](../lib/persistence/postgresql/operations/evidence.js) | kanonische PostgreSQL-Evidence für Schema, Constraints, Indizes, Daten, Migrationsledger und Dokumentreferenzen |
| [`lib/persistence/postgresql/operations/backup.js`](../lib/persistence/postgresql/operations/backup.js) | nicht produktiver Custom-Dump und gekoppelter Dokument-Sicherungspunkt |
| [`lib/persistence/postgresql/operations/restore.js`](../lib/persistence/postgresql/operations/restore.js) | Restore ausschließlich in ein neues, leeres und isoliertes Scratch-Ziel mit Evidence- und Smoke-Prüfung |
| [`lib/persistence/postgresql/operations/recovery-assurance.js`](../lib/persistence/postgresql/operations/recovery-assurance.js) | bindet PostgreSQL-Backup, Restore und externe Offsite-/Repository-Evidence an den signierten Belegvertrag; fehlende externe Evidence bleibt fehlgeschlagen |
| [`lib/persistence/postgresql/operations/monitor.js`](../lib/persistence/postgresql/operations/monitor.js) | read-only PostgreSQL-Metriken und fail-closed Capability-Evidence-Bindung |
| [`lib/persistence/contract.js`](../lib/persistence/contract.js) | gemeinsame Providerfassade, gebundener Transaktionsexecutor und capability-gesteuerte Parallelität |
| [`test/v087-database-block5-postgresql-provider.test.js`](../test/v087-database-block5-postgresql-provider.test.js) | synthetische Provider-, Transaktions-, Fehler- und Pooltests |
| [`test/v087-database-block5-postgresql-catalog-contract.test.js`](../test/v087-database-block5-postgresql-catalog-contract.test.js) | Katalog-, Provenienz-, Teil-Slice- und 0/1119-Acceptance-Gates |
| [`test/v087-database-block5-postgresql-ui-preferences.test.js`](../test/v087-database-block5-postgresql-ui-preferences.test.js) | realer Dual-Provider-Nachweis für den 4/4-UI-Präferenzslice |
| [`test/v087-database-block5-postgresql-planning-settings.test.js`](../test/v087-database-block5-postgresql-planning-settings.test.js) | realer Dual-Provider-Nachweis für den 2/2-Planning-Settings-Slice |
| [`test/v087-database-block5-postgresql-organization-departments.test.js`](../test/v087-database-block5-postgresql-organization-departments.test.js) | realer Dual-Provider-Nachweis für den 2/2-Organization-Departments-Slice |
| [`test/v087-database-block5-postgresql-system-center-metrics.test.js`](../test/v087-database-block5-postgresql-system-center-metrics.test.js) | realer Dual-Provider-Nachweis für den 1/1-System-Center-`oldestIntervalKeys`-Slice |
| [`test/v087-database-block5-postgresql-migration-adapter.test.js`](../test/v087-database-block5-postgresql-migration-adapter.test.js) | statische und reale PostgreSQL-Nachweise für Migrationsledger, Ablauf, Parallelität, Rollback und Drift |
| [`test/v087-database-block5-postgresql-live.test.js`](../test/v087-database-block5-postgresql-live.test.js) | sieben isolierte reale Nonprod-Fälle für Treibertypen, Compiler-JSON-Bindungen, Constraints, Transaktionen, Parallelität, Deadlock und Statement-Timeout |
| [`test/v087-database-block6-postgresql-restore-live.test.js`](../test/v087-database-block6-postgresql-restore-live.test.js) | realer PostgreSQL-18.4-E2E-Nachweis für exportierten Snapshot, Dump, isolierten Restore, Schema-/Evidence-Abgleich und verschlüsseltes Dokument |
| [`test/v087-database-block6-no-cutover.test.js`](../test/v087-database-block6-no-cutover.test.js) | hält Produktprovider, Produktfähigkeiten, Serverstart und Produktoberfläche weiterhin ausschließlich auf SQLite |

`createPostgresqlPersistenceProvider(...)` erhält einen bereits erzeugten Pool
und veröffentlicht nur die allgemeine `PersistenceProvider`-Oberfläche. Pool,
Client, Connection, Queryobjekt und Treiberhandle werden nie an Fachlogik
weitergegeben.

Der direkte Poolinjektionspfad ist eine Adapter- und Testgrenze. Der einzige
vorgesehene Konstruktionspfad für eine spätere nicht produktive
Treiberintegration ist `openPostgresqlDevelopmentPersistence(...)`. Er
akzeptiert ausschließlich das exakte Profil `development-contract`, erzeugt
die Poolkonfiguration über die verbindliche Policy und übernimmt anschließend
das Pool-Eigentum.

Weder `server.js` noch die produktive Providerkonfiguration dürfen diesen
Öffnungspfad in Block 5 aufrufen.

### 2.1 Dialektplan, Katalog-Gate und ausführbare Teil-Slices

Der PostgreSQL-Dialektcompiler liegt in Version 2 vor. Der weiterhin
nicht ausführbare Gesamtplan umfasst alle 1119 Anwendungsstatements:

- 1008 Einträge sind generierte PostgreSQL-Syntaxkandidaten
  (`portable-generated`);
- 111 Einträge benötigen weiterhin eine ausdrückliche
  `requires-override`-Implementierung;
- 0 von 1119 Einträgen bilden einen freigegebenen, für die Anwendung
  ausführbaren Vollkatalog.

Ein generierter Syntaxkandidat ist weder ein Live-Nachweis noch automatisch
Teil eines ausführbaren Providerkatalogs. Compiler v2 ergänzt insbesondere
streng beschriebene JSON-Parameterbindungen; Provenienz, Parameterbindung und
SQL-Fingerprint bleiben je Eintrag nachvollziehbar.

Der zentrale Katalogvertrag hält die Acceptance-Grenze geschlossen. Für einen
für die Vollanwendung ausführbaren Katalog sind 1119 akzeptierte Live- und
Paritätsnachweise erforderlich; aktuell liegen 0/1119 vor. Deshalb kann selbst
ein strukturell vollständiger Katalog mit 1119 Deklarationen heute nicht
`applicationExecutable: true` werden.

Davon getrennt existieren vier bewusst kleine, auf einem realen
PostgreSQL-Server gegen SQLite geprüfte Teil-Slices:

- **UI-Präferenzen 4/4:** `list`, `get`, `upsert` und `delete`; die
  `COLLATE NOCASE`-Abweichung der Listenreihenfolge ist ausdrücklich gelöst.
- **Planning Settings 2/2:** `listSettings` und `upsertSetting`; der Nachweis
  umfasst die Bindung von zwei PostgreSQL-Parametern aus einem JSON-Payload,
  die JSONB-Objektkonstruktion mit `jsonb_build_object` sowie den atomaren
  Transaktionsrollback. Ein fachlich ungültiges `key: null` scheitert nun
  bereits providerneutral mit `PERSISTENCE_STATEMENT_INVALID`; eine
  unterschiedliche SQLite-/PostgreSQL-Constraintreaktion wird nicht mehr
  zugelassen.
- **Organization Departments 2/2:** `listDepartments` und
  `insertDepartment`; der Slice löst das Boolean-Prädikat, die
  SQLite-`BINARY`-Sortierung durch `COLLATE "C"` und die Ausgabe des
  UTC-Zeitstempels als SQLite-kompatiblen Text ausdrücklich.
- **System Center 1/1:** `oldestIntervalKeys`; das positive sichere
  Ganzzahllimit wird als typisiertes `LIMIT $1::bigint` gebunden und gleiche
  Zeitpunkte werden mit `COLLATE "C"` in derselben binären Reihenfolge wie
  unter SQLite aufgelöst.

Alle neun Statements der vier Slices sind fachlich live gegen SQLite und
PostgreSQL geprüft. Jeder Slice trägt den Status `development-contract`, ist
nur innerhalb dieser
Entwicklungsgrenze ausführbar und deklariert
`fullApplicationCatalog: false`. Der daraus gebildete Teilkatalog bleibt
`applicationExecutable: false` und `productActivation: false`. Auch die
Abdeckungen 4/4, 2/2, 2/2 und 1/1 verändern den Vollanwendungsstand von 0/1119
nicht und aktivieren keinen PostgreSQL-Produktpfad.

Jeder der vier Slices pinnt zusätzlich einen Quellvertrags-Fingerprint. Er
bindet den exakten kanonischen SQLite-SQL-Text an Statement-ID, Operation,
Parameterarten einschließlich Nullability/Optionalität sowie Ergebnisarten
und Ergebnisreihenfolge. SQL- oder Vertragsdrift scheitert damit bereits bei
der Slice-Erzeugung geschlossen; Planprovenienz, Statementvertrag und
kompiliertes PostgreSQL-SQL können nicht unbemerkt auseinanderlaufen.

Für spätere PostgreSQL-Migrationen gilt außerdem ein eigenes Schema-Gate:
SQLite lässt bei `TEXT PRIMARY KEY` ohne zusätzliches `NOT NULL` Nullwerte zu
und besitzt damit einen schwächeren Vertrag als PostgreSQL. Die
PostgreSQL-Migration darf die Nullability daher nicht mechanisch aus der
SQLite-DDL übernehmen, sondern muss sie für jede Spalte ausdrücklich aus dem
Fachvertrag ableiten und prüfen.

Die Ergebnisgrenze scheitert geschlossen: Der Provider verlangt
`rowMode: "array"` und prüft die von `pg` gelieferten Feldnamen einschließlich
ihrer Reihenfolge exakt gegen den Statementvertrag, bevor Werte zugeordnet
werden. Ebenso müssen Statementspalten, Katalogfeld `returning` und eine
tatsächliche SQL-`RETURNING`-Klausel widerspruchsfrei zusammenpassen.
Abweichungen werden als Vertragsfehler vor der ersten Verbindung
beziehungsweise als Ergebnisfehler innerhalb der laufenden Transaktion
zurückgewiesen.

### 2.2 Generischer Migrationsadapter ohne Anwendungsaktivierung

Der generische PostgreSQL-Migrationsadapter ist als `development-contract`
implementiert und real getestet. Er ist nicht an die neun
Anwendungsmigrationen gebunden: `applicationMigrationsImplemented` bleibt `0`
und `productActivation` bleibt `false`.

Ein Migrationslauf besitzt exakt folgende Konkurrenz- und Transaktionsgrenze:

1. ein Poolclient wird bezogen und auf dieser Session wird
   `pg_advisory_lock($1::bigint)` erworben;
2. erst nach erfolgreichem Lock beginnt genau eine
   `SERIALIZABLE READ WRITE`-Transaktion;
3. Schema, `search_path`, Ledger, Migrationsschritte und Ledgeränderungen
   werden innerhalb dieser einen Transaktion geprüft beziehungsweise
   ausgeführt;
4. der Lauf endet mit genau einem Commit oder Rollback;
5. erst danach wird der Session-Lock mit `pg_advisory_unlock` gelöst und der
   Client freigegeben.

Ein transaktionsgebundener `pg_advisory_xact_lock` wurde nach einem real
reproduzierten Stale-Snapshot-/Ledgerfehler verworfen: Er könnte erst nach
Transaktionsbeginn warten und damit keinen frischen serialisierbaren Snapshot
nach der Wartezeit garantieren. Es gibt deshalb weder eine Prozess-lokale
JavaScript-Queue noch einen automatischen Retry.

Reale PostgreSQL-Tests sind für Rebuild, Präfix-Upgrade, No-op, einen
synthetischen Rollback, den atomaren Abbruch eines gesamten fehlerhaften Laufs,
zwei parallele Runner sowie Implementierungs-, Manifest- und Historien-Drift
grün. Cleanupfehler werden weder im Adapter noch in den Dual-Provider-Fixtures
verschluckt; sie lassen den jeweiligen Test geschlossen fehlschlagen.

Frei programmierbare Migrationshandler gehören ausdrücklich nicht mehr zum
Adaptervertrag. Jede Operation ist ein kanonisches Artefakt aus Formatversion,
Operationsversion und einer geordneten Liste aus SQL plus Parametern. Der
Adapter validiert eine positive Befehls-/Objektmenge, berechnet den
Implementierungs-Fingerprint selbst und führt exakt dieses Artefakt aus.
Transaktions- oder Sessionsteuerung, Routinen, temporäre beziehungsweise
`UNLOGGED`-Objekte, explizite Schemaqualifizierung sowie jeder Artefaktzugriff
auf das interne Ledger scheitern vor der Verbindung geschlossen. `SELECT`
bleibt read-only; `SELECT ... INTO` ist nicht Teil der erlaubten Grammatik.

Die Rollenanforderung ist technisch erzwungen: `current_user` und
`session_user` müssen exakt der konfigurierten Migrationsrolle entsprechen,
das Anwendungsschema muss ihr gehören, privilegierte Rollenflags und geerbte
Rollen sind unzulässig. Der Live-Test verwendet dafür eine getrennte
temporäre Loginrolle und entfernt Rolle und Schema anschließend vollständig.
Diese technische Migrationsrolle ersetzt keine der vier getrennten Rollen für
Anwendung, Migration, Backup und Betrieb.

## 3. Poolrichtlinie

### 3.1 Verbindliche Standardwerte

Die aktuellen Standardwerte aus `DEFAULT_POSTGRESQL_POOL_POLICY` sind:

| Grenze | Standard | Treiberoption beziehungsweise Wirkung |
| --- | ---: | --- |
| minimale Verbindungen | `0` | `min` |
| maximale Verbindungen | `5` | `max` |
| Verbindungsaufbau | `5.000 ms` | `connectionTimeoutMillis` und Acquire-Grenze des Providers |
| Leerlauf einer Poolverbindung | `30.000 ms` | `idleTimeoutMillis` |
| serverseitiges Statementlimit | `30.000 ms` | `statement_timeout` |
| clientseitiges Querylimit | `32.000 ms` | `query_timeout` |
| Leerlauf in einer offenen Transaktion | `60.000 ms` | `idle_in_transaction_session_timeout` |
| maximale Verbindungslebensdauer | `3.600 s` | `maxLifetimeSeconds` |
| Prozessende bei leerem Pool | `false` | `allowExitOnIdle` |

Das clientseitige Querylimit liegt bewusst über dem serverseitigen
Statementlimit. Dadurch soll der Server eine zu lange Operation zuerst
kontrolliert abbrechen. Die Grenze von 60 Sekunden ist kein maximales
Gesamtlaufzeitversprechen für einen Transaktionscallback, sondern ausschließlich
das PostgreSQL-Limit für Leerlauf innerhalb einer offenen Transaktion.

Der Standard-Anwendungsname lautet
`grabenplaner-development-contract`. Andere Anwendungsnamen müssen dem
festgelegten, geheimnisfreien Zeichen- und Längenvertrag entsprechen.

### 3.2 Zulässige Anpassungsgrenzen

Eine nicht produktive Testumgebung darf Werte nur innerhalb der in der Policy
geprüften Grenzen verändern:

| Grenze | zulässiger Bereich |
| --- | ---: |
| minimale Verbindungen | `0` bis `20` |
| maximale Verbindungen | `1` bis `50` |
| Verbindungsaufbau | `100` bis `60.000 ms` |
| Poolleerlauf | `1.000` bis `600.000 ms` |
| Statementlimit | `100` bis `300.000 ms` |
| Querylimit | `100` bis `300.000 ms`, nie kürzer als das Statementlimit |
| Leerlauf in Transaktion | `100` bis `600.000 ms`, nie kürzer als das Statementlimit |
| Verbindungslebensdauer | `60` bis `86.400 s` |

Unbekannte Policyfelder, widersprüchliche Min-/Max-Werte und Werte außerhalb
dieser Grenzen scheitern vor der Poolerzeugung geschlossen.

### 3.3 Eigentum und Lebenszyklus

Es gibt exakt zwei Eigentumsmodi:

| Modus | Bedeutung beim Schließen |
| --- | --- |
| `external` | Standard der direkten Injektion; der Provider beendet den fremd verwalteten Pool nicht |
| `provider` | der Provider besitzt den Pool und ruft nach dem Leeren laufender Operationen genau einmal `pool.end()` auf |

`openPostgresqlDevelopmentPersistence(...)` verwendet immer
`poolOwnership: "provider"`. `close()` ist über die gemeinsame Providerfassade
idempotent, sperrt neue Operationen und wartet auf bereits begonnene Arbeit,
bevor der Adapter geschlossen wird.

Jede normale Operation leiht einen Client aus, führt das Statement innerhalb
einer eigenen expliziten Transaktion aus und gibt den Client anschließend genau
einmal frei. Ein nach Ablauf des Acquire-Limits verspätet eintreffender Client
wird ohne Statementausführung mit `release(true)` verworfen.

Der Provider registriert während seiner Lebensdauer einen Listener für
Poolfehler. Ein optionaler Diagnosecallback erhält ausschließlich einen bereits
normalisierten, geheimnisfreien `PersistenceError`. Fehler des
Diagnosecallbacks dürfen den Providerzustand nicht verändern. Beim Schließen
wird der Listener wieder entfernt.

## 4. Transaktionen und Parallelität

### 4.1 Isolationsabbildung

Der Vertragswert `default` ist für PostgreSQL ausdrücklich
`READ COMMITTED`; er hängt nicht von einer veränderbaren Servervorgabe ab.
`serializable` wird ausdrücklich als `SERIALIZABLE` begonnen.

| Vertragsoptionen | ausgeführter Beginn |
| --- | --- |
| `default`, schreibend | `BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE` |
| `default`, read-only | `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY` |
| `serializable`, schreibend | `BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE` |
| `serializable`, read-only | `BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY` |

Normale `queryOne`- und `queryAll`-Operationen laufen jeweils in einer eigenen
`READ COMMITTED READ ONLY`-Transaktion. Normale `execute`-Operationen laufen in
einer eigenen `READ COMMITTED READ WRITE`-Transaktion.

Der Transaktionscallback erhält ausschließlich den an genau diesen Client
gebundenen Executor. Ein Aufruf des globalen Providers aus demselben Callback
und verschachtelte Transaktionen werden weiterhin eindeutig abgelehnt.
Read-only-Transaktionen sperren `execute` bereits in der Providerfassade und
zusätzlich durch PostgreSQL `READ ONLY`.

### 4.2 Commit, Rollback und Clientfreigabe

Der Provider verantwortet `BEGIN`, `COMMIT` und `ROLLBACK`. Bei einem
Callback- oder Statementfehler wird Rollback versucht. Der normalisierte
Primärfehler bleibt auch dann verbindlich, wenn zusätzlich Rollback fehlschlägt.
Ein Commitfehler wird normalisiert; die gemeinsame Fassade versucht danach ein
Rollback. Schlägt dieses Cleanup ebenfalls fehl, wird die betroffene Verbindung
zerstörend freigegeben.

Es gibt keine automatische Wiederholung von Transaktionen.

### 4.3 Capability-Grenze

Der PostgreSQL-Produktprovider weist aktuell weiterhin nur folgende
Providerfähigkeiten positiv aus:

- atomare Transaktionen;
- parallele Schreibarbeit innerhalb der getesteten Providerfassade.

`concurrentWrites: true` erlaubt unabhängigen Aufrufern parallele
Transaktionen über unterschiedliche Poolclients. Die Schutzregel innerhalb
eines Transaktionscallbacks bleibt davon unberührt.

Folgende Fähigkeiten bleiben ausdrücklich `false`:

- mehrere App-Instanzen;
- Datenbankbackup und Restore;
- Integritätsprüfung und Recovery Assurance;
- System-Center-Status für PostgreSQL;
- gekoppeltes Dokumentbackup;
- Point-in-Time-Recovery.

Block 6 ändert diese Produktfähigkeiten bewusst nicht. Sein separater
Betriebsvertrag kann Backup, Restore, Integritätsprüfung,
Recovery-Assurance, Monitoring und gekoppeltes Dokumentbackup als
`implemented`, `configured` und lokal `verified` beschreiben. Unter dem
Profil `development-contract` bleiben solche Capabilities jedoch immer
`effective: false` und `productActivation: false`.

Die technische Parallelität des Pools ist kein Nachweis, dass Sessions, Jobs,
Sperren, geplante Aufgaben und fachliche Nebenwirkungen bereits
mehrinstanzfähig sind.

## 5. Deadlocks, Wiederholung, Timeout und Abbruch

### 5.1 Fehlerabbildung

Treiber- und SQLSTATE-Fehler werden ohne Nachrichtentext oder Treiberdetails in
stabile Providerfehler übersetzt:

| PostgreSQL- oder Treibersignal | normalisierter Fehler | grundsätzlich wiederholbar |
| --- | --- | --- |
| `23505`, `23P01` | `PERSISTENCE_UNIQUE_VIOLATION` | nein |
| `23503` | `PERSISTENCE_FOREIGN_KEY_VIOLATION` | nein |
| `23502` | `PERSISTENCE_NOT_NULL_VIOLATION` | nein |
| `23514` | `PERSISTENCE_CHECK_VIOLATION` | nein |
| `40001`, `40P01` | `PERSISTENCE_RETRYABLE_TRANSACTION` | ja |
| `55P03`, `55006` | `PERSISTENCE_BUSY` | ja |
| `57014`, `QUERY_TIMEOUT`, `ETIMEDOUT` | `PERSISTENCE_TIMEOUT` | nein |
| `ABORT_ERR`, `AbortError` | `PERSISTENCE_ABORTED` | nein |
| SQLSTATE-Klasse `08`, `53300`, `57P01` bis `57P03` sowie benannte Netzwerkfehler | `PERSISTENCE_CONNECTION_UNAVAILABLE` | nein |
| `25006`, `25P01`, `25P02` | `PERSISTENCE_TRANSACTION_STATE_INVALID` | nein |
| `26000`, `42601`, `42P02` | `PERSISTENCE_STATEMENT_INVALID` | nein |
| benannte Schemafehler und übrige SQLSTATE-Klasse `42` | `PERSISTENCE_SCHEMA_INVALID` | nein |
| unbekannt | `PERSISTENCE_UNKNOWN` | nein |

`retryable: true` ist nur eine Klassifikation. Sie löst keinen automatischen
Retry aus. Eine spätere Wiederholung darf ausschließlich für ausdrücklich
geprüfte, idempotente Operationen mit begrenzter Versuchszahl und
nachvollziehbarer Protokollierung eingeführt werden.

### 5.2 Wahrheitsgemäße Abbruchgrenze

Der Providervertrag besitzt aktuell kein aufruferspezifisches
`AbortSignal`-Argument. Block 5 weist deshalb keinen kontrollierten
Caller-Abbruch einer bereits laufenden realen PostgreSQL-Abfrage nach.

Aktuell nachgewiesen werden nur:

- begrenztes Warten auf einen Poolclient;
- server- und clientseitige Queryzeitgrenzen in der Policy;
- stabile Normalisierung von Timeout- und Abortsignalen;
- sichere Freigabe eines nach Acquire-Timeout verspäteten Clients.

Ein synthetisch ausgelöster `AbortError` beweist lediglich die
Fehlernormalisierung. Echte In-Flight-Abbrüche dürfen erst nach einem
Integrationstest gegen die konkret festgelegte `pg`- und PostgreSQL-Version
behauptet werden. Ungeprüfte Treiberinternas oder direkte Socketmanipulation
sind nicht zulässig.

## 6. TLS, Secrets und Rotation

### 6.1 TLS-Modi

Es gibt exakt zwei zulässige TLS-Modi:

| Modus | Zulässigkeit |
| --- | --- |
| `verify-full` | Standard; TLS mit `rejectUnauthorized: true` |
| `disable-local-only` | ausschließlich für `localhost`, `127.0.0.1` oder `::1` |

Ein entfernter Host darf niemals mit deaktivierter Zertifikatsprüfung geöffnet
werden. SSL-Parameter in der `DATABASE_URL` werden abgelehnt; die TLS-Policy
darf nicht durch URL-Parameter überschrieben werden.

Die aktuelle Policy besitzt noch keine Schnittstelle für eine kundenspezifische
CA-Kette oder Clientzertifikate. Eine Umgebung, die solche Materialien
benötigt, ist daher noch nicht freigegeben und benötigt zuerst eine eigene,
getestete Secret- und Zertifikatsintegration.

### 6.2 Secret-Grenze

Die `DATABASE_URL` ist ein Secret und darf:

- nicht im Repository, in Fixtures oder Dokumentationsbeispielen gespeichert
  werden;
- nicht in Logs, Statusantworten, Oberflächen oder Fehlerobjekten erscheinen;
- nicht zusammen mit der erzeugten Poolkonfiguration serialisiert oder
  protokolliert werden;
- nur dem ausdrücklich zuständigen Prozess und der zugehörigen Rolle
  bereitgestellt werden.

Die URL-Validierung prüft Protokoll, Host und Datenbanknamen, gibt bei Fehlern
aber nur eine generische, geheimnisfreie Diagnose zurück. Der Provider
übernimmt weder URL noch Credentials in seine öffentliche Oberfläche.

### 6.3 Rotationsverfahren

Secret-Rotation erfolgt später ausschließlich als kontrollierter Pooltausch:

1. neues rollenbezogenes Credential im vorgesehenen Secret-System erzeugen;
2. neuen Pool mit der unveränderten Policy erstellen;
3. Verbindung, Rolle und minimale Rechte in einer nicht produktiven Prüfung
   bestätigen;
4. neue App-Instanz beziehungsweise kontrollierten Neustart mit dem neuen Pool
   starten;
5. alten Pool geordnet leeren und schließen;
6. altes Credential erst danach widerrufen;
7. Rotation ohne Secretwerte revisionsfähig dokumentieren.

Eine laufende Poolinstanz wird nicht durch Mutation ihrer Connection- oder
Secretfelder rotiert. Automatische Rotation und produktive Umschaltung sind
nicht Bestandteil von Block 5 oder Block 6.

### 6.4 Block-6-Werkzeugcredentials

`pg_dump` und `pg_restore` erhalten weder `DATABASE_URL` noch Passwörter als
Kommandozeilenargument. Der Prozess erhält ausschließlich den benannten
PostgreSQL-Service und private Credentialdateien über `PGSERVICE`,
`PGSERVICEFILE` und `PGPASSFILE`. Die Dateien müssen absolut, regulär,
unverlinkt und einfach verlinkt sein; unter Unix sind Gruppen- und
Fremdrechte unzulässig. Die entsprechende Windows-ACL muss vor einer realen
Installation zusätzlich betrieblich geprüft werden.

Quellbackup und isoliertes Restore-Ziel verwenden getrennte Serviceidentitäten.
Dateipfade, Servicenamen, Hosts, Rollen und Secrets sind keine zulässigen
Felder in Backup-Bundle, Recovery-Assurance-Beleg, Capability-Report oder
Monitoringausgabe. Block 6 erzeugt und verteilt keine produktiven
Credentialdateien.

## 7. Vier getrennte Least-Privilege-Rollen

Die vier Rollenabsichten aus `POSTGRESQL_ROLE_PURPOSES` sind verbindlich
getrennt. Credentials dürfen nicht zwischen ihnen geteilt werden.

| Rolle | Erforderliche Rechte | Ausdrücklich nicht zulässig |
| --- | --- | --- |
| `application` | `CONNECT`, Schema-`USAGE`, erforderliches `SELECT`, `INSERT`, `UPDATE`, `DELETE` und eng begrenzte Sequenzrechte auf Anwendungsobjekten | DDL, Rollenverwaltung, Datenbankanlage, Backup-/Betriebsrechte, Superuser |
| `migration` | kontrollierter Zugriff auf Migrationsledger und notwendiges Erstellen, Ändern oder Entfernen von Objekten ausschließlich im Anwendungsschema | Verwendung durch den App-Prozess, Rollenverwaltung, Datenbankanlage, Replikation, Superuser |
| `backup` | konsistenter, lesender Zugriff auf die vollständig festgelegten Sicherungsobjekte der einen Anwendungsdatenbank | Anwendungs-DML, DDL, Restore, Rollenverwaltung, Superuser |
| `operations` | ausschließlich erforderliche, lesende Diagnose- und Monitoringrechte; gegebenenfalls eng begrenzte PostgreSQL-Monitorrolle | fachlicher Datenzugriff, Anwendungs-DML, DDL sowie Signal-, Rollen- oder Superuserrechte ohne separate zeitlich begrenzte Freigabe |

Für keine dieser Rollen sind `SUPERUSER`, `CREATEDB`, `CREATEROLE`,
`REPLICATION` oder `BYPASSRLS` ein Standardrecht. Öffentliche Standardrechte
und Schema-`CREATE` sind vor einer realen Integration ausdrücklich zu prüfen
und auf das notwendige Minimum zurückzunehmen.

Der produktive App-Prozess dürfte später ausschließlich das
`application`-Credential erhalten. Migration, Backup und Betrieb benötigen
getrennte Prozesse, getrennte Secrets und getrennte Ausführungsfreigaben.

Block 6 setzt diese Trennung in den Werkzeug- und Monitorverträgen voraus,
legt aber keine produktiven Rollen an. Der Backup-Dump benötigt eine
eigenständige lesende Identität; der Monitor prüft `READ ONLY`, identische
Session-/Current-Identität, unprivilegierte Rollenflags, `pg_monitor` und das
Fehlen sonstiger direkter Rollenmitgliedschaften. Vollständige Objekt-,
Schema- und Datenbankprivilegien sowie `ADMIN OPTION` sind damit noch nicht
abgenommen. Das isolierte Restore-Ziel besitzt ein eigenes
Service-/Zielbinding; der lokale Live-Test nutzt für Quelle und Ziel jedoch
noch dieselbe synthetische Test-Loginrolle. Reale Rechte-Negativtests,
Eigentümerschaft, getrennte Restore-Rolle und Credentialrotation bleiben
installationsbezogene Gates.

## 8. Test- und Abnahmematrix

| Bereich | Synthetischer Nachweis in Block 5 | Zusätzlicher Nachweis vor realer Phase-5-Abnahme | Gate vor Supportfreigabe |
| --- | --- | --- | --- |
| Provideroberfläche und keine Raw-Handles | Vertrags- und Providertests | vollständige Repository-Parität | Regression und Architekturaudit |
| Parameter, Array-Zeilen und Werttypen | Fake-Pool plus reale Nonprod-Prüfung der aktuell verwendeten Vertragsarten; Feldname und Feldreihenfolge scheitern bei Abweichung geschlossen | vollständige Paritätsprüfung aller Anwendungsspalten | produktionsnahe Datenstichprobe |
| SQL-Katalog | Compiler-v2-Plan mit 1008 Syntaxkandidaten und 111 Overrides; geschlossener 0/1119-Acceptance-Vertrag; gepinnte Quellvertrags-Fingerprints aus SQL plus vollständigem Statementvertrag; widersprüchliches `RETURNING` scheitert geschlossen; vier reale Teil-Slices mit zusammen neun Statements: UI-Präferenzen 4/4, Planning Settings 2/2, Organization Departments 2/2 und System Center 1/1 | alle 1119 Anwendungsstatements mit geprüftem PostgreSQL-SQL und je einem akzeptierten Live-/Paritätsnachweis | vollständiger Funktionslauf |
| Schema und Nullability | dokumentiertes Gate für den schwächeren SQLite-Vertrag von `TEXT PRIMARY KEY` ohne `NOT NULL` | explizite Ableitung und Prüfung jeder PostgreSQL-Nullability aus dem Fachvertrag | Migrations- und historische Paritätsabnahme |
| Transaktionsmodi | alle vier `BEGIN`-Varianten synthetisch sowie reale Read-only-, Rollback- und Serializable-Prüfung | vollständige fachliche Transaktionsparität | fachliche Parität |
| Parallelität | zwei Fake-Pool-Clients und zwei gleichzeitig aktive reale Transaktionen | Konkurrenz-, Lock- und Lasttest mit Anwendungspfaden | separate Mehrinstanzentscheidung |
| Deadlock und Serialization Failure | SQLSTATE-Abbildung und realer `40P01`-Deadlock | kontrolliert reproduzierter `40001` und fachliche Konfliktfälle | freigegebene, idempotente Retryregeln |
| Acquire-Timeout | verspäteter Client wird verworfen | realer erschöpfter Pool | Monitoring und Alarmierung |
| Statement- und Querytimeout | Policy, Fehlerabbildung und realer `57014`-Statement-Timeout | Sperrwartezeit, clientseitiger Querytimeout und Verbindungsabbruch | betriebliche Grenzwerte |
| Abort | synthetische `AbortError`-Normalisierung | unterstützter realer In-Flight-Abbruch | dokumentiertes Betriebsverhalten |
| Pool-Eigentum und `close()` | externer und Provider-Pool synthetisch | echtes `pg.Pool.end()` unter Last | geordneter Server-Shutdown |
| TLS | Policy-, URL- und Loopback-Negativtests | echte Zertifikats- und Hostnamenprüfung | Secret-/Zertifikatsbetrieb abgenommen |
| Secret-Redaktion | Fehler mit eingebetteten Testsecrets | Log-, Status- und Crashdump-Prüfung | Rotation und Incident-Prozess |
| Rollen | vier statisch getrennte Rollen; der Migrationsadapter prüft eine echte getrennte Loginrolle, `current_user = session_user`, Schemaeigentum, unprivilegierte Rollenflags und fehlende Rollenmitgliedschaften fail-closed | Rechte-Negativtests mit den übrigen drei echten Betriebsrollen | betriebliche Rollenverantwortung |
| Migrationen | generischer Adapter mit Session-Lock vor genau einer serialisierbaren Schreibtransaktion und selbst gehashten versionierten SQL-Artefakten; Rebuild, Präfix-Upgrade, No-op, synthetischer Rollback, atomarer Fehlerabbruch, Parallelität, Allowlist und Drift real geprüft; Anwendungsmigrationen weiterhin 0/10 | deklarative Bindung und Nachweis aller zehn Anwendungsmigrationen einschließlich historischem Bestand | reproduzierbarer Cutover- und Rückkehrplan |
| Backup-Bundle und Dump | Bundle v2, exportierter Snapshot, Custom-Dump, Dokumentbindung, Manipulations-/Partial-/Link-Negativtests | produktive Quiesce-Verdrahtung, Zeitplan, Retention und Offsite | freigegebener installierter Backupbetrieb passend zum RPO |
| Restore | synthetische Negativtests plus realer PostgreSQL-18.4-Restore-E2E 1/1 lokal und extern in CI grün | Vollanwendungs-Restore auf realitätsnaher Datenmenge | gemessenes RTO und freigegebener Wiederanlaufplan |
| Monitoring | read-only Abfrage, exakter Resultatvertrag und Evidence-Zustände getestet | System-Center-, Alarmierungs- und Operations-Rollenintegration | betrieblich verantwortete Grenzwerte und Eskalation |
| Recovery Assurance | providergebundener signierter Belegvertrag v2 und Negativtests | produktiver Orchestrator für Offsite, Repository-Read-Check, Restore, Signierung und Ablage | aktueller vollständiger End-to-End-Beleg |
| PITR, HA und Mehrinstanz | nicht implementiert | nicht Ziel von Block 6 | jeweils eigener Aufbau und eigene Freigabe |

### 8.1 Abnahme des nicht produktiven Provider- und Betriebs-Slices

Der Provider-Slice darf als nicht produktive Grundlage abgenommen werden, wenn:

- Policy-, Provider-, Vertrags- und Negativtests vollständig grün sind;
- die Gesamtsuite ohne neue Regression läuft;
- das Persistence-Audit nur die ausdrücklich benannten PostgreSQL-Module und
  Test-Fixtures zulässt;
- keine Secrets oder rohen Handles die Providergrenze verlassen;
- `DB_PROVIDER=postgresql` im normalen Startpfad weiterhin geschlossen bleibt;
- Dokumentation, Oberfläche, README und Release Notes keine
  PostgreSQL-Supportbehauptung enthalten.

Für Block 6 wurde darüber hinaus lokal abgenommen:

- kombinierter PostgreSQL-Block-5/6-Lauf: 121/121 Tests grün;
- realer PostgreSQL-18.4-Backup-/Restore-E2E-Fall: 1/1 grün;
- identische Quell-/Ziel-Evidence und verschlüsselter Dokument-Roundtrip;
- vollständiger Scratch-Cleanup und Ablehnung eines beschädigten Dumps;
- No-Cutover-Gates für Produktprovider, Serverstart und Produktoberfläche.

Der GitHub-Actions-Job ist mit `postgres:18.4-alpine`, Clientwerkzeugen 18 und
allen Block-5/6-Tests konfiguriert. Der veröffentlichte Integrationscommit
`25fab8e` ist im
[GitHub-Actions-Lauf 30508095599](https://github.com/christianseiwaldat-collab/Grabenplaner/actions/runs/30508095599)
einschließlich PostgreSQL-18.4-Vertragsjob sowie vollständiger Ubuntu- und
Windows-Suite grün. Das erfüllt den nicht produktiven externen CI-Nachweis,
aber keine Vollanwendungs-, Support- oder Installationsfreigabe.

### 8.2 Noch erforderliche vollständige Phase-5-Abnahme

Eine vollständige technische Phase-5-Abnahme erfordert zusätzlich eine
reproduzierbare, hermetische Testumgebung mit festgelegter `pg`- und
PostgreSQL-Version. Dort müssen mindestens sämtliche PostgreSQL-Dialekte,
Migrationen, Constraints, Transaktionsmodi, Timeouts, Abbrüche,
Konkurrenzfälle und realitätsnahe Last geprüft werden.

Selbst eine bestandene reale Phase-5-Abnahme ist noch keine Produktiv- oder
Supportfreigabe. Diese bleibt an die Betriebs-, Recovery- und Support-Gates von
Phase 6 gebunden.

Block 6 ersetzt diese Phase-5-Abnahme nicht. Die Akzeptanzstände bleiben
0/1119 für den Vollanwendungskatalog und 0/10 für die Anwendungsmigrationen.

## 9. Was die aktuellen Tests ausdrücklich nicht beweisen

Der Fake-Pool prüft Aufrufreihenfolge, gebundene Clients,
Parameterwerte, Resultatnormalisierung einschließlich exakter Feldnamen und
-reihenfolge, Fehlercodes, Parallelitätssteuerung und Lifecycle. Die ergänzte
isolierte Nonprod-Live-Suite hat mit `pg` 8.22.0 und PostgreSQL 18.4 in sieben
Fällen zusätzlich die verwendeten Treibertypen und `RETURNING`,
Compiler-v2-JSON-Bindungen, vier Constraint-SQLSTATEs, Rollback, Read-only und
Serializable, zwei parallele Transaktionen, einen echten `40P01`-Deadlock
sowie einen echten `57014`-Statement-Timeout geprüft.

Separat weisen reale Dual-Provider-Tests UI-Präferenzen 4/4, Planning Settings
2/2, Organization Departments 2/2 und System Center `oldestIntervalKeys` 1/1
fachlich deckungsgleich nach. Die vier Slices umfassen zusammen genau neun
live geprüfte Statements. Darin sind unter anderem JSON-Binding,
JSONB-Objektkonstruktion, providerneutrales `key: null`-Fehlschlagen,
Transaktionsrollback, Boolean-Prädikat, `C`/`BINARY`-Sortierung,
UTC-Timestamp-Text und ein typisiertes `LIMIT` abgedeckt. Gepinnte
Quellvertrags-Fingerprints schützen alle vier Slices gegen unbemerkte SQL-,
Parameter-, Nullability- und Ergebnisvertragsdrift. Cleanupfehler lassen die
Tests fehlschlagen.

Block 6 ergänzt einen realen PostgreSQL-18.4-Betriebsweg-Nachweis für
exportierten Snapshot, `pg_dump`, isolierten `pg_restore`, Schema und
Constraints, kanonische Quell-/Ziel-Evidence sowie eine verschlüsselte,
referenzierte PDF-Datei. Dieser Live-Test verwendet ein kleines synthetisches
Anwendungsschema. Er beweist den Betriebsweg, nicht die Wiederherstellbarkeit
der noch nicht vorhandenen PostgreSQL-Vollanwendung.

Alle vier bleiben `development-contract`-Slices mit
`applicationExecutable: false`, `fullApplicationCatalog: false` und
`productActivation: false`; der Katalogvertrag verhindert bei 0/1119
Acceptance-Nachweisen weiterhin jeden für die Vollanwendung ausführbaren
Katalog. Der generische Migrationsadapter beweist zusätzlich seinen
Transaktions-, Ledger- und Parallelitätsvertrag, aber keine der neun
Anwendungsmigrationen. Diese Teilnachweise beweisen weiterhin nicht:

- dass der nicht ausführbare Gesamtplan oder alle 1008 generierten
  Syntaxkandidaten einen vollständigen PostgreSQL-Anwendungskatalog bilden;
- dass ein realer PostgreSQL-Server alle Dialektvarianten akzeptiert;
- dass sämtliche Anwendungsspalten und historischen Werte ohne server- oder
  treiberabhängige Abweichungen ankommen;
- dass TLS, DNS, Zertifikatsprüfung und Netzwerkabbrüche korrekt funktionieren;
- dass Querytimeout, Sperrwartezeit, Verbindungsabbruch und
  Transaktionsleerlaufgrenzen unter realer Last zuverlässig ineinandergreifen;
- dass `40001`, Sperren und fachliche Serializable-Konflikte sicher behandelt
  werden können;
- dass Migrationen historische Datenbestände verlustfrei überführen;
- dass Poolgröße und Laufzeiten für eine konkrete Installation ausreichend
  sind;
- dass ein geplanter produktiver Backup-, Offsite-, Restore- oder
  Recovery-Assurance-Betrieb für eine konkrete Installation funktioniert;
- dass PITR, WAL-Archivierung, Replikation, Hochverfügbarkeit oder Failover
  funktionieren;
- dass mehrere Grabenplaner-Instanzen gemeinsam betrieben werden dürfen.

Diese Grenzen müssen in Testberichten und Abnahmeaussagen sichtbar bleiben.
Der PostgreSQL-Anwendungsmigrationsstand bleibt 0/10; keine der zehn
Anwendungsmigrationen ist implementiert. Der Vollanwendungskatalog bleibt
0/1119.

## 10. Ausdrückliche Nichtziele und Stop-Regeln

Block 5 und Block 6 erlauben nicht:

- PostgreSQL im produktiven Startpfad zu aktivieren;
- `DB_PROVIDER=postgresql` als unterstützt auszuweisen;
- echte Kundendaten zu migrieren oder automatisch zu importieren;
- einen produktiven Cutover oder Rückkehrplan auszuführen;
- SQLite abzuschaffen oder herabzustufen;
- Backup, Restore, Recovery Assurance oder System-Center-Nachweise vom
  SQLite-Pfad auf PostgreSQL zu übertragen;
- einen produktiven Backupzeitplan, Restorejob oder
  Recovery-Assurance-Orchestrator zu aktivieren;
- automatische Deadlock- oder Transaktionswiederholungen einzuführen;
- mehrere App-Instanzen, HA, Failover, PITR oder Multi-Region zu versprechen;
- einen konkreten PostgreSQL-Anbieter auszuwählen;
- Secrets, Zertifikate oder Rollen zusammenzulegen;
- eine entfernte Verbindung ohne vollständige TLS-Prüfung zu öffnen;
- ein Release, einen Push oder eine Serveraktualisierung aus dieser
  Architekturentscheidung abzuleiten.

Jede produktive Aktivierung, Datenübernahme und Supportfreigabe benötigt eine
eigene ausdrückliche Entscheidung nach den noch offenen realen Integrations-,
Betriebs- und Recovery-Nachweisen.

Für RPO, RTO, Wartung, Rollen, Secrets, externe CI-Evidence und die weiterhin
offenen installationsbezogenen Abnahmen gilt verbindlich
[PostgreSQL-Betrieb und Recovery im nicht produktiven Status](DATENBANK-POSTGRESQL-BETRIEB-UND-RECOVERY.md).
