# PostgreSQL-Betrieb und Recovery im nicht produktiven Status

**Status:** Block 6/7 als nicht produktiver `development-contract` lokal
abgenommen; keine Produktiv-, Support- oder Cutoverfreigabe<br>
**Stand:** 13.08.2026<br>
**Produktiver Datenbankprovider:** weiterhin ausschließlich SQLite<br>
**PostgreSQL-Produktaktivierung:** `false`

## 1. Zweck und Abnahmegrenze

Dieses Dokument beschreibt den in Block 6/7 entwickelten PostgreSQL-Pfad für
Backup, isolierten Restore, Monitoring und Recovery Assurance. Es konkretisiert
die Betriebs- und Recovery-Anteile aus der
[Datenbank-Provider-Strategie](DATENBANK-PROVIDER-STRATEGIE.md) und ergänzt den
[PostgreSQL-Provider im nicht produktiven Status](DATENBANK-POSTGRESQL-PROVIDER.md).

Block 6 schafft eine providergebundene, fail-closed Entwicklungsgrundlage. Er
aktiviert weder PostgreSQL im normalen Serverstart noch einen Zeitplan,
System-Center-Schalter, Produktivjob oder automatischen Cutover. Die
Produktkonfiguration und alle bestehenden Installationen bleiben auf SQLite.

Block 6 schließt die weiterhin offene Phase-5-Parität nicht:

- Vollanwendungskatalog PostgreSQL: **0/1115** akzeptierte Live- und
  Paritätsnachweise;
- PostgreSQL-Anwendungsmigrationen: **0/10** implementiert;
- `applicationExecutable`: `false`;
- `productActivation`: `false`.

Diese beiden Gates bleiben zwingende Voraussetzungen vor jeder konkreten
Installation oder Migration in Block 7.

## 2. Implementierter Entwicklungsumfang

| Bereich | Implementierter Stand in Block 6 | Produktstatus |
| --- | --- | --- |
| Betriebsvertrag | providerneutraler Capability-Report und enge Betriebsfassade ohne Raw-Handle | nur `development-contract` |
| Backup-Bundle | Schema v2 mit Provider, Methode, Datenbank-, Dokument- und Verifikationsbindung | nicht in den Produktserver eingebunden |
| PostgreSQL-Backup | `pg_dump --format=custom` aus einem exportierten PostgreSQL-Snapshot | lokal testbar, nicht geplant ausgeführt |
| Dokumentkonsistenz | Mutation-Quiesce-Vertrag, vollständiges AMU-Manifest und Datenbank-/Snapshotbindung | Serverintegration noch offen |
| Restore | Wiederherstellung ausschließlich in ein neu angelegtes, leeres und isoliertes Ziel | kein In-place- oder Produktiv-Restore |
| Evidenz | kanonischer Fingerprint für Schema, Constraints, Indizes, Daten, Migrationsledger und Dokumentreferenzen | nicht für die Vollanwendung abgenommen |
| Recovery Assurance | signierbarer, provider- und methodengebundener Belegvertrag v2 | kein produktiver Orchestrator |
| Monitoring | read-only PostgreSQL-Metriken plus bindende Capability-Evidence | nicht im System-Center aktiviert |
| Retention | Löschen ausschließlich vollständig verifizierter Bundle-v2-Sicherungspunkte | kein freigegebener Produktzeitplan |

Die maßgeblichen Module sind:

- [`lib/backup-bundle.js`](../lib/backup-bundle.js);
- [`lib/persistence/operations/contract.js`](../lib/persistence/operations/contract.js);
- [`lib/persistence/operations/mutation-quiesce.js`](../lib/persistence/operations/mutation-quiesce.js);
- [`lib/persistence/operations/recovery-assurance.js`](../lib/persistence/operations/recovery-assurance.js);
- [`lib/persistence/postgresql/operations/tools.js`](../lib/persistence/postgresql/operations/tools.js);
- [`lib/persistence/postgresql/operations/snapshot.js`](../lib/persistence/postgresql/operations/snapshot.js);
- [`lib/persistence/postgresql/operations/evidence.js`](../lib/persistence/postgresql/operations/evidence.js);
- [`lib/persistence/postgresql/operations/backup.js`](../lib/persistence/postgresql/operations/backup.js);
- [`lib/persistence/postgresql/operations/restore.js`](../lib/persistence/postgresql/operations/restore.js);
- [`lib/persistence/postgresql/operations/recovery-assurance.js`](../lib/persistence/postgresql/operations/recovery-assurance.js);
- [`lib/persistence/postgresql/operations/monitor.js`](../lib/persistence/postgresql/operations/monitor.js).

