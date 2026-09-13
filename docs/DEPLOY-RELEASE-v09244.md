# Release v0.92.44-beta

## Freigabe und Umfang

Am 14.09.2026 ausdrücklich gemeinsam zur Veröffentlichung beauftragt:

- Getrennte WGR-/Sortimentsfilter, persönliche gespeicherte Berichtsvorlagen
  und der neue Bereich Grafiken mit PDF-Zeitverlauf.
- Korrekte Behandlung der zwei bestätigten Nettobelegköpfe für MA 419
  vom 24. und 26.08.2026. Vorhandene PDFs bleiben erhalten; neue Berichte
  verwenden Regelversion 10.
- Unabhängige Artikel- und Belegsuchfreigaben in den Filialkontoeinstellungen
  einschließlich eigener Portalansichten und PDF-Beleginformation.
  PostgreSQL-Belegabfragen verwenden den vorhandenen begrenzten Workerpool.

Keine neue Datenbankschemamigration oder erneute ACCDB-Datenübernahme.
Die beiden PostgreSQL-Datenbanken und die Aufbewahrung von zwei vollständigen
Sicherungspaaren bleiben bestehen. Keine produktiven Konten werden automatisch
freigeschaltet. Das separate weitergehende Filialkonto-/ZA-Prototyppaket ist
nicht Teil dieses Releases.

## Nachweise vor der Bereitstellung

Die vorherigen lokalen Funktions-, Browser- und PDF-Prüfungen sind dokumentiert:

- [Verkaufsanalysen, Vorlagen und Grafiken](VERKAUFSANALYSEN-VORLAGEN-GRAFIKEN-2026-09-13.md)
- [Filialkonto-Suchfreigaben](FILIALKONTO-SUCHFREIGABEN-2026-09-14.md)
- [Bestätigte Kassenregeln](VERKAUFSBERICHTE-GEPRUEFTE-TEILWERTE.md)

Aktuelle lesende VPS-Vorprüfung: v0.92.43-beta, Source `0547dd4`, alle
648 Manifestdateien unverändert, vier interne/öffentliche Live-/Ready-Aufrufe
HTTP 200, PostgreSQL maßgeblich, Offsite-Status ohne offene Fehler,
88,72 GB frei. Eigene und fremde Dienst-IDs sowie Bootkennung sind als
Vergleichsbasis gespeichert. Es läuft kein konkurrierender Wartungsauftrag.

Die Releaseauswahl umfasste 93 Testfälle. Nach Korrektur der alten
Versionsnummer in zwei Testassertionen sind 90 bestanden; drei Linux-spezifische
Fälle bleiben auf Windows übersprungen. Der gezielte Versionsnachlauf bestand
alle acht Fälle. Der Persistenzaudit ist ohne unklassifizierte Dateien oder
Phasengrenzverletzungen bestanden. Die separat verfügbaren Entwicklungs-PG-Tests
wurden nicht als ausgeführt gezählt; native PostgreSQL-Nachweise folgen unten.

## Veröffentlichung

- Runtime-Commit: `a498d00f0dc07fea69ae68e0b9d3eaa96bc17b4d`.
- Serverpaket: `Grabenplaner-Server-v0.92.44-beta-linux-x64.zip`.
- Paket-SHA-256: `b1bf968c958e4242af525239bc0865e9bf6bf940d5099f906d14e882940b8367`.
- Manifest-SHA-256: `c9eda89ecc54f26fff3ac6286a2fa7c07b8ac4f86f807551940b813fec9eee4d`; alle 656 Dateien bestätigt.
- Updater erfolgreich am 13.09.2026 um 22:46 UTC, Dauer **13 min 01 s**.
- Die bestehende vollständige Updateprüfung wurde verwendet. Keine erneute
  PostgreSQL-Migration und keine Übernahme einer Access-Datei.

Größte Schritte: vollständiger Paketvirenscan 340 s, externe Sicherung vor dem
Update 152 s, zwei aktuelle lokale Rückkehrpunkte 81 s und 78 s. Die Serverprüfung
im Updater dauerte 31 s und wurde danach nicht nochmals separat ausgeführt.
Die zusätzliche vollständige Recovery-Assurance dauerte **18 min 12 s**.
Diese Zeiten betreffen den Serverlauf, nicht die vorherige lokale Vorbereitung.

Der separat gepinnte Paketprüfer setzt im bestehenden Updater ausdrücklich den
Vollmodus. Bei zukünftigen Releases mit unverändertem Prüfer kann dessen bereits
installierte Vertrauensbindung verwendet werden; die automatische Entscheidung
prüft dann weiterhin kritische Änderungen. Es wurde kein Schutzschritt umgangen.

