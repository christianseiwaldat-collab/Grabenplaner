# Block 6 – Testimport, Abschlussprüfung und offene Abnahme

Stand: 05.09.2026. **Technische Prüfungen lokal umgesetzt; fachlicher Summenabgleich und Produktivfreigabe noch offen.** Kein Commit, Push, Deploy oder produktiver Import.

Nachfolgende Freigabe: [Veröffentlichung v0.92.27 Beta](RELEASE-v09227.md). Die dort erlaubte Codeveröffentlichung hebt die fachlichen Importgates nicht auf; der folgende Prüfbericht bleibt der historische lokale Abnahmestand.

## Quellenprüfung und abgesicherter Testimport

Der Offline-Prüfer [verify-tradefoto-test-import.mjs](../../scripts/verify-tradefoto-test-import.mjs) liest nur die zwei bereits inventarisierten ACCDB-Dateien. SHA-256, Größe und unveränderte Originaldateien werden kontrolliert. Verknüpfte Datenbanken, Access-Makros, externe Medienpfade und Netzwerkquellen werden nicht geöffnet.

Der [abschließende maschinenlesbare Bericht](BLOCK-6-TEST-REPORT-FINAL.json) enthält ausschließlich Zähler, Tabellen-/Feldnamen und Prüfcodes, keine Kunden-/Mitarbeiternamen, Kennwörter oder Quellfeldinhalte.

| Prüfung | Ergebnis |
| --- | --- |
| Fachlich registrierte Tabellen | 109 |
| Vollständig gelesene und typvalidierte Quellzeilen | 1.477.216 |
| Typfehler im abschließenden Lauf | 0 |
| Kassenbelegköpfe / Verkaufspositionen validiert | 219.885 / 385.798 |
| Tatsächlich testimportierte Quellzeilen | 1.041 |
| Davon geschützte Stammdaten / Historienzeilen | 541 / 500 |
| Getrennte Testimporte und idempotente Wiederholungen | 88 / 88 |
| Feldgenauer verschlüsselter Schreib-/Leseabgleich | 1.041 von 1.041 |
| Wiederanlauf nach Schließen/Öffnen der Testdatenbank | Bestanden |
| Rücknahme sämtlicher Test-Zieldatensätze und Holds | Bestanden; alle Zielzähler wieder 0 |
| SQLite-Integrität / Fremdschlüssel | Bestanden |
| Originaldateien nach Lesen unverändert | Beide bestätigt |

Dies ist **kein vollständiger Import von 1,48 Millionen Zeilen**: alle Zeilen wurden validiert, eine ausdrücklich begrenzte Auswahl wurde tatsächlich importiert. Die Auswahl enthält vollständige Mitgliedschaften für 60 ausgewählte Kassenbelegköpfe und die zugehörigen 69 Positionen sowie ausgewählte Journal-, Stamm- und sonstige Historienzeilen. Lange und ungewöhnliche Memos sind ausdrücklich in die Auswahl einbezogen.

Jede Auswahl ist ein eigener, verschlüsselter Testexport mit eigener Manifestidentität und eigenem Test-Quellnamensraum. Die ACCDB-Gesamtzeilenzahl wird nicht durch eine Stichprobenzahl ersetzt. Verwendet wird eine frisch erzeugte temporäre Datenbank, niemals die bestehende GP-Datenbank. Schlüssel bestehen nur im Prozess; Testdateien werden danach entfernt. Kontrollierte Rücknahme berücksichtigt die tatsächlichen Quellabhängigkeiten und versucht zunächst deren abhängige Läufe. Keine erzwungene Entfernung von Holds; ein echter Zyklus würde die Rücknahme stoppen.

26 weitere Tabellen mit 32.490 Zeilen sind im Ausgangskatalog inventarisiert, aber als alte Zugangs-/Konfigurations-/Technikarchive nicht über diese Fachadapter aktiviert. Zugangsdaten werden nicht zu GP-Zugängen. Zwei Kennwortspalten bleiben ausdrücklich ausgeschlossen. Externe Bilder/Dokumente sind weiterhin nicht durch die zwei ACCDB-Dateien vollständig abgedeckt.

## Durch Echtdaten gefundene und behobene technische Fehler

