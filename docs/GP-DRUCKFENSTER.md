# GP-Druckfenster

Stand: 18.10.2026 · GP-Standard Druck & PDF, Fassung 8.

Neue und überarbeitete PDF-Ausgaben verwenden den gemeinsamen Baustein `public/gp-print-window.js`. Er ergänzt den Fensterstandard aus `public/gp-window.js`; es wird kein Browserfenster geöffnet.

## Bedienung

- Das Fenster lässt sich über die gesamte GP-Fläche verschieben, auch über die Sidebar. Größe an Rändern und Ecken ändern; minimiert bleiben Position und vorherige volle Größe erhalten.
- Links stehen Dateiname und fachliche Optionen. Titel und Ausrichtung sind nur einstellbar, wenn der jeweilige Renderer diese Einstellungen übernimmt. Der vorgegebene Dienstplantitel beansprucht kein Eingabefeld. Rechts erscheint die tatsächlich erzeugte PDF-Datei mit Seitenzahl, Seitenwechsel und Zoom.
- Jede PDF-Vorschau bietet Ganze Seite, Seitenbreite, 50/60/70/80/90/100/125/150/200 % und einen eigenen Wert von 10 bis 400 % (auch Dezimalwerte). Die Vergrößerung verändert nur die Anzeige; PDF-Bytes und Seitenumbrüche bleiben gleich.
- Beim Dienstplan gilt die Mitarbeiterauswahl für Wochenmatrix und klassisches Design. Alle auswählen wählt alle beim Öffnen verfügbaren Personen. Jede Auswahl wird als konkrete Nummernliste übermittelt und serverseitig auf den berechtigten Filial-/Abteilungsbereich begrenzt; später hinzugekommene Personen werden nicht unbemerkt ergänzt. Keine Auswahl sperrt die Ausgabe. Weder Aktivstatus noch Dienstplanung werden dadurch geändert.
- Die Wochenmatrix verwendet kompakte Leerabstände für sechs Personen auf einer A4-Seite. Benötigen mehrere Ereignisse oder lange Hinweise mehr Platz, wachsen Zeilen bzw. folgen weitere Seiten; Inhalte werden nicht zugunsten einer erzwungenen Einseitigkeit abgeschnitten.
- Geänderte Optionen machen die vorherige Ausgabe ungültig. Der Download verwendet exakt die erfolgreich dargestellte Datei.
- Navigation innerhalb des GP erhält eine gültige Ausgabe. Schließen räumt die Vorschau auf und führt zum jeweiligen Öffner zurück. Konto- oder Rechtewechsel verwirft die Ausgabe.
- Tastaturbedienung, schmale Fenster und reduzierte Bewegung gehören zum Standard. Fensterposition und Größe werden mit den vorhandenen kontogebundenen GP-Fenstereinstellungen gespeichert.

## Integration

`GpPrintWindow.mount` erhält die Kontobindung, Zugriffsprüfung, fachliche Optionsdarstellung und einen `createPdf`-Callback. Der Callback holt eine geschützte serverseitig erzeugte PDF-Datei und liefert `{ blob, filename, summary }` zurück. Die Shell verwaltet Abbruch, verspätete Antworten, Vorschau, Ressourcen und Download.

Die fachliche PDF-Erstellung bleibt für Rechte, Quellstand, Berechnung, vollständige bzw. sichtbar begrenzte Auswahl und Umbrüche verantwortlich. Eine Bildschirmansicht oder ein nachgeahmtes Drucklayout ersetzt die echte PDF-Vorschau nicht.

Die gemeinsame Zoomsteuerung liegt ausschließlich in `public/sales-article-report-pdf-preview.js` (Alias `GpPdfPreview`). Fachadapter erstellen keine eigenen Zoomlisten.

## Geprüfte Druckbereiche

