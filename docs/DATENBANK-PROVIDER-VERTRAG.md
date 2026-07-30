# Datenbank-Provider-Vertrag

**Status:** Block 2/7 abgeschlossen<br>
**Vertragsversion:** 1<br>
**Stand:** 29.07.2026<br>
**Produktstand:** Grabenplaner v0.87.0-beta

## 1. Zweck und Blockgrenze

Dieses Dokument ist das Ergebnis von Phase 2 der
[Datenbank-Provider-Strategie](DATENBANK-PROVIDER-STRATEGIE.md). Es legt den
Promise-basierten Providervertrag, die typisierten Statements, normalisierten
Werte und Fehler, die Transaktionssemantik sowie die geschlossene
Providerkonfiguration fest.

Zum Abnahmezeitpunkt von Block 2 war noch kein neuer Datenbankpfad aktiviert:

- Die produktive Fachlogik verwendete weiterhin den bestehenden SQLite-Zugriff.
- Es gab noch keinen SQLite-Adapter hinter dem neuen Vertrag.
- Es gab keinen PostgreSQL-Treiber und keine PostgreSQL-Verbindung.
- SQL, Migrationen, Trigger, Backup, Restore und Recovery waren nicht
  umgestellt.
- `DB_PROVIDER=postgresql` wurde erkannt, aber ausdrücklich als noch nicht
  implementiert oder freigegeben abgelehnt.
- Es gab keine Datenkonvertierung, Produktivmigration oder Supportbehauptung.

Block 3 wurde am 29.07.2026 separat freigegeben und abgeschlossen. Der Vertrag
dieses Dokuments bleibt unverändert Version 1; Implementierung und Abnahme sind
in
[SQLite-Provider und vollständige SQLite-Parität](DATENBANK-SQLITE-PROVIDER.md)
dokumentiert.

## 2. Verbindliche Module

| Modul | Verantwortung |
|---|---|
| [`lib/persistence/contract.js`](../lib/persistence/contract.js) | Providerfassade, Statementvertrag, Werte, Resultate, Transaktionen, Capabilities und Lebenszyklus |
| [`lib/persistence/errors.js`](../lib/persistence/errors.js) | stabile providerneutrale Fehlercodes und sichere Fehlernormalisierung |
| [`lib/persistence/configuration.js`](../lib/persistence/configuration.js) | geschlossene Providerauswahl und kompatible SQLite-Pfadauflösung |
| [`test-support/persistence-provider-contract.js`](../test-support/persistence-provider-contract.js) | wiederverwendbare providerunabhängige Vertragstests |
| [`test-support/persistence-contract-adapter.js`](../test-support/persistence-contract-adapter.js) | deterministischer, treiberfreier Testadapter |

Es existiert bewusst keine allgemeine `index.js`-Fassade und kein
`getRaw()`, `unwrap()`, `withConnection()` oder vergleichbarer Escape-Hatch.

## 3. Öffentliche Provideroberfläche

Ein `PersistenceProvider` veröffentlicht exakt:

```js
{
  queryOne(statement, params),
  queryAll(statement, params),
  execute(statement, params),
  transaction(work, options),
  close(),
  getCapabilities()
}
```

Alle Daten- und Lebenszyklusoperationen liefern Promises. Auch synchrone
Adapterfehler gelangen nur als abgelehnte Promises an Aufrufer.
`getCapabilities()` ist eine reine synchrone Metadatenabfrage.

Der transaktionsgebundene `PersistenceExecutor` veröffentlicht exakt:

```js
{
  queryOne(statement, params),
  queryAll(statement, params),
  execute(statement, params)
}
```

Er enthält insbesondere keine verschachtelte `transaction()`-Methode, kein
`close()`, keine Capabilities und keinen Treiberhandle.

## 4. Statements und SQL-Eigentum

Statements werden ausschließlich mit `definePersistenceStatement(...)`
angelegt. Ein Statement besitzt:

