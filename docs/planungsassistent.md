# Lokaler Planungsassistent – Prüfung und CP-SAT-Optimierung

Der Planungsassistent prüft den gespeicherten GP-Wochenplan automatisch, nachdem die vorhandene Dienstplanansicht und ihre Zusatzprüfungen geladen wurden. Eine Schaltfläche erlaubt die erneute Prüfung. Die Ergebnisse stehen direkt im Dienstplan, mit Schweregrad, betroffenen Personen und Zeitfenstern, Ursache sowie einem konkreten Prüf- oder Änderungsvorschlag. Zusätzlich berechnet ein lokaler Python-Dienst mit Google OR-Tools CP-SAT Wochenplanvorschläge und Ersatzpersonal. Erst die ausdrückliche Bestätigung eines geprüften Vorschlags speichert Dienste. Es werden keine externen KI-Dienste für Planung oder Berechnung verwendet.

## Strategie und Integration

Die Umsetzung verbindet vorhandene Arbeitsregelprofile, Filialaufsichtsregeln, Zeitbewertung, Abwesenheitsdaten, Lernanforderungen und Berechtigungsgrenzen. Die Reihenfolge ist: autorisierte GP-Fakten laden, zulässige Dienstvarianten über die bestehende Validierung bestimmen, lokal optimieren, das Gesamtergebnis erneut im GP prüfen, Unterschiede anzeigen und erst nach Bestätigung transaktional übernehmen. Es entsteht keine zweite Planungs-, Personal- oder Zeitkontenverwaltung.

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
| Fachliche Qualifikationen | Bestehende Lernanforderungen, Kompetenzrevisionen, Schulungsabschlüsse und `personnel-learning-team.cell` | Prüfung von Fassung, Stufe, Gültigkeit und Zielgruppe am Diensttag und in der tatsächlichen Abteilung |

Die HTTP-Route `GET /api/schedule/assistant` lädt diese Quellen serverseitig. Die Bedienoberfläche übermittelt nur Woche, Filiale und optional Abteilung. Personalnummern, frei erfundene Prüfdaten und fremde Standortdaten werden nicht als Eingabe angenommen. Die zusätzliche Prüfung hat einen eigenen Lade-/Fehlerstatus; ein Ausfall lässt die normale Dienstplanansicht und bestehende Mutationstests weiterarbeiten.

`lib/planning-assistant-gp.js` projiziert die vorhandenen GP-Fakten. `lib/planning-assistant.js` ist eine reine, seiteneffektfreie Auswertung mit Ergebnisschema Version 1. `lib/planning-assistant-settings.js` validiert die kleinen betrieblichen Ergänzungen. `public/planning-assistant.js` zeigt den Bericht, filtert nach Schweregrad und verwirft verspätete Ergebnisse nach Konto-, Rechte- oder Bereichswechsel. Die automatische Prüfung ist eine Prüfung beim Laden/Aktualisieren, kein Hintergrundprozess und kein zugesicherter Echtzeitabgleich zwischen mehreren Browsern.

## Prüfeinstellungen

Unter **Planungsassistent → Prüfeinstellungen für diesen Bereich** können Berechtigte mit `settings:write` speichern:

- Toleranz beim Vergleich zum vertraglichen Wochensoll, 0–600 Minuten; Standard 0.
- Mindestanzahl je vorhandener aktiver Position, bis zu 20 Positionen.
- Eine Gruppe ausgewählter Schlüsselpersonen; mindestens eine davon muss im Besetzungsfenster verfügbar sein. Leere Auswahl erzeugt keine zusätzliche Pflicht.

Die Vorgaben gelten im bestehenden täglichen Besetzungsfenster, außerhalb der konfigurierten Mittagsschließung. Sperrtage und gesetzliche Feiertage werden bei diesen Besetzungsanforderungen genauso ausgenommen wie in der bestehenden Filialaufsichtsprüfung; tatsächlich eingetragene Dienste bleiben Gegenstand der Arbeitsregelprüfung. Filiale und Abteilung besitzen getrennte Einstellungen. Im Gesamtplan werden zusätzlich die Vorgaben aller aktiven Abteilungen berücksichtigt, damit eine filialweite Optimierung keine Abteilungspflicht umgeht. Zeiten, Besetzungszahlen und Pausen ändern Berechtigte weiterhin in den vorhandenen Filialeinstellungen, Arbeitsregelprofile in ihrer vorhandenen Verwaltung.

