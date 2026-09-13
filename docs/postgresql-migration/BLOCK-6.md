# Block 6: TradeFoto und Artikelstamm

Stand 12.09.2026. In der isolierten Entwicklungsumgebung abgeschlossen; keine produktive Anbindung.

Zusätzlich zu Kassa sind 34 Tabellen, 25 Quellindizes und 29 übertragene Trigger angelegt. Der kumulative Sales-Katalog umfasst 194 erfolgreich vorbereitete SQL-Anweisungen. Preise verwenden `NUMERIC(30,12)`; führende Nullen in Artikelnummern bleiben erhalten. Binärbilder werden als `bytea` gespeichert und vor Ausgabe anhand Länge und SHA-256 geprüft.

## Fachlicher Nachweis

- Alle 66 Trade-Masterprofile wurden über den bestehenden Importablauf eingelesen, geprüft und angewendet. Die entschlüsselten Ansichten stimmen für sämtliche Tabellen mit SQLite überein. Die bekannten zwei Zugangsdatenfelder bleiben vom Import ausgeschlossen.
- Ein langer Quelltext mit 89.000 Zusatzzeichen bleibt verschlüsselt und unverändert erhalten. Der Import verändert keine CRM-Karte automatisch.
- Artikelimport, wiederholter Import, Groß-/Kleinschreibung bei der Suche und exakte zwölfstellige Preiswerte funktionieren. Ein Trade-Update und seine fachliche Rücknahme erhalten das eigene Bild unter der Artikelnummer; `001234` und `1234` bleiben getrennt. Veraltete Bildrevisionen und manipulierte Bildprüfsummen werden abgewiesen.
- Manuelle Anlage, Änderung, Archivierung, Wiederherstellung und Kopie funktionieren. Veraltete Revisionen und doppelte Artikelnummern erzeugen keine halben Änderungen oder zusätzlichen Audit-Einträge.
- Artikel-Audits werden bereits atomar mit der Änderung in einer Sales-Outbox gespeichert. Ihre bestätigte Zustellung an den Core folgt in Block 7.

`postgresql-migration-trade.test.js`: vier Prüfungen insgesamt bestanden. Der erste Lauf bestand Schema und manuelle Änderungen; die beiden übrigen Prüfungen wurden nach Korrektur der Testadressierung und des Vergleichs zufälliger IDs gezielt erneut ausgeführt: 2 bestanden, 0 Fehler, 0 übersprungen. Der vollständige Vergleich aller Profile dauerte über den SSH-Tunnel etwa 247 Sekunden. Das ist eine Testlaufzeit, keine interaktive Suchzeit. Zusätzlich: 29/29 Triggerproben und 194/194 SQL-Vorbereitungen.

## Grenzen

Dies sind synthetische, echte PostgreSQL-Geschäftsvorgänge. Die vollständige historische Übernahme folgt in Block 9; eine historische Gesamtparität wird hier nicht behauptet. GP-Zuordnungen und der Core-Audit-Empfang folgen in Block 7, Last- und Berichtsprüfungen in Block 8. Die produktive Freigabe bleibt geschlossen.
