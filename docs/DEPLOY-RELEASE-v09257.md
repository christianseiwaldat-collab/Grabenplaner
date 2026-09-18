# v0.92.57 Beta · Planung, Xoffi und Artikelstamm

## Umfang

Die am 18.09.2026 ausdrücklich beauftragte Veröffentlichung umfasst den auf
`main` bereitgestellten Stand `f43377b`: schnellere Wochen- und Filialwechsel,
persönliche PDF-Auswahl, Dashboard-Kennzahlen, Xoffi-MHTML, Einsatzanfragen und
die überarbeitete Artikelansicht. Die fachlichen Details stehen im
[gemeinsamen Prüfstand](PRUEFSTAND-MAIN-2026-09-18.md).

Für den Release wird die additive Xoffi-Migration vor den Start der neuen App
gelegt. Der Updater führt sie nur mit expliziter Option und übernommener
Wartungssperre aus. Bei einem Fehler startet die neue App nicht; eine veränderte
PostgreSQL-Struktur bleibt durch die bestehende Rollback-Kompatibilitätsprüfung
geschützt. Der Wiederherstellungstest ergänzt ältere, bereits vollständig
verifizierte Sicherungen ausschließlich in seiner isolierten Testkopie für den
Start der neuen Anwendung. Siehe [Migrationsablauf](XOFFI-MHTML-UND-FILIALEINSATZ-2026-09-17.md).

## Vorprüfung

- VPS-Ausgangsstand v0.92.56, Runtime-Commit `b9d551e`; alle 729 Manifestdateien
  stimmen mit ihren Hashes überein. Vier interne/öffentliche Healthchecks
  liefern HTTP 200. Bestell- und Kassenimporte sind abgeschlossen.
- Etwa 54 GiB freier Plattenplatz, etwa 5 GiB verfügbarer Arbeitsspeicher.
- Der fehlgeschlagene nächtliche Restore vom 17.09.2026 bleibt ein offener
  Nachweis. Der Deploy muss ihn mit dem neuen, auf 30 Minuten begrenzten Worker
  erneut vollständig prüfen. Keine manuellen Erfolgsmarkierungen.
- 262/265 gemeinsame Regressionstests sowie drei native PostgreSQL-Tests
  bestanden. Die drei Architekturfehler sind im gemeinsamen Prüfstand benannt.
- Die zusätzliche GitHub-Linux-Gesamtsuite hat 3588 bestandene, 26 fehlgeschlagene
  und 77 übersprungene Tests. Betroffen sind außerdem ältere SQLite-Prüfhaken,
  historische Katalog-/Runtimeannahmen, Berechtigungsfixtures und OCR. Die acht
  auffälligen Personalrechtefälle sowie die Smoke-Schema- und Hardeningfehler
  wurden im unveränderten Vorgänger `f1a40c2` reproduziert. Das ist kein insgesamt
  grüner CI-Nachweis. Die native PostgreSQL-Rechteprüfung bleibt separat belegt.
- 47 gezielte Deployment-/Xoffi-Prüfungen bestanden. Nach der Ergänzung des
  isolierten Schema-Upgrades weitere 15 Tests bestanden, einschließlich
  Migrationsfehler vor App-Start und abgewiesenem Migrationsnachweis.
- Abschließende Versions-/Paketprüfung: 41 bestanden, drei unveränderte
  Linux-spezifische Tests unter Windows übersprungen. Alle drei nativen
  PostgreSQL-Tests am endgültigen Code erneut bestanden, einschließlich des
  Schema-Upgrades über den Recovery-Worker. Bash-/JavaScript-Syntax geprüft.
- Der Linux-CI-Lauf für den Release-Commit umfasst 3695 Tests: 3592 bestanden,
  dieselben 26 Fehler wie im oben genannten Lauf und 77 übersprungen. Die vier
  zusätzlichen Release-Tests bestehen; es gibt gegenüber diesem Lauf keine
  zusätzlichen fehlgeschlagenen Testfälle.

## Erster Paketstand und Korrektur

- Version: `0.92.57-beta`
- Runtime-Commit: `9ae1ea24d0769d6e39635793b99ff8083a7be6a9`
- Paket: `Grabenplaner-Server-v0.92.57-beta-linux-x64.zip`
- Paket-SHA-256: `5b23d9e56f81286a2d66591f64fd48173ddf0cfcc555838473fc3b1cb1b63619`
- Manifest-SHA-256: `4e793ff0cd11ea11eb76a2e9e00d1f61a972fa6601f850340bbdb2f026e6d4ba`
- 746 Manifestdateien unabhängig gegen die Paketierung geprüft.
- Beim ersten Stagingversuch fehlte die erforderliche Dienstgruppe an einem
  Prüfhelfer. Der Updater brach vor dem Anhalten der App und vor Datenänderungen
  ab. Nach Anwendung der bestehenden Paket-Berechtigungsroutine und erneuter
  Paketprüfung wurde derselbe Release-Auftrag erneut gestartet. Die erste
  Fehlermeldung bleibt in den Nachweisen erhalten.
- Der anschließende Updateversuch wurde vor dem App-Tausch beim Erstellen des
  Rückkehrpunkts abgebrochen: PostgreSQL meldete `57014` (Statement-Timeout).
  Die Sicherungsverbindungen übernahmen das 30-Sekunden-Limit ihrer Rollen.
  Der bisherige GP wurde wieder gestartet; die Xoffi-Migration lief noch nicht.
- Vollständige Prüfabfragen innerhalb der gesperrten Sicherung erhalten nun
  maximal fünf Minuten. Das Limit ist transaktionslokal; die normalen Limits
  werden nach Commit und Rollback wieder wirksam. Ein nativer PostgreSQL-Test
  weist beide Fälle mit einer absichtlich langsamen Abfrage nach. Zusätzlich
  bestehen 32 gezielte Regressionstests; ein Linux-spezifischer Test ist unter
  Windows unverändert übersprungen.
- Für diesen expliziten Xoffi-Deploy nutzt der Updater bereits vor dem App-Tausch
  die vollständige, verifizierte Paketversion des Sicherungswerkzeugs. Dadurch
  gilt die Korrektur auch für den erforderlichen Rückkehrpunkt. Paketprüfung,
  Virenscan und Berechtigungsprüfung finden zuvor unverändert statt.

## Zweiter Paketstand und fehlgeschlagener Abschluss

Der Paketstand `b2e09af2530943aff4e12e8e2211edeed7764c27` wurde installiert und
lieferte mit Xoffi-Migration erfolgreiche interne und öffentliche Healthchecks.
Der abschließende isolierte Restore-Test scheiterte am separaten 15-Minuten-Limit
von `pg_restore`, obwohl der äußere Worker bereits 30 Minuten erlaubte. Am
18.09.2026 um 00:23 UTC rollte der Updater die App zurück. Das PostgreSQL-Paar
blieb einschließlich der additiven Migration und aller Nutzdaten erhalten. Die
alte App wurde wegen des inkompatiblen Schemas absichtlich nicht gestartet.
Die gezielte Wiederherstellung und die konsistente Zeitgrenze werden in
[Release v0.92.58](DEPLOY-RELEASE-v09258.md) dokumentiert.

## Ursprünglicher Veröffentlichungsstatus vor dem zweiten Versuch

Der erste Paketstand wurde nicht installiert. Das korrigierte Paket und seine
abschließende VPS-Verifikation stehen noch aus.
Die Veröffentlichung wird erst nach den tatsächlichen Belegen als abgeschlossen
dokumentiert. Die umfangreichen Access-Import-Laufzeittests werden nicht erneut
gestartet.
