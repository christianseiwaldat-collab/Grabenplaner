# Prüfstand für den gemeinsamen Quellstand

Stand: 18.09.2026. Zusammenführung der seit `f1a40c2` lokal bearbeiteten
Änderungen für `main`. Ein VPS-Deploy ist nicht Bestandteil dieses Schritts.

## Enthaltene Arbeiten

- Dienstplan- und Urlaubsplaner-Geschwindigkeit, gebündelte PostgreSQL-Lesezugriffe,
  reduzierte Hintergrundabfragen, RAM-Anzeige und Wiederherstellungstest-Zeitlimit.
- Persönliche PDF-Auswahl und umschaltbare Dashboard-Kennzahlen mit `€/Kunde`.
- Xoffi-MHTML-Import, getrennte Quellenstände für Zeitkonto und Urlaub,
  Einsatzanfragen bis sechs Monate voraus sowie die Tagesfrist vor Ladenschluss.
- Artikelstamm mit zweispaltiger Arbeitsfläche, Preisübersicht, Filialbeständen,
  ergänzten Verknüpfungen und Bestellnummernsuche.

Die Einzelheiten und bereits erfolgten Browserprüfungen stehen in
[Dienstplanung](PERFORMANCE-WOCHENWECHSEL-2026-09-17.md),
[Urlaubsplaner und Analysen](URLAUB-UND-PDF-AUSWAHL-2026-09-17.md),
[Xoffi und Filialeinsatz](XOFFI-MHTML-UND-FILIALEINSATZ-2026-09-17.md) und
[Artikelstamm](ARTIKELSTAMM-ANSICHT-2026-09-17.md).

## Gemeinsame Abschlussprüfung

- 265 Tests in 33 betroffenen Funktions- und Persistenzdateien ausgeführt:
  262 bestanden, drei fehlgeschlagen, keiner übersprungen.
- Die drei Fehler betreffen die bekannten historischen Architekturprüfungen:
  zwei Vergleiche der aktuellen Statement-Anzahl mit dem historischen
  Block-4-Katalog (`1405` gegenüber `1354`) und den darauf aufbauenden allgemeinen
  Provider-Audit. Die zugrunde liegenden Altbefunde sind bereits in
  [v0.92.56](DEPLOY-RELEASE-v09256.md) dokumentiert. Die Prüfungen bleiben aktiv;
  der Gesamtprüfstand ist deshalb nicht vollständig grün.
- Drei native PostgreSQL-Integrationstests bestanden: Dienstplan/Urlaub mit
  frischen Rechten und Änderungen, Xoffi-Migration und Import sowie Artikel-
  und Bestellnummernsuche, Bestände und Preisrechte. Die lokale Testinstanz
  wurde anschließend wieder gestoppt.
- JavaScript-Syntax und Git-Whitespace-Prüfung bestanden.

Lokale Protokolle: `tmp/commit-main-regressions-20260918.log` und
`tmp/commit-main-postgresql-20260918.log`. Temporäre Datenbanken, Protokolle,
Vorschauartefakte und Betriebsberichte gehören nicht zum Quellstand.

## Nächster Release

Die zusätzliche Xoffi-Core-Migration muss beim nächsten beauftragten VPS-Deploy
gemäß der Xoffi-Dokumentation im geschützten Release-Ablauf ausgeführt werden.
Der Push nach `main` startet die vorhandenen GitHub-Prüfungen; der geprüfte
Workflow enthält keinen automatischen VPS-Deploy.
