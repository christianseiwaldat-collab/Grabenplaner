# v0.92.56 Beta · Datenbankimporte und integrierter Einkaufsbereich

## Änderung

Der Datenbankimport erhält kompakte Uploadfelder und eine Tabelle mit
Originaldateiname und fachlichem Datenstand. Der normale Trade-Import übernimmt
auch den Artikelkatalog in wiederaufnehmbaren Paketen. Die neue Löschaktion
entfernt ausschließlich gespeicherte Access-Dateikopien; GP-Daten, Importstände
und Protokolle bleiben erhalten.

Einkauf & Bestand ist als reguläre GP-Ansicht mit Hauptmenü, Verkaufsübersicht,
Funktionssuche, gemeinsamem Darkmode und Browsernavigation eingebunden. Die
bisherigen Direktlinks führen zur passenden integrierten Auswertung.

Es gibt keine neue Migration und keine zusätzliche Abhängigkeit.
Details und bisherige Prüfnachweise:

- [Importumbau](IMPORT-NEUAUFBAU-2026-09-16.md)
- [GP-Integration](EINKAUF-GP-INTEGRATION-2026-09-16.md)

Die vollständige Importdauer auf dem VPS ist weiterhin nicht nachgewiesen. Der
auf Nutzerwunsch abgebrochene Laufzeittest wird für diesen Deploy nicht erneut
gestartet.

## Freigabe und Veröffentlichung

Commit, Push und VPS-Deploy sind am 16.09.2026 ausdrücklich beauftragt.
Releaseprüfung und Veröffentlichung laufen; dieser Abschnitt ist bis zum
abschließenden Updatebeleg kein Nachweis einer erfolgreichen Installation.

## Lokale Releaseprüfung

- Abschließende Prüfung von Version, Paketierung, Navigation, Rechten,
  Einkaufsansicht und Importlaufzeitcode: 107 bestanden, kein Fehler.
  Drei unveränderte Linux-Installer-Tests sind unter Windows übersprungen.
- Die zusätzlichen Import-, PostgreSQL- und Browsernachweise sind in den
  oben verlinkten Fachberichten dokumentiert.
- Die Persistenzprüfung enthält ausschließlich die beiden bereits für
  v0.92.55 dokumentierten Altbefunde; keine neue Grenzverletzung und keine
  unbekannte Produktions- oder Testdatei.
- Der Live-Vorcheck bestätigt v0.92.55, vier erfolgreiche interne/öffentliche
  Bereitschaftsprüfungen und den abgeschlossenen Zustand der Bestell- und
  Kassenimporte. Diese Importstände bleiben erhalten.