`PUT /api/settings/planning-assistant` speichert ausschließlich diese Vorgaben, transaktional über das vorhandene Repository. Berechtigungen, Scope und CSRF werden geprüft, nur existente Personen/Positionen akzeptiert. Der Inhaltsstand verhindert verlorene gleichzeitige Änderungen. Vorher/Nachher werden im bestehenden Audit aufgezeichnet. Der GP erhält keine zusätzlichen Planungs- oder Personaltabellen.

## Aussagekraft und Grenzen

**Konflikt**, **Warnung**, **Nicht prüfbar** und **Hinweis** sind Darstellungsstufen. Davon getrennt kennzeichnet `constraint` einen zwingenden Sachverhalt (`hard`), eine Präferenz (`preference`) oder einen fachlich zu klärenden Sachverhalt (`review`). Phase 1 sperrt selbst keine Mutation. Die bestehenden GP-Sperren und Freigabeprozesse bleiben maßgeblich.

Ein Überschneidungsbefund kann Dienste desselben Mitarbeiters außerhalb des betrachteten Bereichs berücksichtigen. Er zeigt nur die lokale Einteilung und einen neutralen Hinweis auf eine weitere Einteilung; fremde Dienstkennungen, Filialdetails und fremde Personen werden nicht ausgegeben. Gleichzeitig eingeteilte Abteilungen sichern keine eindeutige Abteilungsabdeckung; filialweit zählt die Person höchstens einmal.

Ein vollständiger Wochen-Sollvergleich wird nur im Gesamtplan der Stammfiliale ausgewiesen. Bei Abteilungsausschnitten, geliehenen Mitarbeitenden oder widersprüchlichen Zeitangaben erscheint die Bewertung als nicht prüfbar. Die vorhandene GP-Gewichtung und Gutschriften werden übernommen. Eine positive Wochendifferenz ist keine abgeschlossene arbeitsrechtliche Überstunden- oder Entgeltbewertung; tatsächliche Arbeitszeiten werden durch diese Planprüfung nicht ersetzt.

Die Lern-Teamübersicht besitzt bereits versionierte Anforderungen an Fähigkeiten und Schulungen einschließlich Gültigkeitsdauer, Position, Rolle und organisatorischem Geltungsbereich. `personnel-learning-evidence` stellt deren bestehende revisionsgeprüfte Nachweise gemeinsam für Teamübersicht und Planungsassistent bereit. `planning-qualifications` verwendet dieselbe fachliche Bewertung für jeden Diensttag und jede tatsächliche Abteilung. Ein bald ablaufender, am Diensttag noch gültiger Nachweis bleibt zulässig; ein abgelaufener, fehlender oder unpassender Nachweis schließt die Dienstvariante aus. Rechte für die Lern-Teamübersicht bleiben erforderlich. Für nicht freigegebene Mitarbeitende erscheint „nicht prüfbar“; deren private Nachweise werden nicht geladen. Nachträglich geänderte Nachweise werden nicht als Beleg für historische Dienste ausgegeben. Eine Rekonstruktion historischer Nachweisstände ist kein Bestandteil der Optimierung zukünftiger Wochen.

Ungültige und kalenderübergreifende Altdienste werden in der zusätzlichen Besetzungsprüfung als nicht prüfbar markiert. Die bestehende Arbeitsregelprüfung behält ihre eigene kalender- und zeitzonenbezogene Behandlung. Das manuelle GP-Dienstzeitfenster und vorhandene Speichervalidierungen werden nicht erweitert. Bei ausgeschalteter Filialaufsicht, fehlender Leseberechtigung für Arbeitsregeln oder fehlender Pausenlage erscheint keine ersatzweise grüne Freigabe.

