# Arbeitskopien und bereitgestellte Quellen

Stand: 07.09.2026. Lokale Fortsetzung auf `feature/schedule-pdf-day-separators`, HEAD `41e6d92e5fc95c30a4ecb11d478802a930ea44e1`. Die vorherige [Vollbestandsmessung und Betriebsprüfung](VOLLBESTAND-BETRIEB-RESTORE-2026-09-07.md) bleiben nachvollziehbar. Kein Commit, Push, Deploy, produktiver Import, Speicherzukauf oder manuelles Löschen vorhandener Sicherungen in dieser Fortsetzung.

## Verbindliche Quellenregel

Es werden ausschließlich die zuletzt vom Nutzer bereitgestellten Exporte verwendet. Ein wochenlang unveränderter Stand ist zulässig; es gibt keine Pflicht zu täglichen oder regelmäßigen neuen Exporten. Die beiden Desktop-Dateien vom 04.09.2026 wurden in dieser Fortsetzung erneut nur gehasht und blieben identisch:

| Quelle | SHA-256 |
| --- | --- |
| Trade_Daten.accdb | `42a40cb19d867fcc5d6e6f3429065ba0ff77f65a7b9b7fcfaae3d0b61f8154f3` |
| Kassen_Umsätze.accdb | `6a7e9f3cb8404299da54aef8c5ab661d7d66e1791003ebcd62c10d60a6a4e395` |

Ein tägliches App-Backup sichert den vorhandenen Grabenplaner-Bestand und startet keinen erneuten Access-Vollimport. Die erfolgreiche Wiedererkennung unveränderter Dateien ist im vollständigen Messlauf bereits enthalten. Kontrollierte synthetische Folgeimportfälle mit den echten Import-Writern sind vorhanden; sie werden nicht als echte neuere Geschäftsdaten ausgegeben. Erst wenn der Nutzer eine neue Datei bereitstellt, wird deren geänderter Stand vor der Übernahme geprüft. Langfristiges Archivwachstum und Kapazität bleiben technische Prüfaufgaben und werden nicht durch eine fiktive Upload-Häufigkeit ersetzt.

## Lokal umgesetzt

Der Archivexport verwendet auf demselben Dateisystem die zuvor unabhängig geprüfte temporäre Datenbank samt Dokumenten und Marker direkt als Export. Die Dateien werden in ein neu angelegtes privates Ziel verschoben und dort nochmals geprüft. Dateiidentität und Hash bleiben erhalten. Eine zweite vollständige Exportkopie wird nicht angelegt. Auf unterschiedlichen Laufwerken bleibt eine geprüfte Kopie mit getrennten Platzprüfungen nötig. Bestehende Exporte und das Archiv werden nicht überschrieben.

`lib/backup-workspace.js` koordiniert große Kopierarbeiten je vorhandener Live-Datenbank. Unter Linux teilen Node und Bash eine betriebssystemseitige `flock`-Sperre; unter Windows wird der vorhandene SQLite-Sperradapter für eine separate Sperrdatei verwendet. Die Sperre wird nicht anhand eines Alters zwangsweise entfernt. Nach dem tatsächlichen Prozessende gibt das Betriebssystem sie frei. Symlink-/Hardlinkpfade, ersetzte Sperrdateien und ungültige Wartebudgets werden abgelehnt.

| Eingebundener Weg | Lebensdauer der gemeinsamen Sperre |
| --- | --- |
| Hintergrundsicherung der App | Vor Platzprüfung und Rohkopie bis Archivierung, Aufbewahrung und Abschluss des Workers |
| Start-/synchrone App-Sicherung und Backup-CLI | Während der vollständigen Sicherung; bestehende App-Instanzsperren bleiben getrennt |
| Datenbankdownload | Von der Snapshot-Erstellung bis zum Transferabschluss und Bereinigungsversuch; ein belegter Arbeitsbereich ergibt HTTP 409 |
| Linux-Serversicherung | Nach kontrolliertem App-Stopp, über die gesamte Erstellung und Archivierung |
| Offsite-Vorbereitung | Während der Staging-Kopie; unvollständige Staging-Dateien werden vor Freigabe der Sperre entfernt, danach darf die App wieder starten |
| Isolierter Offsite-Restore-Test | Vor Restic-Restore bis zum Ende einschließlich isoliertem App-Test und Bereinigung |
| Archivverwaltung | `export`, `archive-existing`, `finish-retention`, `reconcile`; absoluter `DB_PATH` der zugehörigen vorhandenen Installation erforderlich |