## 3. Backup-Vertrag

### 3.1 PostgreSQL-Sicherungspunkt

Ein PostgreSQL-Sicherungslauf verwendet einen expliziten
`REPEATABLE READ READ ONLY`-Transaktionssnapshot und
`pg_export_snapshot()`. Während dieser Snapshot offen ist, werden:

1. der kanonische Quell-Evidence-Fingerprint gelesen;
2. die referenzierten geschützten Dokumente ermittelt;
3. ein Custom-Format-Dump mit genau diesem Snapshot erzeugt;
4. der Dump mit `pg_restore --list` strukturell geprüft;
5. die verschlüsselte Dokumentablage in einem Quiesce-Fenster gesichert;
6. Datenbankdump, Dokumentmanifest und Snapshot-Evidence miteinander
   verbunden;
7. erst danach die Komponenten und der Commitmarker veröffentlicht.

Der Dump-Aufruf enthält insbesondere:

- `--format=custom`;
- `--no-owner`;
- `--no-privileges`;
- `--snapshot=<exportierter Snapshot>`;
- genau das konfigurierte Anwendungsschema;
- einen zuvor nicht vorhandenen absoluten Ausgabepfad.

Der PostgreSQL-Clientwerkzeug-Major muss der festgelegten Version exakt
entsprechen. Der lokale und der CI-Vertrag sind derzeit auf PostgreSQL 18
beziehungsweise die real geprüfte Version 18.4 ausgerichtet.

### 3.2 Backup-Bundle v2

Das Bundle v2 enthält ausschließlich die festgelegten Metadaten:

- `providerId`, `method`, `snapshotId`, `createdAt` und `appVersion`;
- Datenbankdatei, SHA-256, Byteanzahl, Format und Tool-Major;
- Dokumentordner, Manifestdatei, Manifest-SHA-256, Größen und Dateianzahl;
- Verifikationsstatus, Zeitpunkt und die drei positiven Checks
  `databaseComponent`, `protectedDocumentsComponent` und `providerMethod`;
- einen kanonisch gebildeten `bundleHash`.

Pfade zu Hosts, Datenbanken, Rollen, Service- oder Passwortdateien sowie
Connection-Strings und Secrets sind keine zulässigen Bundlefelder. Unbekannte
oder zusätzliche Felder scheitern geschlossen.

Der Commitmarker wird zuerst exklusiv als `.partial-*` geschrieben,
dateisystemseitig synchronisiert und erst danach atomar umbenannt. Ein Bundle
gilt nur dann als vollständig, wenn Marker, Datenbankdatei und
Dokumentkomponente erneut verifiziert werden können. Partielle Marker,
symbolische Links, Hardlinks, unerwartete Dateien und manipulierte Hashes
werden nicht gelistet und nicht durch Retention gelöscht.

### 3.3 Bindung der geschützten Dokumente

Das AMU-Manifest ist nicht nur eine benachbarte Datei. Es muss exakt an den
Sicherungspunkt gebunden sein:

- `database.fileName` und `database.sha256` entsprechen der
  Datenbankkomponente im Bundle;
- Provider, Sicherungsmethode und `snapshotId` entsprechen dem Bundle;
- der Quell-Evidence-Fingerprint und die Anzahl der Datenbankreferenzen sind
  festgehalten;
- Schlüsselprüfwert und jede verschlüsselte Dokumentdatei werden über
  Dateiname, Größe und SHA-256 geprüft;
