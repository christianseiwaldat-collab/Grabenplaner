# Release v0.92.59 Beta

## Anlass und Änderung

Der vollständige Wiederherstellungstest von v0.92.58 erreichte auf dem VPS
die äußere 30-Minuten-Grenze. PostgreSQL prüfte nach dem Indexaufbau noch
Fremdschlüssel; der Prozess wurde durch systemd beendet. Die produktive App
blieb verfügbar, die Wiederherstellung lief ausschließlich in einer Testkopie.

`pg_restore` erhält maximal 45 Minuten. Der übergeordnete Worker leitet sein
Gesamtlimit aus derselben Konstante ab und reserviert zusätzlich 15 Minuten
für die andere Datenbank und den vollständigen Anwendungsfunktionstest.
Damit bleibt der gesamte Worker auf eine Stunde begrenzt. Andere native
Werkzeuge behalten ihre 15-Minuten-Grenze. CPU-Quote, Speichergrenze,
Prozessgruppenbeendigung, private Netzwerkumgebung und Pfadsperren bleiben
unverändert. Keine Integritäts- oder Anwendungsprüfung wird ausgelassen.

Uhr-gesteuerte Tests prüfen erfolgreichen Abschluss nach 44 Minuten, Abbruch
bei 45 Minuten, das Verwerfen verspäteter Erfolgsmeldungen und Timerbereinigung.
Der Worker-Vertrag prüft ausdrücklich die zusätzliche Reserve gegenüber dem
inneren Werkzeug sowie die unveränderte Abschottung.

## Status