1. **Nachkommastellen:** Access-Double-/Float-Quellwerte werden nun auch im Stammdatenarchiv verlustfrei als `source_decimal` übernommen. Die zuvor zu enge Zwölf-Nachkommastellen-Grenze hätte zahlreiche gültige Quellwerte abgewiesen. Currency-Felder und operative Preisvalidierung bleiben getrennt; keine stillschweigende Preisrundung oder Änderung aktueller GP-Preise.
2. **Quellmemos:** 16 Artikel enthalten lange Texte bzw. alte Steuerzeichen (10 lange Texte, 6 mit Steuerzeichen; Feldüberschneidungen möglich). `source_text` bewahrt originale Memo-Inhalte ausschließlich innerhalb der geschützten Quellenablage. Normale Geschäftstexte, CRM-Eingaben und Größenlimits bleiben validiert. Nichts wird ausgeführt, abgeschnitten oder automatisch bereinigt. Für eine spätere sichtbare/operative Übernahme bleiben diese Textqualitätsbefunde kenntlich.
3. **Rücknahmereihenfolge:** Bereits früher importierte Kindtabellen können spätere Stammdatensätze referenzieren. Der Testablauf entfernt abhängige Läufe zuerst, anstatt alphabetische bzw. reine umgekehrte Importreihenfolge als Abhängigkeitsreihenfolge anzunehmen.

Die Zwischenberichte [Erstlauf](BLOCK-6-TEST-REPORT.json) und [Dezimal-/Rücknahmekorrektur](BLOCK-6-TEST-REPORT-VERIFIED.json) bleiben als technische Nachweise erhalten; maßgeblich ist ausschließlich der Finalbericht.

## Noch offene fachliche Abnahme

**Q01 – deklarierte Zeilenzähler:** `ARTIKEL_STAMM` meldet 19.187, gelesen werden 19.186; `ARTIKEL_FILIALEN` meldet 231.355, gelesen werden 231.351. Eine zusätzliche Zählung aller zugehörigen physischen Datenseiten bestätigt jeweils genau die gelesene aktive Zeilenanzahl. Diese Zählung nutzt jedoch denselben vorhandenen Codec und ist **kein unabhängiger Access-Engine-Abgleich**. Es wird weder eine fehlende Zeile erfunden noch pauschal behauptet, die Differenz entspreche gelöschten Datensätzen. Das Produktiv-Manifestgate bleibt geschlossen.

**Q02 – tatsächlicher Umsatz:** bestätigte TradeFoto-Berichte und eindeutige Beispiele für Verkauf, Rückgabe und Storno fehlen. Ohne sie sind Statusbits, Preisbasis, Rabatte, Steuern und Belegsumme nicht fachlich freigegeben. Synthetische korrekte Rechentests ersetzen diese Abnahme nicht. Insbesondere wird `AStorno` nicht nach Vermutung interpretiert. Die Frage nach den benötigten Quellbeispielen wurde gestellt.

**Weitere Übernahmeentscheidungen:** bestätigte Standort-/Personal- und Kundenverknüpfungen, historische Fehlreferenzen, Datumsfälle, verfügbare externe Medien sowie produktiver Schlüsselbetrieb, Rechte und Aufbewahrung bleiben vor einer Aktivierung abzuarbeiten. Unternehmensweite Produktionslast und vollständige Großdatenübernahme sind mit dem begrenzten Schreibtest nicht abgenommen. Vorher kein ungeprüfter Gesamtumsatz und kein Aktivierungsschalter für Echtdaten.

## Reproduktion und Tests

```text
node --max-old-space-size=4096 scripts/verify-tradefoto-test-import.mjs TRADE.accdb CASH.accdb NEUER-BERICHT.json
node scripts/build-tradefoto-master-metadata.mjs
node scripts/build-tradefoto-history-metadata.mjs
node scripts/render-tradefoto-catalog.mjs docs/tradefoto-gesamtimport-v0.1/catalog.json --check
node --test --test-concurrency=1 test/data-import-foundation.test.js test/tradefoto-master-data.test.js test/tradefoto-history.test.js test/sales-history-access-routes-ui.test.js
node --test --test-concurrency=1
git diff --check
```

Der abschließende vollständige App-Prüflauf bestand mit **2.801 erfolgreichen Tests, 40 bewusst übersprungenen Tests und keinem Fehler** (448,6 Sekunden; insgesamt 2.841 Tests). Er umfasst die abschließende Memo-Korrektur und den tatsächlichen App-Starttest für Developer-/Standardrollen. Anschließend wurde die explizite Geschäftstags-Komposition zusätzlich abgesichert und fokussiert nachgeprüft. Die 112 fokussierten Import-/Historien-/Rechte-/UI-Tests sind ebenfalls erfolgreich.

PostgreSQL-Verträge/SQL-Portabilität sind geprüft; die optionalen PostgreSQL-Livetests bleiben mangels Testserver übersprungen. Browser-/Chrome-Steuerung, visuelle Abnahme und Infrastrukturänderungen fanden nicht statt.
