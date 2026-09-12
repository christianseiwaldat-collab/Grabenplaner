# Kürzere Bereitstellung und nächtliche Wiederherstellungsprüfung

Stand: 11.09.2026. Die freigegebene Aufteilung ist lokal umgesetzt und gezielt
geprüft. **Noch nicht installiert:** Der produktive GP bleibt auf v0.92.36.
Die Änderung benötigt beim nächsten freigegebenen Release das passende
Kernpaket und den ausdrücklichen Wechsel auf Offsite-Modul 8.

Beim erstmaligen Wechsel kann der installierte Paketprüfer den neuen
Modulvertrag noch nicht kennen. Dafür erlaubt der Updater ausschließlich einen
expliziten, separat geprüften SHA256-Pin mit `--package-verifier-sha256`.
Der Prüfer und sein Pfad müssen root-geschützt sein. Dieser Aufruf erzwingt
die Vollprüfung; der bisherige Prüfer prüft weiterhin den installierten
Runtimevertrag. Paketdateien, Runtimevergleich und Offsite-Kompatibilität
bleiben vollständig geprüft. Normale Folgeupdates benötigen diese Option nicht.

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

## Umgesetzter Ablauf

| Anlass | Prüfung und Sicherung |
| --- | --- |
| Gewöhnliches kompatibles Update | Ein frischer, vollständig verifizierter DB-/Dokumentpunkt; Paketprüfung, Versionswechsel, kurze Betriebsprüfungen; signierter Auftrag für die nächste Nacht |
| Fehlender, veralteter oder unpassender Gesamtnachweis | Bisheriger vollständiger Ablauf mit externer Vorabsicherung und sofort anschließendem Recovery-Auftrag |
| Geänderter Server-, Datenbank-, Migrations-, Sicherungs- oder Laufzeitcode | Vollständiger Ablauf; keine Übernahme des alten Gesamtnachweises |
| Nachtlauf | Vorgemerkte Archivabschlüsse, neue externe Sicherung, vollständiges Lesen des Repositorys, isolierte Wiederherstellung samt App-Start, volle Datenbank-/Dokumentprüfung |
| Regelmäßiger Monitor | Erreichbarkeit, Dienste, TLS, freier Speicher, kurzer SQLite-Lesezugriff und gebundene Sicherungsmetadaten |

`grabenplaner-update --verification auto` ist der Standard. `--verification full`
erzwingt den vollständigen Ablauf; eine Option zum Erzwingen des kurzen Ablaufs
gibt es nicht. Im Updatebeleg stehen Auswahlgrund, Beginn und einzelne Phasenzeiten.
Das ist noch keine neue Messung der produktiven Gesamtdauer oder Ausfallzeit.

Der kurze Ablauf verlangt einen höchstens **36 Stunden** alten erfolgreichen
Gesamtlauf. Der root-geschützte Nachweis wird mit der signierten Historie sowie
mit Wiederherstellungscode, Abhängigkeiten, Datenbankschema, Migrationskennungen,
Datenbankpfad, Konfiguration und Node-Binary abgeglichen. Der nächtliche Timer
muss aktiviert und aktiv sein. Spätere Fehler, unvollständige Prüfungen und
Konfigurationsänderungen entwerten den Nachweis. Gewöhnliche vorgemerkte App-Updates
dürfen bis zum Nachtlauf folgen. Änderungen allein an Oberfläche und Version
bleiben möglich; Änderungen an `server.js` erzwingen vorsorglich den vollen Ablauf.

Archivaufträge liegen unter `maintenance/deferred-backups` im geschützten
Datenverzeichnis, gebunden an den exakten Sicherungsmarker. Höchstens zehn
Punkte dürfen ausstehen. Archivierung erfolgt zeitlich geordnet vor einem neuen
externen Archiv; Unterbrechungen behalten den offenen Auftrag und Rohpunkt.
Unbekannte alte Rohsicherungen werden nicht automatisch übernommen. Die
Offsite-Vorbereitung schließt diese Archive ab, während die App noch läuft.
Andere vollständige externe Sicherungsläufe dürfen die Aufträge ebenfalls erledigen.

Updater und Offsite-Vorbereitung übernehmen nun dieselbe Lebenszyklus-Sicherung.
Die Sperren für Wartung, Repository und Sicherungsdateien bleiben getrennt.
Beim Stoppen und Wiederanlauf wird dadurch keine zusätzliche native Sicherung
ausgelöst, solange der verantwortliche Wartungsprozess seine Sperre hält.

