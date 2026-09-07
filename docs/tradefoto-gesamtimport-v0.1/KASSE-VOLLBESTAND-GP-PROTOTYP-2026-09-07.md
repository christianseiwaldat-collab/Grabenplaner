# Gesamte Kasse im schlanken GP-Prototyp

Nachfolgende Umsetzung: [Kasse funktional an die Auswertungen angebunden](KASSE-ANBINDUNG-ABSCHLUSS-2026-09-07.md). Die unten beschriebene fehlende fachliche Anbindung ist der historische Prototypstand; der neue Abschlussbericht dokumentiert Leseadapter, Rechte, festgehaltene Zuordnungen, Aktivierung und Rückkehr. Die ursprünglichen Vollbestandsmesswerte bleiben unverändert erhalten.

Stand: 07.09.2026. Ausdrücklicher Auftrag: „Gesamte Kasse im schlanken Prototyp – Das machen wir.“ **Die gesamte Kassenhistorie bleibt enthalten; die 24-Monate-Grenze entfällt. TradeFoto bleibt vollständig und unverändert.**

## Umgesetzter Aufbau

Die normale GP-Importvorschau kann neue Kassenquellen nun in sieben kompakten Kassentabellen speichern. Jede Quellzeile besitzt genau ein verschlüsseltes Wertefeld. Alle 97 Geschäftsfelder, ursprüngliche Quellzeilen, typisierte Identitäten und die bisherigen präzisen Normalisierungsregeln bleiben erhalten. Beleg- und Journalpositionen verweisen innerhalb desselben Datenstands auf vorhandene Köpfe. Unbekannte Datumswerte oder alte Jahre werden nicht entfernt.

Die Tabellen liegen in der vorhandenen GP-Datenbank. Ein kleines, authentifiziert verschlüsseltes Datenstandsprotokoll hält Quellenhash, Schema, Importeur, Zähler, Prüffortschritt und Prüfsummen. Damit gibt es keine zusätzliche Kassen-Datei, die bei einem GP-Backup versehentlich fehlen könnte. Verschlüsselte Kassentabellen und der durch den bestehenden Integration-Vault geschützte Import-Key-Umschlag werden gemeinsam gesichert. Ein normaler Sicherungslauf erfordert keinen neuen Import und keine Neuverschlüsselung sämtlicher Geschäftswerte.

Der Kassenweg schreibt keine zusätzlichen universellen Importzeilen, Quellverknüpfungen, Rücknahmekopien oder Historienversionen mit erneutem Geschäftswertinhalt. Vorhandene frühere Importbestände werden weder umgebaut noch gelöscht. Bereits begonnene universelle Kassenläufe behalten ihre ursprüngliche Ablage; der neue Weg betrifft neue Kassenläufe. Trade-Uploads verwenden den bisherigen Import unverändert.

Die Quelle wird in begrenzten Paketen gelesen. Fortschritt und verschlüsselte Werte werden je Paket atomar gespeichert. Derselbe Upload kann nach einer Unterbrechung wiederholt werden: vorhandene Zeilen werden mit den erneut gelieferten Werten verglichen, weitere Zeilen angefügt. Eine andere Datei erhält einen eigenen Datenstand. Ein Fehler nach der letzten Lesemeldung gilt weiterhin als Unterbrechung und erfordert denselben Upload erneut.

Die Prüfung liest jede gespeicherte Zeile vollständig zurück und vergleicht eine fortlaufende Prüfsumme mit der beim Lesen aufgebauten Quellwert-Prüfsumme. Zeilenzahl, Reihenfolge, authentifizierte Metadaten und Nutzdaten müssen übereinstimmen. Eine Restore-Prüfung beginnt bei null und vertraut nicht bloß dem gespeicherten Status „geprüft“.

Die bestehende persönliche Importberechtigung, CSRF-Prüfung, private Quellenzuordnung und verwaltete Schlüsselöffnung gelten auch hier. Die Sitzung wird vor und nach jedem begrenzten Arbeitsschritt neu geprüft; die Sitzungsprüfung darf selbst über denselben Provider lesen. Die Oberfläche zeigt nur Fortschritt und Zeilenstatus, keine privaten Quellwerte. Nicht vorhandene Einzelzeilen-Rücknahme und Protokollaktionen werden für den kompakten Vorschauweg nicht angeboten.

