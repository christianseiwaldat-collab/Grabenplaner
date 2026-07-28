# Grabenplaner – Übergabe für Fortsetzung #3

Stand: 28. Juli 2026
Nächster fachlicher Arbeitsblock: **Block 3/8 – Rechte ab PL+**

## 1. Zweck dieser Übergabe

Dieses Dokument verdichtet den bisherigen sehr langen Grabenplaner-Chat. Der neue Chat soll den vorhandenen lokalen Arbeitsstand übernehmen, nichts neu beginnen und zunächst keine weiteren Änderungen vornehmen, bis der Nutzer den nächsten Block ausdrücklich startet.

## 2. Verbindlicher Arbeitsstand

- Lokales Repo: `C:\Users\chris\Documents\Lamprechter\Grabenplaner-mitterweg-pilot-v0863`
- Aktueller Branch: `feature/v0864-cost-center-types`
- Basis-HEAD: `022a6b8`
- Die Änderungen aus **Block 1/8 und Block 2/8 sind noch nicht committet**.
- Der Arbeitsbaum ist absichtlich nicht sauber. Vorhandene Änderungen dürfen nicht verworfen, zurückgesetzt oder durch einen neuen Checkout überschrieben werden.
- GitHub und VPS wurden für Block 1/8 und Block 2/8 nicht aktualisiert.
- Die acht Blöcke sollen zunächst lokal fertiggestellt werden; eine VPS-Aktualisierung erfolgt erst nach Abschluss und Gesamtabnahme.
- Vor jeder späteren Serveränderung muss der aktuelle Live-Stand erneut geprüft werden.

## 3. Produktiv- und Pilotstand

- Der zuletzt bestätigte Produktivstand ist Grabenplaner `v0.86.3-beta`.
- Produktion und synthetische Testumgebung sind serverseitig getrennt.
- Der frühere eigenständige F18-Leihdienst wurde außer Betrieb genommen und darf nicht versehentlich wieder aktiviert werden.
- Bestehende Sicherungsarchitektur:
  - interne Serversicherung,
  - externes/offsite Sicherungsziel über Google Drive,
  - geschützter vollständiger Datenbankdownload für berechtigte Admin-Konten,
  - Änderungen an Sicherungsziel oder Datenbankdownload nur nach erneuter Passworteingabe.
- Vorhandene System-Center- und Betriebsüberwachungsfunktionen samt geschützten Reparaturaktionen für Admin, IT-Admin und Developer müssen erhalten bleiben.

Diese Angaben sind Übergabewissen. Vor produktiven Maßnahmen müssen sie live verifiziert werden.

## 4. Wichtige Nutzer- und Arbeitspräferenzen

- Kommunikation auf Deutsch, klar, kompakt und freundlich.
- Der Nutzer ist häufig 30 Minuten oder länger nicht am Rechner.
- Für normale lokale Implementierung, Tests und reversible Repo-Arbeit nicht laufend nach Bestätigungen fragen.
- Nur bei echten fachlichen Entscheidungen, externen Veröffentlichungen oder riskanten/destruktiven Aktionen stoppen.
- Zukunftsnotizen sind keine sofortige Umsetzungsfreigabe.
- GitHub, VPS und produktive Daten nur ändern, wenn der Nutzer den betreffenden Schritt ausdrücklich startet.
- Produktartefakte und Dokumentationen bleiben sachlich und professionell.
- Grabenplaner wird ausschließlich im Serverbetrieb weitergeführt.

## 5. Block 1/8 – abgeschlossen: neues Kostenstellenmodell

Umgesetzt wurde ein datenbankgestütztes, frei konfigurierbares Kostenstellentyp-Modell.

### Fachlich

- Kostenstellentypen sind keine fest im Client codierte Auswahlliste mehr.
- Eingebaute Ausgangstypen:
  - Filiale,
  - Verwaltung/Zentrale,
  - Produktion/Printcenter,
  - Sonstige.
- Eigene Typen können ergänzt werden.
- Ein Typ enthält unter anderem:
  - technischen Code,
  - Anzeigenamen,
  - Beschreibung,
  - Filialkennzeichen,
  - Aktivstatus,
  - erlaubte Positionen.
