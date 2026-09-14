# Release v0.92.46-beta

## Freigabe und Paketumfang

Am 14.09.2026 freigegeben: alle sechs Integrationsblöcke nacheinander,
anschließend Deploy bei bestandener Abnahme. Die danach gemeldeten Loginfehler
sind Teil desselben Pakets. Keine neue Veröffentlichung eines GitHub-Releases,
kein Tag und keine Änderung von Netzwerkzugängen oder anderen Anwendungen.

- [Sechs Fachblöcke](INTEGRATION-SECHS-BLOECKE-2026-09-14.md).
- [Planungsoptimierung](PLANUNG-LADEZEITEN-2026-09-14.md).
- [Login- und Importsperren](LOGIN-UND-IMPORTSPERREN-2026-09-14.md).

147 gezielte lokale Tests bestanden; zusätzlich native PostgreSQL-Fachprüfung,
native Belegsuche und tatsächlicher HTTP-Login mit zwölf parallelen Aufrufen bei
gleichzeitigem synthetischem Import bestanden. Produktive Daten wurden für
Diagnose und Vorprüfung ausschließlich gelesen. Der Ausgangsstand war
v0.92.45-beta / `ebeadc74a0e9cbeb54ba6f302048200a8a62901e`.

Die neue Core-Tabelle und ihr Migrationsprotokoll werden erst nach erfolgreichem
normalem Code-Update durch den installierten Root-Helfer ergänzt. Ein kontrollierter
Fehler in der DDL-Transaktion wurde nativ als vollständige Rücknahme geprüft.
Das Sales-Schema bleibt unverändert. Frischer gekoppelter Sicherungspunkt,
geprüftes Paket und kurze Betriebsprüfungen bleiben verpflichtend. Der bestehende
Updater wählt den Prüfmodus anhand seiner unveränderten Richtlinie.

## Produktiver Wechsel am 14.09.2026

Der normale Updater wurde um 19:36:30 UTC gestartet und meldete um 19:52:15 UTC
den erfolgreichen Code-Commit. Die additive Core-Migration war um 19:52:18 UTC
abgeschlossen; der gesamte Wrapper endete um 19:52:21 UTC mit Exit 0. Die reine
Releasekette dauerte damit knapp 16 Minuten. Es gab keinen VPS- oder PostgreSQL-
Neustart. Caddy, Lebensatlas und die andere PostgreSQL-Instanz behielten ihre PIDs.

- Laufzeit-Commit: `088a56200fa2dc29e62e569b817b672de8bc72cf`.
- Paket: `Grabenplaner-Server-v0.92.46-beta-linux-x64.zip`.
- Paket-SHA-256: `b4215e18f6f51a53e4922fecd4fdc633e78aeb06e1e5d71df3317f65fd544008`.
- Manifest-SHA-256: `91d247593e79cb40e864199ddb73e449a50cfd98fc03099d0c671c79c6b4959d`.
- Alle 691 installierten Manifestdateien geprüft; Runtime-Vertrag 5 und
  Offsite-Modul 10 unverändert.
- Vier interne/öffentliche Live-/Ready-Prüfungen erfolgreich. Die drei neuen
  geschützten Fachzugänge antworten ohne Sitzung über HTTPS mit 401.
  Der lokale HTTP-Prüfversuch wurde zuvor korrekt mit 426 abgewiesen; der
  Prüfhelfer wurde auf den tatsächlich vorgeschriebenen HTTPS-Zugang berichtigt.
- `/api-errors.js` wird ohne Sitzung mit HTTP 200 als JavaScript ausgeliefert.
- PostgreSQL 18.6: Core `7c97285f37d5abce0cdc65f7ab03eaa09bc178ba084b9bedfe6dd808581a6df0`,
  Sales unverändert `e7310d88fa0dfe8a479a19fbe0cdb51fb7d65b17cf6daf5510baeff3a55323e3`.
  Der App-Zugang darf das neue Migrationsprotokoll nicht ändern.

Der vorhandene Prüfer wählte wegen geändertem Wiederherstellungsvertrag `full`.
Die temporär verzögerte ereignisgesteuerte Folgeprüfung wurde nach erfolgreichem
Code- und Schemawechsel wieder freigegeben und um 19:54:28 UTC gestartet. Sie
erstellte einen konsistenten Sicherungsstand des neuen Schemas und hielt dafür
den GP kontrolliert von 19:54:42 UTC bis zum erneuten Start um 19:56:47 UTC an;
die Anwendung war ab 19:57:18 UTC wieder gestartet. Die währenddessen beobachtete
Loginantwort 502 gehört zu diesem Wartungsfenster. Kein automatischer Absturz-
Neustart wurde ausgelöst. Der Abschluss der vollständigen Folgeprüfung ist
unten gesondert dokumentiert; der bereits erfolgreiche Code-Deploy ist davon
zu unterscheiden.

