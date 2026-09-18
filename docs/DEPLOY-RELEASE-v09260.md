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
