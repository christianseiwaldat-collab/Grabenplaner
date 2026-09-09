# Datenbank-Dialekte und providerfähige Migrationen

Katalogzahlen fortgeschrieben am 07.09.2026 für den aktuellen lokalen Codebestand einschließlich Belegsuche. Das ist keine neue Produktivfreigabe; datierte Abnahmen sind über ihre jeweiligen Nachweisartefakte belegt.

**Status:** Block 4/7 abgeschlossen  
**Stand:** 13.08.2026
**Produktiver Datenbankpfad:** ausschließlich SQLite

## 1. Ergebnis und Grenze

Block 4 macht SQL-Eigentum, Dialektabweichungen und Migrationsschritte
maschinenprüfbar. Der bestehende SQLite-Pfad bleibt vollständig ausführbar und
kompatibel. PostgreSQL wird ausschließlich durch deckungsgleiche, nicht
ausführbare Vertrags-Fixtures vorbereitet.

Nicht Bestandteil dieses Blocks sind:

- ein PostgreSQL-Treiber oder Connection-Pool;
- ausführbares PostgreSQL-SQL;
- ein produktiver PostgreSQL-Provider;
- Datenübernahme, Cutover oder Änderung einer realen Datenbank;
- Änderungen an Backup, Restore, Recovery oder Serverbetrieb;
- Abschaffung oder Herabstufung des SQLite-Standards.

## 2. SQL-Eigentum und Dialektvertrag

Die Verantwortungsgrenzen sind verbindlich:

- `lib/persistence/statements/` enthält nur Statement-ID, Operation sowie
  Parameter- und Ergebnisvertrag;
- `lib/persistence/repositories/` enthält ausschließlich Fachzugriffe über den
  providerneutralen Executor;
- `lib/persistence/sqlite/*-catalog.js` besitzt das ausführbare SQLite-SQL;
- [`lib/persistence/dialects/contract.js`](../lib/persistence/dialects/contract.js)
  definiert die unveränderliche Dialekt- und Eigentumsstruktur;
- [`lib/persistence/dialects/application-manifest.js`](../lib/persistence/dialects/application-manifest.js)
  bindet jedes Anwendungsstatement genau einmal an sein SQLite-SQL und erzeugt
  die deckungsgleiche PostgreSQL-Plan-Fixture.

Der Stand umfasst 1348 Statementverträge, einschließlich 97 zuvor in den
Anwendungskatalog aufgenommenen Importverträgen und 46 kompakten Kassenverträgen. Die
Klassifikation beschreibt ausschließlich die bekannte SQLite-Syntax und ist
kein Nachweis, dass unverändertes SQL auf einem anderen Provider ausführbar
wäre:

| Klassifikation | Anzahl | Bedeutung |
| --- | ---: | --- |
| geprüfte SQLite-Baseline | 37 | keine vom aktuellen, konservativen Scanner erkannte SQLite-Besonderheit; kein Portabilitätsversprechen |
| benannte SQLite-Dialektvariante | 1311 | mindestens ein explizites SQLite-Merkmal |
| ungebundene oder doppelte Statements | 0 | Block-4-Gate |

Als Dialektmerkmale werden unter anderem Upserts, `INSERT OR IGNORE`,
`COLLATE NOCASE`, SQLite-Datums- und JSON-Funktionen, `julianday()`,
`RETURNING`, `GLOB`, `AUTOINCREMENT`, SQLite-Katalogzugriffe und
`RAISE(ABORT)` geführt. 1238 der 1311 Varianten verwenden die in der
SQLite-Anbindung benannten Dollar-Parameter wie `$employeeNumber`; sie sind ein
explizites Dialektmerkmal und werden deshalb nie als SQLite-Baseline
ausgewiesen. Neue Merkmale müssen vor ihrer Aufnahme eindeutig klassifiziert
werden.

Die PostgreSQL-Fixture besitzt für alle 1348 Statement-IDs denselben Eigentümer
und dieselbe SQLite-Ausgangsklassifikation. Das ist lediglich eine
deckungsgleiche Arbeitsliste, keine Aussage über PostgreSQL-Kompatibilität. Sie
enthält absichtlich kein SQL, keinen ausführbaren Handler und keinen Treiber.
Ihr Status ist ausschließlich `contract-only`.

