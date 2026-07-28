# Codespaces-Demo

> Ausschließlich für fiktive Demo- und Testdaten. Keine Personal-, Gesundheits-, Zugangs- oder Produktivdaten verwenden.

## Zugriff

Der automatische Grabenplaner-Demo-Start ist nur für den Repository-Eigentümer und eingeladene Collaborators mit Schreibzugriff vorgesehen.

Der Start-Hook prüft:

- das Original-Repository `christianseiwaldat-collab/Grabenplaner`;
- die vom Codespace gemeldete GitHub-Identität;
- Admin- oder Schreibzugriff dieser Identität auf das Repository.

Port `3000` bleibt privat und ist nur über den authentifizierten HTTPS-Proxy des jeweiligen Codespaces erreichbar.

Dieses Repository ist privat. GitHub erlaubt die Erstellung eines Codespaces für ein privates Repository eines persönlichen Kontos nur Personen mit Repository-Zugriff. Der Start-Hook beschränkt den automatischen Demo-Start zusätzlich auf den Repository-Eigentümer und ausdrücklich eingeladene Collaborators mit Schreibzugriff.

## Start

1. Auf GitHub **Code → Codespaces → Create codespace on main** wählen.
2. Den Containerstart abwarten.
3. Port `3000` unter **PORTS** mit **Open in Browser** öffnen.
4. Die erzeugten Demo-Zugangsdaten im Terminal anzeigen:

```bash
cat "/workspaces/.grabenplaner-codespaces/${CODESPACE_NAME}/secrets.json"
```

Der Dev Container verwendet Node.js 24 und pnpm 11.7.0. Er erzeugt einen isolierten Demo-Admin und ein fiktives Sporthandelsprofil. Laufzeitdaten, Logs, Backups und Zugangsdaten liegen außerhalb des Repositorys unter:

```text
/workspaces/.grabenplaner-codespaces/${CODESPACE_NAME}
```

Nach Änderungen am Servercode den Container neu aufbauen oder einen frischen Codespace erstellen. Codespaces ersetzt weder den verwalteten Ubuntu-Serverbetrieb noch dessen Backup-, Virenscanner-, Update- und Recovery-Prüfungen.
