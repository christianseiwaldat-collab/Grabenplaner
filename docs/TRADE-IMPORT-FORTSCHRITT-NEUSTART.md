# Trade-Import: Fortschritt und kontrollierter VPS-Neustart

## Verarbeitungsbudget

Die PostgreSQL-Prüfung hat ein Zeitbudget von 750 Millisekunden pro Schritt.
Das umfasst auch das Lesen, Entschlüsseln und Vorbereiten der Zeilen. Ein festes
Paket von 200 breiten Artikeln konnte dieses Budget schon vor der ersten Prüfung
überschreiten. Dann wurde nur eine Zeile bestätigt und der übrige Inhalt beim
nächsten Schritt erneut vorbereitet.

Die Prüfung und Übernahme beginnen deshalb mit höchstens 16 Zeilen. Die
Paketgröße passt sich pro Quellprofil und Aktion an der gemessenen Schrittzeit an.
Sie wächst vorsichtig, lässt Zeit für weitere GP-Anfragen und bleibt innerhalb
der bisherigen Obergrenzen. Rückmeldungen werden erst nach erfolgreichem
Transaktionsabschluss berücksichtigt. Nach einem Prozessneustart gilt wieder
die kleine Anfangsgröße. Quellprüfung, Rechte, Revisionen, Referenzprüfungen und
die Speicherung der Zwischenstände bleiben vollständig erhalten.

Das betrifft alle Quellen, die dieselbe PostgreSQL-Importprüfung verwenden.
Die gemeinsame Freigabe des kompakten Kassenstands bleibt eine atomare Aktion.

## Fortschrittsanzeige

Die Anzeige unterscheidet Einlesen, Prüfung, Übernahme, Rücknahme, Artikelkatalog
und Ermittlung des Datenstands. Zusätzlich zum Gesamtfortschritt werden die
bereits geprüften Zeilen der aktuellen Tabelle angezeigt. Damit wird laufende
Prüfarbeit sichtbar, bevor sie den Gesamtzähler der Übernahme verändert.

Start, Phasenwechsel und Abschluss werden mit dem geschützten Importzustand
gespeichert. Das erfordert keine Datenbankmigration. Vorhandene Importe ohne
gespeicherten Zeitbeleg zeigen für abgeschlossene Phasen einen Strich. Bei einer
laufenden alten Phase beginnt die neue Zeitmessung am ersten neuen Prüfschritt;
der Start eines vorhandenen Hintergrundauftrags bleibt für den Gesamtvorgang
verfügbar.

Die Restzeit beruht auf mindestens drei Fortschrittsmessungen über mindestens
acht Sekunden. Phasenwechsel, Pause, rückläufige Zähler und veraltete Messungen
verwerfen die Schätzung. Bei der atomaren Kassenfreigabe bleibt der Fortschritt
bis zur bestätigten Freigabe unbestimmt. Fremde Phasenzeiten werden nicht als
Übernahmedauer verwendet.

## Vorbereitung eines Neustarts

Die Vorbereitung führt keinen Neustart, Deploy oder Wartungsauftrag aus.
Vor der tatsächlichen Ausführung müssen die folgenden Prüfungen erneut aktuell
sein; ein früheres grünes Ergebnis reserviert kein Wartungsfenster.

1. Installierten Stand, Dienste, vier interne/öffentliche Live- und Ready-Proben,
   freien Speicher, Wartungssperre und laufende Wartungsaufträge prüfen.
2. Nachtaufgaben und deren nächste Startzeiten berücksichtigen. Ein kontrollierter
   Neustart darf nicht mit Sicherung, Wiederherstellungsprüfung oder Host-Wartung
   konkurrieren. Timerzustände nur im normalen Wartungsablauf behandeln.
3. Aktive Importaufträge einschließlich Ablaufzeit und gespeichertem Zwischenstand
   erfassen. Beim geregelten Anhalten wartet der GP auf den aktuellen Schritt,
   bevor er die Datenbankverbindung schließt. Keine erzwungene Prozessbeendigung.
4. Den bestehenden PostgreSQL-Lifecycle für `vps-reboot` verwenden. Er hält den GP
   geregelt an, erstellt und prüft eine frische gekoppelte Sicherung und gibt erst
   danach die privilegierte Neustartanforderung frei. Ein Sicherungsfehler sperrt
   den Neustart und stellt den GP wieder bereit. Eine bloße Manifest-/Größenprüfung
   der letzten Sicherung ersetzt diesen frischen Sicherungspunkt nicht.
5. Dienste anderer Anwendungen auf demselben VPS berücksichtigen. Ihre eigenen
   Daten sind kein Bestandteil des GP-Sicherungspaars. Erreichbarkeit und
   Autostart der benötigten Dienste sowie die bestehende SSH-/Tailscale-Verbindung
   prüfen; keine Zugangs- oder Firewalländerung für den Neustart vornehmen.
6. Nach dem Neustart neue Bootkennung, Dienstzustände, Live/Ready und die
   automatische Wiederaufnahme am gespeicherten Importstand prüfen. Der Zähler
   muss wieder steigen; keine doppelten Zeilen und keine abgelaufenen Aufträge.

Fehlerbelege werden erhalten und eingeordnet. Ein früher fehlgeschlagener
Wiederherstellungstest ist kein aktueller Ausfall, wenn ein späterer vollständig
bestätigter Gesamtlauf und die signierte Prüfhistorie erfolgreich sind. Ohne
solchen Folgebefund bleibt die Wiederherstellungsbereitschaft offen.

## Prüfumfang

Die gezielten Tests umfassen begrenzte Paketgrößen, Rollback, Rechteentzug,
Wiederaufnahme, geschützte Zwischenstände, Zeitmessung und Restzeitschätzung.
Für eine Veröffentlichung kommen die normalen Linux-/PostgreSQL- und
Paketprüfungen des konkreten Kandidaten hinzu. Lokale Tests und reine VPS-
Vorprüfungen bestätigen noch keine Installation der Änderungen auf dem Server.