## 3. Providerneutraler Migrationsvertrag

[`lib/persistence/migrations/contract.js`](../lib/persistence/migrations/contract.js)
und
[`lib/persistence/migrations/runner.js`](../lib/persistence/migrations/runner.js)
trennen stabile fachliche Operations-IDs von der Ausführung:

- eindeutige, total geordnete Migrations-IDs;
- unveränderliche Manifeste mit SHA-256-Fingerprint;
- separate SHA-256-Fingerprints der gebundenen SQLite-Implementierungen;
- Verlauf muss ein unveränderter Präfix des Manifests sein;
- deterministische Pläne für Neuaufbau, Upgrade, No-op und Rollback;
- fehlende Rückwärtsoperationen scheitern ausdrücklich und geschlossen;
- ein Marker wird erst nach erfolgreicher Operation persistiert.

Der SQLite-Adapter unter
[`lib/persistence/sqlite/migrations/adapter.js`](../lib/persistence/sqlite/migrations/adapter.js)
besitzt den SQLite-spezifischen Ledger und führt jeden Schritt einschließlich
Verlaufsänderung innerhalb von `BEGIN IMMEDIATE` atomar aus. Der Ledger
persistiert neben dem Manifest-Fingerprint auch ausdrücklich gelieferte,
primitive SHA-256-Fingerprints der konkreten Operationsbindungen; implizit aus
einer Closure abgeleitete Fingerprints werden nicht akzeptiert. Eine
nachträglich geänderte Bindung macht den Verlauf ungültig und scheitert
geschlossen. Handler erhalten nur eine kurzlebige Datenbank-Capability.
Asynchrone Nachläufer, nicht registrierte Rohoperationen sowie eigene `BEGIN`-,
`COMMIT`-, `ROLLBACK`-, `SAVEPOINT`- oder `END`-Befehle werden abgelehnt.

## 4. Reale Anwendungsmigrationskette

Das providerneutrale
[`Anwendungsmanifest`](../lib/persistence/migrations/application-manifest.js)
beschreibt zehn bestehende Startstufen:

1. kanonisches Anwendungsschema;
2. startkritische Kompatibilitätsmigrationen;
3. geschützte Personal- und Urlaubshistorien;
4. historische Strukturkompatibilität;
5. Anwendungsgrundwerte;
6. Feature-Kompatibilität;
7. Organisations- und Kostenstellenschema;
8. optionales synthetisches Demoprofil;
9. System-Center-Schema.
10. Schema für Filialbestellungen.

Die
[`SQLite-Bindungen`](../lib/persistence/sqlite/migrations/application-bindings.js)
stellen für jede Operations-ID einen direkten synchronen Handler sowie einen
reproduzierbaren Implementierungs-Fingerprint bereit. Dieser bindet den Wrapper,
die direkt zugeordnete Operationsdatei und deren vollständigen lokalen
Abhängigkeitsabschluss im Repository. Alle zehn Handler werden in
Manifestreihenfolge gegen einen leeren, rein synthetischen SQLite-Stand
ausgeführt. Die deckungsgleiche PostgreSQL-Migrations-Fixture ist
`contract-only`, nicht ausführbar und enthält weder Modulpfad noch SQL.

Der neue generische Ledger wird in Block 4 nicht still anstelle des bestehenden
Produktivledgers aktiviert. Die aktuelle SQLite-Startkette bleibt unverändert;
das Manifest bildet ihre Eigentums- und Providergrenzen für die spätere
kontrollierte Umstellung ab. Die bestehenden Startoperationen verwalten
teilweise eigene Transaktionen. Deshalb ist die neue Bindung ausdrücklich als
`mapped-not-ledger-activated` und `genericAdapterCompatible: false`
gekennzeichnet. Eine spätere Aktivierung benötigt zuerst eine eigene
Transaktionsnormalisierung und einen vollständigen Upgrade-Nachweis; Block 4
behauptet diese Aktivierung nicht.

## 5. Abnahme

Die Block-4-Tests prüfen:

- vollständige und eindeutige Bindung aller 1348 Statements;
- strikte Trennung zwischen konservativer SQLite-Baseline und erkannten
  SQLite-Dialektvarianten;
