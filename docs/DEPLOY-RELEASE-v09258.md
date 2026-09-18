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

### Paket und Quellprüfung

- Runtime-Commit: `736cc4dd7b00413ca3e6cb3eafba1e84a1d80c5e`.
- Paket: `Grabenplaner-Server-v0.92.58-beta-linux-x64.zip`, 746 Manifestdateien.
- Paket-SHA-256: `6228b93267864f39149cc6e4fea453bdba9af86e07c1fb07e0f82e42faa9fe22`.
- Manifest-SHA-256: `a6e653d4e056d3bdcb0397016e36fc328a1d58a6939498d2b1699332a1e5135f`.
- Alle vier [CI-Jobs](https://github.com/christianseiwaldat-collab/Grabenplaner/actions/runs/35291872375) erfolgreich:
  Linux 3627 bestanden / 78 übersprungen, Windows 3605 bestanden / 100
  übersprungen, jeweils 3705 Tests ohne Fehler. Mindest-Node 50/50 und
  PostgreSQL-Vertrag 125/125 bestanden. Die ursprünglichen 26 Fehler sind
  einzeln als ausgeführte und bestandene Fälle abgeglichen.

### Gezielte Vorwärtswiederherstellung

Die eingefrorenen Produktionsabhängigkeiten wurden isoliert installiert und
mit dem vorhandenen Installationsbaum-Prüfer geprüft. Der vollständige
Virenscan blieb ohne Fund. Ein anschließend irrtümlich auf den installierten
Abhängigkeitsbaum angewendeter Quellpaket-Prüfer lehnte erlaubte interne
Symlinks ab. Der Fehlerbeleg blieb erhalten. Der geprüfte Inhalt wurde mit
Einzelhashes aller Manifestdateien und dem vorgesehenen Installationsbaum-
Prüfer erneut validiert, ohne den erfolgreichen Scan zu wiederholen.

Unter der bestehenden Wartungssperre wurde die kompatible App eingesetzt.
Vor und nach dem Tausch blieben das Datenbankpaar, seine Strukturen, die
geprüften Bestände in 22 Tabellen und die Import-Checkpoints identisch.
Es erfolgte kein Daten-Rollback und keine erneute produktive Migration.

Das Offsite-Modul wurde über seinen bestehenden expliziten Installer
aktualisiert. Provider, Repository, Installationsidentität, Binärversionen und
Zugangsdaten blieben unverändert. Neuer Modul-Fingerprint:
`58e577b200ad734ade73cb70763b0a894057d9333c4b8d6ced5136a4a0121848`.
Temporäre Installer-Kopien der Zugangsdaten wurden anschließend entfernt.

Die vier internen/öffentlichen Live- und Bereitschaftsprüfungen bestanden.
Am 18.09.2026 um 00:56 UTC wurden zusätzlich die öffentliche Versionsanzeige,
neun ausgelieferte Assets, der integrierte Einkaufsbereich, MHTML-Eingabe und
Bestellnummernsuche gegen den unveränderlichen Paketstand geprüft.

### Ergebnis der vollständigen Wiederherstellungsprüfung

Die vollständige Sicherungs- und Wiederherstellungsprüfung lief unter dem
signierten Auftrag `1e0489b8-a93d-4f22-9e57-2e074a66aed9`. Für dessen neue
gemeinsame Sicherung wurde der GP nochmals kontrolliert angehalten. Seit
01:13 UTC antwortet er wieder öffentlich mit Bereitschaft 200.
Sicherung und vollständige Repository-Prüfung bestanden. Der native Worker
`d3839f06-8f07-4b39-b173-cd1b15b8d138` erreichte jedoch am 18.09.2026 um
02:15:01 UTC seine äußere Laufzeitgrenze von 30 Minuten. Er hatte 23 Minuten
30 Sekunden CPU-Zeit verbraucht und war auf 1,5 GiB begrenzt. Die isolierte
Datenbank war nach dem Indexaufbau noch mit einer Fremdschlüsselprüfung
beschäftigt (`ALTER`, `DataFileRead`); der letzte Lesestatus stammt von
02:14:15 UTC. Es gab keinen Speicherabbruch. Das Journal meldet `timeout`,
das native Werkzeug anschließend `terminated by user`.

Damit besitzt v0.92.58 keinen erfolgreichen vollständigen Recovery-Nachweis.
Die kompatible produktive App blieb aktiv; es erfolgte kein erneuter
Code- oder Daten-Rollback. Die gestaffelten Grenzen werden in
[v0.92.59](DEPLOY-RELEASE-v09259.md) korrigiert. Der gleichzeitig fällige
Nachtlauf wurde vor dem Erwerb der Wartungssperre kontrolliert gestoppt;
kein zusätzlicher Assurance-Auftrag begann. Die temporäre Startmaskierung
ist entfernt, der aktive Timer plant wieder den nächsten regulären Lauf.
Die Belege aller fehlgeschlagenen Versuche bleiben erhalten.
Es wurden keine Access-Laufzeitbenchmarks gestartet.