## Nachweisstand

**Vollbestands-, Archiv- und Wiederherstellungsprüfung bestanden.** Der Lauf verwendet die echte, zuletzt bereitgestellte Kassenquelle mit 1.082.167 Zeilen. Alle sieben Tabellen und alle 97 Geschäftsfelder sind enthalten. Nachweis: [maschinenlesbarer Messbericht](KASSE-VOLLBESTAND-GP-PROTOTYP-2026-09-07.json).

| Messgröße | Ergebnis |
| --- | ---: |
| Access-Quelle | 330.928.128 Byte / 330,93 MB |
| Kompaktierte GP-Testdatenbank mit gesamter Kasse | **816.533.504 Byte / 816,53 MB** |
| Verhältnis Datenbank zur Quelle | **2,47** |
| Erstes lokales verschlüsseltes Archiv einschließlich Metadaten | **449.205.660 Byte / 449,21 MB** |
| Zusätzlicher Archivplatz für den zweiten unveränderten Sicherungspunkt | **52.534 Byte / 52,5 KB** |
| Upload einschließlich vollständigem Lesen und Speichern | 9 min 37,69 s |
| Vollständiges Rücklesen und Quellwertvergleich | 2 min 50,75 s |
| Kompaktierung | 18,65 s |
| Import, Prüfung und Kompaktierung zusammen | **12 min 47,10 s** |
| Archivbildung einschließlich automatischem gekoppeltem Restore | 23,17 s |
| Erneuter Restore einschließlich vollständigem Wertevergleich | **3 min 19,43 s** |
| Gesamter Nachweislauf einschließlich zweitem Sicherungspunkt | 16 min 54,33 s |

Die Bytewerte betreffen die vollständige Kasse mit den benötigten leeren GP-Importtabellen; sie enthalten weder den übrigen produktiven GP-Bestand noch einen neuen Trade-Vollimport. MB und KB sind dezimale Einheiten. Die Laufzeiten wurden auf diesem PC gemessen, teilweise parallel zu gezielten Tests. Der frühere 835,14-MB-Wert gehört zum separaten Dateiprototyp; die aktuelle GP-Ablage ist der hier gemessene Aufbau.

Das lokale Archiv wurde mit dem vorhandenen, per SHA-256 geprüften Restic-Programm über den bestehenden GP-Archivhelfer erzeugt. Die Sicherung enthält Datenbank, authentifizierten Abschlussmarker und geschützte Dokumente. Nach dem Restore stimmte der Datenbank-Dateihash überein. Eine neue Provider-/Vault-Instanz öffnete den enthaltenen verwalteten Import-Key-Umschlag mit demselben flüchtigen Test-Vault-Schlüssel. Danach wurden **alle 1.082.167 Zeilen erneut entschlüsselt und vollständig verglichen**. Ein fehlender oder falscher Vault wird nicht durch einen neuen Schlüssel ersetzt.

Der zweite Sicherungspunkt verwendete unveränderte Datenbankwerte und bestand ebenfalls die automatische gekoppelte Wiederherstellung. Seine 52,5 KB zusätzlicher Archivplatz sind eine reale Deduplizierungsmessung; sie sind keine Zusicherung für geänderte Geschäftsdaten, zukünftige Exporte oder tägliche Sicherungen mit sonstigen GP-Änderungen. Der Test änderte keine vorhandene Aufbewahrungsregel und löschte keine vorhandene Sicherung.

Die beobachtete Dateispitze im isolierten Prüfverzeichnis lag bei 2.084.586.767 Byte. Das ist eine Stichprobenmessung der vorhandenen Testdateien; interne temporäre SQLite-Dateien außerhalb des Verzeichnisses und kurzfristige Spitzen innerhalb synchroner Archivoperationen sind damit nicht vollständig vermessen. Die RAM-Zahl im JSON stammt aus `process.memoryUsage().rss`; sie ist keine Messung aller externen Archivprozesse. Aus diesen Werten wird keine automatische VPS-Gesamtfreigabe abgeleitet.

