# Untersuchung: Unterbrechungen während der Datenbankimporte

Stand: 14.09.2026, 04:22 Uhr Europe/Vienna. Auftrag: Ursache prüfen.
Produktiv: v0.92.44-beta, Runtime a498d00f0dc07fea69ae68e0b9d3eaa96bc17b4d.
Es wurden ausschließlich lesende Zugriffe am VPS ausgeführt. Kein Neustart,
Import, Datenbankeingriff, Timerwechsel oder Deployment wurde ausgelöst.

## Nachgewiesene Abschaltungen

Alle Uhrzeiten in dieser Tabelle sind Wiener Sommerzeit (UTC+2).

| Zeitpunkt | Nachweis |
| --- | --- |
| 01:34:12 | Ein Trade-Upload endete am Proxy mit HTTP 502 und HTTP/2 `CANCEL`. Der GP-Prozess lief dabei weiter. Der genaue Grund des Uploadabbruchs ist nicht nachgewiesen. |
| 02:17:13 | Zwei Portalabfragen konnten keine PostgreSQL-Verbindung innerhalb des Pool-Zeitlimits erhalten. Dies ist kein protokollierter Prozessabsturz. |
| 02:42:43 | Die tägliche Offsite-Vorbereitung startete. |
| 02:42:56 | Die Sicherungsroutine beendete `grabenplaner.service` ausdrücklich per SIGTERM. Dienstende erfolgreich. |
| 02:44:53 | Der GP lauschte wieder auf Port 3000; der Proxy meldete während seiner Wiederanlaufphase noch bis 02:45 Uhr zeitweise 503. |
| 02:53:59 | Neuer Import von `Trade_DatenBestell.accdb` angelegt. |
| 03:19:05 | Letzter bestätigter Fortschritt in den Bestell-Importzeilen. |
| 04:10:21 | Der zusätzliche nächtliche Recovery-Assurance-Lauf startete. |
| 04:11:08 | Auch dieser Lauf stoppte den GP kontrolliert für einen gemeinsamen Sicherungspunkt. |
| 04:13:12 | Der GP lauschte wieder; spätere öffentliche Bereitschaftsabfragen lieferten HTTP 200. |

Die zwei vollständigen Unterbrechungen sind den Sicherungsdiensten eindeutig
zugeordnet. Kein Kernel-OOM-Ereignis im geprüften Zeitraum seit 01:10 Uhr,
`NRestarts=0`, erfolgreiche Dienstenden, unveränderter produktiver Runtime-Stand.
Die Zeitüberschreitungen und der einzelne Uploadabbruch werden nicht pauschal
als dieselbe Ursache gewertet.

## Doppelter Sicherungsplan

Aktiv sind beide Timer:

- `grabenplaner-offsite-upload.timer`: täglich 02:35 Uhr plus bis zu 20 Minuten
  zufällige Verzögerung. Der Upload verlangt vorher eine lokale Vorbereitung.
- `grabenplaner-offsite-assurance.timer`: täglich 03:45 Uhr plus bis zu 90 Minuten
  feste Zufallsverzögerung. Dieser vollständige Lauf erzeugt ebenfalls einen
  Sicherungspunkt und führt die Offsite- und Wiederherstellungsprüfung aus.

`server-tools/linux/offsite/grabenplaner-offsite-prepare.sh` ruft vor dem neuen
Sicherungspunkt `gp_stop_service` auf. Damit stoppen derzeit beide Pläne den GP.
Die Wartungssperre schützt Sicherungsabläufe gegeneinander; die Importlaufzeit
ist darin nicht als laufender Auftrag registriert.

## Bestell-Import ist unvollständig

- Datei: 136.056.832 Bytes, 21 bekannte Tabellen, 414.434 deklarierte Zeilen.
- Bestätigt zwischengespeichert: 204.181 Zeilen (rund 49,3 Prozent).
- Letzte unvollständige Tabelle: `Rechnung_Z`, 5.400 von 13.211 Zeilen.
- Die ersten elf Tabellen sind bereit für die anschließende Prüfung; keine
  dieser Bestell-Tabellen wurde produktiv übernommen.
- Die Reparaturtabelle mit 8.021 Zeilen wurde noch nicht bereitgestellt.
- Der gespeicherte Quellkopf steht auf `reading`, `complete=false`, ohne
  Fehlercode. Nach dem Dienstneustart projiziert die Laufzeit einen solchen
  Kopf ohne aktiven Worker korrekt als `interrupted`.
