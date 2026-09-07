# Produktivanbindung · Block 2/4

Stand: 05.09.2026. Lokale Umsetzung der ausdrücklich freigegebenen Stammdaten-Zuordnung und skalierbaren Verkaufs-/CRM-Ansichten. Ausgangspunkt ist [Block 1](PRODUKTIV-BLOCK-1-IMPORTANBINDUNG.md).

**Kein produktiver Import, keine produktive Zuordnung oder Kennzahlenaktivierung, kein Commit, Push, Deploy oder Versionswechsel.** Die App-Komposition hält `allowApply`, `allowMapping` und die Historien-Aktivierung weiterhin ausdrücklich auf `false`. HTTP-Anfragen können diese Sperren nicht aufheben. Vorhandene uncommittete Arbeiten aus Block 1 bleiben erhalten.

## Stammdaten-Zuordnung unter Verkauf

Der eigene, einklappbare Bereich „Stammdaten-Zuordnung des Gesamtimports“ bietet eine explizite Suche im bereits übernommenen Quellarchiv. Die geschützte Staging-Vorschau allein ist noch kein Stammdatensatz. Es gibt keine automatische Verknüpfung oder Massenänderung beim Öffnen.

- Bereiche: Filialen, Mitarbeitende/Verkäufer, Artikel und Kunden/CRM.
- Exakte Quellnummern einschließlich führender Nullen; Filter „offen“, „zugeordnet“ und „alle“; begrenzte Seiten mit sortierbaren Nummern/Namen und scrollbarer Liste.
- GP-Ziele werden bewusst ausgewählt. Personalnummern und Standort-IDs können exakt gesucht werden; eine paginierte Auswahlliste zeigt nur ID, Name und Aktivstatus.
- Artikel verwenden ausschließlich eine bereits geprüfte Quellbindung des zentralen Artikelstamms. Es entsteht kein zweiter Artikelstamm; Preise bleiben unverändert.
- Privat/gewerblich ist eine ausdrückliche CRM-Entscheidung. Korrekturen erfolgen ausschließlich an freigegebenen CRM-Feldern; Originalwerte bleiben im verschlüsselten Quellarchiv. Eine gleichlautende Kundennummer erfordert eine bestätigte Verbindung zur vorhandenen Karte. Namen, E-Mail oder Telefonnummern sind keine automatische Identitätsregel.
- Vorschau und Bestätigung sind getrennt. Der bestätigte Plan ist an Akteur, Quellrevision, Zielzustand und Entscheidung gebunden. Veränderungen erfordern eine neue Vorschau.
- Manuell gepflegte Website, Fotos und eigene Textfelder bleiben erhalten. Konkurrierende manuelle/Quelländerungen werden nicht überschrieben. Inaktive Personal-/Standort-/Artikelziele benötigen die ausdrückliche historische Zuordnung.
- Eigene letzte Änderungen können über die vorhandene transaktionale, revisions- und abhängigkeitssichere Rücknahme geprüft werden. Spätere Änderungen, fremde Aktionen und abhängige Historie sperren die Rücknahme; das ist kein pauschaler Restore.

Die Rechte sind kumulativ: persönliches Gesamtimport-/Gesamtfirmenrecht plus bereichsspezifische Fachrechte. Kunden benötigen CRM-Lese-/Schreibrechte, Personal die zentrale Personalberechtigung, Artikel das getrennte Artikelimportrecht und Standorte das vollständige Standortrecht. Rollenbezeichnungen allein berechtigen nicht. Keine automatische Rechteausweitung und keine Übernahme alter Zugangsrechte.

Bank-/Finanzdaten, Passwörter, Personalkonditionen und Einkaufspreise gelangen nicht über diese Zuordnungsoberfläche nach außen. Antworten sind `private, no-store`; auch Vorschau-/Such-POSTs benötigen CSRF. Accountwechsel, ausgeblendete Seiten und verspätete Antworten werden berücksichtigt. Zuordnungsereignisse bleiben zentral und verschlüsselt im Importprotokoll nachweisbar.

