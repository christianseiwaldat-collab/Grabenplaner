# Verkaufsberichte und Kassenklärung – v0.92.36 Beta

## Umfang

Das gemeinsame Release enthält den bisher nicht installierten Hotfix aus
v0.92.35 sowie die anschließenden Berichtserweiterungen, Kassenklärungen,
Beleganordnung und Browsernavigation. Grundlage sind die
[Auswahl- und Navigationsbeschreibung](VERKAUFSANALYSEN-AUSWAHL-UND-NAVIGATION-2026-09-10.md),
die [geprüften Kassenregeln](VERKAUFSBERICHTE-GEPRUEFTE-TEILWERTE.md) und der
[Störungsnachweis](GP-STOERUNG-2026-09-10.md).

Die Berichtserstellung läuft in begrenzten Hintergrund-Workern mit separater
lesender Datenbankverbindung. Verschlüsselte Zwischenstände werden aufgeteilt;
Rechteentzug, Abbruch, Wiederanlauf und Quellenbindung bleiben geprüft.
Neue Filter, Hoch-/Querformat, Diagramme und gekennzeichnete Teilwerte ergänzen
die PDF-Berichte. Die historischen Kassenwerte werden entsprechend den
bestätigten Fachregeln ausgewertet, einschließlich signierter Roherträge,
Gutscheine, UID-Zwischenbuchungen und Gebrauchtware mit gespeichertem Steuersatz 0.

Bereits gespeicherte PDF-Dateien bleiben unverändert. Für die neuen Regeln
sind neue Berichtsaufträge erforderlich. Alte, an einen anderen Regelstand
gebundene Aufträge dürfen nicht mit geänderten Regeln fortgesetzt werden.

## Prüfung vor der Bereitstellung

Die gezielte Releaseauswahl umfasst 658 Prüfungen für Kassa, TradeFoto,
Berichts-Worker, Verschlüsselung, Rechte, PDF-Inhalte und -Grenzen, Artikelstamm,
Navigation, angrenzende Oberflächen, Providerverträge und Paket-/Versionsstand.
Nach Anpassung der veralteten Versionsvergleiche bestehen 649 Prüfungen;
neun Linux- und PostgreSQL-Prüfungen ohne passende lokale Laufzeit bleiben als
übersprungen ausgewiesen. Der Persistenzaudit weist keine unklassifizierten
Dateien oder Phasengrenzverletzungen aus.

Vor der Bereitstellung wurde außerdem ein abgebrochener nächtlicher
Archivabschluss festgestellt. Die Wiederaufnahme verwendet die vorhandene
Archivverwaltung mit Prüfung des beendeten Sperrbesitzers und signierter
Vorgangshistorie; Sicherungspunkte werden durch diese Abstimmung nicht gelöscht.
Das Update bleibt vom erfolgreichen Abschluss der Sicherungsprüfungen abhängig.

## Bereitstellungsstatus

v0.92.36-beta wurde am 11.09.2026 installiert. Der reguläre Updater bestätigte
den Versionswechsel um 18:54:41 UTC. Nach den Funktionsprüfungen wurde die
Berichtspause um 20:39:22 UTC unter der Wartungssperre aufgehoben. Die
Berichterstellung ist damit wieder nutzbar. Bestehende PDF-Dateien und
fehlgeschlagene Originalaufträge wurden nicht verändert oder erneut gestartet.

- Quellcommit: `2df6dfe94d42c6e54829d84a7a6b1ce4769663c2`.
- Paket: `Grabenplaner-Server-v0.92.36-beta-linux-x64.zip`, 3.719.647 Bytes.
- SHA-256: `2a8067abdab03e5cfff4b0a21e66fa5d48327e89af418929c3b92658be96b0f9`.
- Alle 555 installierten Paketdateien und 14 öffentlich ausgelieferte
  Oberflächendateien wurden gegen ihre Hashes geprüft.
