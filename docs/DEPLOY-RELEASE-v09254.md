# v0.92.54 Beta · Schnellere Datenbankimporte

## Änderung

Der Import bündelt PostgreSQL-Lese- und Schreibzugriffe für Trade-, Bestell-
und Kassendaten. Authentifizierte Referenzen werden innerhalb derselben
Transaktion wiederverwendet. Neue Ziele werden in begrenzten Paketen gespeichert,
aus der Datenbank zurückgelesen und erneut authentifiziert. Rücknahmebelege,
Konflikterkennung, Berechtigungsprüfung und gespeicherte Wiederaufnahme bleiben
erhalten. Es gibt keine neue Migration und keine zusätzliche Abhängigkeit.

Die [Analyse und Messungen](IMPORT-OPTIMIERUNG-2026-09-15.md) dokumentieren
die Ursachen, vollständige lokale Dateiimporte und die noch offene Verbesserung
für Tabellen ohne stabile Quellschlüssel. Die angestrebten ungefähr 30 Minuten
pro Datenbank auf dem VPS sind damit noch nicht nachgewiesen.

## Erneute Freigabeprüfung am 16.09.2026

- Gesamtlauf des aktuellen Testverzeichnisses mit Node 24.19.0:
  3.621 Prüfungen, davon 3.502 bestanden, 27 fehlgeschlagen und 92 übersprungen.
  Vier veraltete Test-Dummys wurden anschließend ergänzt und erfolgreich erneut
  geprüft. Die übrigen 23 Fehler wurden in einem separaten Checkout des
  unveränderten Ausgangscommits `40caa8f` reproduziert. Sie betreffen vorhandene
  Personalrechts-, Schema-, Dokumentations- und historische Inventarprüfungen;
  der Gesamtlauf ist deshalb ausdrücklich nicht vollständig grün.
- Abschließende gezielte Prüfung mit Node 22.22.1: 83 bestanden, kein Fehler,
  eine Linux-Prüfung auf Windows erwartungsgemäß übersprungen. Die Ergänzungen
  an vier Test-Dummys betreffen den vorhandenen Import-Dienststopp, den
  Datenbankmodus und die Verbindungsprüfung. Der betreffende Anwendungscode
  wurde nicht geändert.
- Fünf native PostgreSQL-Prüfungen mit Node 22.22.1 und PostgreSQL 18.6:
  alle bestanden, keine übersprungene Prüfung. Darunter 30.567 Zeilen in
  153 begrenzten Wiederprüfungspaketen; maximale Paketdauer im letzten Lauf
  45 ms, im vorherigen Lauf unter paralleler Testlast 2.451 ms. Geprüft wurden
  außerdem Wiederaufnahme, Dubletten, manipulierte Verschlüsselung, atomare
  Rücknahme sowie der tatsächlich produktiv verwendete verzögerte Provider.
- Die Architekturprüfung registriert die neuen Paketdateien ausdrücklich.
  Ihre verbleibenden zwei historischen Katalogfehler stimmen exakt mit dem
  Ausgangsstand überein; es bleibt kein zusätzlicher Architekturfehler.
- Die VPS-Vorprüfung bestätigte sämtliche 718 Dateien der installierten v53,
  vier erfolgreiche Live-/Ready-Prüfungen, unveränderte Dienste sowie einen
  erfolgreichen vollständigen Wiederherstellungsnachweis von heute Nacht.

## Installation auf dem VPS

Commit `670b32cea87726ea9ca23b66b89e66c44efb53fd` wurde am 16.09.2026
um 06:54:36 UTC erfolgreich installiert. Der koordinierte Gesamtaufruf endete
um 06:54:47 UTC mit Exit 0. Die Importarbeiter pausierten kooperativ und
wurden mit der neuen Anwendung erneut gestartet.

- Paket SHA-256: `3330444ca7a8394293a7fba6423df407eb67378ef7e9c5f4900b6506dfca0b8a`.
- Manifest SHA-256: `79afa0b815428b31ae3bb1c868bc0b93426528ef297de909d550e9066473cb76`;
  alle 726 installierten Laufzeitdateien unabhängig nachgeprüft.
- Der installierte Updater wählte `full / RECOVERY_CONTRACT_CHANGED`.
  Die Änderungen innerhalb der Persistenzschicht verlangen den umfassenden
  Ablauf. Lokale und externe Rückkehrpunkte wurden vollständig erstellt;
  der kurze Ablauf wurde nicht erzwungen.
