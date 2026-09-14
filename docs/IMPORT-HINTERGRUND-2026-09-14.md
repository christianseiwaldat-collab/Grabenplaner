# Dauerhafte ACCDB-Hintergrundprüfung

Stand: 14.09.2026. Lokal umgesetzt und geprüft, noch nicht veröffentlicht.
Ausgangspunkt: v0.92.44-beta, Runtime `a498d00f0dc07fea69ae68e0b9d3eaa96bc17b4d`.
Die vorherige [Import-/Wartungskorrektur](IMPORT-STABILITAET-2026-09-14.md) bleibt
enthalten. Weder produktive Imports noch Neustarts, Timeränderungen oder ein
Deploy wurden für diese Untersuchung ausgeführt.

## Aktueller Befund am VPS

Lesende SSH-, PostgreSQL- und HTTP-Prüfung am 14.09.2026 um 11:33 und 11:59 CEST:

- GP und `grabenplaner-postgresql.service` aktiv, keine automatischen Neustarts,
  kein Kernel-OOM in den untersuchten 24 Stunden. Live-Check HTTP 200, zuletzt
  0,045 Sekunden. Das ist eine Erreichbarkeitsprüfung, keine erneute Releaseabnahme.
- Jüngster Trade-Import: Start 10:57:39, Unterbrechung 11:22:43,
  `IMPORT_SOURCE_READ_TIMEOUT`. 119.796 von 396.466 deklarierten Zeilen gespeichert;
  zuletzt `ARTIKEL_STAMM` mit 5.600 von 19.328 Zeilen.
- Im tatsächlich installierten Reader gilt weiterhin `timeoutMs = 1500000`:
  die feste 25-Minuten-Gesamtfrist beendet auch fortlaufend arbeitende Imports.
  Die lokal vorbereitete Stillstandsprüfung ist noch nicht produktiv.
- Bestelldaten-Import weiterhin unvollständig mit 204.181 von 414.434 Zeilen;
  zuletzt `Rechnung_Z` mit 5.400 von 13.211 Zeilen. Die zuvor belegten nächtlichen
  Dienststopps und zwei aktiven Nacht-Timer bestehen im alten Release fort.
- Kein neuer Kassenstand oder Artikelimport durch diese unvollständigen Prüfstände
  veröffentlicht. Keine aktuellen langen Transaktionen oder Lock-Wartezustände.
  87,96 GB frei; keine Notwendigkeit für eine Speicherbereinigung in diesem Auftrag.

Zusätzliche `PERSISTENCE_UNKNOWN`-Meldungen wurden gezählt, ohne sie unbelegt mit
dem eindeutig gespeicherten Trade-Timeout gleichzusetzen. Keine Kundendaten,
Dateikennwörter, Sitzungstoken oder Datenbankzugänge in den Diagnoseausgaben.
Nachweis: `tmp/import-background-vps-20260914T095931Z.json` und
`tmp/import-background-vps-final.log`.

## Verhalten nach dem Update

1. Der Benutzer lädt eine ACCDB in den Systemeinstellungen hoch. Die Route prüft
   Anmeldung, aktuelle Rechte, CSRF, Dateigröße und Dateiformat vor der Aufnahme.
   Erst eine verschlüsselte, synchronisierte Dateikopie samt atomar gespeichertem
   Auftrag erlaubt HTTP 202. Fehlgeschlagene Aufnahme verspricht keine Warteschlange.
2. Ein Hintergrundarbeiter liest und prüft die Quelle in vorhandenen, begrenzten
   Datenbankpaketen. Er verwendet die aktuelle Berechtigung des ursprünglichen
   Mitarbeiters statt einer gespeicherten Sitzung. Schließen des Browsers oder
   Abmelden beendet einen bereits angenommenen Auftrag nicht; Rechteentzug tut es.
3. Vorübergehende Fehler werden dreimal nach 30 Sekunden, zwei und zehn Minuten
   wiederholt. Derselbe Hash, Tabellenvertrag und Quellzähler sind Voraussetzung
   für die Wiederaufnahme. Der Worker erhält den gespeicherten Zeilenstand vom
   Server. Browseroffsets oder ungeprüft geänderte Quelldateien werden nicht akzeptiert.
4. Nach Dienstende oder Neustart werden gespeicherte laufende Aufträge wieder in
   die Warteschlange gestellt. Shutdown wartet auf den laufenden Datenbankabschluss.
   Wartung verbraucht keinen Fehler-Wiederholungsversuch. Eine ausdrückliche Pause
   bleibt auch bei gleichzeitigem Workerabbruch und anschließendem Neustart bestehen.
5. Nach erfolgreichem Einlesen werden Quelldatei und Kennwort entfernt; die
   serverseitige Fachprüfung läuft weiter bis `ready` oder `needs_review`.
   Übernehmen beziehungsweise Kassenstand aktivieren bleibt eine Benutzerentscheidung.

