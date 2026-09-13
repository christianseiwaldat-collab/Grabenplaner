# Release v0.92.43-beta

## Umfang

Freigegeben nach der abgeschlossenen VPS-Bereinigung am 13.09.2026:
vorbereitete Einstellungsstruktur, zentrale ACCDB-Importe für Trade, Kassa und
Bestell, PostgreSQL-Fußzeile, Bestell-Importhistorie mit Erhalt fehlender
Reparaturen, bestätigte Anzahlungsregel in Kassenansicht und neuen PDF-Berichten,
sowie die Aufbewahrung von zwei vollständigen PostgreSQL-Sicherungspaaren.

Eigene spätere Reparaturübersichten, Filialkonto-Prototyp und noch nicht
implementierte Bestandsauswertungen gehören nicht zu diesem fertigen Paket.
Es erfolgt kein produktiver ACCDB-Import durch das Deployment.

## Vorprüfung und Scanner-Speichergrenze

Der laufende GP 0.92.42 zeigte während der Vorprüfung Transaktions-Timeouts.
PostgreSQL meldete keine blockierenden Sitzungen. Im App-Cgroup beanspruchte
der GP rund 550 MB und der laufende Scanner rund 900 MB; die Probe
`.scanner-probe-…txt` wartete direkt in `__mem_cgroup_handle_over_high`.
Die bisherige Schwelle von 1.280 MiB war dafür zu klein. Es gab keine OOM-Kills,
aber ausgeprägte Speicherdrosselung mit Datenbank-Zeitüberschreitungen.

Bei rund 4 GB verfügbarer RAM-Reserve wurden nur die App-Grenzen auf
MemoryHigh=2.048 MiB und MemoryMax=2.560 MiB angepasst. Swap bleibt aus und
TasksMax bleibt unverändert. PostgreSQL- und fremde Dienstgrenzen bleiben
unverändert. Vorlage, installierter Drop-in, verwalteter Installationsbeleg und
Paketmanifest wurden gemeinsam mit vorherigen Dateihashes dokumentiert und
geprüft; `daemon-reload` übernahm die Grenzen im bestehenden App-Prozess.

Danach sank der App-Cgroup auf etwa 0,52 GB; alle vier internen und öffentlichen
Live-/Ready-Aufrufe bestanden. Prozess, Boot-ID, DB-Paaridentität, Mailfreigabe
und andere Dienste waren unverändert. Die fünf verwalteten PostgreSQL-
Betriebsdateien und alle 646 installierten Manifestdateien sind geprüft.
Die Speicheranpassung ist in der neuen Releasevorlage enthalten.

## Lokale Prüfungen

319 gezielte Tests aus 26 Dateien: 317 zunächst erfolgreich; zwei veraltete
statische Erwartungen für Versionsnummer und bisher deaktivierte Importübernahme
wurden an den freigegebenen Stand angepasst und gezielt erneut geprüft.
Der Core-Zuordnungsabgleich bleibt ausdrücklich gesperrt. Persistenzaudit OK,
keine unklassifizierten produktiven Dateien oder Phasengrenzverletzungen.
Die vier nur für ausdrücklich konfigurierte PostgreSQL-Livetests vorgesehenen
Windows-Testfälle waren übersprungen und sind kein positiver Live-Nachweis.

Logs: `tmp/v09243-release-tests.log`, `tmp/v09243-corrected-tests.log`,
`tmp/v09243-persistence-audit.json`, `tmp/v09243-preflight.json`.
Weitere bereits dokumentierte Bedien-/PDF-Nachweise stehen bei den jeweiligen
[Einstellungsänderungen](EINSTELLUNGEN-DATENBANKIMPORTE-2026-09-13.md) und der
[Anzahlungsregel](VERKAUFSBERICHTE-GEPRUEFTE-TEILWERTE.md).

## Veröffentlichung

Der bestehende transaktionale Updater hat v0.92.43-beta am 13.09.2026 um
20:02:23 UTC erfolgreich abgeschlossen. Produktiver Laufzeitcommit:
`0547dd4f7e8bd0251fd3c2e70d229ea708bad80a`, Branch
`feature/schedule-pdf-day-separators`. Runtimevertrag 5 und Offsite-Modul 9.