- vollständige, nicht ausführbare PostgreSQL-Statement-Fixture;
- vollständige SQLite- und PostgreSQL-Planabdeckung aller zehn realen
  Migrationsoperationen;
- Neuaufbau, Upgrade, No-op und Rollback;
- verlustfreie synthetische historische SQLite-Fixture;
- atomaren Abbruch bei kontrolliert fehlschlagendem DDL-Schritt;
- gesperrte Transaktionssteuerung und gesperrte Async-Nachläufer;
- Manifest- und Implementierungs-Fingerprint-Drift, lückenhafte Historie und
  nicht reversible Ziele;
- synchrone Aufrufkonvention aller zehn realen SQLite-Bindungen;
- unveränderte Phase-3-Gates und weiterhin fehlende PostgreSQL-Abhängigkeiten.

Sämtliche Fixtures sind synthetisch und enthalten keine Produktiv- oder
Personendaten. Bestehende historische SQLite-Regressionstests bleiben
verbindlicher Bestandteil der Gesamtsuite.

## 6. Nicht erweiterte Freigabe

Block 4 ist kein Nachweis einer PostgreSQL-Implementierung und keine
Supportfreigabe. Die separate Startentscheidung für Phase 5 erweitert weder
die Produktfreigabe noch den produktiven Datenbankpfad. Jede Datenübernahme,
Supportfreigabe und produktive Aktivierung benötigt weiterhin eine eigene
ausdrückliche Entscheidung und Abnahme.

## 7. Phase-5-Zwischenstand

Phase 5 ist am 29.07.2026 begonnen und weiterhin in Bearbeitung. Der
abgegrenzte PostgreSQL-Provider einschließlich Connection-Pool,
Transaktionsbindung, Fehlernormalisierung und Sicherheitsrichtlinien ist für
die nicht produktive Entwicklung implementiert. Reale, isolierte
Nonprod-Live-Tests gegen PostgreSQL wurden erfolgreich ausgeführt. PostgreSQL
bleibt dennoch in Produkt- und Serverkonfiguration deaktiviert; der
produktive Datenbankpfad ist weiterhin ausschließlich SQLite.

Der ergänzte PostgreSQL-Dialektplan ist nicht ausführbar und umfasst alle 1348
Anwendungsstatements:

- Compiler v2 erzeugt 1233 Syntaxkandidaten (`portable-generated`);
- 115 Einträge bleiben `requires-override`;
- 0 von 1348 bilden einen ausführbaren Vollanwendungskatalog.

Die generierten Einträge bleiben Kandidaten mit nachvollziehbarer Provenienz,
Parameterbindung und SQL-Fingerprint; sie sind nicht pauschal live geprüft.
Der Katalogvertrag fordert für einen für die Vollanwendung ausführbaren
Katalog 1348 akzeptierte Live- und Paritätsnachweise. Der aktuelle Stand ist
0/1348; deshalb bleiben selbst 1348 strukturell vollständige Deklarationen ohne
diese Receipts geschlossen und können nicht `applicationExecutable: true`
werden.

Der Provider validiert außerdem die von `pg` gelieferten Ergebnisfeldnamen und
deren Reihenfolge exakt gegen den Statementvertrag. Widersprüche zwischen
Statementspalten, Katalogangabe und SQL-`RETURNING` scheitern geschlossen.

Separat vom nicht ausführbaren Gesamtplan wurden vier eng begrenzte Teil-Slices
mit synthetischen Daten auf SQLite und einem realen PostgreSQL-Server fachlich
deckungsgleich geprüft:

- UI-Präferenzen 4/4;
- Planning Settings 2/2 einschließlich JSON-Binding,
  JSONB-Objektkonstruktion, Transaktionsrollback und providerneutralem
  `PERSISTENCE_STATEMENT_INVALID` für `key: null`;
- Organization Departments 2/2 einschließlich Boolean-Prädikat,
  SQLite-`BINARY`-/PostgreSQL-`C`-Sortierung und UTC-Timestamp-Text;
- System Center `oldestIntervalKeys` 1/1 einschließlich typisiertem `LIMIT`
  und `C`-Tie-Sortierung.

