# Datenbank-Provider-Strategie

**Status:** Verbindliche Zielarchitektur, noch nicht implementiert

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
| Konsistentes Datenbankbackup | bestehender SQLite-Pfad | nicht durch SQLite-Nachweis abgedeckt | eigener geprüfter PostgreSQL-Backup-Pfad |
| Restore | bestehender SQLite-Pfad | nicht freigegeben | automatisierter Restore-Test |
| Integritätsprüfung | SQLite-spezifisch | separat zu definieren | providerbezogener Integritätsnachweis |
| Point-in-Time-Recovery | nicht Bestandteil des SQLite-Standards | optionales PostgreSQL-Ziel | eigener PITR-Aufbau und Wiederherstellungstest |
| Recovery Assurance | SQLite-spezifischer Nachweis | nicht freigegeben | signierter providerbezogener End-to-End-Nachweis |
| System-Center-Auskunft | SQLite-Status | erst nach Implementierung | aktive Methode und Nachweisalter korrekt ausgewiesen |
| Gepaarte Dokumentablage | bestehender Betriebsweg | separat nachzuweisen | konsistenter Datenbank-/Dokument-Sicherungspunkt |

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

Umfang:

- SQL-Eigentum vollständig in die Persistence-Schicht überführen;
- gemeinsamen SQL-Teilumfang und die Eigentumsgrenzen künftiger
  Dialektvarianten festlegen;
- fachliche Migrationen von providerspezifischer Syntax trennen;
- Neuaufbau-, Upgrade-, Rollback- und historische Fixture-Tests etablieren.

Abnahme:

- Fachlogik enthält keine Providerverzweigungen oder rohen Treiberzugriffe;
- der SQLite-Pfad ist vollständig ausführbar; der geplante PostgreSQL-Pfad ist
  durch benannte Schnittstellen, Dialekt-Fixtures und Architekturprüfungen
  statisch überprüfbar, aber noch nicht als implementiert ausgewiesen;
- historische SQLite-Datenbestände bleiben vollständig kompatibel.

### Phase 5 – PostgreSQL-Provider im nicht produktiven Status

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

Umfang:

- PostgreSQL-Backup und automatisierten Restore-Nachweis implementieren;
- Recovery Assurance und System-Center providerbezogen umsetzen;
- Secret-, Rollen-, Monitoring- und Wartungskonzept abnehmen;
- gegebenenfalls Mehrinstanz-, PITR- oder HA-Anforderungen separat prüfen;
- installationsbezogenen Cutover- und Rückkehrplan erstellen.

Abnahme:

- alle zutreffenden Capability-Gates sind erfüllt;
- mindestens ein vollständiger, reproduzierbarer End-to-End-Restore ist
  nachgewiesen;
- Betriebsverantwortung, Alarmierung und Wartung sind geklärt;
- PostgreSQL-Support und ein konkreter Produktiv-Cutover werden jeweils
  ausdrücklich freigegeben.

## 10. Übergreifende Abnahmekriterien

- [ ] Ausgangslage und direkte Datenbankkopplungen sind vollständig inventarisiert.
- [ ] Der asynchrone Providervertrag ist dokumentiert und vertraglich getestet.
- [ ] Transaktionen verwenden ausschließlich ihren gebundenen Executor.
- [ ] Fachlogik erhält keine rohen Treiberhandles.
- [ ] Resultate, Werte und Fehler sind providerneutral normalisiert.
- [ ] `DB_PATH` bleibt für bestehende SQLite-Installationen kompatibel.
- [ ] Unbekannte oder ungültige Providerkonfiguration scheitert geschlossen.
- [ ] SQLite läuft ohne funktionale Verschlechterung vollständig über den
  Providerpfad.
- [ ] Bestehende SQLite-Dateien bleiben ohne Datenverlust nutzbar.
- [ ] SQL-Eigentum und Migrationen sind providerfähig getrennt.
- [ ] Die Capability-Matrix wird technisch und betrieblich wahrheitsgemäß
  abgebildet.
- [ ] Backup, Restore und Recovery Assurance sind providerspezifisch getrennt.
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
