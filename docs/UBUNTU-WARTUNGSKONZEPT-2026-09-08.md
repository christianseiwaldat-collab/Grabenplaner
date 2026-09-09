# Ubuntu-Host: Diagnose und kontrollierte Wartung

Diagnose: 08.09.2026; lokale Umsetzung abgeschlossen am 09.09.2026.
**Korrekturen lokal implementiert; keine ausgeführte VPS-Wartung.**
Die Bestandsaufnahme am VPS war ausschließlich lesend. Die anschließende
Umsetzung und Prüfung erfolgten lokal mit synthetischen Daten. Kein VPS-Neustart,
Dienststopp am VPS, Deployment, Firewall-/SSH-Eingriff, Status-Reset oder Löschen
von Sicherungen wurde ausgelöst. Ein Wartungsfenster wurde nicht festgelegt.

## Lokal umgesetzt

- Die Metadatenprüfung der Neustartsteuerung verwendet bei ausgelassenem
  Argument den vorgesehenen Socket. Das korrigiert sowohl die Verfügbarkeits-
  als auch die erneute Prüfung vor dem Neustartauftrag. Besitzer, Gruppe,
  Dateityp, Verzeichnis- und Socketrechte bleiben streng geprüft. Die reine
  Verfügbarkeitsprüfung öffnet keine Verbindung zum Broker.
- Ein veralteter oder zeitlich unplausibler Audit sperrt bereits die App-Aktion
  und den API-Auftrag vor Beginn einer Sicherung. Die Frist wird anhand der
  ungerundeten Zeit geprüft. Die unabhängigen Prüfungen im Root-Broker bleiben
  erhalten, ebenso Rollenprüfung, Passwortbestätigung und Sicherungspflicht.
- Wartungsneustart, Sicherheitsabweichungen, fehlgeschlagene Dienste,
  unvollständiger Audit und offene Sicherheitsbestätigung haben getrennte
  Meldungen. Nur ausstehender Neustart: gelber Hinweis „Wartung nötig“.
  Ein zusätzlicher Sicherheitsfehler bleibt separat rot sichtbar.
- Die Portprüfung unterscheidet sicheren Listener, unzulässige Bindung,
  fehlenden Listener und nicht durchführbare Abfrage. Ausschließlich ein
  fehlender Listener wird für höchstens 30 Sekunden erneut gesucht. Eine
  unzulässige Bindung wird sofort als Fehler gemeldet. Bleibt der Listener
  aus, lautet das Ergebnis „nicht bestätigt“, niemals erfolgreich.
- Nicht lesbare Firewall-/Listenerabfragen bleiben Auditfehler. Fehlgeschlagene
  Dienstabfragen werden als unbestätigt gekennzeichnet; tatsächlich gespeicherte
  Dienstfehler werden weiterhin gemeldet und nicht bereinigt.

Das geschützte Dateischema bleibt Version 1 mit den bereits erlaubten Werten
`true`, `false` und `null`. Die App leitet daraus zusätzlich `unknownChecks` ab;
Adressen, Pfade, Benutzer und Diagnosefreitext bleiben aus dem Status ausgeschlossen.
Meldungskennungen enthalten keine wechselnden Abrufzeitpunkte. Es wird kein neuer
Benachrichtigungsversand eingeführt. „Letzte Prüfung“ bleibt der Zeitbezug des
Audits; eine dauerhafte Historie mit Beginn des Neustartbedarfs, Paketbezug und
erfolgreichen Folgeläufen ist noch nicht implementiert.

## Aktuell nachgewiesen

Die erste Bestandsaufnahme erfolgte am 08.09.2026 um 19:20 UTC, ergänzt durch
gezielte lesende Prüfungen derselben Sitzung.