- Positionen werden Typen zugeordnet.
- Nur Filialtypen dürfen neu mit einem Standort verknüpft werden.
- Archivierung bleibt historienverträglich; belegte Typen und Zuordnungen werden geschützt.
- Relevante Änderungen werden auditiert.

### Technisch

- Datenbankmigrationen und Rückwärtskompatibilität wurden ergänzt.
- Serverseitige Validierung verhindert unzulässige Typ-, Standort- und Positionsänderungen.
- Typverwaltung und Positionszuordnung wurden in die Personal-/Kostenstellenverwaltung integriert.
- Bestandsdaten werden konservativ migriert.
- Profil-/Teildatenbankexporte übernehmen alle eingebauten und tatsächlich referenzierten Typen samt Positionsmappings.

### Dokumentation

- `docs/KOSTENSTELLEN-TYPMODELL-v0.1.md`

## 6. Block 2/8 – abgeschlossen: Mitarbeiteranlage und Personalakt

Die Kostenstelle ist jetzt die führende organisatorische Mitarbeiterzuordnung.

### Fachlich

- In der Mitarbeiteranlage wird zuerst die Kostenstelle gewählt.
- Das Positionsfeld zeigt nur Positionen, die für den Kostenstellentyp freigegeben sind.
- Das bisherige Feld „Stammfiliale“ wurde entfernt.
- Bei einer Filialkostenstelle wird der Standort intern automatisch aus der Kostenstelle abgeleitet.
- Verwaltung, Produktion und andere Nicht-Filialtypen benötigen keinen Standort.
- Zusätzliche Einsatzstandorte für die Dienstplanung bleiben möglich.
- Widersprüchliche alte Standort-/Kostenstellenkombinationen werden serverseitig verhindert.

### Oberfläche

- Mitarbeiteranlage ist in standardmäßig geschlossene Akkordeons gegliedert.
- Personalakt ist ebenfalls standardmäßig eingeklappt.
- Der aktuell bearbeitete Abschnitt bleibt geöffnet.
- Schmale Verwaltungsansicht wurde im echten lokalen Browser ohne horizontalen Überlauf geprüft.

### Import und Migration

- Alte Personalimporte mit Standortfeldern bleiben intern kompatibel.
- Neue sichtbare Importzuordnung arbeitet kostenstellenbasiert.
- Bestehende Importprofile werden nicht stillschweigend zerstört.

### Dokumentation

- `docs/MITARBEITER-KOSTENSTELLENZUORDNUNG-v0.1.md`

## 7. Abnahme nach Block 2/8

- 156 Testdateien ausgeführt.
- `1.067` Tests gesamt.
- `1.043` bestanden.
- `24` übersprungen.
- `0` fehlgeschlagen.
- `server.js` und `public/app.js` bestehen die Syntaxprüfung.
- `git diff --check` ist sauber.
- Lokale Browserprüfung erfolgreich:
  - alle neuen Bereiche anfangs eingeklappt,
  - kein Stammfilialfeld,
  - Standortableitung aus Filialkostenstelle,
  - Nicht-Filialkostenstelle ohne Standort,
  - Positionsauswahl aus Typmapping,
  - geöffneter Personalaktabschnitt bleibt erhalten.
- Die temporäre QA-Instanz wurde beendet und entfernt.

Nicht als Fehler werten:

- `test/v075-linux-hardening-package.test.js` wurde aus der Gesamtsuite ausgespart, weil dieser Paket-Guard absichtlich einen bereits committeten, sauberen Git-Arbeitsbaum verlangt. Er ist erst nach einem späteren bewussten Commit sinnvoll ausführbar.

## 8. Verbindliche Roadmap 3/8 bis 8/8

### Block 3/8 – Fachliche Rechte ab PL+

Ab der Rollenstufe PL+ müssen zusätzliche fachliche Einzelrechte zuweisbar sein für:

- Arbeitszeitregeln,
- Personalakt,
- AUM.

Damit soll insbesondere Benutzer `275` die benötigten Rechte erhalten können.

Wichtige Grenze:

- fachliche Einzelrechte für PL+ öffnen,
- technische System-, Rollenverwaltungs- und sicherheitskritische Rechte weiterhin schützen,
- nicht ungefragt daraus ableiten, dass jede PL+-Person diese Rechte auch selbst an andere vergeben darf.

