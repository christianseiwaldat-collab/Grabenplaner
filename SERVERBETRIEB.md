# Serverbetrieb und Recovery-Vertrag

## Betriebsvoraussetzungen

Der zentrale Serverbetrieb verwendet eine verwaltete Ubuntu-Instanz mit genau einem aktiven App-Prozess.
Unterstützt sind Ubuntu 24.04 LTS und Ubuntu 26.04 LTS x86-64; Node.js und pnpm richten sich nach `package.json`.
Caddy stellt HTTPS bereit. Die Anwendung bindet ausschließlich an Loopback; Bootstrap und Datenbankports bleiben privat.
Die Administration prüft DNS, TLS, Firewall, Dienstkonten, Sicherheitsupdates, ClamAV, Backupziel und Wiederanlauf.
Programm, Daten, Schlüssel, Protokolle und Sicherungen besitzen getrennte Verzeichnisse und restriktive Rechte.
Die Anwendung hat keine allgemeinen sudo-/Shell-Rechte; Caddy erhält keinen Zugriff auf Geschäftsdaten oder Schlüssel.
Aktive Datenbanken liegen auf einem lokalen Dateisystem, niemals auf Netzlaufwerken, Cloudmounts oder synchronisierten Ordnern.
Geheimnisse stammen aus der geschützten Dienstumgebung und gehören weder in Git noch in Programm- oder Releasepakete.

SQLite bleibt der Installationsstandard. Ausdrücklich migrierte PostgreSQL-Installationen verwenden
`grabenplaner_core` und `grabenplaner_sales` als gebundenes Datenbankpaar.
Die Migration benötigt freigegebenes Paket, passende Betriebsverträge, Wartungssperre, vollständige Datenprüfung und den ersten gemeinsamen Sicherungspunkt.
Eine alleinige Änderung von `DB_PROVIDER` aktiviert keine Migration. Geschäftszugänge und administrative Recovery-Zugänge bleiben getrennt.
Nach Veröffentlichung des PostgreSQL-Bestands gibt es keinen automatischen Rückfall auf SQLite.

## Installation und Pakete

Vor Paketbau und Upload ist ein gesonderter, rein lesender VPS-Preflight Pflicht. Er prüft `/tmp` als echtes Verzeichnis ohne Symlink,
mit Eigentümer `root:root` und exakt `1777` einschließlich Sticky-Bit sowie wirksamen Schreib- und Suchrechten (`-w`/`-x`) für App-/Buildkonto und das installierte Offsite-Dienstkonto.
Fehlt das Dienstkonto eines installierten Offsite-Moduls, scheitert die Prüfung. Nach VPS-Tests ist der Preflight erneut vollständig grün erforderlich.
Solange das installierte Wartungswerkzeug diesen Check noch nicht enthält, wird derselbe Check aus dem geprüften aktuellen Quellstand
separat und rein lesend am VPS ausgeführt, bevor der installierte Preflight startet.
Es erfolgt kein automatisches `chmod` oder `chown`. Als root ausgeführte VPS-Tests verwenden ausschließlich ein eigenes privates `TMPDIR`;
Rechte gemeinsamer Elternverzeichnisse werden niemals verändert.

`server-tools/package/New-GrabenplanerLinuxServerPackage.ps1` akzeptiert nur einen sauberen Git-Checkout und freigegebene Laufzeitdateien.
Das deterministische Linux-Quellpaket enthält Manifest, Quellcommit und SHA-256-Prüfsummen sowie weder produktive Daten noch Geheimnisse.
ZIP und veröffentlichte Prüfsumme werden vor Entpacken und Installation verglichen. Produktionsabhängigkeiten werden auf dem Zielsystem installiert:

```bash
pnpm install --prod --frozen-lockfile --config.node-linker=hoisted
```

Die Ersteinrichtung beginnt mit einem einmaligen root-geschützten Bootstrap-Token und privat gebundenem Listener.
Vor Abschluss müssen eigener Admin-Zugang, erster gekoppelter Sicherungspunkt, interne Ready-Prüfung und öffentliche HTTPS-Ready-Prüfung erfolgreich sein.
Der Token wird erst danach atomar verbraucht; bei Fehlern bleibt der Bootstrapzugang privat. Vorhandene fremde Proxykonfigurationen werden nicht still ersetzt.

