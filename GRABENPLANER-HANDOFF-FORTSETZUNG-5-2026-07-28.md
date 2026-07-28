# Grabenplaner – Übergabe für Fortsetzung #5

Stand: 28. Juli 2026
Nächster fachlicher Arbeitsblock: **Block 6/8 – Zustand der Arbeitszeit-Regelprüfung**

## 1. Zweck und Arbeitsstand

Diese Übergabe setzt
`GRABENPLANER-HANDOFF-FORTSETZUNG-4-2026-07-28.md` fort. Der dort
beschriebene lokale Stand wurde vollständig erhalten und um Block 5/8 ergänzt.

- Lokales Repo:
  `C:\Users\chris\Documents\Lamprechter\Grabenplaner-mitterweg-pilot-v0863`
- Branch: `feature/v0864-cost-center-types`
- Basis-HEAD: `022a6b8`
- Block 1/8 bis Block 5/8 sind lokal umgesetzt und noch nicht committet.
- Der Arbeitsbaum bleibt absichtlich unsauber; vorhandene Änderungen dürfen
  nicht verworfen, zurückgesetzt oder überschrieben werden.
- Es erfolgte kein Commit, Push, GitHub-, Release-, Produktions- oder
  VPS-Eingriff.
- Die acht Blöcke werden zuerst lokal abgeschlossen. Externe Schritte beginnen
  erst nach der ausdrücklichen Gesamtabnahme.

## 2. Übernommene Blöcke 1/8 bis 4/8

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

Die Detailbeschreibungen und zugehörigen Tests stehen in den Übergaben
Fortsetzung #3 und #4.

## 3. Block 5/8 – abgeschlossen: unveränderliche Leihfoto-PDF-Beilagen

Jeder neue Foto-Upload erzeugt jetzt zusätzlich zu den Fotoeinträgen eine
geschützte, unveränderliche PDF-Teilbeilage:

- Ausgabe- und Rückgabefotos bleiben fachlich getrennt.
- Jede Upload-Charge erhält eine eigene Revision, beispielsweise Beilage B1
  oder B2.
- Die Fotonummerierung läuft je Phase auch über spätere und parallele Uploads
  korrekt weiter.
- Pro A4-Seite werden höchstens zwei Fotos mit Dateibezeichnung,
  Vorgangsbezug, Phase und laufender Nummer dargestellt.
- Die PDF-Ausgabe ist je Standort als Graustufe oder Schwarzweiß einstellbar.
- Foto- und PDF-Erzeugung, Datenbankeinträge, Ereignis und Audit werden als
  zusammengehöriger Vorgang behandelt.
- Parallel eingehende Uploads desselben Leihvorgangs werden serialisiert.

Die PDF-Beilage wird verschlüsselt im bestehenden geschützten Blob-Speicher
abgelegt. Nachträgliches Ändern oder Löschen eines Foto- oder Beilageneintrags
wird durch Datenbanktrigger verhindert.

Wichtige Bausteine:

- `lib/loan-photo-pdf.js`
- Tabelle `loan_photo_attachments`
- Migrationskennung `v0.87-loan-photo-pdf-attachments`
- `GET /api/portal/v1/loans/photo-attachments/:id/preview`
- `GET /api/portal/v1/loans/photo-attachments/:id/download`

## 4. Farbfassungen und Aufbewahrung

Die App speichert weiterhin niemals die unveränderte Datei des Mobiltelefons.
Das bisherige Leihfoto ist eine neu codierte, metadatenfreie und verkleinerte
Farbfassung. Diese fachlich korrekte Bezeichnung ersetzt deshalb den
missverständlichen Begriff „Farboriginal“ in der Oberfläche.

Je Standort stehen für neue Uploads zwei Aufbewahrungsvarianten zur Verfügung:

- `retain`: aufbereitete Farbfassung geschützt aufbewahren,
- `delete`: aufbereitete Farbfassung erst nach erfolgreicher PDF-Erzeugung
  löschen.

Der sichere Standard ist `retain`. Bei `delete` bleiben die unveränderliche
PDF-Beilage und ein revisionsfester Löschstatus erhalten; der direkte
Fotoabruf antwortet danach mit HTTP 410.

Die Einstellung gilt nur für neu hochgeladene Fotos. Bereits vorhandene
Farbfassungen werden sicher als aufbewahrt behandelt; historische Fotos werden
nicht nachträglich in neue PDF-Beilagen umgewandelt.

## 5. Geschützte Vorschau, Download und Zeugenbegrenzung

Verwaltung und Mitarbeiterportal zeigen je Beilage:

- Phase Ausgabe oder Rückgabe,
- Beilagenrevision,
- Fotoanzahl,
- Ausgabemodus,
- Aufbewahrungsstatus,
- geschützte Vorschau,
- geschützten PDF-Download.

Die Routen verwenden die bestehenden vertraulichen Leihzugriffsregeln.
Unbeteiligte Beschäftigte und Filial-/Terminalkonten erhalten keinen Zugriff.
Bei einer ausstehenden Rückgabebestätigung werden Foto- und Beilagen-IDs im
Bestätigungsvorgang festgehalten; eine zweite bestätigende Person sieht damit
nur die konkret zu diesem Vorgang gehörenden Rückgabeunterlagen und keine
historischen Beilagen.

