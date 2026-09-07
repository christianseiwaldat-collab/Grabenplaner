# Kompakte Kasse: funktionale Anbindung abgeschlossen

Stand: 07.09.2026. Die fehlende Anbindung ist lokal implementiert und mit der normalen App-Komposition verbunden. Dies ist eine funktionale Umsetzung nach der abgeschlossenen Vorprüfung. Am VPS wurde in diesem Arbeitsschritt nichts installiert oder importiert; Branch und Version bleiben unverändert.

## Jetzt umgesetzt

- Die vorhandenen Verkaufsansichten lesen unmittelbar aus den sieben kompakten Kassentabellen. Es entstehen keine zusätzlichen universellen Historien-, Quellwert- oder Rücknahmekopien der Verkaufszeilen.
- Die normale Importoberfläche öffnet für einen vollständig geprüften Kassenstand die Auswahl für Auswertungen. Vorbereitung, ausdrückliche Zuordnung, Vorschau und Aktivierung sind getrennte Schritte. Unvollständige oder zwischenzeitlich geänderte Stände werden abgewiesen.
- Filialen, Positionsverkäufer, Belegverkäufer und Kunden werden über ausdrücklich ausgewählte GP-Ziele zugeordnet. Bereits bestätigte Artikelbindungen können übernommen werden; es entsteht kein zweiter Artikelkatalog. Die Zuordnungen werden für den aktivierten Stand festgehalten und beim späteren Lesen nicht an aktuelle Katalogänderungen angepasst.
- Der Wechsel auf einen neuen Stand und die Rückkehr zum vorherigen Stand erfolgen jeweils atomar. Ein konkurrierender oder veralteter Bestätigungsschritt wird abgewiesen. Bereits begonnene Auswertungen werden bei einem Standwechsel ungültig und müssen neu gestartet werden. Die Quelldaten bleiben erhalten.
- Filialrechte, getrennte Verkäuferrechte, zusätzliche Kundenkaufrechte und Finanzrechte werden auch auf dem kompakten Weg serverseitig geprüft. Organisationseinwahl und bloße Rollenbezeichnungen reichen nicht. Mutierende HTTP-Aufrufe benötigen eine persönliche Berechtigung und CSRF-Nachweis.
- Verkaufsbeträge verwenden die vorhandene exakte Dezimalrechnung und Belegprüfung. Die fünf Statuskombinationen der bereits bestätigten Belegbeispiele sind als Regelprofil hinterlegt. Andere Kombinationen bleiben prüfpflichtig. Steuercode 0 ist ausschließlich bei Nullpreispositionen belegt; daraus wird keine allgemeine Steuerbefreiung abgeleitet.
- Kassenjournal und Tagesberichte sind eigenständige Finanzansichten und werden nicht zu Einzelverkäufen addiert. Teilweise verarbeitete oder ungeprüfte Ergebnisse erhalten keine freigegebene Umsatzsumme.
- Neue Exporte mit derselben geprüften Kassenstruktur können dieselben bestätigten Regeln verwenden. Unbekannte Kombinationen werden weiterhin nicht geschätzt. Bis zum nächsten Upload bleibt der bisherige Stand gültig; ein unveränderter Upload löst keinen erneuten vollständigen Import aus.

## Prüfstand

Die Abschlussnachweise und Dateihashes stehen im [maschinenlesbaren Bericht](KASSE-ANBINDUNG-ABSCHLUSS-2026-09-07.json).

- Gezielte Funktionsprüfungen: kompakter Import, normale Auswertung, exakte Summen, vollständige Verarbeitung mehrerer Pakete, Blättern ohne Doppelzählung, Standort- und Datenklassenrechte, explizite CRM-/Artikelbindungen, Status-/Steuergates, Datenstandswechsel, Rückkehr, veränderte Vorschauen und manipulierte Suchzuordnungen.
- Ein aktivierter synthetischer Stand wurde tatsächlich in eine zweite Datenbank kopiert. Eine frische Schlüsselverwaltung öffnete ihn; nach erneutem vollständigem Wertevergleich blieb die ursprüngliche aktive Auswahl nutzbar.
- Die normale Oberfläche wurde im Browser mit ausdrücklich synthetischen Daten von der Auswahl über die Zuordnung und Vorschau bis zur sichtbaren Aktivierungsbestätigung bedient. Die Browserprüfung hatte keine produktive Datenverbindung.
- Die gezielten App-Start-/SQLite-Operationstests, Statement-/Dialektverträge und die Persistenzarchitekturprüfung bestehen. Die 16 neuen Statementverträge sind im Inventar erfasst: 1.324 insgesamt, 1.290 Dialektvarianten, 1.217 mit benannten Dollar-Parametern, 1.210 PostgreSQL-Syntaxkandidaten und weiterhin 114 offene Overrides. PostgreSQL wird nicht produktiv aktiviert.

Die vorherige Messung von 816,53 MB betrifft die unveränderte kompakte Speicherung der vollständigen Kassenzeilen. Hinzu kommen jetzt kleine Verwaltungs- und Zuordnungstabellen. Ein erneuter vollständiger Trade-Import oder eine neue kombinierte Vollbestandsmessung wurde dafür nicht gestartet. Der alte Messbericht wird nicht nachträglich als Nachweis dieser neuen Funktionen umetikettiert.

## Übergang zu Block 4

Die fachliche Kassenanbindung ist als lokale Vorarbeit abgeschlossen. Block 4 kann mit der vorhandenen Releasekette fortgesetzt werden: Anwendung und Runtime-/Backup-Umstellung zusammen ausliefern, den letzten bereitgestellten Kassenexport kontrolliert übernehmen, die konkreten GP-Zuordnungen prüfen und den Stand aktivieren. Danach ist die vollständige signierte Betriebs-/Wiederherstellungsprüfung auf dem installierten Stand erforderlich. Die bisherigen Speicherzahlen sind eine Planung für bestehenden GP plus kompakte Kasse; sie sind keine produktive Importabnahme.

Die normale generische Trade-Übernahme bleibt getrennt gesperrt. Der neue Kassenweg besitzt seine eigene persönlich berechtigte Aktivierung; der reine Upload aktiviert keine Auswertung. Es wurden kein Commit, Push, Deploy, produktiver Import oder Änderungen an vorhandenen Backups vorgenommen.