- Der letzte Quellkopf-Zeitstempel ist 04:11:08.884 Uhr, die letzte bestätigte
  Sales-Zeilenfortsetzung bereits 03:19:05.495 Uhr. Dieser Unterschied bleibt
  Teil der Fehleruntersuchung; ein Zeitstempel allein belegt keinen Fortschritt.

`lib/tradefoto-full-import-reader.js` begrenzt den gesamten Worker-Auftrag fest
auf 1.500.000 ms (25 Minuten), einschließlich der quittierten Datenbankschritte.
Der letzte bestätigte Fortschritt nach etwa 25 Minuten passt genau zu dieser
Grenze. Ein gespeicherter `IMPORT_SOURCE_READ_TIMEOUT` fehlt jedoch; deshalb ist
der konkrete Abbruchpfad nicht abschließend nachgewiesen. Das anschließende
Warten auf `worker.terminate()` und den noch offenen `onMessage`-Schritt sowie
das Speichern des Unterbrechungsstatus müssen gezielt geprüft werden.

Der Shutdown in `server.js` wartet auf Berichte und AUM-Vorgänge, besitzt aber
keinen entsprechenden Drain-/Abbruchvertrag für den nach HTTP 202 weiterlaufenden
ACCDB-Import. Der Wartungsstopp kann diesen Auftrag daher vor seiner sauberen
Statusübergabe beenden.

Kassenveröffentlichung und Artikel-Importstand sind unverändert. Bei der letzten
lesenden Prüfung bestanden keine wartenden Datenbanksperren oder langen offenen
Transaktionen. Core ca. 198 MB, Sales ca. 3,09 GB; VPS ca. 83 GiB frei.

## Empfohlene Korrektur

1. Die beiden nächtlichen Sicherungspläne in einen Ablauf zusammenführen. Dabei
   die bestehende Offsite- und Wiederherstellungsprüfung und zwei lokalen
   Sicherungspaare erhalten; keinen Timer ohne Ersatz stilllegen.
2. Import und Wartung koordinieren: keine neuen Importaufträge während einer
   angekündigten Schreibpause, laufende Arbeit bis zu einem bestätigten
   Zwischenstand abschließen oder kontrolliert als fortsetzbar markieren.
   Erst danach den Sicherungspunkt erzeugen.
3. Für große ACCDB-Dateien Fortschritts- und Stillstandsgrenzen getrennt führen.
   Ein arbeitender Import darf nicht allein wegen 25 Minuten Gesamtdauer enden.
   Abbruch, Statusspeicherung und Wiederaufnahme begrenzt und nachvollziehbar
   gestalten; dieselbe Datei darf keine doppelten Zeilen erzeugen.
4. Eine Sicherung ohne vollständigen Webdienststopp separat qualifizieren:
   gemeinsame Schreibbarriere für Core/Sales und geschützte Dateien, danach
   konsistente Snapshots und Freigabe des normalen Betriebs. Zwei unabhängige
   ungeprüfte Online-Dumps ersetzen diesen Konsistenzvertrag nicht.

Gezielte Validierung für die Umsetzung: großer synthetischer Import mit
parallelen GP-Leseabfragen; künstlich kurze Frist bei weiterlaufendem Fortschritt;
Wartung mitten im Import; Dienstende und Wiederaufnahme ohne Duplikate. Ein
produktiver Wiederholungsimport ist kein geeigneter Regressionstest.

## Nachweise

Die nachfolgende Umsetzung vom 14.09.2026 ist in
[IMPORT-STABILITAET-2026-09-14.md](IMPORT-STABILITAET-2026-09-14.md) dokumentiert.
Die vorstehende Diagnose beschreibt den damals produktiven Stand v0.92.44;
die Korrekturen sind zunächst lokal und ändern diese historische Einordnung nicht.

Lokal unter `tmp/import-incident-20260914-*`: lesende Diagnosehelfer,
sanitisierte Quellmetadaten und Proxy-Ereignisse. Ausgaben enthalten keine
Zugangsdaten, Kundendatensätze oder Browsercookies. Die ersten beiden
Diagnosehelfer-Fehler (leere Journal-Suche mit Exit 1, nicht erlaubte
Monitorverbindung zur Datenbank `postgres`) waren Diagnosefehler; anschließend
wurde die vorgesehene Monitorverbindung zu `grabenplaner_core` erfolgreich
verwendet. Sie sind keine Anwendungsfehler.
