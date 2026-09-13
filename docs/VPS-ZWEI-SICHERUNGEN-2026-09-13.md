# Zwei vollständige lokale GP-Sicherungspunkte

## Auftrag und Umfang

Am 13.09.2026 wurde die Aufbewahrung ausdrücklich auf **insgesamt zwei**
vollständige GP-Sicherungspunkte auf dem VPS begrenzt. Ein Sicherungspunkt
enthält immer beide PostgreSQL-Datenbanken (Core und Sales), Konfiguration,
Wiederherstellungsschlüssel, private Dokumente und Branding-Dateien.
Die entfernte Offsite-Aufbewahrung wird durch diesen Auftrag nicht verändert.

Bei dieser Bereinigung galt zunächst der Veröffentlichungsstopp für die noch
offenen Produktänderungen. Die hier beschriebene Änderung betrifft nur den ausdrücklich
beauftragten Sicherungsbetrieb und die Bereinigung des VPS. Kein Reboot,
kein Dienstneustart, keine Änderung an SSH, Netzwerk oder anderen Projekten.

Nach dem Bereinigungsauftrag hat der Benutzer den anschließenden Deploy aller
zuvor vorbereiteten GP-Änderungen ausdrücklich freigegeben. Dieser wird als
separater regulärer Release v0.92.43-beta durchgeführt und dokumentiert.

## Laufende Aufbewahrung

Die geschützte `/etc/grabenplaner/postgresql-operations.json` enthält:

```json
"localBackupRetention": { "keepCount": 2 }
```

`paired-retention.js` unterstützt damit eine Anzahl vollständiger Punkte,
unabhängig vom Kalendertag. Die alten Tagesparameter werden für diesen Server
durch die explizite Anzahl ersetzt. Zwei Sicherungen vom gleichen Tag bleiben
erhalten. Ohne diese Konfiguration bleibt der bisherige Tagesmodus verfügbar.

Der gemeinsame Betriebsadapter `postgresql-operations.js` prüft die Regel vor
der Sicherung. Nach einem erfolgreich abgeschlossenen neuen Sicherungspaar
prüft er sämtliche vollständigen Paare und entfernt nur die ältesten außerhalb
der zwei neuesten. Deployment, Nachtlauf und geschützte Wartungsaktionen nutzen
diesen Adapter unter den vorhandenen Wartungs- und Arbeitsbereichssperren.
Auch der nächtliche bisherige `prune ... 20`-Aufruf verwendet die Anzahl zwei.

Während der Erstellung darf vorübergehend ein dritter Punkt entstehen. Erst
nach dessen erfolgreicher Prüfung wird der älteste entfernt. Beschädigte
vollständige Sicherungen verhindern jede automatische Löschung. Unvollständige
oder unbekannte Dateien werden nicht ungeprüft als entbehrlich behandelt.

## Installation und Nachweis

Die beiden isolierten Betriebsdateien wurden als dokumentierte Wartungsänderung
auf der bestehenden Version 0.92.42-beta installiert. Vorherige Dateihashes
mussten exakt dem erwarteten Ausgangsstand entsprechen. Alle Manifestdateien
wurden vor und nach der Änderung geprüft; der Linux-Runtimevertrag blieb gleich.
Das Manifest erfasst die zwei neuen Dateihashes und den Wartungsnachtrag separat
zum ursprünglichen Quellcommit `e4cfbd6141a15c6a37f591787a34d5b3ec929de7`.

VPS-Nachweise und kleine Rückkehrdateien für diesen Betriebsnachtrag:
`/var/lib/grabenplaner-assurance/maintenance-evidence/retention-two-20260913/`.
Diese Konfigurations-/Codebelege sind keine zusätzliche vollständige GP-Kopie.
Die bestehende signierte Wiederherstellungsprüfung wird nicht umgeschrieben.
Nach dem geänderten Betriebsvertrag muss der reguläre Nachtlauf einen neuen
vollständigen Nachweis erzeugen, bevor ein späterer Kurzdeploy darauf beruht.

13 gezielte Tests bestanden: Paarkonsistenz, beschädigte Komponenten,
Offsite-Übernahme, Tagesmodus, zwei Punkte am gleichen Tag, unvollständige
Folgesicherung, ungültige Regeln, Reihenfolge Sicherung vor Rotation und
Vorrang der Serverregel im Nachtlauf. Der produktive Rotationsaufruf bestätigte
zwei gültige vollständige Punkte, ohne einen davon zu löschen.

## Bereinigung und lokales Archiv

Die alten SQLite- und Importsicherungen in den drei bisherigen GP-Ordnern wurden
nach erneuter Bestands-, Nutzungs- und Paarprüfung entfernt. Die leeren
Verzeichniswurzeln bleiben für bestehende Dienstverträge erhalten.
Dabei wurden 42,57 GB freigegeben; der freie Platz stieg zunächst von 19,38
auf 61,95 GB. Inventar und Löschbeleg werden lokal aufbewahrt.

Lokales geschütztes Archivverzeichnis außerhalb von Git:
`C:\Users\chris\Documents\Lamprechter\GP-VPS-Archiv-2026-09-13`.

Das Archiv sichert die erfolgreiche ursprüngliche Migrationsquelle einschließlich
Schlüssel und Dokumente, die zurückbehaltene ursprüngliche SQLite-Datei und die
Prüf-/Konfigurationsnachweise. Mehrfach erzeugte Test-Dumps, restaurierte
Testcluster und erneut installierbare Testabhängigkeiten werden nach dem
erfolgreichen produktiven Migrations- und Wiederherstellungsnachweis verworfen.
Sie sind nicht als unabhängige, künftig notwendige Datenbestände einzustufen.

Das lokale Archiv wird binär über SSH übertragen, anhand identischer SHA-256
am VPS und lokal geprüft und vollständig als TAR gelesen. Das Inventar hält
getrennt fest, welche Dateien archiviert und welche redundanten Testdateien
verworfen werden. Vor der Serverlöschung wurde das gesamte Quellinventar
unverändert bestätigt und auf laufende Zugriffe geprüft. Verzeichniswurzeln
wurden kanonisch gebunden; symbolischen Links wurde nicht gefolgt.

Abgeschlossen am 13.09.2026 um 19:29:52 UTC. Vier Migrations-/Prüfwurzeln und
die alte SQLite-Datei wurden nach Prüfung entfernt; die erforderlichen
PostgreSQL-Bezüge und kleine Migrationsabschlussnachweise bleiben erhalten.
38.442 Einträge im Quellinventar, 6.618 archivierte Einträge, Archivgröße
2.451.087.954 Byte. SHA-256 des vollständig gelesenen lokalen Archivs:
`22a665b84b26642a397d580cef68ec5459bbb17fe303c0e42402f0bc5d15d224`.

Freier Platz danach: **88.700.747.776 Byte / 88,70 GB**. Zusammen wurden
ungefähr **69,32 GB** frei. Der laufende PostgreSQL-Cluster benötigt etwa
3,26 GB und die zwei komprimierten Paare zusammen 2,01 GB. Die vom Benutzer
geschätzten 10 GB sind somit für diese beiden Gruppen großzügig bemessen;
Betriebssystem und andere Anwendungen benötigen ihren eigenen Platz.

Die zwei aktuellen Paare wurden vor dieser Konfigurationsänderung erstellt.
Bei einer späteren Wiederherstellung dieser älteren Punkte muss die hier
dokumentierte Aufbewahrungsregel erneut gesetzt werden. Neu erstellte Punkte
enthalten die geänderte Konfiguration automatisch.
