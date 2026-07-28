# Grabenplaner – Übergabe für Fortsetzung #7

Stand: 28. Juli 2026
Nächster fachlicher Arbeitsblock: **Block 8/8 – Migration und Gesamtabnahme**

## 1. Zweck und verbindlicher Arbeitsstand

Diese Übergabe setzt
`GRABENPLANER-HANDOFF-FORTSETZUNG-6-2026-07-28.md` fort. Der dort
beschriebene lokale Stand wurde vollständig erhalten und um Block 7/8 ergänzt.

- Lokales Repo:
  `C:\Users\chris\Documents\Lamprechter\Grabenplaner-mitterweg-pilot-v0863`
- Branch: `feature/v0864-cost-center-types`
- Basis-HEAD: `022a6b8`
- Block 1/8 bis Block 7/8 sind lokal umgesetzt und noch nicht committet.
- Der Arbeitsbaum bleibt absichtlich unsauber. Vorhandene Änderungen dürfen
  nicht verworfen, zurückgesetzt oder überschrieben werden.
- Es erfolgte kein Commit, Push, GitHub-, Release-, Produktions- oder
  VPS-Zugriff.

## 2. Block 7/8 – Ergebnis

Die Grundeinstellungen wurden vollständig nach dem freigegebenen Block-7-Scope
neu strukturiert.

### Betriebsmodus

Aus der Verwaltungsoberfläche entfernt wurden:

- die Betriebsmodus-Karte,
- die Browserauswahl und der separate Speicherweg,
- die Berechtigung `operation_mode:write`,
- der Mutationsendpunkt `/api/operation-mode`,
- der alte lokale Neustartendpunkt `/api/system/restart`,
- die dafür ausschließlich benötigten Client- und Serverfunktionen,
- der alte Datenbankwert `settings.operation_mode`.

Öffentliche Verwaltungsdateien enthalten keine sichtbaren Bezeichnungen
`Betriebsmodus`, `Servermodus`, `Lokalbetrieb`, `LAN-Betrieb` oder
`Geschützter LAN-Zugang` mehr.

Bewusst erhalten blieben die nicht über den Browser änderbaren
Laufzeitsicherungen:

- `GRABENPLANER_OPERATION_MODE`,
- `configuredOperationMode`,
- `serverModeActive`,
- die interne Statuskompatibilität `operationMode`.

Diese Pfade steuern weiterhin unter anderem HTTPS-, Origin-, Cookie-,
Schlüssel-, Scanner-, Backup-, Offsite- und Produktionsschutz. Sie sind keine
Benutzereinstellung und dürfen nicht pauschal entfernt werden.

## 3. Datenbank- und Rechtemigration

Die idempotente Migration
`v0.87-block7-settings-appearance` ist in den bestehenden
Pre-Migration-Backup-Gate eingebunden.

Sie:

- entfernt `operation_mode` aus `settings`,
- entfernt `operation_mode:write` aus individuellen Grants und Denials,
- entfernt das alte Recht auch aus eigenen Rollen-JSONs,
- migriert `dashboard_font_size` je Benutzer auf
  `app_font_scale_percent`,
- löscht anschließend den alten Präferenzschlüssel.

Die verlustfreie Zuordnung lautet:

- `compact` → `85`,
- `standard` → `100`,
- `large` → `115`.

Ein bereits vorhandener gültiger numerischer Wert gewinnt gegenüber dem
Legacy-Wert. Lesen und Speichern bleiben während des Übergangs defensiv;
neue Schreibvorgänge verwenden ausschließlich den numerischen Schlüssel.

Zusätzlich läuft eine enge idempotente Bereinigung der entfernten
Berechtigung und Einstellung auch dann, wenn ein historischer Datenbestand
den Migrationsmarker bereits enthält.

## 4. Numerische Schriftgröße

Die bisherige globale Auswahl klein/standard/groß wurde durch eine
Google-Docs-artige Steuerung ersetzt:

- Minus-Schaltfläche,
- editierbarer Prozentwert,
- Plus-Schaltfläche.

Vertrag:

- Bereich `75` bis `150` Prozent,
- ausschließlich ganze 5er-Schritte,
- Standard `100`,
- API-Feld `appFontScalePercent`,
- Datenbankschlüssel `app_font_scale_percent`.

Die Änderung wird sofort im gesamten Grabenplaner als Vorschau angewendet.
Erst die globale Schaltfläche **Einstellungen speichern** übernimmt sie
dauerhaft. Ein Neuladen ohne Speichern stellt den letzten gespeicherten Wert
wieder her. Ein Speicherfehler setzt die Vorschau auf den letzten bestätigten
Wert zurück.

