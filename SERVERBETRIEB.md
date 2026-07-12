# Grabenplaner Serverbetrieb

Der Serverbetrieb in v0.49 Beta ist ein technisches Fundament für einen späteren Pilotbetrieb. Lokalbetrieb und LAN-Host bleiben unverändert verfügbar.

## Voraussetzungen

- Ein zentraler Windows- oder Linux-Server mit Node.js 22 oder der mitgelieferten Windows-Laufzeit
- Eine feste Domain, zum Beispiel `plan.example.at`
- Ein HTTPS-Reverse-Proxy wie Caddy oder Nginx
- Ein zuvor im Lokal- oder LAN-Betrieb eingerichteter Admin-Zugang
- Ein ausschließlich lokal am Server gespeicherter SQLite-Datenbankpfad
- Ein zusätzlicher Backup-Ordner auf einem anderen Datenträger oder Sicherungsziel

Die SQLite-Datei darf nicht auf einem Netzlaufwerk liegen. Alle Browser greifen auf eine einzige laufende Grabenplaner-Instanz zu.

## Geschützte Serverkonfiguration

Der Servermodus wird absichtlich nicht im Browser aktiviert. Die Serveradministration setzt beim Start mindestens:

```powershell
$env:GRABENPLANER_OPERATION_MODE = "server"
$env:GRABENPLANER_PUBLIC_URL = "https://plan.example.at"
$env:GRABENPLANER_HOST = "127.0.0.1"
$env:GRABENPLANER_TRUST_PROXY = "loopback"
$env:DB_PATH = "D:\Grabenplaner-Daten\dienstplan.db"
$env:BACKUP_DIR = "E:\Grabenplaner-Backups"
runtime\node.exe server.js
```

`GRABENPLANER_PUBLIC_URL` muss eine vollständige HTTPS-Adresse ohne zusätzlichen Pfad enthalten. Der Reverse-Proxy verbindet sich anschließend intern mit `127.0.0.1:3000`.

Ein minimales Caddy-Prinzip sieht so aus:

```text
plan.example.at {
    reverse_proxy 127.0.0.1:3000
}
```

Die endgültige Einrichtung von Domain, Zertifikat, Firewall, Serverdienst und Backupziel erfolgt gemeinsam mit der zuständigen Firmen-IT.

## Sicherheitsverhalten

Im Serverbetrieb gelten automatisch:

- HTTPS-Pflicht und sichere Cookies
- Prüfung der öffentlichen Herkunft bei schreibenden Browseranfragen
- Mindestlänge von 10 Zeichen für neu gesetzte Passwörter
- Kontosperre und zusätzliche IP-basierte Login-Drosselung
- Sicherheitsheader und HSTS
- Schutz vor zwei gleichzeitig laufenden Instanzen auf derselben Datenbank
- gesperrte automatische App-Updates, Neustarts und Datenbankimporte aus dem Browser

Updates und Datenbankimporte werden im Serverbetrieb kontrolliert in einem Wartungsfenster durchgeführt.

## SQLite und Backups

Grabenplaner aktiviert WAL, Fremdschlüssel, eine Schreibwartezeit von fünf Sekunden und eine Integritätsprüfung beim Start. Erstellte Backups werden unmittelbar mit `quick_check` geprüft. Die Diagnose unter `Einstellungen > Datenbank` zeigt den aktuellen Zustand.

SQLite ist für den geplanten kleinen Pilotbetrieb mit einer zentralen Serverinstanz geeignet. Sollte die spätere Nutzung deutlich wachsen oder mehrere Serverinstanzen benötigen, ist eine Migration auf PostgreSQL der nächste sinnvolle Schritt.
