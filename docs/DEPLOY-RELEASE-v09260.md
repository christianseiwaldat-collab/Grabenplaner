# Release v0.92.60 Beta

## Anlass

Der vollständige Wiederherstellungstest von v0.92.59 deckte einen Fehler im
PostgreSQL-Kaltstart auf: Die erste Verbindung begann während des synchronen
Aufbaus der Anwendung. Im isolierten Worker dauerte dieser Aufbau etwa
84 Sekunden; die fünf Sekunden Verbindungsfrist liefen bereits davor ab,
bevor Netzwerkantworten verarbeitet werden konnten.

## Korrektur und Prüfung

Die Initialisierung gibt zunächst den aktuellen synchronen Aufruf frei.
Erst danach beginnen die Datenbankverbindungen. Verbindungsfrist, Rollen,
Berechtigungsprüfungen und Bereitschaftssperre bleiben unverändert.

Ein Test bildet den beobachteten Start mit einer gesteuerten Uhr nach und
scheiterte vor der Korrektur mit dem Verbindungszeitlimit. Nach der Korrektur
bestehen beide Starttests mit Node 22.22.1 und Node 24.19.0. Zehn gezielte
Start-, Lesetransaktions- und Recovery-Tests bestehen mit Node 22.

CI, Paket und VPS-Abschluss sind noch offen. Der fehlgeschlagene v0.92.59-Lauf
und sein automatischer Rollback werden im vorherigen Release-Bericht bewahrt.

Der erste CI-Kandidat `eb89eeb` erkannte die neue Starttestdatei als noch
nicht klassifizierte Testkopplung. Die Datei ist jetzt ausdrücklich im
Architekturkatalog registriert; die erwartete Anzahl steigt genau um diese
eine Testdatei. Alle 23 Architektur- und Provider-Vertragsprüfungen bestehen.
Produktive Zugriffsgrenzen wurden dadurch nicht erweitert.

## Unterbrechung am 18.09.2026 um 05:43 UTC

Nach dem Einwand des Nutzers gegen die lange Bearbeitungsdauer wurde der
isolierte Zusatztest `grabenplaner-startup-diagnostic-v09260-eb89eeb` beendet.
Sein Ende durch `systemctl stop` ist kein erfolgreicher Anwendungsnachweis;
ein vollständiger Smoke-Ergebnisbeleg liegt nicht vor. Die reguläre
Wiederherstellung bleibt ungeklärt. Es wird kein weiterer Deploy gestartet.

`605e73954c0ef0c5e2f66baa228b942813f80e41` ist auf main. Das Paket ist lokal
erstellt; v0.92.60 ist nicht produktiv installiert. Die letzte bestätigte
produktive Version ist v0.92.58 nach dem geprüften Rollback.

Der Nutzer hat unmittelbar danach ausdrücklich die Fortsetzung und den
schnellstmöglichen Abschluss beauftragt. Die gezielte Prüfung wird an
derselben isolierten Testkopie fortgesetzt.

## Zusätzlicher Ressourcenbefund

Im fortgesetzten Test starteten die Datenbankverbindungen, aber die
Berichtsprozesse erreichten ihre 120-Sekunden-Frist. Das PostgreSQL-Protokoll
zeigt währenddessen drei gleichzeitige Autovacuum-Scans großer Importtabellen.
Sie teilen die auf einen CPU-Kern begrenzte Testumgebung mit den niedrig
priorisierten Berichtsprozessen. Die ausschließlich temporäre Restore-Instanz
führt deshalb keine automatische Hintergrundwartung aus. Alle Daten-, Rollen-,
Schutz- und Anwendungsprüfungen bleiben aktiv; der produktive PostgreSQL-Dienst
und seine Wartungseinstellungen bleiben unverändert. Die gezielte Prüfung der
bestehenden Testkopie läuft. Vier gezielte Start- und Recovery-Tests bestehen.