| Artefakt | SHA-256 |
| --- | --- |
| Linux-ZIP, 4.321.743 Byte | `50389784f3480447a91a1684f73c455190979a77c23b7cea891c1a5767496104` |
| Manifest, 648 verwaltete Dateien | `492308f600436c87434a26370ad00bce327b7fb92e28525361a88ea7dc9da63b` |
| Paketprüfer | `6dba6a651dc91a62d5e9c2d956c8d95c66e7dda8eee1a22a16271e85c232aca5` |

Der Updatebeleg misst 826,39 Sekunden, also 13 Minuten 46 Sekunden. Die
Paketprüfung mit ClamAV dauerte 345 Sekunden, die beiden aktuellen gekoppelten
Rückkehrpunkte 80 und 83 Sekunden, die externe Absicherung samt Prüfung
157 Sekunden. Paketinstallation und Startprüfungen bilden den übrigen Anteil.
Die Zeit umfasst den vollständigen Updater, noch nicht die nachfolgenden
manuellen Betriebsprüfungen und den vollständigen Recovery-Assurance-Lauf.

Die manuell nacheinander ausgeführten `grabenplaner-test --deploy-mode` und
`grabenplaner-offsite-test` bestanden am 13.09.2026 um 20:03:56 UTC. Alle 648
installierten Dateien entsprechen dem Manifest, alle vier internen/öffentlichen
Live-/Ready-Prüfungen antworten mit 200. Provider, PostgreSQL-Paaridentität,
Mailfreigabe und Boot-ID blieben erhalten; PostgreSQL, Caddy und die Dienste des
anderen Projekts behielten ihre Prozess-IDs. Kein Ubuntu-Neustart.

Die automatische Einplanung des Assurance-Laufs war im Releasewrapper bewusst
kurz gesperrt, damit die manuellen Betriebsprüfungen zuerst und ohne Konkurrenz
ablaufen. Der Wrapper hat diese Sperre aufgehoben. Anschließend wurde genau ein
vollständiger Lauf gestartet: `f0c15d58-e098-4281-833b-26714f5f3aed`, Beginn
20:04:35,822 UTC. Dieser Lauf ist um 20:24:41 UTC erfolgreich beendet worden;
systemd misst 20 Minuten 9 Sekunden. Alle sieben signierten Schritte sind
bestätigt, ohne fehlgeschlagenen Schritt in diesem Lauf. Snapshotprefix:
`084c0d4016f4`. Der gebundene aktuelle Deploy-Nachweis wählt für einen normalen
Deploy wieder `short`; kritische Änderungen bleiben weiterhin vollständig zu
prüfen. Update und zusätzlicher Vollnachweis waren somit getrennte Zeitanteile.

Die Testwiederherstellung bestätigte 201 Core- und 63 Sales-Tabellen mit
209.817 beziehungsweise 2.738.958 Zeilen und identischen Strukturprüfsummen,
55 geschützte Dokumente und 113 geschützte Datensätze. Der vollständige
Anwendungstest bestand einschließlich Anmeldung, acht parallelen berechtigten
Lesezugriffen, Artikelimport mit Konfliktprüfung und Rücknahme, Belegsuche,
Dienstplan-PDF und Verkaufsbericht mit 2.239 Positionen. Schreibende Testfälle
liefen ausschließlich in der isolierten Wiederherstellung. Die produktiven
Abschlussabfragen blieben lesend; die Berichterstellung ist nicht pausiert.

## Sichtkontrolle der veröffentlichten Oberfläche

Mit der bestehenden angemeldeten Chrome-Sitzung geprüft:

- v0.92.43 Beta und PostgreSQL 18.6 mit `grabenplaner_core + grabenplaner_sales`.
- Unter Personal sind Urlaub, Zeiterfassung und Import & Lohnverrechnung
  aufklappbar zusammengeführt; die früheren einzelnen Oberkategorien entfallen.
