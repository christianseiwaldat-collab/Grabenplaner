# Grabenplaner

Grabenplaner unterstützt Dienstplanung, Personalorganisation, Zeiterfassung,
Verkaufsanalysen und ein mobiles Mitarbeiterportal.

**Quellstand: v0.92.75 Beta · veröffentlichter GitHub-Serverrelease: v0.92.72 Beta.**
Der installierte Serverstand wird im GP angezeigt.

## Releases

- [Veröffentlichter Serverrelease v0.92.72 Beta](https://github.com/christianseiwaldat-collab/Grabenplaner/releases/tag/v0.92.72-beta)
- [Legacy v0.87.0-beta.legacy.1](https://github.com/christianseiwaldat-collab/Grabenplaner/releases/tag/v0.87.0-beta.legacy.1): eingefrorene Windows-Portable-/LAN-Version.

## Betrieb

Die Anwendung läuft auf einem verwalteten Ubuntu-Einzelserver hinter HTTPS.
SQLite bleibt der Standard für unveränderte Installationen. Für ausdrücklich migrierte Ubuntu-Server verwenden
`grabenplaner_core` und `grabenplaner_sales` eine geprüfte gemeinsame Datenübernahme;
ein einzelner Umgebungsparameter aktiviert den PostgreSQL-Wechsel nicht. Access-DB-Importe sind kontrollierte Datenübernahmen.

[Betriebs- und Recovery-Vertrag](SERVERBETRIEB.md) · [Sicherheit](SECURITY.md) ·
[Integrationen](INTEGRATIONEN.md) · [Versionsstatus](VERSIONS-LOG.md) · [Demo](CODESPACES.md)

## Entwicklung und Lizenz

Node.js und pnpm gemäß `package.json`: `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm start`.
Für Entwicklung und Demo ausschließlich synthetische Daten verwenden.
Grabenplaner ist source-available; Nutzung gemäß [LICENSE.md](LICENSE.md).
