# Schulung und Wissen – Umsetzung der Blöcke 1 bis 4

Beauftragt am 15.09.2026. Arbeitsstand auf `feature/schedule-pdf-day-separators`,
Ausgangscommit `70beecc387d0bbdb05929af7f82d2cc18e892293`. Keine Veröffentlichung
oder Produktversionänderung beauftragt. Produktive Lernzuweisungen werden nicht
mit erfundenen Personen oder Qualifikationen angelegt.

## Block 1 – bestehender Kern

- Verwaltung in kompakte aufklappbare Bereiche aufgeteilt; zusätzliche Kataloge
  werden erst bei Bedarf geladen. Bestehende Suchziele öffnen die Bereiche.
- Veraltete Sitzungserneuerungs-Vorbedingungen in Sicherheitsprüfungen korrigiert.
  Die Prüfungen weisen nun ausdrücklich nach, dass die konkurrierende Änderung
  auch tatsächlich ausgeführt wurde. Keine Lockerung der Rechteprüfung.
- 101 vorhandene Prüfungen bestanden.
- Neuer nativer Test unter PostgreSQL 18.6: veröffentlichte Fähigkeit und Vorlage,
  Trainerbindung, Zuweisung, Fortschritt, Abschluss, Korrektur und unveränderliche
  Historie bestanden. Eigener Cluster mit privatem Unix-Socket und deaktiviertem
  TCP, ausschließlich synthetische Daten. Cluster danach gestoppt.

## Block 2 – Kassa-Pilot

- Vorbereitbare Kassa-Fähigkeit mit zehn fachlich zu prüfenden Stufen und
  Kassa-Einschulung mit sieben konkreten Lernschritten. Bestehende Fassungen
  werden beim Vorbereiten nicht überschrieben.
- Optionale versionsgebundene Zielkompetenz, Zielstufe und Trainer-Mindeststufe.
  Zuweisung prüft ausdrücklich Trainerfähigkeit, Fassung und Mindeststufe.
- Selbstlernen bleibt möglich; Praxisabschluss durch berechtigte Person.
  Kompetenzfreigabe nach bestandenem Kurs erfolgt separat und bewusst.
- API geprüft: unzureichende Trainerstufe abgewiesen; selbst erteilter Abschluss
  abgewiesen; bestandener Kurs erzeugt keine automatische Mitarbeiterkompetenz.
- Vorgeschlagene Zielstufe 4, Trainer mindestens Stufe 8. Vor Veröffentlichung
  fachlich prüfen. Benannte Beteiligte wurden angefragt und stehen noch aus.

## Block 3 – Wissensbibliothek

- Wissensartikel mit Kategorie, Suche, Schlagwörtern, lesbarem Text und
  unveränderlichen Fassungen. Entwurf, Veröffentlichung, Archiv und Wiederherstellung.
- Verwaltung und persönliches/Filialportal verwenden dieselbe Bibliothek mit
  serverseitig geprüftem Geltungsbereich. Leser erhalten nur veröffentlichte
  Fassungen, keine Entwürfe oder archivierten Inhalte.
- Drei vorbereitbare Arbeitsfassungen aus den bestätigten Kassenregeln:
  Gutscheine/Anzahlungen, Rohertrag/Rabatt/Rücknahme, Belegprüfung/Sonderfälle.
- 108 Prüfungen: 107 bestanden, ein optionaler nativer Test im lokalen Lauf
  ausgelassen; dieser wurde separat unter PostgreSQL ausgeführt (Block 1).
- Dateibasierte Nachweise und Prüfungszertifikate gehören zu Block 5.

## Block 4 – Schulungen organisieren

- Bis zu 50 Lernende gemeinsam zuweisen. Alle Personen, Bereiche und
  Trainerfreigaben werden innerhalb derselben Transaktion erneut geprüft.
  Eine ungültige Person verwirft die gesamte Mehrfachzuweisung.
- Fälligkeitsdatum, Erinnerungsabstand und Wiederholungsintervall: monatlich,
  vierteljährlich, halbjährlich, jährlich oder alle zwei Jahre.