## Prüfung, Updates und Neustarts

- `/api/health/live` prüft die Prozessantwort; `/api/health/ready` prüft zusätzlich Produktionskonfiguration, Integrität, Instanzschutz, Daten-/Backupziel und Virenscanner.
- Ein grüner Live-Check ersetzt keine Ready-Prüfung. Nach Einrichtung, Update und Wiederherstellung sind interne und öffentliche Prüfungen erforderlich.
- `grabenplaner-test`, `grabenplaner-monitor` und `grabenplaner-offsite-test` prüfen die eingerichteten Betriebsverträge; Browserdiagnosen zeigen nur redigierte Statuswerte.
- Ein veralteter Monitorstatus wird zuerst lesend über Dienste, Journal, Wartungssperre und aktuelle Endpunkte untersucht.
- Nur drei aufeinanderfolgende interne Live-Fehler dürfen den begrenzten Monitor-Neustart auslösen; zwischen Versuchen liegen mindestens 30 Minuten.
- Ready-, HTTPS-, Speicher-, Backup-, Offsite- und Virenscannerfehler lösen Wartungsalarme aus und keinen automatischen Neustart.

Updates verwenden ein lokal vorliegendes geprüftes Paket, ein angekündigtes Wartungsfenster und die gemeinsame Wartungssperre.
Vor dem Austausch entsteht ein verifizierter gekoppelter Sicherungspunkt. Staging, Paketmanifest und Betriebsmodul-Kompatibilität werden geprüft.
Dienst und Schreiber werden kontrolliert gestoppt; nach dem atomaren App-Tausch müssen Start sowie Live-/Ready-Prüfungen bestehen.
Der Bereitschaftstest hat eine eigene Obergrenze von 1500 Sekunden. Bei Fehlern erfolgt eine kontrollierte Rücknahme auf den vorherigen Programmstand mit erneuter Prüfung.
Ein Versions-/Vertragskonflikt wird nicht umgangen. Gleich-/Altversionen benötigen eine ausdrücklich dokumentierte Ausnahme.
Produktive Daten, Schlüssel und Sicherungen sind kein austauschbarer Teil des App-Pakets.
Ein ausdrücklich bestätigter Neustart erstellt vorher einen verifizierten Sicherungspunkt.
Update, Neustart und Hostneustart sind getrennte administrativ freizugebende Vorgänge.

Kompatible kurze Updates binden die vollständige Folgeprüfung an den Nachtablauf; der vollständige Ablauf prüft sie direkt.
Eine Deploypause bleibt wirksam. Bewusst deaktivierte Timer bleiben deaktiviert; unveränderte Timer werden nicht neu gestartet.

### VPS-Deploy: Zeitplanung und geordneter Abschluss

Der lesende Preflight muss vor Paketbau auch den voraussichtlichen Prüfpfad, laufende oder unmittelbar bevorstehende Wartungen
und das daraus abgeleitete Zeitbudget feststellen. Die Vorabschätzung verwendet den nachgewiesenen Produktivstand und den freigegebenen Quellstand;
die verbindliche Entscheidung trifft weiterhin `--verification auto` anhand der geprüften Paket- und Betriebsverträge.
Eine grüne Bereitschaftsprüfung bestätigt die Durchführbarkeit, noch keine bestimmte Gesamtdauer.
Prüfpfad, Begründung, mögliche Wartezeit und erwartete Gesamtdauer werden vor Beginn der teuren Arbeiten mitgeteilt.

Vollständige Betriebs-Selbsttests starten erst nach erfolgreichem Abschluss der erforderlichen Assurance und Freigabe ihrer Sperren.
Während eines laufenden Restore dienen lesende Live-/Ready-, Status- und Fortschrittsabfragen zur Beobachtung.
Einzelne bestandene Phasen ersetzen weder das signierte erfolgreiche Gesamtergebnis noch das reguläre Dienstende.
Erst danach folgen `grabenplaner-test` und `grabenplaner-offsite-test` nacheinander und eine gebündelte Abschlussprüfung.
Ein belegter vorübergehender Sperrfehler wird nach Freigabe einmal erneut geprüft; der erste Fehlerbeleg bleibt erhalten.

