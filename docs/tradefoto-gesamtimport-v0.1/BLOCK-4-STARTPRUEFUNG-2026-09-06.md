# Block 4: Prüfung der Fortsetzung

Historischer Stand: 06.09.2026. Die Aussagen dieses Dokuments, insbesondere der damals noch ausstehende Vollbestand und die früheren Aufbewahrungszahlen, bleiben als zeitlich zugeordneter Messbeleg erhalten. Der [Abschluss vom 07.09.2026](VOLLBESTAND-BETRIEB-RESTORE-2026-09-07.md) enthält die inzwischen bestandene Vollbestandsmessung, die Betriebs-/Restore-Ergebnisse, die aktuelle Kapazitätsbewertung und die angefragte Drei-Stände-Variante. Die lokale 20-Kalendertage-Umstellung ist im [Vorbereitungsstand](ABSCHLUSS-VORBEREITUNG-2026-09-06.md) dokumentiert. Keine Veröffentlichung.

## Entscheidung

**Lokale Platzprüfung für eine isolierte Vollbestandsmessung: bestanden. Produktiver Gesamtimport: weiterhin nicht freigabefähig.** C: hat nach der Speicherfreigabe durch den Nutzer 116.372.238.336 Bytes frei; das neue konservative Testbudget verlangt 98.247.376.896 Bytes einschließlich 10 GiB Reserve. Die verbleibenden Nachweise stehen weiter unten. Eine Optimierung oder synthetische Teilprüfung ist keine Freigabe für den Vollbestand.

## Verifizierter Abschluss des alten Messlaufs

`tmp/tradefoto-block3-5S1S2a/report.json`: `status=failed`, `progress.phase=backup-measurement`, 1.082.167 Kassenzeilen verarbeitet, 18.213.148 ms Laufzeit. `backup.error=BACKUP_MEASUREMENT_DISK_RESERVE`, null Sicherungspunkte, kein Restore-Beleg, `productionQualified=false`. Die PIDs 14168 und 20200 waren beim lokalen Check nicht vorhanden. `isolatedMeasurementFilesRemoved=true`; kein fertiger Testbestand steht für eine Fortsetzung bereit.

Der Report verwendet die ältere Messimplementierung. `importEvidenceStorage` und `measurementImplementation` fehlen darin. Er qualifiziert weder `vacuum-into-v2` noch die neue gemeinsame Payload-Ablage. Der Quellenstand wird aus den vorhandenen Hashnachweisen übernommen, nicht als erneut geprüft bezeichnet.

## Historischer Engpass und Herkunft der knapp 47 GiB

Der aktuelle Code in `test-support/tradefoto-full-backup-measurement.js` reserviert vor `VACUUM INTO` mindestens die aktuelle Quelldateigröße plus 64 MiB Arbeitszuschlag plus 10 GiB freie Reserve. Nach dem Dateitausch bleiben Archivaufbau, Stressänderung und Restore ebenfalls platzpflichtig.

| Größe | Bytes | Einordnung |
| --- | ---: | --- |
| Alte DB vor Kompaktierung | 19.665.858.560 | Gemessene unkompaktierte Datei; kein neuer Backup-Punkt |
| Frei beim alten Abbruch | 22.565.416.960 | Report |
| V2-Mindestfreiraum bei derselben Dateigröße | 30.470.385.664 | DB + 64 MiB + 10 GiB; unterstellt keine größeren belegten Seiten |
| Fehlbetrag an dieser Stelle | 7.904.968.704 | Rund 7,36 GiB |
| Optimistische Startuntergrenze bei derselben DB-Größe | 50.136.244.224 | Zwei DB-Dateien + Zuschlag + Reserve; weitere Lasten fehlen noch |
| C: frei beim neuen lokalen Check | 42.014.613.504 | Rund 39,13 GiB; veränderlicher Snapshot |