Gesetzliche Regeln werden nicht anhand dieses Dokuments neu festgelegt. Die bestehenden Profile haben Quellen, Geltungsbereich und Freigabestatus. Als aktuelle Referenz wurde am 12. Oktober 2026 unter anderem [AZG § 12 im RIS](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=12) eingesehen. Diese Implementierung ersetzt weder eine fachliche Profilfreigabe noch die Prüfung anwendbarer Ausnahmen.

## Lokale Optimierung

Unter **Planungsassistent → Planvorschläge und Ersatzpersonal** stehen Wochenplanoptimierung und Ersatz für eine ausgewählte ausfallende Person bereit. Auch eine leere zukünftige Woche kann besetzt werden. Die Auswahl verwendet ausschließlich Mitarbeitende, die der bestehende GP für diesen Standort-/Abteilungsausschnitt freigibt. Filialübergreifende Personalzuordnung erfolgt weiterhin über die vorhandenen GP-Zuordnungen und Verleihfunktionen.

`lib/planning-optimizer.js` erstellt Vertrag Version 2 mit ganzzahligen Minuten und vorgeprüften Dienstvarianten. Varianten entstehen aus bestehenden Diensten, Öffnungsfenstern, halben Öffnungsfenstern und vertraglichen Tageslängen im 30-Minuten-Raster. Mindestbesetzung, Positions- und Schlüsselpersonenabdeckung werden an allen tatsächlichen Dienst-/Pausengrenzen geprüft; die Besetzungsprüfung verwendet kein grobes Zeitraster. Bestätigte Abwesenheiten, Krankenstand, feste Arbeitstage, fremde Überschneidungen und Qualifikationen werden über die vorhandenen GP-Funktionen ausgeschlossen. Bei Ersatzsuche bleiben nicht betroffene Dienste erhalten; eine schon eingeteilte Person kann denselben Dienst nicht zusätzlich als Ersatz abdecken.

Es werden bis zu drei unterschiedliche Szenarien berechnet:

| Szenario | Gewicht Änderungen | Sollabweichung je Minute | Wunschabweichung | Samstagsdifferenz |
| --- | ---: | ---: | ---: | ---: |
| Wenige Änderungen | 600 | 1 | 25 | 20 |
| Ausgewogene Planung | 180 | 3 | 60 | 100 |
| Wünsche bevorzugen | 120 | 2 | 300 | 60 |

Wünsche sind der hinterlegte bevorzugte freie Wochentag und offene Abwesenheitswünsche. Offene Wünsche werden als Präferenz behandelt, niemals stillschweigend genehmigt. Für die Samstagsverteilung zählen unterschiedliche Samstage der letzten acht Wochen plus die vorgeschlagene Woche. GP-Gutschriften werden beim Sollvergleich beibehalten. Änderungen sind entfernte plus hinzugefügte Dienste; unveränderte Dienste behalten ihre Datenbankkennung und Notizen. Die Oberfläche zeigt diese Messwerte, vollständige Dienste, Unterschiede und verbleibende GP-Prüfhinweise.