- eine stabile, fachlich benannte ID;
- genau eine Operation: `queryOne`, `queryAll` oder `execute`;
- vollständig benannte Parameter;
- vollständig benannte Rückgabespalten;
- für jedes Feld einen providerneutralen Werttyp sowie
  `nullable`-/`optional`-Eigenschaften.

Das öffentliche Statement enthält weder SQL-Text noch ein vorbereitetes
Treiberstatement. Spätere Provider ordnen derselben Statement-ID ihren
jeweiligen SQL-Dialekt innerhalb der Persistence-Schicht zu.

Unbekannte, fehlende oder zusätzliche Parameter und Spalten scheitern
geschlossen. Dadurch kann ein Treiberobjekt nicht als zusätzliche
Ergebniseigenschaft in Fachlogik gelangen.

## 5. Normalisierte Werte

| Vertragstyp | Normalisierte JavaScript-Darstellung |
|---|---|
| `text` | `string` |
| `boolean` | ausschließlich `true` oder `false` |
| `safe_integer` | sichere JavaScript-Ganzzahl |
| `bigint_string` | kanonische Dezimalzeichenfolge ohne Präzisionsverlust |
| `decimal_string` | kanonische Dezimalzeichenfolge |
| `utc_timestamp` | UTC-ISO-8601 mit Millisekunden und `Z` |
| `date` | gültiges `YYYY-MM-DD` |
| `time` | gültiges `HH:mm:ss` |
| `json` | tief kopierter und eingefrorener JSON-Wert |
| `bytes` | unabhängige `Buffer`-Kopie |

Zusätzliche Regeln:

- SQL-`NULL` wird nur bei einem als `nullable` definierten Feld zu `null`.
- Eine nicht ausgewählte optionale Spalte bleibt abwesend; sie wird nicht
  künstlich zu `null`.
- `undefined`, `NaN`, unendliche Zahlen und unsichere JavaScript-Ganzzahlen
  werden abgelehnt.
- Binär- und JSON-Werte werden vom Adapterwert entkoppelt.

## 6. Normalisierte Resultate

`queryOne(...)` liefert genau eine eingefrorene Zeile oder `null`. Mehr als
eine Zeile ist ein Vertragsfehler.

`queryAll(...)` liefert immer eine eingefrorene Zeilenliste; kein Treffer
ergibt `[]`.

`execute(...)` liefert exakt:

```js
{
  rowsAffected: 0,
  returnedRows: []
}
```

`rowsAffected` ist eine nichtnegative sichere Ganzzahl. Erzeugte Schlüssel
dürfen nur über normalisierte Rückgabezeilen erscheinen.
`lastInsertRowid`, PostgreSQL-Resultatobjekte, Statements oder Connections
werden verworfen beziehungsweise abgelehnt.

## 7. Normalisierte Fehler

Verbindliche Codes:

| Gruppe | Codes |
|---|---|
| Constraints | `PERSISTENCE_UNIQUE_VIOLATION`, `PERSISTENCE_FOREIGN_KEY_VIOLATION`, `PERSISTENCE_NOT_NULL_VIOLATION`, `PERSISTENCE_CHECK_VIOLATION` |
| Konkurrenz | `PERSISTENCE_BUSY`, `PERSISTENCE_RETRYABLE_TRANSACTION` |
| Verbindung | `PERSISTENCE_CONNECTION_UNAVAILABLE`, `PERSISTENCE_TIMEOUT`, `PERSISTENCE_ABORTED` |
| Vertrag | `PERSISTENCE_TRANSACTION_STATE_INVALID`, `PERSISTENCE_STATEMENT_INVALID`, `PERSISTENCE_SCHEMA_INVALID`, `PERSISTENCE_RESULT_INVALID`, `PERSISTENCE_CONTRACT_VIOLATION` |
| Konfiguration | `PERSISTENCE_CONFIGURATION_INVALID`, `PERSISTENCE_PROVIDER_UNAVAILABLE` |
| Lebenszyklus | `PERSISTENCE_PROVIDER_CLOSING`, `PERSISTENCE_PROVIDER_CLOSED` |
| Fallback | `PERSISTENCE_UNKNOWN` |

