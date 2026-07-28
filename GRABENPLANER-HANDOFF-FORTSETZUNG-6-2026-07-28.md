# Grabenplaner – Übergabe für Fortsetzung #6

Stand: 28. Juli 2026
Nächster fachlicher Arbeitsblock: **Block 7/8 – Grundeinstellungen neu strukturieren**

## 1. Zweck und verbindlicher Arbeitsstand

Diese Übergabe setzt
`GRABENPLANER-HANDOFF-FORTSETZUNG-5-2026-07-28.md` fort. Der dort
beschriebene lokale Stand wurde vollständig erhalten und um Block 6/8 ergänzt.

- Lokales Repo:
  `C:\Users\chris\Documents\Lamprechter\Grabenplaner-mitterweg-pilot-v0863`
- Branch: `feature/v0864-cost-center-types`
- Basis-HEAD: `022a6b8`
- Block 1/8 bis Block 6/8 sind lokal umgesetzt und noch nicht committet.
- Der Arbeitsbaum bleibt absichtlich unsauber. Vorhandene Änderungen dürfen
  nicht verworfen, zurückgesetzt oder überschrieben werden.
- Es erfolgte kein Commit, Push, GitHub-, Release-, Produktions- oder
  VPS-Eingriff.
- Die acht Blöcke werden zuerst lokal abgeschlossen. Externe Schritte beginnen
  erst nach der ausdrücklichen Gesamtabnahme.

## 2. Übernommene Blöcke 1/8 bis 5/8

Unverändert übernommen sind:

- Block 1/8: datenbankgestütztes Kostenstellentyp-Modell einschließlich
  Positionszuordnung, Filialkennzeichen, Migration, Validierung, Audit und
  Profil-/Teildatenbankexport.
- Block 2/8: kostenstellengeführte Mitarbeiterzuordnung, Ableitung des
  Standorts bei Filialkostenstellen, gefilterte Positionsauswahl,
  kostenstellenbasierter Import und eingeklappte Mitarbeiter-/Personalaktbereiche.
- Block 3/8: ab Personalleitung gezielt delegierbare fachliche Einzelrechte
  unter Beibehaltung der serverseitigen Rollen-, Abhängigkeits- und
  Bereichsgrenzen.
- Block 4/8: datensparsame offene Leihübersicht sowie eigenständige,
  standortgebundene Filial- und Terminalkonten mit ausschließlich reduzierten
  Nur-Lese-Ansichten.
- Block 5/8: geschützte, unveränderliche Leihfoto-PDF-Beilagen mit getrennten
  Ausgabe-/Rückgabephasen, konfigurierbarer Bildausgabe und sicherer
  Aufbewahrungsregel für die aufbereitete Farbfassung.

Die Detailbeschreibungen und zugehörigen Tests stehen in den Übergaben
Fortsetzung #3 bis #5.

## 3. Block 6/8 – abgeschlossen: Regelprüfungsbereich folgt dem Benutzer

Der Öffnungszustand der Arbeitszeit-Regelprüfung wird nicht mehr aus dem
aktuellen Prüfergebnis abgeleitet:

- Der Bereich ist bei noch nicht gespeicherter Präferenz standardmäßig
  eingeklappt.
- Ein eingeklappter Bereich bleibt nach Anlegen, Speichern und Bearbeiten eines
  Dienstes eingeklappt.
- Das vollständige Datenneuladen nach einer Dienstmutation verändert den
  Öffnungszustand nicht.
- Hinweise und blockierende Befunde aktualisieren weiterhin Inhalt, Status,
  Warnfarbe und Zähler, öffnen den Bereich aber nicht automatisch.
- Ein bewusst geöffneter Bereich bleibt ebenfalls über einen Seitenreload
  geöffnet.
- Nach bewusstem Schließen bleibt der Bereich über einen Seitenreload
  geschlossen.

Die bisherigen Renderer-Zuweisungen an `workRuleAssessmentPanel.open` wurden
entfernt. Der Renderer aktualisiert nur noch das fachliche Ergebnis und die
Darstellung.