- Unter System & Backups steht Datenbankimporte an erster Stelle. Die
  Uploadmaske führt `Trade_Daten.accdb`, `Kassen_Umsätze.accdb` und
  `Trade_DatenBestell.accdb`; Dateien werden vor der Übernahme geprüft.
- Die kompakte Importmaske ist im vorhandenen Desktopfenster vollständig lesbar.
  Bestehende Importvorschauen und fertige Verkaufsberichte sind weiter sichtbar.

Es wurde keine echte ACCDB-Datei hochgeladen oder übernommen und kein
vorhandener Bericht geändert. Der bekannte automatisierungsbedingte Chrome-
Downloadschutz wurde nicht erneut als Anwendungsfehler bewertet.

Nebenbefund für einen späteren UI-Abgleich: Die beiden älteren Footerfelder
„Interne Sicherung“ und „Letztes Backup“ lesen noch den früheren SQLite-
Sicherungsstatus. Sie zeigen noch den alten Ordner und „noch ausständig“;
der reale PostgreSQL-Sicherungsstand wird separat am Server geprüft. Die hier
beauftragte Datenbankversion und beide Datenbanknamen werden korrekt angezeigt.

## Abschließender Betriebs- und Speicherstand

Der reguläre Servermonitor bestätigte am 13.09.2026 um 20:25:43,790 UTC alle
24 Prüfungen. Kein zusätzlicher automatischer Neustart wurde ausgelöst.
PostgreSQL-Autovacuum ist eingeschaltet, die Dienste anderer Anwendungen und
die Boot-ID sind unverändert. Der signierte Offsite-Status ist `ok`; alle drei
offenen Fehlerflags sind zurückgesetzt durch erfolgreiche Folgeläufe.
Historische systemd-Fehler und Journale wurden nicht pauschal gelöscht.

Nach der Wiederherstellung sind genau zwei vollständige lokale Paare erhalten,
jeweils mit Core, Sales, Konfiguration und zugehörigen Dateien:

| Erzeugt (UTC) | Paar | Manifest-SHA-256 |
| --- | --- | --- |
| 20:00:32,202 | `1a16511a-279a-4821-9c54-4f4d28e889ff` | `18b9e86a818613a8592792cdb1d72894e10c3b51fc2f0512339c6c0306f6c360` |
| 20:05:55,259 | `3f39d99e-f714-4dbd-ab11-1b4ddf6de85e` | `42eff04d3a6c2d91a4841d82ff3a907f09ececde65d2ffd2974f960e72bcd053` |

Beide vollständigen Dateiinhalte wurden erneut gehasht: zusammen
2.013.610.266 Byte, je 72 Dateien. Die drei alten Sicherungswurzeln und das
Offsite-Staging sind leer; die entfernten Migrationswurzeln und die alte
SQLite-Datei wurden nicht wieder angelegt. Testcluster und temporäre
Restorekopien sind entfernt, ihre kleinen Nachweise bleiben erhalten.

Alle Abschlussbelege wurden lokal heruntergeladen und mit ihren Serverhashes
verglichen. Erst danach wurden die exakt gebundenen eigenen Upload-/Stagepfade
und der eigene saubere Paket-Worktree entfernt. Verbleibender freier VPS-Platz:
**88.730.021.888 Byte / 88,73 GB**. Produktive Dateien und die zwei Sicherungspaare
waren ausdrücklich außerhalb dieses abschließenden Löschumfangs.

Dauerhafte Belege am VPS:
`/var/lib/grabenplaner-assurance/maintenance-evidence/v09243-20260913`.
Lokale Belege: `tmp/v09243-evidence`, einschließlich `LOCAL-VERIFIED.json`
und `cleanup-receipt.json`. Hash des identisch gesicherten Belegmanifests:
`dd60e5d94fcebca2a58e423cedf9f7dc0dd029efa4f1f43c25019d33c7edc97b`.

Das gesonderte lokale Migrationsarchiv bleibt erhalten; siehe
[Bereinigung und Archiv](VPS-ZWEI-SICHERUNGEN-2026-09-13.md).
