# Grabenplaner

Grabenplaner unterstützt Dienstplanung, Personalorganisation, Zeiterfassung,
Verkaufsanalysen und ein mobiles Mitarbeiterportal.

**Quellstand: v0.92.95 Beta · veröffentlichter GitHub-Serverrelease: v0.92.72 Beta.**
Der installierte Serverstand wird im GP angezeigt.

## Releases

- [Veröffentlichter Serverrelease v0.92.72 Beta](https://github.com/christianseiwaldat-collab/Grabenplaner/releases/tag/v0.92.72-beta)
- [Legacy v0.87.0-beta.legacy.1](https://github.com/christianseiwaldat-collab/Grabenplaner/releases/tag/v0.87.0-beta.legacy.1): eingefrorene Windows-Portable-/LAN-Version.

## Betrieb

Die Anwendung läuft auf einem verwalteten Ubuntu-Einzelserver hinter HTTPS.
PostgreSQL ist die einzige unterstützte Betriebsdatenbank. `grabenplaner_core` und `grabenplaner_sales`
bilden ein geprüftes Datenbankpaar. Installation und Versionswechsel verlangen einen verifizierten PostgreSQL-Bestand;
eine Änderung von Umgebungsparametern ersetzt keine Migration. Der [Übergangs- und Altsicherungsvertrag](POSTGRESQL-ONLY.md)
beschreibt die getrennte Offline-Wiederherstellung früherer SQLite-Sicherungen.

[Betriebs- und Recovery-Vertrag](SERVERBETRIEB.md) · [Sicherheit](SECURITY.md) ·
[Integrationen](INTEGRATIONEN.md) · [Versionsstatus](VERSIONS-LOG.md) · [Demo](CODESPACES.md)

## Entwicklung und Lizenz

Node.js und pnpm gemäß `package.json`: `pnpm install --frozen-lockfile`. Der Serverstart setzt die geschützte PostgreSQL-Konfiguration voraus.
Die vollständige Linux-Anwendungsprüfung richtet mit `test-support/postgresql-migration/ci-stock-import-delete.js --full`
ein ausschließlich synthetisches PostgreSQL-Paar im gebundenen CI-Dienst ein; die HTTP-Fixtures verwenden dabei den Testadapter `test-support/postgresql-api/preload.js`.
Für Entwicklung und Demo ausschließlich synthetische Daten verwenden.
Grabenplaner ist source-available; Nutzung gemäß [LICENSE.md](LICENSE.md).
