# Rollen- und Positionsstandards in den Einstellungen

Stand: 9. September 2026. Lokal implementiert und geprüft; noch nicht veröffentlicht. Die produktive Datenbank wurde durch diese Umsetzung nicht verändert. Ein VPS- oder Dienstneustart wurde nicht ausgeführt.

## Verhalten

Der Developer kann in der zentralen Rechteverwaltung alle bekannten Berechtigungen für andere persönliche Zugänge vergeben und entziehen. Die bisherigen Einschränkungen nach Zielrolle blockieren seine Entscheidungen nicht mehr; dies gilt insbesondere für Mitarbeiter und Abteilungsleitungen. Der Developer selbst behält garantierten Vollzugriff und kann über diese Oberfläche weder eingeschränkt noch als Rolle neu vergeben werden.

Unter **Einstellungen → Rechtemanagement → Standardrechte je Rolle und Position** lassen sich die Standards jeder vorhandenen App-Rolle und Position auswählen. Eine Suche grenzt die nach Fachbereichen gruppierten Rechte ein. Änderungen werden zunächst als Entwurf gehalten und erst mit **Standardrechte speichern** angewendet. Eingebaute Rollenstandards und die Vererbung von App-Rollen können wiederhergestellt werden.

Die Reihenfolge ist eindeutig:

| Ebene | Wirkung |
|---|---|
| App-Rolle | Liefert den Standard, solange kein eigener Positionsstandard besteht. |
| Position | Ein ausdrücklich gespeicherter Positionsstandard ersetzt den Rollenstandard aller zugeordneten persönlichen Zugänge. Eine leere Auswahl bedeutet keine Standardrechte. |
| Persönliche Freigaben | Ergänzen die Standardrechte. |
| Persönliche Entzüge | Entfernen das betreffende Recht aus dem wirksamen Satz und bleiben auch bei späteren Standardänderungen gespeichert. |
| Developer | Behält unabhängig von Position und persönlichen Einträgen alle bekannten Rechte. |

Beispiel: Eine Verkaufsmitarbeiter-Position erhält ausschließlich das Recht für den eigenen Dienstplan. Dies ersetzt auch bei einem zugeordneten Zugang mit App-Rolle Abteilungsleitung dessen bisherige Standardrechte. Eine ausdrücklich persönlich freigegebene Artikelsuche kommt hinzu. Ein persönlicher Dienstplanentzug bleibt wirksam. Nach Rückkehr zum App-Rollenstandard bleiben diese persönlichen Entscheidungen erhalten.

Die Personalbearbeitung zeigt die Standards der ausgewählten Rolle und Position an. Normale Stammdatenänderungen übermitteln kein unverändertes Rechteprofil. Persönliche Entzüge werden dort kenntlich gemacht; ihre Änderung erfolgt in der zentralen Rechteverwaltung. Bereits gespeicherte persönliche Freigaben bleiben auch dann erhalten, wenn dasselbe Recht zwischenzeitlich zusätzlich zum Standard gehört.

## Verbindliche Grenzen und Speicherung

Bestehende fachliche Geltungsbereiche, erforderliche Vorrechte, Personalakt-Feldrechte, Modulfreigaben und besondere Vertrauensregeln bleiben eigenständige Prüfungen. Die Vergabe eines Rechts ändert nicht automatisch die zugehörige Standort- oder Abteilungszuordnung. Andere Verwaltungsrollen behalten ihre bisherigen Delegationsgrenzen; Standards kann ausschließlich ein aktiver Developer bearbeiten.

Die Schnittstellen prüfen Berechtigung und aktiven Bearbeiter serverseitig erneut innerhalb der Schreibtransaktion. Unbekannte Rechte, widersprüchliche Abhängigkeiten und veraltete Versionsstände werden abgewiesen. Falls persönliche Ausnahmen mit einem neuen Standard unvereinbar sind, wird die gesamte Änderung zurückgerollt und die betroffene Personalnummer benannt.

Geänderte Standards wirken auf bestehende aktive Zugänge. Ihre Web- und Mobilsitzungen werden beendet, sodass eine erneute Anmeldung erforderlich ist. Änderungen werden revisionsbezogen und je verändertem Recht protokolliert. Die Anzeige meldet die Zahl der aktualisierten Zugänge.

Angepasste Rollenstandards werden beim nächsten Anwendungsstart nicht mehr durch eingebaute Werte überschrieben. Die zuvor bei jedem Start ausgeführte Bereinigung nach alten Rollengrenzen läuft als einmalige Kompatibilitätsmigration. Neue Developer-Freigaben bleiben bei weiteren Starts erhalten. Positionsstandards liegen in einer eigenen Tabelle; persönliche Zugriffsprojektionen verwenden dieselbe Auflösung für Web, Mobilzugang und die betroffenen Fachmodule. Zwei bestehende Datenbankregeln für Aufgabenzuordnungen werden nur bei exakt bekannter Vorgängerdefinition angepasst; abweichende Definitionen werden nicht stillschweigend ersetzt.

