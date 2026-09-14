# Release v0.92.45-beta

## Freigabe und Umfang

Am 14.09.2026 ausdrücklich mit „bitte deploy“ freigegeben. Das Paket veröffentlicht
die [dauerhafte ACCDB-Hintergrundprüfung](IMPORT-HINTERGRUND-2026-09-14.md) gemeinsam
mit den [Mobil- und Wartungskorrekturen](IMPORT-STABILITAET-2026-09-14.md).

Vollständig angenommene Dateien werden befristet verschlüsselt gespeichert und
unabhängig vom Browser eingelesen und geprüft. Vorübergehende Fehler erhalten
höchstens drei Wiederholungen; Serverneustarts übernehmen den gespeicherten
Auftrag. Die festen Ressourcen-, Integritäts- und Rechtegrenzen bleiben erhalten.
Produktive Übernahme und Kassenpublikation sind weiterhin bewusste Benutzeraktionen.

Offsite-Modul 10 führt die bisherigen beiden täglichen Sicherungsstarts in einem
gemeinsamen Nachtlauf zusammen. Zwei lokale Sicherungspaare, entfernte Aufbewahrung
und vollständige Wiederherstellungsprüfungen bleiben bestehen. Keine PostgreSQL-
Schemamigration, erneute Datenübernahme oder Änderung an Netzwerkzugängen.

## Prüfungen vor dem Wechsel

- Lesende VPS-Vorprüfung am 14.09.2026 um 12:09 CEST: v0.92.44/a498d00,
  656 Manifestdateien unverändert, GP/Caddy/PostgreSQL aktiv, vier HTTP-200-
  Prüfungen, keine konkurrierende Wartung, rund 87,96 GB frei.
- Vorbestehende 24 fehlgeschlagene systemd-Units wurden als Vergleichsstand
  erfasst, nicht pauschal quittiert. Der signierte Offsite-Status ist `ok`,
  ohne offene Sicherungs-, Archiv- oder Wiederherstellungsfehler.
- Die vorausgegangene lokale Funktionsauswahl bestand 141 Tests plus einen
  zusätzlichen mehrteiligen Datei-Test; vier Linux-Fälle waren dort übersprungen.
  Die Releaseauswahl bestand nach Korrektur zweier alter Versionsassertionen:
  zunächst 62 bestanden, zwei Versionsfehler und drei Plattform-Skips;
  anschließend alle acht betroffenen Versionsfälle bestanden.
- Das unveränderte Releasepaket wurde direkt auf Linux zusätzlich mit
  **89 bestandenen Tests, null Fehlern und null Skips** geprüft. Die Testdatenbanken,
  Quelldateien und Schlüssel waren ausschließlich synthetisch. Darunter echte
  Importablage, Verschlüsselung, Wiederaufnahme, Pause, Shutdown, Kassen-Snapshots,
  Dateischutz und Versionsübergang. Keine produktiven Importzeilen verändert.
- Persistenzaudit erfolgreich; Syntax und `git diff --check` ohne Befund.

## Paket und Ablauf

- Runtime-Commit: `ebeadc74a0e9cbeb54ba6f302048200a8a62901e`.
- Paket: `Grabenplaner-Server-v0.92.45-beta-linux-x64.zip`.
- Paket-SHA-256: `a144f9f83c607e980a51701ed1832652a2cf71b4d336bbaa1afc0bafb2c55fe3`.
- Manifest-SHA-256: `42569bc9478b3cd4949d2b97e9d0f03671283b0843222ee19c0ae078031ce2a5`.
- 659 Manifestdateien; nur 28 zum freigegebenen Umfang gehörende Runtime-Dateien
  unterscheiden sich vom alten Paket. Runtimevertrag 5, Offsite-Vertrag 10.
- Eigene Stage: `/opt/grabenplaner/.deploy-v09245-ebeadc7`.
- Eigene Unit: `grabenplaner-release-v09245-import.service`, Invocation
  `8662794c034547039d506b195f1a5673`, Start 14.09.2026 um 10:14:54 UTC.

Der bestehende Installer aktualisiert zuerst das Offsite-Modul unter Erhalt seiner
Providerbindung. Im Übergang bleibt der Vorgängerzeitplan bestehen; erst nach
passendem App-Tausch konvergiert er auf den gemeinsamen Nachtlauf. Der reguläre
transaktionale Updater erstellt die nötigen Rückkehrpunkte und prüft die neue App.
Die vorgemerkten vollständigen Assurance-Anlässe werden zu einem anschließenden
Prüflauf zusammengefasst. Temporäre Dienstmasken und Monitorpause werden im
Wrapper-Abschluss wieder aufgehoben.

