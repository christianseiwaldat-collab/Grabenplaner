# Datenbankimporte: Dateiauswahl und gemeinsame Filialzuordnung

Stand: 16.09.2026. Bestandteil von v0.92.55 Beta. Den verifizierten
Veröffentlichungsstand dokumentiert der [Releasebericht](DEPLOY-RELEASE-v09255.md).

## Bedienung

Der Kassenimport liest bereits die ganze Datei einschließlich aller Filialen
und Zeiträume ein. Filialzuordnungen bestimmen die reguläre Standortauswertung;
sie sind keine Auswahl der zu importierenden Datensätze.

1. Unter Einstellungen → System → Datenbankimporte den Dateinamen in der
   Übersicht auswählen. Eine bereits vollständig gelesene Datei nicht erneut
   hochladen.
2. „Kassenstand für Auswertungen auswählen“ öffnen.
3. Die gemeinsame Filialtabelle prüfen. Gültige Zuordnungen des aktiven
   Kassenstands werden wiederverwendet. Eindeutige gleiche Filialnummern werden
   vorgeschlagen; abweichende Schreibweisen mit führenden Nullen nur bei
   eindeutigen Quell- und Zielnummern. Offene Fälle bleiben sichtbar.
4. „Gesamten Kassenstand prüfen“, danach „Gesamten Kassenstand aktivieren“.
   Alle gewählten Zuordnungen werden gemeinsam geprüft und aktiviert.

Filialnummern stammen aus dem geprüften Kassenstand. Als GP-Standort lassen sich
nur vorhandene Ziele auswählen. Inaktive Ziele verlangen weiterhin eine
ausdrückliche historische Zuordnung. Die Serverprüfung verwirft manipulierte,
fehlende oder inzwischen veränderte Ziele. Nach einer Eingabeänderung ist eine
neue Prüfung nötig. Ohne GP-Zuordnung bleiben die Quelldaten vollständig erhalten.
Gültige bisherige Verkäufer- und Kundenbindungen werden ebenfalls vorgeschlagen,
soweit die aktuelle Person diese verwalten darf. Artikelbindungen werden wie
bisher anhand des bestätigten Artikelkatalogs aufgelöst.

## Dateitabelle

Spalten: Originaldatei | Status | Letzte Aktualisierung. Datum und Uhrzeit rechts
zeigen den letzten Bearbeitungsstand im GP, nicht das letzte Umsatzdatum oder
das Änderungsdatum der Access-Datei. Die ausgewählte Zeile ist hervorgehoben.
Die Auswahl einer älteren Datei behält die Seite der Übersicht bei.

Neue Uploads speichern den ursprünglichen Dateinamen als verschlüsselte
Anzeigemetadaten. Nur der Dateiname ohne Verzeichnispfad wird übernommen; er
wird nicht als Speicherpfad verwendet. Derselbe Dateiinhalt behält seine
bisherige Importidentität und seinen Fortschritt. Alte Datensätze ohne
Originalnamen zeigen den bekannten Standarddateinamen mit entsprechendem
Hinweis. Keine Schemaänderung und keine neue Abhängigkeit.

## Prüfung

- 118 gezielte Tests in Import-Routen, Import-Runtime, Hintergrundjobs,
  Kassenpublikation und PostgreSQL-Batch-Katalog bestanden.
- Anschließende gezielte Wiederprüfung einschließlich neuer Pagination:
  Dateiauswahl bleibt auf ihrer Seite; ungültige IDs werden abgelehnt;
  mehrdeutige und inaktive Zuordnungen werden nicht automatisch übernommen.
- PostgreSQL-Repositoryzweig zusätzlich mit transaktionalem Testadapter geprüft;
  keine neue native PostgreSQL- oder VPS-Prüfung in diesem lokalen Arbeitsblock.
- Browserprüfung mit synthetischen Daten: Dateitabelle, Auswahlmarkierung,
  gemeinsame Filialprüfung, erneute Prüfsperre nach Änderungen sowie helle und
  dunkle Darstellung. Keine produktiven Daten verwendet oder verändert.
- Testprotokolle: `tmp/import-overview-tests.log` und
  `tmp/import-overview-final-checks.log`.
