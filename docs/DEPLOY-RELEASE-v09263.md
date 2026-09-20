# Vorbereitung v0.92.63 Beta

## Änderungen

- Das System-Center misst die Größe beider PostgreSQL-Datenbanken und prüft
  Fremdschlüssel anhand des PostgreSQL-Katalogs. Fehlende Messwerte bleiben
  unbekannt. Die SQLite-Anzeige gilt nur für SQLite-Installationen.
- Sicherheits-, HTTPS- und Sicherungsnachweise erhalten verständliche Hinweise
  und passende Verweise. Die Aktualitätsbewertung berücksichtigt den täglichen
  Wartungsrhythmus. Nach erfolgreicher Nachtprüfung wird der Monitor angestoßen.
- Isolierte Restores verwenden zwei begrenzte Restore-Jobs und einen passenden
  Speicherrahmen. Sicherungen erfassen technische Phasendauern. Produktive
  PostgreSQL-Einstellungen und vollständige Nachweispflichten bleiben erhalten.
- Der xoffi-Import erlaubt die laufende Woche ab dem letzten geplanten Dienstende
  im gewählten Bereich. Die Übernahme prüft diese Bedingung erneut.
- Die Zeiterfassung zeigt importierte xoffi-Zeiten je Kalenderwoche und Person
  neben dem GP-Plan, einschließlich Tagesdetails und signierter Abweichung.
  Einstellbare Standardgrenzen: Betrag bis 5 % grün, bis 15 % gelb, darüber rot.
  Fehlende Zeiten, Nullplanstunden und abweichende Importbereiche sind gesondert
  gekennzeichnet. Bereichsrechte und CSRF-Prüfungen gelten auch für die Einstellungen.

## Verbindliche Auslieferungsreihenfolge

Diese Vorbereitung führt weder einen App-Deploy noch einen Host-Neustart aus.
Die Produktionsversion bleibt bis zur Auslieferung 0.92.62-beta.

1. CI für den endgültigen Main-Commit vollständig prüfen. Einen neuen separaten
   Server-Vorabcheck vor Paketbau, Upload, Vollscan und Sicherung ausführen.
2. Die bereits abgeschlossene Host-/PostgreSQL-Modulwartung GP710 anhand der
   installierten Bytes prüfen, nicht erneut ausführen.
3. **Der normale App-Updater ist vorerst blockiert:** Der bestehende Offsite-
   Prüfer meldet `migration-required:11->11`. Ausschließlich die Vorlage
   `systemd/grabenplaner-offsite-assurance@.service.in` unterscheidet sich vom
   installierten Modul 11. Die neue Nachlaufaktion startet den unabhängigen
   Monitor; sie darf nicht durch manuelles Umschreiben eines Vertragsbelegs
   freigeschaltet werden.
4. Im ausdrücklich freigegebenen Auslieferungsfenster zuerst den regulären
   Offsite-Modulinstaller mit den vorhandenen geschützten Konfigurationen,
   gepinnten Werkzeugen und einem aus dem Commit geprüften Quellbaum verwenden.
   Das bestehende Repository nicht neu initialisieren. Die tägliche
   03:00-Planung und sämtliche Timerzustände erhalten.
5. Der Installer startet selbst eine vollständige Assurance für den installierten
   App-Stand. Deren Abschluss, signierte Belege und Bereinigung abwarten;
   keinen App-Deploy, Restore oder Backup parallel beginnen.
6. Anschließend Offsite-Kompatibilität und separaten Deploy-Vorabcheck frisch
   prüfen. Erst dann den regulären vollständigen App-Updateweg ausführen.
   Versionsanstieg, Paket- und Quellprüfsummen, Scan, Rückkehrpunkt und
   Updatequittung müssen zusammenpassen. Aktive Prozesse anhand ihres
   Fortschritts beobachten; keine identischen Fehlversuche wiederholen.
7. Automatisch folgende Assurance und regulären Postflight abschließen. Echte
   angemeldete Oberfläche einschließlich Dienstplan und Zeiterfassung prüfen;
   Health-Endpunkte allein belegen keine funktionierende Oberfläche.
8. **VPS-Neustart erst danach:** separate frische Prüfung von Rückkehrpunkt,
   Kernel/initramfs, Bootdiensten, Wartungssperren, Timern und unabhängigen
   Zugängen. Die bisherige Vorbereitung ist keine Neustartausführung.

## Stand der Machbarkeitsprüfung am 20.09.2026

17:46 Europe/Vienna: installierter Deploy-Vorabcheck erfolgreich, rund 72,66 GB
frei, kein aktiver Sicherungs-/Recoverylauf, Wartungszeitgeber täglich 03:00.
Alle fünf PostgreSQL-Unit-Verträge passen auch zum Kandidaten; die installierte
Host-Brokerkopie ist bytegleich. Das installierte Offsite-Modul besteht seine
eigene Vertragsprüfung. Die oben genannte Kandidatenabweichung bleibt eine echte
Auslieferungsvoraussetzung.

Diese Momentaufnahme reserviert kein Wartungsfenster. Ein Abschluss innerhalb
von 30 Minuten ist wegen Modul-Assurance, Update und anschließender Assurance
nicht belegt. Der kleine synthetische Restorevergleich ist kein produktiver
Vollnachweis und keine garantierte Laufzeitersparnis.

Weitere Details: [Restore und Neustart](POSTGRESQL-RESTORE-PERFORMANCE-UND-NEUSTART.md).
