# Artikel- und Belegsuche für Filialkonten

Stand: 14.09.2026. Lokal integriert und geprüft; noch nicht veröffentlicht.

## Bedienung

Unter **Einstellungen → Zugänge → Filial- & Terminalkonten** das Filialkonto
bearbeiten. Zwei unabhängige Schalter stehen zur Verfügung:

- **Artikelsuche verwenden:** Artikelnummer, Bezeichnung und EAN/GTIN im
  gemeinsamen Artikelstamm suchen; VK brutto und Internetpreis anzeigen.
- **Belegsuche und PDF-Download verwenden:** Belege der zugewiesenen Filiale
  nach Zeitraum, Belegnummer/Rechnungsreferenz und Artikeltext suchen,
  Positionen ansehen und eine PDF-Beleginformation herunterladen.

Beide Freigaben sind bei neuen und bisher nicht freigeschalteten Konten aus.
Sie lassen sich einzeln aktivieren und entfernen. Nach einer Kontoänderung
werden bestehende Sitzungen widerrufen; das Filialkonto muss sich neu anmelden.
Es werden keine produktiven Konten automatisch verändert.

## Kontotypen

Filialkonten sind gemeinsame Standortzugänge. Dienstplan, standortbezogene
Urlaubsübersicht, Leihübersicht und Schulungsdashboard gehören zum bestehenden
Funktionsumfang. Filialbestellungen und beide Suchen sind optional.
Terminalkonten bieten einzeln wählbare Dienstplan- und Leihansichten.
Beide Kontotypen haben keinen Mitarbeiterdatensatz und keine persönliche
Zeiterfassung, Personalakte oder Mitarbeiteranträge.

Beim Wechsel auf Terminal entfernt die Oberfläche jetzt auch das zuvor
stehengebliebene Schulungsrecht und blendet die Filialfunktionen aus.

## Integration und Zugriffsgrenzen

Die Grundvorbereitung lag bisher ausschließlich im separaten Checkout
`Grabenplaner-filialkonto-za-20260913`. Übernommen wurden gezielt die beiden
Suchfunktionen aus dem archivierten Übergabestand. ZA-Vorbereitungen und
weitergehende Artikel-/EK-/Kundensuche dieses Checkouts wurden nicht übernommen.
Der separate Checkout blieb unverändert.

Neue optionale Organisationsrechte: `branch_articles:read` und
`branch_receipts:read`. Sie sind nur für Filialkonten zulässig. Eigene Routen
unter `/api/portal/v1/branch-articles` und `/api/portal/v1/branch-receipts`
prüfen Anmeldung, Kontotyp, genau eine aktive Filialzuordnung, das einzelne
Suchrecht und bei POST zusätzlich CSRF. Identität und Rechte werden vor und
nach asynchronem Lesen erneut geprüft. Eine vom Browser übermittelte andere
Filiale oder Rechteprojektion wird nicht akzeptiert.

Die Artikelausgabe beschränkt sich auf Artikelnummer, Beschreibung, EAN, Status
und Verkaufspreise. Die Belegausgabe enthält keine Kunden- oder Personaldaten,
keine EK-Werte und keinen Rohertrag. Fremde Beleg-IDs werden abgewiesen.
Persönliche Verkaufsanalyse-/Import-/CRM-Routen bleiben getrennt geschützt.

Unter PostgreSQL laufen Such- und Belegleseoperationen über die vorhandenen
drei Belegworker mit begrenzter Warteschlange, Speichergrenzen und Timeout.
Es entstehen keine zusätzlichen produktiven Worker oder Datenbankpools.
Der interne Auftrag enthält ausschließlich die serverseitig geprüfte
Filialidentität und ist an den veröffentlichten Kassenstand gebunden.
Die erneute Sitzungsprüfung vor Auslieferung verhindert Ergebnisse nach
Rechteentzug. Ein Beleg-PDF nutzt den bestehenden PDF-Renderer und dessen
Positionsgrenze. Daten werden nur gelesen; keine neue Schemamigration nötig.

## Prüfungen

- 25 Tests der beiden Suchen: Kontoeinstellungen, sämtliche Schalterkombinationen,
  HTTP-Freigaben, CSRF, fremde Beleg-IDs, Konto-/Filialwechsel, Rechteentzug,
  Paging, maskierte Texte, verspätete Antworten, PDF sowie echte Hintergrundleser
  über separate lokale SQLite-Verbindungen.
- 102 bestehende Tests für Organisationskonten, Kassenberichte/Belege,
  Berichtsverarbeitung, Navigation und Portal erfolgreich.
- Abschließende kombinierte Suche-/Worker-/PostgreSQL-Vertragsprüfung:
  31 bestanden, fünf explizite Live-PostgreSQL-Tests ohne erreichbare
  Entwicklungs-Testdatenbank übersprungen. Dazu gehört der neue Test
  `test/postgresql-branch-sales.test.js`; echte PostgreSQL-/VPS-Abnahme steht aus.
- Zwölf Abläufe im lokalen Chrome mit synthetischen Daten und echten APIs:
  Konto anlegen/bearbeiten, Terminalwechsel, EAN-Suche, Verkaufspreise,
  Filialbelegsuche, Details, echter PDF-Download, Zurück/Vorwärts,
  390-px-Handyansicht, Fremdbeleg-Abweisung, keine JavaScript-Seitenfehler.
  Screenshots wurden visuell geprüft; lange Beschreibungen werden umgebrochen.
- Persistenzaudit, JavaScript-Syntax und `git diff --check` erfolgreich.

Browsernachweis:
`tmp/branch-search-browser-1789337406412/result.json` mit Screenshots und
synthetischer `Beleginformation.pdf` im selben Verzeichnis. Keine produktiven
Daten oder Zugangsdaten in den Prüfarbeitsständen.

Die vorhandenen Änderungen für MA 419, getrennte WGR-/Sortimentsfilter,
Berichtsvorlagen und Grafiken bleiben erhalten. Kein Commit, Push oder Deploy
in diesem Arbeitsschritt. Beim nächsten beauftragten Deploy gemeinsam prüfen
und veröffentlichen; anschließend mindestens eine Filialfreigabe sowie
Suche, Beleg-PDF und Rechteentzug gegen die PostgreSQL-Laufzeit abnehmen.
