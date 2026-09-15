# Schulung & Wissen – Bestandsaufnahme vom 15.09.2026

Das eigenständige Lernmodul ist bereits implementiert und auf dem VPS installiert.
Die Grundlage für Katalog, Durchführung und Kompetenzprofile ist vorhanden.
Der nächste Schwerpunkt ist die fachliche Einrichtung und ein gut bedienbarer
Arbeitsablauf; ein vollständiger Neuaufbau ist nicht erforderlich.

## Prüfgrundlage

- Produktivversion: **v0.92.51-beta**, Laufzeit-Commit `b49158fbbc8a8b570bfe6026d1832fbf3dcf9556`.
- Lokaler Quellstand: `70beecc387d0bbdb05929af7f82d2cc18e892293`; gegenüber dem Laufzeit-Commit kamen ausschließlich Import-Dokumentationen hinzu.
- Elf relevante Server-, Oberflächen- und Lernmoduldateien stimmen bytegenau mit dem installierten Stand überein.
- Ausschließlich lesende Bestandsabfrage in der produktiven PostgreSQL-Core-Datenbank: neun Lernmodultabellen vorhanden.
- Bestehende lokale Fach-, API-, Rechte-, Persistenz- und Oberflächentests ausgeführt; Testdaten lagen in isolierten temporären SQLite-Datenbanken.
- Kein neuer vollständiger Browserdurchlauf und kein schreibender PostgreSQL-Fachtest in dieser Bestandsaufnahme. Keine Änderung oder Testdatenerzeugung am VPS, kein Deployment.

## 1. Tatsächlich vorhandene Inhalte

| Eintrag | Typ | Stand | Umfang / Geltungsbereich |
|---|---|---|---|
| Kassensystem Einschulung | Schulungsprozess | Veröffentlicht | Zwei Schritte; Trainerbestätigung; Unternehmen |
| Drohnen: | Fähigkeit | Veröffentlicht | Zehn definierte Stufen; Unternehmen |
| Studiofotografie, Blitztechniken, Godox-System | Fähigkeit | Veröffentlicht | Zehn definierte Stufen; Abteilung |

Es gibt **keine gespeicherten Mitarbeiterkompetenzen, Trainerfreigaben,
Schulungszuweisungen oder Fortschrittsrevisionen**. Die entsprechenden Tabellen
sind leer. Damit fehlen aktuell insbesondere freigegebene Trainer für den
ersten produktiven Schulungsablauf.

Die zwei Fähigkeiten werden intern als speziell typisierte Wissenseinträge
gespeichert. Sie sind keine zwei zusätzlichen Wissensprozesse. Ein eigenständiger
Wissensprozess ist derzeit nicht angelegt.

## 2. Bereits umgesetzt

| Bereich | Vorhandene Funktion |
|---|---|
| Prozesskatalog | Schulungs- und Wissensprozesse mit Titel, Lernziel, Dauer, Schlagwörtern, Geltungsbereich und 1–40 geordneten Schritten. Schritte können verpflichtend sein und Abschlusskriterien enthalten. |
| Versionierung | Entwurf, Veröffentlichung, neue Version, Archivierung und Wiederherstellung. Veröffentlichtes wird nicht überschrieben; bestehende Zuweisungen bleiben an ihre Version gebunden. |
| Fähigkeiten | Eigener Katalog mit Kategorien und genau zehn beschriebenen Stufen je Fähigkeit. |
| Mitarbeiterkompetenzen | Mehrere Fähigkeiten pro Person, konkrete Stufe, gesonderte Trainerfreigabe sowie nachvollziehbare Änderung, Entziehung und Wiederherstellung. |
| Zuweisungen | Lernende Person, veröffentlichter Prozess und eine oder mehrere Trainerfähigkeiten; filialübergreifend mit entsprechendem Recht. Trainerwechsel, Abbruch und Wiederherstellung sind vorgesehen. |
| Durchführung | Schritte abhaken, Fortschritt berechnen, alle Pflichtschritte vor Abschluss verlangen; Ergebnis „Ziele erfüllt“, „Nachschulung erforderlich“ oder „Nicht bestanden“. Spätere Korrekturen benötigen eine Begründung. |
| Übersichten | Dashboard mit laufenden, begonnenen, abgeschlossenen und klärungsbedürftigen Schulungen. Fähigkeitsdarstellung nach Kategorien mit Stufen 1–10. |
| Mitarbeiterportal | Persönliche Schulungsansicht und Fortschrittserfassung. Abschluss entsprechend der gewählten Prüfart und Zuständigkeit. |
| Filialkonto | Freigegebene Filialübersicht und standortbezogenes Abhaken. Kein Abschluss und keine nachträgliche Abschlusskorrektur über das gemeinsame Filialkonto. |
| Rechte | Getrennte Rechte für Lesen, Bearbeiten, Veröffentlichen, Zuweisen, filialübergreifendes Arbeiten, Historieneinsicht und Delegation. Developer behält den garantierten Vollzugriff. |

Diese Funktionen sind im installierten Code vorhanden. Das ist von einem bereits
fachlich eingerichteten und im laufenden Betrieb erprobten Schulungssystem zu
unterscheiden: Die tatsächlichen Durchführungsdaten sind noch leer.

