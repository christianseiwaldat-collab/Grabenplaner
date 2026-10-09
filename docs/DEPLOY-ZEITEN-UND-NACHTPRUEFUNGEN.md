# VPS-Deploy: Zeitbudget und vermeidbare Fehler

Dieses Prozedere ergänzt [SERVERBETRIEB.md](../SERVERBETRIEB.md) für ausdrücklich freigegebene GP-Releases.
Es verändert keine Recovery-Gates, Berechtigungen, Sicherungsanforderungen oder Laufzeitgrenzen.

## Vor dem Paketbau: Bereitschaft und Zeitbedarf

1. Checkout, Branch, Commit und Arbeitsstand sowie den tatsächlichen produktiven Stand feststellen. Installierte Pfade aus den Dienstverträgen ableiten.
2. Den gesonderten lesenden VPS-Preflight ausführen: Wartungssperre, laufende und bevorstehende Wartungs-/Sicherungsläufe, App/Caddy, Live/Ready, Speicherreserve, Dienstkonten, Toolchain und PostgreSQL-Recovery-Pfade.
3. `/tmp` als echtes Verzeichnis ohne Symlink mit `root:root`, exakt `1777` und Sticky-Bit prüfen; App-/Buildkonto und installiertes Offsite-Konto benötigen wirksame Schreib- und Suchrechte. Tests als root verwenden ein privates `TMPDIR`. Keine automatische Änderung gemeinsamer Verzeichnisrechte.
4. Den voraussichtlichen Kurz- oder Vollablauf konservativ anhand des Quellstands und der installierten Nachweise abschätzen. Maßgeblich sind die Regeln in `server-tools/linux/lib/deploy-policy.js`: kritische Dateien, Laufzeitabhängigkeiten, Datenbank-/Konfigurationsbindung, signierte Historie, laufende Recovery-Arbeit und Nacht-Timer. Der Kurzablauf benötigt insbesondere einen höchstens 36 Stunden alten, passend gebundenen Vollnachweis.
5. Prüfpfad und Begründung, Wartezeit bis zur Freigabe, erwartete Aktualisierungszeit und anschließende Prüfzeit mitteilen. Für unbekannte oder nicht vergleichbare Messwerte eine Unsicherheit ausweisen.

Die Vorabschätzung ersetzt nicht die spätere verbindliche `auto`-Entscheidung anhand des geprüften Kandidatenmanifests.
Ein Wechsel des Paket-Verifiers über `--package-verifier-sha256` ist ebenfalls ein Vertrauenswechsel und erzwingt den Vollablauf.
Ergibt die tatsächliche Entscheidung einen längeren Pfad als angekündigt, wird die Laufzeitprognose sofort korrigiert.
Der Wunsch nach höchstens 90 Minuten darf weder einen ungültigen Kurzpfad erzwingen noch Sicherungs- oder Restoreprüfungen verkürzen.
Ein aktiver Nachtlauf wird regulär abgewartet; seine Sperre wird weder umgangen noch durch Abbruch oder Neustart beseitigt.

## Aktualisierung und Beobachtung

- Erst nach grünem Preflight folgen Paketbau, Manifest-/Hashprüfung und erforderliche Kandidatentests. Vor dem Update wird die Bereitschaft erneut geprüft.
- Den bestehenden transaktionalen Updater mit dauerhaft lesbarem Protokoll verwenden. `--health-timeout 1500` begrenzt die Bereitschaftsphase; es ist kein Zeitlimit für den gesamten Deploy, ClamAV oder eine Sicherung.
- Lange Phasen anhand tatsächlicher Prozess-, CPU-, Lese-/Schreib- und strukturierter Fortschrittsdaten beobachten. Vorhandene Diagnosewege nutzen und keine Serie neuer Beobachter-/Hilfsskripte für unveränderte Zustände aufbauen.
- Keine vollständigen Betriebs-/Offsite-Selbsttests parallel zur laufenden Assurance starten. Health-/Statusabfragen bleiben lesend; ein wartender zweiter Selbsttest erzeugt keinen zusätzlichen Nachweis und kann an den Sperren scheitern.
- Logs, Marker und Beobachterdateien bleiben außerhalb des privaten, Restore-Dienst-eigenen und vollständig leeren `restorePair`-Arbeitsordners.

