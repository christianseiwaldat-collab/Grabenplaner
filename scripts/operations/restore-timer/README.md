# Doppelten Offsite-Restore am GP-Server vermeiden

Die auf diesem Host installierte Unit `grabenplaner-offsite-restore-test.service` besitzt eine zusätzliche systemd-Bedingung. Bei einem Aufruf durch ihren Timer wartet diese auf die Assurance- und Repository-Sperren. Sie vergleicht den von Restic ausgewählten neuesten Sicherungspunkt mit der signierten vollständigen Nachtprüfung desselben Timer-Tages. Stimmen vollständige Snapshot-ID, Receipt-Hash, Installation, Datenbankschema, App-Stand und Prüfumfang überein, überspringt systemd den Restore. Der Journaleintrag nennt den geprüften Snapshot und den Zeitpunkt in UTC. Der ursprüngliche Beleg behält seinen Zeitstempel.

Die Bedingung gibt einen explizit angeforderten Restore direkt frei. Auch bei einem fehlenden, ungültigen oder durch einen späteren Fehler überholten Beleg wird das reguläre Restore-Programm ausgeführt. Die normale Nachtprüfung verwendet weiterhin ihren eigenen vollständigen Restore. Die Entscheidung für den separaten Repository-Check gehört zu dessen eigener Unit.

Zur Einrichtung die drei Dateien `install.sh`, `restore-condition.sh` und `restore-proof.cjs` gemeinsam in ein root-geschütztes Verzeichnis kopieren und dort als root `bash install.sh` ausführen. Der Installer erkennt den bisherigen Kalendervergleich an der Prüfsumme seines Drop-ins und prüft die tatsächlich geladene Bedingung nach dem Neuladen von systemd. Dienst und Timer laufen dabei weiter. Er nennt den Pfad der gesicherten Originalkonfiguration. Für die Rücknahme diese als `/etc/systemd/system/grabenplaner-offsite-restore-test.service.d/90-complete-nightly-assurance.conf` (root:root, 0644) wiederherstellen und `systemctl daemon-reload` ausführen.

Gezielte Tests unter Linux aus dem Projektverzeichnis:

```sh
node --test test/restore-timer-coverage.test.js test/restore-timer-lock.test.js
```
