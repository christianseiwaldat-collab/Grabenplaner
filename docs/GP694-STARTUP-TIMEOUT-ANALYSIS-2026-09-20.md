# GP694: Startanalyse und getrennte Verbindungsqualifizierung

## Ergebnis und Freigabegrenze

Ein isolierter Anwendungsstart mit einer wiederhergestellten Core-Datenbank aus dem betroffenen Sicherungspaar scheiterte mit `PERSISTENCE_TIMEOUT`. Der gesicherte Stacktrace verweist auf das Fünf-Sekunden-Limit in `provider.acquireClient`. Die Untersuchung fand zusätzlich einen konkreten Schnittstellenfehler: Core und Sales lieferten dem Provider einen Pool, dessen `connect()` nicht nur auf eine Verbindung wartete, sondern auch deren vollständige Umgebungs- und Schemaqualifizierung ausführte. Dadurch konnte das Verbindungslimit bereits erfolgreich verbundene, noch in Prüfung befindliche Clients verwerfen.

Die Korrektur trennt diese Schritte. Der gezielte Regressionstest belegt den Fehlermechanismus unabhängig von der schwankenden VPS-Auslastung. Er beweist nicht, welcher Anteil der fünf Sekunden im fehlgeschlagenen realen Lauf auf das Warten beziehungsweise die Prüfung entfiel; die getrennte Zeitmessung wurde erst danach ergänzt.

**Die ursprüngliche Ursache von `IMPORT_REPORT_FAILED` bleibt historisch unbewiesen.** Dieser frühere Fehler entstand beim Worker-Start, während der jetzt nachgewiesene Zeitlimitfehler bereits in `application-data` auftrat. Es wäre falsch, beide ohne weiteren Nachweis gleichzusetzen. Die Änderung ist lokal vorbereitet, nicht ausgeliefert; eine Deployfreigabe ergibt sich daraus nicht.

## Untersuchung

Alle Starts erfolgten in eigens angelegten systemd-Diensten auf Ubuntu mit privatem Netzwerk, privatem temporärem Verzeichnis, eigenem PostgreSQL-18-Cluster und eigenen Rollenkennwörtern. Die Ressourcenbegrenzung entsprach der Wiederherstellungsprüfung: ein CPU-Kern, 1536 MiB, Nice 15. Produktive Datenbankpfade, Sockets, Konfigurationen und Sicherungsverzeichnisse waren im Testdienst gesperrt. Die erforderlichen Daten und Schlüssel wurden vorher gezielt in den privaten Testbaum kopiert; Schlüsselwerte wurden nicht protokolliert.

| Prüfung | Ergebnis und Aussagegrenze |
| --- | --- |
| Kernelprotokoll im historischen Fehlerfenster | Keine gefundenen OOM-, I/O-Fehler- oder Blockierungsereignisse; dies schließt Ressourcenengpässe nicht allgemein aus. |
| Vergleich ausgewählter Konfigurationen der vorher erfolgreichen und fehlgeschlagenen Sicherung | AMU-/Integrationsschlüsselkonfiguration und Operationskonfiguration identisch. Keine vollständige Gleichheit sämtlicher Sicherungsinhalte behauptet. |
| Exakte Core-/Sales-Schemata und technische Migrationsdaten, vier echte PostgreSQL-Worker | Alle Worker wurden bereit. Sales-Geschäftsdaten waren nicht enthalten. |
| Tatsächliche Serverinitialisierung mit Schemafixture und synthetischem Standort | Erfolgreich, etwa 108 Sekunden. Ein vorheriger Fixturestart ohne Standort wurde korrekt zurückgewiesen. |
| Tatsächliche Core-Sicherung plus Sales-Schema und technische Daten | Ein Start scheiterte nach etwa 37 Sekunden Initialisierung mit `PERSISTENCE_TIMEOUT` in `application-data`; der Stacktrace identifiziert den Provider-Verbindungstimer. |
| Anschließende Starts derselben isolierten Kopie mit Zeitmessung | Erfolgreich. Gemessene reine Poolwartezeit maximal 426 ms; beobachtete Core-Schemaqualifizierung bis 2810 ms. Diese Werte stammen nicht aus dem fehlgeschlagenen Lauf. |
| Weitere frisch wiederhergestellte Core-Kopie, Messung ab erstem Start | Erfolgreich; Anwendungsinitialisierung etwa 82,8 Sekunden. Dies zeigt die fehlende verlässliche Reproduzierbarkeit unter realer Last. |

Die erste Probe scheiterte an einem zu langen Unix-Socketpfad; dieser Fehler lag ausschließlich im Testaufbau. Der Socket wurde anschließend im privaten `/tmp` angelegt. Ein weiterer Aufbau ohne Standort war keine vollständige Anwendungsfixture und wurde entsprechend ergänzt. Diese Ergebnisse sind keine zusätzlichen Deployversuche und keine Ursachen des historischen Vorfalls.

Bei einer Vergleichsprobe wurde ausschließlich für Dateien der gestoppten, wegwerfbaren Testdatenbank `POSIX_FADV_DONTNEED` verwendet. Es erfolgte keine globale Cacheleerung. Auch dadurch entsteht kein kontrollierter Vergleich mit dem ursprünglichen historischen Zustand: bereits erfolgte Initialisierung und schwankende Systemlast bleiben Einflussgrößen.

## Korrektur

