# Release v0.92.49-beta

Die Live-Bedienprüfung zeigte nach Verlassen und erneutem Öffnen der
Importseite einen stehengebliebenen Anzeigestand. Die Datenübernahme lief
auf dem Server weiter, aber die Auftragsauswahl hatte den Aktualisierungstimer
abgebrochen und nicht wieder gestartet.

Die Auswahl eines gespeicherten Auftrags lädt nun auch die aktuelle Liste
und startet bei aktiven Aufträgen wieder die bestehende automatische
Aktualisierung. Berechtigungen, Freigabe und Serververarbeitung bleiben
unverändert. 17 Import-/UI-Prüfungen und 8 Versionsprüfungen bestanden.

Der letzte Aufruf enthielt noch die separat gepinnte Prüferfreigabe aus
früheren Wartungsarbeiten. Dieser Parameter erzwingt eine Vollprüfung auch
bei unverändertem Prüfer. Da der installierte und der mitgelieferte Prüfer
identisch sind, verwendet dieses normale Folgeupdate den regulären
installierten Paketprüfer. Hash- und Manifestprüfung, frischer gemeinsamer
Rückkehrpunkt und Betriebsprüfungen bleiben verpflichtend. Der unveränderte
kritische Programmvertrag erlaubt die Nutzung des bestätigten v0.92.47-
Wiederherstellungsnachweises; die neue vollständige Prüfung folgt im Nachtlauf.

Der tatsächliche Updater fiel dennoch auf `full` zurück: Er war aus dem
zusätzlich entpackten Kandidaten gestartet worden, in dem `pg` fehlte.
Die gleiche Prüfentscheidung aus dem installierten Baum war vor Beginn
`short`; der Kandidatenaufruf scheiterte nachweislich mit `MODULE_NOT_FOUND`.
Der laufende Release wird regulär abgeschlossen. Der normale Aufruf für
weitere kompatible Updates ist im Dokument
[Deployzeiten und Nachtprüfungen](DEPLOY-ZEITEN-UND-NACHTPRUEFUNGEN.md)
präzisiert. Es wird kein weiterer Release nur zur Zeitmessung ausgelöst.

Produktiv abgeschlossen am 14.09.2026 um 23:40:45 UTC, nach Beginn um
23:25:20 UTC (15 Minuten 25 Sekunden). Paketquelle
`4db87312d63b77dc0f19e5fbfba9c6648651fb52`, SHA256
`a9a97af1ec08cdca4deea72c417576fc5e5a2893d20dd7f8cf998c1d84df9272`.
Alle 697 Manifestdateien, vier Erreichbarkeitsprüfungen, die unveränderten
PostgreSQL-Schemata und Rollen sowie der separate Offsite-Betriebstest bestanden.
Die vier echten Artikelprüfungen bestätigten weiterhin den Durchschnitts-EK,
RE und Ziel-RE. Andere Dienste und die Host-Bootkennung blieben unverändert.

Im frisch geladenen Chrome wurde v0.92.49 angezeigt. Nach der Auswahl des
bestehenden Trade-Auftrags stieg der Stand ohne manuelles Aktualisieren von
45.447 auf 46.132 Zeilen. Der Auftrag lief nach dem Dienstwechsel mit null
Fehlern/Wiederholungen und exakt 72 Stunden Aufbewahrungsfrist weiter. Das
belegt die Wiederaufnahme und Anzeige, noch nicht den Abschluss aller 396.466
Quellzeilen. Eine separate Funktionsprobe des echten Clientmoduls bestätigte
ebenfalls Auswahl, Wiederanlauf des Timers, Folgeaktualisierung und Abbau.

Der reguläre Monitor bestand am 14.09.2026 um 23:43:44 UTC alle 24 Prüfungen.
Kein automatischer Neustart wurde ausgelöst. Zwei vollständige Sicherungspaare
blieben erhalten; rund 85,5 Milliarden Bytes waren frei. Der installierte
Entscheidungsprüfer bestätigte anschließend wieder `short` mit dem echten
v0.92.47-Nachweis. Eine erneute vollständige Assurance wurde nicht ausgelöst.

17 Abschlussdateien liegen dauerhaft unter
`/var/lib/grabenplaner-assurance/maintenance-evidence/release-v09249-4db8731-20260914`
und hashgeprüft lokal unter `tmp/v09249-evidence/vps`.
Archiv-SHA256: `b4eb27b081a63488d5e6152b59f8adbc75b696ed0f71d3d5272ffc288af30926`.
Nur eigene temporäre Release-/Uploadverzeichnisse und saubere Build-Worktrees
wurden entfernt. Das Kamerascannen auf einem tatsächlichen Mobilgerät bleibt
ein gesonderter, noch nicht ausgeführter Gerätetest.