## Produktive Bedienprüfung

Der Benutzer meldete sich erfolgreich an; HTTP-Antwort des Logins 643 ms. Seine
Sitzung blieb nach dem kontrollierten Wartungsstart gültig. Filiale 18: normale
Wochenwechsel auf 21.09. und 28.09.2026 mit 2051 und 1802 ms; Urlaub 2027 mit
256 ms und die Rückkehr zu 2026 mit 270 ms. Dies sind einzelne vollständige
Serveranfragen unter laufender externer Prüfung, keine garantierten Gesamtzeiten
für Browseraufbau und Netzverbindung.
Das Ausgangsjahr 2026 wurde wiederhergestellt. Browser-Zurück führte von der
Urlaubsansicht zur Dienstplanung im GP zurück.

Der erste programmatische Jahresfeldwechsel der Browserautomatisierung löste
kein natives Änderungsereignis aus. Der Wechsel über die native Pfeiltaste wurde
anschließend mit tatsächlichem API-Aufruf und geänderter Anzeige bestätigt.

`Verkauf → Einkauf & Bestand` lädt im produktiven angemeldeten GP. Die Suche
meldet derzeit ausdrücklich, dass noch kein vollständig übernommener
Quelldatenstand vorhanden ist. Die native Fachprüfung verwendete deshalb
zusätzlich vollständig importierte synthetische Daten; ein leerer produktiver
Einkaufsstand ist kein Nachweis für vorhandene Einkaufsdaten.

## Vollständige Folgeabnahme

Die signierte Assurance `4f1408b0-f915-423b-a09b-24e4da9fa597` hat alle sieben
erforderlichen Ereignisse bestätigt: Start, OAuth-Vorgabe, Sicherung, vollständige
Repositoryprüfung, isolierte Wiederherstellung, Anwendungstest und Gesamterfolg.
Snapshot `3ede9a3170c4`; `full-assurance-passed` um 20:15:14 UTC. Die zusätzliche
Folgeabnahme dauerte 20 Minuten 46 Sekunden. Zusammen mit der Releasekette ist
das bei diesem Paket länger als ein gewöhnliches Programmupdate.

Die isolierte Anwendung erzeugte und lud auch eine Analyse-PDF und prüfte
Anmeldung, parallele Aufrufe, Import/Rücknahme und Rechteentzug. Beide produktiven
Datenbanken wurden dabei nicht zurückgespielt. Keine der drei Offsite-
Fehlerkategorien meldet anschließend einen offenen Fehler. Der normale
Deploy-Entscheider bestätigt nach dieser neuen Abnahme wieder `short` für unveränderte
Wiederherstellungsverträge.

Abschließende Hostprüfung: produktive Bereitschaft HTTP 200, Autovacuum aktiv,
fremde Dienst-PIDs und Boot-ID unverändert, keine neue fehlgeschlagene Unit.
Die 24 historischen fehlgeschlagenen Units wurden unverändert belassen.
Es existieren genau zwei vollständige gekoppelte lokale Sicherungen mit
zusammen rund 3,11 GB Dateigröße (3.107.965.980 Byte). Die zuvor entfernten
Migrations-/Altdatenkopien wurden nicht neu angelegt.

## Abschluss und Nachweise

Der anschließend frisch gelaufene Servermonitor bestätigte um 20:17:16 UTC alle
24 Prüfungen. Die temporäre zusätzliche PostgreSQL-Testinstanz wurde gestoppt;
ihr Verzeichnis sowie beide eigenen Upload-/Deployverzeichnisse sind entfernt.
Auch der saubere lokale Build-Worktree ist entfernt; ZIP und absichtliches
`output/` bleiben erhalten. Nach der VPS-Bereinigung sind rund 80,1 GiB frei.

Dauerhafter root-geschützter Nachweisordner:
`/var/lib/grabenplaner-assurance/maintenance-evidence/release-v09246-088a562-20260914`.
Alle 27 dort archivierten Dateien wurden lokal nach
`tmp/v09246-evidence/vps` übernommen und gegen die einzelnen SHA-256-Werte geprüft.
Archiv-SHA-256: `dd2e04e04a8503034536799b499c2fb5735a6cfa0d6763aace332d6ce9b16cb3`.
Der signierte Assurance-Verlauf und die Wiederherstellungsbelege verbleiben
zusätzlich an ihren üblichen geschützten Betriebsorten.

Kein neuer produktiver ACCDB-Upload wurde für diese Releaseabnahme gestartet.
Die alten unvollständigen Quellen benötigen weiterhin dieselbe Originaldatei
für den einmaligen Übergang in den bereits veröffentlichten Hintergrundablauf.
