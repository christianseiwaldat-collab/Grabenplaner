# GP697: Einmaliger vollständiger isolierter Wiederherstellungstest

## Auftrag und Status

Der Nutzer hat am 20.09.2026 ausdrücklich den einmaligen vollständigen Test nach kurzen Diagnoseprüfungen freigegeben. Kein Deploy und keine automatische Wiederholung bei Fehler. Der serverseitige Lauf wurde um **05:14:36 Europe/Vienna** gestartet und ist um **05:16:00** bereits vor dem nativen Datenbank-Restore gescheitert. Ursache war ein Fehler im neu angelegten Diagnoseaufbau, nicht ein nachgewiesener Fehler des produktiven GP. Es wurde kein zweiter vollständiger Lauf gestartet.

Getesteter Kandidat: `b508a2a3093f618bf799a541336b5988cb17d7a6`, Version 0.92.62-beta, einschließlich Startdiagnose `acf4bb4`, Korrektur des Verbindungserwerbs `355bca2` und isoliertem Timeout-Beobachter. Der produktive GP bleibt unverändert auf 0.92.61-beta. Es wurden keine Datenbank-Zeitlimits erhöht.

## Kurze Vorprüfung

77 gezielte Tests unter Ubuntu bestanden, 0 Fehler und 0 übersprungene Tests, rund 30,6 Sekunden. Darunter die bisherigen Provider-/Worker-/Recoverytests und neue Diagnosetests:

- SQL-Statement-Zeitlimit, Treiber-Abfrage-Zeitlimit, Verbindungslimit und allgemeine Abfrageunterbrechung werden getrennt klassifiziert.
- Der tatsächliche Provider-Verbindungstimer wurde kurz und gezielt ausgelöst; seine Codeposition wurde vor der Fehlernormalisierung erfasst.
- Ursprüngliche Fehlerobjekte, Promise-/Callback-Verhalten und unveränderliche PersistenceError-Objekte bleiben erhalten.
- SQL-Inhalt, Parameter, Kennwörter und beliebige Fehlermeldungen werden nicht protokolliert. Für eine fehlgeschlagene SQL-Anweisung wird nur ihr SHA-256 gespeichert; Stackprojektionen enthalten ausschließlich relative Quellpositionen.

Der Beobachter wird ausschließlich im isolierten Kandidaten über Node-Preload geladen und von dessen Threads übernommen. Er schreibt eine private kleine JSONL-Datei; Fehler der Beobachtung verändern den Testausgang nicht.

## Server-Preflight und Umfang

Frisch bestätigt: Live/Ready HTTP 200, rund 72,7 GB frei, keine konkurrierenden geplanten Wartungs-/Backupdienste und nächste reguläre Wartungen erst am 21.09. um 03:00 Uhr. Die bestehende Wartungssperre wird während des Tests exklusiv gehalten. Ein beobachteter ClamAV-Unterprozess gehörte zum laufenden produktiven GP und wurde nicht beendet.

Quelle ist die unveränderte Sicherung der fehlgeschlagenen Nachtprüfung:

- Paar: `9af09935-5ef9-44ea-9435-0e76f74d28de.pair`.
- Manifest SHA-256: `c746146445ac8f5daeb402410ea927fa670bd68a04a7044563c00c4bdadc930b`.
- Core-Dump: 90.719.502 Bytes; Sales-Dump: 3.916.196.709 Bytes.

Das Original wird vor dem Kopieren vollständig über den vorhandenen Bundle-Verifizierer geprüft. Der Test verwendet anschließend eine eigene vollständige Kopie beider Datenbanken, privates Netzwerk, eigene PostgreSQL-Instanz, die bestehenden Ressourcenlimits und denselben nativen Restore-/App-Prüfpfad. Der vollständige App-Test umfasst auch HTTP, Anmeldung, Importprüfung und PDF-/Berichtsprüfung. Dies ist kein bloßer Schema- oder Startup-Test.

Der Supervisor beobachtet CPU-/I/O-Fortschritt und verwendet die bestehende Stillstandsüberwachung; es gibt keinen willkürlichen Abbruch nach 50 Minuten. Bei Fehler sichert er die kleinen Belege und beendet den Worker kontrolliert. Erst nach bestätigtem Stillstand entfernt er die eigene Datenbank- und Kandidatenkopie. Bei unbestätigtem Stillstand bleibt sie zur sicheren Klärung erhalten. Originalbackups, produktive Daten und Wartungspläne werden nicht geändert.

## Laufkennung und Belege

Lauf-ID: `e1e23db1-6d25-43fe-8f99-6abb7197fc28`.