Alle ausschließlich für diesen Lauf erzeugten Datenbanken, Archive, Restores und Test-Schlüsseldateien sind entfernt. Die Access-Quelle ist in Hash, Dateigröße und Änderungsmetadaten unverändert; TradeFoto wurde nicht gelesen oder verändert. Auf C: waren danach 135.696.523.264 Byte frei. Der frühere abgebrochene Anbindungslauf wurde nach Korrektur des Provider-basierten Sitzungsladens ebenfalls vollständig aus seinem eigenen Testverzeichnis bereinigt.

Gezielte Funktionsprüfungen: volle Historie einschließlich alter und fehlender Datumswerte, Dezimalpräzision und führende Nullen, fehlender Belegkopf, doppelte Identität samt vollständigem Paketrollback, wiederholter Upload, Unterbrechung nach der letzten Lesemeldung, erneuter Runtime-Start, Datenstandstrennung, Rechteentzug, tatsächliches Provider-basiertes Sitzungsladen, manipulierte Indizes, fehlende Zeilen und falscher Vault. Die bestehende Wiederherstellungsprüfung erkennt kompakte Kassenbestände auch dann als schlüsselpflichtig, wenn allgemeine Quellenmetadaten fehlen.

Abschließende gezielte Prüfgruppen: **118 bestanden, 0 fehlgeschlagen, 1 übersprungen** (77 Import-/Archiv-/Providerprüfungen, 23 Architekturprüfungen, 18 bestandene Start-/Migrationsprüfungen). `git diff --check` besteht. Dies ist kein neuer vollständiger Release-Testlauf. Der PostgreSQL-Vertrag wurde um die 46 neuen Statementverträge auf 1.308 Verträge ergänzt; sämtliche Produktivfreigaben für PostgreSQL bleiben unverändert geschlossen.

## Abgrenzung zur produktiven Auswertung

Dieser Auftrag setzt den gesamten Bestand als lokalen GP-Prototyp um. Eine bestandene Speicher-/Werteprüfung ist keine fachliche Umsatzfreigabe. Die kompakte Kasse bleibt ausdrücklich von produktiver Übernahme und Kennzahlenaktivierung ausgeschlossen, auch wenn die allgemeine Importfreigabe anderweitig geöffnet würde.

Für den produktiven Verkaufsbereich sind anschließend der kompakte Leseadapter mit Standort- und Datenklassenrechten, bestätigte Trade-/GP-Zuordnungen mit festgehaltenem Zuordnungsstand, Regel-/Belegabgleich sowie der atomare aktive Datenstandswechsel einschließlich Rückkehr zum vorherigen geprüften Stand fertigzustellen. Die vorgesehene Rücknahme betrifft einen ganzen Datenstand; manuelle Einzeländerungen an historischen Quellwerten sind nicht vorgesehen. Der aktive Standwechsel ist im vorliegenden Speicherprototyp noch nicht aktiviert oder nachgewiesen.

Eine Wiederherstellung dieses lokalen Kassenbestands ersetzt nicht die gesamte VPS-Betriebsabnahme einschließlich unverändertem Trade-Bestand, vorhandener Sicherungsreihen, Offsite-Assurance und freiem Google-Drive-Speicher. Bestehende Sicherungen, Aufbewahrungsregeln und Produktivschlüssel wurden nicht verändert. Kein Commit, Push, Deploy oder produktiver Kassenimport.

## Code und Prüfung

- [Kompakte Ablage](../../lib/persistence/repositories/cash-snapshots.js), [Providerverträge](../../lib/persistence/statements/cash-snapshots.js), [SQLite-Schema](../../lib/persistence/sqlite/operations/cash-snapshots-schema.js).
- [Normale GP-Importanbindung](../../lib/persistence/repositories/data-import-runtime.js), [gezielte Tests](../../test/cash-snapshots.test.js).
- [Vollbestands- und Wiederherstellungshelfer](../../scripts/verify-compact-cash-full.mjs).
- [Früherer isolierter Speichervergleich](KASSE-SCHLANKER-SNAPSHOT-MESSUNG-2026-09-07.json), unverändert erhalten. Dessen 24-Monate-Variante ist keine aktuelle Auswahlvorgabe.