| Befund | Nachweis und Bedeutung |
| --- | --- |
| Sicherheitsneustart offen | Ubuntu 26.04 LTS läuft mit `7.0.0-30-generic`. `linux-image-7.0.0-31-generic`, Version `7.0.0-31.31`, ist installiert. `/run/reboot-required` besteht seit 06.09.2026, 06:14 CEST; genannt werden `linux-base` und der neue Kernel. |
| Letzter Host-Boot | 22.08.2026, 02:32 CEST. App-Updates haben den Host seitdem nicht neu gestartet. |
| Sicherheitsupdates aktiv | Tägliche Paket-/Sicherheitsaktualisierungen sind konfiguriert; `Unattended-Upgrade::Automatic-Reboot` ist `false`. |
| Gespeicherter Host-Audit | 08.09.2026, 00:11 CEST; `state: error`, `rebootRequired: true`, keine offene Sicherheitstransaktion. |
| Zusätzliche Auditbefunde | `publicPorts: false`, `failedUnits: false`; die acht anderen Einzelprüfungen sind erfolgreich. Die rote Gesamtanzeige ist daher nicht allein der Neustartbedarf. |
| App und Webserver | Grabenplaner und Caddy sind aktiv. Port 3000 ist aktuell ausschließlich an `127.0.0.1` gebunden. Dies ist eine lokale Listenerprüfung, kein externer Netzwerkscan. |
| Geschützter Neustartsocket | Der Socketdienst ist aktiv und aktiviert; der Socket hat `root:grabenplaner-host-control`, Modus `0660`, sein Verzeichnis `root:root`, Modus `0755`. Die laufende App hat die benötigte Gruppe. |

## Warum die Neustartsteuerung ausgegraut ist

Im produktiv untersuchten Stand bestand ein konkret nachgewiesener Fehler in der Verfügbarkeitsprüfung:
`server.js`, Funktion `currentHostManagedRebootAvailable()`, ruft
`assertSafeHostRebootSocket()` **ohne Pfadargument** auf.
Die Funktion `assertSafeSocket()` in `lib/host-reboot-control-client.js`
hat dafür keinen Standardwert und prüft dadurch das Arbeitsverzeichnis
anstelle von `/run/grabenplaner-host-control/request.sock`.
Das liefert `HOST_REBOOT_CONTROL_SOCKET_UNSAFE` und anschließend „Steuerung
nicht verfügbar“.

Lesend im Mount-Namensraum und unter dem Benutzer der laufenden App geprüft:

- Mit dem vorhandenen Boot-Credential der App ist die Bootgeneration verfügbar.
- Die Socketprüfung ohne Pfad scheitert mit dem genannten Fehlercode.
- Dieselbe Socketprüfung mit dem ausdrücklich angegebenen vorgesehenen Pfad
  besteht. Es wurde keine Verbindung zum Steuerungssocket geöffnet und keine
  Neustartanforderung übertragen.

**Lokal korrigiert:** `assertSafeSocket(socketPath = DEFAULT_SOCKET_PATH, ...)`
verwendet den Standard nur für ein ausgelassenes Argument. Explizit leere und
ungültige Pfade werden weiterhin abgelehnt. Es wurden keine Gruppen, Socketrechte
oder systemd-Schutzmaßnahmen gelockert. Die Regression führt die tatsächliche
Verfügbarkeitsfunktion mit simulierten sicheren und unsicheren Linux-Metadaten
aus. Fehlende Bootgeneration und ungeprüfter Audit sperren die App-Aktion;
laufende Wartung, unvollständige Sicherungen und offene Sicherheitstransaktionen
werden zusätzlich durch die bestehenden Brokerprüfungen abgesichert.

## Warum die Ubuntu-Meldung häufig erscheint