- Interne Hinweise bei naher oder überschrittener Frist in Verwaltung und
  persönlichem/Filialportal. Keine E-Mail, Push-Nachricht oder Fremdübermittlung.
- Nach Abschluss einen eigenen Durchgang zuweisen; aktuelle Prozessfassung und
  Trainerfreigaben werden erneut geprüft. Fortschritt startet bei null; frühere
  Durchgänge und begründete Korrekturen bleiben unverändert erhalten.
- Der Wiederholungstermin bezieht sich auf die bisherige Fälligkeit, ersatzweise
  den Abschlusszeitpunkt. Monatsende und Schaltjahr werden berücksichtigt.
  Ein weiterer Durchgang wird bewusst zugewiesen, nicht automatisch angelegt.
- Friständerungen erhalten eigene unveränderliche Revisionsbelege und einen
  Audit-Eintrag. Gleichzeitige veraltete Änderungen werden abgewiesen.

## Verifikation und Betriebsgrenze

- Gemeinsamer Lauf: 144 Prüfungen, davon 130 bestanden und 14 explizite optionale
  Live-Prüfungen ausgelassen. Enthalten: sämtliche Learning-Tests,
  Funktionsnavigation und PostgreSQL-Verträge der Vollanwendung/Domain-Grenzen.
  Nach letzter Änderung erneut 19 API-/Fristprüfungen bestanden.
- Zusätzlich nativer PostgreSQL-18.6-Lauf auf einem eigenen, anschließend
  gestoppten Testcluster: additive Migration, zweimaliger Aufruf ohne erneute
  Änderung, echte Repository-Zugriffe mit App-Rolle, zwei unabhängige Durchgänge,
  Abschlusskorrektur, unveränderliche Historie und Transaktionsrücknahme bestanden.
  Keine produktiven Datenbankzugriffe in diesem Lauf.
- Browser mit lokaler synthetischer Installation: Übersicht am Desktop geladen;
  auf 390 × 844 Pixel Wissensentwurf gespeichert/gelesen, zwei Lernende gemeinsam
  zugewiesen, überfälligen Termin angezeigt, Abschluss und Wiederholung gespeichert.
  Alter Abschluss 100 %, neuer Durchgang 0 %. Kein horizontaler Überlauf der
  geöffneten Dialoge (Lesedialog 320/320 Pixel, Zuweisung 362/362 Pixel).
- Die zusätzliche Desktop-Sichtprüfung nach Größenwechsel wurde durch eine
  Zeitüberschreitung der Browsersteuerung beendet. Die Veröffentlichungslogik und
  Versionssichtbarkeit sind durch API-Tests geprüft, nicht als weiterer erfolgreicher
  Browserdurchlauf ausgewiesen. Temporäre Größenüberschreibung zurückgesetzt.
- Globaler historischer Persistenzaudit bleibt rot. Gegen eine aus HEAD `70beecc`
  exportierte Textkopie geprüft: identische fünf Fehlermeldungen und drei bereits
  unklassifizierte Sales-Importdateien (`cash-publication-batches`,
  `import-recheck-catalog`, `import-work-queues`). Die neuen Lernartefakte sind
  ausdrücklich klassifiziert; der bestehende globale Befund wurde nicht verdeckt.
- Syntaxprüfung und `git diff --check`. Lokale Prüfprotokolle unter
  `tmp/learning-final-tests.log`, `tmp/learning-final-api.log`,
  `tmp/learning-final-postgresql.log`, `tmp/learning-audit-baseline.log` und
  `tmp/learning-audit-current.log` (nicht Teil des Produktpakets).

Die Erweiterung ist **lokal vorbereitet, nicht veröffentlicht**. Für PostgreSQL
benötigt der nächste ausdrücklich beauftragte Deploy die additive Lernmigration;
siehe `SCHULUNG-WISSEN-MIGRATION.md`. Bestehende Tabellen und eingefrorene
PostgreSQL-Quellverträge werden nicht umgebaut. Der allgemeine Updater bleibt
unverändert. Keine produktive Mitarbeiterqualifikation oder Kurszuweisung angelegt.
Für den echten Kassa-Piloten fehlen weiterhin benannter Trainer und erste Lernende.


