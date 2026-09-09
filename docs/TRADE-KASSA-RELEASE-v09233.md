# VPS-Veröffentlichung v0.92.33-beta

Datum: 9. September 2026. Status: **Veröffentlichung vollständig abgeschlossen**. v0.92.33-beta ist öffentlich bereit; automatische Recovery Assurance mit tatsächlichem App-Test, Betriebsprüfungen und abschließender Datenvergleich sind bestanden.

## Umfang und Korrektur

Die Veröffentlichung enthält die sechs Optimierungsblöcke für Trade und Kassa sowie die bereits vorbereiteten Rechte-, Einstellungs- und Navigationsänderungen aus [v0.92.32](TRADE-KASSA-RELEASE-v09232.md). Dazu gehören vorbereitete Artikelsuchwerte, indexgestützte Standardlisten, Bestandsnachweise für Kassenabfragen, verschlüsselte Belegzusammenfassungen und persönliche Berichtsaufträge im Hintergrund. SQLite bleibt die aktive Datenbank.

Der vollständige Wiederherstellungstest von v0.92.32 wies den nicht vergleichbaren Versionsplatzhalter `local` beim neuen Migrationsmarker `developer-permission-defaults-v1` ab. v0.92.33 repariert ausschließlich diesen bekannten Platzhalter zu `0.92.32-beta`. Der ursprüngliche Migrationszeitpunkt und individuelle Rechte bleiben erhalten; die einmalige Rechtebereinigung wird nicht erneut ausgeführt. Der Recovery-Leser akzeptiert denselben historischen Eintrag ausschließlich bei unveränderlichen Sicherungen mit Quellversion `0.92.32-beta`. Andere unbekannte oder zu neue Versionsangaben werden weiterhin abgewiesen.

Die neue Sicherungskoordination wurde beim regulären Update auf dem VPS bereits bestätigt: Während der Updater seine eigenen gekoppelten Rückfallpunkte verantwortet, unterbleiben die redundanten App-Startsicherungen. Der zweite kontrollierte Dienststopp endete innerhalb weniger Sekunden. Die eigenen exakten Sicherungspunkte, externe Bestätigung und vollständige Recovery Assurance bleiben Teil des Ablaufs.

## Lokale Prüfung und Paket

- Die fokussierte Prüfung der Korrektur einschließlich Rechteerhalt, ursprünglichem Migrationszeitpunkt, historischen Sicherungen, abgewiesenen ungültigen Versionen, Recovery-Vertrag und Release-Bereitschaft besteht mit **41 Tests**, ohne Fehler oder übersprungene Tests.
- Die vorherige Feature-Prüfung hat nach gezielten Fixture-Korrekturen **309 ausführbare Tests bestanden**; sechs Prüfungen wurden plattformbedingt übersprungen. Der erste kombinierte Lauf enthielt drei inzwischen behobene Fixture-Fehler. Die separaten Prüfungen der Optimierungsblöcke bestanden zuvor mit 136 Tests.
- Der Persistenzaudit bestätigt **1.348 Statements**: 1.233 portable Zugriffe und 115 freigegebene Überschreibungen, keine unbekannten Zugriffe und keine Phasengrenzverletzungen. Syntaxprüfung der beiden geänderten Laufzeitmodule und `git diff --check` sind bestanden.
- Quellcommit: `ed9fe81cc057ea433b3804aedf97097990013c05`, auf `feature/schedule-pdf-day-separators` committed und gepusht.
- Paket: `Grabenplaner-Server-v0.92.33-beta-linux-x64.zip`, **3.675.016 Bytes**.
- SHA-256: `3dfffbbaed7e9fb802cfd8faa7e99b5a3eac213edde65ef33fd5029c11eb140e`.
- Alle **534 Manifestdateien** wurden unabhängig nach Pfad, Größe, Hash und Quellinhalt geprüft. Gegenüber dem verifizierten v0.92.32-Paket unterscheiden sich vier Laufzeitdateien: `README.md`, `package.json`, die Rechte-Initialisierung und der Recovery-Versionsvergleich.