Der Statusbericht unterscheidet die installierte und erreichbare neue App von der noch laufenden Recovery-Prüfung und vom vollständig abgeschlossenen Release.
Ausfallzeit, Gesamtdauer und Dauer der Hintergrundprüfung sind getrennte Angaben.

## Abschluss: einmal gebündelt prüfen

1. Für einen erforderlichen Vollablauf den neuen, zur freigegebenen Version gehörenden signierten Assurance-Lauf abwarten: OAuth-/Providerprüfung, Sicherung, Repositoryprüfung, Restore und App-Smoke müssen bestehen, anschließend auch der gesamte Lauf. Die zugehörige Unit muss regulär beendet sein (`inactive`, `Result=success`); aktive Sperren oder Wartungsjobs verhindern den Start der vollständigen Selbsttests.
2. `grabenplaner-test` und danach `grabenplaner-offsite-test` nacheinander bis zum tatsächlichen Ende ausführen. Ersten Fehlerbeleg bewahren. Nur einen nachgewiesenen vorübergehenden Fehler nach Auflösung seiner Ursache erneut prüfen; keine blinden Wiederholungen oder neuen Deployzyklen.
3. Eine gemeinsame Abschlussprüfung erfasst Version/Commit, Dienste, vier interne/öffentliche Live-/Ready-Antworten, relevante Datenbank-/Migrationsverträge, ausgelieferte Dateien, Updatebeleg, erforderlichen Recovery-Nachweis und offene Fehler. Geschützte Konfigurationshashes, Datenbankidentität und Timerzustände/-zeitpläne werden mit dem Vorabstand verglichen.
4. Bereits beendete Assurance-Control-Units im systemd-Fehlercache zuerst einzeln untersuchen. Nur durch Journale und Sperrintervalle belegte historische Lock-Timeouts mit exaktem Unitnamen, InvocationID, Zeitstempeln, Exitstatus und PIDs 0 qualifizieren. Belege sichern und nach erfolgreicher Wiederholungsprüfung ausschließlich diese Units gezielt zurücksetzen; neue oder ungeklärte Fehler bleiben offen. Kein pauschales `reset-failed`, kein Zurücksetzen echter Sicherungs-/Restorefehler.
5. Vorhandene strukturierte Ergebnisse nach ihrem tatsächlichen Schema lesen; Feldnamen und systemd-Laufzeitfelder nicht erraten. systemd kann eine erfolgreich beendete Template-Instanz sammeln: `ExecMainCode=0` und leere Invocation-/Start-/Endfelder sind dann kein fortbestehender Laufzeitbeleg. Erfolg nur mit dem aktuellen signierten Vollnachweis, passender Version, erfolgreichem inaktivem Dienst und freien Sperren bestätigen. Die Identitätsprüfungen fehlgeschlagener Requests bleiben strikt.
6. Die Log-/Statusanalyse für bekannte lange Phasen vorbereiten; konkrete Request-Identitäten nach Laufende nochmals feststellen. Vorhandene geprüfte Prüf-/Bereinigungswege wiederverwenden, statt beim Abschluss für jeden Eintrag neue Skripte und mehrfach dieselben Reviews aufzubauen.
7. Releasebelege privat sichern. Ausschließlich die exakt geprüften temporären Staging-Verzeichnisse nach Prüfung von Pfad, Realpath, Typ, Eigentümer/Rechten, Inhalt/Hashes und fehlenden Prozessreferenzen entfernen; Datenbanken und Sicherungen erhalten. Anschließend Abwesenheit und finalen Gesundheitszustand bestätigen, Git-/Remote-Stand prüfen und einen kompakten Abschlussbeleg schreiben.