## Funktions- und PostgreSQL-Nachweise

- Die zwei bestätigten Nettobelegköpfe werden direkt mit der veröffentlichten
  Regelversion 10 gelesen; die vier zuvor offenen MA-419-Positionen sind geklärt.
  Originalquelle und bestehendes PDF bleiben unverändert.
- Native Belegsuche über das PostgreSQL-Workerprotokoll: Suche, vollständiger
  Beleg, Ablehnung fremder Filialbelege und Ablehnung entzogener Rechte bestanden.
  Dieser technische Projektionstest verwendet ausschließlich Datenbankleser;
  produktive Kontofreigaben wurden dabei nicht geändert.
- Angemeldete Chrome-Sichtprüfung: WGR und Sortiment getrennt, Reihenfolge
  Bericht erstellen → Berichte → Grafiken → PDF-Analysen korrekt.
- Eine persönliche Grafikvorlage wurde gespeichert und nach Änderung von Titel
  und Zeitraster erneut geladen. Die gespeicherten Werte wurden wiederhergestellt.
  Der damit erstellte Grafik-PDF-Auftrag für August ist mit 1.252 Positionen fertig;
  die Monat-/Jahr-Platzhalter sind im Berichtstitel korrekt aufgelöst.
- Beide Suchschalter sind beim bestehenden Filialkonto einzeln bedienbar und
  bleiben bis zur bewussten Freigabe ausgeschaltet. Browser-Zurück führt innerhalb
  der Einstellungen und zurück zur Berichtsübersicht; die Sitzung bleibt bestehen.

Der kurzzeitige HTTP-502-Zustand während des kontrollierten Sicherungsstopps
wurde nach dem Wiederanlauf nicht mehr beobachtet. Ein vorübergehender
Chrome-Ladeblock wurde mit dem normalen Ladebutton behoben. Der bekannte
automatisierungsbedingte PDF-Downloadschutz wurde nicht als GP-Fehler bewertet
oder erneut getestet. Die isolierte Anwendung bestätigte einen PDF-Download
mit HTTP 200 und gültigem PDF-Inhalt.

## Wiederherstellung und Betriebsabschluss

Vollständiger signierter Prüflauf `3e50e27b-ff5c-426a-8913-588be05a82bc`, externer Sicherungsstand
`460cacd82a06`: OAuth-Regel, Sicherung, Repository,
Testwiederherstellung, vollständiger Anwendungstest und Abschluss bestanden.
Die Wiederherstellung bestätigt 201 Core- und 63 Sales-Tabellen mit 209.825 und
2.738.958 Zeilen, identischen Strukturprüfsummen, 55 geschützten Dokumenten und
113 geschützten Datensätzen. Schreibende Testfälle liefen in der isolierten
Wiederherstellung; dort sind auch Anmeldung, acht parallele Lesezugriffe,
Artikelimport samt Konflikt/Rücknahme, Belegsuche, Dienstplan-PDF und ein
Verkaufsbericht mit 2.239 Positionen bestanden.

Der Monitor bestätigte um `2026-09-13T23:08:41.288Z` alle 24 Prüfungen.
Interne und öffentliche Live-/Ready-Aufrufe liefern HTTP 200. Beide produktiven
PostgreSQL-Datenbanken sind maßgeblich; Autovacuum ist an, keine Berichtspause
ist gesetzt. Die Boot-ID und Dienste anderer Anwendungen sind unverändert;
kein zusätzlicher automatischer Neustart wurde ausgelöst.

Es bleiben genau zwei vollständige lokale Sicherungspaare mit zusammen rund
2,01 GB. Der Abschluss prüfte deren Manifest, Größen und Anzahl; die vollständige
Inhaltsprüfung war bereits in den Sicherungs-/Wiederherstellungsschritten erfolgt.
Nach hashgeprüfter lokaler Übernahme der 15 Nachweisdateien wurden ausschließlich
die eigenen Upload-/Stageverzeichnisse und das eigene saubere Paket-Worktree
entfernt. Freier VPS-Speicher danach: **88.72 GB**.

Dauerhafte VPS-Nachweise:
`/var/lib/grabenplaner-assurance/maintenance-evidence/v09244-20260914`.
Lokale Nachweise: `tmp/v09244-evidence`.
Belegmanifest-SHA-256: `5b2124ee3bfcfb5c4ee909092c52f88665dd05c9c6139606fefcaec3f0724a53`.
