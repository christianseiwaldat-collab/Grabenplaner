# Verkaufsberichte und Browsernavigation

Stand: 11.09.2026. Gemeinsam mit dem Hotfix in v0.92.36-beta veröffentlicht.
Die Berichterstellung ist wieder freigegeben. Paket, Funktionsnachweise und
getrennt offene Betriebsprüfungen stehen im
[Releasebericht](VERKAUFSBERICHTE-RELEASE-v09236.md). Die folgenden lokalen
Prüfungen dokumentieren die Entwicklung vor dieser Bereitstellung.

## Berichtsauswahl

„Bericht erstellen“ nutzt die verfügbare Breite. Auswertungs- und
Vergleichszeitraum bieten exakte Daten, Monat, Quartal und Jahr. Laufende
Kalenderzeiträume enden heute; noch nicht begonnene Zeiträume sind gesperrt.
Der Vergleich folgt zunächst genau ein Jahr zuvor, einschließlich der
Schaltjahrkorrektur. Eine manuelle Änderung bleibt erhalten, bis der Benutzer
„Vorjahr übernehmen“ auswählt. Die vorhandene Grenze von 366 Tagen je Zeitraum
gilt weiterhin.

WGR/Sortimente und Hersteller haben jeweils eine durchsuchbare Tabelle links
und die Berichtsauswahl rechts. Markierte Einträge werden mit „Hinzufügen“
übernommen und mit „Entfernen“ zurückgenommen. Pro Auswahl sind höchstens zehn
Einträge erlaubt, auch serverseitig. Ohne Auswahl erfolgt keine zusätzliche
Eingrenzung. Lange Namen umbrechen vollständig. Bei geringer Breite stehen die
Auswahlbereiche untereinander; die Tabellen scrollen innerhalb ihrer Fläche.

Die Bezeichnungen stammen aus dem eingelesenen Trade-Stand. Wenn die zugehörigen
Stammdatentabellen noch nicht angewendet wurden, kann der Leser ausschließlich
die benötigten Bezeichnungen aus einem vollständig geprüften Importarchiv
verwenden. Er verifiziert Profil, Umfang, Inhaltsbindung und geschützte
Nutzdaten. Dabei wird kein Import angewendet und keine Quelle verändert.
Ein ausschließlich lesender Test am vorhandenen Serverbestand fand 231
Sortimente und 613 Hersteller in 1.365 ms; die Bereitschaftsprüfung war HTTP 200.

## Online-Filialen

Die zusätzliche Auswahl „Online (00, 70, 90)“ umfasst die Kassen-Quellkennungen
`0`, `00`, `70` und `90`. Die Kennung `0` bezeichnet gleichzeitig das Zentrallager.
Online ist nur mit unternehmensweitem Auswertungsrecht verfügbar. Bei einer
gemeinsamen Auswahl von Online und einer physischen Filiale werden überlappende
Kassenpositionen einmal gezählt. Die Reihenfolge der ausgewählten Filialen
ändert das Ergebnis nicht. Die indexierte, begrenzte Suche prüft Kandidaten mit
leerer Zuordnung nach dem Entschlüsseln nochmals auf ihre echte Quellkennung.

## PDF-Darstellung

Neue Berichtsaufträge verwenden Auswahlversion 3 mit Hoch-/Querformat und
automatischem Diagramm, Vergleichsbalken, Ringdiagramm oder ohne Diagramm.
Bereits gespeicherte Auswahlversion 2 behält ihren bisherigen Vertrag und ihre
früheren Auswahlgrenzen.

Ringdiagramme zeigen bis zu zehn Gruppen bei geeigneten additiven Kennzahlen
und nicht negativen Werten. Bei ungeeigneten Anteilen, etwa Retouren mit
negativem Ergebnis, erscheinen Balken und eine Erklärung. Die Detailtabellen
enthalten weiterhin alle Gruppen. Schriftgrößen, Werte und Sicherheitsgrenzen
bleiben erhalten; Seitenbreite, Umbrüche und Fußzeilen berücksichtigen das
gewählte Format.

Die anschließende Prüfung fehlender Herstellerwerte ergänzt ausdrücklich
gekennzeichnete geprüfte Teilwerte und eine Übersicht offener Belegprüfungen.
Details und Nachweise stehen unter
[Geprüfte Teilwerte in Verkaufsberichten](VERKAUFSBERICHTE-GEPRUEFTE-TEILWERTE.md).

Ein Diagramm mit einer echten Zeitachse bleibt eine spätere Erweiterung. Die
aktuellen Diagramme vergleichen die ausgewählten Gruppen und Zeiträume; sie
behaupten keine tägliche oder monatliche Datenvollständigkeit.