Der gegenwärtige Neustarthinweis ist berechtigt: Ein installiertes Kernelupdate
ist noch nicht durch einen Host-Boot aktiviert. Das Neustarten nur des
Grabenplaner-Dienstes behebt diesen Zustand nicht. Künftige Sicherheitsupdates
können erneut einen Neustart erfordern. Automatische Updates sollen aktiv
bleiben; erforderlich ist ein verlässlicher Abschluss durch geplante Wartung.
[Ubuntu: automatische Updates](https://ubuntu.com/server/docs/how-to/software/automatic-updates/)

Die produktiv untersuchte Anzeige vermischte unterschiedliche Ursachen:

1. **Neustartbedarf:** als Wartungsbedarf mit Beginn und betroffenem Update
   anzeigen. Einen unveränderten Zustand nicht als immer neuen Fehler melden.
2. **Portprüfung:** Der installierte Audit verlangt einen vorhandenen Listener
   auf Port 3000. Fehlt dieser etwa während Start oder Wartung, lautet die
   Fehlermeldung trotzdem „Firewall oder Listener verletzen die Trennung“.
   Das systemd-Journal zeigt einen App-Start am 08.09. um 00:10:47 CEST, kurz vor
   dem Audit um 00:11:01. Das passt zu einer Prüfung während des Starts; der
   genaue fehlende Listener zum Auditzeitpunkt wurde nicht nachträglich bewiesen.
   Bei der Bestandsaufnahme war der Listener ausschließlich lokal gebunden.
   Die lokale Korrektur unterscheidet nun
   „App startet/lauscht noch nicht“, „Prüfung nicht möglich“ und „App lauscht
   auf unzulässiger Adresse“. Nur die letzte Situation belegt
   mit dieser Prüfung eine fehlerhafte Bindung.
3. **Dienstfehler:** Es bestehen 23 systemd-Fehlerzustände, überwiegend ältere
   Assurance-Steuerungsinstanzen. Dazu gehören der nächtliche Prepare-Timeout,
   eine fehlgeschlagene nächtliche Assurance und
   `systemd-networkd-wait-online.service`. Die zuletzt protokollierten Läufe
   von Prepare und nächtlicher Assurance scheiterten am 08.09. um 03:11 bzw.
   04:32 CEST. Ein später erfolgreicher Release-Nachweis beseitigt diese
   separaten Fehlerzustände nicht automatisch.

**Dauerhafte Behandlung:** Zuerst die jeweiligen Ursachen bearbeiten und einen
erfolgreichen Folgeablauf belegen. Historische Fehler mit Zeitpunkt und
nachfolgendem Erfolg nachvollziehbar darstellen; aktuelle Probleme sichtbar
halten. Keine pauschale `reset-failed`-Bereinigung oder Unterdrückung des
Host-Audits. Nach Updates und einem Host-Boot sollte ein neuer Audit erst bei
geklärtem Dienstzustand stattfinden. Unveränderte Warnungen brauchen einen
stabilen Eintrag mit Zeitbezug; echte neue Fehler oder überfällige Wartung
bleiben handlungsrelevant.

## Ablauf eines später ausdrücklich beauftragten Host-Neustarts

1. **Wartungsfenster vorbereiten:** erwartete Unterbrechung aller auf dem VPS
   betriebenen Anwendungen berücksichtigen. Aktuell konfigurierte Dienste,
   Speicherplatz, Bootzustand, bestehende SSH-Route und laufende Sicherungs-,
   Import-, Update- und Berichtsvorgänge lesend feststellen. Keine Änderungen
   an Zugangswegen als Nebenwirkung der Wartung.
2. **Neue Arbeit anhalten:** keine neuen Datenimporte oder Berichtsjobs starten.
   Laufende Arbeit kontrolliert abschließen oder mit belastbarem Zustand
   pausieren. Ein bloßes Abschießen von Sicherungsworkern ist ungeeignet.
3. **Rückfallstand sichern:** frische konsistente Sicherung nach dem vorgesehenen
   Sicherungsvertrag erstellen und verifizieren. Vorhandene lokale/offsite
   Sperren und Wartungstransaktionen müssen erklärt und abgeschlossen sein.
   Keinen Neustart bei ungeklärter Wiederherstellbarkeit freigeben.
4. **Kontrolliert neu starten:** erst nach erfolgreicher Vorbereitung einmalig
   den geschützten Host-Neustart auslösen. Die App-Sicherung und der geschützte
   Neustart-Broker müssen denselben Wartungsvorgang nachweisen. Ein
   Verbindungsabbruch gilt nicht als Beweis eines erfolgreichen Neustarts.
5. **Rückkehr nachweisen:** neue Bootgeneration und tatsächlich laufenden
   Zielkernel prüfen, SSH-Erreichbarkeit, App-/Webdienste, Gesundheitsendpunkte,
   Datenbankkonsistenz, benötigte Socketdienste und Timer kontrollieren.
   Fehlende Neustartmarkierung und frischen Host-Audit bestätigen. Alle
   mitbetroffenen Anwendungen berücksichtigen, nicht nur Grabenplaner.
6. **Arbeit wieder freigeben:** unterbrochene Aufträge erkennen und gezielt
   fortsetzen; unvollständige Dateien nicht als fertige Berichte anzeigen.
   Sicherungen und notwendige Wiederherstellungsnachweise abschließen.
   Bei ausbleibender Rückkehr keine Neustartschleife starten, sondern den
   vorbereiteten Wiederherstellungsweg verwenden.

Die lokal vorbereitete Backupoptimierung kann unnötige Wiederholungen und
ungünstige Dienststopps reduzieren. Ihr tatsächlicher Gewinn ist noch nicht
am produktiven Gesamtablauf gemessen. Für den ersten Übergang arbeiten zunächst
noch ältere installierte Werkzeuge; eine feste kurze Ausfallzeit lässt sich
darum derzeit nicht seriös zusagen.

Ein regelmäßig vorgesehenes Wartungsfenster mit vorangehender Sicherung und
anschließender Prüfung ist sinnvoller als ein unkoordiniert aktivierter
automatischer Reboot. Eine spätere Automatisierung benötigt dieselben
Voraussetzungen und darf bei aktiven Importen, Berichten oder Backups keinen
Neustart erzwingen. Mit diesem Konzept wurde kein Zeitplan eingerichtet.

Canonical Livepatch kann als Ergänzung geprüft werden, wenn Kernel und
Ubuntu-Pro-Konfiguration geeignet sind. Es ersetzt nicht alle Kernelupdates
und Neustarts und behebt weder den Socketfehler noch die Dienstfehler.
[Ubuntu: wann weiterhin ein Neustart nötig ist](https://ubuntu.com/security/livepatch/docs/client/explanation/troubleshooting/do-i-need-to-reboot/)

## Veröffentlichung und getrennte Modulwartung

Die App-Korrektur und die Host-Audit-Korrektur werden getrennt übernommen:

| Bestandteil | Vorgehen bei späterer Freigabe |
| --- | --- |
| App, Statusanzeige und Socketprüfung | Normaler geprüfter App-Release. Die bestehende Statusdatei und das unveränderte Brokerprotokoll bleiben lesbar. Ein App-Release startet den Ubuntu-Host nicht neu. |
| Geschütztes Hardening-Modul | Explizite Modulwartung gemäß `SERVERBETRIEB.md`, Abschnitt „Ubuntu-Host absichern“. Das App-Update ersetzt das installierte Modul absichtlich nicht. |
| Vollständiger Host-Neustart | Eigenes Wartungsfenster nach den oben beschriebenen Vorprüfungen und einem verifizierten Rückfallstand. |

Der neue Hardening-Vertragsfingerprint lautet
`dc42a15ed03fe6f10eae2fbc38754fb9c44d14377a1a6989ee27527564140a50`;
zuvor war er `e917ee0355874ce08f8ab096335ea6b533d151a4e9ab2bc4755d4f940682f91d`.
Der Unterschied stammt aus dem Audit-Skript. Modulversion und Statusschema
bleiben 1; Dateiliste, Controller, Installer, Richtlinien und systemd-Vorlagen
wurden hier nicht verändert. Der Fingerprint ist im Pakettest ausdrücklich
gebunden. Kernlaufzeit- und Offsite-Verträge ändern sich durch diese Korrektur nicht.

Der gegenwärtige Hardening-Installer erlaubt keinen Austausch gegen einen
abweichenden Vertrag. Der dokumentierte Wechsel setzt einen geklärten
Transaktionszustand voraus und kann Rücknahme und erneute Bestätigung von
Host-Richtlinien aus zwei SSH-Sitzungen erfordern. Das betrifft Zugangs- und
Firewallregeln und ist deshalb ein eigener, vorzubereitender Wartungsschritt.
Weder Moduldateien noch Vertragsbelege oder aktive Transaktionen dürfen für
einen schnellen Austausch überschrieben werden. Dieser Wechsel wurde nicht
implementiert, freigegeben oder ausgeführt.

Vor dem späteren Start gilt insbesondere:

| Befund | Folge |
| --- | --- |
| Audit fehlt, ist älter als 36 Stunden oder hat einen unplausiblen Zeitstempel | Frischen geschützten Audit erzeugen und prüfen; App-Aktion und API bleiben bis dahin gesperrt. „Diagnose aktualisieren“ liest den gespeicherten Audit, führt selbst keinen Root-Audit aus. |
| Offene Sicherheitstransaktion | Erst regulär bestätigen oder kontrolliert zurücknehmen. |
| Laufender Updater, nicht abgeschlossene Sicherung oder ungeklärter Import | Vorgang abschließen beziehungsweise den Wartungsablauf mit belastbarer Wiederaufnahme vorbereiten. Keine Sperren löschen oder Prozesse abschießen. |
| Unvollständiger oder nicht verifizierter Sicherungspunkt | Keinen Neustart beauftragen; Sicherungsursache beheben. |
| Gespeicherte Dienstfehler | Einzelne Units und Zeitpunkte mit den tatsächlichen Folgeläufen abgleichen. Prepare-Timeout, nächtliche Assurance und Netzwerk-Wartefehler benötigen weiterhin einen Ursachen- und Erfolgsnachweis. |
| Rückkehr ohne neue Bootgeneration oder mit fehlenden Diensten | Wartung nicht als erfolgreich melden und keinen automatischen zweiten Neustart auslösen. |

Für künftige Berichtsjobs bleiben eine dauerhafte Wartungssperre für neue
Aufträge, kontrolliertes Pausieren und Wiederaufnahme nach einem Host-Boot
Teil des separaten Berichtsqueue-Konzepts. Die gegenwärtige Suchmaske startet
noch keine solchen Jobs. Auch eine gemeinsame automatische Stilllegung aller
VPS-Anwendungen ist mit dieser lokalen Korrektur nicht eingeführt worden.

## Verifikation der lokalen Korrektur

- 99 unterschiedliche gezielte Tests bestanden; fünf optionale Tests wurden
  auf dem Windows-Testhost übersprungen. Linux-Metadaten und Broker-Sperren
  wurden mit isolierten Testdaten geprüft, ohne einen Neustart auszulösen.
- Das echte Bash-Prüfverfahren wurde zusätzlich mit Git Bash in zwölf
  ungefährlichen Szenarien ausgeführt: sichere IPv4-/IPv6-Listener, verzögerter
  Start, dauerhaft fehlender Listener, IPv4-/IPv6-/gemischte unzulässige Bindung,
  Abfragefehler, fehlerhaftes Ausgabeformat, Firewallabweichung und Dienstfehler.
  `bash -n` für das vollständige Audit-Skript sowie JavaScript-Syntaxprüfungen
  für App und Server bestanden.
- Der zunächst fehlgeschlagene Pakettest war die absichtliche Bindung an den
  bisherigen Audit-Fingerprint. Nach Prüfung des einzigen Modulunterschieds
  und Aktualisierung der Bindung bestanden alle zwölf Pakettests. Die
  Installation eines geänderten Moduls wurde dabei nicht ausgeführt.
- Browserprüfung mit eigener synthetischer Datenbank: gemischte Befunde,
  ausschließlich ausstehender Wartungsneustart sowie unbestätigte Portprüfung
  korrekt getrennt; helle und dunkle Darstellung ohne horizontalen Überlauf.
  Ein zwei Tage alter Audit erzeugte den Aktualisierungshinweis und sperrte
  die Neustartaktion. Keine Warnungen oder Fehler in der Browserkonsole.
- Nachweise: `tmp/ubuntu-maintenance-tests-2026-09-08.tap`,
  `tmp/ubuntu-maintenance-contract-tests-2026-09-08.tap`,
  `tmp/ubuntu-maintenance-final-tests-2026-09-08.tap` und
  `tmp/ubuntu-maintenance-progress-2026-09-08.md`.

Diese Prüfungen bestätigen die lokalen Korrekturen und den Paketvertrag.
Ein produktiver Modulwechsel, die Behebung der vorhandenen Dienstfehler und
ein erfolgreicher vollständiger Host-Neustart sind damit nicht nachgewiesen.