Die vier Slices umfassen zusammen genau neun fachlich live geprüfte
Statements. Alle vier tragen `development-contract`, deklarieren
`fullApplicationCatalog: false` und bleiben
`applicationExecutable: false` sowie `productActivation: false`. Diese
Teilnachweise verändern den Vollanwendungsstand 0/1348 nicht und sind keine
Produkt- oder Supportfreigabe. Ihre Quellvertrags-Fingerprints binden den
kanonischen SQLite-SQL-Text an ID, Operation, Parameterarten,
Nullability/Optionalität sowie Ergebnisarten und -reihenfolge. SQL- oder
Statementvertragsdrift scheitert vor der Slice-Ausführung geschlossen.
Cleanupfehler werden von den Dual-Provider-Tests nicht verschluckt.

Für die PostgreSQL-Migrationsbindung gilt zusätzlich ein Schema-Gate:
SQLite-`TEXT PRIMARY KEY` kann ohne ausdrückliches `NOT NULL` Nullwerte
zulassen und ist damit schwächer als PostgreSQL. Die Nullability darf deshalb
nicht mechanisch aus der SQLite-DDL übernommen werden, sondern muss je Spalte
aus dem Fachvertrag abgeleitet und geprüft werden.

Der generische PostgreSQL-Migrationsadapter ist als `development-contract`
implementiert und real geprüft, aber nicht mit den neun
Anwendungsmigrationen verbunden. Er erwirbt auf einer Session
`pg_advisory_lock` vor genau einer
`SERIALIZABLE READ WRITE`-Transaktion, führt Schema-, Ledger- und
Migrationsarbeit innerhalb dieser einen Transaktion aus und löst den Lock erst
nach Commit oder Rollback. Der transaktionsgebundene
`pg_advisory_xact_lock` wurde nach einem real reproduzierten
Stale-Snapshot-/Ledgerfehler verworfen. Es gibt keine JavaScript-Queue und
keinen automatischen Retry.

Rebuild, Präfix-Upgrade, No-op, ein synthetischer Rollback, ein atomarer
Fehlerabbruch, parallele Runner sowie Implementierungs-, Manifest- und
Historiendrift sind gegen PostgreSQL grün. Operationen sind ausschließlich
kanonische, versionierte SQL-Artefakte; der Adapter berechnet deren
Fingerprint und führt sie selbst aus. Seine positive SQL-Grenze sperrt unter
anderem Routinen, Ledgerzugriff, Schemaqualifizierung, temporäre oder
`UNLOGGED`-Objekte und `SELECT ... INTO`.

Der Adapter verlangt außerdem eine ausdrücklich konfigurierte
Least-Privilege-Loginrolle. `current_user`, `session_user` und Schemaeigentümer
müssen dieser Rolle entsprechen; Superuser-, Create-Role-, Create-DB-,
Bypass-RLS- und Replikationsrechte sowie Rollenmitgliedschaften sind
unzulässig. Eine getrennte temporäre Liverolle weist diese Grenze nach. Daraus
folgt weder eine Produktaktivierung noch eine Anwendungsmigrationsfreigabe.

Der isolierte PostgreSQL-Live-Harness umfasst sieben reale Fälle:
Treibertypen und `RETURNING`, Compiler-JSON-Bindungen, Constraint-SQLSTATEs,
Rollback/Read-only/Serializable, parallele Transaktionen, einen echten
`40P01`-Deadlock und einen echten `57014`-Statement-Timeout.

Der PostgreSQL-Anwendungsmigrationsstand bleibt 0/10; keine der zehn
Anwendungsmigrationen ist implementiert.
Datenübernahme, vollständige fachliche Parität und Lasttests bleiben offen.
Der technische Provider-Zwischenstand ist in
[PostgreSQL-Provider im nicht produktiven Entwicklungsstatus](DATENBANK-POSTGRESQL-PROVIDER.md)
dokumentiert.

## Additive Personalmodul-Stufe R1

Die SQLite-Stufe `v0.89-personnel-lifecycle-scoped-rights` ergänzt die
fachrechtgebundene PL+-Freigabehülle `portal_permission_scope_grants`. Im
ursprünglichen R1-Stand bindet jeder Eintrag genau eines der Fachrechte
`personnel:candidates:read` oder `personnel:applications:write` an Mitarbeiter,
Standort und optional Abteilung sowie an einen nichtleeren Genehmiger. Der
zusammengesetzte Fremdschlüssel auf `portal_permission_grants` widerruft die
Bereichshülle gemeinsam mit dem Fachrecht; der Standort ist ebenfalls per
Fremdschlüssel gebunden.

