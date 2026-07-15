# GitHub-Codespaces-Test

> **Achtung:** Diese Umgebung ist ausschließlich für Demo- und Testdaten bestimmt. Keine echten Personal-, Gesundheits- oder Produktivdaten verwenden.

Codespaces bildet Browser-, Rollen- und Portalabläufe über den privaten GitHub-HTTPS-Proxy ab. Es ersetzt weder den produktiven Windows-Einzelserver mit Caddy/WinSW und getrennten Dienstrechten noch dessen Backup-, Virenscanner-, Update- und Wiederherstellungsprüfung.

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

War der Codespace zwischenzeitlich beendet oder ist die GitHub-Anmeldung des privaten Ports abgelaufen, eine noch offene Portal-Seite nicht weiterverwenden: Codespace starten, den Port `3000` erneut unter **PORTS** mit **Open in Browser** öffnen und den Start kurz abwarten. Das Portal zeigt für diesen Fall eine eigene Hinweismeldung; die Sicherheitsprüfung der App wird dabei nicht gelockert.

Nach einem Update des Servercodes genügt ein Neuladen der Portal-Seite nicht. Den Codespace über **Codespaces: Rebuild Container** neu aufbauen oder für eine vollständig frische Demo-Testinstanz neu erstellen; erst danach läuft der aktualisierte Grabenplaner-Prozess.

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
