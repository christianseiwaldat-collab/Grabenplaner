# Produktivanbindung · Block 4/4 – Betriebsvorprüfung

Aktuelle Fortsetzung: [Funktionale Kassenanbindung abgeschlossen](KASSE-ANBINDUNG-ABSCHLUSS-2026-09-07.md). Die zuvor fehlenden Leseadapter, Rechteprüfungen und sicheren Datenstandswechsel sind lokal umgesetzt. Als folgender Arbeitsschritt bleibt die zusammenhängende Release-/VPS-Übernahme; keine erneute pauschale Trade-Vollmessung als Voraussetzung.

Aktueller Abschluss: [Erneute Vorprüfung vom 07.09.2026](BLOCK-4-NEUPRUEFUNG-2026-09-07.md). Die Prüfung für die gesamte schlanke Kasse und den bestehenden GP-Bestand ist beendet; die fachliche Integration kann fortgesetzt werden. Der zusätzliche Trade-Vollaufbau wurde auf Nutzerwunsch zur Begrenzung des Prüfaufwands abgebrochen und seine Testdateien entfernt. Die neue Speicherrechnung ist ein Planungsszenario, keine produktive Aktivierung oder bestandene kombinierte Vollmessung.

Stand: 06.09.2026, lesende VPS-Prüfung ab 09:55 UTC. Block 4 wurde ausdrücklich beauftragt. **Begonnen, nicht abgeschlossen; noch kein Release oder Produktivimport.**

Aktuelle Umfangsentscheidung vom 07.09.2026: [Gesamte Kasse im schlanken GP-Prototyp](KASSE-VOLLBESTAND-GP-PROTOTYP-2026-09-07.md). TradeFoto und Kasse bleiben vollständig; die zwischenzeitlich geprüfte 24-Monate-Grenze entfällt. Die Kasse erhält eigene kompakte Tabellen. Geschäftliche Aktivierung und vollständige Betriebsfreigabe bleiben offen. Die folgenden Betriebswerte und Vollbestandsnachweise beziehen sich auf den ursprünglichen universellen Importaufbau.

Aktueller isolierter Nachweis: [Gesamte Kasse im GP-Prototyp](KASSE-VOLLBESTAND-GP-PROTOTYP-2026-09-07.md), 816,53 MB für alle 1.082.167 Zeilen, 449,21 MB für das erste lokale Archiv und 52,5 KB zusätzlich für einen unveränderten zweiten Sicherungspunkt. Beide gekoppelten Archiv-Restores sowie das vollständige erneute Rücklesen mit verwalteten Schlüsseln sind bestanden. Geschäftliche Leseadapter, Zuordnungen, Freigaben und die gesamte VPS-Kapazität einschließlich unverändertem Trade-Bestand bleiben offen. Der frühere [24-Monate-Dateivergleich](KASSE-SPEICHERARCHITEKTUR-2026-09-07.md) bleibt historischer Vergleich.

Aktueller Nachweis: [Vollbestand, Betrieb und Wiederherstellung vom 07.09.2026](VOLLBESTAND-BETRIEB-RESTORE-2026-09-07.md). Die neue Vollbestandsmessung und zwei lokale Restores sind bestanden. Der installierte vollständige Assurance-Lauf scheiterte am bisherigen Startzeitfenster; eine separate Archiv- und App-Restore-Prüfung bestand. Die anschließende [Begrenzung der Arbeitskopien und Quellenregel](ARBEITSKOPIEN-UND-QUELLSTAENDE-2026-09-07.md) ist ein lokaler Kandidat, keine Produktivfreigabe. Die folgenden VPS-Werte und Befunde bleiben ausdrücklich der historische Stand vom 06.09.2026, 09:55 UTC.

Fortsetzung nach ausdrücklicher Freigabe: [Großdaten-Backup-Strategie](GROSSDATEN-BACKUP-STRATEGIE.md).
RAM-Korrekturen und isolierte Deduplizierungs-/Restore-Nachweise sind dort vom noch unveränderten Produktivbetrieb getrennt dokumentiert. Die folgende Vorprüfung bleibt der ursprüngliche Messstand.

## Freigegebener Umfang und aktueller Stopp

Die vereinbarte Releasekette umfasst Tests, Version/Commit, Push ausschließlich des zugehörigen Branches, geprüftes Serverpaket, vorhandenen transaktionalen Updater, Betriebsnachweise sowie anschließend den kontrollierten Erstimport und die fachliche Aktivierung. Die Freigabe erlaubt keine Änderungen an SSH, Tailscale, Firewall, UFW, Zugangsdaten oder anderen Worktrees und keine eigenmächtige Bestellung zusätzlicher Serverkapazität.