- nicht manifestierte, doppelte, verlinkte oder fehlende Dateien führen zum
  Abbruch.

Das Mutation-Quiesce-Modul blockiert neue Dokumentmutationen, wartet begrenzt
auf bereits laufende Mutationen und öffnet erst bei `pendingMutations: 0` das
Sicherungsfenster. Vor einer späteren Produktaktivierung muss nachgewiesen
werden, dass **alle** produktiven Dokumentmutationen tatsächlich über dieses
Gate laufen. Block 6 verdrahtet dieses Gate noch nicht in `server.js`.

### 3.4 SQLite-Abgrenzung

Das bestehende SQLite-Backup-Schema 1 bleibt unverändert und getrennt. Gemischte
Verzeichnisse werden unterstützt, ohne v1-Sicherungspunkte als Bundle v2 zu
interpretieren oder durch die v2-Retention zu entfernen. Diese Trennung ist
kein automatischer Import und kein Providerwechsel.

## 4. Isolierter Restore-Nachweis

Der Restore-Pfad ist ausschließlich ein zerstörungsfreier
Wiederherstellungsnachweis:

1. das vollständige Bundle wird erneut provider- und methodengebunden
   verifiziert;
2. `pg_dump`- und `pg_restore`-Major werden geprüft;
3. ein neues, leeres und von der Quelle verschiedenes Ziel wird angelegt;
4. das Zielbinding wird kryptografisch an Service-Namen und
   Servicekonfigurationsdatei gebunden;
5. `pg_restore` läuft mit `--single-transaction`, `--exit-on-error`,
   `--no-owner` und `--no-privileges`;
6. die verschlüsselte Dokumentablage wird in einen separaten Scratch-Pfad
   restauriert;
7. Quell- und Ziel-Evidence sowie sämtliche Dokumentreferenzen werden
   verglichen;
8. ein Anwendungssmoke-Test muss positiv zurückkehren;
9. Scratch-Datenbank und Scratch-Dokumente werden auch nach Fehlern
   vollständig entfernt.

Ein bereits befülltes, nicht isoliertes oder während des Laufs umgebundenes
Ziel scheitert geschlossen. Cleanupfehler dürfen einen ansonsten erfolgreichen
Restore nicht grün erscheinen lassen.

Der aktuelle Restore-Pfad ist kein Werkzeug zum Überschreiben einer laufenden
Installation. Ein produktiver Restore, ein Umschalten von Verbindungen und ein
Rückkehrplan gehören erst in eine separat freigegebene Installation.

## 5. Monitoring

Der PostgreSQL-Monitor akzeptiert nur eine ausdrücklich bestätigte
Betriebsgrenze:

- eigene Operations-Identität mit identischem `current_user` und
  `session_user`;
- Mitgliedschaft in `pg_monitor`, keine sonstige direkte Rollenmitgliedschaft
  und keine privilegierten Rollenflags;
- zwingend read-only Transaktion;
- die Monitorabfrage selbst enthält weder DML noch DDL.

Er liest nur:

- PostgreSQL-Server-Major und Recovery-Zustand;
- Datenbankgröße;
- gesamte, aktive, wartende und in Transaktion leerlaufende Verbindungen;
- Commit-, Rollback- und Deadlockzähler.

Resultatfelder, Reihenfolge, Typen und kanonische Zahlenwerte werden exakt
geprüft. Fehlertexte oder Verbindungsdaten werden nicht als öffentliche
Diagnose übernommen.

Diese Prüfung beweist noch nicht die vollständige Rechteausstattung der
Operations-Rolle: Objekt-, Schema- und Datenbankprivilegien sowie
`ADMIN OPTION` werden im aktuellen Monitor nicht vollständig negativ geprüft.
Vor Produktivierung sind deshalb echte Rechte-Negativtests erforderlich.

Der Monitor bindet seine Aussage an den providerneutralen Capability-Report.
Fehlende, veraltete, zukünftige oder zu Provider, Profil, Methode oder
Artefaktformat widersprüchliche Evidence wird als `unknown`, `warning` oder
`error` ausgewiesen. Auch bei vollständig grüner technischer Evidence bleibt
der Zustand unter `development-contract` nur `development`; er wird nicht
`supported`.

