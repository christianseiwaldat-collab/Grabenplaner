# Abschluss der Vorbereitungen vor dem nächsten Deploy

Stand: 06.09.2026. Arbeitsstand: `feature/schedule-pdf-day-separators`, HEAD `41e6d92e5fc95c30a4ecb11d478802a930ea44e1`, Version `0.92.27-beta`. Änderungen liegen lokal; kein Commit, Push, Deploy und keine produktive Löschung.

Fortschreibung: Der [Abschluss vom 07.09.2026](VOLLBESTAND-BETRIEB-RESTORE-2026-09-07.md) dokumentiert die danach ausgeführte Vollbestandsmessung, Betriebs-/Restore-Prüfung, den Befund zur Startwartezeit und die Bewertung von drei lokalen Sicherungsständen. Der folgende Vorbereitungsstand bleibt als Historie erhalten.

## Speicherbedarf und Laufzeit

Die Quelldateien sind 330.928.128 Bytes für die Kasse und 188.649.472 Bytes für Trade, zusammen rund 520 MB. Die Größen wurden anhand der bekannten lokalen Dateien bestätigt; in diesem Arbeitsschritt wurden die Quellen nicht erneut inhaltlich eingelesen.

Die früheren 19.665.858.560 Bytes gehörten zur isolierten importierten Prüfdatenbank. Darin lagen neben fachlichen Zielen auch verschlüsselte Quell-, Prüf-, Verknüpfungs- und Rücknahmenachweise. Wiederholte JSON-Feldnamen und leere Werte, mehrere Nachweise je Zeile sowie Verschlüsselungs-/Base64-Verpackung erklären, warum diese Datei deutlich größer als die Access-Quellen war. Die knapp 47 GiB waren eine unvollständige lokale Arbeitsraum-Untergrenze; das spätere konservative Messbudget von 98,25 GB berücksichtigt gleichzeitig erforderliche Kopien und Reserven. Beides ist keine normale tägliche Backupgröße und keine pauschale VPS-Speicheranforderung.

Neue lokale Änderungen:

1. Größere, gut komprimierbare Inhalte werden vor der Verschlüsselung verlustfrei komprimiert. Alte und neue Formate bleiben lesbar, die Formatversion wird authentifiziert, Nonces bleiben zufällig und die Entpackgröße ist begrenzt. Der normale verwaltete Import verwendet den neuen Writer.
2. Die freigegebene gemeinsame Prüfablage vermeidet weitere Wiederholungen in den importinternen Nachweisen. Sie bleibt an ihre vorhandenen Aktivierungsvoraussetzungen gebunden. Bereits verschlüsselte Bestände werden nicht ungeprüft umgeschrieben.
3. Importfortschritt zählt nicht mehr nach jedem 200-Zeilen-Schritt die vollständige Zeilentabelle neu. Kleine Zustandszähler werden atomar mit Insert, Zustandswechsel, Löschung und Rollback gepflegt. Bestehende Bestände bekommen einen einmaligen kontrollierten Aufbau; fehlende Trigger verhindern die Wiederverwendung eines ungesicherten Zählerstands.
4. Identische Quelldateien werden anhand ihrer bestehenden Identität erkannt und erneut bereitgestellte vollständige Quellen erzeugen keine doppelten Zielimporte. Geänderte Quellen müssen weiterhin gelesen und fachlich geprüft werden.
5. Die Tagesaufbewahrung verhindert, dass mehrfache Starts und Stopps jeweils eine eigene dauerhaft aufzubewahrende Vollkopie verbrauchen. Der deduplizierte lokale Archivbetrieb bleibt bis zur vollständigen Betriebsabnahme hinter seinem Opt-in.

### Begrenzte Messungen

Echte TradeFoto-Writer mit synthetischen Datensätzen, Erst- und Folgeimport, erhaltenen Quellversionen und unveränderten fachlichen Ergebnissen:

| Notizgröße | Bisherige DB nach Folgeimport | Neue komprimierte gemeinsame Ablage | Einsparung |
| --- | ---: | ---: | ---: |
| 100 Bytes | 1.527.808 Bytes | 1.036.288 Bytes | 32,2 % |
| 1.000 Bytes | 2.154.496 Bytes | 1.044.480 Bytes | 51,5 % |
| 4.096 Bytes | 3.874.816 Bytes | 1.052.672 Bytes | 72,8 % |

Die reine Schreibzeit dieses kleinen Vergleichs ist mit Kompression höher: etwa 746–779 ms statt 383–527 ms. Daraus wird keine Beschleunigung des vollständigen Imports behauptet. Die entfallende Fortschrittsvollzählung ist separat gemessen: 500 Abfragen bei 100.000 Zeilen benötigten rund 5,17 ms statt 2.351,27 ms. Das beschleunigt diesen Teil; es ist kein Faktor für die komplette Importdauer.

Nachweise: `tmp/import-optimization-metrics-20260906.json`, `tmp/import-optimized-regression-20260906.tap` (65/65). Quelle unverändert wiederverwenden, Unterbrechung/Wiederanlauf, Prüfung, Übernahme, Rücknahme, verschlüsselte Formate und Zustandszähler sind darin enthalten.

## Sicherungen: 20 Tage statt 30 einzelne Zeitpunkte

Ein Sicherungspunkt bezeichnet einen vollständigen wiederherstellbaren Stand zu einem Zeitpunkt. Die bisherigen 30 + 30 Punkte konnten durch mehrere Sicherungen am selben Tag weit weniger als 30 Tage abdecken.