## 3. Lücken und Ausbaugrenzen

### Fachliche Einrichtung und erster Einsatz

Die Kassen-Einschulung ist mit zwei Schritten ein kleiner Ausgangspunkt. Für den
ersten vollständigen Ablauf fehlen ein fachlich passendes Fähigkeitsprofil,
benannte Trainer mit Freigabe und die Zuordnung eines Lernenden. Eine eigene
Kassa-Fähigkeit ist unter den zwei vorhandenen Fähigkeiten noch nicht enthalten.

Prozess, erforderliche Trainerqualifikation und die vom Lernenden zu erreichende
Fähigkeit sind noch nicht als verbindliche fachliche Kette modelliert. Derzeit
wählt die Leitung die Trainerfähigkeiten aus. Ein bestandener Kurs erzeugt nicht
automatisch eine neue Kompetenzstufe beim Lernenden; der Kompetenzstand wird
gesondert gepflegt. Dafür sollte ein ausdrücklicher, nachvollziehbarer
Freigabeschritt vorgesehen werden.

### Wissen und Lernunterlagen

„Wissen“ verwendet bisher dasselbe Schrittmodell wie ein Schulungsprozess.
Es gibt noch keine eigenständige Wissensbibliothek mit frei lesbaren Artikeln,
Inhaltskategorien, verknüpften Dokumenten, Bildern oder Videos. Der vorhandene
Texteditor verarbeitet einfache Texte; eine Medien- oder Dateiverwaltung ist
in diesem Lernmodul nicht eingebunden.

Lernunterlagen und personenbezogene Abschlussnachweise sollten getrennte Zwecke
und Sichtbarkeiten erhalten. Vorhandene GP-Dokumentfunktionen sind mögliche
Bausteine; deren Verwendung wäre erst fachlich und technisch anzuschließen.

### Termine, Wiederholung und Selbstlernen

- Zuweisungen haben noch keine Frist, Terminplanung, Wiederholungsperiode oder Gültigkeitsdauer. Die geplante Dauer im Prozess ist keine Kalenderbuchung.
- Die Oberfläche weist jeweils eine Person zu; Sammelzuweisung nach Filiale, Rolle oder mehreren Mitarbeitern fehlt.
- Derselbe Prozess kann derselben Person nicht als zusätzlicher unabhängiger Durchlauf zugewiesen werden. Wiederherstellung und Korrektur ersetzen keine jährliche Wiederholungsschulung.
- Selbstbestätigung ist vorhanden. Dennoch verlangt die Zuweisung derzeit mindestens eine Trainerfähigkeit. Ein vollständig selbstständiger Lernweg benötigt eine passende eigene Regel.
- Schulungsspezifische Erinnerungen und Eskalationen sind noch nicht an diese Zuweisungen angebunden.

### Prüfung, Nachweise und Auswertung

- „Wissenskontrolle“ und „Praxisprüfung“ sind auswählbare Prüfarten. Ein Fragenkatalog, ein Quiz mit Antworten/Punkten oder eine automatische Prüfungsauswertung ist damit noch nicht umgesetzt.
- Dateinachweise, Teilnahmebestätigungen und Schulungszertifikate als PDF fehlen im Lernmodul.
- Der „Fähigkeitsbaum“ ist derzeit eine gruppierte Darstellung vorhandener Kompetenzstände. Lernvoraussetzungen, Abhängigkeiten und nächste freizuschaltende Stufen sind nicht als Lernpfad hinterlegt.
- Eine Soll-/Ist-Matrix nach Rolle oder Filiale, Pflichtschulungsquoten und Berichte zu bald ablaufenden Qualifikationen fehlen.
- Die getrennte O6-Schnittstellenvorarbeit für Onboarding und externe Systeme ist keine aktive Anbindung dieses Lernmoduls. Die ältere O6-Beschreibung darf weder als fertige Integration noch als Beleg für ein insgesamt fehlendes Lernmodul gelesen werden.

### Bedienung und Wachstum

Auf derselben Verwaltungsseite stehen Dashboard, Prozesskatalog, Fähigkeiten,
Kompetenzprofile und Zuweisungen untereinander. Technische Texte wie „Block 3“,
„Block 5 + 6“, „keine zweite Wahrheit“ und interne Versionsgrenzen gehören überarbeitet.
Empfohlen sind kompakte Teilansichten mit gut sichtbaren Hauptaktionen und
vollständig lesbaren Feldinhalten.

Beim Öffnen werden bis zu fünf Fachansichten parallel geladen. Die serverseitige
Dashboard-Vorbereitung liest derzeit sämtliche zugehörigen Mitarbeiter,
Zuweisungen und Revisionshistorien und filtert danach. Je Katalogmodul folgen
weitere Einzelabfragen. Für einen größeren Bestand sollten Filterung,
Seitennavigation und gebündelte Datenabfragen früh ergänzt werden. Ein aktuelles
Laufzeitproblem dieses Bereichs wurde damit noch nicht gemessen.

## 4. Testergebnis und technische Restarbeit

