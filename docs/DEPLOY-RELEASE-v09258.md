# Release v0.92.58 Beta

## Anlass

Der v0.92.57-Deploy hatte App, Datenmigration und Live-Betriebsprüfungen bereits
erfolgreich durchlaufen. Der anschließende isolierte Wiederherstellungstest wurde
jedoch durch das weiterhin auf 15 Minuten begrenzte untergeordnete `pg_restore`
abgebrochen. Der äußere Worker hatte bereits 30 Minuten. Der automatische
Code-Rollback beließ die additive PostgreSQL-Migration und alle Nutzdaten intakt;
die alte App blieb wegen des inkompatiblen Schemas gestoppt.

## Korrektur und Wiederherstellung

- `pg_restore` erhält 30 Minuten; sonstige native Werkzeuge behalten 15 Minuten.
  Der isolierte Worker behält seinen Gesamt-, CPU- und Speicherrahmen.
- Drei Uhr-gesteuerte Regressionstests prüfen Erfolg nach 29 Minuten, Abbruch bei
  30 Minuten, bereinigte Timer und unveränderte Grenzen anderer Werkzeuge.
- Die Korrekturen der ursprünglichen 26 CI-Fehler sowie der zusätzlichen
  Windows-Fixture- und Checkout-Probleme sind enthalten.
- Die gezielte Vorwärtswiederherstellung installiert ein geprüftes, zum bereits
  migrierten Datenbankpaar passendes Paket. Sie setzt keine Daten zurück.
  Der fehlgeschlagene Updater-Beleg bleibt unverändert erhalten.

## Status

Paketierung, Wiederherstellung und abschließende Betriebs-/Offsite-Verifikation
sind noch offen. Dieser Bericht dokumentiert bis dahin keinen erfolgreichen
Deploy. Es werden keine Access-Laufzeitbenchmarks gestartet.