## Vorprüfung

Die lesende Vorprüfung endete um **09:29:46 UTC** erfolgreich. Sie bestätigte alle 534 installierten Dateien der Vorgängerversion, neun öffentlich ausgelieferte Assets, vier interne und öffentliche HTTP-200-Antworten, den Listener auf `127.0.0.1:3000`, die Ablehnung anonymer Zugriffe auf neue geschützte Routen sowie SQLite-Integrität ohne Fremdschlüsselfehler. Alle bisherigen fachlichen Bestände und Freigaben blieben unverändert.

Die sechs neuen Tabellen, Kassenbestandsnachweise und ihre 25 Änderungstrigger waren konsistent. Die Artikelsuchprojektion enthielt vollständig **19.024 Artikel**, ohne ausstehende Aktualisierungen. Die Standardabfrage nutzte den vorgesehenen Index ohne temporäre Sortierung. Eine einzelne lesende SQL-Messung für 50 Ergebniszeilen und die exakte Gesamtzahl dauerte **2,326 ms**. Dies ist eine Datenbankmessung im vorhandenen Cachezustand, keine Messung der vollständigen Seitenladezeit und kein Vorher-Nachher-Vergleich.

Der zuvor fehlgeschlagene Wiederherstellungstest war vor dem Update ausdrücklich noch offen. Es gab keinen manuellen Reset von Fehlerstatus oder produktiven Datenbankmetadaten. Die Archive waren vor dem Update ohne offene Transaktion oder Sperre; der Offsite-Arbeitsbereich war leer. Auf dem VPS waren 53.949.259.776 Bytes frei.

## Veröffentlichungsnachweis

Der reguläre Updater startete um **09:32:01 UTC**, nach Abschluss des bereits laufenden Monitors. Der Monitor-Timer ist für den Updateabschnitt mit Wiederaktivierung im EXIT-Trap pausiert. Die Virenprüfung endete um 09:38:01 UTC erfolgreich.

Der erste exakte Sicherungspunkt `dienstplan-2026-09-09T09-38-07-559341110-5ca163814991` wurde um **09:49:10 UTC** vollständig bestätigt. Die bisherige App startete vor der externen Übertragung wieder. Ihr Journal bestätigte um 09:53:51 UTC ausdrücklich die Sicherungsverantwortung des Linux-Updaters. Die externe Sicherung einschließlich Repository-Prüfung und Aufbewahrung wurde um **10:00:12 UTC** bestätigt. Unmittelbar danach begann der zweite aktuelle Rückfallpunkt vor dem App-Tausch.

Der zweite Rückfallpunkt `dienstplan-2026-09-09T10-00-18-638714485-f92756db2da4` wurde um **10:22:46 UTC** vollständig bestätigt. Anschließend startete v0.92.33 um 10:22:52 UTC; die App lauschte um 10:28:55 UTC. Auch bei diesem Start bestätigte das Journal die Sicherungsverantwortung des Updaters und damit das Auslassen der redundanten Startsicherung.

Der erfolgreiche Updater-Beleg lautet `/var/lib/grabenplaner/maintenance/history/update-2026-09-09T10-29-12-252807307.json`, Abschlusszeit **2026-09-09T10:29:12.491Z**, SHA-256 `cf75f8785e2ab2f34bb06ef7960099a18e5eadd0b6336133b4fc78fa15c5426b`. Er bestätigt `status=success`, `error=null`, den Wechsel von v0.92.32 zu v0.92.33, die exakte Paketprüfsumme und den zweiten Rückfallpunkt. Die enthaltenen `rollback…`-Felder dokumentieren Rückfallvoraussetzungen, keinen tatsächlich ausgeführten Rollback. Der Updater endete mit Exit-Code 0; der Monitor-Timer wurde um **10:29:17 UTC** wieder aktiviert.

## Vollständiger Wiederherstellungsnachweis