Offsite-Vorbereitung prüft bestehendes Staging jetzt innerhalb der Wartungs- und Repository-Sperren. Eine weitere Vorbereitung verwendet nur einen verifizierten passenden bestehenden Punkt. Ein unvollständiger Rest im Staging-Verzeichnis blockiert einen neuen Aufbau; er wird nicht stillschweigend gelöscht. Der Pre-Update-Aufruf übernimmt seine bereits gehaltene Repository-Sperre ausdrücklich. Das verhindert ein gegenseitiges Warten auf dieselbe Sperre.

Die abschließende Paketprüfung fand eine zusätzliche Lieferlücke: Die bisherigen Paketfilter schlossen `backup.js` sowie die beiden benötigten Skripte für Hintergrundsicherung und Archivverwaltung aus. Linux-Verifikation und beide Windows-Paketbauer lassen jetzt genau diese Laufzeiteinstiege zu und verlangen sie zusammen mit den Sicherungsmodulen als Pflichtdateien. Andere Skripte, Testimporte, Daten und Geheimnisse bleiben ausgeschlossen. Drei gezielte Tests belegten den Fehler vor der Korrektur; danach erzeugte der Worker aus einer isolierten Kopie der tatsächlich zugelassenen Laufzeitdateien einen verifizierten Sicherungspunkt. Das ist keine Veröffentlichung des offenen Arbeitsstands.

## Nachweise dieser Fortsetzung

| Prüfung | Ergebnis |
| --- | --- |
| Tatsächliches Linux-Sperrverhalten, einschließlich Bash/Node in beiden Richtungen und beendetem Worker | 5 von 5 bestanden; unveränderte Wiederholung ebenfalls bestanden |
| Echter Hintergrundworker bei bereits belegtem Arbeitsbereich | Keine neue Sicherungsdatei während der Wartezeit; nach Freigabe verifizierter vollständiger Sicherungspunkt |
| Hintergrundworker, Offsite-Staging und Persistenzinventar | 23 von 23 bestanden |
| Paketvertrag, Workspace und Server-Backup-/Downloadtests | 28 bestanden, 1 Linux-Plattformtest unter Windows übersprungen, kein Fehler |
| Archivexport mit echtem Restic und 64 MiB zufälliger Nutzlast | 9 von 9 bestanden; SQLite-Datei 67.207.168 Bytes, Export 5.913 ms, keine zweite Datenbankkopie, Dateiidentität erhalten |
| Linux-Shellsyntax | 35 Skripte bestanden |
| Korrigierte Paketfilter, isolierter Paket-Worker und vorhandene Paketverträge | 27 bestanden, 3 Linux-Plattformtests unter Windows übersprungen; beide PowerShell-Paketbauer syntaktisch geprüft |
| Abschließende Klassifikation der synthetischen Datenbank-Testfixtures | 5 von 5 bestanden; keine neue direkte Produktiv-SQL-Kopplung |
| Vollständige Regression vor den letzten Korrekturen | 3.077 Tests: 3.031 bestanden, 2 fehlgeschlagen, 44 übersprungen, keine Abbrüche; 19 min 24 s |
| Korrigierte vorhandene Windows-Paketfixture und neuer Paket-Worker | 10 von 10 bestanden |
| Windows-Dateikonflikt beim signierten Assurance-Kopf | 9 von 9 bestanden, einschließlich vorübergehendem und dauerhaftem Fehler sowie bestehender Wiederaufnahme einer gültigen signierten Kette |
| Abschließende Assurance- und Paketregression nach Anpassung des Windows-Wartefensters | 101 bestanden, 5 Plattformtests übersprungen, kein Fehler; darin die neun History-Tests |
| Windows-Parallelprüfung mit ausschließlich der implementierten Wiederholung | 800 synthetische Historien in acht Prozessen, 1.600 atomare Austausche bestanden; 77 vorübergehend fehlgeschlagene native Rename-Aufrufe abgefangen |

Der größere Exporttest verwendet synthetische Daten und einen neuen lokalen Testschlüssel. Er belegt den konkreten Weg ohne zweite Kopie, keine unterbrechungsfreie Messung aller Betriebsabläufe. Alle dadurch erzeugten Archive, Datenbanken und Testschlüssel wurden durch den Test entfernt. Das für den Linux-Nachweis eigens angelegte Verzeichnis `/tmp/grabenplaner-workspace-check-20260907-6bfa19` wurde nach den beendeten Tests auf genauen Pfad und Eigentümer geprüft und entfernt. Installierte VPS-Dateien, Dienste und Konfiguration wurden dafür nicht geändert.

