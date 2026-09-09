# Deploylaufzeit und Wochenwechsel, 8. September 2026

Status: Ursachenanalyse abgeschlossen. Dienstplanfehler lokal korrigiert und
mit automatisierten Tests sowie im Browser geprüft. Kein neuer Deploy.
VPS, Sicherungsregeln und Filialfreigaben wurden ausschließlich gelesen.

## Warum kleine Veröffentlichungen lange dauern

Die Archivintegration aus `f0730ee` (v0.92.28, 7. September 2026) verbindet
jede neue Sicherung mit einer vollständigen lokalen Archivwartung. Gleichzeitig
enthält die produktive Datenbank inzwischen auch die importierten Verkaufsdaten.
Am 8. September um 17:51 UTC hatte sie 2.653.724.672 Bytes (2,65 GB).
Die Sicherungsarbeit richtet sich nach diesem Gesamtbestand und dem Archiv,
auch wenn ausschließlich wenige Oberflächendateien geändert wurden.

Der letzte Release v0.92.31 umfasste sechs geänderte Paketdateien und ein ZIP
von 3.632.526 Bytes. Aus den bereits vorhandenen Protokollen:

| Schritt | Zeit in UTC | Dauer |
| --- | --- | --- |
| Paketprüfung, Abhängigkeiten, Virenscan | 13:23:15–13:29:01 | 5 min 46 s |
| Erster Dienststopp einschließlich App-Abschlusssicherung | 13:29:01–13:46:51 | 17 min 50 s |
| Zusätzliche lokale Sicherung samt Archivierung | 13:46:55–14:13:40 | 26 min 45 s |
| Wiederanlauf, Offsite-Vorbereitung und Bestätigung | 14:13:41–14:31:19 | 17 min 38 s |
| Zweiter Dienststopp einschließlich App-Abschlusssicherung | 14:31:19–14:48:19 | rund 17 min |
| Weitere aktuelle lokale Rückfallsicherung | 14:48:35–15:11:17 | 22 min 42 s |
| Programmaustausch, Start und Releasebestätigung | bis 15:15:34 | rund 4 min |
| Automatische vollständige Wiederherstellungsprüfung | 15:15:45–15:56:59 | 41 min 15 s |
| Nachkontrollen und Abschluss | bis 16:10:12 | rund 13 min |

Updater insgesamt: rund 1 h 52 min. Einschließlich automatischer
Wiederherstellungsprüfung und Abschlusskontrollen: rund 2 h 47 min.
Der reine Abhängigkeitsaufbau dauerte laut Protokoll 6,3 Sekunden;
der Virenscan etwa 5,5 Minuten. Die Zeit wird überwiegend durch den
Sicherungsablauf bestimmt. Unterbrechungen und Wiederanläufe sind im
[Releasebeleg v0.92.31](PREBOARDING-RELEASE-v09231.md) einzeln dokumentiert.
Diese Zeiten sind Wandzeiten und dürfen nicht zusätzlich mit gleichzeitig
laufenden Startsicherungen aufsummiert werden.

### Wiederholungen im installierten Ablauf

1. `server.js` startet 1,5 Sekunden nach jedem App-Start eine Sicherung.
   Beim Beenden wartet die App auf laufende Sicherungen und erzeugt danach
   eine weitere Abschlusssicherung.
2. `server-tools/linux/update-grabenplaner-server.sh` stoppt die App,
   erzeugt selbst einen gekoppelten Sicherungspunkt, startet die bisherige
   App für die Offsite-Phase und stoppt sie anschließend nochmals für einen
   weiteren aktuellen Rückfallsicherungspunkt. Damit entstehen zusätzlich
   App-Sicherungen bei den Zwischenstarts und Stopps.
3. `lib/local-backup-archive.js` liest pro vollständig ausgeführtem lokalen
   Archivablauf dreimal alle Archivdaten (`check --read-data`): Vorprüfung,
   vor und nach der Aufbewahrungswartung. Der neue Punkt wird dreimal
   unabhängig wiederhergestellt und geprüft: bei der Archivaufnahme sowie
   vor und nach der Bereinigung.
4. Die Paarprüfer berechnen mehrfach den Hash der kompletten Datenbank und
   führen `PRAGMA quick_check` aus. Schon die Kopie wird geprüft, danach
   die veröffentlichte Kopie, die Archivaufnahme und jede Wiederherstellung.
   `maintainRetention()` führt Wartung und Nachprüfung auch dann durch,
   wenn keine Archivpunkte zum Entfernen ausgewählt wurden.
5. Nach jeder Veröffentlichung wird zusätzlich ein vollständiger
   `app-updated`-Assurance-Lauf eingeplant. Dessen Vorbereitung erzeugt wieder
   einen Sicherungspunkt und stoppt dafür die produktive App.

