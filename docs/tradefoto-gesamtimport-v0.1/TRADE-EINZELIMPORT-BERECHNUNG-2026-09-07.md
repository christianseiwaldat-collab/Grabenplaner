# Berechnung des einzelnen TradeFoto-Imports

Aktuelle Entscheidung: [Gesamte Kasse im schlanken GP-Prototyp](KASSE-VOLLBESTAND-GP-PROTOTYP-2026-09-07.md), ohne 24-Monate-Grenze. TradeFoto bleibt mit allen 395.163 Zeilen im bisherigen Importumfang; auf die unbedeutenden 370 potenziell entbehrlichen Zeilen wird ausdrücklich verzichtet. Die folgende vollständige Trade-Berechnung bleibt deshalb die passende Vergleichsgrundlage.

Stand: 07.09.2026. Es wird ausschließlich `Trade_Daten.accdb`, die kleinere Quelle, betrachtet. Grundlage ist der bereits abgeschlossene vollständige Messlauf: Trade wurde darin vollständig verarbeitet, bevor die Kassenquelle begann. Die Berechnung verwendet die erhaltenen Phasenmessungen; es wurde kein neuer Import gestartet.

## Abgegrenzte Messwerte

| Größe | Nur TradeFoto |
| --- | ---: |
| Ursprüngliche Access-Datei | 188.649.472 Bytes = 188,65 MB |
| Erfasste Tabellen | 102, davon 83 mit Zeilen und 19 leer |
| Verarbeitete Quellzeilen | 395.163 |
| Einlesen und geschützte Zwischenablage | 335.219 ms = 5 min 35 s |
| Prüfung und Vorbereitung | 449.670 ms = 7 min 30 s |
| Übernahme | 3.467.872 ms = 57 min 48 s |
| Summe dieser Importphasen | 4.252.761 ms = 1 h 10 min 53 s |
| Beobachtete Spitze der Datenbank samt WAL/SHM | 3.527.423.472 Bytes = 3,53 GB |
| Beobachtete Spitze des Node-Arbeitsspeichers | 1.152.155.648 Bytes = 1,15 GB |
| Separat kompaktierte Trade-Endgröße | Nicht gemessen |
| Separates Trade-Backup | Nicht gemessen |

Alle Zeilen der nicht leeren Trade-Tabellen sind im Bericht als angewendet gezählt, die Tabellen abgeschlossen und ihre Gates leer. Die im Gesamtbericht noch als `ready` bezeichnete Quellvorschau ist der frühere Prüfzustand; der gesonderte Übernahmeabschluss ist `apply=applied`. Die Messung verwendet den tatsächlichen Import-Writer, jedoch eine isolierte Datenbank mit synthetischen Zuordnungszielen und einem flüchtigen Testschlüssel.

Die Größen sind dezimale MB/GB. Die Speicherwerte sind beobachtete Stichprobenspitzen, keine garantierten Obergrenzen. Der Node-RAM-Wert umfasst weder den Java-Reader noch andere Prozesse. Der gesamte Ablauf enthält Prüf- und Wiederaufnahmeschritte; die gemessene Dauer ist keine Zusage für jede Installation.

## Beweis der Trennung von der Kassenquelle

Zeile 410 in `tmp/full-stock-20260906-213054.stdout.log` beendet `trade:apply` mit 395.163 verarbeiteten Zeilen, nach 4.253.939 ms Gesamtlaufzeit und einer bisherigen DB-Familienspitze von 3.527.423.472 Bytes. Erst Zeile 411 beginnt `cash:stage`, nach 4.254.714 ms. Es gibt keinen späteren Trade-Abschnitt und keinen früheren Kassenabschnitt im Messprotokoll. Die kleine Differenz zwischen der Summe der Phasendauern und dem Abschlusszeitpunkt entsteht durch Vorlauf und weitere Kontrollschritte.

| Importphase | Bis dahin beobachtete maximale Größe von DB + WAL + SHM |
| --- | ---: |
| Einlesen | 760.303.048 Bytes |
| Prüfung | 903.376.328 Bytes |
| Übernahme | 3.527.423.472 Bytes |

Der Messcode speichert die höchste bis dahin beobachtete Größe der drei Dateien zusammen. Daraus lässt sich weder die reine Datenbankdatei am Abschluss noch ihre Größe nach einer separaten Kompaktierung bestimmen. Die später gemessenen 11,60 GB Datenbank und 5,33 GB Archiv gehören zum Gesamtbestand aus Trade und Kasse. Sie werden hier weder übernommen noch proportional nach Dateigröße oder Zeilenzahl aufgeteilt.

Vor der ersten Kassenübernahme sind 133.733 Stammdatensätze, 261.430 Historieneinträge, ebenso viele Historienversionen und 498.260 Stammdaten-Haltebeziehungen vorhanden. Diese Zieldaten stammen aus dem abgeschlossenen Trade-Import. Zusätzlich bestehen Importzeilen, Änderungen, Verknüpfungen und weitere Nachweise. Eine Auswertung der tatsächlichen Bytes je Tabelle und Index fehlt weiterhin.

## Planbarer gezielter Folgeversuch

Für einen eigenen Trade-Prüflauf kann ein Datenbanklimit von **4 GiB** und ein zusätzliches WAL-Limit von **2 GiB** angesetzt werden. Das sind Abbruchgrenzen eines kontrollierten Versuchs, keine Vorhersage der endgültigen Datei. Die bisher beobachtete Spitze von DB und Journal zusammen liegt unter dem vorgeschlagenen Datenbanklimit.

Der vorhandene Phasen-Budgetrechner ergibt damit **29.527.900.160 Bytes = 29,53 GB** benötigten Startfreiraum. Enthalten sind Kompaktierung, drei konservativ als Vollkopien budgetierte Archivpunkte, sequenzielle Rücksicherung, Metadaten und **10 GiB Reserve**. Es werden keine Kompressionsersparnis und keine Löschung vorhandener Sicherungen angerechnet. Beim Berechnen waren auf C: rund 136,53 GB frei; die Start-Platzprüfung dieses vorgeschlagenen Versuchs besteht.

Der bisherige Vollmessungs-CLI verlangt weiterhin beide Quellen. Ein ausschließlich auf Trade begrenzter Messeinstieg wäre dafür gesondert einzurichten und müsste die obigen Grenzen durchsetzen. Er soll vor allem die noch fehlenden Werte liefern: reine kompaktierte Trade-Datenbank, Speicheranteile der Tabellen/Indizes, eigener Archivpunkt und dessen Rücksicherung. Die aktuelle Rechnung startet diesen Versuch nicht und erteilt keine VPS-Betriebsfreigabe.

## Nachweise

- [Maschinenlesbare Berechnung](TRADE-EINZELIMPORT-BERECHNUNG-2026-09-07.json), einschließlich SHA-256 der zugrunde liegenden Berichte und exakter Phasenwerte.
- Ursprünglicher vollständiger Messbericht: `tmp/tradefoto-block3-2Ap4l0/report.json`.
- Phasenprotokoll: `tmp/full-stock-20260906-213054.stdout.log`, besonders Zeilen 410 und 411.
- Berechnungsskript: `tmp/calculate-trade-only-import-20260907.cjs`.

Alle zwölf Implementierungsdateien der Originalmessung sind unverändert. Die ursprüngliche Testdatenbank wurde wie vorgesehen nach dem damaligen Lauf entfernt. Kein neuer Import, keine Änderung der Quelldateien, kein Commit, Push oder Deploy.
