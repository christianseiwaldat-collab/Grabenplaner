# Block 4: Auslieferung und kontrollierte Kassenuebernahme

Am 07.09.2026 wurde Block 4 nach Abschluss der lokalen Kassenanbindung
ausdruecklich gestartet. Der Releasekandidat ist v0.92.28-beta auf
`feature/schedule-pdf-day-separators`. Der bestehende TradeFoto-Katalog bleibt
erhalten. Ein erneuter vollstaendiger Trade-Aufbau gehoert nicht zu diesem Lauf.

## Vor dem Paketbau bestaetigt

- Installiert: v0.92.27-beta, Commit `41e6d92e5fc95c30a4ecb11d478802a930ea44e1`,
  Linux-Runtime 4 und separat gebundenes Offsite-Modul 6.
- Die internen und oeffentlichen Live-/Ready-Pruefungen antworten jeweils 200.
  SQLite-Integritaet ist `ok`, Fremdschluesselfehler: 0. Der Personalbestand
  umfasst 18 Personen. Freier VPS-Datentraeger: rund 72,43 GB.
- Der neue Runtime-5-Uebergang wurde gegen die vorhandenen Artefakte des
  installierten Quellcommits geprueft. Alle verwalteten Runtime-Dateien bleiben
  bis auf die beiden bestaetigten Start-/Stoppfenster bytegleich. Das
  Host-Hardening behaelt seinen bisherigen Fingerprint.
- Die vorhandenen funktionalen Kassen-, Dienstplan- und Samstagsnachweise
  wurden um gezielte Release-/Migrationspruefungen ergaenzt. Alte
  Versionsannahmen in den Vertragstests wurden an Runtime 5/Offsite 7 angepasst.

## Reihenfolge

1. Geprueften Commit und neutrales Serverpaket erzeugen; nur den zugehoerigen
   Branch veroeffentlichen. Absichtlich unversionierte Ausgabeordner erhalten.
2. App, Runtime 4 -> 5 und Offsite 6 -> 7 mit dem expliziten Migrationswerkzeug
   unter gemeinsamer Wartungssperre ausliefern. Vor dem App-Tausch sichern
   die vollstaendig geprueften Kandidatenwerkzeuge den gekoppelten Bestand
   lokal; der vorhandene Offsite-Hook sichert ihn auf Drive. Die unveraenderte
   Alt-Historie wird beim Uebergang weder bereinigt noch erneut voll gelesen.
3. Beide lokalen Sicherungsarchive mit vorhandenem Vault initialisieren und
   aktivieren. Ein Stand je Kalendertag, 20 Tage pro Bereich; kein pauschales
   Loeschen alter Rohsicherungen zur Finanzierung des Imports.
4. Die freigegebene Samstagsumstellung fuer vorhandene Verkaufsmitarbeitende
   aktivieren und den einmaligen Beleg gegen den Personalbestand pruefen.
5. Die zuletzt bereitgestellte Kassen-ACCDB persoenlich angemeldet importieren,
   ausdrueckliche GP-Zuordnungen bestaetigen und den vollstaendig geprueften
   Stand aktivieren. Ein alter Export darf bis zum naechsten Upload gelten.
6. Installierten App-/Offsite-Betrieb, gekoppelten Restore und den vollstaendigen
   signierten Assurance-Abschluss pruefen. Erst danach den produktiven
   Abschluss vermerken.

Diese Vorbereitung ist kein Beleg einer bereits erfolgten Installation oder
Kassenaktivierung. Paket-, Migrations- und Betriebsbelege werden nach dem
tatsaechlichen Lauf ergaenzt. Vorhandene alte fehlgeschlagene Systemd-Instanzen
werden nicht durch ein pauschales Zuruecksetzen der Fehlerliste verdeckt.