## 4. Benutzerbezogene Speicherung und Sicherheitsgrenzen

Die bestehende Präferenzinfrastruktur wurde erweitert:

- API-Feld: `workRuleAssessmentExpanded`
- Datenbankschlüssel: `work_rule_assessment_expanded`
- Speicherung pro persönlicher Mitarbeiterkennung in
  `portal_user_preferences`
- Datenbankwert `1` für geöffnet und `0` für geschlossen
- ausschließlich boolesche API-Werte zulässig
- kein Schemawechsel erforderlich, weil die vorhandene Präferenztabelle
  Schlüssel/Wert-basiert arbeitet

Im lokalen, ausdrücklich portal-freien Betrieb wird der Zustand mit einem
akteursbezogenen Schlüssel im lokalen Browserspeicher abgelegt. Der lokale
Fallback greift nur, wenn die API den Akteur ausdrücklich als `local` meldet
oder der Portalbetrieb tatsächlich deaktiviert ist. Ein Fehler oder ein
gesperrtes Organisationskonto wird dadurch nicht fälschlich als lokaler
Administrator behandelt.

Filial- und Terminalkonten bleiben von den Mitarbeiterpräferenzen getrennt:

- GET und PUT der Verwaltungspräferenzen antworten für Organisationskonten
  weiterhin mit HTTP 403.
- Der Zustand wird nicht in ein Organisationskonto oder dessen reduzierte
  Dienstplanansicht übertragen.

Schnelle aufeinanderfolgende Umschaltungen werden über eine Anforderungsnummer
geordnet. Bei einem aktuellen Speicherfehler wird auf den vorherigen Zustand
zurückgesetzt und eine Fehlermeldung angezeigt.

## 5. Geschlossener Kopf und blockierende Hinweise

Für Block 6 waren keine Änderungen an `public/index.html` oder
`public/styles.css` erforderlich:

- Status, Betriebsmodus und Ergebniszähler liegen bereits vollständig im
  `<summary>` des Bereichs.
- Der geschlossene Kopf zeigt daher weiterhin bestätigte Punkte, Hinweise,
  Prüffälle, Stammdatenhinweise und blockierte Punkte.
- Die bestehende Klasse `blocked` hält Rand, Farbe, Symbol und Blockiert-Zähler
  auch im geschlossenen Zustand auffällig.
- Die mobile Zählerdarstellung bleibt am linken Rand ausgerichtet.

## 6. Relevante Dateien und Regressionstests

Für Block 6 geändert beziehungsweise ergänzt:

- `server.js`
- `public/app.js`
- `test/v087-block6-work-rule-panel-state.test.js`
- `test/work-rule-planning-ui.test.js`
- `test/v087-block4-organization-accounts.test.js`

Die neue Block-6-Testreihe prüft insbesondere:

- sicheren Standardzustand,
- getrennte Präferenzen für zwei Mitarbeiter,
- boolesche Validierung und anonyme Sperre,
- Erhalt des Zustands bei partiellen Präferenzänderungen,
- Erhalt von `false` nach Dienstanlage und Dienstbearbeitung,
- fehlende automatische `open`-Zuweisung im Renderer,
- Status und Warnungszahlen im geschlossenen Kopf,
- blockierende Darstellung,
- lokalen, akteursbezogenen Speicherschlüssel,
- Schutz gegen überholte Speicherantworten,
- gesperrten GET- und PUT-Zugriff für Organisationskonten.

## 7. Abnahme nach Block 6/8

- Gezielte Regel-, Planungs-, Dienstmutations- und Rechteprüfung:
  - `12` Testdateien,
  - `97` Tests,
  - `97` bestanden,
  - `0` fehlgeschlagen.
- Ergänzende Organisationskonto-/Panelprüfung:
  - `14` Tests,
  - `14` bestanden,
  - `0` fehlgeschlagen.