Die Oberfläche zeigt Hintergrundarbeit, nächsten Versuch, Pause und Fortsetzen.
Der alte Hinweis, dieselbe Datei erneut hochzuladen, erscheint bei einem vorhandenen
automatisch wiederaufnehmbaren Auftrag nicht mehr. Alte unterbrochene Imports aus
v44 benötigen jedoch einmalig denselben Dateistand erneut: v44 hat keine Originaldatei
aufbewahrt. Die früher gespeicherten Pakete werden dabei weiterverwendet.

## Schutz und Ressourcen

`lib/data-import-job-store.js` hält ausschließlich temporäre verschlüsselte Dateien
außerhalb der Geschäftsdatensicherungen. AES-256-GCM schützt jede Quelldatei mit
eigenem Schlüssel; die bestehende Vault schützt Metadaten, Schlüssel und optionales
Access-Kennwort, gebunden an die Auftrags-ID. Keine Browserzugänge werden gespeichert.
Private Dateirechte, sichere Namen, Verknüpfungs- und Integritätsprüfungen sowie
atomare Metadatenwechsel schützen die Ablage. Ohne passende Schlüssel wird nichts
entschlüsselt und kein Ersatzschlüssel erzeugt.

Die Dateikopie wird nach Einlesen, sonst nach 72 Stunden beim nächsten möglichen
Bereinigungslauf entfernt. Maximal sechs Aufträge, insgesamt 1,5 GiB Quelldateien,
mindestens 1 GiB freier Restplatz und ein großer Upload/Reader gleichzeitig.
Verschlüsselung und Entschlüsselung verwenden begrenzte Dateizugriffspakete.
Die alte 512-MiB-Dateigrenze sowie Reader-Speicherlimits bleiben unverändert.
Release-Bauer und Server-Paketprüfer schließen `import-jobs` ausdrücklich aus.
Vorhandene PostgreSQL-Sicherungen erfassen nur ihre bisherigen Verzeichnisse;
die temporäre Ablage erzeugt keine zusätzlichen großen Sicherungskopien.

Normale Neustarts mit unveränderter Datenablage werden unterstützt. Verlust der
temporären Ablage, Ablauf der Aufbewahrung oder ein absichtlicher Code-Rollback
auf einen Stand ohne Hintergrundarbeiter erfordern eine entsprechend neue Aufnahme
beziehungsweise Rückkehr zum unterstützten Programmstand. Keine produktive Migration
oder neue Datenbankschema-Version ist Bestandteil dieser Änderung.

## Prüfung und Grenzen

Gezielte gemeinsame Auswahl: **141 bestanden, 0 fehlgeschlagen, 4 Linux-Prüfungen
unter Windows übersprungen**, 145 Tests in 13,1 Sekunden. Ergänzende Prüfung des
mehrteiligen Datei-Datenstroms: **1 bestanden**, einschließlich vollständigem
Bytevergleich und Entfernen einer abgebrochenen temporären Datei. Die Auswahl
umfasst Importrouten, echten Import-Repositoriumspfad, Kassen-Snapshots,
Lifecycle/Shutdown, Verschlüsselung, Aufbewahrung, Zugriffsentzug, Versionsübergang,
gemeinsamen Nachtplan und Paketgrenzen. Vorangegangene Prüfungen sind im verlinkten
Stabilitätsdokument getrennt dokumentiert; Ergebnisse werden nicht doppelt gezählt.

Die echte Importablage wurde mit 401 synthetischen Zeilen geprüft: Timeout nach
200 gespeicherten Zeilen, nächster Versuch beginnt bei 201, danach 401. Endstand
401 Zeilen, keine doppelten Zeilen und keine automatisch angelegten Geschäftsdaten.
Neuer Prozess nach Dateizusage, Prozessende während Speicherung, manuelle Pause,
falsche Rechte, Dateimanipulation und ausgeschöpfte Wiederholungen sind abgedeckt.

Chrome mit echter HTTP-Route, echtem Importmodul und synthetischem Reader:
geschützte Dateiannahme, sichtbarer automatischer Wiederholungsversuch nach
200/401 Zeilen, 389 Pixel breite Maske ohne Seitenüberlauf, danach Prüf-Tab
geschlossen. Anschließende direkte lokale Serverprüfung: `ready`, 401 Zeilen,
keine Geschäftsübernahme, temporäre Ablage leer. Kein weiterer Upload nötig.
Der Test ersetzt keine Prüfung auf dem betroffenen Android-/Drive-Dateidialog
und keinen nativen PostgreSQL-Großimport nach Veröffentlichung.

Nachweise: `tmp/import-background-final-tests.log`,
`tmp/import-background-chunk-test.log`, `tmp/import-background-browser-result.json`,
`tmp/import-background-browser.cjs`, `tmp/import-background-syntax.json`,
`tmp/import-background-final-audit.log`. Syntaxprüfung und Persistenzaudit ohne
Befund; veröffentlichte Versionsnummer und produktive Daten unverändert.
