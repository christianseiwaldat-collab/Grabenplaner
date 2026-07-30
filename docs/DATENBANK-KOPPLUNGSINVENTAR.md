# Datenbank-Kopplungsinventar

**Status:** Block 1/7 abgeschlossen<br>
**Inventarstand:** 29.07.2026<br>
**Ausgangscommit:** `92b023ce0b3fe545aa5253ae0903af8822388afc`<br>
**Produktstand:** Grabenplaner v0.87.0-beta, SQLite

## 1. Zweck und Blockgrenze

Dieses Inventar ist das Ergebnis von Phase 1 der
[Datenbank-Provider-Strategie](DATENBANK-PROVIDER-STRATEGIE.md). Es erfasst
direkte und indirekte SQLite-Kopplungen, SQL-Eigentum, Migrationen,
Transaktionen, Tests sowie Betriebsfunktionen und ordnet ihnen Zielschicht,
Risiko und Übergangsausnahme zu.

Block 1 verändert keine Runtime, Datenbank, Abhängigkeit, Konfiguration,
Bereitstellung oder Produktangabe. Insbesondere wurden noch nicht eingeführt:

- kein `PersistenceProvider` oder `AppDatabaseProvider`;
- kein `DB_PROVIDER` und keine PostgreSQL-Konfiguration;
- kein PostgreSQL-Treiber;
- kein SQL-Umbau und keine Datenkonvertierung;
- keine Änderung an Migrationen, Triggern oder unveränderlichen Historien;
- kein Deployment und kein Produktiv-Cutover.

## 2. Reproduzierbare Prüfung

Der Inventarprüfer arbeitet ausschließlich mit Node.js-Bordmitteln:

```bash
node scripts/audit-persistence-coupling.js --check
```

Eine vollständige maschinenlesbare Liste aller Treffer einschließlich Datei,
Zeile, Merkmal, Fachbereich, Zielschicht, Risiko und Übergangsausnahme liefert:

```bash
node scripts/audit-persistence-coupling.js --json
```

Der Prüfer:

- scannt Produkt-, Betriebs-, Entwicklungs- und Testquellen;
- klassifiziert jeden bekannten direkten und indirekten Treffer;
- meldet neue unklassifizierte Kopplungsdateien;
- verhindert steigende produktive Kopplungswerte ohne Baseline-Anpassung;
- unterscheidet produktive, betriebliche, Legacy- und Testausnahmen;
- prüft, dass Phase-2-Symbole und PostgreSQL-Abhängigkeiten noch fehlen.

Ausgeschlossen sind generierte oder laufzeitbezogene Verzeichnisse wie
`node_modules`, `release`, `runtime`, `data`, `backups`, `tmp` und
Testausgaben. Der Inventarprüfer selbst wird nicht als Quellkopplung gezählt.

## 3. Messbare Ausgangswerte

### 3.1 Gesamtsicht

| Messwert | Ausgangswert |
|---|---:|
| Direkt gekoppelte Produkt-/Betriebsdateien | 28 |
| Zusätzlich indirekt inventarisierte Produkt-/Betriebsdateien | 28 |
| Dateien mit direktem `node:sqlite`-Import oder eingebettetem Import | 20 |
| Davon eigenständige produktionsnahe JavaScript-Module | 13 |
| Explizit klassifizierte Test-/Fixture-Dateien mit SQL-Kopplung | 69 |
| Test-/Fixture-Dateien mit direktem `node:sqlite`-Import | 26 |
| Nicht klassifizierte Treffer | 0 |

