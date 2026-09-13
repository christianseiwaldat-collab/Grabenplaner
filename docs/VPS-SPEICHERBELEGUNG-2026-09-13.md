# VPS-Speicherbelegung nach der PostgreSQL-Migration

**Nachtrag:** Die folgende Aufstellung ist die Ausgangsmessung. Anschließend
wurde die ausdrücklich beauftragte Bereinigung ausgeführt: rund 88,70 GB frei,
zwei vollständige PostgreSQL-Sicherungspaare und lokal archivierte
Migrationsquelle. Ablauf und Nachweise: [Zwei Sicherungspunkte](VPS-ZWEI-SICHERUNGEN-2026-09-13.md).

Am 13.09.2026 erneut ausschließlich lesend gemessen. Keine Sicherungen,
Quelldateien, Verzeichnisse oder Datenbankinhalte gelöscht; keine Dienste
gestoppt oder neu gestartet.

Die zuvor genannten 19,37 GB bezeichneten den freien Platz auf dem **gesamten
VPS-Dateisystem**, nicht die Größe der GP-Datenbanken. Die erste Aufstellung
enthielt nicht alle GP-Sicherungsordner. Diese vollständige Aufstellung ergänzt
insbesondere den zweiten großen SQLite-Sicherungsbereich, die CRM-Importsicherung
und zwei weitere Offsite-Prüfbereiche.

## Gemessene Belegung

Alle Größen in dezimalen GB. Dateisystem: 102,92 GB insgesamt, 83,52 GB belegt,
19,38 GB verfügbar. Leichte Änderungen durch den laufenden Betrieb sind normal.

| Bereich | Größe |
| --- | ---: |
| Laufender GP-PostgreSQL-Cluster | 3,26 GB |
| Erhaltener SQLite-Bestand und bisherige GP-Dateien | 2,59 GB |
| GP-Sicherungen über vier Bereiche | 44,58 GB |
| Migrations- und Qualifikationsbereiche | 24,16 GB |
| Betriebssystem, Programme und übrige belegte Daten | ca. 8,92 GB |

Die beiden größten Gruppen entstehen durch Kopien und Sicherungen; sie sind
keine Vergrößerung des laufenden GP-Datenbestands auf 80 GB.

### Sicherungen: 44,58 GB

| Pfad | Bytes | Größe |
| --- | ---: | ---: |
| `/var/lib/grabenplaner/backups` | 17881686016 | 17,88 GB |
| `/var/backups/grabenplaner` | 22396665856 | 22,40 GB |
| `/var/backups/grabenplaner-crm-import-20260908` | 2288541696 | 2,29 GB |
| `/var/backups/grabenplaner-postgresql` | 2013151232 | 2,01 GB |

Die beiden bisherigen SQLite-Sicherungsbereiche enthalten sowohl Archiv-
Repositorys als auch aufbewahrte Rohkopien beziehungsweise temporäre Prüfdaten.
Es sind also nicht vier neue PostgreSQL-Datenbanken. Die PostgreSQL-Paarsicherungen
sind der gegenwärtige Sicherungsweg für Core und Sales samt zugehörigen Dateien.

### Migrations- und Qualifikationsbereiche: 24,16 GB

| Pfad | Bytes | Größe |
| --- | ---: | ---: |
| `/var/lib/grabenplaner-postgresql/migration` | 5199650816 | 5,20 GB |
| `/home/gpadmin/grabenplaner-pg-migration-20260912` | 14612787200 | 14,61 GB |
| `/var/lib/grabenplaner-offsite/postgresql-qualification-20260912` | 2014363648 | 2,01 GB |
| `/var/lib/grabenplaner-offsite/postgresql-recovery-qualification-20260912` | 2336628736 | 2,34 GB |

Die erste Aufstellung hatte die ersten beiden Pfade, zusammen 19,81 GB, bereits
erfasst. Die jetzt zusätzlich erfassten Offsite-Qualifikationsbereiche enthalten
weitere 4,35 GB. Das sind vorhandene lokale Test-/Wiederherstellungskopien,
keine Größenangabe über das entfernte Offsite-Repository.

## Konsequenz

Die Einschätzung des Benutzers von ungefähr 2–4 GB für den laufenden GP-Bestand
passt zur gemessenen PostgreSQL-Größe von 3,26 GB. Für die Erklärung des fast
vollen VPS müssen zusätzlich die Sicherungs- und Übergangskopien betrachtet
werden. Ein normaler Deploy wiederholt nicht die gesamte Migration.

Ein sinnvoller anschließender Bereinigungsschritt wäre, abgeschlossene
Migrations-/Prüfkopien sowie überholte SQLite- und Importsicherungen mit den
aktuellen PostgreSQL-Rückkehrnachweisen und Aufbewahrungsregeln abzugleichen.
Erst danach lässt sich eine konkrete Löschliste mit freigebbarem Umfang
festlegen. Die gesamten 68,74 GB dieser beiden großen Gruppen sind ausdrücklich
keine pauschale Löschfreigabe; aktuelle Rückkehrpunkte und benötigte Originale
müssen erhalten bleiben. In diesem Auftrag wurde ausschließlich gemessen.

## Nachweis

Lokaler Messbeleg: `tmp/vps-storage-readonly-20260913.json`, beobachtet am
13.09.2026, 18:57:51 UTC. Messung über die bestehende SSH-Route, Dateisystem-
Statistik und begrenztes `du -x -s -B1` mit niedriger I/O-/CPU-Priorität. Es
wurden Verzeichnisgrößen und keine privaten Datenbankinhalte ausgelesen.
