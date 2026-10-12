# Lokaler Planungsassistent – Phase 1

Der Planungsassistent prüft den gespeicherten GP-Wochenplan automatisch, nachdem die vorhandene Dienstplanansicht und ihre Zusatzprüfungen geladen wurden. Eine Schaltfläche erlaubt die erneute Prüfung. Die Ergebnisse stehen direkt im Dienstplan, mit Schweregrad, betroffenen Personen und Zeitfenstern, Ursache sowie einem konkreten Prüf- oder Änderungsvorschlag. Der Assistent führt keine Dienstplanänderung, Genehmigung oder externe KI-Anfrage aus.

## Strategie und Integration

Die Analyse hat bereits vorhandene Arbeitsregelprofile, Filialaufsichtsregeln, Zeitbewertung, Abwesenheitsdaten und Berechtigungsgrenzen ergeben. Phase 1 verbindet diese Quellen mit einer kleinen lokalen Konfliktprüfung. Es entsteht keine zweite Planungs-, Personal- oder Zeitkontenverwaltung.

| Bereich | Bestehende Quelle | Ergänzung |
| --- | --- | --- |
| Freigegebener Wochenplan | `getSchedule`, `resolvePlanningContext`, bestehende Repositories | Auf den autorisierten Standort-/Abteilungsausschnitt begrenzter Prüfbericht |
| Arbeitszeitgrenzen und Ruhezeiten | `evaluateScheduleWorkRules`, zugewiesene GP-Regelprofile einschließlich Jugend-, Schutz-, KV- und Unternehmensregeln | Übernahme von Ergebnis, Durchsetzungsmodus und Regelkennung; keine neuen gesetzlichen Grenzwerte |
| Urlaub, ZA, Sonderfälle | `listOverlappingWeekOptions`, dieselben Ganztags-/Zeitfensterregeln wie `optionOverlapsTime` | Überschneidungen mit vorhandenen Diensten; offene Wünsche werden nicht als bewilligte Abwesenheit behandelt |
| Krankenstand | `sicknessCreditsForEmployeesInRange`, wie im normalen Dienstplan | Neutrale Nichtverfügbarkeit ohne Diagnose, Fallkennung, Dokumente oder Fallnotizen |
| Fixe Arbeitstage und Sperrtage | `employeeCanWorkOnDate`, vorhandene globale Tagessperren | Hinweise auf vorhandene widersprüchliche Einteilungen |
| Pausen | `plannedShiftBreaks`, Filialkonfiguration | Konkrete Pausenfenster werden abgezogen; Pauschalpausen ohne Zeitpunkt erzeugen Unsicherheit statt erfundener Abdeckung |
| Besetzung | `dayConfiguration`, Filial- und Abteilungs-Mindestbesetzung | Prüfung an tatsächlichen Intervallgrenzen statt grobem Zeittakt; jede Person zählt höchstens einmal |
| Filialaufsicht | `assessBranchSupervision` | Wiederverwendung mit bekannter tatsächlicher Planverfügbarkeit nach Abwesenheits-/Pausenabzug im Gesamtplan |
| Vertragliches Soll | `contracted_hours` und bestehende `getSchedule.totals` | Vergleich von GP-Planbewertung einschließlich Gutschriften zum Wochensoll |
| Positionen und Schlüsselpersonen | Bestehende Positionen und Mitarbeitende des freigegebenen Bereichs | Konfigurierbare Besetzungsvorgaben; keine Kopie von Stammdaten |

Die HTTP-Route `GET /api/schedule/assistant` lädt diese Quellen serverseitig. Die Bedienoberfläche übermittelt nur Woche, Filiale und optional Abteilung. Personalnummern, frei erfundene Prüfdaten und fremde Standortdaten werden nicht als Eingabe angenommen. Die zusätzliche Prüfung hat einen eigenen Lade-/Fehlerstatus; ein Ausfall lässt die normale Dienstplanansicht und bestehende Mutationstests weiterarbeiten.

`lib/planning-assistant-gp.js` projiziert die vorhandenen GP-Fakten. `lib/planning-assistant.js` ist eine reine, seiteneffektfreie Auswertung mit Ergebnisschema Version 1. `lib/planning-assistant-settings.js` validiert die kleinen betrieblichen Ergänzungen. `public/planning-assistant.js` zeigt den Bericht, filtert nach Schweregrad und verwirft verspätete Ergebnisse nach Konto-, Rechte- oder Bereichswechsel. Die automatische Prüfung ist eine Prüfung beim Laden/Aktualisieren, kein Hintergrundprozess und kein zugesicherter Echtzeitabgleich zwischen mehreren Browsern.

