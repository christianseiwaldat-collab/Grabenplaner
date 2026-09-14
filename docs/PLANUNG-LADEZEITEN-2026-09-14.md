# Lange Ladezeiten der Dienst- und Urlaubsplanung

Stand: 14.09.2026. Produktiv geprüft: v0.92.45-beta / `ebeadc7`.
Lokale Korrektur vorbereitet auf `feature/schedule-pdf-day-separators`, Basis
`c987bcf`. Die anschließende Freigabe umfasst alle sechs Integrationsblöcke und
den gemeinsamen Deploy; der Abschluss wird in `DEPLOY-RELEASE-v09246.md` ergänzt.

## Messung am VPS

Die Caddy-Protokolle bestätigen die gemeldete Verzögerung auf der Serverseite.
Beispiel Filiale 18, Wochen September 2026: `/api/schedule` zuletzt 7,158 bis
8,400 Sekunden; weitere Aufrufe desselben Tages lagen bei 9,363 und 13,026 Sekunden,
einzelne Spitzen bei 32,852 beziehungsweise 41,736 Sekunden. Die Urlaubsdaten
benötigten zuletzt rund 1,3 bis 1,6 Sekunden, während stärkerer gleichzeitiger
Belastung ebenfalls über zehn Sekunden. Alle genannten Antworten waren HTTP 200.

Der VPS hatte bei der lesenden Bestandsaufnahme um 18:38 CEST vier CPU-Kerne,
eine Last von 0,62 und rund 5 GB verfügbaren Arbeitsspeicher. Beide GP-Dienste
waren aktiv, ohne automatische Neustarts. Keine jüngsten Import-/Persistenz-
Fehlercodes im betrachteten 30-Minuten-Fenster. Einfache Datenbankabfragen
benötigten ungefähr 0,5 bis 3 Millisekunden. Eine allgemeine Speicherknappheit
oder eine blockierende Datenbanksperre wurde in diesen Stichproben nicht gefunden.

Zusätzlich wurden die tatsächlichen registrierten PostgreSQL-Abfragen mit
`EXPLAIN (ANALYZE, BUFFERS, TIMING FALSE)` unter der Leserrolle und einer
schreibgeschützten Transaktion geprüft. Mitarbeiter-/Planungsabfragen führten
in etwa 0,5 bis 2,3 Millisekunden aus; benötigte Seiten lagen bereits im
Datenbankcache. Die komplexe aktuelle Sitzungs-/Rechteprojektion benötigte
zusätzlich mehrere Millisekunden für die Abfrageplanung. Keine Sitzungstoken
aus dem Browser ausgelesen und keine Geschäftsdatensätze ausgegeben.

## Ursachen

1. `scheduleWorkRuleFacts` lädt für jeden Dienst des 17-wöchigen Prüfbereichs
   erneut Filialzeiten und die vollständige Samstagsbewertung. Die Regelprüfung
   verwendet daraus jedoch nur die Pausenwerte. Für die geprüfte Woche ab
   28.09.2026, Filiale 18, waren das sechs sichtbare Mitarbeiter und 239 historische
   Dienste an zwei Standorten. Bereits die Filialabfrage und zwei Bewertungsabfragen
   je Dienst erzeugen mindestens 717 zusätzliche Datenbankoperationen.
2. Der PostgreSQL-Adapter validiert nach jeder dieser Leseoperationen erneut die
   aktuelle Sitzung einschließlich sämtlicher Rechte und Bereiche. Diese wichtige
   Prüfung vervielfacht bei vielen kleinen Einzelabfragen die Arbeit. Die Stichprobe
   während der Navigation zeigt überwiegend darauf wartende Anwendungstransaktionen
   und sehr viele Zugriffe auf Sitzungs-/Rechtetabellen. Die Zähler gehören zum
   gesamten Messfenster und sind keine exakte Zählung eines einzelnen HTTP-Aufrufs.
3. Krankheitsgutschriften lesen denselben Fallbestand bisher erneut für jeden
   Mitarbeiter und Kalendertag. Bei sechs Mitarbeitern sind das 42 Leseoperationen
   für eine Woche.