Ein späterer Versionsrückgang muss dieses Berechtigungsmodell berücksichtigen: Eine ältere Anwendung kennt Positionsstandards nicht und kann ihre eingebauten Rollenwerte erneut setzen. Die Freigabe eines Updates sollte deshalb zusammen mit einem aktuellen vollständigen Wiederherstellungsstand erfolgen. Dieser Hinweis ist Teil der späteren Veröffentlichung; es wurde hier kein Update ausgelöst.

## Kompakte Einstellungen

Alle Einstellungsbereiche verwenden die kompakteren Kopfzeilen, Abstände und Felder entsprechend Grundeinstellungen und Dienstplanung. Beschriftungen, Hilfetexte und Aktionszeilen dürfen umbrechen; Inhaltskarten wachsen mit ihrem Inhalt. Das vorhandene adaptive Raster und die einspaltige Darstellung bei schmalen Ansichten bleiben erhalten. Tabellen und Menüreiter behalten ihre vorgesehenen Scrollflächen.

Feldbeschriftungen nutzen auch im Darkmode die passende Textfarbe. Die neuen Rechte-Schalter besitzen eine eigene kompakte Größe und übernehmen nicht die Höhe gewöhnlicher Textfelder.

## Prüfnachweis

Der abschließende Lauf umfasst **131 erfolgreiche Tests, keine Fehler, keine übersprungenen Tests** aus 15 betroffenen Testdateien. Geprüft wurden insbesondere:

- Vergabe sämtlicher bekannter Rechte an MA und AL und anschließender Entzug über authentifizierte HTTP-Schnittstellen, einschließlich eines tatsächlichen Artikelabrufs;
- geschützter Developer, abgewiesene Standardänderungen anderer Rollen und CSRF-Prüfung;
- wirksame Rollen- und Positionsstandards in Web- und Mobilzugängen, persönliche Ausnahmen, erneute Anmeldung, Versionskonflikte und Rücknahme bei ungültigen Abhängigkeiten;
- Personalbearbeitung mit Positionsstandards und dauerhaften persönlichen Freigaben beziehungsweise Entzügen;
- Wiederherstellung aller eingebauten Rollenstandards, erneutes Seeding und gezielte Migration bestehender Zuordnungsregeln;
- bestehende Delegations-, Personalmodul-, Organisations- und Sitzungsprüfungen sowie die Einstellungsstruktur und das adaptive Raster.

Das lokale Laufprotokoll liegt unter `tmp/rights-and-settings-verification-20260909.log`. Die wichtigsten neuen Integrationstests stehen in `test/portal-permission-defaults.test.js`. Syntaxprüfung und `git diff --check` waren erfolgreich.

Nach der letzten CSS-Korrektur wurden die elf Einstellungstests erneut ausgeführt und bestanden (`tmp/rights-settings-layout-recheck-20260909.log`). Ein vorheriger Zusatzlauf überschritt einmal die bestehende Startgrenze von zwölf Sekunden für den lokalen Migrationstestserver; dessen Health-Endpunkt antwortete anschließend erfolgreich. Der zurückgebliebene isolierte Testprozess wurde beendet. Die Testgrenze und der Test selbst wurden nicht geändert.

Die Sichtprüfung erfolgte in Chrome ausschließlich mit einer isolierten synthetischen Datenbank. Das Speichern und Wiederherstellen eines Rollenstandards wurde in der Oberfläche durchgespielt. Geöffnete Bereiche für Rechte, Personal, Urlaub, Zeiterfassung, Import, Zugänge, Datenschutz und System/Backups zeigten im geprüften Desktopfenster keine abgeschnittenen Inhalte oder seitlichen Seitenüberlauf. Die Rechteansicht wurde zusätzlich mit 150 Prozent App-Schriftgröße geprüft; die dafür vorgesehene Reiterleiste blieb scrollbar. Nach Korrektur der Darkmode-Beschriftungen und Schaltergröße wurde die Seite frisch geladen und erneut visuell kontrolliert. Die Browserkonsole meldete keine Fehler oder Warnungen.

Dies ist kein Nachweis sämtlicher Inhalte bei jeder Bildschirmbreite: Die mobile Einspaltenregel wurde durch die vorhandenen Layouttests geprüft, nicht durch einen vollständigen Durchlauf auf einem physischen Mobilgerät.

Die separat angefragte Untersuchung der Ladezeiten ist in [KASSEN-TRADE-PERFORMANCE-RECHERCHE-2026-09-09.md](KASSEN-TRADE-PERFORMANCE-RECHERCHE-2026-09-09.md) dokumentiert. Ihre Optimierungen sind ein begründeter Umsetzungsvorschlag und noch nicht im produktiven Suchweg aktiviert.
