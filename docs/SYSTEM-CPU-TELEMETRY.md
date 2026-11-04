# CPU-Messung im gehärteten Linux-Dienst

Die CPU-Anzeige berechnet die Auslastung des gesamten Servers aus zwei echten
Kernel-Zählerständen. `ProcSubset=pid` blendet `/proc/stat` im Namensraum des
GP-Dienstes aus. `os.cpus()` liest unter Linux dieselbe Schnittstelle und bietet
daher keinen verlässlichen Ersatz. RAM kann über andere Betriebssystemschnittstellen
weiterhin verfügbar sein.

## Eng begrenzte Freigabe

Die Vorlage `server-tools/linux/grabenplaner-host-cpu-stat.conf.in` ist für einen
zusätzlichen systemd-Drop-in bestimmt:

`/etc/systemd/system/grabenplaner.service.d/50-host-cpu-stat.conf`

Sie bindet ausschließlich die laufend aktualisierte Host-Datei `/proc/stat`
schreibgeschützt und nicht rekursiv nach `/run/grabenplaner-host-cpu-stat` im
Dienst ein. Es wird keine Kopie mit eingefrorenen Werten verwendet. Die Anwendung
liest den festen Alias nur, wenn `/proc/stat` fehlt oder der Zugriff verweigert
wird. Andere Lesefehler und ungültige Zähler bleiben sichtbar als fehlende
Messung. Ein fehlender Alias führt ebenfalls zu „Nicht verfügbar“, nie zu einer
erfundenen Auslastung von null Prozent.

`ProcSubset=pid`, `ProtectProc=invisible`, die Benutzer-/Gruppenzuordnung,
Capabilities und alle übrigen Schutzvorgaben bleiben unverändert. Der Alias liegt
direkt unter dem vom Anwendungsbenutzer nicht beschreibbaren `/run`. Für den
Zählerzugriff ist kein privilegierter Hilfsprozess erforderlich.

## Betriebsvertrag und Freigabe

Die bestehende Core6-Hauptunit und ihre Quellhashes werden durch diese Vorbereitung
nicht geändert. Die Vorlage wird nicht automatisch installiert. Der zusätzliche
Drop-in muss bei einer freigegebenen Auslieferung gesondert als Betriebsartefakt
mit Quellhash, Zielhash, Besitzer `root:root` und Modus `0644` erfasst werden.
Nach `systemd-analyze verify`, `daemon-reload` und kontrolliertem Dienstneustart
muss der tatsächliche Dienstnamensraum geprüft werden. Die Konfigurationsänderung
gehört zum freigegebenen Auslieferungsumfang; lokale Anwendungstests ersetzen
den Betriebsnachweis nicht.

Die Wirksamkeitsprüfung umfasst mindestens:

- Der Alias liefert im Dienst zwei ansteigende echte CPU-Zählerstände; die
  CPU-Anzeige wird nach dem nächsten Messintervall numerisch und der Verlauf
  erhält neue CPU-Punkte. Vorhandene Lücken bleiben erhalten.
- `/proc/stat` bleibt im Dienst verborgen, andere globale Proc-Dateien werden
  nicht freigegeben. Die beiden bestehenden Proc-Schutzvorgaben bleiben gesetzt.
- Der Dienstbenutzer kann den gebundenen Alias weder ändern noch ersetzen.
- Ohne Alias und bei fehlerhaften, rückläufigen oder unveränderten Zählern
  bleibt die CPU unbekannt. RAM und vorhandene Verlaufspunkte bleiben erhalten.
- Rücknahme des zusätzlichen Drop-ins stellt die bisherige Betriebsdefinition
  wieder her; sie benötigt ebenfalls einen kontrollierten Neustart.

Die systemd-Semantik ist dokumentiert unter
[systemd.exec: ProcSubset und BindReadOnlyPaths](https://www.freedesktop.org/software/systemd/man/systemd.exec.html).