## Fortsetzung: Block 5 und Block 6 abgeschlossen (lokal)

Die folgenden Erweiterungen wurden nach dem ausdrücklichen Auftrag nacheinander
umgesetzt. Der Versionsstand bleibt 0.92.51-beta; keine Veröffentlichung erfolgt.

### Block 5 – Prüfungen und Nachweise

- Vorlageneditor: Wissenstest mit bis zu 30 Fragen, je 2–6 Antworten und einer
  richtigen Antwort, Gewichtung, exakter Bestehensgrenze und 1–10 Versuchen je
  Freigabe. Fragen können beim Anlegen einer neuen Fassung erweitert werden.
- Die persönliche Lernperson gibt Antworten ab. Lösungen werden nicht an normale
  Leser ausgeliefert. Nach ausgeschöpften Versuchen kann die zuständige Trainerperson
  oder Leitung begründet weitere Versuche freigeben; bisherige Versuche bleiben erhalten.
- Optionale oder für den Abschluss erforderliche PDF-/PNG-/JPEG-Nachweise:
  Dateiprüfung, verschlüsselte Speicherung in Core, autorisierter Download und
  begründete Rücknahme. Grenze 2 MiB pro Datei, zehn aktuelle Dateien je Durchgang.
- Ein erfolgreicher Abschluss prüft serverseitig Test und erforderliche Nachweise.
  Die vorhandene fachliche Abschlussbewertung und begründete Korrektur bleiben erhalten.
- PDF-Bestätigung mit Lernperson, Fassung, Durchgang, Lernschritten, Bewertung und
  Abschlussbeleg. Eine negative spätere Abschlusskorrektur sperrt neue Downloads.
  Kein automatisches Erteilen von Kompetenzstufen oder Trainerrechten.
- Oberfläche unter Schulungen → „Prüfungen & Nachweise“, im persönlichen Portal
  ebenso. Gemeinsame Filialkonten erhalten keinen Zugriff auf persönliche Prüfungen
  und geschützte Dateinachweise.

### Block 6 – Teamübersicht und Ausbau

- Neuer aufklappbarer Bereich „Team · Soll und Ist“ mit nachprüfbaren Anforderungen
  für Soll-Kompetenzen und Pflichtschulungen. Filter nach Filiale, Position, Rolle,
  Name/Personalnummer sowie Kompetenz-/Schulungsansicht.
- Anforderungen binden eine veröffentlichte Fassung, optional Position und Rolle
  gemeinsam, Zielstufe und Gültigkeit in Monaten (0 = ohne Ablauf). Archivierung
  erhält die Historie. Änderungen sind durch aktuelle Leitungs-/Katalogrechte und
  optimistische Revisionsprüfung geschützt; Audit und Änderung sind atomar.
- Matrix zeigt fehlende, unzureichende, anders versionierte, erfüllte, bald fällige,
  abgelaufene und nachzuschulende Anforderungen. Ein noch gültiger früherer Abschluss
  bleibt während eines neu gestarteten Wiederholungsdurchgangs gültig. Eine negative
  Abschlusskorrektur wird entsprechend berücksichtigt.
- Seitenweise Anzeige (10/25/50 Personen), Gesamtzahl des Filters, Quote **dieser
  Seite** und CSV-Export **dieser Seite**. Kein stillschweigender Gesamtexport.
- Personenfilter und Begrenzung bereits in SQL; Lernhistorien nur für die ausgewählten
  Personen. Module, Fassungen und Ereignisse werden gebündelt geladen – auch in
  Vorlagen, Wissensbibliothek, Kompetenzprofilen und bestehenden Schulungsprojektionen.
- Mobile Dialoge umbrechen Inhalte; Matrix ist separat horizontal scrollbar.
  Vollständige Namen der gewählten Schulungsfassung stehen zusätzlich unter der
  Auswahlliste. Unzulässige Geltungsbereiche werden schon in der Auswahl gefiltert.

### Nachweise dieser Fortsetzung

- Letzter fokussierter Lauf nach finaler Serveränderung: **138 Tests, 133 bestanden,
  5 optionale native/Live-Tests ausgelassen, keine Fehler**. Log:
  `tmp/learning-block56-focused-tests.log`.