Die additive M4-Migration erweitert denselben Scope-Träger um die vier
Workflow-Rechte `personnel:workflows:read`,
`personnel:workflows:draft:write`, `personnel:workflows:publish` und
`personnel:workflows:local:supplement`. Bewerbungs- und Workflow-Rechte bleiben
getrennte Fachverträge.

Die gestapelte M7-Migration `v0.90-personnel-profile-scoped-rights` erweitert
denselben Träger ausschließlich um `personnel:profiles:read` und
`personnel:profiles:master:read`. Dokument- und Delegationsrecht erhalten keine
Scope-Zeilen. Bewerbungs-, Workflow- und Profilrechte bleiben getrennte
Fachverträge; die acht bestehenden Schutztrigger bleiben unverändert.

Kanonische Trigger prüfen Abteilung und Standort sowie einen deckenden
allgemeinen `portal_access_scopes`-Eintrag. Wird dieser allgemeine Bereich
verkleinert oder entfernt, werden nicht länger gedeckte Fachfreigaben
fail-closed entfernt. Abweichende nichtleere R1-Strukturen oder semantisch
widersprüchliche Scope-Zeilen werden nach der verpflichtenden
Pre-Migrationssicherung nicht automatisch umgebaut.

M2-/M3-Datenbanken ohne R1 bleiben read-only importkompatibel und werden beim
regulären SQLite-Start additiv migriert. Die exakten historischen R1- und
M4-Tabellendefinitionen sowie das kanonische M7-Schema werden bei Read-only-
Import und Maintenance akzeptiert. Beim aktiven Start werden R1-/M4-Zeilen erst
nach dem vorhandenen Pre-Migration-Sicherungspunkt verlustfrei in das erweiterte
Schema übernommen; partielle Tabellen, Trigger oder widersprüchliche Zeilen
scheitern geschlossen. Die fünf ergänzten, typisierten Statements sind
im 1015er Providerplan enthalten; sie ändern weder den PostgreSQL-Stand 0/1015
noch die deaktivierte PostgreSQL-Produktfreigabe.

Die bestehende Mitarbeitertabelle erhält zusätzlich zwei kanonische
Identitätsschutztrigger. Sie verbieten `personnel_number = local`
case-insensitiv und nach Entfernung umgebenden ASCII-Leerraums einschließlich
TAB, CR und LF bei INSERT und UPDATE. Nach der Schemaanlage prüfen SQLite-Start
und read-only Importinspektion auch Bestandszeilen; ein Konflikt stoppt mit
`EMPLOYEE_PRINCIPAL_RESERVED` und wird weder automatisch umbenannt noch
gelöscht. Diese Härtung ist keine neue fachliche Anwendungsmigrationsstufe und
ändert den PostgreSQL-Anwendungsmigrationsstand 0/10 nicht.

Die additive M4-Publikationsschicht ergänzt drei weitere typisierte Statements
zum Lesen, Veröffentlichen und Archivieren unveränderbarer Workflow-Versionen.
Sie erweitert die R1-Scope-Tabelle verlustfrei um
`personnel:workflows:read`, `personnel:workflows:draft:write`,
`personnel:workflows:publish` und `personnel:workflows:local:supplement`;
die beiden Bewerbungsrechte und ihre vorhandenen Genehmigungszeilen bleiben
unverändert erhalten.
Der Compiler klassifiziert alle drei als `portable-generated`; sie erhöhten den
damaligen M4-Vollanwendungsplan auf 928 Statements und 826 Syntaxkandidaten.
Am M4-Abschluss blieb der PostgreSQL-Stand ohne Live- und Paritätsreceipts
0/928; eine
PostgreSQL-Anwendungsmigration wird dadurch nicht implementiert (weiterhin 0/10).

