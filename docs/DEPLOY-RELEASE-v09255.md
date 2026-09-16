# v0.92.55 Beta · Importübersicht und Bestellkonfiguration

## Änderung

Die Importübersicht zeigt Originaldateiname, Status und den letzten
Bearbeitungsstand im GP. Der Kassenstand erhält eine gemeinsame Filialzuordnung
mit vorhandenen Standorten, geprüften bisherigen Bindungen und eindeutigen
Vorschlägen. Die [Bedienung](IMPORT-BEDIENUNG-2026-09-16.md) beschreibt die
Datumsbedeutung und die gemeinsame Prüfung und Aktivierung.

Beim Speichern der Filialbestellkonfiguration wartete der PostgreSQL-Zweig
nicht auf drei asynchrone ID-Abfragen. Der produktiv bestätigte Fehler
`existingIds.has is not a function` wird durch die fehlenden `await`-Aufrufe
behoben. Neue Einheiten, Positionen und Gruppen lassen sich dadurch gemeinsam
speichern. Historische Bestellungen und die Transaktion bleiben erhalten.

Die beiden zusätzlichen Kassa-Vorbereitungsbuttons in Prozessvorlagen und
Fähigkeitskatalog entfallen. Vorhandene Inhalte bleiben erhalten. Es gibt
keine neue Migration und keine zusätzliche Abhängigkeit.

## Freigabeprüfung

Der abschließende gemeinsame Lauf mit Node 22.22.1 bestand mit 185 erfolgreichen
Prüfungen, keinem Fehler und drei unter Windows übersprungenen Linux-Prüfungen.
Er umfasst Importe, gemeinsame Kassenfreigabe, Filialbestellung, Schulungs-UI,
Import-Lebenszyklus, Versionskonsistenz und Paketverträge. Der neue
Bestellkonfigurationstest lief auch nativ gegen PostgreSQL 18.6; geprüft wurden
wiederholtes Speichern, erhaltene historische Bestellungen und vollständige
Rücknahme bei einem Schreibfehler. Die Testdatenbank wurde anschließend beendet.

Die Oberfläche wurde zuvor mit synthetischen Daten im Browser geprüft. Der neue
Test ist im Persistenzinventar eingeordnet; die zwei bekannten historischen
Katalogfehler bleiben gesondert dokumentiert.

Der breite Teststand von v54 enthält dokumentierte Altfehler; ein vollständig
grüner Gesamtlauf wird nicht behauptet. Die etwa 30 Minuten pro vollständiger
Quelldatenbank auf dem VPS bleiben gesondert zu messen.

## Veröffentlichung

Vorbereitet und zum Deploy freigegeben. Installation und Abschlussprüfung
stehen noch aus.
