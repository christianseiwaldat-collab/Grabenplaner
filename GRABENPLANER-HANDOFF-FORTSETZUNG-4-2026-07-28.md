# Grabenplaner – Übergabe für Fortsetzung #4

Stand: 28. Juli 2026
Nächster fachlicher Arbeitsblock: **Block 5/8 – Leihfotos als PDF-Beilage**

## 1. Zweck und Arbeitsstand

Diese Übergabe setzt
`GRABENPLANER-HANDOFF-FORTSETZUNG-3-2026-07-28.md` fort. Der dort
beschriebene lokale Stand wurde übernommen und um Block 3/8 und Block 4/8
ergänzt.

- Lokales Repo:
  `C:\Users\chris\Documents\Lamprechter\Grabenplaner-mitterweg-pilot-v0863`
- Branch: `feature/v0864-cost-center-types`
- Basis-HEAD: `022a6b8`
- Block 1/8 bis Block 4/8 sind lokal umgesetzt und noch nicht committet.
- Der Arbeitsbaum bleibt absichtlich unsauber; vorhandene Änderungen dürfen
  nicht verworfen, zurückgesetzt oder überschrieben werden.
- Es erfolgte kein Commit, Push, GitHub-, Release-, Produktions- oder
  VPS-Eingriff.
- Die acht Blöcke werden zuerst lokal abgeschlossen. Externe Schritte beginnen
  erst nach der ausdrücklichen Gesamtabnahme.

## 2. Übernommene Blöcke 1/8 und 2/8

Unverändert übernommen sind:

- Block 1/8: datenbankgestütztes Kostenstellentyp-Modell einschließlich
  Positionszuordnung, Filialkennzeichen, Migration, Validierung, Audit und
  Profil-/Teildatenbankexport.
- Block 2/8: kostenstellengeführte Mitarbeiterzuordnung, Ableitung des
  Standorts bei Filialkostenstellen, gefilterte Positionsauswahl,
  kostenstellenbasierter Import und eingeklappte Mitarbeiter-/Personalaktbereiche.

Die Detailbeschreibung und zugehörigen Dokumente stehen in der Übergabe
Fortsetzung #3.

## 3. Block 3/8 – abgeschlossen: fachliche Rechte ab PL+

Personalleitung und höhere Rollen können einer geeigneten Zielrolle jetzt
gezielt zusätzliche fachliche Einzelrechte geben. Für die
Planungsverantwortung `275` sind dabei insbesondere vorgesehen:

- `work_rules:read`,
- `personnel:sensitive:read`,
- `personnel:sensitive:write`,
- `sickness:read`,
- `amu:local:manage`.

Wesentliche Grenzen:

- Die Rechte werden nicht zu neuen Grundrechten der Rolle
  `location_planner`.
- Abhängigkeiten werden atomar validiert; AUM-Zugriff verlangt beispielsweise
  das zugehörige Krankmeldungs-Leserecht.
- Standort- und Bereichsscope bleiben serverseitig wirksam.
- Rechteverwaltung, Rollenverwaltung, Systemdiagnostik, Backup, Update,
  Developer- und geschützte AUM-Rechte bleiben nicht delegierbar.
- Eine Rechteänderung widerruft bestehende Sitzungen und wird mit Vorher-/Nachher-
  Zustand auditiert.
- Die beiden Rechteeditoren filtern nach Zielrolle und zeigen unzulässige Rechte
  deaktiviert.

Relevante Tests:

- `test/v087-pl-plus-functional-rights.test.js`
- `test/v087-pl-plus-functional-rights-ui.test.js`

## 4. Block 4/8 – abgeschlossen: offene Leihübersicht

Normale Beschäftigte erhalten das neue reine Leserecht
`loans:overview:read`.

Die erste Ansicht des Leihbereichs ist eine direkt sichtbare Tabelle der
offenen Geräte. Sie enthält ausschließlich:

- Gerät/Modell,
- Artikel-/Inventarnummer,
- Seriennummer,
- geplante Rückgabe.

Die serverseitige Antwort enthält keine Leih-ID, Person, Fotos, Dokumente,
Unterschriften, internen Notizen, Ereignisse, Revisionen oder
Bearbeitungsrechte. Angezeigt werden nur offene Leihen des eigenen
freigeschalteten Standorts.

Bei höchstens zehn Einträgen bleibt die Suche ausgeblendet. Ab elf Einträgen
erscheint oberhalb der Tabelle eine kleine lokale Suche über Bezeichnung,
Artikel-/Inventarnummer und Seriennummer.

Wichtige Bausteine:

- `GET /api/portal/v1/loans/open-overview`
- Portal-Tabelle `loanOpenOverview`
- feste Suchschwelle `10`
- serverseitige Standortprüfung auch bei manipuliertem `locationId`

## 5. Block 4/8 – abgeschlossen: Filial- und Terminalkonten

Filial- und Terminalkonten bilden eine eigene Kontendomäne. Sie sind keine
Mitarbeitenden und besitzen weder Mitarbeiterzeile noch Personalnummer.
`fil18` bleibt ein generisches Beispiel und wird nicht fest angelegt oder
sonderbehandelt.

### Daten- und Sicherheitsmodell

Getrennt gespeichert werden:

- Organisationskonten,
- Organisationssitzungen,
- Funktionsrechte,
- Standortscopes.

