# Datenbankimporte: vereinfachte Bedienung und gemeinsamer Trade-Abgleich

Stand: 16.09.2026. Lokaler, noch nicht veröffentlichter Arbeitsstand auf Basis
von v0.92.55-beta. Dieser Bericht ersetzt keinen Deploynachweis.

## Bedienung

- Links stehen Datenquelle, ACCDB-Datei und optionales Dateikennwort untereinander.
  Ein bekannter Dateiname wählt den zugehörigen Datenbanktyp automatisch aus.
- Rechts zeigt eine zweispaltige Tabelle den ursprünglichen Dateinamen und den
  Datenstand. Ein Klick auf den Namen öffnet den Auftrag. Ältere Seiten bleiben
  beim Öffnen eines Auftrags ausgewählt.
- Der Datenstand ist das jüngste fachliche Änderungs- oder Belegdatum aus den
  eingelesenen Tabellen. Upload-, Kopier- und GP-Bearbeitungsdatum sind dafür kein
  Ersatz. Bei älteren Aufträgen ohne gespeicherten Originalnamen wird ausdrücklich
  nur der bekannte Dateityp angezeigt.
- Technische Tabellen, Dateiprüfsumme und Protokollaktionen sind eingeklappt.
  Das Aufklappen und der Tastaturfokus bleiben bei der Fortschrittsaktualisierung
  desselben Auftrags erhalten. Auf schmalen Bildschirmen stehen beide Bereiche
  untereinander.
- Der zusätzliche TradeFoto-Artikelstamm-Button und die manuelle
  Stammdaten-Zuordnung entfallen in diesem Bereich.

Die Datei wird nach dem Hochladen im Hintergrund eingelesen und geprüft.
Anschließend wird Trade/Bestell mit **Übernehmen** übernommen. Bei der Kasse
enthält ein Import bereits alle Filialen und Zeiträume; die Auswahl des geprüften
Kassenstands für Auswertungen bleibt ein eigener Schritt. Die bestehende
Filialzuordnung begrenzt den eingelesenen Datenumfang nicht.

## Löschgrenze

**Access-Datei löschen** entfernt ausschließlich die vorübergehend gespeicherte,
verschlüsselte Access-Kopie und das dazu gespeicherte Dateikennwort auf dem Server.
Es gibt keinen neuen Endpunkt zum Löschen von GP-Importständen. Eingelesene und
übernommene GP-Daten, Quellenmetadaten, Versionsstände und Protokolle werden durch
diese Aktion nicht gelöscht. Die bereits bestehende Aufbewahrungslogik wird
dadurch nicht verändert.

Nach vollständigem Einlesen wird die Access-Kopie automatisch entfernt. Schlägt
das Entfernen fehl, bleibt ihr Verweis im Auftrag erhalten; ein Neustart holt die
Bereinigung nach, ohne die Datenbank nochmals einzulesen. Unterbrochene Kopien
unterliegen weiterhin der bestehenden 72-Stunden-Bereinigung.

Manuelles Löschen prüft Berechtigung, Besitzer, Auftragsrevision und laufende
Verarbeitung. Ein aktiver Auftrag muss erst pausiert und dessen laufendes Paket
beendet sein. Fehlen nach der Löschung noch Quelldaten, kann genau dieselbe Datei
erneut hochgeladen werden; bereits gespeicherte Pakete werden weiterverwendet.
Ist das Einlesen abgeschlossen, läuft die weitere Prüfung ohne Access-Kopie.

## Fachliches Datum

`lib/data-import-content-date.js` führt eine explizite Liste fachlicher Datumsfelder
für Trade, Bestell und Kasse. Geplante Liefertermine, Geburtstage, zukünftige
Preisgültigkeiten, reine Uhrzeiten mit Access-Basisdatum 1899 und unplausible
Datumswerte bestimmen die Aktualität nicht. Die Anzeige verändert keine Zeitzone
eines Access-Datums ohne Zeitzoneninformation.

Neue Importe sammeln das Maximum während des ohnehin laufenden Einlesens. Für
vorhandene Quellen ohne Datumsmetadaten berechnet ein wiederaufnehmbarer Auftrag
das Datum aus den bereits verschlüsselt gespeicherten Zeilen. Er hat geringere
Warteschlangenpriorität als normale Importe und benötigt keinen erneuten Upload.
Ein fehlendes Datum wird ehrlich als fehlend angezeigt. Geht beim Einlesen nur
der Metadaten-Fortschritt verloren, wird das Maximum aus den bereits bestätigten
Zeilen nachermittelt.

## Artikelkatalog im normalen Trade-Import

Der bisherige Vollimport schrieb die generischen Importtabellen. Die zusätzliche
Artikelimport-Funktion aktualisierte den durchsuchbaren Artikelkatalog. Das reine
Entfernen ihres Buttons hätte diese zweite Funktion nicht ersetzt.

