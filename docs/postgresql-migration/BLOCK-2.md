# Block 2: Isolierte PostgreSQL-Umgebung

Stand 12.09.2026, Entwicklung ohne produktive Anbindung. Nach Abschluss des Inventars wurde eine eigene PostgreSQL-18.6-Instanz angelegt, unter `/home/gpadmin/grabenplaner-pg-migration-20260912`. Sie verwendet ein eigenes Datenverzeichnis und ausschließlich synthetische Daten. Die GP-SQLite-Datei und der Lebensatlas-Cluster `18/main` bleiben unverändert.

## Konfiguration

- Datenbanken: `gp_migration_core` und `gp_migration_sales`. Die abweichenden Entwicklungsnamen verhindern Verwechslungen mit späteren Produktivzielen.
- Nur `127.0.0.1:55482`, keine öffentliche Bindung. Temporärer SSH-Tunnel auf dem Arbeitsrechner `127.0.0.1:55483`; keine Änderung an SSH-, Firewall- oder Tailscale-Konfiguration.
- PostgreSQL-Prozess ohne neue systemd-Unit, mit niedriger CPU-Priorität. 20 Verbindungen, 64 MiB Shared Buffers, 4 MiB Work Memory, 32 MiB Maintenance Work Memory. Diese Testgrenzen sind keine produktive Dimensionierung.
- Für die atomare Anlage der 191 Core-Tabellen samt Regeln gilt `max_locks_per_transaction=256`. Die anfängliche Standardgrenze reichte für diesen DDL-Lauf nicht; ausschließlich die eigene Entwicklungsinstanz wurde dafür neu gestartet.
- Eigene SCRAM-Zugangsdaten. Serververzeichnis privat (0700); Dateien mit umask 077. Lokale Zugangsdaten ausschließlich unter einem ignorierten Verzeichnis mit entfernter ACL-Vererbung und Zugriff für den aktuellen Benutzer/SYSTEM. Keine Secrets im Repository oder Bericht.
- Getrennte Owner ohne Login, Migratoren, schreibende Anwendungen und Leser pro Datenbank. Keine Superuser-, CreateDB-, CreateRole-, Replikations- oder RLS-Bypass-Rechte für diese sechs Zugänge. Der lokale Bootstrap-Administrator gehört nur zu dieser eigenen Testinstanz.
- Anwendungen können weder Schema/Owner ändern noch in die andere Datenbank oder in die Wartungsdatenbanken `postgres` und `template1` verbinden. Diese Wartungszugriffe bleiben dem eigenen Bootstrap-Administrator vorbehalten. Tabellenbesitzer bleiben die jeweiligen Owner ohne Login; Migratoren verwenden sie ausdrücklich zur Schemaanlage, Anwendungen erhalten nur vorgesehene DML-Rechte.

## Programmgrenze

`lib/persistence/postgresql/core/environment.js` verlangt das Profil `core-migration-development`, die exakten Datenbank-/Rollennamen und den privaten Environment-Marker. URL-Optionen und produktive Datenbanknamen werden zurückgewiesen. Standard ist vollständige TLS-Prüfung; unverschlüsselter Transport ist nur für Loopback zulässig. Der SSH-Tunnel verschlüsselt die Verbindung über das Netzwerk.

Poolgrenzen nach Block 8: drei Verbindungen je Core-Anwendungspool, zwei je Sales-Anwendungspool, eine je Leser-/Migratorpool; 10 Sekunden Statement-, 12 Sekunden Client- und 30 Sekunden Idle-Transaktionslimit. Es gibt weiterhin keine Freigabe des produktiven `DB_PROVIDER=postgresql`.

Ergänzung aus Block 8: Die Core-App-Rolle der eigenen Entwicklungsinstanz erhält ein Verbindungslimit von acht (drei unabhängige Core-Verbindungen, drei Grenzabfragen, eine Koordination, eine Reserve), die Sales-App-Rolle sieben. Fünf Core-Verbindungen reichten im Fünf-Benutzer-Test einschließlich aktueller Rechteprüfung nicht. Die drei Beleg-Worker und der Berichts-Worker verwenden jeweils eigene begrenzte Leserzugänge; die Leserrollen bleiben auf fünf Verbindungen je Datenbank begrenzt. Der kleinere Sales-Anwendungspool hält dafür Platz innerhalb des Clusterlimits von 20 frei. `tune-development-pools.js` prüft Datenverzeichnis, Port, Bootstrap-Benutzer und Datenbank vor dieser ausschließlich lokalen Entwicklungsänderung. Dies ist noch kein produktiver Kapazitätsplan.

## Reproduktion und Lebenszyklus

Von den 20 Clusterverbindungen sind drei PostgreSQL-Superuser-Verbindungen reserviert. Für normale Rollen stehen somit 17 bereit. Eine frühe Probe mit drei Beleg-Workern und zusätzlichen eigenständigen Fixture-Pools erreichte diese Grenze und brach den Berichtsauftrag kontrolliert ab. Der bereinigte Aufbau schließt die unbenutzten Fixture-Anwendungspools: drei Core-App-Verbindungen, eine Koordination, zwei Sales-App-Verbindungen, ein eigener Core-Leser für frische Autorisierung, jeweils zwei Leser für drei Beleg-Worker und einen Berichts-Worker sowie zwei Fixture-Migratoren ergeben höchstens 17 normale Verbindungen. Das PostgreSQL-Reservelimit bleibt unverändert.

`scripts/postgresql/create-isolated-environment.sh` erstellt nur den exakt benannten neuen Entwicklungsbereich und verweigert vorhandene Ziele. Es ist kein allgemeiner VPS-Installer. `mark-development-environment.js` legt die getrennten Marker an. `run-development.js` reicht private Verbindungsdaten nur an lokale Unterprozesse weiter; Werte werden nicht ausgegeben.

Die Instanz wurde für Block 3/4 verwendet und nach Abschluss am 12.09.2026 kontrolliert gestoppt. Port 55482 ist ohne Listener; auch der eigene lokale SSH-Tunnel auf 55483 wurde beendet. Alle 191 Core-Anwendungstabellen und die Artikelreferenztabelle sind nach den synthetischen Tests leer, Schema/Marker/Ledger bleiben erhalten. Ein erneuter Start prüft Ownership-Marker, absolutes Datenverzeichnis und Port, bevor `pg_ctl` arbeitet. Produktivdienste wurden nicht neu gestartet.

Nach der Fortsetzung mit Block 5–8 wurde die eigene Instanz erneut kontrolliert gestoppt. Der aktuelle Abschlussnachweis umfasst 198 leere Core- und 61 leere Sales-Tabellen einschließlich technischer Referenzen und Fixture-Marker. Beide Schemaverträge stimmen mit ihren Ledgers überein. Ports 55482 und 55483 sind ohne Listener; der produktive GP läuft mit unverändertem Hauptprozess und HTTP 200 weiter.

## Nachweis

Echte PostgreSQL-Prüfungen: alle sechs Rollen/Marker geprüft, Core/Sales-Zugriff jeweils in Gegenrichtung abgewiesen, DDL-/Owner-/Markeränderungen für App/Reader abgewiesen. Zusätzlich wird ein echter Statement-Timeout ausgelöst und die anschließende Nutzbarkeit der Verbindung geprüft. Die Konfigurationstests prüfen falsches Profil, Produktivdatenbank, falsche Rolle, URL-Optionen und unverschlüsselten Fremdhost.

Dieser Nachweis betrifft die isolierte Umgebung. Anwendungsschema, Vollanwendungsparität, Produktionsbackup und Cutover bleiben eigene nachfolgende Blöcke.
