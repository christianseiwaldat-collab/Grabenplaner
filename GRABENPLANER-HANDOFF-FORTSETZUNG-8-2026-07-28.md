# Grabenplaner – Übergabe nach Abschluss von Block 8/8

Stand: 28. Juli 2026

Fachlicher Arbeitsstand: **Block 1/8 bis Block 8/8 lokal umgesetzt und
abgenommen**

## 1. Zweck und verbindlicher Arbeitsstand

Diese Übergabe setzt
`GRABENPLANER-HANDOFF-FORTSETZUNG-7-2026-07-28.md` fort. Der dort
beschriebene lokale Stand wurde vollständig erhalten und um Block 8/8
ergänzt.

- Lokales Repo:
  `C:\Users\chris\Documents\Lamprechter\Grabenplaner-mitterweg-pilot-v0863`
- Branch: `feature/v0864-cost-center-types`
- Basis-HEAD: `022a6b8`
- Paket- und sichtbare Produktversion bleiben `v0.86.3 Beta`.
- Block 1/8 bis Block 8/8 sind lokal umgesetzt und noch nicht committet.
- Der Arbeitsbaum bleibt absichtlich unsauber. Vorhandene Änderungen dürfen
  nicht verworfen, zurückgesetzt oder überschrieben werden.
- Es erfolgte kein Commit, Push, GitHub-, Release-, Produktions- oder
  VPS-Zugriff.

Die Freigabe für Block 8/8 umfasste ausschließlich Migration und
Gesamtabnahme. Sie ist keine Freigabe für einen Commit, eine Veröffentlichung
oder eine Serveränderung.

## 2. Block 8/8 – Ergebnis

Block 8 schließt die acht lokalen Arbeitsblöcke mit vier Schwerpunkten ab:

1. verlustfreie und belegbare Bereinigung historischer
   Kostenstellenzuordnungen,
2. durchgängige Trennung von Beschäftigten- und Organisationskonten,
3. abschließende Zugriffs-, Audit- und Aktualisierungsprüfung des Leihmoduls,
4. vollständige automatisierte und reale Browserabnahme.

## 3. Verlustfreie Kostenstellenmigration

Die Migration `v0.87-block8-principal-separation` ergänzt den bestehenden
Migrations- und Sicherungsrahmen.

### Fachliche Führungsregel

Die Kostenstelle bleibt die führende organisatorische Zuordnung:

- Eine aktive Filialkostenstelle leitet den zugehörigen
  `home_location_id` ab.
- Eine Nicht-Filialkostenstelle leitet keinen Stammstandort ab; ein
  widersprüchlicher historischer Wert wird deshalb auf `NULL` gesetzt.
- Eine bevorzugte Abteilung bleibt nur erhalten, wenn sie zum daraus
  abgeleiteten Stammstandort gehört.
- Person, Personalnummer, Kostenstelle, Beschäftigungsdaten und andere
  Kerndaten werden nicht gelöscht oder neu angelegt.

Diese Regel entspricht
`docs/MITARBEITER-KOSTENSTELLENZUORDNUNG-v0.1.md`.

### Reparaturerkennung und Sicherung

Vor dem Migrationslauf wird nun nicht nur auf fehlende Marker oder Trigger,
sondern auch zeilenbezogen auf tatsächlich widersprüchliche Bestandsdaten
geprüft.

Ein Vor-Migrations-Backup wird dadurch auch dann zwingend erstellt, wenn:

- der frühere Migrationsmarker bereits vorhanden ist,
- aber Kostenstellentyp-, Kostenstellen- oder
  Mitarbeiterzuordnungsdaten noch repariert werden müssen,
- oder die neuen Principal-Trenner fehlen.

Der Test beweist, dass die Sicherung noch den unveränderten Zustand vor der
Reparatur enthält.

### Audit und Nachbedingungen

Jede tatsächlich geänderte Person erhält einen kompakten Audit-Eintrag:

- Akteur: `system`
- Aktion: `employee.cost-center.reconcile`
- Entität: `employee`
- Detail: Migrationskennung, Grund, Kostenstelle sowie Vorher/Nachher-Werte
  für Stammstandort und bevorzugte Abteilung

Nach der Migration werden zusätzlich geprüft:

- die fachlichen Mitarbeiter-Kostenstellen-Invarianten,
- `PRAGMA foreign_key_check`,
- `PRAGMA quick_check`.

Der zweite Start mit demselben bereits bereinigten Datenbestand erzeugt weder
ein weiteres Reparatur-Audit noch ein weiteres Migrationsbackup.

## 4. Trennung von Personen- und Organisationskonten

Vier Datenbanktrigger verhindern neue, case-insensitive Login-Kollisionen in
beiden Richtungen:

- Beschäftigtenzugang gegen vorhandenes Organisationskonto,
- Änderung eines Beschäftigtenzugangs gegen Organisationskonten,
- Organisationskonto gegen vorhandenen Beschäftigtenzugang,
- Änderung eines Organisationskontos gegen Beschäftigtenzugänge.

