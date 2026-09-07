# Vollbestand, Betrieb und Wiederherstellung

Stand: 07.09.2026. Branch `feature/schedule-pdf-day-separators`, HEAD `41e6d92e5fc95c30a4ecb11d478802a930ea44e1`, Version `0.92.27-beta`. Der absichtlich offene Arbeitsstand bleibt erhalten. Kein Commit, Push, Deploy, produktiver Import oder Kauf von Speicher. Die normalen installierten Betriebsprüfungen haben Sicherungspunkte und Prüfbelege erzeugt; der vollständige Assurance-Versuch hat die App kontrolliert neu gestartet. Keine manuelle Bestandslöschung oder Änderung der produktiven Aufbewahrung.

## Ergebnis und Grenze

Die isolierte Vollbestandsmessung mit `shared-parts-v1`, authentifizierter Deflate-Kompression und transaktionalen Fortschrittszählern ist bestanden. Alle 1.477.330 Zeilen aus beiden Quellen wurden verarbeitet, zwei Archivstände unabhängig zurückgespielt und die Schlüssel-/Dokumentkopplung geprüft. Beide Quelldateien blieben unverändert. Die temporären verschlüsselten Testbestände, Archive und Testschlüssel wurden entfernt; aggregierte Nachweise bleiben erhalten.

Ein produktiver Start von Block 4 ist damit noch nicht freigegeben. Das langfristige Archivwachstum und der gemeinsame Betrieb aller Kopier-/Sicherungswege mit dem großen Bestand fehlen. Die unten stehende konservative Kapazitätsrechnung passt nicht auf den aktuellen VPS. Sie ist ein Planungsbudget, kein gemessener gleichzeitiger VPS-Verbrauch. Die folgende [lokale Optimierung und Quellenregel](ARBEITSKOPIEN-UND-QUELLSTAENDE-2026-09-07.md) baut darauf auf; die fehlende Bereitstellung eines neueren Exports wird nicht als laufende Aufgabe des Nutzers behandelt.

## Vollständiger Import

| Messgröße | Ergebnis |
| --- | ---: |
| Trade-Quelle | 188.649.472 Bytes, 395.163 Zeilen, 102 Tabellen |
| Kassen-Quelle | 330.928.128 Bytes, 1.082.167 Zeilen, 7 Tabellen |
| Quellen zusammen | 519.577.600 Bytes, 1.477.330 Zeilen |
| Gesamtlauf einschließlich Prüfungen und Backups | 19.296.665 ms, 5 h 21 min 37 s |
| Importphase bis zum vollständigen Anwenden | rund 5 h 8 min |
| Neue Datenbank vor Kompaktierung | 12.012.789.760 Bytes |
| Kompaktierte Datenbank | 11.602.071.552 Bytes |
| Alter unkompaktierter Vergleichsbestand | 19.665.858.560 Bytes |
| Einsparung vor Kompaktierung, gleiche Vergleichsstufe | 38,92 % |
| Gemessene Spitze des gesamten isolierten Testverzeichnisses | 28.541.897.537 Bytes |

Die SQLite-Datenbank enthält zusätzlich zu den fachlichen Daten die verschlüsselten Quellnachweise, Änderungen, Verknüpfungen, Rücknahmenachweise und Indizes: jeweils 1.477.330 Quell-, Link- und Änderungszeilen, 1.343.597 Historieneinträge und -versionen, 133.733 Stammdatensätze sowie 2.638.655 Stammdaten-Haltebeziehungen. Sie ist deshalb keine einfache Kopie der etwa 520 MB großen Access-Dateien.

Die zwölf im Messbericht festgehaltenen Implementierungshashes wurden unverändert nachgewiesen. Der spätere Fehlerbehelf für das 24-Stunden-Backupintervall verändert keinen dieser Import-/Messbausteine. Integritätsprüfung und Fremdschlüsselprüfung sind bestanden; `issues=[]`. Wiederholung und Neustart mit denselben vollständigen Quellen erzeugten keine doppelten Zielimporte.

Die Wiedererkennung identischer lokaler Quellen dauerte im Messlauf unter einer Sekunde je Datei. Das umfasst lokale Dateilektüre/Hash und vorhandene Identität, keinen Netzwerktransfer und keinen geänderten Quellenexport. Ein tägliches Backup benötigt keinen erneuten Vollimport. Der erste vollständige Import bleibt in dieser Messung dennoch ein Vorgang von etwa fünf Stunden. Ein wesentlicher Geschwindigkeitsgewinn ist nicht nachgewiesen; zu Beginn liefen lokale Regressionstests mit geringer Priorität parallel.