Die technische [Block-3-Abnahme](PRODUKTIV-BLOCK-3-ABNAHME-2026-09-06.json) ist abgeschlossen. Vor dem produktiven Großimport fehlen jedoch belastbare Nachweise für **Großdatei-Backup/Restore und den dauerhaften Speicherbedarf mit der bestehenden Aufbewahrung**. Ein bloß passender freier Platz für den einmaligen Import genügt nicht. Die Produktivgates bleiben auf `false`; der Betriebsstand wird nicht durch ungeprüfte Importdaten vergrößert.

## Bestätigter VPS-Bestand

| Prüfung | Ergebnis |
| --- | --- |
| Zugriff | Vorhandener Alias `grabenplaner-prod-tailnet`, Konto `gpadmin`; keine Zugangsänderung |
| Installierte App | `0.92.27-beta`, Commit `41e6d92e5fc95c30a4ecb11d478802a930ea44e1` |
| Dienstpfade | Über `systemctl show` ermittelt: `/opt/grabenplaner/app`, `/etc/grabenplaner/grabenplaner.env` |
| App/Caddy | Aktiv; App-Port ausschließlich `127.0.0.1:3000` |
| Arbeitsspeicher | 8.321.531.904 Bytes gesamt, bei erster Prüfung ca. 6.081.118.208 Bytes verfügbar; kein Swap |
| Freier Datenträger | 75.145.670.656 Bytes, ca. 70 GiB, vor Import |
| Aktive Datenbank | 636.530.688 Bytes; Integrität bestanden, 0 Fremdschlüsselfehler |
| Neue Importtabellen produktiv | 0; keine Datenübernahme erfolgt |
| Lokale Aufbewahrung | `GRABENPLANER_BACKUP_KEEP=30`, unverändert |
| App-interne Sicherungen | 30 Datenbankdateien, zusammen 10.561.601.536 Bytes |
| Externe lokale Sicherungen | 32 Datenbankdateien, zusammen 7.422.074.880 Bytes; nicht als 32 gültige gekoppelte Sicherungspunkte behauptet |
| Vorhandener Integration-Vault | Konfiguriert; keine Schlüssel exportiert, erstellt oder geändert |

Die aufgelisteten Sicherungsgrößen enthalten nur Datenbankdateien. Dokumentkopien, temporäre Sicherungspunkte, Offsite-Staging und Wiederherstellungen kommen hinzu. Beide lokalen Sicherungsbereiche liegen auf demselben Datenträger.

## Betriebs- und Wiederherstellungsprüfungen

`grabenplaner-test` und anschließend `grabenplaner-offsite-test` wurden über die zuvor verifizierten installierten Helfer ausgeführt. Beide endeten erfolgreich; Abschluss der zweiten Prüfung 10:00:15 UTC. Bestätigt wurden unter anderem interne Live-/Ready- und öffentliche HTTPS-Ready-Prüfung, SQLite, aktueller gekoppelter Sicherungspunkt, TLS/Sicherheitsheader, ClamAV, Modul-/Binärintegrität, Providerbindung und signierter Assurance-Verlauf.

Der letzte signierte Vollabschluss lautet `full-assurance-passed`, Auslöser `scheduled-nightly`, Zeitpunkt `2026-09-06T02:16:41.684Z`, App-Version `0.92.27-beta`. Die Verlaufssignaturen sind gültig. Das ist ein Nachweis für den **bisherigen** Datenbestand, noch kein DB-/Import-Key-/Vault-Restore nach dem Großimport.

Die erste Systemübersicht enthielt weiterhin fehlgeschlagene ältere Steuerungsinstanzen sowie `grabenplaner-offsite-prepare.service` und `systemd-networkd-wait-online.service`. Das Offsite-Protokoll vom 06.09. belegt einen erzeugten und geprüften Sicherungspunkt; der Ablauf scheiterte danach an der 120-Sekunden-Ready-Wartezeit beim App-Neustart. Die spätere nächtliche Assurance und die aktuellen Prüfungen bestanden. Fehlerzustände wurden weder gelöscht noch mit `reset-failed` verdeckt. `f18-lagerware-auth.service` war inaktiv; dieser fremde Betriebsbereich wurde nicht verändert. Es wird nicht behauptet, sämtliche System-Units seien fehlerfrei.

Die lokalen SSH-Aufrufketten verwendeten jeweils 1.500 Sekunden mit Keepalives. Der noch vorhandene kürzere Timeout im Offsite-Helfer ist gesondert vor dem Großdatenbetrieb zu prüfen; die jetzige Vorprüfung änderte ihn nicht.

