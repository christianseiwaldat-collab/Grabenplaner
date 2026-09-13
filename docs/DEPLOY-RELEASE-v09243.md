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

Paketbau und VPS-Update erfolgen über den bestehenden transaktionalen Updater.
Ein frischer geprüfter Rückkehrpunkt bleibt vorgeschrieben; die neue Rotation
behält danach genau zwei Paare. Kritische Persistenz-/Betriebsänderungen erhalten
den vollständigen Wiederherstellungsnachweis. Release-Ergebnis und endgültige
Hashes werden nach den Serverprüfungen ergänzt.