- Erweiterter Lauf mit allen Funktionssuchtests: 182 Tests, 176 bestanden,
  5 ausgelassen, ein unveränderter Altfehler. `function-search-release-readiness`
  erwartet fest 0.92.49-beta, während bereits HEAD 0.92.51-beta enthält. Derselbe
  Fehler wurde im aus HEAD exportierten Ausgangsstand reproduziert. Logs:
  `tmp/learning-block56-final-tests.log`, `tmp/learning-release-readiness-baseline.log`.
- Nativer PostgreSQL-18.6-Test im eigenen Cluster bestanden: echte App-Rolle,
  additive Migration und Wiederholung, unveränderliche Historien, verschlüsselte
  Feldspeicherung als Bytevertrag, Transaktionsrücknahme und Teamabfragen.
  Echte Verschlüsselung/Entschlüsselung und Dateiprüfung zusätzlich im API-Test.
  Cluster danach gestoppt; keine produktiven Datenbankänderungen.
- 510 synthetische Personen im API-Test: Filtergesamtzahl 500, genau zehn Personen
  auf der letzten gewählten Seite, entsprechend begrenzter CSV-Export. Fremde Rollen
  und Filialbereiche, veraltete Schreibversuche sowie bewusst fehlschlagender Audit
  sind geprüft. Negative Abschlusskorrektur entfernt die Erfüllung der Pflichtschulung.
- Browser: Team-Anforderung am Desktop gespeichert; Bearbeitungsdialog mobil bei
  390 × 844 Pixel mit 320 Pixel Inhalts- und Scrollbreite (kein seitlicher Überlauf).
  Wissenstest im persönlichen Portal abgegeben, als bestanden angezeigt und nach
  Neuladen erhalten. Zu breite mobile Radiobuttons korrigiert und visuell erneut
  geprüft; Antworttexte vollständig sichtbar. Vorlagenfassung mit dritter Antwort
  im Editor als neue unveröffentlichte Version gespeichert (Version 2, veröffentlicht 1).
- PDF-Bestätigung über die echte API erstellt, mit Poppler gerendert und visuell
  geprüft: lesbar, kein überlagerter Text. Synthetischer Beleg unter
  `tmp/pdfs/learning-confirmation-qa.pdf`, kein produktiver Schulungsnachweis.
- Globaler Persistenzaudit: weiterhin dieselben fünf historischen Befunde und drei
  unklassifizierten Sales-Importdateien, kein zusätzlicher Befund aus Block 5/6.
  Log: `tmp/learning-audit-block56.log`. Keine globale Freigabe behauptet.

### Bewusst anschließender Ausbau

Für eine spätere Onboarding-Verknüpfung zuerst einen eindeutigen Bezug zwischen
Lifecycle-Schritt und Lernzuweisung definieren, Wiederholungen/Korrekturen übertragen
und doppelte Abschlusswahrheiten vermeiden. Eine externe LMS-Anbindung benötigt
separat vereinbarte Quelle, Identitätszuordnung, zulässige Daten, Versions- und
Widerrufsregeln. In diesem Auftrag ist keine solche Integration aktiviert.

Der ausdrücklich beauftragte Deploy einschließlich additiver Migration der sechs
Core-Tabellen ist am 15.09.2026 abgeschlossen. Die Korrektur des dabei gefundenen
Restore-Problems und der erfolgreiche vollständige Sicherungsnachweis sind unter
[v0.92.53](DEPLOY-RELEASE-v09253.md) dokumentiert. Bekannte allgemeine Audit-Altbefunde
bleiben getrennt ausgewiesen. Für den fachlichen Kassa-Piloten bleiben benannte
Trainer und erste Lernende offen.

Abschließend: 40 geänderte/neue JavaScript-Dateien syntaktisch geprüft,
`git diff --check` ohne Befund. Drei Team-Fachtests nach letzter Normalisierung
nochmals bestanden. Temporärer Browser geschlossen, Viewport zurückgesetzt,
lokaler synthetischer Testserver beendet. PostgreSQL-Protokoll lokal unter
`tmp/learning-block56-postgresql.log`.