Der normale Trade-Import übernimmt deshalb jetzt zusätzlich Artikelnummern,
Barcodes und Preise aus den bereits eingelesenen Tabellen `ARTIKEL_STAMM` und
`ARTIKEL_ZWEITEAN`. Ein zweiter Datei-Upload oder Access-Leselauf ist unnötig. Der
vorhandene kanonische TradeFoto-Adapter und seine Preis-/Identitätsprüfungen werden
wiederverwendet. Unveränderte Artikel erzeugen keine neue Artikelversion; manuelle
GP-Änderungen und uneindeutige Barcodes bleiben geschützt. Zurückgestellte Artikel
werden als Anzahl ausgewiesen. Der zusätzliche Artikelimport benötigt weiterhin
das vorhandene Artikelimport-Recht.

Quellenmetadaten liegen in Core, der Artikelkatalog in Sales. Ein Paket von bis
zu 40 Artikeln speichert daher zuerst einen verschlüsselten Schreibauftrag in
Core, übernimmt ihn atomar in Sales und bestätigt anschließend den Fortschritt
in Core. Geht die Bestätigung verloren, erkennt die Wiederaufnahme den bereits
gespeicherten Beleg. Zwischenzeitliche manuelle Änderungen verwerfen den alten
Plan und werden neu geprüft. Der vertrauliche Schreibauftrag erscheint nicht in
der HTTP-Zusammenfassung. Eine Rücknahme verwendet denselben Ablauf mit einem
stabilen Rücknahmebeleg und beachtet spätere Änderungen sowie die Rücknahmefrist.

## Prüfung und Zeitbudget

Die Untersuchung der SQL-Kosten und die früheren vollständigen Messungen stehen
in [IMPORT-OPTIMIERUNG-2026-09-15.md](IMPORT-OPTIMIERUNG-2026-09-15.md). Es wurde
kein zusätzlicher Fremddienst und keine weitere Laufzeitabhängigkeit eingeführt.
Der bereits eingesetzte Access-Reader wird weiterverwendet.

Die erneute vollständige Trade-Messung verwendet die unveränderte lokale Kopie
mit 396.466 Zeilen, Node 22.22.1 und das isolierte PostgreSQL-18.6-Testsystem mit
getrennten Core-/Sales-Datenbanken. Sie umfasst verschlüsselte Bereitstellung,
Prüfung, Übernahme und den neuen Artikelkatalogabgleich. Netzwerk-Upload,
produktive Zielbestände, Warteschlange und VPS-Last sind darin nicht enthalten.

Der Lauf wurde auf ausdrücklichen Wunsch abgebrochen. Am letzten protokollierten
Fortschrittspunkt nach **33 min 08 s** waren alle 396.466 Quellzeilen verarbeitet
und der Artikelkatalogabgleich hatte begonnen. Dies ist keine vollständige
Gesamtlaufzeit. Weitere vollständige Laufzeitmessungen wurden nicht gestartet.
Das Ziel von 30–45 Minuten auf dem VPS ist durch diesen abgebrochenen lokalen
Lauf nicht bestätigt.

Der Testprozess ist beendet, seine isolierten Testdaten wurden durch die
Fixture-Bereinigung entfernt und das eigene lokale PostgreSQL-Testsystem wurde
ordnungsgemäß gestoppt. Die Implementierung bleibt lokal und unveröffentlicht.

### Reproduzierbare Prüfungen

- Node-22-Tests für Import-Runtime, Auftragsablage und HTTP-/UI-Verträge.
- Regressionen der Artikelkatalog-Persistenz, TradeFoto-Adapter und Kassenfreigabe.
- Native PostgreSQL-Tests gegen getrennte Core-/Sales-Datenbanken.
- Fehlerfälle: verlorene Übernahme- und Rücknahmebestätigung, spätere manuelle
  Artikeländerung, verlorener Datumsfortschritt, fehlgeschlagene Dateibereinigung,
  Neustart und erneuter Upload nach ausschließlich gelöschter Access-Kopie.
- Browserprüfung mit synthetischen Daten: Desktop und 390-Pixel-Ansicht,
  helle/dunkle Darstellung, Auswahl und aufklappbare Details.

Erfolgreiche Nachweise: 191/191 Tests in der gemeinsamen Regression; danach
3/3 gezielte Datumsprüfungen einschließlich fehlender gespeicherter Zeilen,
24/24 Auftragstests einschließlich Vorrang für neue Datenaktualisierungen und
21/21 HTTP-/UI-Tests. Diese Gruppen überschneiden sich. Der neue gemeinsame
Trade-Import wurde zusätzlich gegen die echte Core-/Sales-PostgreSQL-Struktur
mit Übernahme, Wiederholung und Rücknahme erfolgreich geprüft. Der anschließend
gestartete vollständige Lauf mit der echten Trade-Datei wurde wie beschrieben
abgebrochen.

Der Produktivserver und die Originaldateien wurden bei diesen Prüfungen nicht
verändert. Der neue Stand ist nicht deployed.
