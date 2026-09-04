# Datenbank-Provider-Strategie

**Status:** Verbindliche Zielarchitektur; Phase 4 abgeschlossen, Phase 5
weiterhin in Bearbeitung; Block 6 als nicht produktiver Betriebs- und
Recovery-Vertrag lokal abgenommen

**Stand:** 13.08.2026

**Beschlossen am:** 28.07.2026

**Ausgangsbasis:** Grabenplaner v0.87.0-beta, ausschließlich SQLite

**Betriebsmodell:** verwalteter Serverbetrieb

## 1. Zweck und Entscheidungsgrenze

Grabenplaner erhält schrittweise eine klar abgegrenzte
Datenbank-Provider-Architektur. SQLite bleibt dauerhaft der vollständig
unterstützte Standard für verwaltete Einzelserver mit genau einer
Grabenplaner-App-Instanz. PostgreSQL soll später als zusätzlicher Provider für
größere zentrale Installationen verfügbar werden.

Diese Strategie ist eine verbindliche Architekturentscheidung. Sie ist weder
eine Behauptung bereits vorhandener PostgreSQL-Unterstützung noch eine
Freigabe, den Produktivserver zu migrieren. Jede nachfolgend beschriebene
Implementierungsphase benötigt eine eigene ausdrückliche Startfreigabe.

Die Ausgangsversion v0.87.0-beta verwendet ausschließlich SQLite. In Phase 0
werden weder Runtime-Code noch Abhängigkeiten, Datenbanken,
Produktivkonfigurationen oder öffentliche Produktangaben verändert.

## 2. Zielbild

```text
Verwalteter Einzelserver, eine App-Instanz  -> SQLite (Standard)
Größere zentrale Installation              -> SQLite oder PostgreSQL
Mehrere App-Instanzen / erhöhte Parallelität -> PostgreSQL, erst nach Freigabe
```

### 2.1 SQLite

SQLite bleibt dauerhaft vorgesehen für:

- verwaltete Grabenplaner-Einzelserver;
- genau eine aktive Grabenplaner-App-Instanz je Datenbank;
- möglichst wartungsarmen Betrieb ohne separaten Datenbankserver;
- Installationen, deren Parallelitäts- und Wiederherstellungsanforderungen
  durch den nachgewiesenen SQLite-Betrieb erfüllt werden;
- bestehende verwaltete Serverinstallationen und ihre SQLite-Datenbanken.

Bestehende SQLite-Datenbanken müssen ohne automatische Konvertierung und ohne
Datenverlust weiterverwendet werden können. Der bisherige
`DB_PATH`-Konfigurationsweg bleibt kompatibel.

### 2.2 PostgreSQL

PostgreSQL ist langfristig vorgesehen für:

- größere zentrale Firmeninstallationen;
- viele gleichzeitige Schreibzugriffe;
- mehrere Organisationen oder Mandanten auf einer Plattform;
- mehrere parallele Grabenplaner-App-Instanzen, sofern auch alle übrigen
  Mehrinstanzanforderungen erfüllt sind;
- getrennte oder verwaltete Datenbankserver;
- anspruchsvollere Wiederherstellungsziele, gegebenenfalls einschließlich
  Point-in-Time-Recovery.

PostgreSQL darf erst als unterstützt bezeichnet oder produktiv angeboten
werden, wenn Providervertrag, Migrationen, Fachfunktionen, Backup, Restore,
Recovery Assurance, Monitoring und Betriebsdokumentation die festgelegten
Gates vollständig erfüllen.

### 2.3 Nicht mehr Teil des Zielbilds

Portable-, USB- und nicht verwaltete lokale Auslieferungen sind kein künftiges
Produktmodell dieser Strategie. Eine gesonderte Legacy-Veröffentlichung kann
den früheren Stand dokumentieren; daraus entsteht keine Verpflichtung für die
weitere Produktentwicklung.

## 3. Ausgangslage

Der SQLite-Betrieb ist fachlich und betrieblich etabliert. Die Anwendung ist
jedoch tief an SQLite gekoppelt. Dazu gehören insbesondere:

- direkte Nutzung von `node:sqlite` und `DatabaseSync`;
- synchrone Zugriffe über `prepare().run()`, `.get()` und `.all()`;
- SQLite-spezifische SQL-Syntax wie `INSERT OR IGNORE`;
- `?` als SQL-Parameter;
- PRAGMAs;
- `VACUUM INTO` und `PRAGMA quick_check`;
- SQLite-spezifische Transaktions- und Sperrlogik;
- Migrationen, Trigger, Indizes und Constraints;
- SQLite-bezogene Backup-, Restore-, Recovery-Assurance- und
  System-Center-Funktionen.

Ein direkter Austausch der Datenbank wäre deshalb kein Treiberwechsel, sondern
ein umfangreicher Architekturumbau. Insbesondere der Wechsel vom synchronen
SQLite-Zugriff auf asynchrone PostgreSQL-Verbindungen betrifft
Kontrollfluss, Fehlerbehandlung und Transaktionsgrenzen.

## 4. Verbindliche Architekturregeln

### 4.1 Interner Name und Verantwortungsgrenze