- Supervisor: `grabenplaner-gp697-supervisor-e1e23db1-6d25-43fe-8f99-6abb7197fc28.service`.
- Worker: `grabenplaner-pg-recovery-e1e23db1-6d25-43fe-8f99-6abb7197fc28.service`.
- Wegwerfbarer Testbaum: `/var/lib/grabenplaner-offsite/postgresql-recovery/e1e23db1-6d25-43fe-8f99-6abb7197fc28`.
- Dauerhafte private Serverbelege: `/var/lib/grabenplaner-assurance/maintenance-evidence/gp697-full-recovery/e1e23db1-6d25-43fe-8f99-6abb7197fc28`.
- Lokale Belege: `output/deploy/gp697-full-recovery` im übergeordneten Aufgabenverzeichnis.

Wichtige Ergebnisdateien sind `completion.json`, `result.json` oder `failure.json`, `timeout-observer.jsonl`, `startup-failure.json`, `http-progress.jsonl`, `worker.log`, `postflight.json`. Vor dem eigentlichen Workerstart ist nur der äußere Supervisor aktiv, während die Sicherung geprüft und kopiert wird. `Result=success` eines noch laufenden systemd-Dienstes ist kein abgeschlossenes Testergebnis.

Die Automation `gp-fr-here-deploy-fehlerdiagnose-fortsetzen` wurde zunächst auf die ausschließliche Überwachung dieses Laufs umgestellt und nach Bekanntwerden des Fehlers wieder pausiert. Es gibt keinen automatischen neuen Restore. Das lokale Startskript verweigert zusätzlich eine Wiederholung, solange der Nachweis dieses ersten Starts vorhanden ist.

## Konkreter Aufbaufehler und begrenzte Korrektur

Der Preload schrieb sein erstes `observer-ready`-Ereignis nach `work/timeout-observer.jsonl`, bevor `restorePair` aufgerufen wurde. `restorePair` verlangt ausdrücklich einen vorhandenen, dem Testkonto gehörenden und **vollständig leeren** Arbeitsbereich. Die zusätzliche Logdatei verletzte diese Bedingung und führte sofort zu `PG_PAIR_RESTORE_NEW_WORKSPACE`. Das bloße vorherige Anlegen des leeren Verzeichnisses war korrekt; die Diagnose-Datei darin war der Fehler.

Die 77 vorangegangenen Tests deckten die Fehlerklassifizierung und Fehlerweitergabe ab, aber nicht diesen Zusammenhang zwischen Preload und leerem Restore-Verzeichnis. Der Worker lief deshalb nur etwa zwei Sekunden; der innere Supervisor einschließlich Beweissicherung und Bereinigung rund vier Sekunden. Der äußere Lauf einschließlich Sicherungsprüfung und Kopie dauerte rund 1 Minute 28 Sekunden. Ein PostgreSQL-Cluster wurde nicht initialisiert, ein nativer Restore und der App-Test wurden nicht erreicht.

Korrigiert wurde der Diagnoseaufbau lokal: Das Log liegt künftig neben `work/`, außerhalb des geschützten leeren Arbeitsbereichs. Der Preload ist nun als `test-support/recovery-timeout-preload.js` im Repository erfasst; Start- und Beweissicherungsskript verwenden denselben korrigierten Pfad. Ein zusätzlicher kurzer Regressionstest führt den Preload aus und prüft, dass auch seine allererste Ausgabe den Restore-Arbeitsbereich unangetastet lässt. Die zwölf gezielten Diagnosetests einschließlich dieser Regression bestanden unter Ubuntu in rund 0,6 Sekunden. Das ist keine Wiederholung des vollständigen Restores und kein Nachweis des ursprünglichen GP-Startfehlers.

Die Belege wurden lokal gesichert. Der Supervisor bestätigte `stopped: true`, `cleaned: true`; das Testverzeichnis existiert nicht mehr. Produktives Release-Manifest und Prozesskennung blieben unverändert, Live und Ready lieferten jeweils HTTP 200 / `ok: true`. Rund 72,75 GB waren nach der Bereinigung frei. Die Wartungssperre wurde freigegeben. Es erfolgte kein Deploy.

## Grenze eines positiven Ergebnisses

Ein bestandener Test belegt den genannten Kandidaten auf der genannten Sicherung. Er aktualisiert nicht automatisch den signierten nächtlichen Assurance-Status der weiterhin installierten alten Anwendung und ist keine automatische Deployfreigabe. Vor einem späteren Deploy bleiben Kandidatenbindung, Freigabeprüfungen und frischer Betriebs-Preflight erforderlich. Ein Fehler wird ausgewertet, ohne automatisch einen neuen Volltest zu starten.