Jeder Fehler besitzt mindestens `code`, `retryable` und eine sichere öffentliche
Meldung. `retryable` ist ausschließlich Metadatum und keine Erlaubnis für eine
automatische Wiederholung. Standardmäßig sind nur Busy- und ausdrücklich als
wiederholbar klassifizierte Transaktionsfehler wiederholbar; insbesondere muss
ein Provider die Wiederholbarkeit eines Verbindungsfehlers bewusst setzen.

Unbekannte Adapterfehler werden auf `PERSISTENCE_UNKNOWN` normalisiert.
Öffentliche Meldung und JSON-Darstellung enthalten weder Treibermeldung,
Verbindungs-URL noch SQL-Parameter. Ein interner Cause wird höchstens auf
einen bereinigten Fehlernamen reduziert.

## 8. Transaktionssemantik

`transaction(work, options)`:

1. validiert Isolation und `readOnly`;
2. lässt den Adapter genau eine Transaktion beginnen;
3. übergibt einen nur für diese Transaktion gültigen Executor;
4. committet bei erfolgreichem Callback genau einmal;
5. versucht bei synchronem oder asynchronem Callbackfehler genau ein Rollback;
6. erhält den ursprünglichen Callbackfehler auch dann als Primärfehler, wenn
   das Rollback zusätzlich fehlschlägt;
7. versucht nach einem Commitfehler ein kontrolliertes Rollback, ohne den
   normalisierten Commitfehler als Primärfehler zu ersetzen.

Alle Executoroperationen verwenden denselben intern gebundenen
Transaktionsadapter. Der globale Provider wird innerhalb seines
Transaktionscallbacks durch einen privaten asynchronen Kontext abgelehnt.
Die Fassade hält für die gesamte Transaktion zusätzlich eine exklusive
Provider-Lease: bereits laufende globale Operationen werden vor
Transaktionsbeginn beendet, später gestartete Operationen warten bis nach
Commit oder Rollback. Dadurch kann ein einzelner SQLite-Handle keine fremde
Operation unbemerkt in eine offene Transaktion aufnehmen.

Vertragsversion 1 lehnt verschachtelte Transaktionen eindeutig ab.
Ein aus dem Callback heraus gespeicherter Executor wird nach Commit oder
Rollback ungültig. In einer als `readOnly` angelegten Transaktion lehnt die
Fassade jede `execute()`-Operation ab. Bereits gestartete, versehentlich nicht
abgewartete Executoroperationen werden vor Commit oder Rollback vollständig
geleert; ein dabei aufgetretener Fehler erzwingt Rollback.

## 9. Capabilities und Schließen

Capabilities sind tief eingefroren und enthalten ausschließlich:

- Vertragsversion und Provider-ID;
- die explizite Transaktionssemantik;
- boolesche Nachweise für atomare Transaktionen, Parallelität,
  Mehrinstanzbetrieb, Backup, Restore, Integritätsprüfung,
  Recovery Assurance, System-Center-Auskunft, gepaarte Dokument-/
  Datenbanksicherung und Point-in-Time-Recovery.

Ungeprüfte Fähigkeiten sind `false`. Pfade, Secrets, Connection-, Pool- oder
Treiberdetails sind unzulässig.

`close()`:

- ist idempotent;
- wartet auf bereits gestartete Operationen;
- schließt den internen Adapter genau einmal;
- lehnt ab Beginn des Schließens neue Operationen eindeutig ab;
- lässt die unveränderlichen Capabilities weiterhin lesen.

## 10. Providerkonfiguration

| Eingabe | Verhalten in Block 2 |
|---|---|
| `DB_PROVIDER` fehlt oder ist leer | `sqlite` |
| `sqlite`, Groß-/Kleinschreibung und Rand-Whitespace | `sqlite` |
| unbekannter Wert wie `pg`, `postgres` oder Tippfehler | geschlossener Konfigurationsfehler, kein Fallback |
| `postgresql` | bekannter, aber noch nicht verfügbarer Provider |
| `DATABASE_URL` bei effektivem SQLite | geschlossener Konfliktfehler |
| `DB_PATH` gesetzt | unverändert übernommen |
| `DB_PATH` leer oder nicht gesetzt | exakt der bisherige Standardpfad |

