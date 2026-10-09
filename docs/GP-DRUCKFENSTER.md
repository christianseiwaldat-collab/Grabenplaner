# GP-Druckfenster

Neue und überarbeitete PDF-Ausgaben verwenden den gemeinsamen Baustein `public/gp-print-window.js`. Er ergänzt den Fensterstandard aus `public/gp-window.js`; es wird kein Browserfenster geöffnet.

## Bedienung

- Das Fenster lässt sich über die gesamte GP-Fläche verschieben, auch über die Sidebar. Größe an Rändern und Ecken ändern; minimiert bleiben Position und vorherige volle Größe erhalten.
- Links stehen PDF-Titel, Dateiname, Hoch-/Querformat und die fachlichen Optionen. Rechts erscheint die tatsächlich erzeugte PDF-Datei mit Seitenzahl, Seitenwechsel und Zoom.
- Geänderte Optionen machen die vorherige Ausgabe ungültig. Der Download verwendet exakt die erfolgreich dargestellte Datei.
- Navigation innerhalb des GP erhält eine gültige Ausgabe. Schließen räumt die Vorschau auf und führt zum jeweiligen Öffner zurück. Konto- oder Rechtewechsel verwirft die Ausgabe.
- Tastaturbedienung, schmale Fenster und reduzierte Bewegung gehören zum Standard. Fensterposition und Größe werden mit den vorhandenen kontogebundenen GP-Fenstereinstellungen gespeichert.

## Integration

`GpPrintWindow.mount` erhält die Kontobindung, Zugriffsprüfung, fachliche Optionsdarstellung und einen `createPdf`-Callback. Der Callback holt eine geschützte serverseitig erzeugte PDF-Datei und liefert `{ blob, filename, summary }` zurück. Die Shell verwaltet Abbruch, verspätete Antworten, Vorschau, Ressourcen und Download.

Die fachliche PDF-Erstellung bleibt für Rechte, Quellstand, Berechnung, vollständige bzw. sichtbar begrenzte Auswahl und Umbrüche verantwortlich. Eine Bildschirmansicht oder ein nachgeahmtes Drucklayout ersetzt die echte PDF-Vorschau nicht.

Der Standard ist schrittweise bei bestehenden Ausgaben anzuwenden. Die Definition allein behauptet keine vollständige Umstellung sämtlicher älterer Exportdialoge.

Aktuell verwenden Artikel-Auswertung, Artikelstammblatt, ABC-Analyse, Abverkaufs-Simulation und Maßnahmenliste diesen Baustein. Im Artikelstamm bleiben die Bereiche, das optionale Foto, die zuletzt gestarteten Historienfilter und die Erweiterung des Dateinamens erhalten. Eigener PDF-Titel und A4-Ausrichtung werden im serverseitig erzeugten Stammblatt umgesetzt.

Die ABC-Ausgabe verwendet einen kontogebundenen serverseitigen Auswertungsnachweis (`exportToken`). Der Browser liefert keine Finanzzeilen. Alle Ergebniszeilen, Klassenanteile und Prüfhinweise werden aus dem vollständigen geprüften Stand erzeugt; die Seitennavigation der Bildschirmtabelle begrenzt den Export nicht. Rechte und Quellstand werden auch nach der PDF-Erstellung erneut geprüft.

Die Simulation exportiert einen geprüften aktuellen Szenariostand oder die konkrete Version einer gespeicherten persönlichen Variante. Ein gewählter Variantenvergleich enthält seine Annahmen und Herkunft. Historische Varianten werden beim Export nicht automatisch mit neuen Preisen überschrieben. Geänderte, noch nicht berechnete Eingaben sperren den Download.

Die Maßnahmenliste exportiert alle passenden gespeicherten Maßnahmen der ausgewählten Filiale anhand der zuletzt gestarteten Suche. Offene Formulare gehören nicht zur Ausgabe. Versionen und vollständiger Inhalt werden vor und nach dem Rendern erneut geprüft; eine zwischenzeitliche Teamänderung verlangt eine neue Vorschau. Persönliche Verantwortliche erscheinen im PDF mit ihrer Personalnummer. Lange Ergebnisnotizen werden vollständig über Fortsetzungsseiten ausgegeben.

Fachliche Schutzgrenzen: ABC höchstens 5.000 Ergebnisgruppen, Simulation höchstens 10.000 Artikel-Filial-Zeilen, Maßnahmen höchstens 500 gespeicherte Einträge je Filiale. Schutzgrenzen und unvollständige Datengrundlagen bleiben sichtbar. Die Druckshell erhöht diese Grenzen nicht.