Die neue interne Abstraktion heißt konzeptionell `PersistenceProvider` oder
`AppDatabaseProvider`. Dadurch bleibt sie eindeutig von bereits vorhandenen
Providern für externe SQL- oder Importsysteme unterscheidbar.

Fachlogik darf nach abgeschlossener Migration:

- keinen konkreten Datenbanktreiber importieren;
- keinen rohen Connection-, Client-, Statement- oder Treiberhandle erhalten;
- keine providerspezifischen Fehlercodes auswerten;
- keine SQL-Dialekte anhand des aktiven Providers verzweigen;
- keine Transaktion außerhalb des Providervertrags steuern.

Rohe Treiberhandles verbleiben ausschließlich innerhalb des jeweiligen
Providers und seiner ausdrücklich benannten Betriebsadapter.

Eng begrenzte Test-Fixtures und Testhelfer dürfen einen konkreten Treiber
verwenden, wenn sie ausdrücklich als providerspezifisch gekennzeichnet sind und
keine produktive Fachlogik bereitstellen. Die Architekturprüfung unterscheidet
deshalb produktive Direktkopplungen von solchen Testhilfen; sie darf letztere
nicht stillschweigend als allgemeine Ausnahme behandeln.

### 4.2 Asynchroner Providervertrag

Der Providervertrag ist von Beginn an Promise-basiert, auch für SQLite. Damit
wird die Fachlogik nicht später ein zweites Mal von synchron auf asynchron
umgebaut.

Die folgende Form ist richtungsweisend; konkrete Namen dürfen in der
freigegebenen Implementierungsphase begründet angepasst werden:

```ts
interface PersistenceExecutor {
  queryOne<T>(statement: Statement, params?: QueryParams): Promise<T | null>;
  queryAll<T>(
    statement: Statement,
    params?: QueryParams
  ): Promise<ReadonlyArray<T>>;
  execute(
    statement: Statement,
    params?: QueryParams
  ): Promise<ExecuteResult>;
}

interface PersistenceProvider extends PersistenceExecutor {
  transaction<T>(
    work: (tx: PersistenceExecutor) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;
  close(): Promise<void>;
  getCapabilities(): Readonly<ProviderCapabilities>;
}
```

`transaction(...)` stellt dem Callback einen transaktionsgebundenen Executor
bereit. Sämtliche Abfragen des Callbacks müssen über diesen Executor und damit
über dieselbe SQLite-Verbindung beziehungsweise denselben gebundenen
PostgreSQL-Client laufen. Der globale Provider darf innerhalb des Callbacks
nicht als Ausweichpfad verwendet werden.

Der Provider verantwortet Begin, Commit und Rollback. Bei Fehlern im Callback
muss Rollback versucht und der normalisierte Primärfehler erhalten werden.
Verschachtelte Transaktionen sind entweder über eine dokumentierte
Savepoint-Semantik umzusetzen oder eindeutig abzulehnen.

### 4.3 SQL-Eigentum

Eine Provider-API allein macht SQL nicht portabel. Deshalb gilt zusätzlich:

- Fachmodule rufen fachlich benannte Repository- oder Data-Access-Methoden auf.
- SQL liegt ausschließlich in der Persistence-Schicht.
- Jedes Statement gehört entweder zu einem nachweislich gemeinsamen,
  eingeschränkten SQL-Teilumfang oder besitzt getrennte SQLite- und
  PostgreSQL-Varianten.
- Parameter werden nur über die Provider-Parameterbindung eingesetzt; SQL darf
  nicht aus Fachwerten zusammengesetzt werden.
- Migrationen, Diagnoseabfragen und Betriebsfunktionen besitzen ausdrücklich
  benannte, providerabhängige Implementierungen.
- Vorübergehende direkte Zugriffe werden im Inventar geführt und müssen je
  Phase messbar abnehmen.

Der Provider darf keinen allgemeinen Escape-Hatch bereitstellen, über den
Fachlogik wieder rohe Connections oder beliebige Treiberobjekte erhält.

### 4.4 Normalisierte Resultate

Fachlogik darf sich nicht auf treiberspezifische Rückgabeobjekte verlassen.
Mindestens folgende Resultate sind verbindlich zu normalisieren:

```ts
type ExecuteResult = {
  rowsAffected: number;
  returnedRows: ReadonlyArray<Record<string, unknown>>;
};
```

Erzeugte Schlüssel werden entweder als explizite Rückgabezeile oder über eine
eigene dokumentierte Methode zurückgegeben. SQLite-`lastInsertRowid` und
PostgreSQL-`RETURNING` dürfen nicht ungefiltert in Fachmodule gelangen.

Für Werte gelten providerübergreifend festgelegte Regeln, insbesondere für:

- `null` und fehlende Spalten;
- Boolean-Werte;
- Ganzzahlen außerhalb des sicheren JavaScript-Zahlenbereichs;
- Dezimalwerte;
- Zeitstempel, Datum, Uhrzeit und Zeitzone;
- JSON-Werte;
- Binärdaten.

Die konkreten Normalisierungsregeln und Typen werden vor der Umstellung erster
Fachmodule durch Vertragstests festgeschrieben.

### 4.5 Normalisierte Fehler

Providerfehler werden in stabile, providerneutrale Fehlerklassen oder
Fehlercodes übersetzt. Mindestens erforderlich sind:

- eindeutiger Schlüsselkonflikt;
- Foreign-Key-Verletzung;
- Check- oder Not-Null-Constraint-Verletzung;
- Busy- oder Lock-Zustand;
- Deadlock beziehungsweise serialisierbarer Wiederholungsfall;
- Verbindungs- oder Poolfehler;
- Timeout oder Abbruch;
- ungültiger Transaktionszustand;
- ungültiges Statement oder Schema.

Jeder normalisierte Fehler kennzeichnet, ob ein Wiederholungsversuch
grundsätzlich zulässig ist. Treiberdetails dürfen intern als `cause` für
Diagnose und Protokollierung erhalten bleiben, aber weder Geheimnisse enthalten
noch die fachliche Fehlerbehandlung bestimmen.

Automatische Wiederholungen erfolgen nur für ausdrücklich freigegebene,
idempotente Operationen und niemals pauschal.

## 5. Konfiguration und Startverhalten

Vorgesehen sind mindestens:

- `DB_PROVIDER=sqlite|postgresql`;
- `DB_PATH` für SQLite;
- `DATABASE_URL` oder eine gleichwertige Secret-basierte Konfiguration für
  PostgreSQL.

Verbindliche Regeln:

1. Fehlt `DB_PROVIDER`, wird für die Kompatibilität bestehender Installationen
   `sqlite` gewählt.
2. Der bisherige `DB_PATH`-Pfad und sein bisheriges Auflösungsverhalten bleiben
   im SQLite-Betrieb kompatibel.
3. Ein unbekannter Providerwert führt zu einem klaren Startfehler. Es gibt
   keinen stillen Rückfall auf SQLite.
4. Fehlende, widersprüchliche oder ungültige Pflichtkonfiguration führt
   ebenfalls zu einem Startfehler.
5. PostgreSQL-Verbindungsdaten und Secrets erscheinen weder in Logs noch in
   Statusantworten oder Oberflächen.
6. Die aktive Providerkennung darf erst nach erfolgreicher Initialisierung als
   betriebsbereit gemeldet werden.
7. Es gibt keinen automatischen produktiven Providerwechsel und keinen
   automatischen Import zwischen SQLite und PostgreSQL.

## 6. Migrationen und Datenübernahme

Gemeinsame fachliche Migrationen werden von providerspezifischer SQL-Syntax
getrennt. Unterschiede sind mindestens zu berücksichtigen bei:

- Datentypen und Boolean-Werten;
- automatisch erzeugten IDs;
- Zeitstempeln und Zeitzonen;
- Upserts und `RETURNING`;
- Constraints und Foreign Keys;
- Triggern und Teilindizes;
- JSON-Daten;
- Transaktions- und Sperrverhalten;
- Schema- und Tabelleninformationen.

Für jeden Provider muss eine deterministische, wiederholbare Migrationskette
existieren. Migrationen laufen atomar, soweit der jeweilige Provider dies
unterstützt; Ausnahmen sind ausdrücklich zu dokumentieren und abzusichern.

Bestehende unveränderliche Historien, Prüfsummen und revisionsrelevante Daten
dürfen nicht neu interpretiert oder überschrieben werden.

Eine spätere SQLite-zu-PostgreSQL-Datenübernahme ist ein eigener Cutover mit:

- Vorprüfung und eindeutiger Quellidentifikation;
- dokumentierter Feld- und Typabbildung;
- Mengen-, Fremdschlüssel- und Prüfsummenabgleich;
- Behandlung laufender Schreibzugriffe;
- Abbruch- und Rückkehrplan;
- vollständigem Testlauf auf realitätsnahen Datenkopien;
- separater Freigabe für jede Produktivinstallation.

## 7. Capability-Matrix

Die Provider stellen eine maschinenlesbare Capability-Beschreibung bereit.
Oberfläche, System-Center und Betriebswerkzeuge dürfen nur Fähigkeiten
anzeigen, die der aktive Provider tatsächlich und nachweislich unterstützt.