Die Auswertung erfolgt vor Lockdatei, Verzeichniserzeugung und
`DatabaseSync`-Öffnung. `DATABASE_URL` wird in Block 2 weder semantisch
ausgewertet noch gespeichert, protokolliert oder zurückgegeben.

Die bestehende Serverprüfung für einen absoluten lokalen SQLite-Pfad bleibt
unverändert. Relative Pfade und `:memory:` bleiben in den bisherigen
Lokal-/Testkontexten technisch kompatibel; daraus entsteht kein neues
Produktmodell.

## 11. Architekturprüfung

Für die Abnahme von Block 2 setzte der reproduzierbare Prüfer
[`scripts/audit-persistence-coupling.js`](../scripts/audit-persistence-coupling.js)
folgende Grenzen durch:

- Providervertragssymbole nur in den drei einzeln benannten Vertragsmodulen;
- `DB_PROVIDER` und `DATABASE_URL` nur in der zentralen Konfiguration;
- Konfigurationsimport nur im Startmodul und innerhalb der Persistence-Schicht;
- kein Vertragsexport in bestehende Fachlogik vor Block 3;
- keine neuen `node:sqlite`-Importe;
- kein PostgreSQL-Treiber und keine ORM-/PostgreSQL-Abhängigkeit;
- keine neue Paketabhängigkeit gegenüber der eingefrorenen Phase-2-Baseline;
- unveränderte Phase-1-Ausgangswerte für die bestehende SQLite-Kopplung.

Mit der separaten Freigabe von Block 3 wurde dieselbe Prüfung gezielt
fortgeschrieben: Exakt ein neuer produktiver `node:sqlite`-Import ist
ausschließlich in `lib/persistence/sqlite/provider.js` zulässig. Alle übrigen
Treiber-, Provider- und PostgreSQL-Grenzen bleiben geschlossen. Der aktuelle
Umfang und die noch offenen Paritätsarbeiten stehen im
[Phase-3-Fortschrittsartefakt](DATENBANK-SQLITE-PROVIDER.md).

Prüfung:

```bash
node scripts/audit-persistence-coupling.js --check
node --test test/v087-persistence-provider-contract.test.js
```

## 12. Abnahme Block 2/7

- [x] Promise-basierter Providervertrag definiert.
- [x] Statementvertrag ohne SQL- oder Treiberhandle definiert.
- [x] Parameter, Werte, Zeilen und Schreibergebnisse normalisiert.
- [x] Stabile, sichere und providerneutrale Fehlercodes definiert.
- [x] Transaktionsgebundener Executor automatisiert geprüft.
- [x] Exklusive Provider-Lease verhindert fremde Operationen in offenen Transaktionen.
- [x] Nicht abgewartete Executoroperationen werden vor Transaktionsabschluss geleert.
- [x] Commit, Commitfehler-Cleanup, Rollback, Primärfehler und abgelaufener Executor geprüft.
- [x] Read-only-Transaktionen lehnen Schreiboperationen ab.
- [x] Verschachtelte Transaktionen eindeutig abgelehnt.
- [x] Capabilities tief unveränderlich und treiberfrei.
- [x] Idempotente Close-Semantik geprüft.
- [x] `DB_PATH`-Kompatibilität erhalten.
- [x] Unbekannte, widersprüchliche und noch nicht verfügbare Providerkonfiguration scheitert geschlossen.
- [x] Architekturprüfung auf die exakte Block-2-Grenze umgestellt.
- [x] Kein PostgreSQL-Treiber, keine neue Abhängigkeit und keine Datenmigration.

Block 3 wurde am 29.07.2026 separat und ausdrücklich freigegeben. Diese
Freigabe ändert die abgeschlossene Block-2-Abnahme und Vertragsversion nicht.
