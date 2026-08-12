# Verkaufsanalysen – PDF-Berichtsimport v0.1

**Stand:** 03.08.2026<br>
**Arbeitsblock:** 6 – TradeFoto-PDF-Statistiken<br>
**Historischer Implementierungsstatus am 03.08.2026:** im separaten Feature-Worktree umgesetzt und geprüft, noch nicht veröffentlicht oder am VPS ausgerollt

## 1. Ziel und Einordnung

Bis eine belastbare, freigegebene Datenbankanbindung zwischen Grabenplaner und der
TradeFoto-Access-Datenbank besteht, können aggregierte TradeFoto-Statistikberichte
kontrolliert aus PDF-Dateien übernommen werden. Der erste unterstützte Bericht ist:

- `Warengruppenvergleich netto`

Die Funktion ist Teil des fest integrierten Desktop-Bereichs
`Verkaufsverwaltung > Verkaufsanalysen`. Sie ist kein optional installierbares Modul
und besitzt keine eigene mobile Fachansicht.

Der PDF-Bericht wird als aggregierter Bericht behandelt. Er erzeugt ausdrücklich
keine Kassenbons, Bonpositionen, Kundenkontakte, Mitarbeitervorgänge oder
Bestandsbewegungen.

## 2. Importablauf

1. Eine berechtigte Person wählt eine PDF-Datei aus.
2. Der Server prüft Dateigröße, PDF-Signatur, Seitenzahl, Textschicht und den
   erwarteten TradeFoto-Berichtsaufbau.
3. Aus der Textlage werden Filialkennung, Berichts- und Vergleichszeitraum,
   Warengruppen, Mengen, Nettoumsatz, Rohertrag, Kundenanzahl und Umsatz je Kunde
   gelesen.
4. Die Summe der Warengruppen wird gegen die im Bericht gedruckten Summen geprüft.
5. Die Vorschau zeigt erkannte Daten und Prüfhilfen. GP-Filiale und Währung `EUR`
   müssen ausdrücklich gewählt beziehungsweise bestätigt werden.
6. Erst nach einer zusätzlichen Gesamtbestätigung wird der Bericht atomar und
   unveränderlich gespeichert.
7. Eine identische Quelldatei wird anhand ihres SHA-256-Fingerprints nur einmal
   übernommen. Ein erneuter Import liefert den bestehenden Bericht zurück.

Die Vorschau liegt höchstens 15 Minuten in einem benutzergebundenen
Arbeitsspeicher-Cache. Sie ist nicht zwischen angemeldeten Personen austauschbar.

## 3. Datenschutz und Datenminimierung

Die ursprüngliche PDF-Datei wird im Grabenplaner weder als Datei noch als Blob
gespeichert. Dauerhaft verbleiben nur:

- SHA-256-Fingerprint der Quelldatei;
- Parser- und Berichtsmetadaten;
- bestätigte GP-Filialzuordnung und Währung;
- aggregierte Kennzahlen pro Warengruppe und Berichtshorizont;
- gedruckte Berichtssummen;
- Seiten- und Zeilenposition als technische Herkunftshilfe;
- Anzahl der erkannten Prüfhilfen und Status der Summenabstimmung;
- Importzeitpunkt und ausführende Person.

Dateipfad, Drive-Link, Zugangsdaten und PDF-Inhalt werden nicht persistiert. Die
Auditspur enthält ausschließlich minimierte Metadaten und keine Warengruppenzeilen.

## 4. Rechte- und Sichtgrenzen

Der Arbeitsbereich bleibt durch `sales:analytics:access` geschlossen. Der
PDF-Import benötigt zusätzlich:

- eine vollständige Filialfreigabe oder die Unternehmenssicht;
- `sales:analytics:margin:read`, weil der Bericht Rohertragswerte enthält;
- `sales:analytics:imports:manage`.

Eine technische IT-Administrationsrolle erhält dadurch keinen automatischen
Zugriff auf Verkaufsdaten. Ohne Rohertragsrecht werden Rohertragsfelder bei der
Berichtsausgabe serverseitig entfernt. Filialbezogene Leser sehen nur Berichte
ihrer vollständig freigegebenen Filialen; ein reiner Abteilungsscope reicht nicht.

## 5. Validierung und Fehlersicherheit

