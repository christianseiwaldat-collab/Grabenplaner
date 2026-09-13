# PostgreSQL-Migration: Stand der Blöcke 1–12

Stand 13.09.2026. Die nacheinander bearbeiteten Blöcke gehören zum neuen [12-Block-Plan](../POSTGRESQL-BESTANDSAUFNAHME-2026-09-12.md). Alte v0.87-Providerphasen sind eine andere Zählung.

## Ergebnis

| Block | Implementiert und geprüft | Nachweis |
|---|---|---|
| 1 | Vollständiges Daten-/Dateiinventar, explizite Zielaufteilung, synthetische Baselines und Abnahmekriterien | [Bestand](BLOCK-1.md) |
| 2 | Eigene PostgreSQL-Instanz mit zwei Datenbanken, getrennten Rollen und begrenzten Verbindungen | [Umgebung](BLOCK-2.md) |
| 3 | 191 Core-Tabellen, 213 Quellindizes, eine View und 299 Trigger; atomare Schemaanlage und Driftprüfung | [Schema](BLOCK-3.md) |
| 4 | 1.125 Core-Statements, bestehende Core-Repositories am PostgreSQL-Provider, 632 Lesevergleiche und gezielte Fachtests | [Anwendung](BLOCK-4.md) |
| 5 | Vollständige Kassenquellen, verschlüsselter Import, Veröffentlichung und bestätigte Beleg-/Rohertragsregeln | [Kassa](BLOCK-5.md) |
| 6 | Sämtliche 66 Trade-Masterprofile, Artikelrevisionen, exakte Preise, eigene Bilder und Rücknahme | [TradeFoto](BLOCK-6.md) |
| 7 | Atomare GP-Zuordnungen, feste Artikelreferenzen, aktuelle Rechte und wiederholbare Audit-Zustellung | [Core/Sales](BLOCK-7.md) |
| 8 | PostgreSQL-PDF-Worker, Monatsarchiv, Suchoptimierungen, Fachtests und bestandener Lastnachweis | [Berichte und Last](BLOCK-8.md) |
| 9 | Zweimalige vollständige historische Übernahme von 2.887.715 Datensätzen, Abbruch/Wiederanlauf, Dateien und Schlüsselbindungen | [Historischer Transfer](BLOCK-9.md) |
| 10 | Gemeinsame Sicherungen, Offsite-Rückholung, logischer und physischer Restore, Betriebsadapter, Monitoring und kurzer Deployvertrag | [Betrieb und Wiederherstellung](BLOCK-10.md) |
| 11 | Vollständige HTTP-Anwendung, historischer Lastlauf, harter Abbruch/Wiederanlauf, doppelte Audit-Zustellung, vollständiger Restore und Datenausgabe | [Generalprobe](BLOCK-11.md) |
| 12 | Geschützte Produktivkonfiguration, erneute vollständige Übernahme, Start als Anwendungsbenutzer, Sicherungs-/Neustartsteuerung und Wartungsablauf vorbereitet; Produktivwechsel noch offen | [Umstellung](BLOCK-12.md) |

Die Zielaufteilung bleibt **eine Core-Datenbank für GP einschließlich CRM und eine Sales-Datenbank für Kassa, TradeFoto und Berichte**. Das Anfangsinventar ordnete 191 Tabellen Core und 57 Sales zu. Block 7 verschiebt drei bestätigte GP-Zuordnungstabellen in den Core: fachlich jetzt 194 Core-/54 Sales-Quelltabellen. Ihre drei alten Sales-Tabellen bleiben in dieser Entwicklungsstufe leer und gesperrt; zusätzliche technische Referenz- und Übergabetabellen kommen hinzu. Die Originalarchive bleiben vollständig in Sales. Etwa 90 % des ursprünglich zugeordneten SQLite-Platzes entfallen auf Verkauf; das ist keine Prognose der PostgreSQL-Größe.