Auch der frühere benutzerbezogene Browserwert wird einmalig auf 85/100/115
überführt. Organisationskonten bleiben vom Präferenzendpunkt ausgeschlossen.

Die Skalierung verwendet eine globale CSS-Variable am gesamten
Anwendungskörper. Nur die feste mobile Sicherheits-Mindestbreite wird invers
kompensiert, damit 150 Prozent auf einem 390-Pixel-Viewport keinen
Seitenüberlauf erzeugen.

## 5. Neue Struktur der Grundeinstellungen

In **Ansicht & Startverhalten** liegen nun gemeinsam:

- Wiedereinstieg in Dienstplan- und Urlaubs-Gesamtplan,
- Sonntagssichtbarkeit,
- globale Schriftgröße,
- Anzeigedauer für Warnmeldungen.

In die Grundeinstellungen integriert wurden:

- Leihe je Standort,
- Branding,
- PDF-Ausgabe.

Alle drei Bereiche sind echte `<details>`-Accordions und beim normalen
Öffnen standardmäßig geschlossen. Die PDF-Ausgabe liegt nach Leihe und
Branding am Ende der integrierten Bereiche. Bestehende Feld-IDs und die
fachlichen Leih-, Branding- und PDF-Funktionen wurden erhalten.

Die Rechte bleiben getrennt:

- `settings:write` schützt Ansicht, PDF und allgemeine Einstellungen,
- `branding:write` schützt Branding und erlaubt dessen globales Speichern,
- `loans:settings` schützt die Leiheinstellungen.

Der Reiter **Grundeinstellungen** ist sichtbar, sobald mindestens eines
dieser Fachrechte vorhanden ist. Die einzelnen Accordions werden trotzdem
separat ausgeblendet. Dirty Branding wird auch aus der integrierten
Grundeinstellung gespeichert; stille PDF-Vorschauen speichern weder
Schriftvorschau noch Branding unbeabsichtigt.

## 6. Layoutkorrekturen aus der echten Browserprüfung

Die Browserprüfung zeigte zwei reale Grenzfälle, die im Block behoben wurden:

1. Chromium kompensiert `zoom` bereits selbst. Eine zunächst zusätzliche
   Seitenbreitenkompensation wurde deshalb wieder entfernt.
2. Die Desktop-Aktionsleiste und das starre Fünfspalten-Kennzahlenraster
   konnten bei hoher Skalierung überlaufen.

Der endgültige Stand:

- Aktionsleisten dürfen geordnet umbrechen.
- Das Dienstplan-Kennzahlenraster verwendet ein adaptives Auto-Fit-Raster.
- Der Zeitstrahl bleibt in seinem eigenen horizontalen Scrollbereich.
- Einstellungsraster verwenden inhaltsabhängige Zeilen,
  `align-items: start` und Kartenhöhen `auto`.
- Branding-Innenraster und PDF-Karten behalten gemeinsame Breiten, aber
  unterschiedliche sinnvolle Inhaltshöhen.
- Die gesamte Oberfläche bleibt in einer serifenlosen Schriftfamilie.

## 7. Relevante Dateien

Für Block 7 geändert beziehungsweise ergänzt:

- `server.js`
- `lib/usb-profile-database.js`
- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `public/portal.js`
- `test/portal-foundation.test.js`
- `test/v0611-usb-profile-database.test.js`
- `test/v065-settings-layout.test.js`
- `test/v071-page-appearance.test.js`
- `test/v077-system-center-ui.test.js`
- `test/v078-system-center-ui.test.js`
- `test/v087-block7-settings-appearance.test.js`

Die übrigen uncommitteten Dateien gehören zu den bereits übernommenen
Blöcken 1 bis 6 und wurden nicht zurückgesetzt.

## 8. Automatische Prüfungen

### Syntax und gezielte Regressionen

Erfolgreich geprüft:

- `server.js`
- `public/app.js`
- `public/portal.js`
- `lib/usb-profile-database.js`
- Portalrollen und entfernte Browser-API
- USB-Profil-Datenbank
- Einstellungsstruktur
- numerische UI-Präferenz und Grenzwerte
- System-Center-Anbindung an die globale Skalierung
- echte Block-7-Datenbankmigration

Der neue Migrationstest startet einen bestehenden Datenbestand mit:

- drei Benutzern mit `compact`, `standard`, `large`,
- einem Benutzer mit vorhandenem numerischem Wert,
- altem Setting,
- altem Grant und Denial,
- eigener Rolle mit dem alten Recht.

Danach sind 85/100/115 beziehungsweise der vorhandene numerische Wert
getrennt erhalten; alle aktiven Betriebsmodus-Reste sind entfernt.

### Gesamtsuite

Ausgeführt wurden 166 Testdateien seriell mit dem gebündelten Node.js:

- Tests gesamt: `1112`
- bestanden: `1088`
- fehlgeschlagen: `0`
- übersprungen: `24`
- Dauer: rund `185,5 s`

Wie in der vorherigen Übergabe vereinbart, blieb ausschließlich
`test/v075-linux-hardening-package.test.js` ausgespart. Dieser Paketguard
verlangt absichtlich einen bereits committeten, sauberen Git-Arbeitsbaum und
ist deshalb für den noch uncommitteten Acht-Block-Arbeitsstand nicht
aussagekräftig.

Nach der abschließenden neutralen Zugangsbeschriftung wurden die neun direkt
betroffenen Layout-, Präferenz- und Migrationstests erneut ausgeführt:
`9/9` bestanden.

`git diff --check` ist ohne Fehler; die ausgegebenen LF/CRLF-Hinweise sind die
bestehende Windows-Git-Zeilenendenkonfiguration.

## 9. Browser-QA

Geprüft wurde ein temporärer lokaler Server mit eigener Testdatenbank.

Desktop `1440 × 1000`:

- 75, 100 und 150 Prozent,
- keine horizontale Seitenüberbreite in Grundeinstellungen,
- keine horizontale Seitenüberbreite in der Dienstplanung,
- geschlossene Accordions mit gemeinsamer Breite,
- inhaltsabhängige Kartenhöhen,
- adaptives Kennzahlenraster,
- Zeitstrahl bleibt intern scrollbar.

Mobil `390 × 844`:

- 75, 100 und 150 Prozent,
- keine horizontale Seitenüberbreite,
- Schriftsteuerung vollständig innerhalb des Viewports,
- Leihe, Branding und PDF standardmäßig geschlossen,
- geöffnetes PDF-Accordion ohne Seitenüberlauf,
- unterschiedliche PDF-Kartenhöhen entsprechend dem Inhalt.

Funktionsprüfung:

- 150-Prozent-Vorschau ohne Speichern → Reload stellt 100 wieder her,
- 115 Prozent gespeichert → Reload behält 115,
- keine Browser-Konsolenfehler oder Warnungen.

Der temporäre QA-Server, seine Testdatenbank und alle erzeugten Testbackups
wurden anschließend vollständig entfernt.

## 10. Nächster Block 8/8 – noch nicht begonnen

Block 8/8 ist ausschließlich für Migration und Gesamtabnahme vorgesehen:

- verlustfreie Migration bestehender Kostenstellen und Mitarbeitender,
- doppelte beziehungsweise widersprüchliche alte
  Stammfilialzuordnungen bereinigen,
- Rechteprüfung für PL+, besonders Benutzer `275`,
- sicherstellen, dass `fil18` und andere Nicht-Mitarbeiterkonten nirgends als
  Mitarbeiter erscheinen,
- Desktop- und Mobiltests,
- Schriftgrößen- und Layouttests,
- Leihübersicht, Suche, Foto-PDFs und Zugriffsgrenzen,
- bestehende Ausgabe-, Rückgabe- und Filialleitungsfunktionen,
- Datenbank-, Rollen-, Audit- und Sicherheitsprüfung.

Erst nach dieser Gesamtabnahme darf ein eigener, bewusst freigegebener
Commit-/GitHub-/Release-/VPS-Block folgen. Die Block-8-Freigabe ist keine
automatische Freigabe für diese externen Schritte.

Diese Anforderungen sind nur die Übergabe für den nächsten Arbeitsblock.
Block 8/8 darf erst nach ausdrücklicher Startfreigabe begonnen werden.

## 11. Startanweisung für die nächste Fortsetzung

1. Dieses Dokument vollständig lesen.
2. Branch, HEAD und Arbeitsbaum zuerst ausschließlich read-only prüfen.
3. Alle vorhandenen, noch nicht committeten Änderungen aus Block 1 bis
   Block 7 erhalten.
4. Keine GitHub-, Release-, Produktions- oder VPS-Aktion ausführen.
5. Block 8/8 erst nach ausdrücklicher Freigabe starten.
