# Mitarbeiterportal und mobile Dienstplanung – Prüfung vom 8. September 2026

Stand: lokal umgesetzt und geprüft; VPS-Veröffentlichung als v0.92.30-beta
freigegeben und in Vorbereitung. Ausgangspunkt ist
`694b7093a0cfa6b96e2f731e5aba570857c58d03` auf
`feature/schedule-pdf-day-separators` (v0.92.29-beta).

## Änderungen

| Bereich | Befund und Umsetzung |
| --- | --- |
| Persönliche Leihe | Die vorhandenen persönlichen Leihrechte werden durch das standardmäßig aktive Einzelrecht `loans:self:use` gemeinsam verwaltbar. Ein persönlicher Entzug sperrt eigene Leihen, Ausgabe, Rücknahme und die allgemeine Geräteübersicht serverseitig. Gesonderte Verwaltungsrechte bleiben getrennt. |
| Filialleitung | FL kann dieses Einzelrecht für aktive normale Mitarbeitende im eigenen, vollständig verwalteten Standort entziehen und wiederherstellen. Bei diesen Personen zeigt der Rechteeditor ausschließlich diesen Schalter. Die bestehende Verwaltung von AL-Grundrechten bleibt erhalten. Fremde Standorte, Rollen, Zusatzrechte und Geltungsbereiche werden dadurch nicht freigegeben. |
| Nachvollziehbarkeit | Änderungen laufen durch die bestehende Rechte-API, werden protokolliert und widerrufen bestehende Sitzungen. Ein entzogenes eigenes Leihrecht nimmt der FL nicht die zulässige Rechteverwaltung für ihr Team. |
| Zeitausgleich und Urlaub | Direkte Schaltflächen auf der mobilen Startseite, unter „Anträge“ und im persönlichen Dienstplan. Die Antragsformulare führen zurück zu „Meine Anträge“. „Zeitausgleich“ wird ausgeschrieben. |
| Mobile Navigation | Standardmäßig Start, Zeit, Dienstplan, Anträge und Mehr. Persönlich angepasste Menüs bleiben erhalten; Mehr bleibt auch bei längeren Menüs erreichbar. ZA und Urlaub markieren mobil den zugehörigen Bereich Anträge. Tabwechsel führen zum Anfang und fokussieren die Überschrift. |
| Portalaufteilung | Kompakter Kopf ohne abgeschnittene Einstellungsbeschriftung, zwei Spalten für Start- und Mehr-Kacheln, angepasste Datumsfelder und berührbare Formularoptionen. |
| Mobile Leihe | Eigene Leihen zuerst, „Neue Leihe erfassen“ aufklappbar. Die Geräteübersicht verwendet schmale Karten mit Feldbeschriftungen und bestehender Suche. Sie enthält nur die bereits erlaubten Spalten. Ausgabe, Rücknahmedialog und berechtigte Verwaltungsfunktionen bleiben erreichbar. |
| Dienstplanung | Gelber Hinweis zur Bildschirmgröße entfernt. Wochennavigation bleibt sichtbar; „Planaktionen & PDF“ und „Wochenübersicht“ sind mobil standardmäßig eingeklappt. Bei großer Schrift umbrechen Woche und Datum, bevor die Bedienung zu eng wird. Am Desktop bleiben die Bereiche geöffnet. |
| Hauptmenü | Menüknopf überdeckt die Überschrift nicht mehr. Kompaktere Marke, Sitzung, Navigation und Symbolbeschriftungen; ausreichend große Aufklappschalter. Der gesamte Menüinhalt ist auch bei niedriger Bildschirmhöhe scrollbar. Der Tastaturfokus berücksichtigt sichtbare Einträge. |
| Querformat | Mobile Gestaltung bis 1100 Pixel bei grobem Zeiger, kompaktere Anordnung der Planungsüberschrift und bedienbare Dialoge. Touch-Geräte mit Desktop-Browserkennung behalten in diesem Bereich die mobile Navigation. |