Die signierte Ereigniskette bestätigt genau einen automatischen vollständigen Recovery-Assurance-Lauf für diese Version: `29c88238-d54b-4d71-8dfb-3179bbc65a7f`, Beginn **10:29:21.179 UTC**, erfolgreicher Gesamtabschluss **11:28:35.219 UTC**. Alle sieben Ereignisse dieses Laufs sind ohne Fehlercode bestätigt.

Die reguläre Abschlusssicherung der App endete am 9. September um **10:39:40 UTC** erfolgreich, 10 Minuten und 15 Sekunden nach dem kontrollierten Stoppsignal. Der eigene gekoppelte Prüfpunkt `dienstplan-2026-09-09T10-39-47-41603760-95bf1fcd29d0` wurde um **10:55:24 UTC** bestätigt. Die App startete um 10:58:11 UTC wieder, lauschte um 11:03:43 UTC und antwortete bei der öffentlichen Bereitschaftsprüfung um 11:04:11 UTC mit HTTP 200.

| Nachweis | Erfolgreich bestätigt, UTC |
| --- | --- |
| Externe Sicherung, Snapshot `778fff0c9cb7` | 11:06:20.741 |
| Vollständige Repository-Prüfung | 11:09:42.226 |
| Isolierter Wiederherstellungstest | 11:28:33.664 |
| App-Test der Wiederherstellung | 11:28:34.433 |
| Gesamte Recovery Assurance | 11:28:35.219 |

Der Recovery-Beleg hat die SHA-256-Prüfsumme `c7f6c6bd6c411a97b0b4fb729ecbac073876bcf4b5631f1bef107c1d2cb0ae2d`. Ein unabhängiger lesender Beobachter hat das tatsächliche, kurzlebige Ergebnis des isolierten App-Tests erfasst: Format `grabenplaner-recovery-application-smoke`, Schema 1, **`ok=true`, `live=true`, `ready=true`, `reason=null`**. Der Prüfdienst endete mit `Result=success` und Exit-Code 0; sein Status war anschließend `inactive`.

Die normale Startsicherung des erneut gestarteten Produktivdienstes endete ebenfalls erfolgreich, um **11:19:52 UTC**, für `dienstplan-2026-09-09T11-03-45-792Z-71f780b149d2`. Währenddessen wartete der Wiederherstellungslauf an einer Sicherungssperre; nach deren Freigabe setzte er regulär fort. Beide lokalen Archive waren nach dem Gesamtlauf ohne offene Transaktion oder Sperre. Es waren keine weitere Archivreparatur, kein zusätzlicher App-Neustart und kein zweiter Assurance-Lauf erforderlich.

## Betriebs- und Datenbanknachweis

Der tatsächliche installierte Recovery-Versionsvergleich wurde bereits um **10:31:17 UTC** lesend auf der produktiven Datenbank geprüft und ist bestanden. Es sind keine `local`-Migrationsmarker mehr vorhanden.

Die regulären Befehle `grabenplaner-test` und danach `grabenplaner-offsite-test` sind beide mit **Exit-Code 0** bestanden; der gemeinsame Abschluss war um **11:42:27 UTC**. Bestätigt sind unter anderem App und Caddy, interne und öffentliche Bereitschaft, HTTPS-Schutzheader, Zertifikat, Datenbank-Schnellprüfung, Sicherungskopplung, Gruppen- und Dateirechte, Steuerungssockets, Offsite-Timer, Providerbindung, Repository-Identität und der signierte Assurance-Verlauf.

In der Prüfphase erreichte der reguläre Monitor zweimal sein bestehendes Vier-Minuten-Limit. Ein anschließender regulärer Lauf endete am 9. September um **11:41:42.684 UTC** vollständig erfolgreich: **24 Prüfungen bestanden**, `state=ok`, `complete=true`, kein Fehler und kein automatischer Neustartversuch. Dieser tatsächliche Status wurde über den geschützten Statusleser geprüft. Die Monitor-Konfiguration wurde nicht geändert; es gab keinen manuellen Fehler-Reset. Für den anschließenden umfangreichen lesenden Datenvergleich wird die vorhandene Wartungssperre verwendet, während der Monitor-Timer aktiv bleibt.