4. Die Browserfunktion `loadAll` lädt bei jedem Wochenwechsel zwei Gruppen mit
   zusammen acht API-Aufrufen: Standorte, Positionen, Status, Rollen, Dienstplan,
   sämtliche Mitarbeiter, Jahresurlaub und Branding. Die Anzeige wartet auf die
   gesamte zweite Gruppe. Auch ein Wechsel des Urlaubsjahres lädt den Dienstplan
   unnötig mit.

## Lokale Korrektur

- Gemeinsame Pausenberechnung `plannedShiftBreaks`: Die Arbeitszeit-Regelprüfung
  erstellt ihre unveränderten Zeit-/Pausenfakten ohne Lohn- oder Samstagsbewertung.
  `shiftMetrics` verwendet dieselbe Berechnung weiterhin für die vollständige
  Stunden- und Samstagsbewertung.
- Filialzeiten werden innerhalb einer einzelnen Regelprüfung je Standort einmal
  geladen. Für die obige Schleife bleiben zwei Filialabfragen statt mindestens 717
  Einzeloperationen. Die eigentliche Abfrage der historischen Dienste kommt in
  beiden Varianten hinzu. Eine spätere Anfrage lädt aktuelle Einstellungen erneut;
  es gibt keinen dauerhaften Ergebnis- oder Rechtecache.
- Gemeinsamer Wochenabruf der Krankheitsfälle mit anschließender Zuordnung zu den
  sichtbaren Mitarbeitern und Tagen. Neuester passender Fall, Nullgutschriften,
  Wiederantrittsgrenzen und bestehende Krankheitsoptionen behalten ihre Bedeutung.
- Wochenpfeile, Heute und Datumssprung laden nur `/api/schedule`; ein anderes
  Urlaubsjahr lädt nur `/api/vacations`. Erstaufbau und vollständige Aktualisierungen
  verwenden weiterhin den vollständigen Ladeweg. Überholte Browseranfragen werden
  abgebrochen; verspätete Antworten dürfen weder neuere Zeiträume noch einen anderen
  Benutzer oder Standort überschreiben.

Die aktuelle Berechtigungsprüfung, organisatorische Filter, Dienstplansperren,
Regelbewertung und Schreibtransaktionen werden nicht abgeschwächt. Keine neuen
Tabellen, Indizes oder PostgreSQL-Schemamigrationen erforderlich.

## Prüfung und Abgrenzung

- Neun neue gezielte Tests bestanden: Pausen, 500 historische Dienste, frische
  Einstellungen beim Folgeaufruf, Kandidaten-/Lösch-/Standortgrenzen, Gleichheit
  der gebündelten Krankheitsgutschriften mit der Einzeltagesbewertung sowie
  Zeitraumwechsel, Reihenfolge, Sitzungswechsel und Fehlermeldungen im Browser.
- 31 bestehende Tests bestanden: Samstagsbewertung und -API, Arbeitszeitregeln,
  fachliche Sicherheitsregressionen, Wochenraster und manuelle Dienstplansperren.
- Syntaxprüfungen für `server.js` und `public/app.js`, Persistenz-Audit und
  `git diff --check` erfolgreich. Keine Vollsicherung oder Wiederherstellung nötig
  für die lokale Korrektur.
- Die produktive Installation wurde ausschließlich lesend untersucht. Der
  vorhandene Chrome-Tab steht wieder auf Dienstplanung, Filiale 18, Woche 28.09.2026.
  Es wurden keine Dienste, Urlaube, Berechtigungen oder Imports verändert.
- Zum ursprünglichen Prüfzeitpunkt waren die Änderungen lokal und uncommitted.
  Die spätere ausdrückliche Freigabe hebt die damalige Deploypause auf.
  Verbesserte komplette HTTP-Ladezeiten sind erst nach einer
  freigegebenen Veröffentlichung am VPS nachzuweisen; die Datenbankoperationen
  und Tests belegen bisher die gezielte Reduktion der Arbeit.

Lokale Diagnoseartefakte unter `tmp/`: `planning-performance-vps-20260914-result.json`,
`planning-performance-sample-20260914-result.json`,
`planning-performance-query-plans-20260914-result.json`,
`planning-performance-regressions.log` und `planning-performance-persistence-audit.log`.
