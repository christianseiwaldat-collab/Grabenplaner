# Grabenplaner

Aktuelle Beta-Version: **v0.49 Beta**

Grabenplaner ist eine lokale Windows-Web-App für Dienstplanung, Urlaubsplanung und PDF-Ausgaben. Die Daten bleiben lokal in einer SQLite-Datenbank; ein externer Datenbankserver ist nicht nötig.

## Direkt starten

Unter Windows genügt ein Doppelklick auf:

`Grabenplaner v0.49 Beta starten.cmd`

Die App öffnet anschließend lokal unter:

http://localhost:3000

## Key Features

- Dienst- und Urlaubsplanung für Filialen, Abteilungen und Teams
- Personalverwaltung mit Teammitgliedern, Positionen, Sollstunden und individuellen Arbeitsregeln
- Mindestbesetzung je Filiale, Abteilung und Wochentag
- Automatische Anrechnung von Feiertagen
- Urlaubsplanung mit Jahres-, Quartals- und Monatsübersicht
- PDF-Export für Dienstpläne, Abteilungspläne und Urlaubsübersichten
- Wochenstundenübersicht und Auswertung je Teammitglied
- Lokale SQLite-Datenbank ohne externen Datenbankserver
- Integriertes Backup-System
- GitHub-basierter Aktualisierungscheck

## Branding

Firmenname, Logo, Admin-Kontakt und PDF-Titel können in den Einstellungen angepasst und als komplettes Branding-Kit exportiert oder importiert werden. Der App-Name bleibt fest `Grabenplaner`.

## Lizenz

Grabenplaner ist source-available, aber nicht Open Source. Private, interne Test- und Evaluierungsnutzung ist erlaubt; kommerzielle Nutzung nur nach vorheriger schriftlicher Genehmigung.

## Servermodus

Der aktuelle Betrieb bleibt lokal mit SQLite-Datenbank. Optional kann ein Grabenplaner-PC als LAN-Host dienen. Ein Servermodus ist technisch in Vorbereitung, aber noch nicht aktiv.

Die technische Grundlage und die spätere Einrichtung mit Firmen-IT sind in [SERVERBETRIEB.md](SERVERBETRIEB.md) beschrieben.

## Backup und Datenbank

- Beim Start wird automatisch eine interne Sicherung im Ordner `backups` erstellt.
- Optional kann zusätzlich regelmäßig in einen lokalen PC-Ordner gesichert werden.
- Backup-Dateien können über die App wieder importiert werden.
- Die echte Arbeitsdatenbank liegt lokal unter `data\dienstplan.db` und ist nicht Teil der GitHub-Release-ZIP.

## Entwicklung

Mit lokal installiertem Node.js 22 oder neuer:

```powershell
npm.cmd install
npm.cmd start
```

Der Port kann über die Umgebungsvariable `PORT` geändert werden:

```powershell
$env:PORT=8080
npm.cmd start
```
