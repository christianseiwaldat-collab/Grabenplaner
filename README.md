# Grabenplaner

Aktuelle Beta-Version: **v0.55 Beta**

Grabenplaner ist eine lokale Windows-Web-App für Dienstplanung, Urlaubsplanung und PDF-Ausgaben. Die Daten bleiben lokal in einer SQLite-Datenbank; ein externer Datenbankserver ist nicht nötig.

## Direkt starten

Unter Windows genügt ein Doppelklick auf:

`Grabenplaner v0.55 Beta starten.cmd`

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
- Mitarbeiterportal mit Anträgen, AUM-Upload und Zeiterfassung
- Wochen- und Monatsübersichten der Zeiterfassung mit nachvollziehbaren Korrekturanträgen
- Tagesprüfung mit Plan-/Ist-Vergleich, Pausenhinweisen und Samstagswertung
- Rollen- und Rechtemanagement mit personenbezogenen Zusatzrechten und getrennten Vergabegrenzen für IT-Admin und Personalleitung
- Mobil optimiertes Leitungsportal mit konfigurierbaren Kernfunktionen
- Standortbezogene Branding-Zuweisung für unterschiedliche Filialauftritte
- Lokale SQLite-Datenbank ohne externen Datenbankserver
- Integriertes Backup-System
- GitHub-basierter Aktualisierungscheck

## Branding

Firmenname, Logo, Admin-Kontakt und PDF-Titel können in den Einstellungen angepasst und als komplettes Branding-Kit exportiert oder importiert werden. Admin und Personalleitung können installierte Brandings standortbezogen zuweisen. Der App-Name bleibt fest `Grabenplaner`.

## Lizenz

Grabenplaner ist source-available, aber nicht Open Source. Private, interne Test- und Evaluierungsnutzung ist erlaubt; kommerzielle Nutzung nur nach vorheriger schriftlicher Genehmigung.

## Sicherheit

Sicherheitsprobleme bitte vertraulich gemäß [SECURITY.md](SECURITY.md) melden und nicht als öffentliches Issue veröffentlichen.

## Servermodus

Der aktuelle Betrieb bleibt lokal mit SQLite-Datenbank. Ein Servermodus ist technisch in Vorbereitung, aber noch nicht aktiv.

Die technische Grundlage und die spätere Einrichtung mit Firmen-IT sind in [SERVERBETRIEB.md](SERVERBETRIEB.md) beschrieben.

Eine private GitHub-Codespaces-Umgebung für Demo- und Funktionstests der Rollen-, Portal- und Zeiterfassungsabläufe ist in [CODESPACES.md](CODESPACES.md) beschrieben. Dort dürfen keine echten Personal- oder Gesundheitsdaten verwendet werden.

## Backup und Datenbank

- Beim Start wird automatisch eine interne Sicherung im Ordner `backups` erstellt.
- Optional kann zusätzlich regelmäßig in einen lokalen PC-Ordner gesichert werden.
- Backup-Dateien können über die App wieder importiert werden.
- Die echte Arbeitsdatenbank liegt lokal unter `data\dienstplan.db` und ist nicht Teil der GitHub-Release-ZIP.

## Entwicklung

Mit lokal installiertem Node.js 22 oder neuer:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

Der Port kann über die Umgebungsvariable `PORT` geändert werden:

```powershell
$env:PORT=8080
pnpm start
```