Ausgelieferter App-Stand, abgeschlossene Recovery-Prüfung und Release-Abschluss werden getrennt berichtet.
Belegte historische Lock-Timeouts werden einzeln qualifiziert und nur unter ihren exakten Unitnamen bereinigt;
ein pauschales `reset-failed` oder ein Neustart gesunder Dienste ist kein Abschlussverfahren.
Das ausführliche Quellstand-Prozedere mit den Erkenntnissen vom 08.10.2026 steht in
[Deploy-Zeiten und Nachtprüfungen](docs/DEPLOY-ZEITEN-UND-NACHTPRUEFUNGEN.md).

## Sicherungen und Wiederherstellung

Sicherungen koppeln Datenbanken, verschlüsselte Dokumente, erforderliche Schlüssel und Betriebskonfiguration über Identität, Manifest und Hashes.
Der kontrollierte Sicherungsablauf beendet Schreiber unter Wartungssperre und prüft Integrität vor Veröffentlichung.
Ein einzelner Datenbankdownload ersetzt kein vollständiges Recovery-Set.
PostgreSQL-Paare werden gemeinsam gesichert und wiederhergestellt; Einzelrücksicherung und generischer SQLite-Recovery-Apply sind ausgeschlossen.
Das Live-System darf niemals mit einer Testkopie oder Testdatenbank aktiviert werden.

Vor großen Backup-Lese-, Kopier- oder Restore-Arbeiten ist der kurze Diagnose-/Recovery-Regressionstest erforderlich.
`restorePair` verwendet einen privaten, dem Restore-Dienst gehörenden und vollständig leeren `workRoot`.
Vorab erzeugte Dateien und Preload-Protokolle bleiben außerhalb dieses Arbeitsordners.
Wiederherstellungen prüfen exakt gebundenen Snapshot, Installation, Repository, Hashes, Datenbankintegrität, Dokumentmanifest und Recovery-Schlüssel.
Produktive Rücksicherung ist ein beaufsichtigter administrativer Vorgang bei vollständig gestoppten Schreibern.
Vor Austausch werden Sicherheitskopien erstellt; ein Fehler führt zur kontrollierten Rücknahme und Prüfung.
Weder Recovery-Geheimnisse noch unredigierte Protokolle werden veröffentlicht.

Offsite-Daten werden verschlüsselt übertragen; Repository-Bindung, gepinnte Werkzeuge und eingeschränkte Zugänge sind Pflicht.
`--initialize-repository` gilt ausschließlich für ein neues freigegebenes leeres Ziel, niemals für Wiederanbindung oder Fehlerbehebung.
Authentifizierungs-, Netzwerk- und Passwortfehler werden nicht durch Neuinitialisierung übergangen.
Die Aufbewahrung beträgt 14 tägliche, 8 wöchentliche und 12 monatliche Stände. Fehlgeschlagener Upload löst keine Aufräumaktion aus.
Gemeinsame Wartungs- und Repository-Sperren verhindern Parallelbetrieb. Es gibt keine automatische Entsperrung oder Reparatur.
Vor manuellem `unlock`, `forget`, `prune` oder Restore muss jeder konkurrierende Vorgang ausgeschlossen sein.
Repositorywechsel behalten den bisherigen Bestand als Rückfallpunkt bis zum geprüften neuen Nachweis.
Deinstallation entfernt keine produktiven Daten, Recovery-Geheimnisse oder entfernten Repositorys.

## Recovery Assurance und System-Center

Vollprüfungen erzeugen eine Ed25519-signierte, SHA-256-verkettete Historie mit root-geschütztem Signaturschlüssel.
Die Anwendung prüft die gesamte Kette und liest ausschließlich redigierte Diagnosen.
Ein erfolgreicher Volltest gilt höchstens 100 Tage als aktueller Nachweis; danach ist der relevante Status unbekannt.
Der isolierte Restore-/App-Smoke-Test verwendet eine eigene Datenkopie, unprivilegierte Rechte und ausschließlich Loopback ohne externen Netzwerkzugang.
Produktive Daten, Schlüssel und öffentliche Ports bleiben unzugänglich. Teilfehler dürfen keinen erfolgreichen Gesamtstatus erzeugen.
Der Nachtablauf führt keine produktive Wiederherstellung durch; Zeitgrenzen und Aufräumen gelten auch bei Fehlern.
Manuelle Webstarts benötigen das gesonderte Recovery-Recht und einen root-isolierten Broker mit festen Aktionen, Schema, Sperren und Sperrfrist.
Browserwerte bestimmen keine Befehle, Pfade oder Unitnamen.