Die abschließende lesende VPS-Abfrage um 02:47:13 UTC bestätigt App und Caddy aktiv, interne Bereitschaft HTTP 200 und das entfernte isolierte Testverzeichnis. Weiterhin sind 18 System-Units als fehlgeschlagen registriert; es wurde nichts zurückgesetzt. Eine erneute Datenbank-/Offsite-Restore-Abnahme ist diese kurze Bereitschaftsabfrage nicht. Beleg: `tmp/backup-workspace-vps-readonly-20260907.json`.

Belege: `tmp/backup-workspace-linux-final-20260907.tap`, `tmp/backup-workspace-contention-20260907.tap`, `tmp/backup-workspace-final-contracts-20260907.tap`, `tmp/backup-workspace-64mib-export-20260907.tap`, `tmp/backup-package-runtime-final-20260907.tap`, `tmp/backup-package-inventory-final-20260907.tap` und [GROSSDATEN-BACKUP-NACHWEIS.json](GROSSDATEN-BACKUP-NACHWEIS.json). Der erste Gesamtlauf `tmp/backup-workspace-complete-regression-20260907.tap` enthält die echten Restic-Tests und zwei Fehler wegen der noch fehlenden Fixture-Klassifikation. Der weitere abgeschlossene Gesamtlauf liegt separat unter `tmp/backup-workspace-final-complete-regression-20260907.tap`. Sein Archiv-Kerntest bestand erneut mit der vorhandenen gepinnten Restic-Binary; zusätzliche über das Environment freischaltbare Integrationsfälle bleiben durch ihre separaten erfolgreichen Läufe belegt. Ein anfänglicher VM-Test benötigte die neue echte Sperrabhängigkeit in seinem Testkontext; nach deren Ergänzung bestanden alle zwölf Tests der betroffenen Server-Dateien. Die Produktivsperre wurde dafür nicht umgangen.

Die zwei Fehler des letzten Gesamtlaufs betreffen eine vorhandene Windows-Paketfixture mit unvollständiger Pflichtdateiliste und erneut `EPERM` beim Austausch von `head.json` in der lokalen Assurance-Historie. Die Paketfixture wurde an den tatsächlich erforderlichen Laufzeitumfang angepasst. Der Windows-Dateifehler trat anschließend auch beim isolierten Nachtest auf. Betroffen sind neu erzeugte synthetische Testverzeichnisse unter Windows auf C:, keine produktive Kassendatenbank und kein beschädigter VPS-Sicherungspunkt. Welcher Prozess den Dateizugriff kurzfristig verhindert hat, wurde nicht bestimmt.

Eine erste Begrenzung auf 500 ms bestand den isolierten History-Test, reichte im breiteren Prüflauf jedoch nicht aus: `tmp/backup-workspace-assurance-package-final-20260907.tap` enthält 100 bestandene Tests, fünf Skips und einen weiteren `EPERM` im Automation-History-Test. Eine anschließende Diagnose mit acht parallelen Prozessen reproduzierte bei 1.600 Austauschen 18 vorübergehende Konflikte. Dieselben vorhandenen, beschreibbaren Dateien konnten nach etwa 254 bis 1.320 ms atomar ausgetauscht werden. Beleg: `tmp/backup-workspace-assurance-head-parallel-diagnostic-20260907.json`. Diese Diagnose ermittelt die Dauer der Störung, nicht den verursachenden Prozess.

Die abschließende lokale Korrektur wiederholt ausschließlich unter Windows denselben atomaren Dateiaustausch bei `EPERM`, `EACCES` oder `EBUSY`, mit höchstens elf Versuchen und insgesamt 3.000 ms vorgesehener Wartezeit. Die bisherige signierte Datei wird dabei niemals vorab gelöscht. Ein dauerhafter Fehler oder ein anderer Fehlercode bricht weiterhin ab. Ein bereits geschriebener gültiger Ereignisbeleg kann über das bestehende signierte Präfix-Recovery beim nächsten Anfügen wieder aufgenommen werden; eine reine Prüfung meldet die noch unvollständige Veröffentlichung weiterhin als Fehler. Der gezielte Test verlangt auch die erfolgreiche Erholung nach mehr als den zunächst vorgesehenen Versuchen. Alle sieben ursprünglichen History-Tests sowie zwei neue Tests für diese Fehlerfälle bestanden innerhalb der abschließenden Assurance-/Paketregression. Linux führt weiterhin nur den bisherigen unmittelbaren atomaren Austausch aus.

Die Parallelprüfung wurde anschließend ohne zusätzliche Wiederholungen im Diagnosewerkzeug ausgeführt: Alle 800 Historien mit 1.600 Austauschen bestanden. 77 einzelne native Rename-Aufrufe meldeten vorübergehende Fehler, die die implementierte Wiederholung abfing; mehrere Aufrufe können dabei zum selben Dateikonflikt gehören. Alle eigenen Testverzeichnisse wurden entfernt. Belege: `tmp/backup-workspace-assurance-package-bounded-final-20260907.tap` und `tmp/backup-workspace-assurance-parallel-product-final-20260907.json`. Der abschließende Offsite-Fingerprint lautet `76d31dab7f1bcac97a6e7b91d4af0abbf4431f397458d0d63f6e9404a991e053`; die installierte Version wurde nicht verändert.