Schon diese optimistische Startuntergrenze liegt rund 7,56 GiB über dem neuen freien C:-Platz. WAL, weitere temporäre Dateien, Archiv und Restore können den Bedarf erhöhen. Das ist **keine Prognose**, dass die neue gemeinsame Payload-Ablage genauso groß wird; deren Vollbestandswirkung ist gerade noch unbekannt. Synthetische Einsparungsquoten werden nicht auf die 1.477.330 Quellzeilen hochgerechnet.

Die CLI prüfte vor dem Import nur 10 GiB Reserve. Das schützte nicht davor, nach fünf Stunden an der strengeren Kompaktierungsreserve zu scheitern. Diese Lücke ist jetzt durch die unten beschriebene Startprüfung geschlossen. Die 46,69 GiB waren eine optimistische lokale Untergrenze, weder VPS-Bedarf noch Größe von 30 Sicherungen. In dezimalen GB sind es 50,14 GB.

## Zusätzlich fehlende Betriebsnachweise

1. Vollbestand mit dem tatsächlich für den Release vorgesehenen Writer, danach ein nachvollziehbarer Folgeimport. Die CLI kann `--shared-payloads`; der zuletzt beendete Prozess belegt dieses Format nicht.
2. Wirklicher Änderungszeitraum und langfristiges Wachstum. Der aktuelle Messcode ergänzt lediglich 2.000 zufällige Testzeilen; `actualBusinessChangeWindow=false`. Er führt keinen zweiten vollständigen Quellenstand mit veränderter Datei-SHA durch. Schlüssellose Historientabellen behalten weiterhin vollständige dateigebundene Snapshots.
3. Beide lokalen Archive mit je 30 vollständigen Punkten und zusätzlichem Übergangspunkt; Offsite separat. Der große Messhelfer erzeugt nur bis zu drei Punkte im App-Testarchiv. Das prüft Integrität und Größe, nicht den dauerhaften gemeinsamen Betrieb aller Bereiche.
4. Kopien und Speicher: `planLocalBackupCapacity` rechnet ohne verifizierte globale Koordination standardmäßig mit acht gekoppelten Arbeitskopien. Fünf sind erst bei belegter Serialisierung und genau einem Offsite-Stagingpunkt zulässig. Live-Wachstum, WAL, zwei Archive, Übergangspunkt, verwaiste Kandidaten, Repacking und 10 GiB Reserve kommen hinzu. Es gibt keine Löschgutschrift aus vorhandenen Backups.
5. Größenordnung: Würde ein gekoppelter Punkt weiterhin 19,67 GB belegen, wären schon fünf Kopien plus Reserve 109,07 GB. Das übersteigt die historisch freien 75,15 GB des VPS, noch ohne Live-Wachstum und Archive. Dies ist eine bedingte Vergleichsrechnung, kein gemessener kompaktierter Produktionsbedarf.
6. Bestehendes produktives Recovery-Set, verwalteter Import-Key, DB- und Dokumentkopplung sowie falsche Schlüssel praktisch prüfen; Runtime- und Offsite-Verträge koordiniert migrieren. Keine Freigabe durch bloß angepasste Hashwerte.
7. Frische Betriebsprüfung vor Release. Die unten dokumentierte lesende VPS-Prüfung aktualisiert Platz, Unit-Zustände und Assurance; sie ist keine Betriebsabnahme mit dem Großbestand. Die zwei Fehler der älteren Vollsuite sind dokumentiert; spätere grüne Fokustests ersetzen die noch fehlende Gesamtabnahme nicht.

## Kostensparende Reihenfolge

Zunächst eine Start-/Phasenbudgetprüfung aus vorhandenen Größen und aktuellem Code erstellen und einen begrenzten Vergleich der beiden Payload-Formate einschließlich Folgeimport planen. Erst wenn ein plausibles Budget auf der internen C:-Platte samt Reserve vorhanden ist, genau einen gezielten isolierten Vollbestandslauf vorsehen. Dessen gekoppelte Größen und Änderungszuwächse in den unverändert strengen Kapazitätsplan einsetzen. Danach die noch fehlende koordinierte Betriebs-/Recovery-Abnahme und Releasevorbereitung durchführen.

