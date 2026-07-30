# SQLite-Provider und vollständige SQLite-Parität

**Status:** Block 3/7 abgeschlossen  
**Stand:** 29.07.2026  
**Produktstand:** Grabenplaner v0.87.0-beta

## 1. Ergebnis und Grenze

Block 3 führt den vollständigen bestehenden SQLite-Laufzeitpfad hinter den in
Block 2 festgelegten, Promise-basierten Providervertrag. Vollständige SQLite-Parität
ist erreicht: Die Fach- und Anwendungsmodule verwenden
Repositories oder ausdrücklich benannte Betriebsoperationen statt eigener
`db.prepare()`- oder `db.exec()`-Aufrufe.

SQLite bleibt der unterstützte Standard für den verwalteten Einzelserver.
Bestehende Datenbanken und der bisherige `DB_PATH`-Konfigurationsweg bleiben
kompatibel. Es gibt weiterhin keinen PostgreSQL-Treiber, keine automatische
Datenkonvertierung, keinen Cutover und keine Deployment- oder
PostgreSQL-Supportfreigabe.

Block 3 schließt die SQLite-Parität ab. Providerfähige SQL-Dialekte und
providerfähige Migrationen sind erst Gegenstand von Block 4.

## 2. Architektur

- `lib/persistence/statements/` enthält providerneutrale Statement-IDs und
  Parameterverträge.
- `lib/persistence/repositories/` stellt fachlich benannte, treiberfreie
  Zugriffe und gebundene Repository-Transaktionen bereit.
- `lib/persistence/sqlite/*-catalog.js` besitzt das SQLite-SQL der Fachbereiche.
- `lib/persistence/sqlite/operations/` kapselt klar benannte
  SQLite-spezifische Schema-, Migrations-, Diagnose-, Sicherungs- und
  Wartungsoperationen.
- [`lib/persistence/sqlite/provider.js`](../lib/persistence/sqlite/provider.js)
  besitzt den privaten SQLite-Handle und setzt den Providervertrag um.
- `server.js` komponiert genau einen Provider und die
  Anwendungs-Repositories; rohe Treiberhandles gelangen nicht in Fachmodule.

Die Allowlist erlaubt weiterhin genau einen neuen Providerimport von
`node:sqlite`: `lib/persistence/sqlite/provider.js`. Diese Ausnahme gilt nicht
pauschal für die Persistence-Schicht. Transaktionscallbacks arbeiten
ausschließlich mit ihrem gebundenen Executor; Commit und Rollback verbleiben
beim Provider.

## 3. Abgedeckte Laufzeitbereiche

Die Umstellung umfasst unter anderem:

- UI-Präferenzen, Branding und Portalzugang;
- Organisation, Personal, Rechte, Rollen und Kostenstellen;
- Planung, Einstellungen, Zeitbuchungen, Korrekturen und Präsenz;
- Abwesenheiten, Krankheit, AUM und geschützte Dokumente;
- Kollektivverträge, Arbeitsregeln, Governance und eigene Prozesse;
- WLAN-Automatik, mobile Authentifizierung und Integrationen;
- Leihmodul, System-Center-Metriken und Runtime-Recovery;
- Anwendungsschema, Seeding, historische Migrationen, Schutzmigrationen,
  Diagnose, Backup, Import und Wartung.

Portable/USB bleibt eingefrorenes Legacy und ist kein künftiges Produktmodell.
Die noch vorhandenen lesenden Legacy-Laufzeitpfade verwenden ebenfalls die
Repository-Grenze; daraus entsteht keine neue Produkt- oder Supportzusage.

## 4. Gemessene Abnahme

Der Stand wird reproduzierbar mit
`node scripts/audit-persistence-coupling.js --check` ermittelt. Die
Phase-1-Baseline im
[Datenbank-Kopplungsinventar](DATENBANK-KOPPLUNGSINVENTAR.md) bleibt
unverändert.

| Messwert | Abschlussstand |
|---|---:|
| Phase-3-Implementierungsdateien | 77 |
| Phase-3-Testdateien | 23 |
| fachliche Repository-Slices | 20 |
| benannte SQLite-Betriebsoperationen | 14 |
| produktive `node:sqlite`-Providerimporte | 1 |
| direkte `db.prepare`-Aufrufe in `server.js` | 0 |
| direkte `db.exec`-Aufrufe in `server.js` | 0 |
| verbleibende rohe Fachzugriffe | 0 |
| Persistence-Layer-Verstöße | 0 |
| vollständige SQLite-Parität | ja |

Der Provider- und Vertragspfad wurde zusätzlich lokal mit Node 22.13.0
verifiziert. Das CI-Profil prüft diese Mindestlaufzeit separat; die reguläre
Testsuite läuft weiterhin plattformübergreifend.

## 5. Abnahme Block 3/7

- [x] SQLite-Provider erfüllt den Promise-basierten Vertrag.
- [x] Fachbereiche verwenden treiberfreie Repositories.
- [x] Transaktionen verwenden ausschließlich gebundene Executor- und
      Repository-Instanzen.
- [x] Schema, Migrationen und Betriebszugriffe liegen in benannten
      SQLite-Operationen.
- [x] Bestehender `DB_PATH` und historische SQLite-Strukturen bleiben
      kompatibel.
- [x] Direkte Runtime-Fachzugriffe außerhalb der Persistence-Grenze sind null.
- [x] Architektur-Audit, Provider-, Fach- und Regressionstests bilden ein
      geschlossenes Abnahme-Gate.
- [x] Keine PostgreSQL-Abhängigkeit und keine Produktivmigration eingeführt.

Diese Abnahme gab Block 4 nicht automatisch frei. Block 4 wurde anschließend
separat freigegeben und mit
[Datenbank-Dialekte und providerfähige Migrationen](DATENBANK-DIALEKTE-UND-MIGRATIONEN.md)
abgeschlossen.