`services/planning-optimizer/service.py` führt echte [OR-Tools-CP-SAT-Berechnungen](https://developers.google.com/optimization/scheduling/employee_scheduling) aus. Node startet den Python-Prozess bei Bedarf und kommuniziert über Standard-Ein-/Ausgabe. Es gibt keinen zusätzlichen Netzwerkport. Der Prozess erhält Zahlen und Kennungen, keine Namen, Diagnosen, GP-Zugangsdaten oder OpenAI-Schlüssel; er besitzt keine Datenbankverbindung. Standard: ein Worker, drei Sekunden Solver-Zeit je Versuch, maximal vier Versuche pro Szenario, insgesamt 60 Sekunden Berechnungsbudget, höchstens 100 Mitarbeitende, 3.000 Varianten und 12.000 Constraint-Gruppen. Ein Abbruch beendet auch den laufenden Python-Prozess. Eingabe/Ausgabe und parallele Berechnungen sind begrenzt; Zeitüberschreitung oder fehlende Laufzeit liefern einen verständlichen Fehler.

Der Solver optimiert innerhalb dieser begrenzten Variantenmenge. `OPTIMAL` bedeutet optimal für das jeweilige Modell, seine Gewichte und bereits ausgeschlossene Ergebnisse; `FEASIBLE` bedeutet einen gültigen gefundenen Kandidaten ohne Optimalitätsnachweis. Kein Ergebnis beweist, dass außerhalb der Variantenmenge kein besserer Plan existiert. Nicht erfüllbare Modelle benennen betroffene Besetzungsfenster; verworfene GP-Ergebnisse werden nicht zur Übernahme freigegeben. Eine nicht konkret verortete Pauschalpause zählt konservativ nicht als gesicherte Besetzungsabdeckung. Fehlende optionale Schlüsselpersoneneinstellungen bleiben ein Hinweis; beschädigte Einstellungen oder ungültige Besetzungsfenster verhindern die Optimierung.

Gesetzliche Grenzen werden nicht nochmals in Python nachgebaut: `validateShift`, `evaluateScheduleWorkRules`, die bestehende Filialaufsicht und die gemeinsame Konfliktprüfung validieren jedes gesamte Ergebnis. Zwingende GP-Regeln sperren die Übernahme. Vorhandene Warn-/Prüfmodi bleiben als sichtbare Prüfhinweise bestehen. Diese Architektur übernimmt die aktuelle GP-Fachlogik und erteilt keine zusätzliche rechtliche Freigabe.

## Bestätigte Übernahme

`POST /api/schedule/assistant/proposals` braucht aktuelle Rechte `schedule:read`, `schedule:write`, `work_rules:read`, freigegebenen Scope und CSRF. Die GP-Qualifikationsprüfung muss verfügbar sein. Die Anfrage enthält nur Woche, Filiale, gegebenenfalls Abteilung, Aufgabe und bei Ersatzsuche die ausfallende Person. Fremde Prüfdaten, SQL oder frei erzeugte Dienste werden nicht angenommen. Die Berechnung verändert keine Dienste.

Der geprüfte Vorschlag bleibt höchstens zehn Minuten im begrenzten Server-Arbeitsspeicher und ist an Sitzung, Konto, Rolle und Rechte gebunden. **Ich habe die Änderungen und GP-Prüfhinweise geprüft …** plus **Diesen Vorschlag verbindlich übernehmen** senden seine zufällige Kennung und Bestätigungskennung an `POST /api/schedule/assistant/apply`. Die Route akzeptiert ausschließlich `confirmed: true` für einen serverseitig vorhandenen Vorschlag.

Vor der Übernahme werden die aktuellen Daten erneut geprüft. Ein Fingerabdruck über Pläne, Abwesenheiten, Verträge, Einstellungen, Regel-/Qualifikationsnachweise und relevante Ist-/Gutschriftenstände erkennt zwischenzeitliche Änderungen. Innerhalb der seriellen GP-Transaktion werden Sitzung, Scope und Fingerabdruck nochmals geprüft. Bestehende Repository-Funktionen entfernen und ergänzen die geänderten Dienste gemeinsam mit Arbeitsregelbeleg, Tagesprüfungsentwertung und Audit `planning.assistant.proposal.apply`. Fehler rollen alles zurück. Wiederholung derselben erfolgreichen Bestätigung liefert denselben Beleg; ein anderer Vorschlag desselben Vergleichs kann danach nicht zusätzlich übernommen werden. Serverneustart, Ablauf oder Rechtewechsel erfordern neue Vorschläge.

## Python-Einrichtung und Betrieb

Für einen persönlichen Pilot kann `GRABENPLANER_PLANNING_ASSISTANT_PILOT_EMPLOYEES` auf eine kommagetrennte Liste von Personalnummern gesetzt werden. Nur diese persönlichen Konten erhalten dann Planprüfung, Prüfeinstellungen, Vorschläge und bestätigte Übernahmen; vorhandene Planungsrechte bleiben zusätzlich erforderlich. Ohne die Variable gelten die normalen GP-Rechte. Eine fehlerhafte Liste sperrt die Assistentenfunktionen. Die gewöhnliche Dienstplanung bleibt für die übrigen berechtigten Konten verfügbar.

Getestet sind Python 3.10 unter Windows und Python 3.14.4 unter Linux mit `ortools==9.15.6755`. Installation in einer eigenen virtuellen Umgebung gemäß [offizieller Python-Installation](https://developers.google.com/optimization/install/python):

```powershell
python -m venv .venv-planning
.\.venv-planning\Scripts\python.exe -m pip install -r services/planning-optimizer/requirements.txt
```

```sh
python3 -m venv /opt/grabenplaner-planning-venv
/opt/grabenplaner-planning-venv/bin/python -m pip install -r services/planning-optimizer/requirements.txt
```

Für einen Server liegt die Umgebung dauerhaft außerhalb austauschbarer Release-Verzeichnisse. `GRABENPLANER_PLANNING_PYTHON` erhält den absoluten Interpreterpfad; der GP-Dienstbenutzer benötigt Ausführungs-/Leserechte. Ohne Variable wird `.venv-planning/Scripts/python.exe` unter Windows beziehungsweise `.venv-planning/bin/python` im Checkout verwendet. `GRABENPLANER_PLANNING_OPTIMIZER_ENABLED=0` sperrt Vorschläge ausdrücklich. Die normale Dienstplanung und Konfliktprüfung bleiben ohne Python nutzbar.

Die Windows-/Linux-Paketlisten enthalten ausschließlich die beiden benötigten Python-Quelldateien; virtuelle Umgebungen, lokale Schlüssel und Testdaten werden nicht mitgeliefert. Die Python-Abhängigkeiten werden bei der dokumentierten Einrichtung installiert, niemals automatisch während einer Planberechnung. Es fallen keine externen Modellkosten für die Optimierung an; Laufzeit und Speicher werden lokal benötigt. Die bestehende Serverinstallation wurde durch diese Entwicklung nicht verändert.

Sprachsteuerung der Planung ist ein späterer, eigener Ausbau. Der bereits vorhandene [Portal-Sprachassistent](gpt-live-sprachassistent.md) bleibt auf eigene Mitarbeiterdaten und Antragsentwürfe begrenzt.

## Lokale Prüfung

Automatisierte Tests verwenden synthetische Daten in isolierten temporären GP-Datenbanken. Sie prüfen Überschneidungen, minutengenaue Lücken, Nichtverfügbarkeiten, Pausen, Doppelzählung, Positionen/Schlüsselpersonen, bestehende Regelbefunde, Wochenbewertung, Scope, Rollen, CSRF, ungültige Parameter, veraltete Einstellungen sowie fehlende Daten. Browserprüfungen decken Desktop, Smartphone, dunkle Darstellung, Filter, Speichern, Verbindungsfehler und Abmeldung ab.

```powershell
node --test --test-concurrency=1 test/planning-assistant.test.js test/assistant-management-api.test.js
$env:GP_PLANNING_SOLVER_TEST = '1'
node --test --test-concurrency=1 test/planning-qualifications.test.js test/planning-optimizer.test.js test/planning-optimizer-api.test.js
$env:GP_WINDOW_BROWSER_TEST = '1'
$env:GP_DEFINITIONS_BROWSER_TEST = '1'
node --test --test-concurrency=1 test/assistant-management-browser.test.js test/gp-definitions-browser.test.js
node --test test/planning-optimizer-browser.test.js
```

Die Browser verwenden dieselben `GP_BROWSER_TEST_MODULE`- und `GP_BROWSER_EXECUTABLE`-Einstellungen wie die vorhandenen GP-Tests. `GP_PLANNING_SOLVER_TEST=1` verlangt eine tatsächlich vorhandene Python-Laufzeit. Die Tests prüfen echte Solver-Ergebnisse, leere Wochen, Ersatzsuche, Präferenzen, Fairness, beschädigte Einstellungen, abgelaufene Nachweise, Abteilungsbindung, Rechteentzug, veraltete Vorschläge, Transaktionsrollback, Wiederholung und ausdrückliche Bestätigung. Die lokale Abnahme ist keine produktive Aktivierung.
