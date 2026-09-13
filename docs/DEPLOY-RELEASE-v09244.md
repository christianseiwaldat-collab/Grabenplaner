# Release v0.92.44-beta

## Freigabe und Umfang

Am 14.09.2026 ausdrücklich gemeinsam zur Veröffentlichung beauftragt:

- Getrennte WGR-/Sortimentsfilter, persönliche gespeicherte Berichtsvorlagen
  und der neue Bereich Grafiken mit PDF-Zeitverlauf.
- Korrekte Behandlung der zwei bestätigten Nettobelegköpfe für MA 419
  vom 24. und 26.08.2026. Vorhandene PDFs bleiben erhalten; neue Berichte
  verwenden Regelversion 10.
- Unabhängige Artikel- und Belegsuchfreigaben in den Filialkontoeinstellungen
  einschließlich eigener Portalansichten und PDF-Beleginformation.
  PostgreSQL-Belegabfragen verwenden den vorhandenen begrenzten Workerpool.

Keine neue Datenbankschemamigration oder erneute ACCDB-Datenübernahme.
Die beiden PostgreSQL-Datenbanken und die Aufbewahrung von zwei vollständigen
Sicherungspaaren bleiben bestehen. Keine produktiven Konten werden automatisch
freigeschaltet. Das separate weitergehende Filialkonto-/ZA-Prototyppaket ist
nicht Teil dieses Releases.

## Nachweise vor der Bereitstellung

Die vorherigen lokalen Funktions-, Browser- und PDF-Prüfungen sind dokumentiert:

- [Verkaufsanalysen, Vorlagen und Grafiken](VERKAUFSANALYSEN-VORLAGEN-GRAFIKEN-2026-09-13.md)
- [Filialkonto-Suchfreigaben](FILIALKONTO-SUCHFREIGABEN-2026-09-14.md)
- [Bestätigte Kassenregeln](VERKAUFSBERICHTE-GEPRUEFTE-TEILWERTE.md)

Aktuelle lesende VPS-Vorprüfung: v0.92.43-beta, Source `0547dd4`, alle
648 Manifestdateien unverändert, vier interne/öffentliche Live-/Ready-Aufrufe
HTTP 200, PostgreSQL maßgeblich, Offsite-Status ohne offene Fehler,
88,72 GB frei. Eigene und fremde Dienst-IDs sowie Bootkennung sind als
Vergleichsbasis gespeichert. Es läuft kein konkurrierender Wartungsauftrag.

Neue Releaseprüfungen und Veröffentlichungsergebnis werden nach Abschluss
ergänzt. Lokale Nachweise liegen unter `tmp/v09244-*`.
