# ACCDB-Import und nächtliche Sicherung

Stand: 14.09.2026, veröffentlicht mit [v0.92.45-beta](DEPLOY-RELEASE-v09245.md). Ausgangspunkt ist
die [Untersuchung der Unterbrechungen](INCIDENT-IMPORT-2026-09-14.md) und die
anschließende Freigabe, den mobilen Dateidialog und die übrigen Korrekturen
weiterzubearbeiten. Die folgende Untersuchung und lokale Umsetzung erfolgten
noch gegen den Vorgänger v0.92.44, Runtime a498d00; der Releaseabschluss ist
im verlinkten Protokoll festgehalten.

## Dateiauswahl am Handy

Die zentrale Importmaske und der verbleibende Artikel-Dateidialog verwenden
keinen Dateitypfilter im nativen Auswahldialog mehr. Android/Cloudanbieter filtern
nach MIME-Typ; eine sichtbare ACCDB mit abweichender Typzuordnung kann sonst
nicht auswählbar sein. Die Endungs-/Größenprüfung in der Oberfläche sowie
Berechtigung, CSRF, Größenlimit, ACE-Signatur, Dateihash und exakter Tabellen- und
Spaltenvertrag im Server bleiben bestehen. Die freiere Auswahl gibt keine
zusätzlichen Importformate frei.

Die Importmaske behandelt `document.hidden` getrennt von tatsächlicher Navigation.
Der Android-Dateidialog oder ein Hintergrundwechsel entfernt somit weder das
File-Element noch dessen Auswahl und bricht die Übertragung nicht absichtlich ab.
Nur die Statusabfragen pausieren im Hintergrund. Beim Schließen der Ansicht,
Kontowechsel oder Abmelden bleibt das Entfernen privater Anzeigeinhalte erhalten.
Eine Betriebssystem-Beendigung des Browsers während der Übertragung kann weiterhin
einen erneuten Upload erfordern. Nach vollständiger Dateiannahme übernimmt nun
die [dauerhafte Hintergrundprüfung](IMPORT-HINTERGRUND-2026-09-14.md). Die dort
beschriebene verschlüsselte, befristete Dateikopie ergänzt diese erste Korrektur.

Quellen: [Android-Dokumentauswahl](https://developer.android.com/training/data-storage/shared/documents-files)
und [MDN: accept](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/accept).
Die Bilder zeigen das Symptom; eine Diagnose direkt auf dem betroffenen Telefon
liegt noch nicht vor.

## Importfortschritt und Wartung

`data-import-lifecycle` verfolgt Aufträge auch nach ihrer HTTP-202-Antwort. Die
bestehende geschützte Wartungslease sperrt neue Imports. Beim Dienstende werden
Reader abgebrochen, das laufende Datenbankpaket und die Unterbrechungsmarkierung
aber noch abgewartet. Erst danach schließt der Server die Provider. Die Route
protokolliert nach HTTP 202 ausschließlich bereinigte Import-Fehlercodes.

Der Worker hat statt der bisherigen festen 25-Minuten-Frist eine zurückgesetzte
Stillstandsfrist von zwei Minuten sowie eine unabhängige Obergrenze von sechs
Stunden. Empfang eines Pakets und abgeschlossene Speicherung zählen als
Fortschritt. Auch bei Fristablauf wartet der Reader auf die bereits laufende
Speicherung, bevor Schlüssel und Ressourcen freigegeben werden. Speicherlimits,
ein Reader pro Prozess, Dateigröße und Paketgröße wurden nicht erhöht.

Beim erneuten Auswählen exakt derselben Datei meldet der Server dem Worker den
gespeicherten Zeilenstand jeder Tabelle. Nach Prüfung des vollständigen Hashes,
Profils, Tabellenplans und Quellzählers setzt die Decodierung dort fort. Die
Browseranfrage kann keinen solchen Offset vorgeben. Bestätigte Zeilen werden
nicht erneut übertragen oder doppelt angelegt. Produktive Übernahme bleibt eine
eigene geprüfte Entscheidung.

## Ein gemeinsamer Nachtlauf

Offsite-Vertrag 10 koordiniert Modulinstallation, App-Tausch, Betriebsprüfung
und Code-Rollback. Erst beim passenden Paar aus Anwendung und installiertem
Modul wird der zusätzliche Upload-Timer deaktiviert. Zuerst muss der vollständige
Assurance-Timer aktiviert und als betriebsbereit bestätigt sein. Beim Update wird
der alte Timer nicht vorübergehend neu aktiviert, wenn der neue Ablauf bereits
gilt. Ein Vorgängerbetrieb erhält seinen bisherigen Zeitplan zurück.

Der tägliche Assurance-Lauf enthält bereits Vorbereitung, Sicherung, Upload und
Wiederherstellungsprüfung. Die zwei lokalen Sicherungspaare, die Offsite-Retention
und die gesonderten Monats-/Quartalsprüfungen werden nicht reduziert. Der GP
stoppt für den einen konsistenten Sicherungspunkt weiterhin kurz. Konsistente
Online-Snapshots ohne Dienststopp sind ein gesonderter, noch nicht umgesetzter
Schritt. Es wurden keine VPS-Timer oder produktiven Daten verändert.

## Prüfung

Gezielte Node-/Bash-Prüfungen decken Fortschritt über die Stillstandsfrist,
Stillstand und Höchstlaufzeit, Abbruch während einer Datenbankoperation,
Statusspeicherung, HTTP-202-Aufträge beim Shutdown, verweigerte Neuaufnahme und
Wiederaufnahme ohne Duplikate ab. Der gemeinsame Zeitplan wird einschließlich
Versionen, Dateischutz, fehlgeschlagenem Ersatz, kurzem/vollem Updater und
Rollback-Auswahl geprüft. Vorhandene Kassen-Snapshot- und Migrationsverträge
bleiben Teil der Auswahl; Linux-Root-Prüfungen sind unter Windows separat als
übersprungen ausgewiesen.

Chrome mit dem echten Importmodul, synthetischen Dateien und 390 Pixel breiter
Maske: falsche Endung abgefangen; nach simuliertem Sichtbarkeitswechsel dasselbe
File-Element, ausgewählte ACCDB und nicht abgebrochene Übertragung; Fortschritt
nach Dateiannahme; Abbruch und leere Ansicht beim Schließen. Kein horizontaler
Überlauf. Der native Android-/Drive-Dialog wurde nicht als bestanden ausgegeben.
Lokaler Prüfserver: `tmp/import-mobile-qa.cjs`; keine produktiven API-Aufrufe.

Testprotokolle: `tmp/import-fixes-final-tests.log`,
`tmp/import-fixes-contract-tests.log`, `tmp/import-fixes-persistence-audit.log`.
Abschließender kombinierter Lauf: **149 bestanden, 0 fehlgeschlagen, 4 wegen
Linux-Voraussetzungen übersprungen**, insgesamt 153 Tests in 12,4 Sekunden.
Syntaxprüfung: 32 geänderte oder neue JS-/Bash-Dateien ohne Fehler.
Persistenz-Kopplungsaudit: OK, keine unklassifizierten Dateien oder
Phasengrenzverletzungen. `git diff --check` ohne Befund.
Keine erneuten Vollsicherungen, produktiven Wiederholungsimporte, Commits, Pushes
oder Deploys für diese Umsetzung.