## Prüfeinstellungen

Unter **Planungsassistent → Prüfeinstellungen für diesen Bereich** können Berechtigte mit `settings:write` speichern:

- Toleranz beim Vergleich zum vertraglichen Wochensoll, 0–600 Minuten; Standard 0.
- Mindestanzahl je vorhandener aktiver Position, bis zu 20 Positionen.
- Eine Gruppe ausgewählter Schlüsselpersonen; mindestens eine davon muss im Besetzungsfenster verfügbar sein. Leere Auswahl erzeugt keine zusätzliche Pflicht.

Die Vorgaben gelten im bestehenden täglichen Besetzungsfenster, außerhalb der konfigurierten Mittagsschließung. Sperrtage und gesetzliche Feiertage werden bei diesen Besetzungsanforderungen genauso ausgenommen wie in der bestehenden Filialaufsichtsprüfung; tatsächlich eingetragene Dienste bleiben Gegenstand der Arbeitsregelprüfung. Filiale und Abteilung besitzen getrennte Einstellungen. Abteilungsvorgaben werden im jeweiligen Abteilungsausschnitt geprüft; für die Gesamtfiliale gelten deren eigene Vorgaben sowie die bestehenden Mindestbesetzungen ihrer Abteilungen. Zeiten, Besetzungszahlen und Pausen ändern Berechtigte weiterhin in den vorhandenen Filialeinstellungen, Arbeitsregelprofile in ihrer vorhandenen Verwaltung.

`PUT /api/settings/planning-assistant` speichert ausschließlich diese Vorgaben, transaktional über das vorhandene Repository. Berechtigungen, Scope und CSRF werden geprüft, nur existente Personen/Positionen akzeptiert. Der Inhaltsstand verhindert verlorene gleichzeitige Änderungen. Vorher/Nachher werden im bestehenden Audit aufgezeichnet. Der GP erhält keine neuen Tabellen oder externen Dienste.

## Aussagekraft und Grenzen

**Konflikt**, **Warnung**, **Nicht prüfbar** und **Hinweis** sind Darstellungsstufen. Davon getrennt kennzeichnet `constraint` einen zwingenden Sachverhalt (`hard`), eine Präferenz (`preference`) oder einen fachlich zu klärenden Sachverhalt (`review`). Phase 1 sperrt selbst keine Mutation. Die bestehenden GP-Sperren und Freigabeprozesse bleiben maßgeblich.

Ein Überschneidungsbefund kann Dienste desselben Mitarbeiters außerhalb des betrachteten Bereichs berücksichtigen. Er zeigt nur die lokale Einteilung und einen neutralen Hinweis auf eine weitere Einteilung; fremde Dienstkennungen, Filialdetails und fremde Personen werden nicht ausgegeben. Gleichzeitig eingeteilte Abteilungen sichern keine eindeutige Abteilungsabdeckung; filialweit zählt die Person höchstens einmal.

Ein vollständiger Wochen-Sollvergleich wird nur im Gesamtplan der Stammfiliale ausgewiesen. Bei Abteilungsausschnitten, geliehenen Mitarbeitenden oder widersprüchlichen Zeitangaben erscheint die Bewertung als nicht prüfbar. Die vorhandene GP-Gewichtung und Gutschriften werden übernommen. Eine positive Wochendifferenz ist keine abgeschlossene arbeitsrechtliche Überstunden- oder Entgeltbewertung; tatsächliche Arbeitszeiten werden durch diese Planprüfung nicht ersetzt.

Im Lernbereich bestehen bereits versionierte Kompetenzprofile und Skill-Module (`personnel-learning-competencies`, `personnel-learning-skills`). Es fehlt deren verbindliche Zuordnung zu Qualifikationsanforderungen für konkrete Dienste und Zeitfenster einschließlich fachlicher Gültigkeitsregeln. Diese Quelle ist deshalb noch nicht an die Planprüfung angebunden; der Bericht benennt diese Lücke ausdrücklich. Hinterlegte Positionen können bereits geprüft werden, ersetzen aber keine Fachnachweise. Eine spätere Anbindung muss den vorhandenen Personal- und Lernbereich verwenden, statt eine parallele Mitarbeiterliste aufzubauen. Ein pauschal als „vollständig geprüft“ oder „rechtskonform“ bezeichnetes Gesamtergebnis wäre deshalb unzutreffend.

