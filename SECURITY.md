# Sicherheitsrichtlinie

## Unterstützte Versionen

Sicherheitskorrekturen werden grundsätzlich für die jeweils aktuelle veröffentlichte Beta-Version bereitgestellt. Ältere Versionen gelten nach Veröffentlichung einer Nachfolgeversion als nicht mehr unterstützt.

## Sicherheitsproblem vertraulich melden

Bitte Sicherheitslücken nicht als öffentliches GitHub-Issue veröffentlichen. Meldungen können vertraulich per E-Mail an `christian.seiwald.at@gmail.com` gesendet werden.

Empfohlener Betreff: `Grabenplaner Security Report`

Eine hilfreiche Meldung enthält möglichst:

- betroffene Grabenplaner-Version und Betriebsmodus;
- eine klare Beschreibung der Schwachstelle und ihrer möglichen Auswirkungen;
- nachvollziehbare Schritte zur Reproduktion;
- bereinigte Screenshots oder Protokollauszüge ohne Passwörter, Datenbanken oder personenbezogene Daten.

Es sollen keine echten Personal-, Planungs-, AUM- oder Zugangsdaten übermittelt werden.

## Reaktion und verantwortungsvolle Offenlegung

Eine Eingangsbestätigung erfolgt nach Möglichkeit innerhalb von fünf Werktagen, eine erste fachliche Einschätzung innerhalb von zehn Werktagen. Diese Zeiträume sind Zielwerte und keine Garantie.

Bitte räume dem Projekt eine angemessene Frist zur Prüfung und Behebung ein, bevor technische Einzelheiten veröffentlicht werden. Eine namentliche Danksagung erfolgt nur nach vorheriger Zustimmung.

Für dieses Projekt besteht derzeit kein Bug-Bounty-Programm.

## Hinweise für einen sicheren Betrieb

- Die SQLite-Datenbank und Sicherungen können Personal- und Planungsdaten enthalten und müssen durch Betriebssystem- und Dateiberechtigungen geschützt werden.
- Personen mit Schreibzugriff auf den App- oder Datenbankordner gelten als vertrauenswürdige Systembetreiber.
- Der LAN-Host-Modus ist nur für ein vertrauenswürdiges internes Netzwerk vorgesehen.
- Ein öffentlich erreichbarer Betrieb darf nur über den vorgesehenen Servermodus mit HTTPS und korrekt konfiguriertem Reverse Proxy erfolgen.
- Reale Datenbanken, Branding-Kits mit internen Daten und AUM-Dokumente dürfen nicht in öffentliche Repositories oder Fehlerberichte hochgeladen werden.

## Umfang

Meldungen zu Fehlern in Grabenplaner selbst sind willkommen. Probleme, die ausschließlich aus einem unsicheren Betriebssystem, einer fehlerhaften Netzwerk- oder Proxykonfiguration, veränderten Abhängigkeiten oder einer eigenständig modifizierten Installation entstehen, können außerhalb des Projektumfangs liegen.
