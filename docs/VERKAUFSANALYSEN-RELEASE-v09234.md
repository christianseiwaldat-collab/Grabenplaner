# VPS-Veröffentlichung v0.92.34-beta

Datum: 10. September 2026. Status: **Installiert, vollständiger Wiederherstellungsnachweis offen**.
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

Installiert ist Commit `4ddb25d80f86f695754d1a03588b0838b15fb6b4`; der reguläre
Updater bestätigte den Abschluss am 9. September um 23:28:43 UTC. Paket-SHA-256:
`fb050a17ac530c64aac90d89c9617f79c8bf4aba6604f7e9a33736e1b698c412`.
Alle 548 installierten Manifestdateien wurden am 10. September erneut abgeglichen.

Externe Sicherung und Repository-Prüfung waren erfolgreich. Der isolierte Restore
war erfolgreich, die anschließende App-Bereitschaftsprüfung scheiterte jedoch nach
rund 90 Sekunden. Die vollständige Veröffentlichung ist deshalb nicht abschließend
bestätigt. Die dokumentierten mehrminütigen produktiven Startzeiten müssen mit
diesem Prüfzeitfenster abgeglichen werden; eine konkrete Smoke-Fehlerursache ist
noch nicht nachgewiesen.

Am 10. September wurden wiederholte Antwortaussetzer bei PDF-Aufträgen untersucht.
Die Belegpositionsabfrage wählte ohne Planungsstatistik den Primärschlüssel statt
des vorhandenen Elternindex. Die gezielte Aktualisierung der Statistik am
10. September um 07:09:14 UTC verringerte einen unveränderten, separat und nur
lesend ausgeführten 200-Positionen-Schritt von 29,525 Sekunden auf 0,883 Sekunden.
Quellinventar und Vergleichsdatensätze blieben gleich; kein Dienst- oder Hostneustart
war erforderlich. Unabhängig davon ist die bisherige Speicherung größerer
Berichts-Zwischenstände zu korrigieren. Der Indexbefund allein behebt diesen
Berichtsabbruch noch nicht.
