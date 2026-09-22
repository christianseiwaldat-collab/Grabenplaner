# System-Center: Befund und Umsetzung GP719

Stand: 22. September 2026. Produktionsdiagnose lesend; Codeänderungen im isolierten Branch `fix/gp719-system-center`. Noch nicht produktiv installiert.

## Datenbankgröße

Die angezeigten rund 11 GB sind die Summe der beiden PostgreSQL-Datenbanken. Der bestehende Formatter rechnet binär und beschriftet gerundet mit GB; die präzisen Zahlen sind:

| Datenbank | Byte | Binäre Größe |
|---|---:|---:|
| Kern | 208.484.031 | 198,83 MiB |
| Verkauf | 11.578.341.055 | 10,78 GiB |
| Zusammen | 11.786.825.086 | 10,98 GiB |

Die Größen wurden direkt mit `pg_database_size` ermittelt. Größte Tabellen der Verkaufsdatenbank einschließlich Indizes und zugehörigem TOAST-Speicher:

| Tabelle | Gesamter belegter Platz |
|---|---:|
| `integration.data_import_rows` | 2.68 GiB |
| `integration.data_import_links` | 1.20 GiB |
| `kassa.cash_snapshot_6` | 1.09 GiB |
| `integration.data_import_changes` | 0.86 GiB |
| `integration.import_history_versions` | 0.84 GiB |
| `integration.import_history_segments` | 0.80 GiB |
| `kassa.cash_snapshot_5` | 0.62 GiB |
| `integration.import_history_references` | 0.49 GiB |

Die wichtigsten Treiber sind persistierte Importzeilen, Importverknüpfungen, Änderungshistorien und Kassensnapshots. Das sind fachlich gespeicherte Datenbestände, kein Beleg für 11 GB Protokollmüll. `data_import_rows` hat geschätzt 1.211.695 lebende und 183.886 tote Tupel; Statistiken allein erlauben keine zuverlässige Aussage über rückgewinnbaren Speicher. Weder Daten noch Historien wurden gelöscht, und es wurde kein VACUUM FULL/REINDEX ausgeführt. Ein eigener Bereinigungsschritt muss zuerst benötigte Aufbewahrungszeiträume, Referenzen und mögliche redundante Snapshots prüfen.

## Sicherungshäufigkeit

`daily:14`, `weekly:8`, `monthly:12` sind Aufbewahrungsregeln: 14 Tagesstände, 8 Wochenstände, 12 Monatsstände. Sie bedeuten nicht 14 Uploads pro Tag. Die neue Beschriftung nennt ausdrücklich Tages-, Wochen- und Monatsstände.

Der aktive vollständige Sicherungslauf ist täglich um 03:00 Uhr konfiguriert. Der zusätzliche eigenständige Upload-Timer ist deaktiviert. Am 22.09. wurden bis zur Erhebung zwei Assurance-Läufe protokolliert: nachts fehlgeschlagen vor dem Upload; morgens manuell gestartet und vollständig bestanden. Am 21.09. gab es zwei erfolgreiche Läufe: Nachtlauf und Prüfung nach Änderung des Offsite-Moduls. Update-, Konfigurations- und manuelle Prüfläufe können zusätzliche Sicherungen erzeugen. Diese ereignisbezogenen Sicherungen werden durch eine Änderung des regelmäßigen Zeitplans nicht unterdrückt.

Die Auswertung `assurance-frequency.json` zählt signierte Assurance-Läufe nach Abschlussdatum und Auslöser; sie ist keine vollständige Inventur sämtlicher Restic-Snapshots.

## Abbruch des Nachtlaufs

Lauf `0af24322`, 22.09.2026, Zeitzone Europe/Vienna:

- 03:00:01: Start des systemd-Dienstes.
- 03:00:44,807: signierter Beginn des Assurance-Laufs.
- 03:01:35: automatische APT-Paketwartung startet parallel.
- 03:02:49: Anwendung für die konsistente Sicherung angehalten.
- 03:06:51: PostgreSQL erhält einen administrativen Fast-Shutdown. Der Unattended-Upgrades-/needrestart-Nachweis enthält ausdrücklich den Neustart von `grabenplaner-postgresql.service`.
- Gleichzeitig: offener PostgreSQL-Client bricht mit `57P01`, `terminating connection due to administrator command`, und unbehandeltem `error`-Ereignis ab.
- 03:07:16: APT-Wartung abgeschlossen.
- 03:08:23,194: Assurance als `PREPARE_FAILED` abgeschlossen; Dienst endet mit Exit-Code 1.

Die Dienstausführung dauerte rund 8 Minuten 22 Sekunden. Die signierte Prüfung selbst dauerte 7 Minuten 38 Sekunden. Weder ein Acht-Minuten-Timeout noch ein Google-Drive-Uploadfehler ist die Ursache. Der Upload und die anschließenden Restore-Prüfungen wurden nicht erreicht. Ein späterer manueller vollständiger Lauf von 08:37 bis 09:27 war erfolgreich.

