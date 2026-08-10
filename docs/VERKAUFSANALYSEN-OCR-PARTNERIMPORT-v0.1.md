# Verkaufsanalysen · Lokaler OCR-Partnerimport v0.1

**Stand:** 03.08.2026<br>
**Arbeitsblock:** 7 – OCR-Partnerimport für TradeFoto-PDF-Statistiken<br>
**Produktbereich:** Verkaufsverwaltung > Verkaufsanalysen<br>
**Historischer Status am 03.08.2026:** Entwicklungsstand im separaten Verkaufsverwaltungs-Worktree; nicht ausgerollt

## 1. Ziel und Einordnung

Bis eine belastbare Datenbankanbindung zwischen Grabenplaner und der
TradeFoto-Access-Datenbank verfügbar ist, können auch bildbasierte PDF-Ausgaben
des Berichts **„Warengruppenvergleich netto“** lokal eingelesen werden.

Dieser Block ergänzt den PDF-Berichtsimport aus Block 6. Die dort dokumentierte
Angabe „OCR-Fallback noch nicht freigegeben“ bleibt als historischer Stand von
Block 6 erhalten und wird für den aktuellen Entwicklungsstand durch dieses
Nachfolgedokument abgelöst.

Verkaufsverwaltung bleibt ein fest integrierter Hauptbereich. Der OCR-Import ist
kein optionales Installationsmodul und eröffnet ohne die vorhandenen
Verkaufsanalyse-Rechte weder Arbeitsbereich noch Berichtsdaten.

## 2. Unterstützter Ablauf

1. Die PDF wird zunächst mit dem bestehenden, koordinatenbasierten
   Textschicht-Parser geprüft.
2. Nur wenn keine ausreichend verlässliche Textschicht vorhanden ist, wird die
   lokale OCR aktiviert.
3. Jede Seite wird speicherbegrenzt gerastert und nacheinander mit dem lokal
   gebündelten deutschen Tesseract-Modell erkannt.
4. Der bestehende TradeFoto-Parser strukturiert daraus einen **unverbindlichen
   Vorschlag**.
5. Im Desktop-Arbeitsbereich sind Filialkennung, Berichtsdatum, alle Zeiträume,
   Warengruppennummern, Bezeichnungen, Kennzahlen und gedruckten Summen
   bearbeitbar.
6. Jede Änderung hebt eine bereits gesetzte Bestätigung wieder auf.
7. Vor der Übernahme berechnet der Server Pflichtfelder und Summenabgleich erneut.
   Nur `match` oder die ausdrücklich definierte Rundungstoleranz
   `within_tolerance` sind zulässig.
8. Erst nach menschlicher Bestätigung werden die aggregierten Berichtsdaten
   unveränderlich gespeichert.

Eine OCR-Erkennung ist damit niemals eine automatische fachliche Freigabe.

## 3. Daten- und Nachweisgrenzen

Die ursprüngliche PDF bleibt nur während des HTTP-Aufrufs im Arbeitsspeicher.
Sie wird weder als Datei noch als Datenbank-Blob gespeichert. Auch gerasterte
Seiten, PNG-Zwischenstände und der rohe OCR-Text werden nicht persistiert.

Im kurzlebigen, benutzergebundenen Prüfcache liegt ausschließlich die
strukturierte Vorschau. Nach Übernahme oder bewusstem Verwerfen wird die Sitzung
gelöscht; außerdem greift die vorhandene Ablaufzeit des Integrationscaches.

Der unveränderliche Aggregatbericht speichert zusätzlich:

- `extraction = pdf_text_coordinates` und
  `review_method = source_text_confirmed` bei einer Textschicht;
- `extraction = local_ocr_coordinates` und
  `review_method = ocr_human_confirmed` nach bestätigter OCR-Prüfung.

Audit-Einträge enthalten nur technische Nachweise wie Datei-Hash, Seiten- und
Warengruppenanzahl, Filialkennung, Abgleichstatus und Erkennungsweg. PDF-Inhalt,
Rohtext und einzelne OCR-Wörter werden nicht in das Audit geschrieben.

## 4. Technische Schutzgrenzen

Die OCR arbeitet ausschließlich lokal im Grabenplaner-Serverprozess. Es gibt
keinen Cloud-OCR-Aufruf und keine Übertragung an einen externen Dienst.

| Grenze | Entwicklungsstand v0.1 |
|---|---:|
| PDF-Größe | höchstens 15 MiB |
| OCR-Seiten | höchstens 30 |
| Rasterfläche je Seite | höchstens 8.000.000 Pixel |
| Rasterbreite | höchstens 3.200 Pixel |
| OCR-Wörter je Seite | höchstens 8.000 |
| OCR-Wörter je Auftrag | höchstens 60.000 |
| OCR-Zeit je Seite | höchstens 45 Sekunden |
| laufender und wartender OCR-Auftrag | zusammen höchstens 2 |

Die Seiten werden nacheinander verarbeitet und die jeweilige PNG- sowie
Canvas-Zwischenablage direkt danach freigegeben. Überlastung, Zeitüberschreitung,
unplausibler Berichtsaufbau, fehlende Summen oder nicht auflösbare OCR-Ergebnisse
brechen fail-closed ab.

## 5. Rechte und Sichtbarkeit

Es gelten unverändert die serverseitig projizierten Rechte aus Block 3 und 6:

- `sales:analytics:access` für den Arbeitsbereich;
- freigegebener Filialbereich;
- Rohertragsrecht für den geschützten Kennzahlenumfang;
- `sales:analytics:import:manage` für Prüfung und Übernahme.

Ein technisches Administrationsrecht allein gewährt keinen Zugriff auf
Verkaufsdaten. Prüfsitzungen sind an die aktuelle Personalnummer gebunden.

## 6. Bewusst nicht enthalten

- keine mobile Fachansicht oder mobile Abnahme;
- keine direkte oder laufende Access-Datenbank-Synchronisation;
- keine Cloud-OCR und keine Weitergabe der PDF an Dritte;
- keine automatische Korrektur von `#Typ!`-Formelfehlern im Quellbericht;
- keine automatische Übernahme anderer TradeFoto-Berichtsarten;
- keine Erzeugung von Einzelbons, Kunden- oder Personendaten;
- kein Commit, Push, Release oder VPS-Deployment in diesem Arbeitsblock.

## 7. Prüfstand

Der Entwicklungsstand wird mit einer synthetischen, reinen Raster-PDF geprüft.
Der Test bestätigt insbesondere:

- der Textschicht-Parser weist dieselbe Datei kontrolliert ab;
- die lokale OCR erzeugt nur einen bearbeitbaren Vorschlag;
- ein unbearbeiteter OCR-Vorschlag kann nicht persistiert werden;
- nach menschlicher Prüfübergabe werden Summen erneut berechnet;
- Erkennungsweg und Bestätigungsmethode werden gespeichert;
- die Original-PDF und der rohe OCR-Text werden nicht gespeichert.

Die bestehende, nicht aktuelle TradeFoto-Beispielstatistik dient weiterhin nur
zur Layout- und Vertragsprüfung. Dieser Block behauptet keine Browser- oder
Produktionsabnahme und enthält kein Deployment.
