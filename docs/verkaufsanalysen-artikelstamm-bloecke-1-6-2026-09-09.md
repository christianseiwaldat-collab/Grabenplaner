# Verkaufsanalysen und Artikelstamm: Blöcke 1–6

Stand: 09.09.2026. Lokal implementiert und gezielt geprüft. Keine neue Version,
kein Commit, Push oder Deploy. Die zuvor veröffentlichte Version bleibt
v0.92.33-beta. Die anschließend beauftragten eigenen Artikelbilder und die
gemeinsame lokale Abnahme sind in
[Blöcken 7–8](verkaufsanalysen-artikelstamm-bloecke-7-8-2026-09-09.md) dokumentiert.
Geizhals-Bilder bleiben auf Benutzerwunsch ausgenommen.

## 1. Daten und Kennzahlen

Neue Berichte verwenden die aktivierten, geprüften Kassenpositionen. Sortiment
und Hersteller stammen aus `Sortiment` und `UMarke` am Verkaufsdatum. Der heutige
Artikelstamm liefert Auswahlbezeichnungen; er ersetzt keine historische Zuordnung.
Filialen und Positionsverkäufer folgen den bestätigten Importzuordnungen.

Verfügbar sind Umsatz netto/brutto, Rohertrag, Menge einschließlich Retouren,
Beleganzahl, unterschiedliche bekannte Kundenkonten, Nettoumsatz und Rohertrag je
bekanntem Kunden, Nettoumsatz je Beleg sowie die Rohertragsquote vom Nettoumsatz.
Die bestehenden Filial-, Verkäufer-, Kunden- und Rohertragsrechte gelten kumulativ.

Der Benutzer bestätigte am 09.09.2026: `RohertragDM` ist der Rohertrag je Stück;
`KalkRohertrag` bezeichnet den Positionsrohertrag, also Stückrohertrag × Menge.
Die Berechnung verwendet `RohertragDM × VKMenge` aus der Kassa, mit unveränderter
Dezimalpräzision bis zur Rundung der vollständigen Position auf Cent. Beispiel:
8,141666666666667 × 2 ergibt 16,28 EUR. Heutige TradeFoto-Einkaufspreise werden
dafür nicht herangezogen. Die bestätigte Regel ist an das bekannte EUR-Kassenschema
und die freigegebene Kassenregel gebunden. Fehlende Werte bleiben nicht verfügbar.

Kundenkonten werden über die ausgewählten Filialen hinweg dedupliziert.
Anonyme Belege werden gesondert gezählt. Kennzahlen je bekanntem Kunden verwenden
nur den Umsatz/Rohertrag dieser Konten; anonyme Umsätze werden nicht durch die Zahl
bekannter Kunden geteilt. Beleg- und Kundenzahlen verschiedener Gruppen sind nicht
addierbar. Im Arbeitsstand werden nur geschützte Ableitungen der Konten verwendet.

## 2. Berichtsauswahl

Die Navigation bleibt „Bericht erstellen“, „PDF-Analysen“, „Berichte“.
Das Formular bietet Mehrfachauswahl für Filialen, WGR/Sortiment, Hersteller, MA und
Kennzahlen. Ohne WGR-, Hersteller- oder MA-Eingrenzung gilt der gesamte gewählte
Filialumfang. Historische Marken und Personalnummern können zusätzlich eingegeben
werden. Für eingeschränkte Filialrechte wird kein unternehmensweites MA-Verzeichnis
ausgegeben.

Der Vergleich liegt standardmäßig genau ein Kalenderjahr vor dem gewählten
Zeitraum. Der 29. Februar wird dabei auf den 28. Februar begrenzt. Eine manuelle
Änderung bleibt bei späteren Änderungen des Hauptzeitraums erhalten, bis
„Vorjahr übernehmen“ gewählt wird. Je Zeitraum sind höchstens 366 Tage möglich.
Bis zu drei Gruppierungsebenen sowie absolute und prozentuelle Änderungen sind
wählbar. Prozentänderung: Differenz geteilt durch den Betrag des Vergleichswerts;
bei Vergleichswert null bleibt die Prozentänderung nicht verfügbar.

## 3. Hintergrundverarbeitung

Die vorhandene persönliche, verschlüsselte Auftragswarteschlange bleibt bestehen.
Je Arbeitsschritt werden höchstens 200 Positionen aus dem gewählten Zeitraum und
anschließend dem Vergleichszeitraum verarbeitet. Geldsummen basieren ausschließlich
auf vollständig abgeglichenen Belegen; Filter werden erst auf deren geprüfte
Positionen angewendet. Unbekannte Statuskombinationen sperren die betroffenen
Kennzahlen. Ein leerer Quellzeitraum wird nicht als bestätigter Nullumsatz ausgegeben.

Datenstand, Rechenregel und persönliche Berechtigungen sind an den Auftrag gebunden.
Ein geänderter Datenstand oder entzogene Rechte verhindern die Fortsetzung bzw.
den Download. Nach einem Prozessabbruch startet die Berechnung kontrolliert erneut,
ohne bisherige Summen doppelt zu addieren. Abbruch und konkurrierende Arbeiter
bleiben revisionsgesichert. Es gelten weiterhin drei offene und höchstens 50
gespeicherte Aufträge pro Person; die Ableitung begrenzt die Zahl der Gruppen auf
5.000 je Zeitraum.

## 4. PDF-Berichte