Block 6 bindet den Monitor noch nicht in das produktive System-Center, eine
Alarmierungsplattform oder einen Bereitschaftsprozess ein.

## 6. Recovery Assurance

Der Recovery-Assurance-Vertrag v2 bindet einen Beleg an:

- Provider, Profil und Backupmethode;
- Bundle-Hash, Datenbankartefakt und Dokumentmanifest;
- Quell- und Ziel-Evidence-Fingerprint;
- den Hash des Restore-Belegs;
- App-Version und Ausführungskennung;
- einen Ed25519-Schlüssel, Beleg-Hash und Signatur.

Die festgelegten Phasen sind:

1. `backup`;
2. `offsiteUpload`;
3. `repositoryReadCheck`;
4. `isolatedRestore`;
5. `schemaVerification`;
6. `protectedDocumentsVerification`;
7. `applicationSmoke`;
8. `scratchCleanup`.

Ein erfolgreicher Gesamtbeleg erfordert für jede Phase `passed`, identische
Quell- und Ziel-Fingerprints und eine gültige Signatur. Alte oder aus der
Zukunft stammende Belege werden nicht als aktuell behandelt. Ein technisch
gültiger Beleg bleibt bei Profil `development-contract` trotzdem
`effective: false`.

Der PostgreSQL-Adapter bindet einen geprüften Backup- und Restore-Lauf an
diesen Belegvertrag. Ohne zusammengehörige externe Evidence für
`offsiteUpload` und `repositoryReadCheck` erzeugt er bewusst nur einen
fehlgeschlagenen Gesamtbeleg. Vertrag, Bindung und Negativfälle sind
automatisiert getestet.

Block 6 enthält jedoch noch keinen produktiven Orchestrator, der
Offsite-Upload, Repository-Read-Check, Restore, Signierung, Ablage und
Alarmierung regelmäßig ausführt. Insbesondere darf ein bestehender
SQLite-Offsite-Nachweis nicht als PostgreSQL-Nachweis verwendet werden.

## 7. Rollen und Secrets

### 7.1 Getrennte Rollen

| Rolle | Zweck | Block-6-Grenze |
| --- | --- | --- |
| `application` | fachliche Lese- und Schreibzugriffe | erhält keine Backup-, Restore-, DDL- oder Betriebsrechte |
| `migration` | kontrollierte Schema- und Ledgeränderungen | bleibt vom App- und Backupprozess getrennt |
| `backup` | konsistenter lesender Dump der festgelegten Anwendungsobjekte | kein DML, DDL, Restore oder Rollenmanagement |
| `operations` | read-only Monitoring und Diagnose | kein fachliches DML, DDL oder Signalrecht |

Der Restore-Nachweis verwendet ein getrenntes Service-/Zielbinding für die
leere Scratch-Datenbank. Der lokale Live-Test nutzt für Quelle und Ziel noch
dieselbe synthetische Test-Loginrolle; eine eigenständige Restore-Zielrolle ist
vor Produktivierung separat nachzuweisen. Block 6 erzeugt oder verteilt keine
produktiven Rollen; die Rollenanlage und ihre Negativtests sind
installationsbezogene Abnahmepunkte.

### 7.2 Secret-Transport

PostgreSQL-Werkzeuge erhalten keine URL und kein Passwort als
Kommandozeilenargument. Zulässig sind nur:

- `PGSERVICE`;
- `PGSERVICEFILE`;
- `PGPASSFILE`;
- ein geheimnisfreier `PGAPPNAME`;
- die festgelegte Verbindungszeitgrenze und Locale.

Service- und Passwortdatei müssen absolute, reguläre, unverlinkte Dateien mit
genau einem Hardlink sein. Unter Unix dürfen Gruppe und andere Benutzer keine
Dateirechte besitzen. Unter Windows muss die äquivalente ACL vor einer realen
Installation zusätzlich betrieblich geprüft werden.