Vor Umsetzung zuerst bestehende serverseitige Berechtigungslogik, Rechtekatalog, UI-Filter und Tests vollständig inventarisieren.

### Block 4/8 – Leihübersicht und allgemeine Nicht-Mitarbeiterkonten

Für normale Mitarbeitende:

- zuerst eine direkt sichtbare Übersicht/Tabelle der offenen Leihen,
- dadurch sofort erkennbar, ob ein gesuchtes Gerät ausgeliehen ist,
- erst bei längerer Liste ein kleines Suchfeld oberhalb der Tabelle,
- Suche unter anderem nach Gerät, Modell, Inventarnummer oder Seriennummer,
- nur die für den Überblick nötigen Angaben anzeigen,
- keine Fotos, Dokumente, Unterschriften, internen Notizen oder Bearbeitungsrechte.

Kontomodell:

- Ab PL+ soll es möglich sein, Konten anzulegen, die keine Mitarbeitenden sind.
- `fil18` ist ein Beispiel für ein Filial-/Terminalkonto, nicht ein einmaliger Sonderfall.
- Solche Konten können ein passend reduziertes Dashboard erhalten, etwa:
  - Leihübersicht,
  - Dienstplanansicht,
  - weitere ausdrücklich freigegebene Filialfunktionen.
- Sie haben keinen Mitarbeiterdatensatz, keine Personalnummer und keine:
  - Zeiterfassung,
  - Urlaubsverwaltung als Mitarbeiter,
  - AUM,
  - Personalakte.
- Sie müssen auf ihre Organisationseinheit beziehungsweise Filiale begrenzbar sein.

Bestehende Nachvollziehbarkeitsgrenze bewahren:

- Neue Leihen werden nur durch den persönlich angemeldeten Mitarbeiter für sich selbst erstellt.
- Ein Filial-/Terminalkonto darf keine persönliche Ausgabe oder Rückgabebestätigung ersetzen.

### Block 5/8 – Leihfotos als PDF-Beilage

Konfigurierbare Verarbeitung nach dem vorhandenen AUM-Prinzip:

- Fotos verkleinern,
- als Graustufen beziehungsweise Schwarzweiß ausgeben,
- mehrere Bilder in einer kompakten PDF-Beilage zusammenfassen,
- Ausgabe- und Rückgabefotos getrennt behandeln,
- geschützte Vorschau und geschützter Download.

Originalfotos:

- Aufbewahrung oder Löschung muss einstellbar sein.
- In der Oberfläche klar darauf hinweisen, dass die Aufbewahrung der Farboriginale besonders bei Schäden sinnvoll ist.
- Sichere Voreinstellung: Farboriginale geschützt behalten.

### Block 6/8 – Zustand der Arbeitszeit-Regelprüfung

- Eingeklappt bleibt eingeklappt.
- Das gilt auch nach Anlegen, Speichern oder Bearbeiten eines Dienstes.
- Datenneuladen darf den Bereich nicht eigenmächtig öffnen.
- Status- und Warnungsanzahl bleiben im geschlossenen Kopf sichtbar.
- Auch blockierende Meldungen dürfen auffällig sein, öffnen den Bereich aber nicht automatisch.
- Zustand benutzerbezogen speichern.

### Block 7/8 – Grundeinstellungen neu strukturieren

- Betriebsmodus vollständig aus Oberfläche, Einstellungen, überflüssigen Berechtigungen und totem Servercode entfernen.
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
- Bei Karten/Feldern bleibt die gemeinsame Breite erhalten.
- Nur die vertikale Länge/Höhe soll sich sinnvoll am Inhalt orientieren; keine unnötig gleich hohen Karten.
- Layout bei unterschiedlichen Schriftgrößen sowie auf Desktop und mobil prüfen.

### Block 8/8 – Migration und Gesamtabnahme