Ungültige und kalenderübergreifende Altdienste werden in der zusätzlichen Besetzungsprüfung als nicht prüfbar markiert. Die bestehende Arbeitsregelprüfung behält ihre eigene kalender- und zeitzonenbezogene Behandlung. Das manuelle GP-Dienstzeitfenster und vorhandene Speichervalidierungen werden nicht erweitert. Bei ausgeschalteter Filialaufsicht, fehlender Leseberechtigung für Arbeitsregeln oder fehlender Pausenlage erscheint keine ersatzweise grüne Freigabe.

Gesetzliche Regeln werden nicht anhand dieses Dokuments neu festgelegt. Die bestehenden Profile haben Quellen, Geltungsbereich und Freigabestatus. Als aktuelle Referenz wurde am 12. Oktober 2026 unter anderem [AZG § 12 im RIS](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=12) eingesehen. Diese Implementierung ersetzt weder eine fachliche Profilfreigabe noch die Prüfung anwendbarer Ausnahmen.

## Vorbereitung für Phase 2

`optimizationProblem(facts)` definiert einen lokalen JSON-Vertrag mit Versionsnummer, Inhaltsfingerabdruck, Zeitraum, Mitarbeiterkennungen ohne Namen, Diensten in ganzzahligen Minuten, Nichtverfügbarkeiten, zwingenden Besetzungsvorgaben und getrennten Präferenzen. `status: not_solved` und `applyAllowed: false` kennzeichnen den tatsächlichen Stand. Es existieren weder ein laufender Python-Dienst noch ein Optimierungs- oder Übernahmeendpunkt.

Ein späterer lokaler Python-Adapter kann [Google OR-Tools CP-SAT](https://developers.google.com/optimization/cp/cp_solver) verwenden. Dessen ganzzahlige Modellierung und Ergebniszustände passen zum vorgesehenen Vertrag. Für die nächste Phase sind festzulegen: lokale Prozessgrenzen und Ressourcenlimit, vollständige Aufbereitung harter rechtlicher Regeln, Qualifikationsdaten, Wünsche/Fairnessgewichte, Minimierung von Planänderungen und mehrere Szenarien. Ein Solver-Ergebnis muss danach erneut durch die aktuellen GP-Regeln geprüft werden. Eine Übernahme benötigt eine berechtigte ausdrückliche Bestätigung und einen unveränderten Ausgangsstand; sie soll ausschließlich vorhandene GP-Schreibfunktionen verwenden. Der heutige Vertrag erteilt dafür keine Freigabe.

Sprachsteuerung der Planung ist ein späterer, eigener Ausbau. Der bereits vorhandene [Portal-Sprachassistent](gpt-live-sprachassistent.md) bleibt auf eigene Mitarbeiterdaten und Antragsentwürfe begrenzt.

## Lokale Prüfung

Automatisierte Tests verwenden synthetische Daten in isolierten temporären GP-Datenbanken. Sie prüfen Überschneidungen, minutengenaue Lücken, Nichtverfügbarkeiten, Pausen, Doppelzählung, Positionen/Schlüsselpersonen, bestehende Regelbefunde, Wochenbewertung, Scope, Rollen, CSRF, ungültige Parameter, veraltete Einstellungen sowie fehlende Daten. Browserprüfungen decken Desktop, Smartphone, dunkle Darstellung, Filter, Speichern, Verbindungsfehler und Abmeldung ab.

```powershell
node --test --test-concurrency=1 test/planning-assistant.test.js test/assistant-management-api.test.js
$env:GP_WINDOW_BROWSER_TEST = '1'
$env:GP_DEFINITIONS_BROWSER_TEST = '1'
node --test --test-concurrency=1 test/assistant-management-browser.test.js test/gp-definitions-browser.test.js
```

Die Browser verwenden dieselben `GP_BROWSER_TEST_MODULE`- und `GP_BROWSER_EXECUTABLE`-Einstellungen wie die vorhandenen GP-Tests. Reale Sprachabnahme, produktive Aktivierung und Einsatz der zukünftigen Optimierungsengine werden durch diese lokalen Tests nicht behauptet.