In der ersten Startanalyse wurde zunächst nur die Startfähigkeit analysiert. Die später beauftragte Messvorbereitung ist unten ergänzt. Weder ein neuer Vollbestandslauf noch produktive Änderungen wurden ausgelöst. `productionQualified=false` bleibt bestehen. Kein Speicherzukauf, keine Aufbewahrungsverkürzung, keine Zugangs- oder Infrastrukturänderung.

## Lösungswege und erneuter Prozesscheck

Beim Folgecheck während der PDF-Anpassung am 06.09.2026 war kein zugehöriger Node-, Restic- oder Reservewächter-Prozess aktiv. Der prüfende PowerShell-Prozess wurde aus dem Trefferergebnis ausgeschlossen. C: frei zu diesem Zeitpunkt: 41.722.327.040 Bytes (rund 38,86 GiB). Der Messreport ist weiterhin `failed`; es arbeitet keine Hintergrundmessung an der offenen Abnahme.

| Weg | Nutzen | Grenze / nächster Nachweis |
| --- | --- | --- |
| Neue gemeinsame Payload-Ablage prüfen | Gleiche Inhalte können in mehreren Prüf-/Historienbezügen wiederverwendet werden, ohne Belege zu löschen. | Begrenzter Erst-/Folgeimportvergleich nach Datensatzarten vor dem Vollaufbau; kleine Zeilen und schlüssellose Historien einbeziehen. Keine Hochrechnung einer einheitlichen Einsparungsquote. |
| Messablauf nach Phasen budgetieren | Verhindert einen fünfstündigen Aufbau, der erst an der Kompaktierungsreserve scheitert. `VACUUM INTO` und sequentielle Restores sind bereits lokal vorgesehen. | Startfreiraum für Import, WAL, Kompaktierung, Archiv und Restore nachweisen. Bei gleicher alter DB-Größe sind rund 46,69 GiB nur eine optimistische Startuntergrenze. |
| Backup-Produzenten gemeinsam koordinieren und deduplizierte Archive qualifizieren | Eine belegte Serialisierung kann die konservativ angesetzten acht Arbeitskopien auf mindestens fünf reduzieren; Restic kann gleiche Archivblöcke gemeinsam aufbewahren. | Beide lokalen Bereiche behalten je 30 vollständige logische Punkte. Die Koordination zwischen App, Linux und Offsite sowie Repacking und Übergangspunkte sind noch praktisch zu belegen. |
| Lokal Platz für den Test schaffen | Kann eine lokale Messung ermöglichen, sofern entbehrliche Dateien ausdrücklich identifiziert und freigegeben werden. | Löst die dauerhafte VPS-Kapazität nicht. Aus dem freien Platz wurde nichts gelöscht; vorhandene Backups und beabsichtigte Ausgaben sind keine Löschreserve. |
| Weitergehende Datenablage-Optimierung | Falls die neue Payload-Ablage nicht genügt, muss doppelte Speicherung auch bei kleinen oder häufig wiederholten Daten gezielt reduziert werden. | Eigenständiger größerer Umbau mit unverändert vollständiger Historie, Rücknahme, Verschlüsselung und Recovery-Vertrag; keine bereits vorhandene oder freigegebene Lösung behaupten. |

Die technische Messvorbereitung ist inzwischen abgeschlossen; ihr aktuelles Ergebnis folgt. Nächster Messschritt ist genau ein isolierter Vollbestandslauf mit dem vorgesehenen Speicherformat. Seine Ergebnisse entscheiden über die vorhandene VPS-Kapazität. Ein erfolgreicher lokaler Test allein ersetzt die anschließende Betriebs-, Recovery- und Release-Abnahme nicht.

## Aktuelle Messvorbereitung und Platzfreigabe

