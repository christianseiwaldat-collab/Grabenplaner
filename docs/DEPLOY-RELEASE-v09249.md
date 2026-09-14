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

Der produktive Abschluss wird nach Veröffentlichung ergänzt.