Der gespeicherte Host-Sicherheitsaudit muss zum abgeschlossenen Wartungszustand passen. Ein Timerlauf während eines vorübergehenden App-Stopps kann bei einem älteren separat installierten Hardening-Modul einen fehlenden Listener als kritischen Portfehler speichern; später erfolgreiche Recovery-Läufe ersetzen diesen unabhängigen Audit nicht. Nach Ende der Wartung erst lesend prüfen, ob Listener/Firewall und Dienste tatsächlich korrekt sind. Anschließend mit dem installierten `grabenplaner-host-security audit --write-status` einen neuen echten Nachweis schreiben und dessen Prüfpunkte/Alarmstufen kontrollieren. Die alte Meldung wird weder manuell gelöscht noch durch eine gelockerte Indexbewertung verdeckt. Ein nachgewiesener Kernel-Neustartbedarf bleibt sichtbar; er wird nicht durch einen App-Neustart erledigt. Version und Vertrag des separat installierten Hardening-Moduls gesondert prüfen: Ein App-Deploy aktualisiert dieses Modul nicht automatisch.

Der Kurzablauf behält seine vertraglich zulässige Bindung an den Nachtlauf. Er bekommt nicht allein für einen Abschlussbericht einen zusätzlichen sofortigen Vollrestore.
Nach vollständig erfolgreichem Abschluss endet die Releasearbeit; unveränderte Zustände werden nicht weiter abgefragt und optionale Reparaturen eröffnen keinen weiteren Releasezyklus.

## Gemessene Referenz und Konsequenzen vom 08.10.2026

Beim Release v0.92.78-beta wählte der Updater `full` mit `RECOVERY_CONTRACT_CHANGED`.
Auch Deploy-/Sicherungsdateien hatten sich gegenüber dem installierten Stand geändert; die Änderungen an der Oberfläche allein beschreiben deshalb den Prüfbedarf nicht.

| Abschnitt | Gemessene Dauer |
| --- | ---: |
| Laufenden Nachtlauf vor Beginn abwarten | rund 30 Minuten |
| Vorbereitung nach Freigabe | rund 8 Minuten |
| Transaktionaler Updater | 49 Minuten 48 Sekunden |
| Darin: ClamAV | 8 Minuten 55 Sekunden |
| Darin: zwei PostgreSQL-Sicherungspunkte | zusammen 27 Minuten 58 Sekunden |
| Darin: externe Vorsicherung | 7 Minuten 55 Sekunden |
| Anschließende vollständige Assurance | 96 Minuten 44 Sekunden |
| Abschluss nach Ende der Assurance | 28 Minuten 29 Sekunden |
| Darin: sequenzielle Betriebs-/Offsite-Selbsttests | 2 Minuten 14 Sekunden |

Die enthaltenen Unterphasen und überlappende Arbeiten werden nicht nochmals zur Gesamtdauer addiert.
Der zu früh gestartete Selbsttest wartete parallel zur Assurance; seine Wartezeit war kein zusätzlicher serieller Block.
Er verursachte aber einen vermeidbaren Fehler und Nacharbeit. Beim Abschluss entfiel der größte Teil auf vermeidbare Orchestrierung,
zusätzliche Hilfsskripte und die späte Bereinigung alter Timeout-Spuren. Diese Vorbereitung gehört in die laufende Wartephase;
die gezielte Bereinigung selbst bleibt an den erfolgreichen Prüfabschluss und freie Sperren gebunden.

90 Minuten sind ein Ziel für einen normalen kompatiblen Kurzablauf, keine Zusage für einen Vollablauf.
Hier benötigten Updater und anschließende Assurance bereits rund 147 Minuten zuzüglich Warteschlange, Vorbereitung und Abschluss.
Künftige Prognosen verwenden aktuelle vergleichbare Messwerte und unterscheiden technische Laufzeit, überlappende Arbeit und vermeidbaren Organisationsaufwand.