Die produktive Anwendung läuft weiterhin auf SQLite. Die isolierten Datenbanken enthalten seit Block 9 eine vollständig geprüfte historische Kopie. Block 12 ergänzt die ausdrücklich gebundene, Root-verwaltete Aktivierung und den kontrollierten Umschaltablauf. Die zusätzliche Probe verwendet bereits die endgültigen Namen `grabenplaner_core` und `grabenplaner_sales`. Der Nutzer hat die Fortsetzung bis Block 12 beauftragt; dessen produktiver Abschluss benötigt noch den konkreten Release-/Paketstand und das Wartungsfenster aus dem Migrationsplan.

## Arbeitsstand

Repository: `C:\Users\chris\Documents\Lamprechter\Grabenplaner-v0927-function-search`, Branch `feature/schedule-pdf-day-separators`, Ausgangs-HEAD `c6b8a112e79514f39bbd0ce9906c54f052e45e40`. Die Änderungen liegen lokal, ohne Commit, Push oder Deploy. Der bestehende unversionierte Ordner `output/` bleibt erhalten.

Die zusammengefassten Prüfergebnisse und der Abschlusszustand werden in [verification.json](verification.json) festgehalten. Die Fachtests verwenden ausschließlich eigene synthetische Daten und räumen diese nach überprüfter Umgebungs- und Eigentumskennung wieder auf. Schema, Migrationsledger und private Zugangsdaten bleiben für die Fortsetzung erhalten.

Die eigene Entwicklungsinstanz enthält historische Daten und wurde nach den Proben wieder kontrolliert gestoppt. Ein lokaler SSH-Tunnel wurde nicht benötigt. Die synthetischen Bereinigungswerkzeuge dürfen diesen Bestand nicht leeren. Eigene, bereits vollständig nachgewiesene Restore-Duplikate wurden nach Prüfung ihres Stillstands entfernt; Quellkopie, Sicherungspakete, WAL-/Basisbackup und Nachweise bleiben erhalten. Fehlgeschlagene ältere Recovery-Assurance-Läufe werden mit späteren signierten Erfolgsnachweisen abgeglichen; ein alter systemd-Fehlerstatus allein entscheidet nicht über den aktuellen Wiederherstellungsnachweis.

## Wiederanlauf der Entwicklung

Eigener Serverbereich: `/home/gpadmin/grabenplaner-pg-migration-20260912`, nur `127.0.0.1:55482`, ohne systemd-Unit. Die dortigen Datenbanken heißen `gp_migration_core` und `gp_migration_sales`. Sie sind weder die produktive GP-Quelle noch der Lebensatlas-Cluster auf Port 5432.

Das Skript `scripts/postgresql/development-environment.sh` unterstützt `status`, `start` und `stop`. Es muss per vorhandener SSH-Verbindung als `gpadmin` ausgeführt werden und prüft absolute Verzeichnisse, Eigentumsmarker, PostgreSQL-Version, Listenadresse, Port und gegebenenfalls Prozessidentität. Vor dem Start den Status prüfen. Der Installer `create-isolated-environment.sh` ist nur für einen neuen, noch nicht vorhandenen Entwicklungsbereich vorgesehen und darf bei einer Fortsetzung nicht erneut ausgeführt werden.

Der temporäre SSH-Tunnel verbindet lokal `127.0.0.1:55483` mit `127.0.0.1:55482` des Hosts. Private Zugangsdaten liegen nur im ignorierten `tmp/postgresql-development/credentials.json` mit eingeschränkter Windows-ACL. `run-development.js` gibt Verbindungswerte ausschließlich an den gestarteten Unterprozess weiter. Zugangsdaten nicht ausgeben oder ins Repository kopieren.

Die folgenden Befehle dokumentieren die synthetische Qualifikation der Blöcke 1–8. Sie benötigen einen eigenen leeren Fixture-Bestand und dürfen **nicht** auf den seit Block 9 gefüllten Datenbanken ausgeführt werden:

```text
node scripts/postgresql/run-development.js scripts/postgresql/apply-core-schema.js
node scripts/postgresql/run-development.js scripts/postgresql/validate-core-catalog.js
node scripts/postgresql/run-development.js scripts/postgresql/validate-core-triggers.js
node scripts/postgresql/run-development.js scripts/postgresql/apply-sales-schema.js 5
node scripts/postgresql/run-development.js scripts/postgresql/apply-sales-schema.js 6
node scripts/postgresql/run-development.js scripts/postgresql/apply-boundary-schema.js
node scripts/postgresql/run-development.js scripts/postgresql/apply-sales-schema.js 8
node scripts/postgresql/run-development.js scripts/postgresql/validate-sales-catalog.js 8
node scripts/postgresql/run-development.js scripts/postgresql/validate-sales-triggers.js 8
node scripts/postgresql/run-development.js --test --test-concurrency=1 test/postgresql-migration-inventory.test.js test/postgresql-migration-environment.test.js test/postgresql-migration-schema.test.js test/postgresql-migration-application.test.js test/postgresql-migration-queries.test.js
node scripts/postgresql/run-development.js --test --test-concurrency=1 test/postgresql-migration-cash.test.js test/postgresql-migration-trade.test.js test/postgresql-migration-boundary.test.js test/postgresql-migration-reporting.test.js
node scripts/postgresql/run-development.js scripts/postgresql/verify-development-state.js
node scripts/audit-persistence-coupling.js --check
```

Der normale Schema-Wiederholungslauf verifiziert Ledger und reale Struktur ohne erneute DDL. Ein Neuaufbau mit `--rebuild-empty-development` ist ausschließlich eine Entwicklungsfunktion und verweigert belegte Anwendungstabellen. Er ist kein Werkzeug für historische Datenübernahme oder produktive Rückkehr.

Die vollständige Lastmessung läuft im separat markierten Unterverzeichnis `qualification` derselben Entwicklungsumgebung mit dem Node-Runtime des Hosts. Der bewachte Einstieg lautet dort `node scripts/postgresql/run-server-qualification.js scripts/postgresql/qualify-load.js`. Er akzeptiert nur das eigene Verzeichnis und dessen Marker. Fixture-Tests und Lastmessung müssen nacheinander laufen; niemals parallele synthetische Schreiber oder zusätzliche Diagnoseverbindungen während der Lastmessung starten. Die Testrollen teilen sich 17 normale PostgreSQL-Verbindungen; drei weitere bleiben für den eigenen Bootstrap-Administrator reserviert.

Nach einer bewusst geänderten Core-Schema-/SQL-Implementierung benötigt `lock-core-catalog.js` einen frischen vollständigen Validierungsbericht. Das aktualisiert den Entwicklungsvertrag, nicht die produktiven Freigaben. Nach der Arbeit eigene Verbindungen schließen, die bewachte Entwicklungsinstanz stoppen und nur den zugehörigen temporären Tunnel beenden.

## Nächste Arbeit

Die Blöcke 9–11 sind abgeschlossen. Die Umsetzungsvorbereitung für Block 12 ist in [BLOCK-12.md](BLOCK-12.md) festgehalten. Die bestätigten Fachregeln für Rohertrag, Rabatte, Zahlungsmittel, Gutscheinausgabe, UID-Buchungen und Rücknahmen bleiben maßgeblich.

Identitäten und Benachrichtigungscursor, Inhaltsvergleiche sowie Dateien und Schlüsselzuordnungen sind übernommen und geprüft. PostgreSQL-Backup/Restore und die vollständige Gesamtprobe sind bestätigt. Für den finalen Wechsel sind 30–45 Minuten GP-Unterbrechung einzuplanen. Erst der vollständige Abgleich des dann aktuellen Bestands, die produktive Funktionsprüfung und die erste gemeinsame Sicherung schließen Block 12 ab.