Backup-, Restore-, Operations- und Signaturschlüssel dürfen nicht
zusammengelegt werden. Secrets erscheinen weder in Bundle, Recovery-Beleg,
Capability-Report, Monitoringausgabe noch Fehlernachrichten. Rotation erfolgt
als kontrollierter Credential- beziehungsweise Pooltausch; eine Mutation
laufender Credentialobjekte ist nicht zulässig.

## 8. RPO und RTO

Block 6 legt bewusst noch kein produktweites Service-Level fest. Ohne
installationsbezogene, verantwortete Zielwerte gibt es keine belastbare
RPO-/RTO-Zusage.

| Ziel | Verbindlicher Block-6-Stand | Vor Block 7 erforderlich |
| --- | --- | --- |
| RPO – maximal tolerierter Datenverlust | noch nicht festgelegt; `maximumAgeHours` bewertet nur die Aktualität eines Nachweises | Sicherungsintervall, Offsite-Verzögerung, Alarmgrenze und tolerierter Verlust müssen je Installation beschlossen und durch einen vollständigen Lauf gemessen werden |
| RTO – Zeit bis zum verifizierten Wiederanlauf | noch nicht festgelegt; das 120-Sekunden-Testtimeout des Live-Tests ist kein RTO | Zeit für Incident-Entscheidung, Artefaktabruf, Zielaufbau, Restore, Dokumentprüfung, Smoke-Test und kontrollierte Aktivierung muss unter realitätsnaher Datenmenge gemessen werden |

Die in Tests verwendeten Evidence-Altersgrenzen von beispielsweise 24 Stunden
sind Testwerte und kein zugesagtes RPO. Ebenso ist eine erfolgreiche schnelle
synthetische Wiederherstellung kein zugesagtes RTO.

Vor einer konkreten Migration müssen mindestens dokumentiert sein:

- RPO-Ziel und daraus abgeleitetes Backupintervall;
- RTO-Ziel und gemessene End-to-End-Dauer;
- maximale Evidence-Alter für Backup, Restore und Recovery Assurance;
- Eskalationsweg bei Überschreitung;
- Aufbewahrung lokal und offsite;
- fachlich verantwortete Abnahme der Werte.

## 9. Wartung und Betriebsablauf

Vor jedem späteren Sicherungs- oder Restorejob sind mindestens zu prüfen:

- festgelegter PostgreSQL- und Clientwerkzeug-Major;
- private, ausreichend große Backup- und Scratch-Verzeichnisse;
- getrennte und gültige Rollen-/Service-Credentials;
- erfolgreicher Capability-Preflight;
- funktionierendes Dokument-Mutation-Gate;
- freier, isolierter Restore-Zielname;
- verfügbare Signatur- und Offsite-Infrastruktur, sofern der vollständige
  Recovery-Assurance-Lauf ausgeführt werden soll.

Für einen freigegebenen Regelbetrieb wären zusätzlich erforderlich:

- geplanter Backupjob passend zum RPO;
- Alarmierung bei Fehler, fehlender Evidence oder Überschreitung des
  maximalen Evidence-Alters;
- regelmäßiger isolierter Restore passend zum vereinbarten Assurance-Zyklus;
- kontrollierte Retention ausschließlich nach erfolgreicher Bundleprüfung;
- Offsite-Upload plus unabhängiger Repository-Lesetest;
- Rotation von Rollen-Credentials und Signaturschlüsseln;
- erneuter Restore-Nachweis vor und nach PostgreSQL-Major- oder
  Toolchainwechseln;
- dokumentierter Wartungseigentümer und Vertretung.

Die Funktion `pruneBackupBundles(...)` besitzt technisch einen Standardwert von
30 zu behaltenden verifizierten Bundles. Dieser Funktionsstandard ist keine
freigegebene Aufbewahrungsrichtlinie und wird ohne Produktintegration nicht
automatisch ausgeführt.

## 10. Reale Abnahme am 30.07.2026

### 10.1 Lokal ausgeführt