Neue Aufträge liefern echte PDF-Dateien mit eingebetteter Schrift, Titel,
Filterumfang, Zeiträumen, Datenherkunft, Gesamtergebnis, Qualitätsangaben,
Diagramm, vollständigen Gruppentabellen und Seitennummern. Bis zu sechs
nichtnegative additive Gruppen werden als Ringdiagramm dargestellt; bei mehr
Gruppen, negativen oder nicht addierbaren Kennzahlen wird ein Balkendiagramm
verwendet. Das Balkendiagramm zeigt höchstens 20 Gruppen, die Tabellen alle Gruppen.

Tabellenköpfe werden bei Seitenumbrüchen wiederholt und lange Bezeichnungen
umgebrochen. Grenzen: 250 Seiten bzw. 12 MiB; zu umfangreiche Aufträge enden mit
einer verständlichen Aufforderung zur Eingrenzung. Frühere HTML-Berichte und bereits
wartende ältere Aufträge bleiben mit ihrem ursprünglichen Format kompatibel.
Downloads sind persönlich, rechtegeprüft und nicht öffentlich zwischenspeicherbar.

## 5. Artikelansicht

Die Artikelkartei verwendet Register für Stammdaten, EAN/GTIN, Preise und Verlauf.
Stammdaten, Lieferant/Bestellung, importierter Bestand, Kennzeichen und Beschreibung
werden in kompakten Gruppen dargestellt, soweit die entsprechenden Importfelder
vorliegen. Beschreibungen behalten ihre vollständigen Inhalte und Zeilenumbrüche.
Verkaufs- und Einkaufspreise erscheinen als kompakte Preiskarten mit Basis und
Datenstatus. Nicht freigegebene Preisbereiche bleiben getrennt geschützt.

Die zusätzlichen TradeFoto-Felder werden nur aus ausdrücklich ausgewählten,
integritätsgeprüften Importsegmenten gelesen. Medienfelder werden nicht geöffnet.
Bestandsangaben sind der importierte Stand; diese Änderung führt keinen neuen
Live-Bestandsabruf oder zusätzliche Schreibfunktion in TradeFoto ein.

## 6. Suche und Ergebnistabelle

Die Suche nach Artikelnummer/Bezeichnung befindet sich im Kopf links von
„Meine Aktionen“. Erweiterte Filter bleiben darunter verfügbar. Die Ergebnisliste
startet mit zehn sichtbaren Zeilen und lässt sich an der rechten unteren Ecke
zwischen fünf und zwanzig Zeilen verändern. Alternativ funktionieren Pfeiltasten,
Pos1 und Ende. Weitere Treffer werden innerhalb der Liste nachgeladen.

Spalten können ein-/ausgeblendet und umgeordnet werden. Standardmäßig stehen
VK brutto EH und Internetpreis brutto nebeneinander. Zusätzlich gibt es deren
Nettowerte sowie durchschnittlichen EK netto/brutto, soweit ein eindeutiger,
freigegebener EUR-Wert vorliegt. Ungeklärte Preisbasen werden nicht umgerechnet.
Preise werden serverseitig über den gesamten Trefferbestand exakt sortiert;
fehlende Werte stehen in beiden Sortierrichtungen zuletzt. Benutzerkonten speichern
ihre Auswahl, Reihenfolge, Sortierung und Zeilenzahl persönlich. Beim lokalen
Einzelplatz ohne Benutzerkonto bleibt die Darstellung auf die Sitzung beschränkt.

Die Suchprojektion wird beim nächsten regulären Start additiv um Preisfelder
ergänzt und einmalig nachgetragen. Danach werden Änderungen zusammen mit der
Artikelrevision aktualisiert. Normale Suchaufrufe lesen keine Preistabellen je Treffer.

## Gezielte Prüfung

- Hauptlauf: 174 erfolgreiche Tests für Kassenintegration, Berichte, Artikel,
  Import, Berechtigungen und persistierte Daten.
- Zusätzliche Prüfungen: ältere wartende HTML-Aufträge, Migration einer tatsächlich
  auf den alten Spaltenstand zurückgesetzten Test-Suchprojektion, Kalender,
  Rechtewechsel und Navigation. Alle erfolgreich; erneute Migration bleibt ohne
  Änderungen.
- Datenbankzugriffsprüfung: `audit-persistence-coupling.js --check` erfolgreich;
  keine unklassifizierten Produktionsdateien oder Phasengrenzverletzungen.
- PDF-Text- und Seitenprüfung: Testfälle mit 5 bzw. 65 Gruppen. Sichtprüfung von
  Übersicht, Diagramm, Detailtabelle und einer Fortsetzungsseite; keine abgeschnittenen
  Inhalte. Der große Testbericht umfasst 19 Seiten. Unbekannte Werte werden im
  entsprechenden Testfall ausdrücklich als nicht verfügbar geprüft.
- Browser: Mehrfachfilter, automatische und manuell erhaltene Vorjahresdaten,
  Auftragserteilung; Artikelsuche mit 85 Treffern,
  globale Preissortierung bis zum 85. Treffer, Spaltenwechsel/Reihenfolge,
  Mausänderung von 5 auf 7 Zeilen und Tastaturgrenzen 5/20, Register und lange
  Texte. Keine horizontale Seitenüberbreite; die Ergebnistabelle scrollt innerhalb
  ihres eigenen Bereichs. Artikelzusatzdaten im Browser stammen aus einer
  synthetischen Darstellungsvorlage; der echte Importleser wurde separat getestet.

Die Prüfungen sind lokal und synthetisch. Sie sind keine Produktionsmessung und
keine Freigabe einer Live-Aktualisierung. Rohdatenbanken und produktive Dienste
wurden nicht verändert. Die spätere lokale Fortführung ist im Nachweis für
Blöcke 7–8 festgehalten; eine Produktionsbereitstellung bleibt separat.
