# VPS-Veröffentlichung v0.92.34-beta

Datum: 10. September 2026. Status: **Release lokal geprüft, Bereitstellung läuft**.
Die Veröffentlichung ist erst nach Updater-, Wiederherstellungs- und
Betriebsnachweis abgeschlossen.

## Umfang

Verkaufsanalysen liefern persönliche PDF-Berichte aus den bestätigten Kassenständen,
mit Mehrfachfiltern, Hersteller-/Warengruppenvergleich, Kennzahlenauswahl und
bearbeitbarem Vorjahreszeitraum. Die bestehende Warteschlange erzeugt die PDFs im
Hintergrund. Der historische Rohertrag wird aus Stückrohertrag und verkaufter Menge
der Kassenposition berechnet; das bestätigte Beispiel ergibt 16,28 EUR.

Der Artikelstamm verwendet kompakte Register, Preiskarten und eine Suche im Kopf.
Ergebnisspalten sind wählbar, anordenbar und über alle Treffer sortierbar. Die
Listenhöhe lässt sich von fünf bis zwanzig sichtbaren Zeilen anpassen. Eigene
Artikelbilder aus lokalen Dateien oder direkten HTTPS-Adressen bleiben unabhängig
von Trade-Updates über die Artikelnummer gespeichert. Vorhandene Produktlinks
werden angezeigt. Automatische Geizhals-Bilder bleiben ausgenommen.

Es gibt eine additive Bildtabelle und zusätzliche Preiswerte in der Suchprojektion.
Quellimporte, Berechtigungsänderungen, die vorgeschlagene Trennung in `handel.db`
und ein vollständiger Ubuntu-Neustart gehören nicht zu dieser Veröffentlichung.

Funktions- und Prüfnachweise:
[Blöcke 1–6](verkaufsanalysen-artikelstamm-bloecke-1-6-2026-09-09.md),
[Blöcke 7–8](verkaufsanalysen-artikelstamm-bloecke-7-8-2026-09-09.md).

## Lokale Release-Prüfung

216 Tests bestanden, keine Fehler und keine übersprungenen Prüfungen. Enthalten
sind Kassenveröffentlichung, Berichtswarteschlange, PDF-Ausgabe, bestätigte
Rohertragsrechnung, Artikel-/Bildrechte, Importbeständigkeit, URL-Schutz,
Migrationshandler, Recovery-Kompatibilität und Release-/Paketverträge.
Vorangegangene lokale Browser-, Langtabellen- und Persistenzprüfungen sind in den
Blocknachweisen dokumentiert. Es handelt sich um synthetische Funktionsprüfungen,
nicht um neue Produktions-Laufzeitmessungen.

## Vorprüfung des VPS

Die lesende Vorprüfung wurde am 9. September um 22:29:52 UTC abgeschlossen
(10. September, 00:29:52 Uhr in Wien). Bestätigt wurden der erwartete
Ausgangsstand v0.92.33 / `ed9fe81`, alle 534 installierten Manifestdateien,
aktive Dienste, vier interne/öffentliche HTTP-200-Antworten, SQLite-Integrität
`ok`, keine Fremdschlüsselfehler sowie geschlossene Archivvorgänge und Offsite
ohne offene Fehler.

Die Vergleichsbasis enthält 19.024 Artikel, 30.503 Kundenkarten, eine aktivierte
Kassenquelle und 11.059 Kassenverknüpfungen. Die bestehenden fachlichen Bestände,
Leihfreigaben und Mail-Ereignisse werden nach dem Update erneut verglichen.
Historisch fehlgeschlagene Units bleiben erhalten; der zwischenzeitliche
Monitorstatus wird nach den Wartungsarbeiten anhand eines tatsächlichen
vollständigen Laufs bewertet.

Paket-, Updater-, Assurance- und Schlussnachweise werden nach erfolgreichem
Abschluss hier ergänzt.