Der kombinierte lokale PostgreSQL-Entwicklungsvertrag für Block 5 und Block 6
wurde gegen PostgreSQL 18.4 mit **121/121 bestandenen Tests** und
**0 Fehlern** ausgeführt.

Davon wurde der reale Restore-E2E-Fall separat mit **1/1 bestanden**. Er weist
nach:

- reale Quell- und Scratch-Zieldatenbank;
- gepinnte reale `pg_dump`-/`pg_restore`-Werkzeuge;
- exportierten Snapshot bei gleichzeitig fortgesetztem Quellschreiben;
- Custom-Dump und Restore in einer einzelnen Transaktion;
- Schema, Primär- und Check-Constraint;
- Migrationsledger und kanonische Quell-/Ziel-Evidence;
- zwei verschlüsselte, aus der Datenbank referenzierte PDF-Dateien;
- echtes Drain und Sperren konkurrierender Dokumentmutationen über das
  Mutation-Gate;
- read-only Monitoring mit einer getrennten synthetischen `pg_monitor`-Rolle;
- identischen Dokumentinhalt nach dem Restore;
- einen an den realen Run gebundenen signierten Recovery-Beleg, der fehlende
  Offsite-/Readback-Evidence ausdrücklich als nicht technisch gültig ausweist;
- vollständiges Entfernen des Scratch-Ziels;
- fail-closed Ablehnung eines beschädigten Dump-Artefakts.

Der E2E-Fall verwendet ein bewusst kleines synthetisches
`grabenplaner`-Schema. Er ist ein realer Betriebsweg-Nachweis, aber **kein**
Vollanwendungs-Restore: Die Gates 0/1115 und 0/10 bleiben unverändert.

Die lokale Block-5/6-Abnahme allein behauptet keinen vollständigen
plattformübergreifenden `pnpm test`-Gesamtlauf. Der nachfolgend dokumentierte
externe GitHub-Actions-Lauf enthält zusätzlich vollständige Ubuntu- und
Windows-Suiten; auch diese ersetzen keine Vollanwendungsparität.

### 10.2 Externer GitHub-Actions-Nachweis

Der Workflow [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) enthält
den Job `postgresql-provider-development-contract` mit:

- Node.js 22.13.0;
- `postgres:18.4-alpine`;
- PostgreSQL-Clientwerkzeugen 18 aus PGDG;
- allen Block-5- und Block-6-Vertrags-, Negativ- und Live-Tests einschließlich
  des realen Restore-E2E-Falls.