| Fähigkeit | SQLite-Standard | PostgreSQL vor Supportfreigabe | Gate für PostgreSQL-Support |
| --- | --- | --- | --- |
| Fachliche Lese-/Schreibvorgänge | unterstützt | in Phase 5 nicht-produktiv zu implementieren | vollständige Funktions- und Vertragstests |
| Atomare Transaktionen | unterstützt | nachzuweisen | Paritäts- und Fehlertests |
| Bestehende Migrationen | unterstützt | providerabhängig umzusetzen | vollständige Neuaufbau- und Upgrade-Tests |
| Gleichzeitige Schreibzugriffe | begrenzt auf freigegebenes Einzelinstanzmodell | nicht freigegeben; nachzuweisen | Last-, Lock-, Deadlock- und Isolationstests |
| Mehrere App-Instanzen | nicht freigegeben | nicht automatisch freigegeben | Sitzungen, Jobs, Sperren, Dateien und Scheduler geprüft |
| Konsistentes Datenbankbackup | bestehender SQLite-Pfad | Block-6-`development-contract` mit realem Custom-Dump lokal und extern in CI geprüft; Produktfähigkeit bleibt `false` | produktive Verdrahtung, Zeitplan sowie Rollen- und Offsite-Nachweis |
| Restore | bestehender SQLite-Pfad | isolierter Real-Restore gegen PostgreSQL 18.4 lokal 1/1 grün; Produktfähigkeit bleibt `false` | vollständiger Vollanwendungs-Restore, gemessenes RTO und Installationsabnahme |
| Integritätsprüfung | SQLite-spezifisch | Bundle-, Manifest-, Artefakt- und Evidence-Prüfungen nicht produktiv implementiert | produktiver providerbezogener Integritätsnachweis |
| Point-in-Time-Recovery | nicht Bestandteil des SQLite-Standards | nicht implementiert und nicht Ziel von Block 6 | eigener PITR-Aufbau und Wiederherstellungstest |
| Recovery Assurance | SQLite-spezifischer Nachweis | signierbarer Belegvertrag v2 getestet; produktive Orchestrierung und Offsite-Phasen offen | vollständiger signierter providerbezogener End-to-End-Nachweis |
| System-Center-Auskunft | SQLite-Status | read-only Monitoradapter getestet, aber nicht in Server oder Oberfläche aktiviert | aktive Methode, Evidence-Alter, Alarmierung und Betriebsabnahme |
| Gepaarte Dokumentablage | bestehender Betriebsweg | verschlüsselter Dokument-Roundtrip lokal real geprüft; produktive Quiesce-Verdrahtung offen | konsistenter Vollanwendungs-Sicherungspunkt mit allen Mutationspfaden |

Eine nicht vorhandene oder nicht geprüfte Fähigkeit wird als nicht verfügbar
behandelt. PostgreSQL allein ist weder ein Beweis für Hochverfügbarkeit noch
für Mehrinstanzfähigkeit oder Point-in-Time-Recovery.

## 8. Backup, Restore und Recovery Assurance

Das bestehende SQLite-Backup darf nicht als universelles Datenbankbackup
bezeichnet werden.

### 8.1 SQLite

Der SQLite-Betrieb behält:

- das bestehende konsistente Datei- beziehungsweise `VACUUM INTO`-Verfahren;
- SQLite-spezifische Integritätsprüfungen;
- die gepaarte Sicherung der verschlüsselten Dokumentablage;
- bestehende Commit-Marker und Recovery-Nachweise.

SQLite-spezifische Betriebsfunktionen dürfen in klar abgegrenzten
Provider- oder Betriebsmodulen verbleiben.

### 8.2 PostgreSQL

PostgreSQL benötigt einen eigenen, vollständig geprüften Betriebspfad für:

- logische Dumps oder physische Sicherungen;
- konsistente Kopplung mit der Dokumentablage;
- Rollen, Secrets und Berechtigungen;
- regelmäßige automatisierte Restore-Tests;
- Monitoring von Alter, Vollständigkeit und Fehlern;
- gegebenenfalls WAL-Archivierung und Point-in-Time-Recovery;
- gegebenenfalls Standby- und Replikationsbetrieb.

System-Center und Recovery Assurance müssen eindeutig anzeigen:

- welcher Provider aktiv ist;
- welche Sicherungsmethode verwendet wurde;
- welchen Daten- und Dokumentstand der Nachweis umfasst;
- welche Prüfungen tatsächlich durchgeführt wurden;
- wann der letzte erfolgreiche Restore-Nachweis erfolgte;
- welche Nachweise fehlen, fehlgeschlagen oder veraltet sind.

Ein erfolgreicher SQLite-Nachweis darf niemals als PostgreSQL-Nachweis
ausgegeben werden und umgekehrt.