Vorschau und Download werden mit privatem `no-store`, `Pragma: no-cache`,
`nosniff`, korrekter Länge und festem PDF-Inhaltstyp ausgeliefert.

## 6. Migration, Sicherung und Wiederherstellung

Vor der Block-5-Schemaerweiterung wird bei einem bestehenden Datenbestand ein
vollständiger interner Sicherungspunkt erstellt. Die Migration ergänzt:

- die PDF-Einstellungen je Standort,
- den unveränderlichen Aufbewahrungs- und Löschstatus der Fotos,
- die Tabelle für PDF-Beilagen,
- die zugehörigen Konsistenz- und Unveränderlichkeitstrigger.

Ein vollständig migrierter Datenbestand wurde ausdrücklich in einem zweiten
Serverstart geprüft. Damit ist auch der Wiederanlauf ohne erneuten
Migrationsbedarf abgesichert.

Die Sicherungs- und Wiederherstellungslogik wurde für Linux, Windows und die
Offsite-Prüfung erweitert:

- geschützte PDF-Beilagen werden immer als aktive Referenzen gesichert,
- gelöschte Farbfassungen werden nicht mehr als erforderliche Blobs behandelt,
- bei alten Datenbanken ohne neue Aufbewahrungsspalte gilt der sichere
  Rückwärtskompatibilitätsfall,
- eine fehlende aktive PDF-Beilage lässt Verifikation beziehungsweise
  Wiederherstellungsprüfung fehlschlagen.

## 7. Abnahme nach Block 5/8

- `164` Testdateien ausgeführt.
- `1.106` Tests gesamt.
- `1.082` bestanden.
- `24` übersprungen.
- `0` fehlgeschlagen.
- Syntaxprüfung erfolgreich:
  - `server.js`
  - `lib/loan-photo-pdf.js`
  - `public/app.js`
  - `public/portal.js`
  - neue Block-5-Tests
- `git diff --check` ist sauber; die ausgegebenen Hinweise betreffen nur die
  bestehende LF-/CRLF-Konvertierung des Windows-Arbeitsbaums.
- PDF-Abnahme erfolgreich:
  - fünf Testfotos auf drei A4-Seiten,
  - Graustufen- und Schwarzweißverarbeitung,
  - keine Überlagerung oder abgeschnittenen Inhalte,
  - Seitenformat, Text und Fotozählung zusätzlich programmatisch geprüft.
- Lokale Browserabnahme mit ausschließlich temporären QA-Daten erfolgreich:
  - Desktop-Einstellungen bei 1.440 Pixeln,
  - sicherer Standard Graustufe plus geschützte Farbfassung,
  - klarer Hinweis, dass die unveränderte Handydatei nicht gespeichert wird,
  - Mitarbeiterportal bei 390 × 844 Pixeln,
  - Foto, Beilage B1, Vorschau und Download in der offenen Leihe,
  - geschützte PDF-Vorschau im Browser,
  - keine Browser-Konsolenfehler.
- Die temporäre QA-Instanz, Testdaten, PDFs, Bilder und Testprotokolle wurden
  beendet beziehungsweise vollständig entfernt.

Neue Block-5-Tests:

- `test/loan-photo-pdf.test.js`
- `test/v087-block5-loan-photo-appendix.test.js`
- `test/v087-block5-loan-photo-migration.test.js`

Zusätzlich erweitert wurden insbesondere:

- `test/v085-loan-foundation.test.js`
- Sicherungs-, Wiederherstellungs- und Offsite-Testreihen.

Nicht als Fehler werten:

- `test/v075-linux-hardening-package.test.js` bleibt aus der Gesamtsuite
  ausgespart, weil dieser Paket-Guard absichtlich einen bereits committeten,
  sauberen Git-Arbeitsbaum verlangt.

## 8. Nächster Block 6/8 – noch nicht begonnen

Block 6/8 behandelt ausschließlich den benutzerbezogenen Zustand der
Arbeitszeit-Regelprüfung:

- Eingeklappt bleibt eingeklappt.
- Das gilt auch nach Anlegen, Speichern oder Bearbeiten eines Dienstes.
- Datenneuladen darf den Bereich nicht eigenmächtig öffnen.
- Status- und Warnungsanzahl bleiben im geschlossenen Kopf sichtbar.
- Auch blockierende Meldungen dürfen auffällig sein, öffnen den Bereich aber
  nicht automatisch.
- Der Zustand wird benutzerbezogen gespeichert.

Diese Anforderungen sind nur die Übergabe für den nächsten Arbeitsblock und
keine Umsetzungsfreigabe. Block 6/8 darf erst nach ausdrücklicher
Startfreigabe umgesetzt werden.

## 9. Startanweisung für die nächste Fortsetzung

1. Dieses Dokument vollständig lesen.
2. Branch, HEAD und Arbeitsbaum zuerst ausschließlich read-only prüfen.
3. Alle vorhandenen, noch nicht committeten Änderungen aus Block 1 bis Block 5
   erhalten.
4. Keine GitHub-, Release-, Produktions- oder VPS-Aktion ausführen.
5. Block 6/8 erst nach ausdrücklicher Freigabe starten.