## Vollständige Zeiträume statt 5.000-Zeilen-Abbruch

Die bisherige Obergrenze von 5.000 analysierten Datensätzen entfällt. Ein Aufruf verarbeitet höchstens **200 Positionen**, über stabile Datums-/ID-Fortsetzungen. Das ist ein Verarbeitungspaket, keine Grenze der gewählten Jahresauswertung. Ergebnislisten bleiben unabhängig davon auf maximal 100 Zeilen je Seite begrenzt.

Die Oberfläche führt die Zeitraumsauswertung schrittweise fort, zeigt den verarbeiteten Umfang und bietet Pause/Fortsetzung. **Brutto, Netto, Steuer und Tagessummen erscheinen nur nach vollständiger Verarbeitung und erfolgreicher Prüfung aller passenden Belege.** Leere Auswahl oder fehlende Tage werden nicht als erwiesener Nullumsatz ausgegeben. Blättern addiert keine Positionen erneut.

Standard bleibt „Jahr bis Berichtsende“, höchstens 366 Kalendertage je Anfrage. Filialscope, Positions- und Belegverkäufer bleiben getrennte Filter; die Kundenkartei verwendet dieselbe Auswertung mit bestätigter CRM-Bindung und zusätzlichen Kundenkaufrechten. Unbekannte Verkäufer oder Filialen werden nicht still zugeordnet. Kassenjournal/Tagesbericht bleiben explizite Snapshots und werden nicht zu Einzelverkäufen oder PDF-Berichten addiert.

Die Auswertung speichert lediglich verschlüsselte, kurzlebige Summen-/Zählerzustände im Prozessspeicher, keine Kopie aller Verkaufszeilen. Kontogebundene Fortsetzungsnachweise, Berechtigungs-/Filterbindung, Ablauf nach 15 Minuten Inaktivität und eine begrenzte Zahl paralleler Zustände schützen die Fortsetzung. Pro Konto werden höchstens acht ruhende Zustände gehalten, insgesamt maximal 64 inklusive neuer laufender Zustände. Nach Neustart, Ablauf oder verdrängtem Zustand wird neu gesucht; Teilbeträge werden nicht als Gesamtbetrag freigegeben.

Jeder Historien-Append und jede Rücknahme aktualisiert in derselben Transaktion eine zufällige Datenstandskennung. Zusätzlich invalidieren Importlaufrevisionen, Regel- und Quellkonfiguration die Auswertung. Geänderte Datenstände werden nicht über Schritte oder Ergebnisseiten hinweg vermischt. Kundenzuordnung, Verkäufer- und Filialfilter werden nach der Indexauswahl an authentifizierten Referenzen erneut geprüft.

## Fachliche Grenzen bleiben bestehen

Die bestätigte Umsatzsemantik und der Abgleich vom 03./04.09.2026 aus Block 1 gelten unverändert. Belege vom 05.09.2026 werden nicht erneut verlangt. Eine Quellenfreigabe benötigt weiterhin unveränderlich zugeordnete Regeln und den vollständigen Belegzugehörigkeitsnachweis; eine passende Summe allein genügt nicht. Unbestätigte Status-/Steuerkombinationen bleiben prüfpflichtig.

Historische Belege behalten ihren damaligen Zuordnungsstand. Neue Zuordnungen werden vor der erstmaligen Historienübernahme gesetzt. Bei späterer Zuordnung ist der vorhandene explizite Referenz-Neulauf über einen neuen geprüften Importversuch nötig; die Anwendung ändert bestehende Belegversionen nicht heimlich beim Lesen. Der isolierte Gesamtlauf in Block 3 prüft diese Reihenfolge und die erneute Referenzübernahme.

Der synthetische Großtest ersetzt keine Messung des vollständigen realen Imports. Laufzeit und Spitzenbedarf bei 385.877 Positionen sowie die Freigabe der belegten Quellen-/Regelkonfiguration sind Teil der folgenden isolierten Abnahme. Es werden keine bereits importierten Geschäftsdaten nachträglich ohne Freigabe produktiv aktiviert.