Die additive M5-Instanzschicht ergänzt darauf aufbauend elf typisierte
Statements für Publikationslookup, Subjektprüfung, idempotente Run-Bindung,
explizite Schrittzuweisung sowie die datensparsame Instanz- und
Aktivschritt-Liste. Der Compiler klassifiziert zehn davon als
`portable-generated`; ein Eintrag benötigt weiterhin einen ausdrücklichen
`requires-override`. Damit umfasste der damalige geschlossene
Vollanwendungsplan 939 Statements, 837 Syntaxkandidaten und 102 Overrides.
Ohne Live- und Paritätsreceipts blieb der PostgreSQL-Stand 0/939; die
PostgreSQL-Anwendungsmigrationen blieben unverändert bei 0/10.

Die additive M6-Dokument- und Profilpersistenz ergänzt weitere elf typisierte
Statements. Der Compiler klassifiziert alle elf als `portable-generated`.
Damit umfasste der damalige geschlossene Vollanwendungsplan 950 Statements,
848 Syntaxkandidaten und weiterhin 102 Overrides. Ohne akzeptierte Live- und
Paritätsreceipts blieb der PostgreSQL-Stand 0/950; die
PostgreSQL-Anwendungsmigrationen blieben unverändert bei 0/10.

Die additive O1–O4-Onboarding-Fallausführung ergänzt darauf aufbauend 21
weitere typisierte Statements. Der Compiler klassifiziert 19 davon als
`portable-generated`; zwei Einträge benötigen einen ausdrücklichen
`requires-override`. Damit umfasste der damalige geschlossene
Vollanwendungsplan 971 Statements, 867 Syntaxkandidaten und 104 Overrides.
Ohne akzeptierte Live- und Paritätsreceipts blieb der PostgreSQL-Stand 0/971;
die PostgreSQL-Anwendungsmigrationen blieben unverändert bei 0/10.

Die additive O5-Offboarding-Fallausführung ergänzt darauf aufbauend 42 weitere
typisierte Statements. Der Compiler klassifiziert 40 davon als
`portable-generated`; zwei Einträge benötigen einen ausdrücklichen
`requires-override`. Damit umfasste der damalige geschlossene
Vollanwendungsplan 1015 Statements, 909 Syntaxkandidaten und 106 Overrides.
Ohne akzeptierte Live- und Paritätsreceipts blieb der PostgreSQL-Stand
0/1015; die PostgreSQL-Anwendungsmigrationen blieben unverändert bei 0/10.

Die danach ergänzten, weiterhin additiven Fachslices erhöhen den aktuellen
geschlossenen Vollanwendungsplan auf 1348 Statements. Compiler v2 klassifiziert
1233 davon als `portable-generated`; 115 benötigen `requires-override`. Ohne
akzeptierte Live- und Paritätsreceipts bleibt der PostgreSQL-Stand 0/1348; die
PostgreSQL-Anwendungsmigrationen bleiben unverändert bei 0/10. Dies ist keine
Produkt- oder PostgreSQL-Freigabe.

Die wiederverwendbare verschlüsselte Import-Prüfablage trägt acht dieser
Statementverträge bei. Drei additive Tabellen speichern unveränderliche
Payloadblöcke sowie typisierte Zeilen- und Änderungsreferenzen. Fremdschlüssel
verhindern verwaiste Referenzen; eine eindeutige Schlüssel-/Nonce-Kombination
verhindert deren Wiederverwendung. Bestehende Inline-Datensätze werden nicht
umgeschrieben und Blöcke erhalten keine Update-, Delete- oder GC-Operation.
SQLite-spezifische Unveränderlichkeitstrigger bleiben vom portablen
Tabellenschema getrennt. Die acht SQL-Varianten sind `portable-generated`;
dies ersetzt keinen PostgreSQL-Live-, Migrations- oder Paritätsnachweis.

Der lokale Stand vom 9. September 2026 ergänzt vier Statements für
Rollenstandardrechte, vier für die nachgeführte Artikelsuche und zwei für
Kassenbestandsnachweise. Die aktuellen Zahlen oben berücksichtigen diese zehn
Ergänzungen. Der Produktivbetrieb bleibt SQLite; der PostgreSQL-Vollkatalog
ist weiterhin nicht freigegeben. Die Trade-/Kassenoptimierung ist im
[Umsetzungsbericht zu Block 1–3](TRADE-KASSA-OPTIMIERUNG-BLOECKE-1-3-2026-09-09.md)
beschrieben.