| Bereich | Fachadapter zur gemeinsamen Vorschau |
| --- | --- |
| Dienstplan und Urlaubsplanung | `gp-planning-print.js` |
| Verkaufsanalysen | `gp-sales-analytics-print.js`, `sales-report-jobs.js` |
| Kassenberichte und Belegsuche | `gp-receipt-print.js` |
| Artikel-Auswertung und Artikelstammblatt | `sales-article-report.js`, `sales-article-tools.js` |
| BWL: ABC, Abverkaufs-Simulation, Maßnahmen | `sales-bwl-print.js`, `sales-bwl-simulation-print.js`, `sales-bwl-actions-print.js` |
| Preisschilder | `gp-price-label-pdf.js` |
| Bestellungen, Lieferungen und weitere Warenwirtschaftsausgaben | Gemeinsame Ausgabeoptionen und Druckvorschau |
| Personalnachweise, Schulungen, Leihdokumente, Assurance-Berichte | `gp-document-print.js` und explizite Fachintegration |
| USB-Erste-Schritte-Anleitung | `gp-usb-guide-print.js` mit gebundener POST-Auswahl |

Alle genannten Fachadapter führen über `GpPrintWindow` oder `GpExistingPdfWindow` zur identischen PDF.js-Vorschau. CSV-, ZIP- und Bilddownloads sind keine PDF-Druckvorschauen.

Aktuell verwenden Artikel-Auswertung, Artikelstammblatt, ABC-Analyse, Abverkaufs-Simulation und Maßnahmenliste diesen Baustein. Im Artikelstamm bleiben die Bereiche, das optionale Foto, die zuletzt gestarteten Historienfilter und die Erweiterung des Dateinamens erhalten. Eigener PDF-Titel und A4-Ausrichtung werden im serverseitig erzeugten Stammblatt umgesetzt.

Die ABC-Ausgabe verwendet einen kontogebundenen serverseitigen Auswertungsnachweis (`exportToken`). Der Browser liefert keine Finanzzeilen. Alle Ergebniszeilen, Klassenanteile und Prüfhinweise werden aus dem vollständigen geprüften Stand erzeugt; die Seitennavigation der Bildschirmtabelle begrenzt den Export nicht. Rechte und Quellstand werden auch nach der PDF-Erstellung erneut geprüft.

Die Artikel-Auswertung bietet „Auswertung“ und „Berichte“. „Bericht speichern“ legt ausdrücklich die aktuell dargestellten PDF-Bytes zusammen mit Filtern, Spalten, Titel und Ausrichtung im persönlichen Berichtskatalog ab. Ein kurzlebiger, kontogebundener Vorschau-Nachweis verbindet Anzeige und Speicherung; geänderte Optionen verlangen eine neue Vorschau. „PDF ansehen“ öffnet die unveränderte Datei im `GpExistingPdfWindow`. „Einstellungen öffnen“ berechnet mit den gespeicherten Einstellungen den aktuellen Datenstand neu; erneutes Speichern erstellt einen weiteren Bericht. Das Löschen entfernt die PDF und ihre Metadaten gemeinsam. Konto- und Rechtewechsel verwerfen geladene Listen, Einstellungen und Vorschauen; jeder Zugriff prüft die aktuellen Filial- und Spaltenrechte. Die Ablage ist auf 50 Berichte und 100 MiB pro Konto sowie 10 MiB je PDF begrenzt.

Die Simulation exportiert einen geprüften aktuellen Szenariostand oder die konkrete Version einer gespeicherten persönlichen Variante. Ein gewählter Variantenvergleich enthält seine Annahmen und Herkunft. Historische Varianten werden beim Export nicht automatisch mit neuen Preisen überschrieben. Geänderte, noch nicht berechnete Eingaben sperren den Download.

Die Maßnahmenliste exportiert alle passenden gespeicherten Maßnahmen der ausgewählten Filiale anhand der zuletzt gestarteten Suche. Offene Formulare gehören nicht zur Ausgabe. Versionen und vollständiger Inhalt werden vor und nach dem Rendern erneut geprüft; eine zwischenzeitliche Teamänderung verlangt eine neue Vorschau. Persönliche Verantwortliche erscheinen im PDF mit ihrer Personalnummer. Lange Ergebnisnotizen werden vollständig über Fortsetzungsseiten ausgegeben.

Fachliche Schutzgrenzen: ABC höchstens 5.000 Ergebnisgruppen, Simulation höchstens 10.000 Artikel-Filial-Zeilen, Maßnahmen höchstens 500 gespeicherte Einträge je Filiale. Schutzgrenzen und unvollständige Datengrundlagen bleiben sichtbar. Die Druckshell erhöht diese Grenzen nicht.