Die lokale Recovery-Prüfung umfasst 22 Tests: 21 bestanden, kein Fehler,
eine unveränderte Live-Umgebungsauslassung. Alle zehn gezielten Versions-
und Budgetprüfungen bestehen. Der erste CI-Kandidat `5f45382` wird wegen
eines zusätzlich aufgedeckten zeitabhängigen Scheduler-Tests nicht
veröffentlicht. Die Testuhr ist korrigiert; alle 16 Tests dieser Datei bestehen
mit Node 22.22.1 und Node 24.19.0. Der endgültige Runtime-Commit
`de63e729b8e2692801029fec423f866c352d5a1b` besteht alle vier
[CI-Jobs](https://github.com/christianseiwaldat-collab/Grabenplaner/actions/runs/35300292490):
Linux 3627/3705 bestanden bei 78 Auslassungen, Windows 3605/3705 bestanden
bei 100 Auslassungen, beide ohne Fehler; Mindest-Node 50/50 und
PostgreSQL-Vertrag 125/125 bestanden. Die umgebungsabhängigen Auslassungen
bleiben unverändert. VPS-Abschlussnachweise werden erst nach tatsächlichem
Erfolg ergänzt. Die ursprünglichen
[26 CI-Fehler](CI-FEHLERKORREKTUR-2026-09-18.md) sind bereits korrigiert.

## Paket und laufender VPS-Nachweis

- Paket: `Grabenplaner-Server-v0.92.59-beta-linux-x64.zip`, 746 Manifestdateien.
- Runtime-Commit: `de63e729b8e2692801029fec423f866c352d5a1b`.
- Paket-SHA-256: `f8de53dba9754f81b016750c1b102e1ef8b34b847fc262dbe7d2e1f205b2348c`.
- Manifest-SHA-256: `b0f490395df10f2cf064c379a2b74d395d8c072752cf38889ee2aecf67bcf84f`.
- Transaktionaler Updateauftrag: `grabenplaner-release-v09259-de63e72.service`,
  Invocation `ff799c30f3324e94aa44beab2993c180`, Start 18.09.2026 03:09 UTC.

Der Virenscan bestand nach 808 Sekunden. Die erste gekoppelte Sicherung
benötigte 687 Sekunden; deren externe Übertragung samt Repository-Prüfung
und Bestätigung dauerte einschließlich Vorbereitung 483 Sekunden.
Während der externen Übertragung lief die bisherige App wieder.
Unmittelbar vor dem App-Tausch wurde ein aktueller lokaler Rückkehrpunkt
erstellt (693 Sekunden). Der App-Tausch benötigte zehn Sekunden, der Start
bis zur bestätigten Bereitschaft 103 Sekunden.

Am 18.09.2026 um 03:59 UTC wurden die öffentliche Versionsanzeige, neun
ausgelieferte Assets, integrierte Einkaufsansicht mit Weiterleitung des alten
Links, MHTML-Eingabe und Bestellnummernsuche erfolgreich gegen das Paket
geprüft. Die Serverprüfung bestätigte öffentliche Bereitschaft, HTTPS,
PostgreSQL-Paar und Sicherungsbeleg. Seit 04:00 UTC läuft der erneute isolierte
Restore-Test unter Invocation `f54808c28649497184e692bf537ccfcf`.
Der vollständige Release-Abschluss ist bis zu dessen Erfolg und der
anschließenden Gesamtprüfung noch offen.

## Unterbrechung durch das automatische Betriebssystem-Update

Am 18.09.2026 um 04:31 UTC startete `unattended-upgrades` nach dem Update von
SQLite-Systempaketen über `needrestart` mehrere Dienste neu, darunter den GP,
den laufenden Offsite-Restore und dessen isolierten Worker. Der konkrete
`systemctl restart`-Aufruf steht im Paketmanager-Protokoll; das Systemjournal
bestätigt die entsprechenden Neustarts. Es erfolgte kein VPS-Neustart.

Der Worker `a4646e1f-9769-462e-b733-617b182732cb` wurde nach 22 Minuten und
18 Sekunden unterbrochen. Sein automatischer Neustart in derselben bereits
befüllten Testumgebung wurde mit `PG_PAIR_RESTORE_NEW_WORKSPACE` abgewiesen.
Dieser Lauf ist deshalb ausdrücklich kein erfolgreicher Restore-Nachweis.
Der ebenfalls neu gestartete übergeordnete Restore-Auftrag verwendet eine
frische isolierte Umgebung. Seine Invocation ist
`16fe28d8a20b415f9648824b9338fb38`.

Die ursprünglichen Fehler- und Neustartbelege bleiben erhalten. Auch der
vom Betriebssystem neu gestartete Lebensatlas-Dienst wird beim späteren
PID-Abgleich gesondert anhand dieser Belege berücksichtigt; ein unveränderter
Prozess wird dafür nicht behauptet. Die produktiven PostgreSQL-Dienste und
der Caddy-Prozess wurden durch diesen Paketmanager-Aufruf nicht neu gestartet.

Ein begrenzter Test mit einem eigenen kurzlebigen Dienst bestätigte, dass
ein Runtime-Drop-in und `daemon-reload` ein laufendes Startlimit verlängern,
ohne den Dienst neu zu starten. Nur der bereits laufende Release-Auftrag
erhielt daraufhin drei statt zwei Stunden Gesamtspielraum. Invocation,
Startzeit und PID blieben identisch. Die Restore-Grenzen von 45 Minuten
für `pg_restore` und einer Stunde für den isolierten Worker bleiben gleich.
Die temporäre Ausnahme wird nach dem Release entfernt. Vor der abschließenden
Gesamtprüfung muss der automatische Paketmanager-Lauf beendet sein.

## Ergebnis des erneuten Restore-Tests

Der zweite Worker `cbedbc1a-2b81-4cb6-a6e4-8125b8d671fe` stellte beide
Datenbanken wieder her und bestätigte die Daten- und Schutzprüfungen.
Der anschließende vollständige Anwendungsstart scheiterte am 18.09.2026
um 05:21 UTC mit `PERSISTENCE_CONNECTION_UNAVAILABLE`. Das Laden von
`server.js` dauerte im auf einen CPU-Kern begrenzten Worker rund 84 Sekunden;
eine bereits gestartete Verbindung verbrauchte dabei ihre fünf Sekunden Frist.
Dieser Lauf gilt als fehlgeschlagen, nicht als Restore-Nachweis.

Der transaktionale Updater führte den automatischen Rollback aus. Um 05:23:44
UTC bestätigte er die Erreichbarkeit der vorherigen Version; der Release-Auftrag
endete um 05:24 UTC mit Exit 1. Um 05:27 UTC waren v0.92.58 Beta und öffentliche
Bereitschaft erneut bestätigt. Der separate Fix wird in v0.92.60 geprüft.