- `grabenplaner-test` und `grabenplaner-offsite-test` endeten beide mit Exit 0.
- Interne und öffentliche Live-/Ready-Endpunkte antworteten mit HTTP 200;
  unangemeldete Zugriffe auf die geprüften geschützten APIs mit HTTP 401.
- Der reguläre automatische Monitor schloss am 11.09.2026 um 20:43:51 UTC
  mit allen 24 Prüfungen erfolgreich ab: vollständiger Status `ok`, kein
  aktueller Fehler und kein automatischer Neustartversuch.
- Die aktuelle Datenbank bestand `integrity_check` und `foreign_key_check`
  ohne Befund. Die geprüften Geschäftsbestände, Quelleninventare, Rechte- und
  Importschemata blieben unverändert. Es gab keinen Quelldatenimport und
  keinen vollständigen Ubuntu-Neustart.

Die abschließende Betriebskontrolle um 20:44:29 UTC bestätigte die aktiven
Dienste, freigegebene Berichte und unveränderte Host-Boot-ID. Es kamen keine
fehlgeschlagenen Systemdienste hinzu. Beide geprüften Uploadverzeichnisse
wurden nach der Bereitstellung gezielt entfernt.

## Nachweis der Berichtsfunktion

Zwei Originalabfragen wurden mit unveränderter Berechtigungsprojektion und
frischer Quellenbindung über den tatsächlich installierten Worker ausgeführt.
Beide verwendeten nur lesende Datenbankverbindungen. PDFs wurden vollständig
ausgelesen und die geschützte Speicherung durch Ver- und Entschlüsselung im
Arbeitsspeicher geprüft; es entstanden keine zusätzlichen Produktivaufträge.

| Probe | Verarbeitete Positionen | PDF-Seiten | Dauer einschließlich PDF-Prüfung |
| --- | --- | --- | --- |
| Früher abgebrochener großer Bericht | 18.954 | 203 | 107,149 s |
| Herstellerbericht mit bestätigten Kassenregeln | 18.954 | 31 | 71,775 s |

Alle 40 begleitenden Bereitschaftsproben waren HTTP 200; die längste benötigte
686 ms. Die bestätigten Herstellerumsätze und Roherträge waren im zweiten PDF
enthalten. Die ursprünglichen Aufträge und das Quelleninventar blieben
unverändert. Eine erste Prüfprobe scheiterte ausschließlich beim Aufräumen
des PDF.js-Prüfobjekts; nach Korrektur dieser lokalen Probe bestanden beide
vollständigen Nachweise ohne Änderung des installierten Codes.

## Getrennt offener Betriebsnachweis

Der neue Sicherungspunkt, das vollständige externe Archiv und die isolierte
Datenwiederherstellung wurden erfolgreich geprüft. Der anschließende isolierte
Anwendungsstart scheiterte jedoch erneut am bestehenden 90-Sekunden-Limit.
Die signierte Historie belegt denselben Fehler bereits unter v0.92.34.
Der vollständige Recovery-Assurance-Lauf ist deshalb weiterhin als fehlgeschlagen
ausgewiesen; weder Historie noch Prüflimits wurden verändert.

Die Berichtsfunktion wurde nach den bestandenen Betriebs-, Daten- und konkreten
Worker-/PDF-Prüfungen freigegeben. Der offene Recovery-Startnachweis wird dadurch
nicht als bestanden gewertet. Der automatische Monitor hatte während der
umfangreichen Kontrollen mehrfach sein Vier-Minuten-Limit erreicht; der letzte
reguläre Lauf bestand anschließend in 3 Minuten 42 Sekunden ohne Änderung der
Prüfungen oder Zeitlimits. Die langen Prüf- und Startzeiten sowie die doppelte
Shutdown-Sicherung werden im freigegebenen
[Konzept für kürzere Deploys und Nachtprüfungen](DEPLOY-ZEITEN-UND-NACHTPRUEFUNGEN.md)
gesondert weiterbearbeitet. Der installierte Wartungsablauf ist noch unverändert.