## Umgesetzte Änderungen

- Getrennte Diagramme für Kern- und Verkaufsdatenbank, mit genauer Bytezahl und Messzeit bei Mausbewegung, Klick und Tastaturbedienung.
- 180/90/30/7 Tage auswählbar; Auswahl im Browser gespeichert. Aktuelle Vertrauensbewertung separat über dem unveränderten historischen Verlauf.
- Neue getrennte DB-Messreihe: tatsächliche Messzeit, höchstens ein Wert je Sechs-Stunden-Fenster, 180 Tage, begrenzte Größe und Prüfsumme. Speicherung erfolgt bei der Erhebung technischer Diagnosen. Alte Summenwerte werden nicht erfunden aufgeteilt. Ein Schreibfehler oder nicht verifizierbarer Verlauf wird kenntlich gemacht.
- Historischer Nachtfehler begrenzt den aktuellen Gesamtindex nicht mehr pauschal auf 49, wenn danach ein frischer vollständig verifizierter Recovery-Lauf bestanden wurde. Der Fehler bleibt sichtbar und verliert weiterhin seine Punkte. Deaktivierte, überfällige oder tatsächlich unbestätigte Recovery-Nachweise behalten ihre kritische Bewertung. Es wird kein künstlicher Wert von 100 gesetzt.
- Wartungsmatrix durch kompakte responsive Vorgangskarten mit Wochentagen, Rhythmus, Uhrzeit und Aktivstatus ersetzt. Vollständige Sicherung: einmal täglich an ausgewählten Tagen, alle 6 oder alle 12 Stunden; Schnellwahl täglich 03:00. Änderungen bleiben Entwürfe bis zum Speichern.
- Direkte PDF-/Markdown-Berichte pro Assurance-Lauf. Download verlangt technische Diagnoseberechtigung und erneute erfolgreiche Prüfung der gesamten Signaturkette; manipulierte IDs, fehlende Läufe und unbestätigte Historie werden abgewiesen. Nicht ausgeführte Phasen werden entsprechend bezeichnet.
- Verbindungsabbruch während des gepaarten PostgreSQL-Backups wird kontrolliert abgefangen; ein fehlerhaftes Paar darf weder versiegelt noch als vollständig bestätigt werden.
- Separater, reversibler Installer `server-tools/linux/lib/apt-maintenance-lock.py`: beide automatischen APT-Dienste verwenden dieselbe Wartungssperre wie GP. Kurze GP-Wartungsjobs werden von needrestart zurückgestellt, damit sie nicht während einer Sperrwartezeit neu gestartet werden. Datenbank- und Anwendungsdienste bleiben regulär neustartbar. Timerzeiten werden nicht verändert. Der Installer prüft die erwarteten Dienstbefehle und verweigert fremde Konfigurationen. Ohne `--apply` erfolgt ausschließlich die Vorprüfung.

## Prüfung und Freigabestand

Die APT-Vorprüfung auf dem tatsächlichen Server hat bestanden. Der Installer wurde nicht angewendet. Aktive Dienste, produktive Zeitpläne, Datenbanken und Sicherungsbestände sind unverändert.

Die lokale Vorschau verwendet die tatsächlichen Renderfunktionen mit ausdrücklich gekennzeichneten Beispieldaten. Desktopansicht, Dark Mode, Zeitraumauswahl und Wiederöffnen, genaue Messwerte/Tastatur sowie Zeitplanbedienung wurden geprüft. In schmaler Ansicht passen die Karten ohne horizontalen Seitenüberlauf; der Screenshot-Aufruf scheitert nach dem Viewport-Wechsel im Browserwerkzeug, deshalb ist diese Prüfung auf DOM-Maße beschränkt. Das PDF wurde als Bild gerendert und visuell auf Lesbarkeit und Seitenumbrüche kontrolliert.

153 gezielte Tests auf Linux mit Node.js 22.22.1 sind bestanden (153/153, keine ausgelassen). Ergebnisse stehen in `tests-linux.txt`. Syntaxprüfung von Server und Browsercode sowie `git diff --check` sind bestanden. Ein vollständiger produktiver Integrationstest und der erste Nachtlauf nach Installation stehen noch aus. Zusätzliche Tests prüfen unter anderem manipulierte Messhistorien, die Berechtigungsgrenze der Berichte, fehlgeschlagene PostgreSQL-Verbindungen, Intervallvalidierung, Sperrausschluss und die needrestart-Ausnahmen.

Vor Produktivsetzung: reguläres App-Release inklusive Offsite-Modul-Aktualisierung; neue APT-Sperrkonfiguration im freigegebenen Wartungsfenster installieren; anschließend vollständigen Assurance-Lauf und ersten automatischen Nachtlauf verifizieren. Die APT-Integration betrifft die automatischen APT-Dienste, nicht beliebige manuelle Paketbefehle. Manuelle Datenbank-/Paketwartung muss weiterhin das GP-Wartungsfenster und die gemeinsame Sperre beachten.