Die Organisationsmigration speichert einen Prüfbeleg erst nach erfolgreicher
globaler Fremdschlüssel- und `quick_check`-Prüfung. Ein unveränderter, bereits
geprüfter Migrationsstand benötigt diese Vollprüfung nicht bei jedem Start.
Nach Fehler oder Unterbrechung wird sie erneut ausgeführt. Fachliche
Beziehungsprüfungen laufen weiterhin; der Nachtlauf prüft die gesamte Datenbank.
Das behebt eine wiederholte Startarbeit, beweist aber noch nicht, dass die
produktive isolierte Startprobe nun innerhalb von 90 Sekunden erfolgreich ist.

## Betriebsprüfung und Aktivierung

`grabenplaner-test` ohne Modus bleibt die vollständige manuelle Prüfung.
`--monitor-mode` und `--deploy-mode` verwenden kurze Prüfungen. Dabei wird
ausdrücklich nur ein Sicherungsbeleg kontrolliert, nicht die Integrität aller
Dateiinhalte behauptet. `--nightly-mode` führt die vollständigen Datenbank- und
Sicherungsprüfungen im bereits laufenden Recovery-Auftrag aus.

Der Wechsel von installiertem Offsite-Modul 7 auf 8 ist ausdrücklich:

1. Neues Release samt Manifest und Hash prüfen. Der neue Paketprüfer akzeptiert
   den bisherigen Vertrag nur als installierten Vorgänger. Der alte Updater
   wird nicht durch Abschalten seiner Vertragsprüfung übergangen.
2. Den Installer aus dem geprüften Modul 8 mit den vorhandenen geprüften
   Binaries, geschützten Konfigurationsdateien und derselben Repository-Bindung
   verwenden. Kein `--initialize-repository`, kein Zielwechsel. Das Modul kann
   mit dem exakten Vorgänger Runtime 5/Modul 7 im bisherigen vollständigen
   Ablauf arbeiten; dabei wird kein Nachweis für kurze Deploys erzeugt.
3. Den geprüften neuen Updater aus dem bereitgestellten Paket mit
   `--verification full` ausführen. Seine Helfer müssen die regulären
   root-/Dienstgruppenrechte besitzen. Installierte Module, Paket, frischer
   Rückkehrpunkt und Bereitschaft werden weiterhin geprüft. Bei gescheitertem
   Kernupdate bleibt Modul 8 mit dem alten Kern kompatibel.
4. Nach dem Kernupdate den vollständigen Recovery-Lauf einschließlich
   isolierter Startprobe bestehen lassen. Erst dieser erfolgreiche, signierte
   Lauf erzeugt die neue Prüfbasis. Ein früherer Startzeitlimitfehler bleibt
   sichtbar und wird nicht manuell auf Erfolg gesetzt.
5. Timer, Monitor, Updatebeleg und Berichterstellung prüfen. Beim folgenden
   geeigneten Release die reale Gesamtdauer und Erreichbarkeit messen.

Es gibt bei dieser Umstellung keinen Host-Neustart. Der bisherige historische
Runtime-Wechsel 4 → 5 bleibt auf Offsite 6 → 7 begrenzt und autorisiert Modul 8
nicht. Die einmalige Einführung selbst wird deshalb noch umfassend geprüft.

## Nachweise der lokalen Umsetzung

- 95 bestandene Tests in der abschließenden Auswahl, vier plattformabhängige
  Überspringungen. Sie prüfen Auswahlregeln, Archivunterbrechung, tatsächliche
  Updater-Verzweigungen, Start nach fehlgeschlagener Integritätsprüfung,
  Monitor-Ausgabe und Assurance-/Modulverträge.
- Linux-Sperrübergabe mit beiden Descriptor-Paaren bestanden. Der separate
  Linux-Test für den Modul-7-Vorgänger und fehlende oder unsichere Modul-8-Helfer
  ist ebenfalls bestanden. Beide Läufe verwendeten isolierte temporäre Dateien;
  GP-Prozess, Version und Bootkennung blieben unverändert.
- Persistenzgrenzenprüfung bestanden; die Schemaabfrage verwendet den vorhandenen
  SQLite-Wartungsadapter. Kein neuer Datenbanktreiber außerhalb dieser Grenze.
- Weitere 16 Paket- und Runtime-Prüfungen bestanden, vier plattformabhängige
  Überspringungen. Der historische Übergang verweigert ausdrücklich Modul 8.

Diese Nachweise ersetzen nicht die erste produktive Recovery-Prüfung des neuen
Pakets. Die spätere Zeitersparnis wird erst nach dieser Aktivierung gemessen.