Messrechner: Windows, Intel i7-11700F, acht Kerne/16 Threads, rund 68,49 GB RAM. Die beobachtete Prozessspeicherspitze lag bei etwa 1,15 GB; die ergänzende Beobachtung begann erst nach Prozessstart. Verzeichnis-/Speicherspitzen sind Stichproben, keine garantierten Obergrenzen. Das ist kein Benchmark des VPS mit rund 8,32 GB RAM.

## Archiv und lokale Rücksicherung

| Prüfpunkt | Archivgröße bzw. Zuwachs | Erstellen | Rücksicherung |
| --- | ---: | ---: | ---: |
| Erster Vollbestand | 5.331.534.291 Bytes Archiv | 108,294 s | 75,252 s, bestanden |
| Unveränderter Folgestand | +658.710 Bytes | 43,850 s | gleicher DB-Hash; keine weitere unabhängige Rücksicherung |
| Synthetischer Belastungsstand | +2.476.450.745 Bytes | 74,225 s | 80,957 s, bestanden |

Beide unabhängigen Restores haben den verwalteten Import-Schlüssel wiedergewonnen und die geschützten Testdokumente verifiziert. Es waren Testschlüssel, keine produktiven Vault-Schlüssel. `restic check --read-data` bestand in 22,248 Sekunden. Der gesamte Backup-Messabschnitt dauerte 535,613 Sekunden. Unabhängig verifizierte `VACUUM INTO`-Kompaktierungen dauerten 63,317 und 58,322 Sekunden.

Der Belastungsstand erzeugt eine neue Testtabelle mit 2.000 zufälligen 1-KiB-Datensätzen und kompaktiert erneut. Die DB wächst dabei nur um 2.744.320 Bytes, das Archiv aber um etwa 2,48 GB. Das ist kein echter Geschäftstag und keine tägliche Wachstumsprognose. Der Effekt zeigt, warum der fast unveränderte Archivzuwachs nicht auf echte Folgetage übertragen werden darf. Die vorhandenen Backupwege verwenden ebenfalls `VACUUM INTO`; ihr konkreter Einfluss auf das Archiv muss mit geänderten echten Quellen gemessen werden.

## Produktiver Betrieb und Google-Drive-Restore

Die installierte Version bleibt `0.92.27-beta`. Der App-Selbsttest bestand am 07.09. um 00:58:05 UTC, der anschließende Offsite-Selbsttest um 00:58:49 UTC: Dienste, interne/öffentliche Bereitschaft, SQLite, gekoppelte Sicherungen, TLS/Sicherheitsheader, Providerbindung, Binär-/Installationsverträge und signierte Historie wurden geprüft.

Der isolierte Restore aus dem tatsächlich verwendeten Google-Drive-Archiv bestand um 01:01:11 UTC. Snapshot `dda0b883e7a7…`, rund 603,63 MB und 137 Dateien; 54 geschützte Dokumente, 91 geschützte Datensätze und 72 eingefrorene Dateien wurden geprüft. Es waren keine gespeicherten Integrations-Zugangsdaten vorhanden. Der normale Quartalstest startet keine isolierte App (`applicationSmoke=not-run`). Der produktive Bestand enthält noch keine Tabellen des neuen Importmoduls.

Der zusätzliche vollständige Recovery-Assurance-Lauf von 01:08:11 bis 01:21:39 UTC ist **fehlgeschlagen**: Der neue gekoppelte lokale Sicherungspunkt und das Offsite-Staging entstanden, aber die installierte Vorbereitung wartete nur 120 Sekunden auf die App. Sie meldete `PREPARE_FAILED`, bevor Upload und isolierter App-Test erreicht wurden. Die App war anschließend ohne weiteren Eingriff wieder bereit. Der lokale Kandidat wartet an derselben Stelle bereits 1.500 Sekunden; diese Korrektur wurde nicht auf den VPS übertragen.

Der aktuelle signierte Fehler wird nicht gelöscht oder durch einen alten Erfolg ersetzt. Der letzte erfolgreiche vollständige signierte Lauf stammt vom 06.09.2026, 02:16:41 UTC. Die danach separat ausgeführte vollständige Archivprüfung bestand am 07.09. um 01:28:53 UTC. Der erneute Restore mit isoliertem App-Start bestand um 01:31:49 UTC: `applicationSmokePassed=true`, Snapshot `dda0b883e7a7`, Receipt-SHA-256 `2d643957b9502f742767d6b25bc6ab72b451c0fd851e065fc06b0d52fd09b7eb`. Die installierten Wartungs-, Assurance- und Repository-Sperren wurden eingehalten; die produktive App blieb bei diesen separaten Prüfungen aktiv. Ein separat bestandener Restore macht den fehlgeschlagenen vollständigen Lauf nicht nachträglich erfolgreich.