Block 6 hat dafür einen klar abgegrenzten, nicht produktiven Entwicklungspfad
für Custom-Dump, isolierten Restore, Bundle v2, Monitoring und
Recovery-Assurance-Belege geschaffen. Der lokale PostgreSQL-18.4-Nachweis ist
grün. Der veröffentlichte Integrationscommit `25fab8e` ist im
[GitHub-Actions-Lauf 30508095599](https://github.com/christianseiwaldat-collab/Grabenplaner/actions/runs/30508095599)
einschließlich PostgreSQL-18.4-Vertragsjob sowie vollständiger Ubuntu- und
Windows-Suite grün. Einzelheiten, RPO-/RTO-Grenzen und die offenen
Installationsgates stehen in
[PostgreSQL-Betrieb und Recovery im nicht produktiven Status](DATENBANK-POSTGRESQL-BETRIEB-UND-RECOVERY.md).

Dieser Stand ist keine Supportfreigabe. Es gibt weiterhin keinen produktiven
Zeitplan, keinen PostgreSQL-System-Center-Pfad, keinen Offsite-Orchestrator und
keine allgemeine RPO-/RTO-Zusage.

## 9. Phasen und getrennte Freigaben

Jede Phase wird separat geplant, geprüft, abgenommen und erst nach
ausdrücklicher Freigabe begonnen. Der Abschluss einer Phase ist keine
automatische Startfreigabe für die nächste.

### Phase 0 – Zielarchitektur festschreiben

Umfang:

- dieses Strategiedokument in das Repository übernehmen;
- Entscheidungen, Grenzen, Gates und Abnahmekriterien verbindlich festhalten.

Nicht enthalten:

- Runtime-Änderungen;
- PostgreSQL-Treiber oder sonstige neue Abhängigkeiten;
- Änderungen an README, Versionslog oder Produktoberfläche;
- Datenbank-, Produktivserver- oder Deploymentänderungen.

### Phase 1 – Vollständiges Kopplungs- und Betriebsinventar

Ergebnisartefakt:
[Datenbank-Kopplungsinventar](DATENBANK-KOPPLUNGSINVENTAR.md)

Umfang:

- alle direkten Treiberimporte und Datenbankzugriffe erfassen;
- SQL-Dialekte, Transaktionen, Migrationen, Trigger und Constraints erfassen;
- Setup-, Import-, Test-, Backup-, Restore-, Assurance- und
  Wartungszugriffe erfassen;
- Eigentümer und Zielschicht jedes Zugriffs bestimmen;
- messbare Ausgangswerte und zulässige Übergangsausnahmen dokumentieren.

Abnahme:

- reproduzierbares Inventar im Repository;
- keine Runtime-Änderung;
- priorisierte, risikoabhängige Umstellungsreihenfolge.

### Phase 2 – Providervertrag, Typen und Vertragstests

Ergebnisartefakt:
[Datenbank-Provider-Vertrag](DATENBANK-PROVIDER-VERTRAG.md)

Umfang:

- Promise-basierten Vertrag definieren;
- transaktionsgebundenen Executor festlegen;
- normalisierte Resultat-, Wert- und Fehlertypen definieren;
- Konfigurationsvalidierung einschließlich `DB_PATH`-Kompatibilität festlegen;
- providerunabhängige Vertragstests und Architekturprüfung erstellen.

Abnahme:

- Vertrag ist ohne rohen Treiberhandle nutzbar;
- unbekannte oder ungültige Providerkonfiguration scheitert geschlossen;
- Transaktions-, Rollback- und Fehlersemantik ist automatisiert geprüft.

### Phase 3 – SQLite-Provider und schrittweise SQLite-Parität

Abschlussartefakt:
[SQLite-Provider und vollständige SQLite-Parität](DATENBANK-SQLITE-PROVIDER.md)

Aktueller Stand am 29.07.2026: Block 3 wurde separat freigegeben und
abgeschlossen. Fachbereiche verwenden treiberfreie Repositories; Schema,
Migrationen und SQLite-spezifische Betriebsfunktionen liegen hinter ausdrücklich
benannten Persistence-Operationen. Das Architektur-Audit weist null rohe
Fachzugriffe und null Schichtverletzungen aus.

Umfang:

- SQLite-Provider implementieren;
- Fachbereiche in kleinen, überprüfbaren Teilblöcken umstellen;
- bestehende Transaktionsgrenzen erhalten oder nachweislich verbessern;
- neue unzulässige Direktkopplungen automatisiert verhindern;
- bestehende SQLite-Dateien und `DB_PATH` unverändert weiter unterstützen.

Abnahme:

- vollständige Funktionsparität;
- bestehende Datenbanken ohne Datenverlust nutzbar;
- bestehende sowie neue Provider- und Regressionstests grün;
- direkte SQLite-Zugriffe nur noch in dokumentierten Provider- und
  Betriebsmodulen.

### Phase 4 – Providerfähiges SQL und providerfähige Migrationen

Abschlussartefakt:
[Datenbank-Dialekte und providerfähige Migrationen](DATENBANK-DIALEKTE-UND-MIGRATIONEN.md)

Aktueller Stand am 02.08.2026: Block 4 wurde separat freigegeben und
abgeschlossen. Sämtliche 1160 Anwendungsstatements besitzen eine eindeutige
SQLite-Bindung und eine deckungsgleiche, nicht ausführbare
PostgreSQL-Plan-Fixture. Die zehn realen Anwendungsmigrationsstufen sind durch
providerneutrale Operations-IDs, SQLite-Bindungen und einen ausdrücklich nur
vertraglichen PostgreSQL-Status abgebildet. Der neue generische Ledger ist
gehärtet, ersetzt aber die teilweise selbst transaktionierende bestehende
SQLite-Startkette noch nicht; diese Aktivierungsgrenze ist ausdrücklich
dokumentiert. Phase 5 wurde anschließend separat gestartet; ihr aktueller
Zwischenstand ist im folgenden Abschnitt ausgewiesen.

Umfang:

- SQL-Eigentum vollständig in die Persistence-Schicht überführen;
- den konservativen SQLite-Ausgangsbestand und die Eigentumsgrenzen künftiger
  Dialektvarianten festlegen, ohne daraus Portabilität abzuleiten;
- fachliche Migrationen von providerspezifischer Syntax trennen;
- Neuaufbau-, Upgrade-, Rollback- und historische Fixture-Tests etablieren.

Abnahme:

- Fachlogik enthält keine Providerverzweigungen oder rohen Treiberzugriffe;
- der SQLite-Pfad ist vollständig ausführbar; der geplante PostgreSQL-Pfad ist
  durch benannte Schnittstellen, Dialekt-Fixtures und Architekturprüfungen
  statisch überprüfbar, aber noch nicht als implementiert ausgewiesen;
- historische SQLite-Datenbestände bleiben vollständig kompatibel.

### Phase 5 – PostgreSQL-Provider im nicht produktiven Status

Zwischenstand am 02.08.2026: Phase 5 ist begonnen und weiterhin in
Bearbeitung. Der abgegrenzte PostgreSQL-Provider einschließlich
Connection-Pool, Transaktionsbindung, Fehlernormalisierung und
Sicherheitsrichtlinien ist für die nicht produktive Entwicklung implementiert.
Reale, isolierte Nonprod-Live-Tests gegen PostgreSQL haben Datentypen,
Compiler-JSON-Bindungen, Constraints, Commit und Rollback, Read-only- und
serialisierbare Transaktionen, parallele Transaktionen,
Deadlock-Normalisierung und Statement-Timeouts in sieben Fällen erfolgreich
geprüft. Ergebnisfelder werden vor der Zuordnung nach Name und Reihenfolge
geprüft; Widersprüche zwischen Statementvertrag, Katalogangabe und
SQL-`RETURNING` scheitern geschlossen.

Dieser Nachweis ist keine Produktiv- oder Supportfreigabe. PostgreSQL ist
weder in der Produkt- noch in der Serverkonfiguration aktiviert; beide bleiben
ausschließlich auf SQLite festgelegt.

Der aktuelle PostgreSQL-Dialektplan wird mit Compiler v2 erzeugt und bleibt
absichtlich nicht ausführbar. Er umfasst alle 1160 Anwendungsstatements: 1046
Einträge sind generierte Syntaxkandidaten (`portable-generated`), 114
benötigen eine ausdrückliche `requires-override`-Implementierung und 0 von 1160
bilden einen ausführbaren Vollanwendungskatalog.

Der neue Katalogvertrag verhindert bei derzeit 0/1160 akzeptierten Live- und
Paritätsnachweisen jeden für die Vollanwendung ausführbaren Katalog. Auch 1160
strukturell vollständige Deklarationen reichen ohne diese 1160
Acceptance-Nachweise nicht für `applicationExecutable: true`.

Davon getrennt sind vier reale Teil-Slices auf SQLite und PostgreSQL
fachlich geprüft: UI-Präferenzen 4/4, Planning Settings 2/2, Organization
Departments 2/2 und System Center `oldestIntervalKeys` 1/1. Zusammen sind das
genau neun live geprüfte Statements. Alle vier tragen den Status
`development-contract`, deklarieren `fullApplicationCatalog: false` und
bleiben auf `applicationExecutable: false` sowie `productActivation: false`
begrenzt.

Der Planning-Settings-Slice prüft JSON-Binding, JSONB-Objektkonstruktion und
atomaren Transaktionsrollback; `key: null` scheitert nun auf beiden Providern
bereits als `PERSISTENCE_STATEMENT_INVALID`. Der Abteilungsslice löst
Boolean-Prädikat, SQLite-`BINARY`- gegenüber PostgreSQL-`C`-Sortierung und
UTC-Timestamp-Text ausdrücklich. Der System-Center-Slice bindet das Limit
typisiert und löst gleiche Zeitpunkte mit einer `C`-Sortierung auf. Alle vier
Slices pinnen Quellvertrags-Fingerprints aus exaktem SQLite-SQL, Operation,
Parametervertrag und geordnetem Ergebnisvertrag. SQL-, Nullability-,
Parameter- oder Ergebnisdrift scheitert geschlossen. Cleanupfehler lassen die
Dual-Provider-Tests fehlschlagen.

Diese 4/4-, 2/2-, 2/2- und 1/1-Nachweise sind weder Vollkatalog noch
Produktaktivierung und verändern den Stand 0/1160 nicht.

Der generische PostgreSQL-Migrationsadapter ist als nicht aktivierter
`development-contract` implementiert und real getestet. Ein
Session-`pg_advisory_lock` wird vor genau einer
`SERIALIZABLE READ WRITE`-Transaktion erworben und erst nach Commit oder
Rollback wieder gelöst. Der transaktionsgebundene
`pg_advisory_xact_lock` wurde nach einem real reproduzierten
Stale-Snapshot-/Ledgerfehler verworfen; es gibt weder eine JavaScript-Queue
noch einen automatischen Retry. Rebuild,
Präfix-Upgrade, No-op, synthetischer Rollback, atomarer Fehlerabbruch,
parallele Runner und Driftprüfung sind live grün.

Frei programmierbare Handler sind nicht Teil des Adapters. Er führt nur
kanonische versionierte SQL-Artefakte aus, berechnet deren Fingerprint selbst
und sperrt Ledgerzugriff, Routinen, Session-/Transaktionssteuerung,
Schemaqualifizierung, temporäre beziehungsweise `UNLOGGED`-Objekte und
`SELECT ... INTO` fail-closed. Die konfigurierte Migrationsrolle muss zugleich
`current_user`, `session_user` und Schemaeigentümerin sein; privilegierte
Rollenflags oder geerbte Rollen sind unzulässig. Eine getrennte temporäre
Loginrolle weist diese Grenze live nach. Diese technische Grundlage aktiviert
weder den PostgreSQL-Produktpfad noch eine reale Anwendungsmigration.

Für die späteren PostgreSQL-Migrationen gilt ein zusätzliches Schema-Gate:
SQLite-`TEXT PRIMARY KEY` ist ohne ausdrückliches `NOT NULL` schwächer als der
entsprechende PostgreSQL-Vertrag. Die PostgreSQL-Nullability muss daher je
Spalte ausdrücklich aus dem Fachvertrag abgeleitet und geprüft werden; eine
mechanische Übernahme der SQLite-DDL ist nicht zulässig.

Der PostgreSQL-Migrationsstand bleibt 0/10; keine Anwendungsmigration ist
implementiert. Datenübernahme, vollständige fachliche Parität und Lasttests
sind weiterhin offen. Die technischen Einzelheiten des Provider-Slices sind
in
[PostgreSQL-Provider im nicht produktiven Entwicklungsstatus](DATENBANK-POSTGRESQL-PROVIDER.md)
dokumentiert.

Der separat freigegebene Block 6 ergänzt Betriebs- und Recovery-Module, ändert
aber keines dieser Phase-5-Gates: Der Vollanwendungsstand bleibt 0/1160 und der
Anwendungsmigrationsstand 0/10. Ein erfolgreicher technischer Backup- und
Restore-Nachweis darf fehlende Anwendungsparität nicht ersetzen.

Vorbedingung für die Implementierungsfreigabe:

- Eigentum, Lebenszyklus, Größen- und Zeitgrenzen des Connection-Pools sind
  festgelegt;
- Transaktionsisolation, Deadlock-/Retry-Regeln und Abbruchverhalten sind
  beschlossen;
- TLS-Anforderungen, Secret-Ablage und Secret-Rotation sind definiert;
- getrennte, minimal berechtigte Datenbankrollen für Migration, Anwendung,
  Backup und Betrieb sind festgelegt.

Umfang:

- PostgreSQL-Provider und Pooling implementieren;
- PostgreSQL-Dialektvarianten und PostgreSQL-Migrationen implementieren;
- Isolation, Deadlocks, Timeouts und Abbrüche prüfen;
- Migrationen und Datenübernahmewerkzeuge implementieren;
- vollständige Vertrags-, Integrations-, Konkurrenz- und Lasttests ausführen.

Abnahme:

- fachliche Parität auf realitätsnahen Testdaten;
- deterministische Migrationen und nachvollziehbarer Datenabgleich;
- keine öffentliche oder produktive Supportbehauptung;
- kein Produktiv-Cutover.

### Phase 6 – Betriebs-, Recovery- und Supportfreigabe

Aktueller Stand am 30.07.2026: Der nicht produktive technische Anteil von
Block 6 ist lokal abgenommen. Der kombinierte PostgreSQL-Lauf für Block 5 und
Block 6 ist mit 121/121 Tests grün; der reale PostgreSQL-18.4-Restore-E2E-Fall
ist 1/1 grün. Der CI-Job ist mit PostgreSQL 18.4 und den Clientwerkzeugen 18
konfiguriert. Der veröffentlichte Integrationscommit `25fab8e` ist im
[GitHub-Actions-Lauf 30508095599](https://github.com/christianseiwaldat-collab/Grabenplaner/actions/runs/30508095599)
in allen vier Jobs grün.

Implementiert sind der providerneutrale Betriebsvertrag, Backup-Bundle v2,
Custom-Dump aus exportiertem Snapshot, Dokumentbindung, isolierter Restore,
Evidence-Abgleich, ein signierbarer Recovery-Assurance-Vertrag und ein
read-only Monitoradapter. Alle Pfade bleiben `development-contract`,
`productActivation: false` und außerhalb von `server.js`. Das
Abschlussartefakt ist
[PostgreSQL-Betrieb und Recovery im nicht produktiven Status](DATENBANK-POSTGRESQL-BETRIEB-UND-RECOVERY.md).

Umfang:

- PostgreSQL-Backup und automatisierten Restore-Nachweis implementieren;
- Recovery Assurance und System-Center providerbezogen umsetzen;
- Secret-, Rollen-, Monitoring- und Wartungskonzept abnehmen;
- gegebenenfalls Mehrinstanz-, PITR- oder HA-Anforderungen separat prüfen;
- installationsbezogenen Cutover- und Rückkehrplan erstellen.

Abnahme:

- [x] ein realer, isolierter Betriebsweg-Restore ist lokal reproduzierbar
  nachgewiesen;
- [x] Provider, Methode, Datenbankartefakt und verschlüsselte
  Dokumentkomponente sind technisch aneinander gebunden;
- [x] der veröffentlichte Integrationscommit `25fab8e` besitzt mit Run
  `30508095599` einen grünen externen CI-E2E-Lauf;
- [ ] die Phase-5-Gates 1160/1160 und 10/10 sind erfüllt;
- [ ] ein Vollanwendungs-Restore auf realitätsnaher Datenmenge ist
  nachgewiesen;
- [ ] RPO, RTO, Rollen, Secrets, Offsite, Retention, Betriebsverantwortung,
  Alarmierung und Wartung sind je Installation abgenommen;
- [ ] PostgreSQL-Support und ein konkreter Produktiv-Cutover sind jeweils
  ausdrücklich freigegeben.

### Nachgelagerter Block 7 – freiwillige Migration einer konkreten Installation

Die Startprüfung vom 30.07.2026 hat das Ergebnis **NO-GO**. Es ist noch keine
konkrete Zielinstallation ausgewählt oder installationsbezogen freigegeben.
PostgreSQL-Vollkatalog und Anwendungsmigrationen stehen weiterhin bei 0/1160
beziehungsweise 0/10; `productActivation` bleibt `false`. Deshalb wurde keine
Installation, kein VPS und keine Produktkonfiguration verändert.

Block 7 darf erst in einen Cutover übergehen, wenn alle offenen Abnahmepunkte
aus Phase 6 erfüllt sind und für genau eine benannte Installation
Betriebsmodell, Verantwortliche, Wartungsfenster, RPO/RTO, Rollen, Secrets,
TLS, Backup, Offsite, Monitoring, Rückkehrplan und Erfolgskriterien ausdrücklich
freigegeben wurden. Der Start der Prüfung allein ist keine
PostgreSQL-Supportfreigabe.

## 10. Übergreifende Abnahmekriterien

- [x] Ausgangslage und direkte Datenbankkopplungen sind vollständig inventarisiert.
- [x] Der asynchrone Providervertrag ist dokumentiert und vertraglich getestet.
- [x] Transaktionen verwenden ausschließlich ihren gebundenen Executor.
- [x] Fachlogik erhält keine rohen Treiberhandles.
- [x] Resultate, Werte und Fehler sind providerneutral normalisiert.
- [x] `DB_PATH` bleibt für bestehende SQLite-Installationen kompatibel.
- [x] Unbekannte oder ungültige Providerkonfiguration scheitert geschlossen.
- [x] Alle Runtime-Slices einschließlich UI-Präferenzen nutzen Repository- oder
      benannte SQLite-Operationspfade.
- [x] SQLite läuft ohne funktionale Verschlechterung vollständig über den
  Providerpfad.
- [x] Bestehende SQLite-Dateien bleiben ohne Datenverlust nutzbar.
- [x] SQL-Eigentum und Migrationen sind providerfähig getrennt.
- [x] Die Capability-Matrix bildet den nicht produktiven Entwicklungsstand
  technisch wahrheitsgemäß ab; alle PostgreSQL-Produktfähigkeiten bleiben
  `false`.
- [x] Backup, Restore und Recovery Assurance sind im
  `development-contract` providerspezifisch getrennt.
- [x] Der nicht produktive Integrationscommit besitzt einen grünen externen
  CI-E2E-Lauf auf PostgreSQL 18.4, Ubuntu, Windows und der Node-Mindestversion.
- [ ] Produktzeitplan, Offsite-Orchestrierung und System-Center-Integration
  sind abgeschlossen.
- [ ] PostgreSQL wird erst nach bestandenen Betriebs- und Recovery-Gates als
  unterstützt bezeichnet.
- [ ] Jede Implementierungsphase besitzt eine eigene Freigabe und Abnahme.

## 11. Sicherheits- und Qualitätsanforderungen

- Keine Migration echter Produktivdaten ohne separaten Cutover- und
  Rückkehrplan.
- Keine PostgreSQL-Supportbehauptung in Oberfläche, README, Release Notes oder
  öffentlicher Dokumentation vor vollständiger Abnahme.
- Keine stillschweigende Abschwächung von Sicherheits-, Datenschutz-,
  Revisions- oder Recovery-Eigenschaften.
- Keine Secrets in Repository, Logs, Fehlerantworten oder
  System-Center-Ausgaben.
- Providerabhängige Abweichungen werden dokumentiert und begründet.
- Mehrere App-Instanzen werden erst nach Prüfung von Sitzungen, Jobs, Sperren,
  geplanten Aufgaben, Dateizugriffen und konkurrierenden Schreibvorgängen
  freigegeben.
- PostgreSQL ist kein automatischer Beweis für Hochverfügbarkeit. Ein einzelner
  PostgreSQL-Server bleibt ein einzelner Ausfallpunkt.

## 12. Ausdrücklich nicht gleichzeitig umzusetzen

Ohne eigene Entscheidung und Freigabe werden mit dem Providerumbau nicht
gleichzeitig umgesetzt:

- Einführung eines ORM;
- komplette Neuentwicklung der Fachlogik;
- Abschaffung von SQLite;
- automatischer oder erzwungener PostgreSQL-Cutover;
- Austausch des gesamten Backup-Systems;
- Aktivierung mehrerer App-Instanzen;
- Hochverfügbarkeits- oder Multi-Region-Versprechen;
- Auswahl eines konkreten Managed-PostgreSQL-Anbieters;
- Portable-, USB- oder nicht verwaltete lokale Auslieferungen.

## 13. Nicht Bestandteil dieser Architekturentscheidung

- eine konkrete Produktivmigration;
- PostgreSQL-Hochverfügbarkeitscluster;
- horizontale Skalierung;
- Multi-Region-Betrieb;
- ein vollständiges PITR-, Standby- oder Failover-Konzept;
- die Auswahl oder Beschaffung eines Datenbankanbieters;
- die Veröffentlichung eines neuen Produkt- oder Server-Releases.

Diese Themen werden nur bei tatsächlichem betrieblichem Bedarf und in jeweils
eigenen, ausdrücklich freigegebenen Blöcken bearbeitet.