## Browser-Zurück und Vorwärts

Die Verwaltung und das Mitarbeiterportal verwenden einen gemeinsamen
History-Controller. Seitenwechsel werden in den normalen Browserverlauf
eingetragen; zusammengehörende Wechsel von Hauptseite und Untermenü ergeben
einen Schritt. Derselbe Verlauf gilt für die Chrome-Schaltflächen, die
entsprechenden Maustasten und die browserseitige Vorwärtsnavigation.

Erfasst werden alle Hauptseiten, Einstellungen, Personal-Unterbereiche,
Verkaufsanalyse-Untermenüs, Antragsarten, Dashboard-Modi und Prozessauswahl.
Dienst- und Urlaubsplanung berücksichtigen die Filiale und Abteilung. Im Portal
bleiben außerdem Freigabearten und bestehende Aufgaben-Deeplinks erhalten.
Schulungen sind nun ebenfalls als Portalziel normalisiert.

Neuladen stellt die gewählte Seite wieder her. Der erste Aufruf ersetzt nur den
aktuellen Eintrag; es wird kein künstlicher Rücksprung eingebaut. Nach dem
ersten GP-Eintrag führt weiteres Zurück regulär zur zuvor besuchten Website.
Formulare, Berichtsparameter und personenbezogene Inhalte werden nicht in den
neuen Verlauf geschrieben und Aktionen nicht erneut abgeschickt.

Die Wiederherstellung durchläuft die bestehenden Seiten- und Rechteprüfungen.
Nicht mehr erlaubte Ziele führen zur erlaubten Startansicht. Abmeldung stoppt
die interne Wiederherstellung. Verspätete Antworten früherer Filialwechsel
dürfen den aktuellen Kontext nicht überschreiben.

## Prüfung

- 94 Berichts-, Kassen-, Import-, Worker-, Rechte- und Routentests erfolgreich.
- 55 Persistenz-, Katalog-, Dialekt- und Vertragstests erfolgreich.
- 110 Navigations- und angrenzende UI-Prüfungen erfolgreich, darin 13 neue
  Verhaltenstests für Verlauf, Rechte, Filialkontext und verspätete Antworten.
- Weitere 47 Prüfungen für Anmeldung, Abmeldung, Zugangsdaten, Funktionssuche,
  persönliche Aktionen, Portalaufgaben und Dashboards erfolgreich.
- Nach der letzten PDF-Abstandskorrektur alle sechs PDF-Prüfungen erneut
  erfolgreich, einschließlich 939 Gruppen und sechs Kennzahlen.
- Gerenderte synthetische PDFs in Hoch-/Querformat sowie Ring- und
  Retourendarstellung visuell kontrolliert. Die endgültige Querformatfassung
  mit zehn Herstellern hat sechs Seiten und keine verwaiste Hinweisseite.
- Berichtsauswahl im Browser bei 1920, 1366, 1100 und 390 Pixeln geprüft:
  Schaltjahr, manueller Vergleich, Zehnergrenze, vollständige Namen,
  Tastaturbedienung, Dunkelansicht und kein horizontaler Seitenüberlauf.
- Echter GP in isolierten lokalen Datenbanken geprüft: Verwaltung mit und ohne
  Portalpflicht, Untermenüs, zwei Testfilialen, Vorwärts, Zurück und Neuladen.
  Im Portal außerdem Schulungen und mobile Navigation bei 390 Pixeln. Nach
  Abmeldung blieb die Anmeldung trotz Browser-Zurück sichtbar; keine
  JavaScript-Fehler in den geprüften Durchläufen.

Prüfprotokolle liegen lokal unter `tmp/sales-form-final-report-tests.log`,
`tmp/sales-form-final-provider-tests.log`, `tmp/sales-form-final-pdf-tests.log`
und `tmp/navigation-regression-tests.log` sowie
`tmp/navigation-auth-regression-tests.log`. PDF-Beispiele sind ausschließlich
synthetisch unter `tmp/pdfs/sales-form-20260910-final/` abgelegt.

## Veröffentlichungsstand

Die gemeinsame Bereitstellung erfolgte am 11.09.2026 aus Quellcommit `2df6dfe`
als v0.92.36-beta. Der installierte Worker erzeugte die beiden geprüften
Originalabfragen vollständig; alle begleitenden Bereitschaftsproben bestanden.
Die Berichtspause wurde anschließend kontrolliert aufgehoben. Es gab keinen
Produktivimport und keinen vollständigen Ubuntu-Neustart. Das frühere Paket
`release/server-linux-2177276` bleibt ausschließlich ein historischer Hotfix-Nachweis.
Für die geänderten Regeln sind neue Berichtsaufträge erforderlich.
