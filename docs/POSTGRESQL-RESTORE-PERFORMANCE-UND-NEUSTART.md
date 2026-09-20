# PostgreSQL: Restore-Laufzeit und vorbereiteter Host-Neustart

## Isolierter Restore

`operations/restore-performance.js` enthält drei feste Profile:

| Profil | Restore-Jobs | maintenance_work_mem | Parallele Indexarbeiter je Befehl |
| --- | ---: | ---: | ---: |
| baseline | 1 | 32 MiB | 2 |
| memory | 1 | 256 MiB | 2 |
| parallel | 2 | 256 MiB | 0 |

Shared Buffers bleiben bei 64 MiB, work_mem bei 4 MiB. Das Profil betrifft
ausschließlich den neuen isolierten Prüfcluster. Kein produktiver PostgreSQL-Wert
wird geändert. Der Worker benötigt den geprüften Rahmen von zwei CPUs und 3 GiB;
zusätzliche parallele Indexarbeiter werden beim Zwei-Job-Profil ausgeschlossen.

Mehrere pg_restore-Jobs sind mit `--single-transaction` unvereinbar. Im parallelen
Profil bleibt `--exit-on-error` aktiv. Teilweise restaurierte Daten existieren bei
einem Fehler ausschließlich im wegwerfbaren privaten Cluster. Es gibt keinen
Erfolgsnachweis und keinen App-Smoke nach fehlgeschlagenem Restore. Der Cluster
wird im finally-Pfad gestoppt; der Supervisor muss danach die gebundene
Arbeitsumgebung bereinigen. Schema, exakte Zeilenzahlen, Sequenzen, Rollen,
geschützte Inhalte und vollständiger App-Nachweis bleiben vorgeschrieben.

Der opt-in Probe `test-support/postgresql-recovery-performance-probe.js` vergleicht
die Profile anhand desselben künstlichen Custom-Dumps und prüft zusätzlich die
echte Fehlerbehandlung von `restorePair` mit einem beschädigten Archiv. Er verlangt
Linux, einen unprivilegierten Benutzer, ein leeres privates Verzeichnis und eine
isolierte Netzwerkumgebung. Er ist kein produktiver Vollnachweis. Ergebnisse eines
kleinen synthetischen Vergleichs dürfen nicht als garantierte Minutenersparnis
der vollständigen Sicherung bzw. Nacht-Assurance ausgegeben werden.

Vor einem vollständigen Kandidaten-Restore: eigenständige Machbarkeitsprüfung,
freie Wartungssperre, aktive/bevorstehende Jobs, Kapazität, Pfadverträge, native
Ubuntu-Diagnose `npm run test:recovery-diagnostics`. Diagnoseausgaben bleiben
außerhalb des vollkommen leeren `workRoot`. Kein paralleler zweiter Restore.