Der unveränderte Bestand umfasst **101 ausgeführte Tests: 95 bestanden,
6 fehlgeschlagen**. Alle sechs Fehlmeldungen betreffen Tests, die eine Änderung
der Sitzungsablaufzeit als Auslöser für einen simulierten Rechte- oder
Kontowechsel verwenden.

Seit der Sitzungsoptimierung wird eine noch ausreichend lange gültige Sitzung
nicht bei jeder Anfrage verlängert. Deshalb lösen die alten Test-Trigger bei
diesen Vorbedingungen gar nicht mehr aus. In isolierten Kopien der zwei
betroffenen Testdateien wurde ausschließlich die Testvorbedingung geändert:
Die synthetische Sitzung wird vor Einbau des unveränderten Triggers zur
Verlängerung fällig. Mit unverändertem Anwendungscode bestehen dann **alle
39 Tests dieser beiden Dateien**, einschließlich der bisher fehlgeschlagenen
Fälle. Das grenzt diese Fehlmeldungen auf veraltete Testvorbedingungen ein.

Offen bleibt, die regulären Tests dauerhaft so anzupassen, dass der simulierte
Zwischenfall nachweislich eintritt. Der eingecheckte Testbestand ist weiterhin
nicht vollständig grün. Die korrigierten Kopien sind reine Diagnoseartefakte.

Vor einem fachlichen Pilotstart empfehle ich zusätzlich einen vollständigen
Durchlauf auf einer isolierten PostgreSQL-Testdatenbank: Prozess veröffentlichen,
Trainerkompetenz freigeben, zuweisen, mobil abhaken, abschließen, korrigieren und
nach Neustart erneut lesen. Die aktuellen Tests decken überwiegend SQLite und
die gemeinsamen Fachfunktionen ab; die reine VPS-Bestandsabfrage ersetzt diesen
nativen Schreibtest nicht.

## 5. Empfohlene Reihenfolge

Die folgende Einteilung ist ein Ausbauvorschlag, noch keine gestartete Umsetzung.

| Block | Ziel und überprüfbares Ergebnis |
|---|---|
| 1 – Bestehenden Kern abrunden | Testvorbedingungen aktualisieren, vollständigen PostgreSQL-Testablauf ergänzen, Verwaltungsansicht verständlicher und kompakter machen. |
| 2 – Fachlicher Pilot Kassa | Kassa-Fähigkeit, passende Trainerqualifikation und Zielkompetenz definieren; vorhandene Einschulung ausarbeiten und einen vollständigen Ablauf mit benannten Beteiligten vorbereiten. Selbstlernen und bewertete Stufenfreigabe klar regeln. |
| 3 – Wissensbibliothek | Eigene lesbare Wissenseinträge mit Kategorien, Suche und versionierten Lernunterlagen; erste echte Inhalte bereitstellen. |
| 4 – Schulungen organisieren | Mehrfachzuweisung, Fristen, getrennte Wiederholungsdurchläufe und interne Erinnerungen. |
| 5 – Prüfungen und Nachweise | Strukturierte Prüfungen, geschützte Nachweise und PDF-Bestätigungen an den bestehenden Abschluss anbinden. |
| 6 – Teamübersicht und Ausbau | Soll-/Ist-Kompetenzmatrix, Pflichtschulungsübersichten, Auswertungen und Datenabfragen für größere Bestände. Eine zusätzliche Onboarding- oder externe LMS-Anbindung anschließend gesondert planen. |

Für einen ersten brauchbaren Einsatz sind zunächst **Block 1 und 2** maßgeblich.
Die weiteren Blöcke erweitern das Modul. Benannte Trainer und Lernende, die
fachlichen Kassa-Stufen und die gewünschten ersten Wissensinhalte können wir
bei der Einrichtung in Block 2 festlegen.

## Quellen und Nachweise

- Oberfläche: `public/index.html:907`, `public/index.html:3820`, `public/app.js:18854`, `public/app.js:21141`, `public/portal.js:1755`.
- Katalog und Fähigkeiten: `lib/personnel-learning-catalog.js`, `lib/personnel-learning-skills.js`.
- Kompetenzen, Zuweisungen, Durchführung: `lib/personnel-learning-competencies.js`, `lib/personnel-learning-assignments.js`, `lib/personnel-learning-progress.js`.
- Rechte und API: `lib/personnel-learning-access.js`, `server.js:11085`, `server.js:12164`, `server.js:12283`, `server.js:40771`, `server.js:41347`.
- Speicherung: `lib/persistence/statements/personnel-learning.js`, `lib/persistence/repositories/personnel-learning.js`.
- Abgrenzung: `docs/PERSONALMODUL-ONBOARDING-OFFBOARDING-O6-SCHULUNGEN-ARBEITSMITTEL-ZUGAENGE-v0.1.md:156`.
- Lokale Prüfnachweise: `tmp/learning-live-inventory-20260915.json`, `tmp/learning-inventory-tests-20260915.log`, `tmp/learning-inventory-fixture-probe-20260915.log`; ausschließlich synthetische Testkopien unter `tmp/learning-inventory-probes/`.