Der abschließende produktive Check um 01:34:18 UTC bestätigt App und Caddy aktiv, interne und öffentliche Bereitschaft erfolgreich, SQLite-Integrität bestanden und keine Fremdschlüsselverletzungen. Die produktive DB hat 637.530.112 Bytes und weiterhin null Tabellen des neuen Importmoduls. Der Offsite-Status führt den offenen Vorbereitungsfehler korrekt weiter. systemd meldet 18 fehlgeschlagene Units, davon die zuvor vorhandenen 17 und eine weitere Assurance-Control-Instanz seit dem Neustart; es wird kein fehlerfreier Zustand aller Betriebssystemdienste behauptet. Historische Fehler wurden nicht manuell zurückgesetzt.

## Speicher und die vorgeschlagenen drei lokalen Stände

Die Quote wurde über die eingerichtete VPS-Backup-Verbindung und deren verifizierte Google-Drive-Providerbindung abgefragt. Das Konto meldete 214.748.364.800 Bytes Gesamtkapazität und **109.565.102.697 Bytes frei** (109,57 dezimale GB beziehungsweise 102,04 GiB). Die Quote umfasst auch andere Google-Dienste. Der freie Platz reicht für die gemessene erste Archivbasis von 5,33 GB; eine Zusage für ein längerfristiges Änderungsfenster ist damit nicht möglich. Die Drive-Aufbewahrung bleibt 14 tägliche, acht wöchentliche und zwölf monatliche Auswahlpunkte; überlappende Punkte müssen nicht zusätzliche physische Kopien sein.

Das vorhandene Planungsmodell verlangt bei zwei lokalen Archivbereichen, acht möglichen gekoppelten Kopien, 2 GiB WAL-Budget, Archivkandidat und 10 GiB Reserve **133.298.160.777 Bytes freien Platz**. Der zunächst gemessene VPS-Freiraum von rund 74 GB wird davon abgezogen, nicht dazuaddiert. Nach dem Assurance-Versuch waren rund 71,85 GB frei, also rund 61,45 GB weniger als das Modell verlangt. Mit rund 31,07 GB bereits belegtem Platz entspräche das rund 164,37 GB Gesamtkapazität. Die frische abschließende Quote steht im Kapazitätsbeleg.

Die acht Kopien sind eine vorsichtige Annahme für überlappende Abläufe. Die fünf benannten Basiskopien sind: jüngster App-Rohpunkt, jüngster externer Rohpunkt, Offsite-Staging, neue Rohkopie und unabhängiger Restore. Ohne globale Koordination werden gleichzeitige weitere Erstellungen und altes Offsite-Staging berücksichtigt. Nicht alle acht wurden gleichzeitig auf dem VPS beobachtet. Die lokale Testspitze von 28,54 GB umfasst einen isolierten Ablauf, nicht zwei Archive mit allen produktiven Erstellern und Rücksicherungswegen.

Die Aufbewahrung von drei lokalen Ständen ist zunächst eine angefragte Variante, keine ausgeführte Löschung oder geänderte Konfiguration:

- **Drei je Bereich:** sechs aufbewahrte Stände; bei unkomprimierten Vollkopien des Messbestands allein rund 69,61 GB. Beim deduplizierten Modell mit bereits optimistisch auf null gesetztem Änderungszuwachs bleiben die 133,30 GB unverändert.
- **Drei insgesamt:** drei unkomprimierte Vollkopien allein rund 34,81 GB. Ein einziger zukünftiger Archivbereich würde im ansonsten gleichen Modell nur eine Basis von 5,33 GB einsparen, auf rund 127,97 GB. Das vorhandene Modell verlangt zwei Bereiche; ihre Zusammenführung wäre eine eigene Änderung.
- Selbst die noch nicht nachgewiesene Fünf-Kopien-Variante mit zwei Archivbasen, Live-Wachstum und Reserve liegt bei 91,01 GB, bevor WAL, Archivkandidat und echtes Wachstum hinzukommen. Mit nur einer Archivbasis beträgt diese unvollständige Untergrenze 85,68 GB.

