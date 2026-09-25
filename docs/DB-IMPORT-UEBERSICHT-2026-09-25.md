# Datenbankimporte: Übersicht und begrenzte Ergänzungsimporte

Lokale Umsetzung auf Basis von `a2af146f3847f3f057083ffd575e81f341cf00a0` (0.92.67-beta). Kein Push, Deploy oder produktiver Import.

## Bedienung

Unter Einstellungen / Datenbankimporte gibt es eine feste Zeile je regelmäßig benötigter Datenbank. Die Spalten zeigen Datenbank, fachlichen Datenstand, den Uploadzeitpunkt des angezeigten Dateistands, Status und Hochladen. Der Datenstand wird aus fachlichen Datumsfeldern ermittelt; die Bearbeitung eines Importauftrags macht eine alte Datei nicht fachlich aktueller.

Hochladen öffnet direkt die Dateiauswahl für die gewählte Datenbank. Dateikennwort und abschließender Upload bleiben im zugehörigen Formular. Eine erkennbare Datei einer anderen Datenbank wird vor dem Transfer zurückgewiesen. Die vorhandenen serverseitigen Schema-, Rechte-, CSRF- und Größenprüfungen bleiben wirksam. Die Übernahme geprüfter Daten bleibt ein eigener Bedienungsschritt.

Die Übersicht ist wie der bisherige Importverlauf an das persönliche Konto gebunden. Sie liest nicht nur die erste Verlaufsseite; bei mehr als 2.000 eigenen Importständen wird die begrenzte Prüfung ausdrücklich gekennzeichnet. Frühere Dateistände bleiben im aufklappbaren Importverlauf erreichbar. Optionale Quellen und lokal zu behaltende Daten sind getrennt aufklappbar. Nicht angebundene Quellen haben keinen funktionslosen Uploadknopf.

Bei schmaler Darstellung werden die Tabellenzeilen mit beschrifteten Feldern untereinander angeordnet. Alle Angaben und die Uploadaktion bleiben ohne horizontales Scrollen erreichbar.

## Unterstützte Quellen

- Unverändert: Trade_Daten, Kassen_Umsätze und Trade_DatenBestell.
- Neu: WEUM, ausschließlich 16 Bewegungsfelder und sieben Felder historischer Artikelreferenzen. Anforderungen, Seriennummerntabelle und UmAvis werden nicht geöffnet. Freitexte und Bearbeiterkennungen sind nicht in der Projektion. Historische Artikel werden nicht als aktive Artikel angelegt.
- Neu: InventurProtokoll, ausschließlich belegte Inventuren mit zusammengefassten Zeilenzahlen sowie Differenzen und Mengenprüffälle. Unveränderte, rechnerisch konsistente Details und leere Köpfe bleiben in der lokalen Quelldatei. Auch unvollständige Mengen und widersprüchliche Null-Differenzen bleiben als Detail erhalten. Vollständige Zählstandsrecherche benötigt eine spätere bewusste Erweiterung.

Die Inventurdetails verweisen auf den zusammengesetzten Kopf aus Inventurnummer und Filiale. Die gemeinsame Importstrecke übernimmt zunächst Köpfe und prüft Detailabhängigkeiten anschließend erneut. Negative Mengen bleiben erhalten. Preisfelder verwenden die bestehende geschützte Datenklasse `catalog_costs`. Die neuen Daten bleiben getrennte historische Quellen; es werden weder aktuelle Bestände umgebucht noch zusätzliche Kassenumsätze erzeugt.

Die vier neuen Historienprofile nutzen die bestehende SQLite-/PostgreSQL-Abstraktion; eine neue Datenbanktabelle oder ein neuer SQL-Befehl ist hierfür nicht nötig. Die bisherigen Profile bleiben unverändert. Quelldateien verwenden den bestehenden befristeten, verschlüsselten Uploadspeicher.

## Prüfungen und Grenzen

- Die neuen Leser wurden an den unveränderten Arbeitskopien der Analyse vom 22.09.2026 geprüft: 141.084 Bewegungen, 17.468 historische Artikel, 438 Inventurzusammenfassungen und 4.902 Details. Alle projizierten Werte lassen sich mit ihren Importprofilen normalisieren. Nachweis: `tmp/supplement-source-verification.json`.
- Synthetische Integration prüft Auswahl, Mengenzeichen, verlorene/fortgesetzte Pakete, Review, Übernahme, wiederholten Upload, Rücknahme und fehlende Seiteneffekte auf aktive Artikel und Kassendaten.
- Übersicht und Uploads prüfen Kontobindung, Rechte, Datumstrennung, Wiederfinden älterer Quellen, Dateizuordnung und Escaping. Jobs/Lebenszyklus und bestehende Import-/Historientests wurden zusätzlich ausgeführt.
- Die lokale Browservorschau verwendet echte UI-Dateien und synthetische API-Antworten. Desktop, schmale Ansicht, dunkles Design und Dateiauswahl wurden geprüft. Sie führt keine Imports aus.
- Kein nativer PostgreSQL-Serverlauf in dieser Aufgabe. SQL und Schema bleiben unverändert; der bestehende Persistenzaudit wird geprüft. Vor einer Veröffentlichung bleiben Paket-/Releaseprüfungen erforderlich.
- Die Auditliste enthält zusätzlich den bereits auf der Ausgangsbasis vorhandenen isolierten Test `trade-insight-jobs.test.js`, den der Audit zuvor als unklassifiziert meldete. An dessen Geschäftslogik wurde nichts geändert.

Bei späteren Inventurauswertungen müssen Detailzeilen zur jeweiligen Kopfversion beziehungsweise zum Quellstand gehören. Ein in einer späteren Datei ausgelassener Null-Differenzsatz ist keine Löschanweisung für frühere Historie. Neue Fachansichten und automatische Verknüpfungen des Artikelarchivs mit alten Kassenauswertungen sind nicht Bestandteil dieser Importoberfläche.

Die Schemafreigabe der Ergänzungsdateien stammt aus dem geprüften Katalog `output/Trade-Ergaenzungsanalyse-2026-09-22/arbeitsdaten/catalog.json`. Das Produkt enthält ausschließlich die Schema- und Feldauswahl, keine echten Datensätze oder Zugangsdaten.