## Abschlussstand

Produktiv veröffentlicht am 14.09.2026. Updater abgeschlossen: `2026-09-14T10:32:44.259Z`,
Ergebnis `success`, keine Rücknahme. Alle 659 Manifestdateien stimmen mit dem
geprüften Paket überein; App und installiertes Offsite-Modul verwenden Vertrag 10.
Der eigenständige tägliche Upload-Timer ist deaktiviert; der gemeinsame
Assurance-Timer ist aktiviert. Die geschützte temporäre Importablage ist bereit.

Der eigentliche Updater dauerte **15 min 54 s**.
Die anschließende vollständige Recovery-Assurance dauerte **21 min 25 s**.
Diese Serverzeiten enthalten keine lokale Vorbereitung oder Browserwartezeit.
Die größte Paketprüfung benötigte 366 Sekunden. Die Serverprüfung wurde aus dem
erfolgreichen Updater übernommen und nicht ein zweites Mal gestartet. Der volle
Prüfmodus war wegen der kritischen Import-/Betriebsänderungen und des neuen
gepinnten Paketprüfers erforderlich. Nach erfolgreicher Assurance entscheidet
die vorhandene Richtlinie für ein unverändertes Paket wieder auf `short`.

## Abnahme und Nachweise

Signierter vollständiger Wiederherstellungslauf `9e7b6ab3-ec7e-4705-a36f-59771464bc17`:
OAuth-Regel, Sicherung, Repository-Prüfung, isolierte PostgreSQL-Wiederherstellung
und vollständiger Anwendungstest bestanden. Sicherungsstand
`a4589de611c8`. Keine offenen Fehler im aktuellen
Offsite-Status. Produktive Daten wurden dabei nur gelesen; schreibende Prüffälle
liefen in der isolierten Wiederherstellung.

Beide produktiven PostgreSQL-Datenbanken sind maßgeblich. Interne und öffentliche
Live-/Ready-Aufrufe HTTP 200, unauthentifizierte Geschäftsrouten HTTP 401,
Autovacuum an und keine Berichtspause. Frischer Monitor
`2026-09-14T11:00:43.886Z`: alle 24 Prüfungen bestanden. Keine neuen
fehlgeschlagenen Systemdienste, kein automatischer GP-Neustart. Die 24
vorbestehenden historischen Fehlzustände wurden weder verändert noch quittiert.
Boot-ID, PostgreSQL-, Caddy- und Lebensatlas-Prozesse bleiben unverändert.

Die angemeldete Chrome-Sichtprüfung bleibt offen: Die vorhandene GP-Sitzung ist abgelaufen; eine zusätzliche automatisierte Nachladung wurde von Chrome mit ERR_BLOCKED_BY_CLIENT blockiert. Das wird als Grenze der Browserprüfung festgehalten, nicht als nachgewiesener GP-Serverfehler. Anmeldung und Browserschutz wurden nicht umgangen. Die unabhängigen HTTP- und isolierten Anwendungstests sind oben getrennt dokumentiert.

Der native Android-/Drive-Dateidialog und ein erneuter vollständiger produktiver
Großimport sind nicht als getestet ausgewiesen. Die 89 gezielten Linux-Tests
bestätigen dagegen serverseitige Speicherung, Wiederaufnahme, Verschlüsselung,
Stillstandsprüfung und Browserunabhängigkeit mit synthetischen Daten.

Genau zwei vollständige lokale Sicherungspaare, zusammen
2.50 GB. Keine früher entfernten SQLite- oder
Migrationskopien erneut angelegt. Nach hashgeprüfter lokaler Sicherung der
Release-Nachweise wurden ausschließlich eigene Stage, Upload und das saubere
Paket-Worktree entfernt. Die Stage enthielt auch die befristeten rootgeschützten
Installationskopien der bestehenden Zugangsdaten; sie sind ebenfalls entfernt.
Freier VPS-Speicher danach: **87.58 GB**.

Dauerhafte Nachweise:
`/var/lib/grabenplaner-assurance/maintenance-evidence/v09245-20260914`.
Lokale Kopie: `tmp/v09245-evidence`.
Nachweismanifest SHA-256: `6f3404960f9f3881667a817369ffdfd29e9fecf29adb90d964adcb86d7208fdc`.

Aus v0.92.44 unterbrochene Dateien benötigen nach Veröffentlichung einmalig einen
erneuten Upload desselben Dateistands. Die alte Version hatte keine Quelldatei
aufbewahrt; bereits gespeicherte Pakete bleiben bei der Wiederaufnahme maßgeblich.
