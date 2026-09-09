# Optimierter Sicherungsablauf

Stand: 8. September 2026. Lokal umgesetzt; noch nicht produktiv ausgerollt.

## Umfang und Ergebnis

Der bisherige Updateablauf erzeugt auch bei kleinen App-Paketen mehrere
vollständige Datenbanksicherungen. Jede Archivierung liest zusätzlich das
gesamte lokale Archiv dreimal und stellt denselben neuen Sicherungspunkt
dreimal wieder her. Die gemessenen Zeiten des bisherigen Ablaufs stehen in
[VPS-DEPLOY-ANALYSE-2026-09-08.md](VPS-DEPLOY-ANALYSE-2026-09-08.md).

Die Änderung reduziert diese Arbeit pro erfolgreicher Archivierung auf
**einen vollständigen kryptografischen Archivleselauf und eine unabhängige
Wiederherstellung**. Strukturprüfungen bleiben vor der Sicherung und nach
der Bereinigung bestehen. Es wird keine andere Datenbank aufgebaut und
kein neuer Vollbestandsimport durchgeführt.

## Lokales Archiv

1. Vor der Erstellung wird die Archivstruktur samt signierter Historie,
   offenen Vorgängen, Speicherreserve und Aufbewahrungsgrenze geprüft.
2. Das gekoppelte Paar aus Datenbank und verschlüsselten Dokumenten wird
   archiviert, unabhängig wiederhergestellt und mit Datenbank-, Dokument-
   und Schlüsselprüfung bestätigt. Erst dann wird der Beleg signiert.
3. Vor einer Löschung werden alle Archivdaten einmal vollständig gelesen.
   Die signierte Wiederherstellungsbestätigung gilt für genau diese
   unveränderlichen Daten. Die aktuelle rohe Rückfallkopie wird erneut geprüft.
4. Ausschließlich die vom bestehenden 20-Tage-Modell bestimmten Snapshots
   werden entfernt. Die Bereinigung verwendet weiterhin
   `prune --max-unused 0 --max-repack-size 0`: Verwendete Datenpakete werden
   nicht neu geschrieben. Danach müssen Struktur, Index und Paketverweise
   erneut stimmen, bevor alte, ausdrücklich registrierte Rohkopien wegfallen.

Die neueste rohe Rückfallkopie, unregistrierte Altbestände, Dokumentbindung,
Schlüsselprüfung und manuelle Behandlung unterbrochener Vorgänge bleiben
erhalten. Ein fehlgeschlagener vollständiger Archivcheck hinterlässt jetzt
bereits einen offenen Vorgang. Weitere Versuche können dadurch keine neuen
Kopien ansammeln. Die bestehende Reconciliation prüft den Zustand ausdrücklich;
sie löscht selbst keine weiteren Sicherungen.

Grundlage für den Bereinigungsschritt sind die
[Restic-Dokumentation](https://restic.readthedocs.io/en/stable/060_forget.html)
und die [Optionsauswertung in Restic 0.18.1](https://github.com/restic/restic/blob/v0.18.1/cmd/restic/cmd_prune.go).
Eine spätere Änderung hin zum Neupacken von Daten erfordert eine neue
Prüfung dieses Nachweisablaufs.

## Sicherungsverantwortung während eines Updates

Der Linux-Updater übernimmt unter seiner vorhandenen Wartungssperre einen
zusätzlichen, an den konkreten Datenbankpfad gebundenen Auftrag. Dieser ist
eine vom Betriebssystem gehaltene Dateisperre in einem root-geschützten
Laufzeitverzeichnis. Die App erkennt ausschließlich einen aktiven, korrekt
gebundenen Auftrag. Eine alte Datei, eine geänderte Datei, ein anderer
Datenbankpfad oder ein Fehler bei der Sperrprüfung schalten ihre Sicherung
nicht ab. Beim Ende oder Absturz des Besitzers wird die Sperre freigegeben.

Während dieses Auftrags entfallen zusätzliche App-Sicherungen beim Start
und Stopp. Bereits laufende Sicherungsprozesse müssen weiterhin vollständig
enden, bevor Datenbank und Instanzsperre geschlossen werden. Normale Starts,
Stopps, manuelle Sicherungen und Sicherungen vor Datenmigrationen behalten
ihren bisherigen Schutz.

Der Updater erzeugt weiterhin den geprüften Stand vor der Offsite-Übertragung
und den frischen Stand unmittelbar vor dem App-Tausch. Diese beiden Punkte
werden bewusst nicht zusammengelegt: Während der Übertragung läuft die alte
App wieder, und es können neue Daten entstehen. Der zweite Punkt schützt
diese Änderungen bei einem notwendigen Rollback.

## Kontrollierter Dienststopp

Das Wartungswerkzeug sendet SIGTERM zunächst ausschließlich an den von
systemd gemeldeten Hauptprozess. Es wartet auf dessen Ende und lässt erst
danach systemd den Stopp abschließen. Der bisherige sofortige Gruppenstopp
konnte Restic-Prozesse abbrechen, während die App auf genau diese Prozesse
wartete. Ein unerwarteter neuer Hauptprozess oder ein nicht abgeschlossener
Stopp bricht die Wartung ab; der Helfer erzwingt keinen Prozessabbruch.
Die bestehende Grenze von 1.500 Sekunden bleibt bestehen.

Das Verhalten folgt der [systemctl-Dokumentation für gezielte Signale](https://github.com/systemd/systemd/blob/main/man/systemctl.xml).
Die systemd-Vorlagen und die Runtime-/Offsite-Verträge bleiben unverändert;
hierfür ist keine neue Runtime-Migration erforderlich. Direkte, außerhalb
dieser Wartungswerkzeuge ausgelöste systemd-Stopps verwenden weiterhin die
installierte Unit-Konfiguration.

## Freigabe und Grenzen

Die 20-Tage-Aufbewahrung, Offsite-Bestätigung und vollständige automatische
Betriebs- und Wiederherstellungsprüfung nach dem Update bleiben aktiv.
Außerhalb des Updaters wird kein zusätzlicher Sicherungsauftrag vergeben.
Eine verkürzte Freigabe nur aufgrund einer vermuteten Oberfläche-Änderung
ist nicht Bestandteil dieser Änderung.

Die echten kleinen Restic-Prüfungen zählen die ausgeführten Archivleseläufe
und Wiederherstellungen, vergleichen wiederhergestellte Hashes und prüfen
Fehler vor einer Löschung. Ergänzend werden Prozessablauf, manipulierte
Aufträge, Paketinhalt, Sperren und unveränderte Runtime-Verträge geprüft.
Eine isolierte Linux-Prüfung mit einem unprivilegierten Leser bestätigt die
echte Betriebssystemsperre einschließlich ihrer Freigabe beim Besitzerende.
Dabei werden keine produktiven Daten oder Dienste verändert.

Die neue Gesamtdauer eines echten VPS-Updates ist noch nicht gemessen.
Beim ersten Einspielen bleiben die bisher installierten Werkzeuge zunächst
in Benutzung; die Optimierung des Updaters wirkt vollständig bei folgenden
Updates. Die Änderung ist deshalb kein Versprechen einer bestimmten
Minutenzahl für den nächsten Release.