- Alle Betriebsprüfungen des Updaters bestanden. Anschließend bestanden
  vier interne und öffentliche HTTP-200-Prüfungen sowie der separate
  Offsite-Selbsttest. Die übrigen Anwendungs-/Datenbankdienste und die
  Bootkennung blieben erhalten; es gab keine zusätzlichen fehlgeschlagenen
  Systemdienste gegenüber der dokumentierten Ausgangslage.
- Vorher-/Nachher-Abgleich: identische Zeilenzahlen in 17 geprüften Tabellen,
  identische Schema-Fingerprints sowie identische Prüfsummen der Importquellen,
  Aufträge, Zustandszähler, Kassenstände und Freigaben. Bestell- und Kassenarbeiter
  wurden fortgesetzt. Die Versionsbindung des Kassenarbeiters wurde exakt auf
  v54 aktualisiert; Quellen, Kontext und Checkpoints blieben erhalten.

Die automatische Auslösung der Recovery Assurance war während des koordinierten
Deploys vorübergehend gesperrt. Deshalb enthält das Updaterprotokoll den erwarteten
Hinweis auf den noch maskierten Trigger. Beide temporären Sperren wurden beim
Abschluss entfernt. Nach dem erfolgreichen Offsite-Selbsttest startete der
vollständige Lauf getrennt über den bestehenden geschützten Dienst.

## Vollständiger Abschlussnachweis

Der signierte Lauf `abb286eb-fb13-488d-bb9b-dc00b8cbb13b` bestand am
16.09.2026 um 07:28:58 UTC vollständig; der Dienst beendete sich anschließend
mit Exit 0. Er bestätigt externe Sicherung, vollständiges Lesen des Repositorys,
Wiederherstellung beider Datenbanken und Anwendungsprüfung im isolierten Netz.
Alle 24 abschließenden Betriebsprüfungen bestanden.

- Geprüfter Snapshot: `939b65ad3cdc`.
- Restore-Beleg SHA-256:
  `23b5d8f37f2aae7d3dc9fdca7a5173315cf17637a9d2adcc5bd0c5471f061d1b`.
- Wiederhergestellt und abgeglichen: Core mit 210 Tabellen und 210.040 Zeilen,
  Sales mit 63 Tabellen und 8.417.789 Zeilen; außerdem Sequenzen,
  Schema-Fingerprints, 55 geschützte Dokumente und 114 geschützte Datensätze.
- Abschließende Live-Prüfung: vier HTTP-200-Antworten, öffentlich ausgelieferte
  Versionsanzeige v54, unveränderte Datenbankstrukturen und übrige Dienste.
  Genau zwei vollständige lokale Sicherungspaare sind vorhanden. Der neue
  gebundene Nachweis erlaubt gewöhnliche kompatible Folgeupdates wieder im
  kurzen Modus.
- Importfortsetzung am 16.09.2026 um 07:30 UTC durch zwei reine Leseabfragen
  bestätigt: Der Bestelllauf mit 181.125 Zeilen änderte innerhalb von 15 Sekunden
  seine Revision von 13.770 auf 13.831. Das belegt Fortschritt nach der Wartung,
  keine vollständige Importlaufzeit. Der Kassenauftrag wartet weiter auf den
  bestätigten Abschluss des Bestellimports.

Der periodische Monitor hatte bereits am 16.09.2026 um 06:55:45 UTC alle
24 Prüfungen unter v54 bestanden. Der aktuellere vollständige Betriebsnachweis
stammt aus der anschließend erfolgreichen Assurance. Ein neuer periodischer
Monitorlauf nach der Assurance wird nicht behauptet; sein Timer ist aktiv,
der letzte automatische Neustart liegt weiterhin am 10.09.2026.

Die beiden temporären Deploy-/Upload-Verzeichnisse dieser Veröffentlichung sind
entfernt. Wiederherstellungskopien wurden regulär bereinigt; rund 72 GiB sind frei.
31 archivierte Nachweisdateien wurden lokal anhand von Größe und SHA-256 geprüft.

Serverarchiv:
`/var/lib/grabenplaner-assurance/maintenance-evidence/release-v09254-670b32c-20260916`.
Lokale Nachweise: `tmp/v09254-evidence/vps`.

Der Updater benötigte rund 20 Minuten, die anschließende vollständige Assurance
rund 33 Minuten. Das sind Release-Prüfzeiten. Die angestrebte vollständige
Importlaufzeit von ungefähr 30 Minuten pro Quelldatenbank auf dem VPS bleibt
gesondert zu messen.
