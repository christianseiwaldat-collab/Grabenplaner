# Block 9: vollständige historische Übernahme

Abgeschlossen am 12.09.2026 um 20:08 UTC. Der Nutzer hat die Blöcke 9–12 nacheinander beauftragt. Der Produktivbetrieb bleibt während der folgenden Betriebs- und Gesamtprobe auf SQLite.

Die Übernahme beginnt mit einer eigenen konsistenten Online-Kopie der SQLite-Datenbank. Private Dateien, Branding und die geschützte Konfiguration werden mit individuellen Prüfsummen gebunden. Die Kopie bleibt im bestehenden, ausschließlich für GP angelegten Entwicklungsbereich. Es werden weder neue Quellexporte verlangt noch historische oder ungeklärte Positionen ausgelassen.

Jede der 248 Quelltabellen wird ihrem bestätigten Ziel zugeordnet. Drei GP-Zuordnungstabellen wechseln in den Core. Technische lokale Referenzen werden zusätzlich aus den unveränderten Quellen abgeleitet. Benachrichtigungs-Rowids und Sequenzen werden ausdrücklich übernommen.

Der Transfer vergleicht pro Tabelle Zeilenzahl und vollständigen kanonischen Inhalt. Fachliche Trigger werden nur innerhalb der isolierten, gesperrten Lade-Transaktion vorübergehend ausgesetzt, um bereits vorhandene Historien und Zähler nicht doppelt zu erzeugen. Fremdschlüssel werden vor Abschluss vollständig geprüft; Trigger und Constraint-Einstellungen entsprechen danach exakt dem freigegebenen Schema. Fehler erzeugen keinen erfolgreichen Nachweis für das Datenbankpaar.

## Ergebnisse

Zwei vollständige Übernahmen aus derselben konsistenten Online-Kopie liefern jeweils **248 Tabellen und 2.887.715 Datensätze** mit identischen kanonischen Inhaltsnachweisen. Davon liegen 148.777 Datensätze in den 194 Core-Tabellen und 2.738.938 in den 54 Sales-Tabellen. Leere Tabellen bleiben ausdrücklich enthalten. Die Originalquelle und sämtliche übernommenen verschlüsselten Werte bleiben unverändert.

Gemeinsamer Inhaltsnachweis: `b37ad81733768b2e0c90f728e7d5c4a33dca7b6f33c7cb4f98599db254ece379`.

- 30.503 Stammdatenverknüpfungen einschließlich Versionsnachweisen, sechs lokale Filialreferenzen und vier feste Artikelrevisionen für bestehende Leihen sind geprüft.
- 23 Sequenzen sind gegen übernommene Höchstwerte und historische SQLite-Zähler fortgesetzt. Die ursprünglichen Benachrichtigungs-Rowids sind Bestandteil des vollständigen Inhaltsvergleichs.
- 65 private bzw. Branding-Dateien und die geschützte Konfiguration sind durch einzelne SHA-256-Werte gebunden. Alle 55 verschlüsselten Dokumentdateien lassen sich öffnen; sämtliche 55 Datenbankverweise sind vorhanden.
- Der unveränderte verwaltete Importschlüssel wurde geöffnet. 15 Kassenstichproben prüfen Entschlüsselung, vollständige Profilnormalisierung und Quellschlüssel. 28 geschützte Personal-/Urlaubseinträge wurden mit ihrem Datensatzkontext geöffnet. Diese Stichproben ergänzen den vollständigen Vergleich der gespeicherten Ciphertexte; sie werden nicht als erneute Entschlüsselung aller Millionen Archivzeilen ausgegeben.
- Ein gezielter Fehler nach zwei bereits geladenen Tabellen rollte beide Datenbanktransaktionen zurück. Kein vollständiger Paar-Nachweis wurde geschrieben. Der anschließende Wiederholungslauf prüfte vor jedem Neuaufbau nochmals sämtliche bisherigen Tabelleninhalte und lieferte erneut denselben Inhalt.
- Fünf gezielte Prüfungen für Zielbegrenzung, Schemaabweichungen, kaputte Fremdschlüssel, Datei-/Pfadmanipulation, exakte Zahlen und kanonische Zeilen bestanden lokal und unter dem tatsächlichen Node-Runtime des Servers.

Die erste vollständige Übernahme einschließlich Inhaltsprüfungen dauerte **570,857 Sekunden**, die Wiederholung einschließlich Prüfung des vorherigen Bestands **655,257 Sekunden**. Dies ist keine Zusicherung für das gesamte Wartungsfenster: finaler Rückkehrpunkt, Betriebsprüfung und Umschaltung kommen später hinzu. Die reine Online-Erstellung der Ausgangskopie samt Dateibindung benötigte 32,911 Sekunden.

Nachweis: [block-9-verification.json](block-9-verification.json). Detaillierte Tabellen- und Sequenznachweise liegen geschützt im eigenen Serverbereich unter `historical-9/transfer-first.json` und `transfer-second.json`. Sie enthalten keine entschlüsselten Geschäftszeilen. Die produktive GP- und Lebensatlas-Instanz wurden nicht umgestellt oder neu gestartet.

## Wiederholung und Aufbewahrung

Der historische Bestand bleibt in den beiden eigenen Entwicklungsdatenbanken für Block 10/11 erhalten. **Die synthetischen Aufbau-/Bereinigungswerkzeuge aus Block 1–8 dürfen auf diesem Bestand nicht ausgeführt werden.** Der wiederholbare Transfer akzeptiert nur das eigene Umfeld, identische Quellprüfsummen, einen vollständigen vorangegangenen Nachweis und unveränderte Tabelleninhalte ohne weitere aktive Clients. Das Neuaufbauen erfolgt in Transaktionen ausschließlich für diesen eigenen Bestand.

Ein PostgreSQL-Restore, die vollständige HTTP-Anwendung und der Produktivwechsel sind dadurch noch nicht abgenommen. Diese folgen in Block 10–12.
