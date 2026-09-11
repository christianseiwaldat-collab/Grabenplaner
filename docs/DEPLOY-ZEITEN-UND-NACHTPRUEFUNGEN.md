# Kürzere Bereitstellung und nächtliche Wiederherstellungsprüfung

Stand: 11.09.2026. Die Aufteilung ist fachlich freigegeben. Die technische
Umstellung des Wartungsablaufs folgt getrennt vom Funktionsrelease v0.92.36.
Diese Beschreibung ist kein Nachweis einer bereits installierten Änderung.

## Beobachtete Dauer

Der Releaseablauf umfasst deutlich mehr als Paketübertragung und Versionswechsel.
Die bisher abgeschlossenen Schritte zeigen folgende Größenordnung:

| Schritt | Gemessene Dauer |
| --- | --- |
| Lokale Auswahl von 658 Tests, erster Lauf | 5 min 15 s |
| Erste gekoppelte Sicherung im Updater samt Archivabschluss | 22 min 27 s |
| Wiederanlauf des bisherigen Anwendungsstands | 6 min 30 s |
| Vorbereitung, Übertragung und Prüfung des externen Rückkehrpunkts | 8 min 57 s |
| Zweiter aktueller Rückkehrpunkt direkt vor dem Versionswechsel | 7 min 50 s |
| Versionswechsel und Bereitschaft der neuen Anwendung | 6 min 11 s |
| Zusätzliche native Sicherung beim anschließenden Dienststopp | rund 23 min, danach Zeitlimit |
| Eigener Sicherungspunkt der automatischen Recovery Assurance | 14 min 18 s |
| Staging, Wiederanlauf, Übertragung und erste Archivprüfung | 13 min 52 s |
| Vollständiges Lesen des externen Repositorys | 4 min 6 s |
| Isolierte Wiederherstellung einschließlich gescheiterter Startprobe | 10 min 35 s |
| Nachholen des unterbrochenen lokalen Archivabschlusses | 3 min 5 s |
| Manueller Serverbetriebstest einschließlich Backupprüfung | 12 min 15 s |
| Separater Offsite-Selbsttest | 22 s |
| Abschließender erfolgreicher regulärer Monitorlauf | 3 min 42 s |

Zusammengesetzte Phasen enthalten mehrere Arbeiten; ihre Dauer ist keine reine
Upload- oder Datenbankzeit. Die Gesamtdauer des Wartungslaufs und die tatsächliche
Nichterreichbarkeit der Anwendung müssen getrennt ausgewiesen werden.

Die Offsite-Vorbereitung übernimmt vor dem Stoppen der Anwendung nicht die
Lebenszyklus-Sicherung über den bestehenden Wartungs-Lease. Dadurch beginnt
zusätzlich eine native Shutdown-Sicherung. Der Updater selbst verwendet diese
Koordination bereits. Der beim Stoppen erreichte Sicherungs-Timeout erklärt
einen Teil der Verzögerung und muss an dieser Zuständigkeit behoben werden.

Die Wiederherstellungsprobe erstellt außerdem eine bereinigte Datenbankkopie,
führt `VACUUM` sowie vollständige Integritäts- und Fremdschlüsselprüfungen aus
und startet erst danach die isolierte Anwendung. Schon die Vorbereitung der
Testkopie dauerte mehrere Minuten. Der eigentliche Start scheiterte erneut am
bestehenden 90-Sekunden-Limit; die Datenwiederherstellung hatte bestanden.
Der fehlgeschlagene Anwendungsstart bleibt ein eigener offener Nachweis.

Der automatische Monitor ruft dieselbe Serverprüfung mit `--monitor-mode` auf.
Auch dabei werden Datenbank und gekoppeltes Backup umfangreich geprüft;
die Unit begrenzt den Lauf auf vier Minuten. Mehrere reguläre Läufe erreichten
dieses Limit. Der abschließende reguläre Lauf bestand am 11.09.2026 um
20:43:51 UTC mit allen 24 Prüfungen in 3 Minuten 42 Sekunden. Dafür wurden
weder Prüfungen noch Zeitlimits geändert. Die vorherigen Zeitüberschreitungen
und die geringe Reserve zum Vier-Minuten-Limit bleiben Teil der Untersuchung.

Die separate Abschlussprüfung der Live-Datenbank benötigte für
`integrity_check` 110,564 Sekunden und für `foreign_key_check` 3,523 Sekunden.
Das sind Zeiten dieser konkreten Prüfung, keine isolierte Messung des Starts.
Bei der laufenden Backupprüfung zeigten die Prozesse erhebliche Plattenwartezeit;
CPU- und Speicherbegrenzungen der untersuchten Wartungssitzung waren nicht aktiv.
Etwa 5,9 GB von rund 8 GB Arbeitsspeicher waren verfügbar.

## Freigegebene Aufteilung

Beim normalen Deploy bleiben:

- ein frischer, eindeutig dem Versionswechsel zugeordneter Rückkehrpunkt für
  Datenbank und geschützte Dokumente;
- Paket-, Versions- und Laufzeitprüfung sowie Migrationskompatibilität;
- kurze Erreichbarkeits- und Funktionsprüfungen der geänderten Bereiche;
- ein Vergleich der betroffenen Datenbestände und eine belegte Rückkehrmöglichkeit.

Umfangreiche Archiv- und Wiederherstellungsprüfungen werden in die nächtliche
Routine verlagert. Dazu gehören das vollständige Lesen historischer Archive,
der umfangreiche isolierte Restore und seine Anwendungsprobe. Die Aufbewahrung
soll außerhalb des kurzen Versionswechsels abgearbeitet werden können.

Änderungen an Datenbankmigrationen, Sicherung, Recovery oder Laufzeitverträgen
benötigen weiterhin eine umfassende Prüfung vor Freigabe. Fehlende, veraltete
oder fehlgeschlagene nächtliche Nachweise benötigen einen definierten Rückfall
auf den umfassenden Ablauf. Ein alter grüner Test darf nicht unbegrenzt gelten.

## Nächste technische Schritte

1. Jede Phase messen und Datenvolumen, Prozesszeit, Plattenwartezeit sowie
   tatsächliche Ausfallzeit erfassen. Bereits geprüfte unveränderte Quellen
   nicht ohne sachlichen Grund erneut vollständig lesen.
2. Die Zuständigkeit für Start-, Stopp- und Updatesicherungen vereinheitlichen.
   Unterbrechungen müssen weiterhin eine nachvollziehbare Wiederaufnahme erlauben.
3. Den langsamen Anwendungsstart messen. Kandidaten sind insbesondere die
   wiederholten globalen Datenbankprüfungen nach den Organisationsmigrationen.
   Ihr genauer Zeitanteil ist noch zu bestimmen; ein höheres Zeitlimit allein
   behebt die Ursache nicht.
4. Kurzen Deploy und vollständigen Recoverylauf als getrennte, belegbare Abläufe
   implementieren. Die Freigabebedingungen für Alter, Version und Quellenstand
   der nächtlichen Nachweise werden dabei ausdrücklich festgelegt.
5. Das Verhalten bei normalem Update, Datenbankmigration, unterbrochener
   Sicherung und fehlgeschlagenem Nachtlauf prüfen. Danach neue Zeitbudgets
   aus den tatsächlichen Messungen ableiten.

Die unveränderten Produktivskripte und signierten Prüfereignisse des Releases
v0.92.36 bilden die Ausgangsbasis. Bis zur gesonderten Umsetzung gilt weiterhin
der installierte Wartungsablauf.