Neu gilt je lokalem Bereich der letzte vollständige Stand jedes Kalendertages in Europe/Vienna für 20 Tage einschließlich heute. Mehrere Sicherungen desselben Tages werden nach erfolgreicher Prüfung zusammengeführt; fehlende Tage werden nicht nachträglich erzeugt und verlängern das Fenster nicht. Der jüngste vollständige Stand bleibt auch nach längerem Stillstand erhalten. Unregistrierte Sonder-/Wartungskopien werden nicht automatisch entfernt.

Die Umstellung gilt für den App- und den zweiten lokalen Sicherungsordner. Damit entstehen bei durchgehender täglicher Sicherung bis zu 20 + 20 Tagesstände. Die lokale Routine wird einmalig auf 24 Stunden eingestellt. Normale Rohsicherungen und der optionale Archivbetrieb verwenden denselben Kalendervertrag. Der neue Umgebungsparameter heißt `GRABENPLANER_BACKUP_RETENTION_DAYS` und hat den Standard 20; die bisherige Variable `GRABENPLANER_BACKUP_KEEP` für Punktzahlen wird nicht als Tageszahl weiterverwendet.

Die separate Google-Drive-Aufbewahrung von täglichen, wöchentlichen und monatlichen Ständen bleibt bestehen. Der Cloud-Archivbestand belegt Cloud-Speicher; die jeweils lokale Ausgangskopie, Übertragungsvorbereitung und Arbeitsdateien benötigen vorübergehend VPS-Platz.

## Samstagsregel

Vollständig lokal angebunden: Verkaufszuordnung im Mitarbeiterdialog, Plan-/Ist-Bewertung einschließlich Xoffi-Intervallen, Tagesprüfung, davon abgeleitete Zeitkonten und Lohnexport. Eine Arbeitsstunde am Samstag ab 13 Uhr ergibt 90 bewertete Minuten. Pausen werden ausgeschlossen, geteilte Dienste einmal je Personentag gerundet.

Bestätigter Übergang: nächster Deploy; alle bereits angelegten Mitarbeitenden einschließlich Lehrlingen im Foto- und Multimediafachverkauf gelten ausdrücklich als Verkauf. Initialzuordnung und Stichtag werden einmalig atomar gespeichert. Vorherige Bewertungen, Salden und Belege werden nicht überschrieben. Die konkrete Rolloutoption und Nachkontrolle stehen im [Samstags-Umstellungsplan](../SAMSTAGSGUTSCHRIFT-UMSTELLUNG-2026-09-06.md). Keine fachliche Rückfrage mehr offen.

## Prüfung und Grenze zu Block 4

- Samstags-, API-, Mitarbeiterdialog- und bestehende Zeitbewertung: 31/31 in `tmp/saturday-final-20260906.tap`; zusätzlicher CSV-Export prüft 120 Zuschlagsminuten und 510 bewertete Minuten.
- Bestehende Zeit-, Xoffi- und Lohnexport-/Providerregression: 74/74 in `tmp/saturday-legacy-inventory-20260906.tap`.
- Gekoppelte Wiederherstellung, Schlüsselrückgewinnung, Archivexport und Messbudget mit echtem lokalem Restic: 14/14, keine Skips, in `tmp/optimized-recovery-20260906.tap`. Es sind synthetische Bestände.
- Backup-/Portal-/Offsite-/Paketverträge und Architektur: 40/40 in `tmp/final-backup-runtime-regression-20260906.tap`.
- Kalenderaufbewahrung, Backup-Publikation und Hintergrundprozess: 35/35 in `tmp/daily-child-final-20260906.tap`.
- Echter lokaler Archivbetrieb: 9/9 ohne Skips in `tmp/daily-archive-final-20260906.tap`. 32 unabhängig geprüfte synthetische Sicherungsstände werden auf exakt 20 Tagesstände reduziert; Schlüsselrückgewinnung, Wiederherstellung, manipulierte Belege, beschädigte Archive und unterbrochene Vorgänge werden geprüft. Der jüngste vollständige Rohstand und unregistrierte Wartungsstände bleiben erhalten. Maßgeblich ist das ursprüngliche bestätigte Sicherungsdatum, nicht das spätere Archivierungsdatum.
- Abschließende CSV-/Katalog-/Architekturprüfung: 16/16 in `tmp/saturday-export-audit-verified-20260906.tap`; eigenständiger Architekturaudit ohne Befunde in `tmp/final-audit-verified-20260906.json`.
- Die freigegebenen PDF-Layouts bleiben erhalten; Layout-/Renderprüfungen sind im gezielten Prüfbericht `tmp/complete-scope-regression-20260906.tap` enthalten. Dessen drei zunächst fehlgeschlagene Export-/Inventurassertionen sind separat korrigiert und erneut geprüft.

Die große neue Vollbestandsmessung mit den beiden Access-Dateien wurde nicht gestartet. Für einen produktiven Block-4-Import fehlen weiterhin der reale Platz- und Laufzeitnachweis des neuen Writers, ein repräsentatives Änderungsfenster sowie die vollständige Runtime-/Offsite-/Wiederherstellungsabnahme. Ein grüner synthetischer Test ersetzt diese Nachweise nicht. C: hatte beim Abschlusscheck rund 119,8 GB frei; die bisherige lokale Platzblockade besteht damit nicht mehr. Es läuft kein Vollimport. Die gezielten Prüfungen sind bestanden; die vollständige Testsuite wurde nach diesen letzten Änderungen nicht erneut durchlaufen.

Die Dienstplanfreigabe ist übernommen. Die neuen Regeln und Optimierungen sind vor einem nächsten Deploy vorbereitet; der Deploy selbst wurde ausdrücklich zurückgestellt.