Die zwei vorhandenen lokalen Backupverzeichnisse belegten zusammen rund 21,15 GB. Das ist keine sichere Löschfreigabe und keine Einsparung bei drei verbleibenden Ständen; darin können geschützte oder unregistrierte Wartungskopien liegen. Selbst eine unrealistische vollständige Freigabe dieses Platzes reicht nicht für das bestehende 133-GB-Modell. Zuerst sind Erstellungswege und Zwischenkopien zu begrenzen, dann ihr realer gemeinsamer Spitzenbedarf zu messen. Ein Speicherzukauf ist damit noch nicht beschlossen.

## Lokale Regression und verbleibende Freigaben

Die vollständige Suite vor der letzten Intervallkorrektur bestand mit 3.024 bestandenen Tests und 40 bedingten Skips. Danach wurden 3.065 Tests ausgeführt: 3.024 bestanden, 40 übersprungen, ein Fehler beim atomaren Umbenennen einer temporären Windows-Datei (`EPERM`) im unveränderten Assurance-Historientest. Dessen vollständige Testdatei bestand anschließend mit sieben von sieben Tests. Es wird kein durchgehend grüner letzter Gesamtlauf behauptet. Ein ähnlicher Umbenennungsbefund war bereits in einer früheren Testuntersuchung dokumentiert; die Ursache des sporadischen Windows-Dateizugriffsfehlers ist nicht abschließend bestimmt. Die bestehende atomare Signaturablage wurde dafür nicht abgeschwächt.

Zusätzlich wurde ein echter Einstellungsfehler korrigiert: Die API erlaubte 24 Stunden, der SQLite-Provider bisher nur sechs. Die tägliche Einstellung wird nun gespeichert, 25 Stunden werden atomar abgelehnt. Rotnachweis und sieben bestandene Fokustests liegen vor. 35 Linux-Shellskripte bestanden die Syntaxprüfung. Die 40 Skips umfassen bedingte Plattform-/PostgreSQL-Prüfungen; ein großes produktionsgleiches Linux-Kandidaten-Deployment wurde nicht durchgeführt.

Vor dem produktiven Start bleiben insbesondere offen:

1. Belastbares Änderungs- und Archivwachstumsbudget einschließlich Bereinigung. Bis zu einem neuen Upload ausschließlich den zuletzt bereitgestellten Stand verwenden; Änderungen kontrolliert synthetisch prüfen und beim nächsten tatsächlich bereitgestellten Export vor dessen Übernahme neu messen.
2. Verifizierte Koordination von App-, Server- und Offsite-Erstellung; nur benötigte Zwischenkopien, tatsächliche gemeinsame Spitze und klare Entscheidung über drei lokale Stände insgesamt oder je Bereich.
3. Große Kandidaten-App, Download, Restore, transaktionales Update und Rollback mit dem importierten Bestand sowie dessen verwaltetem Schlüssel im bestehenden Recovery-Set.
4. Koordinierte Core-/Offsite-Vertragsmigration und Wiederholung des vollständigen Assurance-Laufs mit dem längeren Startfenster beim ausdrücklich freigegebenen Deploy.

Die genehmigten Dienstplan- und Samstagsänderungen bleiben im lokalen Arbeitsstand. Der aktuelle Aufbewahrungskandidat ist weiterhin 20 Kalendertage je lokalem Bereich mit 24-Stunden-Intervall. Die neue Drei-Stände-Idee ersetzt diesen Stand erst nach der Entscheidung über ihren genauen Umfang.

## Nachweise

- Vollbestand: `tmp/tradefoto-block3-2Ap4l0/report.json`
- Implementierung: `tmp/full-stock-implementation-verification-20260907.json`
- Gesamtabnahme: `tmp/full-stock-operational-verification-20260906.json`
- Produktiver Endstand: `tmp/full-stock-vps-final-state-20260907.json`
- Vollständiger Assurance-Versuch: `tmp/full-stock-vps-full-assurance-20260907.json`
- Separate Archiv-/App-Restore-Prüfung: `tmp/full-stock-vps-isolated-recovery-20260907.json`
- Kapazität und Varianten: `tmp/full-stock-capacity-20260907.json`
- Tatsächliche Drive-Quote: `tmp/backup-drive-quota-20260907.json`
- Konsolidierter fachlicher Status: [GROSSDATEN-BACKUP-NACHWEIS.json](GROSSDATEN-BACKUP-NACHWEIS.json)