## Umsetzung und Prüfstand

- Wiederverwendung des bestehenden Import-Master-Service für Bindung, CRM-Dreiwegeabgleich, Audit und Undo; neue minimierte Listen-/Zielprojektionen und verwaltete Laufzeitanbindung.
- Wiederverwendung der vorhandenen Belegprüfung und exakten Dezimalarithmetik für die schrittweise Verkaufs-/CRM-Auswertung.
- Fünf zusätzliche benannte SQL-Verträge: drei Zuordnungsabfragen sowie Lesen/Fortschreiben der Datenstandskennung. Alle fünf werden als PostgreSQL-Syntaxkandidaten kompiliert; keine neue SQLite-exklusive Fachlogik und keine Datenbankanbieter-Aktivierung.
- Aktuelles Anwendungsinventar: **1.249** Statementverträge, 33 Baseline-/1.216 Dialektvarianten, 1.143 benannte Dollar-Parameter, **1.135** generierte PostgreSQL-Syntaxkandidaten und 114 offene Overrides. Das Vollanwendungsgate bleibt **0/1.249**, Migrationen **0/10**.
- Synthetische Regression: 5.001 Verkäufe in 26 Verarbeitungsschritten, zwei getrennte Tage, CRM- und Positionsverkäuferfilter, exakt 60.012,00 EUR brutto / 50.010,00 EUR netto / 10.002,00 EUR Steuer. Weitere Ergebnisseiten ändern diese Summe nicht.
- Weitere Prüfungen: unbestätigte Teilmengen, leere Auswahl, abgelaufene/manipulierte/wiederholte Cursor, Account-/Rechte-/Datenstandswechsel, Quelle/Ziel-Revisionen, Nummern mit führenden Nullen, bewusste CRM-Verbindung, geschlossene Produktivgates, verwaltete Schlüssel über mehrere Aufrufe, Rücknahme und Ausgabe-Escaping.
- Vollsuite: **2.877 Tests**, 2.836 bestanden, 40 bewusst übersprungen, 1 Fehler; rund 662 Sekunden. Der einzige Fehler war `EPERM` beim Umbenennen einer temporären Datei im unveränderten Recovery-Test `v076-recovery-assurance-history`. Die vollständige betroffene Testdatei bestand anschließend separat **7/7**; der Fehler war dabei nicht reproduzierbar. Der Vollsuite-Lauf wird deshalb nicht als fehlerfrei ausgegeben.
- Nach der abschließenden Oberflächenkorrektur (Schließen während einer laufenden Kontextanfrage und anschließendes Wiederöffnen) bestanden **21/21** betroffene Routen-/UI-Tests. Der zusätzliche Regressionstest ist nicht in den 2.877 Tests des vorher gestarteten Vollsuite-Laufs enthalten. Architektur-, Syntax- und Diff-Prüfungen sind sauber. Keine Browsersteuerung oder visuelle Browserabnahme.

## Nächste ausdrückliche Freigabe

**Block 3/4:** vollständiger Import in eine isolierte Testdatenbank; bestätigte Zuordnung vor abhängiger Historie; Mengen-/Summenabgleich, Performance/Speicher, Wiederholungsimport, Referenz-Neulauf, Abbruch/Wiederaufnahme und Rücknahme. Q01 bleibt unverändert offen: Artikel 19.187 deklariert / 19.186 gelesen, Artikel-Filialen 231.355 / 231.351. Keine Zählerkorrektur ohne unabhängige Bestätigung und keine Umgehung gesperrter Access-Ausführung.

**Block 4/4:** erst nach gesonderter Freigabe Releasekette, VPS-Backup-/Restore-/Kapazitätsprüfung, kontrollierter produktiver Erstimport und Aktivierung. Keine Änderung an SSH, Tailscale, Firewall, UFW oder Zugängen; App-Port weiterhin ausschließlich Loopback.

Branch `feature/schedule-pdf-day-separators`, HEAD `41e6d92e5fc95c30a4ecb11d478802a930ea44e1`, Version unverändert `0.92.27-beta`.