`test-support/tradefoto-measurement-budget.js` definiert begrenzte Testannahmen: höchstens 20 GiB DB, zusätzlich 2 GiB WAL/SHM, 64 MiB Dokument-/Kopplungsspielraum, drei Archivpunkte jeweils ohne Deduplizierungs- oder Kompressionsgutschrift, 1 GiB Archiv-Metadaten, 256 MiB zusätzlicher Arbeitsraum und 10 GiB freie Reserve. Das ergibt **98.247.376.896 Bytes = 98,25 GB = 91,5 GiB Startfreiraum**. Diese Grenzen sind keine Prognose der neuen Vollbestandsgröße.

Die Vollmessungs-CLI prüft das Budget vor dem Lesen der Quellen oder Erstellen einer Datenbank. Import und Messhelfer überwachen DB-Familie, gekoppelten Punkt, Archiv und gesamtes Testverzeichnis an ihren Kontrollpunkten; Restic wird zusätzlich sekündlich beobachtet. Überschreitungen führen zum Abbruch mit erhaltenem Fehlercode und dem bestehenden Aufräumen ausschließlich eigener Testdateien. Die Kontrollen sind Stichproben, keine garantierte Dateisystemquote. Der historische fehlgeschlagene Report bleibt unverändert.

Lokaler Snapshot um 17:49 UTC: 116.372.238.336 Bytes frei, **18.124.861.440 Bytes über dem gesamten Startbudget**. Beleg: `tmp/block4-measurement-budget-20260906.json`. Der Nutzer hat den Platz selbst geschaffen; dieser Auftrag hat keine vorhandenen Dateien oder Sicherungen gelöscht.

Der begrenzte Vergleich verwendet die wirklichen TradeFoto-Profile und Stammdaten-/Historien-Writer: je Quellstand 32 Kunden, eine Filiale, acht Kassenköpfe und acht schlüssellose Bestandszeilen. Der zweite Dateifingerprint enthält 31 unveränderte Kunden und eine Änderung. Alle acht Kassenköpfe bleiben unverändert; die acht schlüssellosen Zeilen erzeugen korrekt acht weitere Historienobjekte. Beide Quellstände bleiben lesbar. Dies ist kein realer betrieblicher Änderungszeitraum.

| Synthetisches Kundenmemo | Erstimport bisher / gemeinsam | Nach Folgeimport bisher / gemeinsam |
| --- | ---: | ---: |
| 100 Bytes | 962.560 / 1.077.248 Bytes | 1.515.520 / 1.544.192 Bytes |
| 1.000 Bytes | 1.384.448 / 1.241.088 Bytes | 2.142.208 / 1.822.720 Bytes |
| 4.096 Bytes | 2.301.952 / 1.896.448 Bytes | 3.862.528 / 2.838.528 Bytes |

Die Messung enthält das gesamte kompaktierte SQLite-File mit Zieltabellen, Historie, Importbelegen und Indizes. Kleine Inhalte können mit echten breiten Quellprofilen trotz der kleinen Memo-Größe mehr Platz belegen. Deshalb bleiben die früheren kleinen Codec-Beispiele gültig, sind aber keine allgemeine Zusicherung. Keine pauschale Einsparquote wird auf den Vollbestand übertragen.

Nachweise: `tmp/block4-preparation-20260906.tap` (3/3) und `tmp/block4-budget-restic-20260906.tap` (5/5, keine Skips). Letzterer prüft den budgetierten Messhelfer mit drei echten Restic-Punkten sowie Rücksicherung von DB, Dokument und verwaltetem Testschlüssel; außerdem den Erhalt der Original-Test-DB bei fehlgeschlagenem Dateitausch.

## Aktuell verifizierte Speicherorte und Aufbewahrung

Lesender VPS-Check um 17:41/17:43 UTC; alle lokalen Serverpfade liegen auf derselben Root-Platte:

| Bereich | Aktueller Stand |
| --- | --- |
| VPS freier Platz | 75.130.363.904 Bytes, rund 75,13 GB |
| App-Reihe `/var/lib/grabenplaner/backups` | 30 laut Metadaten vollständige gekoppelte Punkte, rund 10,81 GB belegter Ordner |
| Weitere lokale Reihe `/var/backups/grabenplaner` | 30 laut Metadaten vollständige gekoppelte Punkte, rund 7,67 GB belegter Ordner; zusätzlich zwei getrennte kleine Wartungs-/Migrationskopien |
| Google Drive | Aktives separates Offsite-Ziel, `providerId=google_drive`, Status `ok`; letzter Erfolg 02:13 UTC, vollständige Prüfung 02:13 UTC, Wiederherstellungstest 02:16 UTC |
| Offsite-Arbeitsbereich auf dem VPS | 9.355.264 Bytes; Staging derzeit leer. Während Sicherung und Restore sind zusätzliche lokale Kopien möglich. |

Die laufende App ist aktiv. Die nächtliche Prepare-Unit meldet weiterhin den bereits bekannten Neustart-Timeout nach 120 Sekunden und erreichte in diesem Lauf rund 5,5 GB Arbeitsspeicher. Der spätere Assurance-Lauf war erfolgreich. Die lokal vorbereiteten längeren Wartezeiten und RAM-Optimierungen sind noch nicht installiert. Der erfolgreiche spätere Test macht den vorherigen Fehler nicht ungeschehen.

Google Drive verwendet die separate zeitliche Aufbewahrung von 14 täglichen, acht wöchentlichen und zwölf monatlichen Zeitfenstern; diese überlappen und sind keine feste Anzahl von 30 Punkten. Der Cloud-Archivbestand zählt nicht zum freien VPS-Platz. Nur lokale Ausgangssicherung, Staging und Arbeitsdateien benötigen dort Platz. Die remote vorhandene Anzahl und Größe wurde hier nicht neu aus dem Archiv gelesen.

30 Punkte je lokaler Reihe waren die installierte Vorgabe beim obigen Snapshot. Der Nutzer hat danach ausdrücklich tägliche Sicherungen mit 20 Kalendertagen Rückblick bestätigt. Der neue lokale Code behält je Bereich den letzten vollständigen Stand pro Wiener Kalendertag, einschließlich heute; fehlende Tage verlängern den Zeitraum nicht. Ein älterer jüngster Stand wird als letzter Rückweg dennoch erhalten. Diese Vorgabe ersetzt die frühere Vorschau „älteste plus neueste 19“. Deren rechnerische 3.087.545.874 Bytes sind kein aktueller Löschplan. Historischer Beleg: `tmp/block4-vps-backup-inventory-20260906.json`.

Die neue Tagesaufbewahrung verwendet das ursprüngliche Sicherungsdatum aus dem verifizierten Commitmarker, auch bei späterer Archivierung. Es gibt keine unbegrenzte lokale Fixierung des ältesten Punkts. Unregistrierte Wartungs-/Migrationskopien und die längere Google-Drive-Aufbewahrung bleiben getrennt. Im Produktivsystem wurde nichts gelöscht und die Aufbewahrung noch nicht geändert.

## Unabhängige Dienstplan-Freigabe

Der Nutzer hat die Dienstplanänderungen am 06.09.2026 visuell freigegeben. Sie sind lokal umgesetzt; die letzte PDF-/Einstellungsregression bestand mit 48/48 Tests. Normale Dienste zeigen große Zeit und Badge darunter, Langbezeichnung nur bei aktivierter PDF-Option. Geteilte Dienste behalten Badge links vor der jeweiligen Zeit und den Standorttext unter der Zeit. Mehrtägige Felder passen sich in der Höhe an, mit dem bisherigen K-/S-Mindestmaß. Diese Freigabe ist dokumentiert; es gab keinen Commit, Push oder Deploy.

Die Samstagsgutschrift wurde inzwischen vollständig lokal angebunden und gezielt geprüft. Der Nutzer hat den nächsten Deploy als Stichtag sowie sämtliche vorhandenen Mitarbeitenden einschließlich Verkaufslehrlingen als Verkauf bestätigt. Siehe [Umstellungsstand](../SAMSTAGSGUTSCHRIFT-UMSTELLUNG-2026-09-06.md). Produktive Aktivierung und Deploy stehen aus; weitere fachliche Rückfragen sind dazu nicht offen.