- `pool.connect()` liefert nur den tatsächlich verbundenen Client zurück. Sobald dies geschehen ist, endet der Fünf-Sekunden-Timer für den Verbindungserwerb.
- Eine explizite `prepareClient`-Funktion führt danach dieselben Umgebungs-, Suchpfad- und Schemaprüfungen aus. Erst nach erfolgreicher Prüfung dürfen Geschäftsanfragen oder Transaktionen beginnen.
- Die erste Verbindung und jeder neu erzeugte Ersatzclient werden weiterhin geprüft; bereits geprüfte Clients bleiben im bestehenden `WeakSet` erfasst.
- Fehler bei der Prüfung verwerfen den Client. Ein nach Ablauf der echten Poolwartefrist eintreffender Client wird ebenfalls verworfen, ohne Geschäftsanfrage.
- Poolgrößen und Zeitlimits werden nicht erhöht. Die PostgreSQL- und Treiber-Abfragegrenzen bleiben unverändert. Es gibt keine automatische Wiederholung.

Die ergänzte Workerdiagnose aus GP693 bleibt erhalten: zukünftige Startfehler übermitteln Phase und freigegebene technische Fehlerklasse statt ausschließlich `IMPORT_REPORT_FAILED`.

## Verifikation

66 gezielte Tests aus zehn Dateien bestanden unter Ubuntu: 0 Fehler, 0 übersprungene Tests, rund 18,1 Sekunden. Die neuen Fälle prüfen insbesondere eine korrekte Qualifizierung über der Poolwartefrist, weiterhin begrenztes Warten auf einen erschöpften Pool, Schema- und Abfragefehler sowie die Qualifizierung neu erzeugter Core- und Sales-Verbindungen. Zusätzlich wurden die vorhandenen Provider-, Poolpolicy-, Startup- und Workerdiagnosetests ausgeführt.

Der abschließende tatsächliche Start mit den drei korrigierten Modulen bestand ebenfalls: Dateninitialisierung, Beleg-Worker und Bericht-Worker wurden erfolgreich bereit; die Anwendungsinitialisierung benötigte rund 85,4 Sekunden. Anschließend wurden Anwendung und isolierter PostgreSQL-Cluster sauber beendet (`Result=success`, `MainPID=0`). Dieser Test verwendet die bereits zuvor initialisierte isolierte Core-Kopie und das Sales-Schema; er ersetzt keinen vollständigen Wiederherstellungs- und Berichtstest mit Sales-Geschäftsdaten. `fixed-core-startup.log` und die Modulhashes halten das Ergebnis fest. Aus dem Vergleich mit früheren Starts folgt kein belastbarer Geschwindigkeitsgewinn.

## Nächster notwendiger Nachweis

Vor Freigabe muss der korrigierte Kandidat einmal die vollständige isolierte Wiederherstellungsprüfung einschließlich Sales-Geschäftsdaten, Anwendungsstart und Bericht bestehen. Bei einem Fehler sind Phase und technische Fehlerklasse auszuwerten; keine automatische Wiederholung und kein anschließender Deploy.

Der vorherige vollständige Sales-Restore benötigte allein etwa 36 Minuten, der gesamte Wiederherstellungslauf etwa 42 Minuten. Kurz vor der regulären Wartung um 03:00 Uhr ist daher kein erneuter Vollrestore zu starten. Ein ausreichend großes, vorher geprüftes Wartungsfenster und die bestehenden Regeln zur Wartungssperre sind erforderlich. Die bisher gemessenen isolierten Startzeiten sind keine Messung der Dienstplan-Ladezeit im Browser.

## Lokale Nachweise

Im übergeordneten Aufgabenverzeichnis `output/deploy/gp694-startup-analysis` liegen unter anderem:

- `initial-audit.json`, `input-comparison.json`: Ausgangszustand und Sicherungsvergleich.
- `core-data-startup-probe.log`, `core-initial-failure.json`: tatsächlich fehlgeschlagener Core-Start und bereinigter Stacktrace.
- `core-startup-trace.log`, `core-startup-cold-trace.log`, `fresh-core-startup-trace.log`: nachfolgende Starts und getrennte Zeitmessungen.
- `ubuntu-focused-tests.tap`, `tested-source-sha256.json`: 66 Ubuntu-Tests und zugehörige Quellhashes.
- `fixed-core-startup.log`, `fixed-startup-source-sha256.json`: abschließender Start mit der Korrektur und exakte Modulhashes.

Diese Nachweise enthalten keine Schlüsselwerte. Alle eigenen, vollständig gestoppten Diagnosebäume mit den Rohdatenbanken und privaten Testkonfigurationen wurden anschließend entfernt. Die abschließende Prüfung um 02:25 Uhr bestätigte HTTP 200 / `ok: true` für Live und Ready, unveränderte Prozesskennungen der produktiven Dienste sowie dasselbe Release-Manifest. Die produktive Anwendung bleibt auf 0.92.61-beta; die beiden ursprünglichen Sicherungspaare sind unverändert. Rund 72,7 GB (67,7 GiB) sind auf dem VPS frei. Es laufen keine Backup-/Wartungsdienste; die nächsten regulären Wartungen stehen weiterhin um 03:00 Uhr an. Die gesonderte Sysstat-Messwerterfassung ist keine Wartungs- oder Cacheleerungsaufgabe.

`final-cleanup.json`, `final-audit.json` und `final-health.json` dokumentieren diesen Abschluss. Es erfolgte kein Deploy und keine Änderung der Wartungszeiten.
