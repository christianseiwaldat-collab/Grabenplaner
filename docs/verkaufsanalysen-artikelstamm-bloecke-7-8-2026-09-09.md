# Verkaufsanalysen und Artikelstamm: Blöcke 7–8

Stand: 09.09.2026. Lokal implementiert und geprüft, aufbauend auf
[Blöcken 1–6](verkaufsanalysen-artikelstamm-bloecke-1-6-2026-09-09.md).
Version unverändert `0.92.33-beta`. Kein neuer Commit, Push oder Deploy;
keine Änderung produktiver Dienste oder Originaldatenbanken.

## Block 7: Eigene Artikelbilder und vorhandene Produktlinks

Das Bildsymbol in der Artikelansicht öffnet einen kompakten Dialog. Wer den
Artikelstamm bearbeiten darf, kann eine lokale Datei auswählen oder ein Bild
von einer direkten öffentlichen HTTPS-Adresse übernehmen. Ohne Schreibrecht
lässt sich ein vorhandenes Bild vergrößert betrachten. Das Symbol misst
66 × 66 Pixel gegenüber den bisherigen 54 × 54 Pixeln.

Erlaubt sind einzelne JPG-, PNG- und WebP-Bilder bis 10 MiB und 24 Megapixel.
Der Server korrigiert die Ausrichtung, erhält das vollständige Seitenverhältnis,
entfernt Metadaten und speichert eine WebP-Fassung mit höchstens 1.280 Pixeln
Kantenlänge und 512 KiB. Er vergrößert kleine Vorlagen nicht. Vektor-/Dokumentformate
und beschädigte Bilder werden abgewiesen. Die Originaldatei und die eingegebene
Webadresse werden nicht gespeichert.

