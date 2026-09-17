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

## Veröffentlichungsstatus

Paketierung, Installation und abschließende VPS-Verifikation stehen noch aus.
Die Veröffentlichung wird erst nach den tatsächlichen Belegen als abgeschlossen
dokumentiert. Die umfangreichen Access-Import-Laufzeittests werden nicht erneut
gestartet.