Jede Anmeldung liefert einen ausdrücklich als Nicht-Mitarbeiter
gekennzeichneten Principal und einen eigenen Audit-Akteur
`account:<UUID>`.

Die serverseitige Funktions-Whitelist umfasst derzeit ausschließlich:

- `loans:overview:read`,
- `schedule:location:view`.

Auch direkt in die Datenbank eingeschleuste andere Rechte werden beim Aufbau
der Sitzung verworfen. Mindestens eine freigegebene Funktion und ein gültiger
Standortscope sind verpflichtend. Änderungen oder Deaktivierung widerrufen
laufende Sitzungen.

### Verwaltung ab PL+

In den Zugangseinstellungen können Personalleitung und höhere Rollen:

- ein Filial- oder Terminalkonto anlegen,
- Bezeichnung, Kontotyp, Standort, Freigaben und Aktivstatus bearbeiten,
- ein Startpasswort setzen oder zurücksetzen,
- gesperrte Konten entsperren.

Login-Kollisionen mit Mitarbeiter- und bestehenden Portalzugängen werden
verhindert. Anlage, Änderung und Entsperrung werden auditiert.

### Reduziertes Portal

Ein Organisationskonto kann nur seine ausdrücklich freigegebenen
Standortansichten öffnen:

- datensparsame offene Leihübersicht,
- reduzierter Standortdienstplan mit Name, Datum, Zeit, Bereich und Abteilung.

Gesperrt bleiben insbesondere:

- Mitarbeiter-Startseite und persönliche Benachrichtigungen,
- Zeiterfassung,
- Urlaubsverwaltung,
- AUM und Krankmeldung,
- Personalakte,
- Prozessaufgaben,
- persönliche Ausgabe, Rücknahme oder Bestätigung,
- Filialleitungs- und andere Leihmutationen,
- Verwaltungsoberfläche und Verwaltungspräferenzen.

## 6. Bewahrte Leihgrenzen

Die bestehenden Abläufe wurden nicht erweitert:

- Neue Leihen werden nur für die persönlich angemeldete Person erstellt.
- Bei der Rückgabe kann weiterhin eine zweite Person derselben Filiale
  bestätigen.
- Filialleitung kann revisionsgesichert bearbeiten, ohne Beleg schließen und
  später wieder öffnen.
- Ein Filial- oder Terminalkonto kann keine persönliche Ausgabe,
  Rückgabebestätigung oder Filialleitungsaktion ersetzen.
- Vertrauliche Leihbelege und Fotos bleiben aus der offenen Übersicht
  ausgeschlossen.

## 7. Abnahme nach Block 4/8

- `161` Testdateien ausgeführt.
- `1.093` Tests gesamt.
- `1.069` bestanden.
- `24` übersprungen.
- `0` fehlgeschlagen.
- Syntaxprüfung erfolgreich:
  - `server.js`
  - `public/app.js`
  - `public/portal.js`
- `git diff --check` ist für die Block-4-Dateien sauber.
- Lokale Browserprüfung mit ausschließlich temporären QA-Daten erfolgreich:
  - Filial-/Terminalkontenkarte in der Verwaltungsansicht,
  - Kontoanlage über die Oberfläche,
  - reduziertes Portal mit genau Einstellungen, Dienstplan und Leihe,
  - Leihsuche über elf offene Geräte,
  - Ausgabe- und persönliche Leihbereiche für das Filialkonto verborgen,
  - Desktop- und Mobilansicht bei 375 Pixeln ohne Seitenüberlauf,
  - keine Browser-Konsolenfehler.
- Die temporäre QA-Instanz wurde beendet und vollständig entfernt.

Zusätzliche Block-4-Tests:

- `test/v087-block4-loan-overview.test.js`
- `test/v087-block4-organization-accounts.test.js`
- `test/v087-block4-organization-accounts-ui.test.js`

Nicht als Fehler werten:

- `test/v075-linux-hardening-package.test.js` bleibt aus der Gesamtsuite
  ausgespart, weil dieser Paket-Guard absichtlich einen bereits committeten,
  sauberen Git-Arbeitsbaum verlangt.

## 8. Nächster Block 5/8 – noch nicht begonnen

Block 5/8 ist die konfigurierbare Verarbeitung der Leihfotos als
PDF-Beilage:

- Fotos verkleinern,
- Graustufen beziehungsweise Schwarzweiß,
- mehrere Bilder kompakt zusammenfassen,
- Ausgabe- und Rückgabefotos getrennt behandeln,
- geschützte Vorschau und geschützter Download,
- Aufbewahrung oder Löschung der Farboriginale konfigurierbar,
- sichere Voreinstellung: Farboriginale geschützt behalten.

Block 5/8 darf erst nach ausdrücklicher Startfreigabe umgesetzt werden.

## 9. Startanweisung für die nächste Fortsetzung

1. Dieses Dokument vollständig lesen.
2. Branch, HEAD und Arbeitsbaum zuerst ausschließlich read-only prüfen.
3. Alle vorhandenen, noch nicht committeten Änderungen aus Block 1 bis Block 4
   erhalten.
4. Keine GitHub-, Release-, Produktions- oder VPS-Aktion ausführen.
5. Block 5/8 erst nach ausdrücklicher Freigabe starten.
