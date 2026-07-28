# Sicherheitsrichtlinie

## Unterstützte Versionen

| Version | Status |
|---|---|
| Aktuelle Server-Beta | Sicherheitskorrekturen nach Prüfung |
| v0.87.0-beta.legacy.1 | Eingefrorener Legacy-Endstand, keine laufende Weiterentwicklung |
| Ältere Releases | Nicht unterstützt |

## Vertraulich melden

Sicherheitsprobleme bitte nicht als öffentliches Issue veröffentlichen. Bevorzugter Meldeweg ist GitHubs **Private Vulnerability Reporting**:

[Sicherheitslücke vertraulich melden](https://github.com/christianseiwaldat-collab/Grabenplaner/security/advisories/new)

Alternativ ist eine vertrauliche Meldung an `christian.seiwald.at@gmail.com` möglich. Bitte nur bereinigte Nachweise ohne echte Personal-, Gesundheits-, Zugangs- oder Produktivdaten übermitteln.

Hilfreich sind betroffene Version, Auswirkung, reproduzierbare Schritte und gegebenenfalls ein minimiertes Testbeispiel. Eine Eingangsbestätigung wird nach Möglichkeit innerhalb von fünf Werktagen, eine erste Einschätzung innerhalb von zehn Werktagen angestrebt; dies sind Zielwerte, keine Garantie.

## Betriebsgrenzen

- Öffentlich erreichbare Installationen benötigen HTTPS, einen korrekt konfigurierten Reverse Proxy und einen ausschließlich an Loopback gebundenen App-Prozess.
- Datenbank, verschlüsselte Dokumentablage, Schlüssel und Sicherungen müssen gemeinsam geschützt, gesichert und getestet wiederherstellbar sein.
- Produktivbetrieb, Updates und Wiederherstellungen liegen in der Verantwortung einer vertrauenswürdigen Systemadministration.
- Reale Datenbanken, Dokumente, Branding-Kits, Schlüssel und Protokolle gehören weder in dieses Repository noch in Fehlerberichte.
- Die technischen Schutzmaßnahmen ersetzen keine Prüfung der konkreten Netzwerk-, Berechtigungs-, Datenschutz- und Backupkonfiguration.

Ausführliche Betriebs- und Recovery-Anforderungen stehen in [SERVERBETRIEB.md](SERVERBETRIEB.md).

Für dieses Projekt besteht kein Bug-Bounty-Programm.