Die vier analysierten Backup-/Updaterdateien wurden per SHA-256 mit der
VPS-Installation abgeglichen. Die Bedeutung von `--read-data` ist in der
[Restic-Dokumentation](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#checking-integrity-and-consistency)
bestätigt: Der Befehl liest alle gespeicherten Datenpakete, nicht nur Metadaten.
Die dreifache Ausführung stammt aus unserem Ablauf.

### Zweiter Fehler: Dienststopp und Hintergrundsicherung

Aktuell installiert: `KillMode=control-group`, `TimeoutStopSec=25min`.
Dadurch erreicht das Stoppsignal auch bereits laufende Sicherungsprozesse.
Die App versucht zugleich, diese Prozesse geordnet fertiglaufen zu lassen.
Beim letzten Assurance-Start brach die Startsicherung tatsächlich ab
(`BACKGROUND_BACKUP_FAILED`, anschließend
`BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED`). Der reguläre Wiederanlauf
und eine spätere Startsicherung waren erfolgreich; das beseitigt den
grundsätzlichen Konflikt nicht.

Die Signalsemantik ist in der
[systemd-Referenz](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml)
dokumentiert. Eine kontrollierte Variante mit Signal zuerst an den
Hauptprozess und späterem erzwungenem Ende der gesamten Gruppe (`mixed`)
ist ein zu prüfender Lösungsweg. Ein bloßer Wechsel ohne Tests der
Kindprozessbeendigung wäre keine abgeschlossene Reparatur.

Die separate nächtliche Prepare-Unit besitzt weiterhin ein 30-Minuten-Limit
und meldet als letzten Ausgang `timeout`. Ihre Zeit umfasst auch das
Stoppen und Sichern. Das erklärt diesen zusätzlichen Abbruchpfad.

### Vorgeschlagene Verbesserung, noch nicht umgesetzt

- Einen koordinierten Sicherungsablauf pro Wartung verwenden. Eine frische,
  vollständig geprüfte Rückfallsicherung muss weiter vorhanden sein; App
  und Updater sollen denselben Auftrag nicht unabhängig mehrfach erledigen.
- Aufnahme eines neuen Sicherungspunkts von vollständiger Archivprüfung,
  Aufbewahrungsbereinigung und deren Wiederherstellungsproben trennen.
  Die Prüfung des neuen Punkts, signierte Herkunft und definierte
  Wiederherstellungsprüfungen bleiben verbindlich. Bereinigung erhält einen
  eigenen belegten Wartungslauf.
- Reine Oberflächenupdates anhand tatsächlich geänderter Paketdateien von
  Server-, Schema- und Speicheränderungen unterscheiden. Für die erste
  Kategorie einen kurzen Releasepfad mit gültigem Rückfallnachweis und
  gezielter Funktionsprüfung vorsehen. Vollständige Wiederherstellung
  zeitlich geplant und bei relevanten Änderungen durchführen.
- Dienststopp und Sicherungsprozesse gemeinsam koordinieren; Zeitlimits
  erst aus diesem bereinigten Ablauf ableiten. Keine pauschale Erhöhung
  als Ersatz für die Beseitigung mehrfacher Arbeit.

Eine konkrete neue Deploydauer ist noch nicht gemessen. Aus den vorhandenen
Belegen lässt sich die unnötige Wiederholung belegen; eine minutengenaue
Zusage für einen noch nicht implementierten Ablauf wäre nicht belastbar.
Es wurde kein neuer Vollbestandstest und kein Sicherungs-/Restorelauf
gestartet. Rund 60,6 GB freier VPS-Speicher wurden lesend bestätigt.

## Dienstplan: Wochenwechsel bleibt am alten Raster stehen

Der Fehler wurde in einem separaten Browser-Tab auf v0.92.31 reproduziert:
Datumsfeld `2026-09-14`, Überschrift KW 38, Tagesraster noch 7.–12. September
und Meldung `Cannot read properties of undefined (reading 'split')`.

Eine Planungsabwesenheit reicht bis Sonntag, 20. September. Der Plan blendet
deshalb den Sonntag zusätzlich ein. Für diesen Tag existieren keine
Öffnungszeiten. `operatingHours()` behandelte fehlendes `sunday_open` bisher
als geöffnet und gab undefinierte Start-/Endzeiten weiter. `timeToMinutes()`
brach ab, bevor das neue Raster eingesetzt wurde. Der bereits aktualisierte
Kopf und das alte Raster blieben dadurch zusammen sichtbar.

Die lokale Korrektur in `public/app.js` liefert Öffnungszeiten nur bei
einem gültigen Zeitpaar. Ein Sonntag ohne Öffnung bleibt im Raster sichtbar,
wenn dort Einträge liegen. Bestehende Dienste und Abwesenheiten werden
weiter angezeigt; es werden keine Ersatzzeiten erfunden oder Daten geändert.

Prüfung:

- Neue Regressionstests reproduzierten zunächst genau den `split`-Fehler.
- Anschließend bestanden alle 18 gezielten Tests für Wochenraster,
  Sonntagsabwesenheit, Sonntagsdienst, Dienstwahl, Filialeinsatz und Sperren.
- Im echten lokalen Browser mit eigener kleiner Testdatenbank und
  synthetischer Person: nächste Woche, vorige Woche, Datumssprung auf
  21. September, zurück auf 14. September und Heute erfolgreich.
  Datum, Kalenderwoche, Tagesraster und unterschiedliche Wochendienste
  stimmen überein. Keine Fehler-/Warnmeldungen im Browserprotokoll.
- Eigene Prüftabs geschlossen und lokaler Testserver beendet. Das
  ursprüngliche Bearbeitungsfenster des Nutzers blieb erhalten.

Die Korrektur ist lokal vorbereitet. Sie ist noch nicht auf dem VPS installiert.

## Leihe: vollständiger Filialabgleich

Am 8. September um 17:51 UTC produktiv aus `locations` und
`loan_location_settings` gelesen:

| Filiale | Leihe aktiviert |
| --- | --- |
| 05 Mitterweg | Nein |
| 11 Boznerplatz | Nein |
| 13 Sparkassenplatz | Nein |
| 18 Grabenweg | Ja |
| 77 Foto Straub | Nein |
| 99 United Camera Wien | Nein |

Es existiert genau eine Freigabezeile, für 18. Die vorherige Hervorhebung
von 11 bezog sich auf die ausdrückliche Nutzerkorrektur für diesen Standort;
sie beschrieb keine Sonderstellung gegenüber den anderen inaktiven Filialen.
Die vollständige Aussage lautet: ausschließlich Filiale 18 ist aktiviert.
Das persönliche Standardrecht eines Mitarbeiters ersetzt keine
Standortfreigabe.