Referenzen: [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html),
[Ressourcenparameter](https://www.postgresql.org/docs/18/runtime-config-resource.html).

## Sicherungszeiten

Das Ergebnis der gekoppelten Sicherung enthält zusätzlich `phaseTimings`:
Dateivorabprüfung, Datenbankidentität, Checkpoint je Datenbank, exakte
Tabellenzählungen, Schema-Fingerprint, Dump, Dump-Katalog, Dateikopie, Rollen-Dump
und Hash-/Manifestabschluss. `operationMilliseconds` umfasst auch die Vorbereitung.
Die bestehenden `timings` und das signierte Checkpoint-/Bundleformat bleiben
kompatibel. Die Zeitwerte enthalten keine SQL-Texte, Zugangsdaten oder Geschäftsdaten.

Übergeordnete Phasen (z. B. `checkpoint-core`, `dump-and-catalog-sales`,
`recovery-files`) enthalten ihre Unterphasen. Diese Zeiten nicht zusammenaddieren.
Für die Gesamtdauer `operationMilliseconds` verwenden. Messungen erfordern keine
zusätzlichen Tabellenabfragen oder Dateihashes. Telemetriefehler dürfen Ergebnisse
und ursprüngliche Betriebsfehler nicht ersetzen.

## Host-Neustart vorbereiten, nicht ausführen

1. Rebootmarker, Kernelimage und initramfs prüfen; PostgreSQL, GP, Caddy,
   Tailscale und SSH-Socket müssen für den Boot eingerichtet sein. Erreichbaren
   Wartungszugang und gegebenenfalls Anbieter-Konsole vor dem Ausfall bestätigen.
2. Der Statusleser akzeptiert root-eigene, nicht gruppen-/weltbeschreibbare
   Host-Sicherheitsdateien mit lesender Monitorgruppe. Root-Eigentum, Dateityp,
   Linkzahl, sichere Öffnung, Statusschema und Aktualität bleiben Pflicht.
3. Der Broker kann mit `--ensure-state-directory` ausschließlich das feste
   Zustandsverzeichnis sicher/idempotent vorbereiten. Vorhandene Cooldown- und
   Anforderungsdaten bleiben unverändert; unsichere vorhandene Pfade werden
   abgewiesen. Dabei wird kein Reboot angefordert.
4. Die PostgreSQL-Control-Unit erstellt denselben privaten StateDirectory beim
   regulären Start. Ihr pauschales 25-Minuten-Gesamtlimit entfällt. Native
   Fehlerbehandlung, Wartungssperre und OnFailure-Wiederanlauf bleiben aktiv.
5. **Auslieferungsvoraussetzung:** Änderungen am Host-Control-Broker und an der
   PostgreSQL-Control-Unit benötigen die explizite Modulwartung der installierten
   Verträge. Der reguläre App-Updater lehnt abweichende PostgreSQL-Unit-Hashes
   absichtlich ab. Vor einem Paketbau zuerst den konkreten Modulübergang samt
   Rückweg vorbereiten; nicht direkt einen normalen App-Deploy versuchen und
   keine Vertragsdatei lediglich auf einen Wunsch-Hash umschreiben.
6. Vor einer später ausdrücklich freigegebenen Ausführung den **installierten**
   nativen PostgreSQL-Reboot-Vorabcheck erneut prüfen. Ein grüner Kandidatencheck
   ersetzt ihn nicht. Frische Wartungskoordination einschließlich 03:00-Timern,
   freie Sperre, keine aktiven Sicherungen/Restores und ausreichender Platz sind
   zusätzlich erforderlich. Timerzustände erhalten; überfällige persistente
   Timer dürfen beim Boot keine unkoordinierte Wartung auslösen.
7. Erst dann im regulären PostgreSQL-Lifecycle einen frischen gekoppelten,
   vollständig geprüften Rückkehrpunkt erstellen und Reboot anfordern. Fehler
   vor der Reboot-Anforderung müssen GP wieder starten. Nach dem Boot neue
   Boot-ID/Kernel, Dienste, HTTPS und tatsächliche angemeldete Oberfläche prüfen.

Eine reine Vorbereitungsfreigabe erlaubt keinen Reboot und keinen vorgezogenen
App-Stopp. Bei der Vorbereitung weder alte Fehlerhistorie umetikettieren noch
Neustart-Cooldowns löschen.


## Modulübergang GP710 (20.09.2026)

Die ausdrücklich freigegebene Modulwartung wurde ohne App-Stopp und ohne Reboot
abgeschlossen. `server-tools/linux/postgresql/maintain-reboot-control.py` bildet
den engen Übergang ab: alte/neue SHA256 fest gebunden, eigene Wartungssperre,
keine aktiven Wartungsoperationen, Originaldateien mit Metadaten sichern,
Steuerungssockets vorübergehend schließen, beide Brokerkopien sowie die
PostgreSQL-Control-Unit samt Vorlage ersetzen. Erst nach Übereinstimmung der
installierten Bytes wird die Quittung aktualisiert. Vertragsprüfung für den
installierten Stand und den Kandidaten, nativer Vorabcheck, unveränderte
Boot-ID/App-PID und Readiness sind Abschlussbedingungen. Bei Fehlern werden
Originaldateien und ihre Rechte wiederhergestellt; die Sockets werden erneut
aktiviert. Der Übergang ist nicht zum wiederholten Ausführen vorgesehen.

Installationsbeleg auf dem VPS:
`/var/lib/grabenplaner-postgresql/module-maintenance/2d1b108f-07f1-443b-8f6f-40f6dc2aec67/result.json`.
Hier liegen auch die geschützten Originaldateien. `installed.json` enthält die
Modulwartungs-ID; die App-Version bleibt 0.92.62-beta. Dies ist keine Auslieferung
der übrigen lokalen App-Änderungen oder der Restore-Leistungsprofile.

17:23 Europe/Vienna: installierter nativer Vorabcheck und alle fünf
PostgreSQL-Unit-Verträge grün, RuntimeMaxUSec=infinity, StateDirectory 0700,
Steuerungssockets aktiv. GRUB-Syntax, initramfs für 7.0.0-31 und dpkg --audit
bestanden. GP, PostgreSQL, Caddy, Tailscale und SSH aktiv/bootfähig; 72,66 GB frei.
Signierte Historie verifiziert, GP705 `full-assurance-passed` bestätigt.

Die Boot-Freigabe bleibt separat: vor dem tatsächlichen Reboot erneut Sperren,
Jobs, Timer einschließlich möglicher Nachholtermine und Zugänge prüfen. Der
reguläre Lifecycle erstellt dann einen neuen konsistenten Rückkehrpunkt. Die
Anbieter-Konsole wurde in GP710 nicht erneut angemeldet oder als Rückweg getestet.
Kein pauschales Versprechen einer ausfallsicheren Wiederkehr aus reinen
Vorabprüfungen ableiten.