- Verlustfreie Migration bestehender Kostenstellen und Mitarbeitender.
- Doppelte beziehungsweise widersprüchliche alte Stammfilialzuordnungen bereinigen.
- Rechteprüfung für PL+, besonders Benutzer `275`.
- Sicherstellen, dass `fil18` und andere Nicht-Mitarbeiterkonten nirgends als Mitarbeiter erscheinen.
- Desktop- und Mobiltests.
- Schriftgrößen- und Layouttests.
- Leihübersicht, Suche, Foto-PDFs und Zugriffsgrenzen.
- Bestehende Ausgabe-, Rückgabe- und Filialleitungsfunktionen.
- Datenbank-, Rollen-, Audit- und Sicherheitsprüfung.
- Erst danach bewusster Commit-/GitHub-/Release-/VPS-Block.

## 9. Bestehende fachliche Grenzen, die nicht regressieren dürfen

### Leihe

- Neue Ausleihe nur für den aktuell angemeldeten Mitarbeiter.
- Bei Rückgabe darf ein zweiter Mitarbeiter aus derselben Filiale bestätigen.
- Filialleitung kann Leihen bearbeiten, ohne Beleg schließen, später wieder öffnen und bearbeiten.
- Offene Leihen müssen auch für normale Mitarbeitende schnell erkennbar werden, ohne vertrauliche Belege preiszugeben.

### Mitterweg-Pilot

- Benutzer `275` ist Marie-Theres Schmidt.
- Sie arbeitet in der echten Pilotdatenbank nur mit ihrem Standort.
- Sie plant Dienstzeiten für die Filiale und kann bereits genehmigte Urlaube sowie U/ZA für die Planung eintragen.
- Sie erfasst oder bearbeitet keine Urlaubsanträge.
- Die übrigen Mitarbeitenden verwenden den Grabenplaner während des Piloten noch nicht selbst.
- Mobile Nutzung durch 275 ist ausdrücklich vorgesehen.
- Konto `9999` ist für den IT-Test vorgesehen und muss von echten Produktionsdaten getrennt bleiben.

### Arbeitszeitregeln

- Rechtliche Regelprüfung bleibt als qualifizierte Planungsunterstützung formuliert, nicht als pauschale Rechtsfreigabe.
- Volljährigkeit wird aus einem verlässlichen Geburtsdatum abgeleitet.
- Bei ungeklärtem Alter darf dezent erinnert werden; Erinnerung soll zeitweise zurückgestellt werden können.
- Für Minderjährige sind konkrete arbeitszeitliche Konflikte im Dienstplan sichtbar zu machen.
- Saisonale oder kollektivvertragliche Ausnahmen müssen versioniert und nachvollziehbar modelliert werden.

### Sicherungen und System-Center

- Offsite-Sicherung über Google Drive bleibt das externe Sicherungsziel.
- Google-Drive-Zielordner muss geschützt auswählbar, neu anlegbar und änderbar sein.
- Datenbankdownload und Pfadänderungen verlangen erneute Passworteingabe.
- Systemaktionen benötigen klare Warn-/Bestätigungsdialoge.

## 10. Größere spätere Roadmap außerhalb der acht Blöcke

Nicht im nächsten Block ungefragt beginnen:

- Personalverwaltung: eigener großer Bereich für Onboarding und Offboarding.
- Vor Implementierung zuerst ein fachliches und organisatorisches Konzept erstellen und mit dem Nutzer abstimmen.
- Prozesswege später klar nach Bereichen strukturieren, zum Beispiel:
  - Personalprozesse,
  - Reparaturen,
  - Second-Hand-Annahme,
  - weitere betriebliche Abläufe.
- Betriebliche Erfahrung darf dabei berücksichtigt werden; formale Berufs- oder Hochschulausbildung ist keine Voraussetzung, um Prozesswissen beizutragen.

## 11. Startanweisung für den neuen Chat

1. Dieses Dokument vollständig lesen.
2. Im Repo zuerst ausschließlich read-only prüfen:
   - `git status --short`
   - aktueller Branch und HEAD
   - vorhandene neuen Dokumente und Tests
3. Keine vorhandene Änderung zurücksetzen oder neu implementieren.
4. Keine GitHub- oder VPS-Aktion ausführen.
5. Noch keinen neuen Block umsetzen.
6. Dem Nutzer kurz bestätigen:
   - Übergabe übernommen,
   - Block 1/8 und 2/8 lokal vorhanden und geprüft,
   - als Nächstes ist Block 3/8 vorgesehen.
7. Erst nach dem ausdrücklichen „Bitte starte Block 3/8“ mit der Implementierung beginnen.
