# Einkauf & Bestand innerhalb des Grabenplaners

Umsetzung vom 16.09.2026, mit v0.92.56-beta veröffentlicht.
Der [Releasebericht](DEPLOY-RELEASE-v09256.md) enthält Commit, Paket- und VPS-Nachweise.

## Verhalten

- Die bisher eigenständige Seite ist eine reguläre Ansicht des GP. Das Hauptmenü,
  die Verkaufsübersicht, die Funktionssuche und das mobile Menü führen dorthin.
- Alle sieben Auswertungen bleiben verfügbar. Die gemeinsame Browsernavigation
  merkt sich den Bereich, beispielsweise `/?view=tradeInsights&section=purchasing`.
- Alte Links auf `trade-insights.html?tab=…` werden auf die passende GP-Ansicht
  weitergeleitet. Unbekannte Werte führen zum Standardbereich; fehlende Rechte
  führen zu einem freigegebenen Tab beziehungsweise zurück zum Startdashboard.
- Filter und Ergebnisse bleiben beim Wechsel zu einer anderen GP-Ansicht erhalten.
  Laufende Anfragen werden angehalten. Abmeldung und Rechtewechsel entfernen die
  zugehörige Oberfläche; verspätete Antworten werden verworfen.
- Die Darstellung nutzt die GP-Farben einschließlich gespeichertem Darkmode.
  Tabellen scrollen innerhalb des Inhalts; mobile Formulare stehen untereinander.
- Bestehende serverseitige Rechte, Filialgrenzen, CSRF- und Revisionsprüfungen
  gelten weiterhin für Auswertungen, Artikelklassifikation und Reparaturstatus.

## Nachweise

Node 22.22.1, ausschließlich kleine synthetische Fixtures:

- 37/37: Navigation, Funktionskatalog, Suchnavigation, Trade-API und Weiterleitung.
- 5/5: Lebenszyklus der Ansicht, verspätete Antworten, Rechte und Deep Links.
- 12/12: Darstellungseinstellungen, Trade-Fachlogik und API.
- Abschließend 20/20: Lebenszyklus und Navigation nach der Korrektur für
  unberechtigte Tab-Links. Diese Gruppen überschneiden sich.
- 21/21: erneute Import-HTTP-/UI-Regression nach Einbindung ins gemeinsame HTML.
- Syntaxprüfung und `git diff --check` erfolgreich.

Chrome gegen einen eigenen lokalen Server mit temporärer SQLite-Testdatenbank:
alter Direktlink, Hauptmenü, Verkaufsübersicht, Funktionssuche, Browser-Zurück,
Einkaufssuche mit 65 Testpositionen sowie Öffnen und Speichern eines synthetischen
Reparaturstatus erfolgreich. Desktopdarstellung hell/dunkel visuell geprüft.
Mobiles Menü, einspaltige Formulare, mindestens 44 CSS-Pixel hohe Bedienelemente
und fehlender horizontaler Seitenüberlauf per Browser-DOM geprüft. Die mobile
Screenshot-Aufnahme meldete Zeitüberschreitungen; sie ist kein visueller Nachweis.
Temporäre Browsergröße zurückgesetzt; Testserver und Testdaten anschließend beendet
beziehungsweise bereinigt.

## Gemeinsamer Stand mit dem Importumbau

Die Importänderungen und ihre Prüfungen sind in
[IMPORT-NEUAUFBAU-2026-09-16.md](IMPORT-NEUAUFBAU-2026-09-16.md) beschrieben.
Die Löschaktion entfernt ausschließlich die gespeicherte Access-Dateikopie.
GP-Daten, Importstände und Protokolle werden dadurch nicht gelöscht.

Der vollständige Import-Laufzeittest wurde auf Nutzerwunsch abgebrochen und nicht
wiederholt. Die Umsetzung ist funktional geprüft; 30–45 Minuten Gesamtlaufzeit
auf dem VPS sind damit weiterhin nicht nachgewiesen. Versionsvergabe, Paketbau
und die normalen VPS-Releaseprüfungen sind im Releasebericht abgeschlossen dokumentiert.
