# Recovery-Nachweisweg nach gescheitertem Nachtlauf

## Festgestellter Zustand

Der signierte Nachtlauf vom 20.09.2026 endete um 04:22:11 Uhr (Europe/Vienna)
mit `full-assurance-failed` / `RESTORE_TEST_FAILED`. Provider-Prüfung, Backup
und Repository-Prüfung waren erfolgreich. Restore und App-Start erhielten keinen
Erfolgsbeleg. Der ältere erfolgreiche Deploy-Nachweis wird dadurch nicht wieder
gültig. Die Historie darf nicht nachträglich auf Erfolg geändert werden.

Die installierte Anwendung ist v0.92.61-beta. Der vorbereitete isolierte
Reparaturkandidat basiert auf v0.92.62-beta und enthält unter anderem Änderungen
an der PostgreSQL-Verbindungsinitialisierung. Er ist nicht mit dem installierten
Programmstand identisch.

## Nächster isolierter Lauf: Kandidatenqualifikation

Ein vollständiger Restore mit diesem Kandidaten prüft beide Datenbanken,
geschützte Daten und Schlüssel sowie den tatsächlichen HTTP-App-Start. Zum
App-Nachweis gehören Anmeldung, Import samt Konfliktprüfung und Rücknahme,
Dienstplan-PDF, Verkaufsbericht-PDF und Sitzungswiderruf. Ein bloßes HTTP 200
genügt nicht. Das Ergebnis wird an Lauf-ID, Quellcommit, Hashliste der tatsächlich
übertragenen Dateien und das Manifest des konkreten Sicherungspaares gebunden.

`test-support/recovery-candidate-proof.js` verwirft unvollständige Ergebnisse.
Sein Beleg kennzeichnet ausdrücklich `isolated-candidate-only`,
`qualifiesInstalledApplication: false` und `renewsNightlyAssurance: false`.
Ein Test aus einem lokalen Sicherungspaar bestätigt außerdem keinen neuen
Download oder Restore aus dem Offsite-Repository.

## Offizieller Gesamtnachweis

Der vorhandene reguläre Einstieg ist `grabenplaner-offsite-assurance --trigger
manual-cli` (über die dafür eingerichtete Service-/Credential-Umgebung).
Er erzeugt eine neue Lauf-ID und führt die zusammengehörige Kette aus:
Provider-Prüfung → Sicherung/Offsite-Übertragung → Repository-Vollprüfung →
Restore desselben Snapshots → isolierter App-Start → abschließende
Serverprüfung → signierter Gesamtabschluss → gebundener Deploy-Nachweis.

Der installierte Ablauf bietet keinen freigegebenen Einstieg zum Fortsetzen
eines bereits fehlgeschlagenen Laufs ab der Restore-Phase. Ein solcher Resume-
Mechanismus wäre eine separate Änderung an Nachweis- und Laufzeitverträgen;
er wird nicht durch manuelles Eintragen erfolgreicher Phasen ersetzt.

Die reguläre Routine prüft den installierten Programmstand. Benötigt der
App-Start die Kandidatenreparatur, muss diese zunächst über den freigegebenen
vollständigen Update-/Reparaturweg installiert werden. Ein Kandidatenbeleg
schaltet den kurzen Deploy nicht frei. Erfolg des Kandidaten, Installation und
regulärer Gesamtnachweis sind drei getrennte Ergebnisse.

Die reguläre Gesamtroutine erstellt eine neue Sicherung und kann dafür den
Live-GP anhalten. Sie ist daher kein bloßer zusätzlicher isolierter App-Start
und wird nicht als versteckter Folgeschritt der Diagnose gestartet.

## Vorbereitung und Startgrenzen

Vorbereitung GP698: eigene Lauf-ID, getrennte Belege, unveränderliche Hashbindung,
einmaliger Start und kein automatischer Wiederholungsversuch. Vor großen
Backup-Arbeiten laufen die Ubuntu-Diagnosetests; `work/` bleibt vollständig leer.
Direkt vor dem Start werden Gesundheit, Wartungssperre, aktive und anstehende
Wartungen, Speicher und unveränderter installierter Stand erneut geprüft.
Fortschritt wird anhand von Phase und Prozess-/I/O-Aktivität beobachtet.
Die Vorbereitung selbst startet weder Restore noch Deploy noch Assurance.