Die letzten Korrekturen werden mit gezielten Assurance- und Pakettests sowie der Parallelprüfung nachgewiesen. Ein dritter vollständiger Gesamtlauf wurde danach nicht ausgeführt; der fehlgeschlagene Gesamtlauf wird nicht nachträglich als bestanden ausgegeben. Die bisherigen Implementierungsmanifeste einschließlich des ersten Windows-Korrekturversuchs bleiben erhalten, und `tmp/backup-workspace-assurance-bounded-final-implementation-20260907.json` erfasst den abschließend korrigierten Stand getrennt. Die zwölf Implementierungsdateien der großen Importmessung blieben unverändert.

## Was daraus für den Speicher folgt

Beim Export eines gekoppelten Vollbestands entfällt rechnerisch eine weitere Kopie von rund 11,60 GB. Das ist eine Einsparung in diesem Ablauf, kein pauschaler Abzug von jedem Backup oder vom gesamten VPS-Planungsbudget. Die gemeinsame Sperre verhindert überlappende Aufträge der oben aufgeführten Wege; ein einzelner Auftrag kann trotzdem mehrere Dateien gleichzeitig benötigen.

Insbesondere hält der vollständige Offsite-App-Test den wiederhergestellten Stand fest und erzeugt zusätzlich eine bereinigte App-Datenbank. Diese Test-App kann eigene Start-/Abschluss-Sicherungen anlegen. Betreute Recovery-Vorbereitung und -Anwendung sowie Updater-Rollback besitzen weitere Sicherheits- und Austauschkopien. Diese manuellen Wege wurden hier nicht auf die neue Sperre umgebaut und dürfen nicht als bereits damit qualifiziert gelten. Ein fehlender Live-Datenbankpfad wird nicht angelegt, um die neue Sperre zu umgehen.

Auch Bereinigungsfehler nach Downloads oder Recovery können Dateien zurücklassen. Ein Sperrtest beweist weder deren Abwesenheit noch eine Obergrenze für alle Fehlerreste. Die zuvor optimistisch auf null angesetzten Reste und Bereinigungsschulden bleiben daher unqualifiziert. Bestehende Freigabegrenzen und Kapazitätsformeln wurden nicht verkleinert.

Das bisherige Planungsbudget von 133.298.160.777 Bytes zusätzlichem Freiraum bleibt konservativ. Die lesende Abfrage um 02:47 UTC ergibt 72.458.493.952 Bytes frei, rund 72,46 dezimale GB. Das Budget wird damit verglichen, nicht dazuaddiert; es fehlen gegenüber diesem Modell rund 60,84 GB. Ein engeres Budget benötigt einen Nachweis aller Phasen einschließlich großer Kandidaten-App, Fehlerfällen und vollständigem Restore/Update/Rollback. Die bisher erfolgreiche Vollbestandsmessung ersetzt diese Betriebsprüfung nicht.

Die Drei-Sicherungen-Variante wurde weder durch Konfigurationsänderung noch durch Löschungen umgesetzt. Der vorhandene lokale Kandidat bleibt bei 20 Kalendertagen je Bereich und täglichem Intervall; Google Drive hat eine eigene Aufbewahrung. Kein produktiver Block-4-Start wird aus den neuen Teilprüfungen abgeleitet. Bei der nächsten freigegebenen Veröffentlichung sind die geänderten Core-/Offsite-Verträge gemeinsam zu migrieren und der vollständige signierte Assurance-Lauf erneut zu bestehen.

Auch die Lieferregel für die beiden Backup-Skripte gehört in diesen Migrationsnachweis: Der normale Linux-Updater verwendet zuerst den bereits installierten vertrauenswürdigen Paketprüfer. Dessen bisherige Regeln schließen `scripts/` und `backup.js` aus. Ein nur lokal bestandener neuer Paketprüfer beweist deshalb noch keine Kompatibilität mit dem bisherigen Updatepfad. Ebenso ist `migrate-grabenplaner-runtime-v4.sh` ausdrücklich nur für Schema 3 → 4 vorgesehen und kann nicht als allgemeine Änderung einer bestehenden Schema-4-Installation wiederverwendet werden. Weder dieser Vertrauensübergang noch eine neue Runtime-Migration wurden hier ausgeführt oder durch Austausch einzelner installierter Dateien umgangen.