Zusätzlich prüft die Serverlogik die Kollision bereits vor dem
Datenbankschreiben. Der einheitliche Fehlercode lautet:
`PORTAL_PRINCIPAL_LOGIN_CONFLICT`.

Die Prüfung gilt für:

- direkte Mitarbeiteranlage beziehungsweise Zugangsanlage,
- Personalimport-Vorschau,
- Personalimport-Anwendung,
- Organisationskonto-Anlage und -Bearbeitung.

Geprüft wurde insbesondere die umgekehrte Reihenfolge:

1. Organisationskonto `FIL18` wird angelegt.
2. Danach wird eine Person beziehungsweise ein Personalimport mit
   `fil18` versucht.
3. Vorschau und Anwendung weisen den Konflikt ab, ohne eine Person, einen
   Benutzer oder Nebenzeilen anzulegen.

`fil18` und andere Organisationskonten erscheinen weiterhin nicht in:

- Mitarbeiterlisten,
- Benutzer- und Rechtezuordnungen für Personen,
- Teammitgliederlisten,
- Rücknahmezeugen-Auswahlen.

## 5. Leihmodul – Zugriffs- und Aktualisierungsabschluss

### Direkte Leihübersicht

Die standortbezogene Direktübersicht wird nun nach jeder bestandsändernden
Portalaktion gemeinsam mit der persönlichen beziehungsweise
leitungsbezogenen Leihliste neu geladen:

- nach einer neuen Ausgabe,
- nach einer Leitungsbearbeitung,
- nach manuellem Schließen,
- nach Wiederöffnen,
- nach bestätigter Rücknahme.

Damit bleibt die offene Geräteübersicht ohne manuelles Aktualisieren aktuell.

### Rollen- und Standortgrenzen

Automatisiert geprüft sind:

- Neue Leihen gehören serverseitig immer der angemeldeten Person.
- Ein Rücknahmezeuge muss ein aktives zweites Teammitglied derselben Filiale
  sein.
- Ein Teammitglied einer Fremdfiliale wird als Zeuge abgewiesen, ohne den
  Leihzustand zu verändern.
- Filialleitung kann ausschließlich Leihen der eigenen Filiale lesen,
  bearbeiten, schließen oder wieder öffnen.
- Fremdfilial-Leihe, Ausgabebeleg, Rücknahmebeleg, Foto und Foto-PDF-Beilage
  bleiben für die Leitung mit `403` gesperrt.
- Organisationskonten erhalten keine Ausgabe-, Rücknahme-, Zeugen- oder
  Leitungsfunktion.

### CSRF, anonyme Dateien und Audit

Geprüft sind fehlende beziehungsweise falsche CSRF-Token für sämtliche
Leihmutationen. Die Versuche verändern weder Revision noch Status.

Anonyme Zugriffe auf geschützte Leihdokumente, Fotos und Foto-PDF-Beilagen:

- liefern keine Schutzdatei aus,
- erzeugen keine erfolgreiche Dateiaktion,
- verändern keine Leihdaten.

Die erfolgreiche Kette aus Ausgabe, Bearbeitung, Schließen, Wiederöffnen,
Rücknahmeanforderung und Bestätigung erzeugt zuordenbare, inhaltsarme Audits
mit Akteur, Aktion, Entität und minimalem Detail.

### Backup- und Recovery-Vertrag

Die neue Tabelle `loan_photo_attachments` ist nun auch in den statischen
Backup- und Serverwerkzeug-Vertragsprüfungen ausdrücklich enthalten.

## 6. In Block 8 berührte Dateien

Produktlogik:

- `server.js`
- `public/portal.js`

Neue beziehungsweise erweiterte Nachweise:

- `test/v087-block8-cost-center-migration.test.js`
- `test/v071-cost-centers-personnel.test.js`
- `test/v087-block4-organization-accounts.test.js`
- `test/v087-block4-loan-overview.test.js`
- `test/v085-loan-foundation.test.js`
- `test/backup-commit.test.js`
- `test/v061-server-tools.test.js`

Die übrigen uncommitteten Dateien gehören zu den bereits übernommenen
Blöcken 1 bis 7 und wurden nicht zurückgesetzt.

## 7. Gezielte Prüfungen

Erfolgreich ausgeführt:

- Syntaxprüfung `server.js`
- Syntaxprüfung `public/portal.js`
- neue Kostenstellen-Reparaturmigration: `1/1`
- Organisationskonto- und Importkollisionen: `28/28`
- breitere Migration-, Rechte- und Backup-Prüfungen: `49/49`
- Leihmodul und Direktübersicht: `25/25`
- Leihgrundlage einschließlich neuer Sicherheitsfälle: `20/20`

`git diff --check` ist ohne Fehler. Die ausgegebenen LF/CRLF-Hinweise sind
die bestehende Windows-Git-Zeilenendenkonfiguration.

## 8. Vollständige lokale Testsuite