Webbilder werden einmalig kopiert. Ein späteres Verschwinden der Webadresse
entfernt daher kein gespeichertes Bild. Der Abruf prüft auch Weiterleitungen
erneut, bindet die Verbindung an geprüfte DNS-Adressen und begrenzt Laufzeit und
Datenmenge. Interne Ziele, Zugangsdaten und andere Ports sind ausgeschlossen;
Sitzungscookies werden nicht weitergegeben. Es werden höchstens zwei Bilder
gleichzeitig und eines je Benutzer verarbeitet. Technische Grundlagen:
[OWASP zu serverseitigen URL-Abrufen](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
und [Sharp-Eingabebegrenzungen](https://sharp.pixelplumbing.com/api-constructor/).

Die Tabelle `sales_article_own_images` speichert das Bild unabhängig von den
Trade-Snapshots über die exakte Artikelnummer. Führende Nullen bleiben erhalten.
Trade-Updates, erneute Imports, Artikelarchivierung und das Rückgängigmachen einer
Artikeländerung überschreiben diese Tabelle nicht. Bildänderungen besitzen eine
eigene Revision und einen Audit-Eintrag. Bei konkurrierenden Änderungen muss der
Benutzer den aktuellen Stand erneut öffnen. Das Entfernen verlangt eine zweite
Bestätigung im Dialog.

Eine Artikelkopie mit neuer Nummer erhält kein fremdes Bild. Auch eine manuelle
Umnummerierung überträgt das Bild nicht automatisch: Die verlangte Bindung bleibt
an der bisherigen Artikelnummer. Es werden keine fremden Bilder aus einer
ähnlichen Artikelnummer abgeleitet.

Bildinhalte werden nur bei geöffneter Artikelansicht angefordert; die Suchliste
enthält keine Bilddaten. Unveränderte Darstellungsaktualisierungen laden das
Bildsymbol nicht erneut. Lesen und Schreiben verwenden die bestehenden
Artikelrechte, Portal-CSRF und eine erneute Rechteprüfung nach längeren Abrufen.
Bildantworten sind privat und nicht öffentlich cachebar. Detailantworten enthalten
lediglich Bildmetadaten. Auch Antworten nach Bearbeiten, Archivieren und Undo
enthalten diese Metadaten, damit das Bild sichtbar bleibt.

Das importierte Feld `HerstellerLink` wird als Produktlink angezeigt, wenn es eine
gültige HTTP-/HTTPS-Adresse ohne eingebettete Zugangsdaten enthält. Erkannte
Geizhals-Adressen tragen die Bezeichnung „Geizhals“. Links öffnen erst durch
Benutzerklick in einem neuen Tab ohne Weitergabe des Referrers. Andere Formate
bleiben einfacher Text. Es gibt weder automatischen Geizhals-Bildabruf noch
Scraping oder eine aus Artikelbezeichnungen erratene Geizhals-Zuordnung.

Die zusätzliche Tabelle wird beim nächsten regulären Anwendungsstart additiv
angelegt. Die Bilder liegen in derselben Datenbanksicherung wie die Artikel;
ein zusätzlicher Dateispeicher muss nicht separat synchronisiert werden.

## Block 8: Lokale gemeinsame Abnahme

- Gesamtlauf: 197 erfolgreiche Tests für Kassenveröffentlichung, Historie,
  Berichtsaufträge/PDF, Artikel, Imports, Berechtigungen und Datenbankverträge.
- Nach der Ergänzung der Produktlinks: 63 erfolgreiche gezielte Tests für
  Bildverarbeitung, sichere Linkdarstellung, Artikeloberfläche und Trade-Leser.
  Die abschließende Oberflächen-/Bildprüfung bestand weitere 28 Tests.
- Zusätzliche Vertragsläufe: 44 sowie 36 erfolgreiche Prüfungen für Portal/
  Einzelplatz, Provider, Dialektzuordnung und Architekturgrenzen. Die Zahlen
  überschneiden sich; sie sind keine Summe unterschiedlicher Tests.
- Eigene Bilder bleiben nach einem wirklichen Test-Trade-Update, Archivierung,
  erneutem Schemaaufbau und einer mit `VACUUM INTO` erstellten, neu geöffneten
  Datenbankkopie unverändert. Führende Nullen, gleichzeitige Änderungen,
  Entfernung, manipulierte Bildinhalte und Rechteentzug wurden geprüft.
- Die echten Serverrouten wurden im Portal und im lokalen Einzelplatz getestet,
  einschließlich fehlendem CSRF, entzogenen Lese-/Schreibrechten und persönlichen
  Undo-Aktionen. Nach Entzug während eines URL-Abrufs wird kein Bild geschrieben.
- Der vollständige Berichtspfad erzeugt für das bestätigte Kassenbeispiel
  `8,141666666666667 × 2` einen PDF-Rohertrag von **16,28 EUR**. Der Hinweis auf
  eine noch unbestätigte Feldbedeutung erscheint für diese bestätigte Quelle nicht.
  Ein fehlender Vergleichszeitraum bleibt ausdrücklich nicht verfügbar.
- PDF-Prüfung: Kennzahlen, Diagramme, lange Gruppennamen, Tabellenfortsetzungen,
  Seitennummern und Seitenbegrenzungen. Sichtprüfung vorhandener Langtabellen und
  des neu aus einem vollständigen Testauftrag erzeugten Rohertrags-PDFs.
- Browser mit synthetischer lokaler Datenbank: Datei auswählen, Vorschau,
  Bild übernehmen, Seite neu laden, Bild erneut öffnen, fehlerhafte Webadresse,
  Entfernen-Bestätigung abbrechen. Bei 1.280 × 720 Pixeln keine horizontale
  Überbreite oder abgeschnittene Dialogtexte; keine Browserfehler. Der positive
  URL-Download ist mit kontrollierten Netzwerkantworten getestet, nicht gegen
  einen beliebigen externen Bildanbieter.
- Persistenzprüfung `audit-persistence-coupling.js --check`: erfolgreich,
  keine unklassifizierten Dateien oder Phasengrenzverletzungen. Die vier neuen
  Bildstatements sind im bestehenden Providervertrag registriert. PostgreSQL
  bleibt beim dokumentierten Entwicklungsstand ohne Produktivaktivierung.

Die Prüfprotokolle und synthetischen PDF-Artefakte liegen lokal unter `tmp/`.
Sie belegen keine Produktionslaufzeiten. Die vorhandenen Warte-/Importgrenzen
bleiben bestehen; ein VPS-Neustart oder eine neue Bereitstellung gehört nicht
zu dieser lokalen Abnahme. Das absichtlich unversionierte `output/` bleibt erhalten.

## Neue Datenbankfrage

Die Kassa enthält zusätzlich Journale und Zahlungsdaten, aber in der untersuchten
Datei keine ausreichenden Einkaufspositionen für einen eigenen Einkaufsdurchschnitt.
Trade besitzt bereits `DurchschnittEK`, dessen Bewertungsbasis noch zu bestätigen
ist. Die fachlich genutzten Importdaten liegen aktuell beim GP-Provider in der
Standarddatenbank `dienstplan.db`.

Die empfohlene spätere Aufteilung in `dienstplan.db` und eine gemeinsame
`handel.db` für Kassa/Trade einschließlich eigener Bilder und Berichte ist im
[separaten Datenbankkonzept](handel-datenbank-konzept-2026-09-09.md) beschrieben.
Eine solche Trennung wurde in diesen Blöcken nicht durchgeführt.