- Gesamtsuite:
  - `165` Testdateien,
  - `1.109` Tests gesamt,
  - `1.085` bestanden,
  - `24` übersprungen,
  - `0` fehlgeschlagen.
- Syntaxprüfung erfolgreich:
  - `server.js`
  - `public/app.js`
- `git diff --check` ist sauber. Die ausgegebenen Hinweise betreffen nur die
  bestehende LF-/CRLF-Konvertierung des Windows-Arbeitsbaums.

Lokale Browserabnahme mit ausschließlich temporären QA-Daten:

- Ein aktiver Regelbetrieb mit einem tatsächlich blockierenden Befund wurde
  geladen.
- Der Bereich blieb geschlossen und zeigte im Kopf weiterhin:
  - `6` Prüffälle,
  - `1` blockierten Punkt,
  - die auffällige Blockiert-Darstellung.
- Nach Bearbeiten und Speichern eines Dienstes blieb der Bereich geschlossen.
- Nach Anlegen und Speichern eines weiteren Dienstes blieb der Bereich
  geschlossen.
- Geöffnet und geschlossen wurden jeweils über einen vollständigen
  Seitenreload beibehalten.
- Mobile Prüfung bei `390 × 844` Pixeln:
  - Bereich weiterhin geschlossen,
  - Kopfbreite innerhalb des mobilen Inhalts,
  - Zähler linksbündig,
  - keine automatische Öffnung.
- Keine Browser-Konsolenfehler.
- Temporärer QA-Server, Datenbank und Testdaten wurden vollständig entfernt.

Nicht als Fehler werten:

- `test/v075-linux-hardening-package.test.js` bleibt aus der Gesamtsuite
  ausgespart, weil dieser Paket-Guard absichtlich einen bereits committeten,
  sauberen Git-Arbeitsbaum verlangt.

## 8. Nächster Block 7/8 – noch nicht begonnen

Block 7/8 ist gemäß Übergabe Fortsetzung #3 ausschließlich für die
Neustrukturierung der Grundeinstellungen vorgesehen:

- Betriebsmodus vollständig aus Oberfläche, Einstellungen, überflüssigen
  Berechtigungen und totem Servercode entfernen.
- Warnmeldungsdauer zu „Ansicht und Startverhalten“ verschieben.
- Bisherige Auswahl „klein / standard / groß“ vollständig entfernen.
- Nur noch numerische Schriftgrößensteuerung nach Google-Docs-Prinzip:
  - Minus,
  - Zahl beziehungsweise Prozentwert,
  - Plus.
- Änderung sofort als Vorschau im gesamten Grabenplaner anwenden.
- Dauerhaft erst nach Speichern übernehmen.
- Bestehende Werte verlustfrei auf numerische Größen migrieren.
- Leihe, Branding und PDF-Ausgabe in die Grundeinstellungen integrieren:
  - standardmäßig eingeklappt,
  - PDF-Ausgabe eher am Seitenende.
- Bei Karten und Feldern bleibt die gemeinsame Breite erhalten.
- Nur vertikale Länge beziehungsweise Höhe sinnvoll am Inhalt ausrichten;
  keine unnötig gleich hohen Karten.
- Layout bei unterschiedlichen Schriftgrößen sowie auf Desktop und mobil
  prüfen.

Diese Anforderungen sind nur die Übergabe für den nächsten Arbeitsblock und
keine Umsetzungsfreigabe. Block 7/8 darf erst nach ausdrücklicher
Startfreigabe umgesetzt werden.

## 9. Startanweisung für die nächste Fortsetzung

1. Dieses Dokument vollständig lesen.
2. Branch, HEAD und Arbeitsbaum zuerst ausschließlich read-only prüfen.
3. Alle vorhandenen, noch nicht committeten Änderungen aus Block 1 bis Block 6
   erhalten.
4. Keine GitHub-, Release-, Produktions- oder VPS-Aktion ausführen.
5. Block 7/8 erst nach ausdrücklicher Freigabe starten.
