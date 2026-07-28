# Grabenplaner

Grabenplaner bündelt Dienstplanung, Abwesenheiten, Personalorganisation, Zeiterfassung und ein mobiles Mitarbeiterportal in einer Anwendung.

**v0.87 Beta · verwalteter Ubuntu-Einzelserver · SQLite · source-available**

[Server-Release v0.87 Beta](https://github.com/christianseiwaldat-collab/Grabenplaner/releases/tag/v0.87-beta) · [Serverbetrieb](SERVERBETRIEB.md) · [Sicherheit](SECURITY.md)

## Produktstatus

`main` wird als zentral betriebenes Serverprodukt weiterentwickelt. Die Anwendung läuft hinter HTTPS auf einem von der zuständigen IT verwalteten Ubuntu-Einzelserver; der App-Prozess selbst bleibt an Loopback gebunden.

SQLite ist der aktuell unterstützte Datenbankprovider. PostgreSQL ist als späterer Provider für größere zentrale Installationen geplant, aber noch nicht implementiert oder freigegeben. Die verbindliche Reihenfolge steht in der [Datenbank-Provider-Strategie](docs/DATENBANK-PROVIDER-STRATEGIE.md).

Die frühere Windows-Portable-/LAN-Auslieferung ist als [v0.87.0-beta.legacy.1](https://github.com/christianseiwaldat-collab/Grabenplaner/releases/tag/v0.87.0-beta.legacy.1) eingefroren. Sie ist kein zweites aktuelles Entwicklungsziel.

## Kernfunktionen

| Bereich | Umfang |
|---|---|
| Planung | Wochen- und Urlaubsplanung, Planungsregeln, PDF-Ausgaben |
| Personal | Mitarbeitende, Personalakt, Kostenstellen, Standorte und Abteilungen |
| Portal | Eigener Dienstplan, Anträge, Zeiterfassung, Krankmeldung und AUM |
| Organisation | Rollen, fachliche Einzelrechte und datensparsame Bereichssichten |
| Leihe | Ausgabe, Rücknahme, Gegenbestätigung, Belege und geschützte Fotoanhänge |
| Betrieb | System-Center, Backups, beaufsichtigte Wiederherstellung und Recovery-Nachweise |
| Integration | CSV/XLSX sowie kontrollierte SQL-/API-Adapter |

Grabenplaner unterstützt betriebliche Abläufe und Nachweise. Die Anwendung ersetzt keine arbeitsrechtliche, datenschutzrechtliche oder IT-sicherheitsfachliche Prüfung der konkreten Installation.

## Einblicke

<table>
  <tr>
    <td><img src="docs/readme/dienstplanung.webp" alt="Dienstplanung in Grabenplaner v0.87"></td>
    <td><img src="docs/readme/teams-standorte.webp" alt="Personal- und Kostenstellenverwaltung in Grabenplaner v0.87"></td>
  </tr>
  <tr>
    <td><img src="docs/readme/rechtemanagement.webp" alt="Rollen und wirksame Bereiche in Grabenplaner v0.87"></td>
    <td><img src="docs/readme/branding-kits.webp" alt="Neutrales Branding in Grabenplaner v0.87"></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/readme/mitarbeiterportal.webp" alt="Mobiles Mitarbeiterportal in Grabenplaner v0.87" width="300"></td>
    <td align="center"><img src="docs/readme/aum-upload.webp" alt="Krankmeldung und AUM im mobilen Portal" width="300"></td>
  </tr>
</table>

Alle Abbildungen stammen aus einem isolierten Demo-Profil mit fiktiven Personen und Standorten.

## Betrieb und Entwicklung

Der vorgesehene Serverbetrieb verwendet Node.js 24, Caddy, systemd, getrennte Dienstrechte und eine eingebettete SQLite-Datenbank. Installation, Update, Backup, Restore und Sicherheitsgrenzen sind in [SERVERBETRIEB.md](SERVERBETRIEB.md) beschrieben.

Lokale Entwicklungsumgebung:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

Die [Codespaces-Demo](CODESPACES.md) ist ausschließlich für fiktive Testdaten vorgesehen. Ihr Port bleibt privat; der automatische Demo-Start prüft zusätzlich den Schreibzugriff auf dieses Repository.

## Dokumentation

- [Serverbetrieb](SERVERBETRIEB.md)
- [Datenbank-Provider-Strategie](docs/DATENBANK-PROVIDER-STRATEGIE.md)
- [Integrationen](INTEGRATIONEN.md)
- [Versionsverlauf](VERSIONS-LOG.md)
- [Sicherheitsrichtlinie](SECURITY.md)
- [Lizenz](LICENSE.md)

## Lizenz und Meldungen

Grabenplaner ist **source-available, nicht Open Source**. Private interne Test- und Evaluierungsnutzung richtet sich nach [LICENSE.md](LICENSE.md); kommerzielle Nutzung erfordert die vorherige schriftliche Genehmigung des Rechteinhabers.

Sicherheitsprobleme bitte ausschließlich vertraulich nach [SECURITY.md](SECURITY.md) melden, nicht als öffentliches Issue.