## Prüfung

Alle schreibenden Prüfungen verwenden eine isolierte lokale Datenbank mit
synthetischen Mitarbeitern und Artikeln. Es wurden keine echten Anträge,
Leihen oder Rechteänderungen auf dem VPS erzeugt und keine E-Mails versendet.

- Gezielte Regressionen: 93 Tests bestanden; zusätzliche Navigations- und
  Leihregressionen: 38 Tests bestanden. Abschließender Lauf nach den letzten
  Funktionsänderungen: 54 Tests bestanden. Die Läufe überschneiden sich;
  die Zahlen sind nicht als Anzahl eindeutiger Tests zu addieren.
- Browsermatrix: 78 Prüfpunkte für normale Mitarbeitende, AL, FL und
  Administration; 320×568, 390×844, 844×390 und 932×430 sowie Desktop 1440×900.
  Kein seitlicher Seitenüberlauf und keine JavaScript-Laufzeitfehler.
  Nach den Änderungen an der Wochenübersicht wurden 34 betroffene Punkte
  erneut erfolgreich geprüft.
- Gefüllte Leihe und Rechteeditor: neun zusätzliche erfolgreiche Prüfungen,
  einschließlich Suche in einer längeren Liste, Artikelauflösung,
  Rücknahmedialog in Hoch- und Querformat und echtem Entzug/Wiederfreigabe
  durch den FL-Rechteeditor mit anschließender regulärer Mitarbeiteranmeldung.
- Weitere acht erfolgreiche Prüfungen: ZA-Moduswechsel, Sperre eines
  umgekehrten Urlaubszeitraums, Planung und vollständig erreichbares Menü
  in Hoch- und Querformat mit 100 und 150 Prozent App-Schriftgröße.
- Syntaxprüfungen und `git diff --check` erfolgreich. Das Persistenzinventar
  klassifiziert den neuen isolierten Rechtetest; keine unklassifizierten
  Kopplungen oder Phasengrenzverletzungen.

Die Browserprüfung verwendet Chrome mit emuliertem Touch-Viewport. Native
Handy-Tastaturen, Kamera und gerätespezifische Browser wurden damit nicht
auf echter Hardware abgenommen. Der Dienstplan selbst bleibt bei vielen
Spalten bewusst innerhalb seines Planbereichs horizontal scrollbar.

Lokale Belege liegen unter `tmp/mobile-review/`: `full-matrix-report.json`,
`report.json`, `actions-report.json`, `extra-report.json` und Screenshots.
Die Testprotokolle liegen unter `tmp/mobile-*.log`. Eine in den synthetischen
Screenshots sichtbare rote Sicherungswarnung stammt aus der isolierten
Testinstallation; sie ist unabhängig vom entfernten gelben Mobilhinweis.

## Produktiver Stand und nächste Schritte

Die lesende Prüfung ergab: Das Leihmodul ist installiert und Standort 18 ist
freigeschaltet. Die vorhandenen Rollenrechte enthielten bereits die
persönlichen Leihfunktionen; persönliche Leihrechtsentzüge wurden nicht
gefunden. Bei Standort 11 fehlt die Standortfreigabe trotz aktivem
persönlichem Mitarbeiterzugang.

Standort 11 bleibt gemäß der abschließenden Festlegung vom 8. September 2026
ohne Leihfreigabe. Die Veröffentlichung verändert keine Standortfreigaben
oder Nachschlageeinstellungen. Eine Browseranmeldung zur Aktivierung von
Standort 11 ist nicht mehr erforderlich.

Die Programmänderungen werden über den bestehenden Releaseweg mit Paket-
und VPS-Prüfung veröffentlicht. Der Abschluss wird getrennt belegt.
Ein produktiver Datenimport ist nicht Bestandteil dieser Veröffentlichung.