Der Import arbeitet fail-closed:

- maximal 15 MiB und 120 Seiten;
- nur lesbare PDF-Dateien mit erwarteter Textlage;
- alle Seiten müssen Filiale und Berichtszeitraum konsistent ausweisen;
- doppelte Warengruppen oder fehlende Pflichtkennzahlen blockieren;
- Dezimalwerte werden als kanonische Werte mit vier Nachkommastellen verarbeitet;
- JavaScript-Gleitkommazahlen werden nicht für die Persistenz verwendet;
- Summenabweichungen außerhalb der definierten Druckrundungstoleranz blockieren;
- eine bestehende TradeFoto-Filialkennung darf nicht still auf eine andere
  GP-Filiale umgebogen werden;
- gespeicherte Berichte und Kennzahlen sind per Datenbanktrigger unveränderlich.

Bekannte kleine Abweichungen durch gedruckte Zweinachkommastellen werden als
`within_tolerance` sichtbar gemacht und müssen bestätigt werden. Ein bekannter
TradeFoto-Mengendrift von genau einer Einheit bleibt ebenfalls ein ausdrücklicher
Prüfhinweis und wird nicht still korrigiert.

## 6. OCR-Grenze

Version 0.1 nutzt die vorhandene PDF-Textschicht und ihre Koordinaten. Bildbasierte
oder unzuverlässig erkannte PDFs werden mit einem klaren Hinweis abgewiesen. Der
geplante OCR-Pfad bleibt ein späterer Partnerimport:

- OCR darf nur eine bearbeitbare Vorschau erzeugen;
- Filiale, Währung, Zeiträume und Kennzahlen bleiben bestätigungspflichtig;
- ein OCR-Ergebnis darf niemals direkt in die Berichtstabellen schreiben;
- dieselben Summen-, Rechte-, Idempotenz- und Auditregeln gelten weiterhin.

Ein OCR-Fallback ist mit diesem Stand noch nicht freigegeben.

## 7. Persistenz und Providerstatus

Der SQLite-Anwendungspfad enthält die Sales-Analytics-Tabellen und 29 zugehörige
Statementverträge. Für den PDF-Bericht werden drei additive, unveränderliche
Relationen verwendet:

- `sales_aggregate_reports`;
- `sales_report_product_group_metrics`;
- `sales_report_total_metrics`.

Der vollständige Anwendungskatalog umfasst damit 979 Statements. Der
PostgreSQL-Dialektplan umfasst ebenfalls 979 Statements, davon 877 portable
Kandidaten und 102 weiterhin erforderliche Overrides. Das globale
PostgreSQL-Acceptance-Gate bleibt bei `0/979` geschlossen. Diese Erweiterung
aktiviert keinen PostgreSQL-Produktivpfad.

## 8. Prüfung mit dem bereitgestellten Beispiel

Der bereitgestellte, nicht aktuelle TradeFoto-Bericht wurde ausschließlich als
temporäres Prüfmaterial verwendet. Der Parser erkannte:

- 11 Seiten;
- TradeFoto-Filiale `18`;
- Berichtszeitraum 01.07.2026 bis 31.07.2026;
- Vergleichszeitraum 01.07.2025 bis 31.07.2025;
- 93 Warengruppen;
- Summenstatus `within_tolerance`;
- TradeFoto-Formelhinweise `#Typ!` auf den Seiten 7, 10 und 11.

Die Formelhinweise blockieren den textbasierten Import nicht automatisch, werden
aber als sichtbare Quellwarnung in die verbindliche Bestätigung aufgenommen.

## 9. Bewusste Restgrenzen

Nicht Bestandteil dieses Blocks sind:

- direkte Access-Datenbankverbindung oder Hintergrundsynchronisierung;
- automatische Übernahme weiterer TradeFoto-Berichtsarten;
- OCR-Verarbeitung gescannter Berichte;
- Kassenbon-, Kunden-, Mitarbeiter- oder Einzelartikelimport aus der PDF;
- selbstständige Korrektur von TradeFoto-Formeln;
- Veröffentlichung, Commit, Push oder VPS-Ausrollung.

Die spätere Datenbankanbindung muss denselben kanonischen Datenkatalog und die
gleichen Rechte-, Vorschau-, Bestätigungs- und Auditgrenzen weiterverwenden.