Wartungszeiten werden anhand tatsächlicher systemd-Werte und Serverzeitzone angezeigt.
Änderungen benötigen Rechte, aktuelle Revision und Wartungssperre; laufende Arbeiten werden nicht beendet.
Ungeänderte Zeilen sowie Verzögerung, Zeitgenauigkeit und Persistenz bleiben erhalten; Speichern löst keine sofortige Nachholung aus.
Nicht vollständig darstellbare Zeitpläne bleiben unverändert und nicht bearbeitbar.
Eine fachliche Freigabe benötigt bestandene technische Gates und getrennte Abnahmen für Version und Prüfstand.
Ein neuer Nachweis macht alte Abnahmen unaktuell. Der technische Status ist keine Verfügbarkeits-, Rechts- oder Sicherheitsgarantie.

## Host-Sicherheitsmodul

Installation und App-Update verändern SSH oder Firewall nicht ohne einen getrennten freigegebenen Vorgang.
Ein App-Update ersetzt ein bereits separat installiertes Sicherheitsmodul absichtlich nicht.
Bei einem Vertragsfingerprint-Wechsel ist die Modulwartung ausdrücklich auszuführen; aktive oder ausstehende Transaktionen dürfen nicht übernommen werden:

```bash
grabenplaner-host-security rollback --transaction <Kennung>
grabenplaner-host-security-uninstall
bash server-tools/linux/hardening/install-grabenplaner-host-hardening.sh
grabenplaner-host-security audit
```

Vor der Neuinstallation wird das Fehlen aktiver/ausstehender Transaktionen geprüft.
Transaktionsdateien duerfen nicht manuell geloescht oder zwischen Modulständen kopiert werden.
Erst danach folgen neuer Plan und Anwendung; Bestätigung erfolgt aus einer neuen zweiten geprüften SSH-Sitzung.
SSH-/Sudo-/Firewallprüfungen und der automatische Rücknahmeschutz bleiben verpflichtend.

## Access-DB-Import im Betrieb

Laufende Importe werden bei geplanter Wartung nach dem aktuellen Datenbankpaket mit gespeichertem Fortschritt beendet.
Neue Importe werden während der Wartung zurückgewiesen. Dieselbe Datei kann anhand von Fingerabdruck, Profil und Tabellenplan fortgesetzt werden.
Die temporäre Dateikopie dient nur der lokalen Wiederaufnahme und gehört nicht zum Geschäftsdatenbackup; nach Datenträgerverlust wird die Originaldatei benötigt.
Höchstens sechs temporäre Aufträge, 512 MiB je Quelldatei, 1,5 GiB Gesamtdateiablage und mindestens 1 GiB freie Reserve begrenzen den Bedarf.
Die Stillstandsgrenze beträgt zwei Minuten, die Gesamtlaufzeitgrenze je Leseversuch sechs Stunden.
Vorübergehende Lese-/Datenbankfehler erhalten höchstens drei Wiederholungen nach 30 Sekunden, zwei Minuten und zehn Minuten.
Schema-, Integritäts- und Berechtigungsfehler werden nicht automatisch wiederholt.

## Zielaufbau unter Windows und Legacy

Die vorhandenen Windows-Serverwerkzeuge verwenden WinSW, Caddy, getrennte Dienstidentitäten und dieselben Betriebs-/Sicherungsgrenzen.
`Test-GrabenplanerServer.ps1`, `Backup-Grabenplaner.ps1`, `Restore-Grabenplaner.ps1` und `Update-GrabenplanerServer.ps1` bleiben administrativ kontrollierte Einstiege.
Backup und Restore benötigen gestoppten Dienst, gekoppelten Datenbank-/Dokumentbestand, Hash-/Integritätsprüfung und erforderliche Recovery-Schlüssel.
Ein Update prüft ZIP/SHA-256 und Staging, sichert vorher und rollt bei fehlgeschlagenen Live-/Ready-Prüfungen kontrolliert zurück.
Portable/LAN ist eingefrorenes Legacy. Es gibt genau eine aktive Instanz; Hochverfügbarkeit und horizontale Skalierung sind kein Betriebsvertrag.