## Großdatenrisiken – keine pauschale Speicherfreigabe

### 1. Vollständige Dateien im Arbeitsspeicher

Die installierten und lokalen Backup-Verträge verwenden an mehreren Stellen `crypto.createHash(...).update(fs.readFileSync(...))`, insbesondere:

- `lib/backup-commit.js`
- `server-tools/linux/lib/backup-snapshot.js`
- `server-tools/linux/lib/verify-backup.js`
- `server-tools/linux/lib/restore-backup.js`
- zusätzlich der lokale, paketierte Offsite-Helfer `server-tools/linux/offsite/lib/offsite-stage.js`

Damit wird die jeweilige Datenbank für die Prüfsumme vollständig in einen Buffer gelesen. Das ist für einen Bestand in der Größenordnung des Großtests auf einem Server mit ca. 8,3 GB RAM keine belastbare Backup-/Restore-Lösung. Benötigt werden speicherbegrenzte Dateiprüfung, Großdatei-Regression und ein gemeinsamer DB-/Import-Key-/Vault-Wiederherstellungsnachweis. Ein kleiner erfolgreicher Betriebs-Selbsttest ersetzt das nicht. Die bestehenden Hash-/Manifest-/Schlüsselprüfungen dürfen dabei nicht abgeschwächt werden.

### 2. Vollkopien und Aufbewahrung

Der isolierte Volltest belegte bis zu **21.297.287.384 Bytes für Datenbank/WAL/SHM zusammen**. Das ist kein exakt vermessener, kompaktierter Sicherungspunkt und keine Zusicherung einer identischen Produktivgröße. Es ist jedoch die derzeit belastbare Größenordnung für die Kapazitätsplanung. Schon eine beispielhafte volle Datenbanksicherung von 20 GB würde bei 30 aufbewahrten Kopien rund 600 GB pro Sicherungsbereich benötigen, zuzüglich Live-Daten, Dokumenten, Staging, Wiederherstellung und Reserve. Der Server hat aktuell nur rund 75,1 GB frei; zwei lokale Sicherungsbereiche behalten Vollkopien.

Daher ist der unveränderte dauerhafte Großdatenbetrieb nicht abgenommen. Aufbewahrung wird nicht eigenmächtig reduziert, bestehende Sicherungen werden nicht entfernt, und es wird kein zusätzlicher Speicher bestellt. Vor Aktivierung ist eine ausdrückliche Entscheidung über Optimierung beziehungsweise geeignete Kapazität/Sicherungsarchitektur erforderlich. Die endgültige Größe ist an einem kompaktierten Vollbestand und einem realen gekoppelten Sicherungspunkt zu messen; aus dem Testmaximum wird kein vermeintlich exakter Speicherbedarf abgeleitet.

## Nächste Schritte nach dieser Entscheidung

1. Großdaten-Backup-/Restore-Prüfung speicherbegrenzt absichern und die vorhandenen Modulverträge einhalten; keine stillschweigende Offsite-Moduländerung.
2. Dauerhafte Kapazität einschließlich beider Sicherungsbereiche, Offsite-Staging, Rücksicherung und Reserve bestätigen. Keine Aufbewahrungsabsenkung ohne eigenen Auftrag.
3. DB und bestehende Vault-Schlüsselverwaltung gemeinsam wiederherstellen und einen neuen Import-Key-Umschlag im isolierten Wiederherstellungsfall nachweisen; keine Ersatzschlüssel bei fehlender Entschlüsselbarkeit.
4. Accountgebundene Importausführung und explizite GP-Zuordnungen vor abhängiger Historie bestätigen; keine Übernahme synthetischer Test-IDs und keine geratenen Personal-/Kundenbindungen.
5. Erst danach Release und kontrollierte Aktivierung mit den bestätigten Quellen-/Regel-/Vollständigkeitsnachweisen, betrieblichem Rollbackpunkt und abschließender Kennzahlenprüfung.

## Erhaltener Arbeitsstand

Repository `Grabenplaner-v0927-function-search`, Branch `feature/schedule-pdf-day-separators`, HEAD `41e6d92e5fc95c30a4ecb11d478802a930ea44e1`, Version unverändert `0.92.27-beta`. Bestehende uncommittete Arbeiten wurden erhalten. In dieser Block-4-Vorprüfung wurden lediglich lokale Abnahme-/Betriebsnachweise ergänzt; weder Produktivcode noch Daten, Backup-Aufbewahrung, Schlüssel, Diensteinstellungen oder Infrastruktur wurden geändert. Kein Commit, Push, Deploy oder produktiver Erstimport.
