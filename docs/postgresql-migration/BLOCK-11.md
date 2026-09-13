# Block 11: vollständige Anwendung und Generalprobe

Abgeschlossen nach Block 10, Stand 13.09.2026. Die produktive Quelle ist weiterhin SQLite. Die vollständige HTTP-Generalprobe, Wiederherstellung, Lastprobe und administrative Datenausgabe sind bestanden; keine Produktivumschaltung.

Die vorhandenen Core-/Sales-/Boundary-Kataloge werden in den vollständigen Server eingebunden. Zusätzlich werden die bisher direkt synchronen Betriebs- und Fachoperationen für Filialbestellungen, temporäre Filialeinsätze, Audit, Diagnostik, geschützte Startprüfung und Datenausgabe bearbeitet. Der bislang erreichte Katalog- und Worker-Nachweis ersetzt diese Gesamtprüfung nicht.

Die ersten beiden Fachoperationen liegen als explizite asynchrone PostgreSQL-Portierungen vor. Datenbankabhängige Array-Schleifen werden der Reihe nach abgewartet; Schreibtransaktionen halten dieselbe Core-Koordinationssperre wie der Core/Sales-Vertrag. Erst nach nativen Paritäts- und Konflikttests werden sie in den HTTP-Server verdrahtet. Die ursprünglichen SQLite-Operationen bleiben zunächst unverändert.

Die vollständige Startkomposition prüft Schema, geschützte Datensätze und Anmeldungen. Ein eigener, begrenzter Pool hält die erneute Berechtigungsprüfung auch bei parallelen Anfragen erreichbar. Berichts- und Belegworker werden vor der Bereitschaftsmeldung initialisiert. Umfangreiche alte Regelwerksbelege werden bei der tiefen Prüfung seitenweise gelesen; der Serverstart lädt nicht mehr sämtliche historischen JSON-Ergebnisse auf einmal.

Ein Sales-Import übergibt persönliche Aktionsbelege dauerhaft über die vorhandene Audit-Ausgangstabelle an Core. Die Generalprobe unterbricht nach dem Core-Commit und vor der Sales-Bestätigung: Wiederholung erzeugt keinen zweiten Beleg, und die Rücknahmeinformation bleibt erhalten. Abbruch vor dem Sales-Commit hinterlässt keine Aktion.

Erreichte Nachweise:

| Probe | Ergebnis |
| --- | --- |
| Filialeinsätze und Filialbestellungen | 12 native Paritäts-/Konfliktfälle bestanden, Transaktion anschließend zurückgerollt |
| Vollständige HTTP-Anwendung | Anmeldung, Dienstplan/PDF, historischer Sony-Artikelstamm, 8 parallele Abfragen, Import mit falscher und richtiger Bestätigung, Rücknahme und wiederholte Rücknahme bestanden |
| Rechteentzug | Deaktivierte Testanmeldung erhält 401 |
| Wiederanlauf | Tatsächliches SIGKILL; Januarbericht nach einmaligem Wiederanlauf mit exakt 2.239 Positionen fertiggestellt |
| Vollständige geschützte Wiederherstellung | 264 Tabellen, 24 Sequenzen, 55 Dateien, 113 geschützte Datensätze und anschließende HTTP-/PDF-Generalprobe bestanden; 544 Regelwerksbelege vollständig geprüft |
| Ausgangstabelle zwischen Sales und Core | Unterbrechung nach Core-Commit, idempotente Zustellung und Rollback vor Sales-Commit bestanden |
| Monatsbericht aller Filialen | 19.551 Positionen, 127.880 PDF-Bytes, 257.691 ms |
| Ganzes Jahr mit Vorjahresvergleich | 27.499 Positionen, 113.508 PDF-Bytes, 338.914 ms |

Die Lastprobe lief mit historischem Datenbestand in einem eigenen Netzwerk, auf einen CPU-Kern und 1.536 MiB begrenzt. Alle 48 parallelen Fachabfragen antworteten erfolgreich. Gemeinsames p95: 2.557 ms, Maximum: 3.366 ms einschließlich der ersten Anfragen. Wiederholte Belegsuchen ohne Berichtslast lagen bei 436–616 ms; unter Berichtslast überwiegend bei 1–1,5 s. Diese Messung ist keine Behauptung einer produktiven p95 unter einer Sekunde. Die PDF-Laufzeiten schließen die Kontrollabfragen ein.

Die Datenausgabe verwendet einen koordinierten Lesezeitpunkt beider Datenbanken und native PostgreSQL-Dumps. Sie enthält keine Dokumentdateien, Schlüssel oder administrativen Rollenpasswörter. Ausdrücklich dokumentierte Betriebsmetadaten mit eingeschränkten Spaltenrechten und drei obsolete, leere Sales-Tabellen sind ausgenommen; die freigegebenen Schemavertragswerte liegen im Manifest. Die vollständige Serverwiederherstellung verwendet weiterhin ausschließlich das gekoppelte, geschützte Betriebssicherungspaket aus Block 10.

Die Datenausgabe wurde vollständig in zwei neue Prüf-Datenbanken eingelesen: 200 Core- und 58 Sales-Tabellen, insgesamt 2.948.916 Zeilen und 24 Sequenzen stimmten überein. Das 995.840.000 Byte große TAR-Paket enthielt ausschließlich Manifest und zwei Dumps; ein gleichzeitig angeforderter zweiter Export wurde abgewiesen. Die Prüf-Datenbanken und temporären Exporte wurden danach entfernt. Die benötigten Erweiterungen werden explizit mitgenommen, entsprechend der [PostgreSQL-18-Dokumentation zu pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html).

Nach Abschluss folgt der bereits beauftragte Block 12: produktive Providerkonfiguration, Betriebsintegration für Sicherungs- und Neustartwege, abschließende Umschaltprobe und konkreter Produktivwechsel mit Rückkehrgrenze. Ein bloßes Umschalten der Umgebungsvariablen wäre weiterhin unzulässig.

## Regression und Abschluss

Die vollständige lokale Testserie umfasste 488 Dateien und 3.397 Prüfungen: zunächst 3.282 bestanden, 33 Fehler und 82 plattform- oder umgebungsabhängig übersprungen. Alle gemeldeten Fehler wurden einzeln bearbeitet und durch gezielte Folgeläufe aufgelöst. Der Fehler in der Passwortreset-Hintergrundbehandlung wurde im Server korrigiert; die übrigen Abweichungen betrafen veraltete Versions-/Menü-/Rechteannahmen oder Testadapter für jetzt asynchrone Funktionen. Drei Rechtefälle wurden zusätzlich am Serverstand vor Block 11 reproduziert. Der Gesamtlauf wurde danach nicht nochmals vollständig wiederholt; die [Prüfchronik](block-11-regression-verification.json) hält diese Grenze und die Hashes der einzelnen Testprotokolle fest.

Block 11 ist damit abgeschlossen. Block 12 enthält die noch ausstehende produktive Aktivierung und ihre Betriebsverträge. Alle bisherigen Störungs-, Last-, Export- und Wiederherstellungsversuche liefen isoliert.