Der veröffentlichte Integrationscommit `25fab8e` wurde im
[GitHub-Actions-Lauf 30508095599](https://github.com/christianseiwaldat-collab/Grabenplaner/actions/runs/30508095599)
extern geprüft. Alle vier Jobs sind grün:

- `postgresql-provider-development-contract` mit PostgreSQL 18.4;
- vollständige Testsuite auf Ubuntu;
- vollständige Testsuite auf Windows;
- Provider- und Block-4-Verträge auf der Node-Mindestversion.

Damit ist das nicht produktive externe CI-Gate für diesen Integrationscommit
erfüllt. Der Lauf aktiviert keine Produktcapability und ersetzt weder 1115/1115
Vollanwendungsparität noch 10/10 Anwendungsmigrationen oder eine
installationsbezogene Betriebsfreigabe.

## 11. Capability-Stand nach Block 6

| Capability | Entwicklungsnachweis | Produktive Capability |
| --- | --- | --- |
| Datenbankbackup | realer PostgreSQL-Custom-Dump lokal grün | `false` |
| Restore | realer isolierter Restore lokal grün | `false` |
| Integritätsprüfung | Bundle-, Manifest-, Artefakt- und Evidence-Prüfungen grün | `false` |
| Recovery Assurance | signierter Belegvertrag getestet; vollständige produktive Orchestrierung offen | `false` |
| System-Center-Status | read-only Monitoradapter und Negativtests vorhanden; keine UI-/Serverintegration | `false` |
| Gekoppeltes Dokumentbackup | realer verschlüsselter Dokument-Roundtrip grün; produktive Quiesce-Verdrahtung offen | `false` |
| Point-in-Time-Recovery | nicht implementiert | `false` |
| Mehrinstanzbetrieb | nicht Gegenstand dieses Blocks | `false` |

Die technische Implementierung einzelner Operationsmodule darf nicht als
Produktfähigkeit ausgegeben werden. Der No-Cutover-Test hält deshalb
`POSTGRESQL_CAPABILITIES` für alle obigen Produktfähigkeiten geschlossen.

## 12. Ausdrückliche Nichtziele

Block 6 enthält nicht:

- Aktivierung von `DB_PROVIDER=postgresql`;
- Änderung des produktiven SQLite-Pfads;
- produktiven Zeitplan, System-Center-Schalter oder Serverjob;
- Migration oder Cutover einer Installation;
- Block 7;
- vollständige PostgreSQL-Anwendungsparität;
- eine der neun PostgreSQL-Anwendungsmigrationen;
- Point-in-Time-Recovery oder WAL-Archivierung;
- physische PostgreSQL-Sicherungen;
- Hochverfügbarkeit, Replikation, Failover oder Multi-Region;
- Mehrinstanzfreigabe;
- automatischen Offsite-Upload oder Repository-Read-Check;
- zugesagtes RPO oder RTO;
- Auswahl eines Datenbankanbieters;
- Release, Push, Deployment oder VPS-Aktualisierung.

## 13. Gates vor einer Block-7-Installationsfreigabe

Vor einer konkreten freiwilligen Installation oder Migration müssen
mindestens alle folgenden Punkte separat abgenommen sein:

- [ ] PostgreSQL-Vollanwendungskatalog: 1115/1115 akzeptierte Live- und
      Paritätsnachweise;
- [ ] PostgreSQL-Anwendungsmigrationen: 10/10 implementiert und mit historischen
      Beständen geprüft;
- [ ] vollständiger Funktions-, Konkurrenz- und Lastlauf auf realitätsnahen
      Daten;
- [x] grüner externer GitHub-Actions-E2E-Lauf für Integrationscommit `25fab8e`
      mit Run `30508095599`;
- [ ] produktive Verdrahtung des Dokument-Mutation-Gates;
- [ ] reale Rollen-, Secret-, TLS- und Dateiberechtigungsabnahme;
- [ ] geplanter Backup-, Offsite-, Retention- und Monitoringbetrieb;
- [ ] vollständiger Recovery-Assurance-Orchestrator samt Signaturschlüssel;
- [ ] installationsbezogenes und gemessenes RPO/RTO;
- [ ] Cutover-, Rückkehr- und Incidentplan;
- [ ] ausdrückliche Freigabe für genau diese Installation.

Bis dahin bleibt SQLite der einzige unterstützte und produktive
Datenbankprovider.

## 14. Block-7-Startprüfung am 30.07.2026

Block 7 ist als installationsbezogene Gate-Prüfung gestartet. Das Ergebnis ist
**NO-GO**:

- Es ist keine konkrete Zielinstallation ausgewählt oder für eine Migration
  freigegeben.
- Der PostgreSQL-Vollanwendungskatalog steht bei 0/1115.
- Die PostgreSQL-Anwendungsmigrationen stehen bei 0/10.
- `productActivation` und alle PostgreSQL-Produktcapabilities bleiben `false`.
- Der externe GitHub-Actions-Nachweis für den Integrationscommit ist grün,
  ersetzt aber keines der offenen Installationsgates.
- Betriebsmodell, Verantwortliche, Wartungsfenster, RPO/RTO, Rollen, Secrets,
  TLS, Backup, Offsite, Retention, Monitoring, Rückkehrplan und
  Erfolgskriterien sind noch nicht installationsbezogen abgenommen.

Die Startprüfung hat deshalb keine Installation, keinen VPS, keine
Produktkonfiguration und keinen unterstützten Datenbankprovider verändert. Ein
Cutover darf erst nach vollständiger Erfüllung der Gates aus Abschnitt 13 und
einer ausdrücklichen Freigabe für genau eine benannte Installation beginnen.