Ausgeführt wurden alle 167 Testdateien mit Ausnahme des bekannten
Clean-Tree-Paketwächters:

- Tests gesamt: `1120`
- bestanden: `1096`
- fehlgeschlagen: `0`
- übersprungen: `24`

Die Suite wurde mit dem gebündelten Node.js seriell und wegen der
Ausgabegröße in vier lückenlosen, alphabetisch sortierten Gruppen
ausgeführt:

1. `317` Tests – `312` bestanden, `5` übersprungen
2. `311` Tests – `308` bestanden, `3` übersprungen
3. `259` Tests – `245` bestanden, `14` übersprungen
4. `233` Tests – `231` bestanden, `2` übersprungen

Ausgespart blieb ausschließlich
`test/v075-linux-hardening-package.test.js`. Dieser Paketguard verlangt
absichtlich einen bereits committeten und sauberen Git-Arbeitsbaum. Er ist
für den bewusst uncommitteten Acht-Block-Arbeitsstand nicht ausführbar.

## 9. Reale Browserabnahme

Geprüft wurde eine temporäre lokale Instanz auf `127.0.0.1:31988` mit eigener
Sporthandel-Testdatenbank. Die bereits geöffnete Nutzerinstanz auf Port
`31987` wurde nicht berührt.

### Desktop `1440 × 1000`

Grundeinstellungen:

- 75, 100 und 150 Prozent
- Hell- und Dunkelmodus
- kein horizontaler Seiten- oder Hauptbereichsüberlauf
- Leihe, Branding und PDF standardmäßig geschlossen
- identische Breite und bündige Kanten der drei Accordions

Leihverwaltung:

- 11 vorbereitete offene Leihen vollständig geladen
- Zusammenfassung und Karten ohne Seitenüberlauf
- nach der Browserausgabe 12 offene Leihen sichtbar

### Mobile Verwaltungsansicht `390 × 844`

- 75, 100 und 150 Prozent
- Hell- und Dunkelmodus
- Schriftsteuerung vollständig innerhalb des Viewports
- kein horizontaler Seiten- oder Hauptbereichsüberlauf
- Leihe, Branding und PDF bei allen Größen bündig und standardmäßig
  geschlossen
- geöffnetes PDF-Accordion auch bei 150 Prozent ohne Seitenüberlauf

### Mobiles Leihportal `412 × 915`

Direktübersicht:

- Suche erscheint ab der längeren offenen Liste.
- Suche nach `QA-11` reduziert 11 Zeilen auf exakt den passenden Datensatz.
- Die breite Gerätetabelle scrollt nur innerhalb ihres eigenen Containers;
  die Seite selbst bleibt ohne horizontalen Überlauf.

Bestandsänderungen:

1. Browserausgabe mit Seriennummer `QA-BROWSER-12`:
   Direktübersicht wächst unmittelbar von 11 auf 12 Zeilen.
2. Leitungsbearbeitung der geplanten Rückgabe von 15. auf 16. September:
   Direktübersicht zeigt sofort den 16. September.
3. Manuelles Schließen:
   Datensatz verschwindet unmittelbar; 12 auf 11 Zeilen.
4. Wiederöffnen:
   Datensatz erscheint unmittelbar wieder; 11 auf 12 Zeilen.

Die Browserkonsole blieb während der gesamten Prüfung ohne Fehler oder
Warnungen.

Viewport-Override und QA-Tabs wurden danach zurückgesetzt beziehungsweise
geschlossen. Der temporäre Serverprozess, Port `31988`, die Testdatenbank,
alle Testbackups und der temporäre Starthelfer wurden vollständig entfernt.

## 10. Noch nicht freigegeben

Nach Abschluss von Block 8/8 ist fachlich nur noch ein gesondert zu
beauftragender Veröffentlichungsblock möglich. Ohne ausdrückliche Freigabe
darf insbesondere nicht:

- gestaged oder committet werden,
- gepusht werden,
- ein Pull Request oder GitHub-Release erstellt werden,
- eine Versions- oder Release-Datei geändert werden,
- ein Paket gebaut oder veröffentlicht werden,
- ein VPS oder eine produktive Installation verändert werden.

## 11. Startanweisung für eine mögliche nächste Fortsetzung

1. Dieses Dokument vollständig lesen.
2. Branch, HEAD und Arbeitsbaum zuerst ausschließlich read-only prüfen.
3. Alle vorhandenen, noch nicht committeten Änderungen aus Block 1 bis
   Block 8 erhalten.
4. Dem Nutzer bestätigen, dass Block 1/8 bis Block 8/8 lokal abgeschlossen
   und abgenommen sind.
5. Auf eine ausdrückliche Entscheidung warten, ob und in welchem Umfang ein
   eigener Commit-/GitHub-/Release-/VPS-Block begonnen werden soll.
6. Keine externe oder veröffentlichende Aktion aus der bloßen Fortsetzung
   dieses Handoffs ableiten.
