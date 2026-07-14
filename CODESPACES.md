# GitHub-Codespaces-Test

> **Achtung:** Diese Umgebung ist ausschließlich für Demo- und Testdaten bestimmt. Keine echten Personal-, Gesundheits- oder Produktivdaten verwenden.

## Start

1. Im GitHub-Repository **Code → Codespaces → Create codespace on main** wählen.
2. Den automatischen Start abwarten und anschließend den privat weitergeleiteten Port `3000` öffnen.
3. Im Codespaces-Terminal die erzeugten Zugangsdaten anzeigen:

```bash
cat "/workspaces/.grabenplaner-codespaces/${CODESPACE_NAME}/secrets.json"
```

Die dort angegebene Personalnummer und das Admin-Passwort gelten ausschließlich für diese Testinstanz.

Der Dev Container verwendet Node.js 24 und die festgelegte pnpm-Version 11.7.0; die Abhängigkeiten werden mit `pnpm install --frozen-lockfile` installiert. Beim Start richtet der Runner bei Bedarf lokal einen Demo-Admin sowie das fiktive Sporthandelsprofil mit sechs Filialen und 31 Verkaufsmitarbeitenden ein und wechselt anschließend in den Servermodus. Der Dienst lauscht intern per HTTP nur auf Loopback; Codespaces leitet Port `3000` privat weiter.

Der Port-Eintrag `protocol: "http"` beschreibt dabei nur die interne Verbindung zum Loopback-Dienst; der Zugriff im Browser erfolgt über den authentifizierten HTTPS-Proxy von Codespaces.

Zum Anmelden immer die Adresse aus dem Bereich **PORTS** mit **Open in Browser** öffnen. Die App akzeptiert dabei sowohl die konfigurierte Codespaces-Adresse als auch die vom vertrauenswürdigen GitHub-Proxy gemeldete gleichursprüngliche Weiterleitungsadresse.

Das Sporthandelsprofil wird ausschließlich in einer frischen, leeren Demo-Datenbank angelegt. Bereits vorhandene Codespaces-Testdaten werden nicht automatisch überschrieben.

Die private URL lautet:

```text
https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}
```

Alle Laufzeitdaten, Backups, Logs und Secrets liegen außerhalb des Repositorys unter:

```text
/workspaces/.grabenplaner-codespaces/${CODESPACE_NAME}
```

Die erzeugten Zugangsdaten stehen in `secrets.json` (Dateimodus `0600`). Der Runner reicht GitHub-Token nicht an den Grabenplaner-Prozess weiter. Nicht gescannte AUM-Uploads sind nur in dieser Testumgebung erlaubt.

Status und Log:

```bash
cat "/workspaces/.grabenplaner-codespaces/${CODESPACE_NAME}/ready.json"
tail -f "/workspaces/.grabenplaner-codespaces/${CODESPACE_NAME}/codespaces-runner.log"
```