Im eingefrorenen Phase-1-Snapshot lagen die vier direkten Treiberimporte im
eigentlichen Anwendungsbaum in
[`server.js`](../server.js#L3),
[`lib/database-lock.js`](../lib/database-lock.js#L6),
[`lib/f18-loan-migration.js`](../lib/f18-loan-migration.js#L8) und
[`lib/usb-profile-database.js`](../lib/usb-profile-database.js#L3). Weitere
Importe lagen in Betriebs-, Entwicklungs-, Recovery- und Legacy-Werkzeugen.
Seit dem ersten Phase-3-Slice liegt der frühere `server.js`-Treiberimport in der
benannten SQLite-Providergrenze; die historischen Zahlen dieser Tabelle bleiben
unverändert.

### 3.2 SQL- und SQLite-Merkmale

Die Werte sind lexikalische, reproduzierbare Kopplungsindikatoren. Bei
`.exec()` handelt es sich bewusst um Kandidaten; die detaillierte JSON-Ausgabe
liefert die Einzelfundstellen.

| Merkmal | Ausgangswert |
|---|---:|
| `.prepare(` | 1.394 |
| `.exec(`-Kandidaten | 419 |
| `BEGIN IMMEDIATE` | 68 |
| `BEGIN EXCLUSIVE` | 1 |
| `PRAGMA` | 63 |
| `INSERT OR IGNORE` | 65 |
| `INSERT OR REPLACE` | 3 |
| `ON CONFLICT` | 41 |
| `RAISE(ABORT)` | 98 |
| `AUTOINCREMENT` | 21 |
| `COLLATE NOCASE` | 54 |
| `julianday()` | 14 |
| `GLOB` | 2 |
| `VACUUM INTO` | 6 |
| `quick_check` | 27 |
| `foreign_key_check` | 3 |
| `wal_checkpoint` | 2 |
| `lastInsertRowid` | 32 |
| SQLite-Katalogzugriffe | 32 |

### 3.3 Schema und Migrationen

| Merkmal | Ausgangswert |
|---|---:|
| `CREATE TABLE` | 122 |
| tatsächliche `CREATE TRIGGER`-DDL-Zeilen | 98 |
| `CREATE [UNIQUE] INDEX` | 128 |
| `ALTER TABLE` | 19 |
| `ensureColumn(` einschließlich Definition | 94 |
| `schema_migrations`-Referenzen | 87 |
| explizite `*MigrationId`-Deklarationen | 17 |

Zum eingefrorenen Phase-1-Stand öffnete
[`server.js`](../server.js) die Datenbank synchron, setzte Foreign-Key-, Busy-,
WAL-, Synchronisations- und Checkpoint-PRAGMAs und hielt den globalen rohen
Handle. Seit dem ersten Phase-3-Slice übernimmt die benannte
SQLite-Providergrenze das Öffnen und gibt der noch nicht migrierten Fachlogik
nur eine befristete Kompatibilitätsfassade. Schemaabfragen verwenden weiterhin
`sqlite_master` und `PRAGMA table_info`; ihr SQL-Eigentum bleibt bis zur
vorgesehenen späteren Phase unverändert.

Bootstrap und inkrementelle Migrationen sind derzeit ineinander verschränkt:

- `schema_migrations` wird innerhalb des großen Schemas angelegt;
- Migrationsbedarf wird über Marker, Tabellen, Spalten, Triggertexte und
  Datenzustände ermittelt;
- vor risikoreichen Migrationen kann ein SQLite-Sicherungspunkt entstehen;
- historische Marker werden teilweise nachträglich mit `INSERT OR IGNORE`
  ergänzt;
- Trigger werden über aus `sqlite_master` gelesene SQL-Texte und
  SQLite-`RAISE(ABORT)`-Körper geprüft;
- der Live-Handle wird am Modulende weiterhin an Tests exportiert.

Allein `server.js` besitzt folgende Hotspot-Werte:

| Merkmal | `server.js` |
|---|---:|
| `.prepare(` | 1.149 |
| `db.prepare(` | 1.101 |
| `db.exec(` | 359 |
| `BEGIN IMMEDIATE` | 59 |
| `CREATE TABLE` | 120 |
| tatsächliche Trigger-DDL-Zeilen | 98 |
| `CREATE [UNIQUE] INDEX` | 127 |
| `ALTER TABLE` | 19 |
| `ensureColumn(` | 94 |
| `schema_migrations` | 82 |
| `*MigrationId`-Deklarationen | 17 |

## 4. Eigentum und Zielschichten

Die vollständige Dateiliste ist im Inventarprüfer festgeschrieben. Die
folgenden Gruppen bilden die verbindliche Eigentums- und Übergangsgrenze.

| Gruppe | Heutiges Eigentum | Künftige Zielschicht | Risiko |
|---|---|---|---|
| `server.js` | Runtime, Schema, Migrationen und fast alle Fachbereiche | Fach-Repositories, Migrationsrunner, SQLite-Runtime- und Betriebsadapter | kritisch |
| Agreement-, Governance- und Work-Rule-Stores | Module mit injiziertem rohem `db`-Handle | Fach-Repositories mit transaktionsgebundenem Executor | hoch |
| Backup und Datenbanksperre | SQLite-Dateisnapshot und exklusive Lock-Datenbank | providerbezogene Operations- und Maintenance-Lease-Adapter | kritisch |
| F18-Datenübernahme | historische fremde SQLite-Sicherung | ausdrücklich benannter Quellformatadapter außerhalb des App-Providers | mittel |
| Codespaces und Entwicklerwerkzeuge | lokale oder disposable SQLite-Datenbank | providerbezogene Entwicklungsprofile und Admin-CLI | mittel |
| Linux-Serverbetrieb | Bootstrap, Backup, Restore, Recovery, Offsite und Prüfung | providerbezogene Betriebsadapter hinter gemeinsamem Orchestrator | kritisch |
| Windows-Serverbetrieb | verwaltete Serverwerkzeuge mit SQLite-Dateipfad | providerbezogene Windows-Adapter oder ausdrücklich begrenzte Plattformmatrix | kritisch |
| Portable/USB | lokale Kopie, Initialisierung und Auslieferung | eingefrorenes SQLite-Legacy-Artefakt; keine PostgreSQL-Portierung | Legacy |
| Test-Fixtures | historische Dateien, Integritätsprüfung, Stores und Fachintegration | Vertragstests plus ausdrücklich providerspezifische Fixtures | Test |

Die bereits ausgelagerten SQL-Module sind noch keine Providerabstraktion:
beispielsweise verlangen
[`lib/governance-store.js`](../lib/governance-store.js#L50),
[`lib/system-center-metrics.js`](../lib/system-center-metrics.js#L277) und die
Work-Rule-Stores weiterhin einen synchronen Handle mit `prepare()` und
teilweise `exec()`.

## 5. Fachliche Hotspots in `server.js`

| Bereich | Baseline-Zeilen | Besonderes Risiko |
|---|---:|---|
| Start, Sperre, Backup | 1–1.517 | globaler Handle, WAL, Datei-Snapshots |
| Schema und Migrationen | 1.518–6.944 | DDL, PRAGMAs, Trigger, Reparaturen |
| Integrationen und Lohnübergabe | 20.916–21.490 | Übergabe- und Revisionsnachweise |
| Backup, Restore und Import | 21.547–22.825 | Datei-/Dokumentkopplung |
| Datenschutz und Zeitnachweise | 23.226–23.618 | unveränderliche Historien |
| Kollektivverträge und Regelwerk | 23.868–25.107 | manuelle Transaktionen, Veröffentlichungen |
| Organisation, Personal und Planung | 25.130–25.970 | zentrale Stammdatenabhängigkeiten |
| Identität, Rechte, WLAN, System-Center | 25.995–29.755 | Sicherheits- und Statusgrenzen |
| Leihe, Belege und Fotos | 30.041–32.961 | revisionsrelevante Daten plus Dateien |
| Krankheit, AUM und Abwesenheiten | 33.204–36.384 | besonders schutzwürdige Daten |
| Zeiterfassung | 36.390–36.619 | Korrekturen und Nachweise |
| Portable/USB | 37.061–37.185 | Legacy-Code im aktuellen Runtime-Baum |
| Einstellungen und Planung | 37.221–38.179 | viele direkte CRUD-Zugriffe |
| Produktreife, PDF und Shutdown | 38.184–39.718 | Abschlussnachweise und WAL-Checkpoint |

## 6. Betriebsinventar

### 6.1 Backupvertrag

Der aktuelle Sicherungspunkt besteht aus:

```text
dienstplan-<zeit>-<nonce>.db
dienstplan-<zeit>-<nonce>.amu/
dienstplan-<zeit>-<nonce>.complete.json
```

[`lib/backup-commit.js`](../lib/backup-commit.js) koppelt Datenbank-Hash und
geschützte Dokumentablage. Dieses Schema 1 bleibt dauerhaft les- und
verifizierbar. Eine providerneutrale Erweiterung benötigt später eine neue
Version; alte Nachweise dürfen nicht umgedeutet werden.

### 6.2 Snapshot, Restore und Sperre

- SQLite-Snapshots verwenden `VACUUM INTO` und `quick_check`.
- Restore tauscht Datenbankdateien kontrolliert aus und entfernt gegebenenfalls
  WAL-/SHM-Dateien.
- [`lib/database-lock.js`](../lib/database-lock.js) verwendet eine separate
  SQLite-Lockdatei und `BEGIN EXCLUSIVE`.
- PostgreSQL darf niemals durch diesen Dateirestore oder diese Locklogik
  behandelt werden.

### 6.3 Recovery Assurance und Offsite

Die aktuellen Pfade setzen `.db`, `.amu`, Commit-Marker,
`databaseSha256`, SQLite-Integrität und teilweise direkte
Trigger-/Schemanipulation voraus. Später zu trennen sind:

1. providerbezogene Engine-Prüfung;
2. providerneutrale fachliche Recovery-Prüfung;
3. Schlüssel- und Dokumentprüfung;
4. providerbezogener Restore beziehungsweise Cutover;
5. versionierter, komponentenbasierter Backup-Bundle-Vertrag.

Ein erfolgreicher SQLite-Nachweis darf niemals als PostgreSQL-Nachweis
erscheinen.

### 6.4 Monitoring und System-Center

Ready-Status, Monitor, Trust Index und Oberfläche verwenden derzeit
SQLite-Check-IDs, Datenbankdateigröße und SQLite-Prüfergebnisse. Künftig müssen
providerneutrale Capability- und Check-IDs verwendet werden; enginespezifische
Werte gehören in klar benannte Providerdetails. Fehlende Nachweise ergeben
„nicht verfügbar“ oder „nicht geprüft“, niemals implizit grün.

### 6.5 Plattformgrenze

Die aktuelle Startseite bezeichnet ausschließlich den verwalteten
Ubuntu-Einzelserver als Produktziel. Gleichzeitig führt
[`SERVERBETRIEB.md`](../SERVERBETRIEB.md#L3) die vorhandenen
Windows-Serverwerkzeuge noch als unterstützt und dokumentiert ab
[Zeile 394](../SERVERBETRIEB.md#L394) einen verwalteten Windows-Server.

Block 1 trifft dazu keine neue Produktentscheidung:

- Windows-Serverwerkzeuge werden vollständig als Betriebszugriffe inventarisiert;
- sie werden nicht mit Portable-/USB-Legacy gleichgesetzt;
- vor PostgreSQL-Support muss ausdrücklich entschieden werden, ob PostgreSQL
  auch unter Windows unterstützt wird;
- bis dahin bleibt der Windows-Serverpfad, soweit unterstützt, SQLite-spezifisch.

Portable, USB, Lokal- und LAN-Host bleiben dagegen eingefrorenes Legacy. Der
Legacy-Code ist noch nicht sauber vom aktuellen Runtime-Baum getrennt:
`server.js` importiert USB-Module und die Oberfläche enthält weiterhin den
Assistenten. Das ist eine dokumentierte Übergangsausnahme, keine künftige
Provideranforderung.

## 7. Test- und Fixture-Inventar

Die 69 erkannten Dateien sind einzeln im Inventarprüfer benannt und werden in
folgende zulässige Kategorien getrennt:

- historische SQLite-Fixtures und Post-Migrationsprüfungen;
- SQLite-Backup-, Restore-, Lock-, Integritäts- und Recovery-Tests;
- isolierte Tests heute SQLite-spezifischer Stores;
- Fachintegrationstests mit kontrolliertem Zugriff auf die Testdatenbank;
- Portable-/USB-Legacy-Test.

Es gibt keine pauschale Ausnahme „Tests dürfen immer direkt auf SQLite
zugreifen“. Eine neue Testdatei mit direkter Kopplung muss ausdrücklich
klassifiziert werden. Neue produktive Treiberimporte oder unregistrierte
SQL-Orte führen zum Fehlschlag der Inventarprüfung.

## 8. Priorisierte Umstellungsreihenfolge

Die Reihenfolge minimiert gleichzeitig Architektur-, Daten- und Betriebsrisiko:

1. **Phase 2:** Promise-basierter Vertrag, normalisierte Werte/Fehler und
   transaktionsgebundener Executor; noch kein PostgreSQL-Runtimepfad.
2. **Niedriges Risiko:** isolierte Systemmetriken und einfache, zunächst
   lesende Katalogzugriffe.
3. **Bereits modulare Stores:** Work-Rule-Store, Kollektivverträge,
   Regelentwürfe und Governance-Zugriffe.
4. **Organisation und Planung:** Kostenstellen, Standorte, Personalstamm und
   einfache Planungs-CRUD-Slices.
5. **Sicherheits- und Integrationsbereiche:** Identität, Rechte, Mobile,
   Schnittstellen und Lohnübergabe.
6. **Höchste Fachinvarianten:** Datenschutz/Governance, Zeit, Abwesenheiten,
   Krankheit/AUM sowie Leihe mit Belegen und Dateien.
7. **Providerbezogene Betriebsgrenze:** Schema, Migrationen, Trigger,
   Backup, Restore, Locking, Integrität, Recovery Assurance und Monitoring.
8. **Legacy-Trennung:** Portable/USB nicht portieren, sondern aus dem aktuellen
   Serverartefakt abgrenzen.

Innerhalb jeder Stufe wird eine vertikale Funktion vollständig über den neuen
Pfad geführt und geprüft. Eine synchrone PostgreSQL-Fassade, die nur die
SQLite-API nachahmt, ist ausdrücklich kein zulässiges Zwischenziel.

## 9. Übergangsausnahmen

Bis zum jeweils freigegebenen späteren Block bleiben ausschließlich die
inventarisierten Ausnahmen zulässig:

- bestehender direkter SQLite-Zugriff im Produktcode;
- SQLite-Bootstrap, Migrationen, Trigger- und Indexprüfung;
- `sqlite-backup-v1`, Datei-Restore, WAL, Locking und Integritätsprüfung;
- historische Linux-Runtime-Migrationen;
- Windows-Serverwerkzeuge vor einer ausdrücklichen Plattformentscheidung;
- Codespaces als SQLite-Referenzprofil;
- F18 als konkrete historische SQLite-Quelle;
- Portable/USB als eingefrorenes SQLite-Legacy;
- einzeln benannte providerspezifische Test-Fixtures.

Nicht zulässig sind:

- neue produktive `node:sqlite`-Importe;
- neue unklassifizierte rohe SQL- oder Migrationsorte;
- Änderungen historischer Migrationskennungen oder unveränderlicher Trigger;
- Providervertrag vor Block 2 oder ausführbarer PostgreSQL-Provider-,
  Treiber- beziehungsweise Runtime-Code vor Block 5;
- automatische Datenkonvertierung;
- Produkt-, Deployment- oder Supportbehauptungen ohne bestandene Gates.

## 10. Abnahme Block 1/7

- [x] Direkte Treiber- und SQL-Kopplungen reproduzierbar erfasst.
- [x] Indirekte Setup-, Backup-, Restore-, Recovery-, Monitoring- und
      Wartungskopplungen erfasst.
- [x] Schema, Migrationen, Trigger, Indizes und Transaktionsstellen vermessen.
- [x] Fachliche Eigentümer, Zielschichten und Risiken zugeordnet.
- [x] Test-/Fixture-Ausnahmen einzeln klassifiziert.
- [x] Portable/USB-Legacy von der offenen Windows-Servergrenze unterschieden.
- [x] Null unklassifizierte Treffer.
- [x] Keine Runtime-, Abhängigkeits-, Datenbank- oder Deploymentänderung.

Block 2 wurde am 29.07.2026 separat freigegeben. Dieses Dokument bleibt die
unveränderte Phase-1-Ausgangsbasis; der umgesetzte Vertrag ist im
[Datenbank-Provider-Vertrag](DATENBANK-PROVIDER-VERTRAG.md) beschrieben.

Block 3 wurde am 29.07.2026 separat freigegeben und abgeschlossen. Die
vollständige SQLite-Parität und ihre aktuellen Nullwerte werden ausschließlich
im Abschlussartefakt
[SQLite-Provider und vollständige SQLite-Parität](DATENBANK-SQLITE-PROVIDER.md)
dokumentiert. Die Messwerte, Ausnahmen und Abnahme dieses Dokuments bleiben die
unveränderte Phase-1-Ausgangsbasis und werden dadurch nicht nachträglich
umgedeutet oder überschrieben.

Block 4 wurde am 29.07.2026 separat freigegeben und abgeschlossen. Das
Ergebnisartefakt
[Datenbank-Dialekte und providerfähige Migrationen](DATENBANK-DIALEKTE-UND-MIGRATIONEN.md)
ergänzt dieses historische Inventar um maschinenprüfbare SQL-Eigentums-,
Dialekt- und Migrationsgrenzen. Die Messwerte dieses Dokuments bleiben weiterhin
die unveränderte Phase-1-Ausgangsbasis.