Der abschließende lesende Datenvergleich lief von **11:43:23 bis 11:46:24 UTC** unter der normalen Wartungssperre und endete mit Exit-Code 0. Danach wurde die Sperre regulär freigegeben. Bestätigt sind:

- **Alle 534 installierten Manifestdateien** und neun öffentlich ausgelieferte Assets stimmen mit dem Paket überein. Die installierte Version und ihr Quellcommit entsprechen v0.92.33 und `ed9fe81cc057ea433b3804aedf97097990013c05`.
- Interne und öffentliche Liveness sowie Readiness antworten mit HTTP 200. Der App-Listener bleibt auf `127.0.0.1:3000` beschränkt; anonyme Zugriffe auf Berichtsaufträge und Rechte-Standards werden mit HTTP 401 abgewiesen.
- SQLite meldet **Integrität `ok` und null Fremdschlüsselfehler**. Kunden-, Bewerbungs- und Kassenbestände sowie Veröffentlichung und Verknüpfungen sind unverändert. Leihfreigaben, Personal-Lifecycle-Funktion und erlaubte Mail-Ereignisse bleiben unverändert.
- Alle sechs neuen Tabellen, die Bestandsnachweise für sieben Kassenquellen und Verknüpfungen sowie **25 Änderungstrigger** sind konsistent. Die Projektion enthält vollständig **19.024 Artikel**, ohne ausstehende Aktualisierung.
- Die Standardabfrage nutzt den vorgesehenen Artikelindex ohne temporäre Sortierung. Eine einzelne SQL-Messung für 50 Zeilen plus exakte Gesamtzahl ergab **4,22 ms**. Dies ist keine vollständige Seitenladezeit und kein kontrollierter Vorher-Nachher-Vergleich.
- Die Rechte- und Auftragsschemata sowie die reparierten Versionsmetadaten sind bestätigt. Der installierte Recovery-Versionsvergleich besteht erneut auf der produktiven Datenbank.
- Offsite meldet **`state=ok`**; alle drei offenen Fehlerkennzeichen für Sicherung, Repository-Prüfung und Wiederherstellung sind `false`. Der historische Eintrag `lastError` bleibt als letzter früherer Fehler gespeichert und wurde nicht manuell gelöscht.

Beide eigenen Upload-Verzeichnisse, `/tmp/grabenplaner-deploy-v09232-a5d2a8a` und `/tmp/grabenplaner-deploy-v09233-ed9fe81`, wurden nach erneuter Prüfung von Realpfad, Eigentümer, regulären Dateien, Inhalt und exakten Paketprüfsummen entfernt. Andere temporäre Verzeichnisse und historische Nachweise wurden nicht bereinigt.

Die Schlusskontrolle endete um **11:48:46 UTC** erfolgreich: App, Caddy und Monitor-Timer sind aktiv und für den Systemstart aktiviert; alle vier Bereitschafts- und Liveness-Aufrufe liefern HTTP 200. Der Assurance-Dienst ist mit Erfolg und Exit-Code 0 beendet. Der tatsächliche vollständige Monitorstatus ist aktuell, mit 24 bestandenen Prüfungen und ohne Fehler. Der Vergleich mit den 23 bereits vor der Veröffentlichung fehlgeschlagenen historischen Units zeigt **keine zusätzlichen Fehler**. Auf dem VPS sind 53.946.404.864 Bytes frei.

Ein vollständiger Ubuntu-Neustart, Änderungen an SSH, Tailscale oder Firewall, ein Quelldatenimport und eine PostgreSQL-Aktivierung wurden nicht durchgeführt. Das [Ubuntu-Wartungskonzept](UBUNTU-WARTUNGSKONZEPT-2026-09-08.md) bleibt der gesonderte Plan für die spätere Host-Wartung.
