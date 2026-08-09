# Personalmodul – Onboarding/Offboarding O8: Grafischer Editor v0.1

- Stand: 3. August 2026
- Status: lokaler O8-Minimalvertrag für einen strikt linearen In-Memory-Arbeitsentwurf; nicht veröffentlicht und nicht produktiv aktiviert
- Vertragsversion: `o8-v0.1`
- Modell: `linear-v1`
- Modus: `memory_only`
- Quelle: `memory`
- Vorgänger: O1 bis O7 sowie das fachlich-organisatorisch freigegebene `PERSONALMODUL-ONBOARDING-OFFBOARDING-FACHKONZEPT-v1.0.md`

## 1. Ziel und verbindlicher Minimalumfang

O8 stellt einen echten lokal bearbeitbaren, grafisch darstellbaren Arbeitsentwurf für Onboarding- und Offboarding-Abläufe bereit. Der Entwurf lebt ausschließlich im Arbeitsspeicher. Er wird streng validiert und als lineare Knoten-/Kantenprojektion zurückgegeben, aber weder in SQLite noch in einer anderen Datenbank, Datei, Browserablage, Revision, Publikation, Instanz oder Aufgabe gespeichert.

Der technische Vertrag liegt in `lib/personnel-lifecycle-editor-contract.js`. Er umfasst:

- sechs voneinander getrennte Editor-Rechte ohne automatische Rollenzuweisung,
- einen servergefilterten Katalog für ausdrücklich freigegebene Workflowtypen,
- ein exaktes und fail-closed geprüftes Draft-DTO,
- hart enumerierte Workflow-, Schritt-, Scope-, Pflicht- und Verantwortungsarten,
- strukturierte fachliche Blocker für sicher darstellbare Unvollständigkeit,
- eine ausschließlich aus der Reihenfolge abgeleitete lineare Graphprojektion,
- einen kanonischen SHA-256-Fingerabdruck ohne Layoutdaten und
- vollständig geschlossene Persistenz-, Publikations-, Laufzeit- und Außenwirkungsgates.

O8 erzeugt keine zweite Workflow-Engine. Das lineare Modell ist eine Entwurfs- und Vorschaugrenze. Es erweitert weder die M4-/M5-Ausführung noch O4, O5, O6 oder O7 um neue Wirkungen.

## 2. Bewusste Architekturgrenze

Die bestehende allgemeine Prozessverwaltung ist keine O8-Laufzeit und kein O8-Speicherpfad. Insbesondere werden folgende Bestandteile nicht als Editorbackend verwendet:

- `customProcessModal`,
- `/api/portal/v1/custom-processes`,
- `processes:write`,
- allgemeine `custom_processes`-Trigger,
- `staffing_shortfall`,
- interne, E-Mail- oder SMS-Verständigungen und
- allgemeine Empfängerlisten mit Personalnummern.

Die generischen Tabellen besitzen vor einer ersten M4-Publikation keine eindeutige Lifecycle-Draftklassifikation. Eine persistente Neuanlage über diesen Pfad könnte deshalb einen Personalentwurf nicht sicher von einem Legacy-Prozess unterscheiden. O8 löst diese noch offene Modellentscheidung nicht durch Titel-, Code-, Kategorie- oder UI-Heuristiken.

Eine spätere Speicherung benötigt einen eigenen, ausdrücklich freizugebenden Lifecycle-Draftvertrag. Sie darf bestehende Publikationen, laufende Instanzen, O4-/O5-Fälle oder Legacy-Prozesse nicht umdeuten.

## 3. Exportoberfläche

Der Vertrag exportiert mindestens:

- `PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION`,
- `PERSONNEL_LIFECYCLE_EDITOR_MODEL`,
- `PERSONNEL_LIFECYCLE_EDITOR_MODE`,
- `PERSONNEL_LIFECYCLE_EDITOR_SOURCE`,
- `PERMISSIONS`,
- `PERMISSION_IDS`,
- `ROLE_GRANTS`,
- `RUNTIME_GATES`,
- `WORKFLOW_TYPES`,
- `STEP_TYPES`,
- `SCOPE_TYPES`,
- `REQUIREMENT_KINDS`,
- `RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE`,
- `LIMITS`,
- `BLOCKER_CODES`,
- `PersonnelLifecycleEditorContractError`,
- `personnelLifecycleEditorCatalog(allowedWorkflowTypes)` und
- `validatePersonnelLifecycleEditorDraft(input)`.

Alle zurückgegebenen Katalog-, Validierungs-, Draft-, Knoten-, Kanten-, Blocker- und Gate-Strukturen sind rekursiv eingefroren. Der Vertrag verändert das übergebene Eingabeobjekt nicht.

## 4. Rechtevertrag

| Fachgrenze | Recht |
|---|---|
| Editor lesen | `personnel:lifecycle:editor:read` |
| flüchtigen Entwurf bearbeiten | `personnel:lifecycle:editor:draft:write` |
| Entwurf validieren | `personnel:lifecycle:editor:validate` |
| fachliche Prüfung vormerken | `personnel:lifecycle:editor:review` |
| spätere Publikationsgrenze | `personnel:lifecycle:editor:publish` |
| spätere Archivierungsgrenze | `personnel:lifecycle:editor:archive` |

`ROLE_GRANTS` ist leer. PL, Admin, IT-Admin, Developer, FL, AL, ein lokales Systemkonto oder eine andere Rolle erhält daher allein durch ihren Rollennamen kein O8-Recht. Die Definition von `publish` und `archive` reserviert nur eine getrennte künftige Rechteprüfung. Sie aktiviert weder einen Endpunkt noch eine Wirkung.

Für eine ausdrückliche Einzelzuweisung sind ausschließlich `hr`, `admin`, `it_admin` und `developer` als technische Rollen geeignet. Auch für sie gibt es keinen Built-in-Autogrant. Die Abhängigkeiten bilden eine geschlossene Kette:

1. `personnel:lifecycle:editor:draft:write` setzt `personnel:lifecycle:editor:read` voraus,
2. `personnel:lifecycle:editor:validate` setzt `personnel:lifecycle:editor:draft:write` voraus,
3. `personnel:lifecycle:editor:review` setzt `personnel:lifecycle:editor:validate` voraus,
4. `personnel:lifecycle:editor:publish` setzt `personnel:lifecycle:editor:review` voraus und
5. `personnel:lifecycle:editor:archive` setzt `personnel:lifecycle:editor:publish` voraus.

Der Server bildet den Katalog ausschließlich aus den beim aktuellen Request tatsächlich wirksamen Einzelrechten, der persönlichen Identität und den serverseitig freigegebenen Quellrechten. Clientwerte dürfen weder Workflowtypen noch Scope oder Rechte erweitern.

## 5. Vollständig geschlossene Runtime-Gates

| Gate | Wert | Bedeutung |
|---|---:|---|
| `persistence` | `false` | keinerlei O8-Persistenz |
| `draftPersistence` | `false` | kein gespeicherter Entwurf |
| `publication` | `false` | keine Veröffentlichung |
| `archive` | `false` | keine Archivierung |
| `instantiation` | `false` | keine Prozessinstanz |
| `runtimeExecution` | `false` | keine Ausführung |
| `taskMutation` | `false` | keine Aufgabe oder Aufgabenmutation |
| `notification` | `false` | keine interne oder externe Verständigung |
| `scheduler` | `false` | kein Zeit- oder Hintergrundlauf |
| `externalMutation` | `false` | keine Außenwirkung |
| `legacyBridge` | `false` | keine Verbindung zur Legacy-Prozessruntime |

Katalog und Validierung liefern denselben vollständigen Gate-Satz. Ein Client muss jeden fehlenden, unbekannten oder auf `true` gesetzten Gatewert fail-closed behandeln.

## 6. Servergefilterter Katalog

`personnelLifecycleEditorCatalog(allowedWorkflowTypes)` besitzt ohne ausdrücklich übergebene Workflowtypen einen leeren Katalog. Damit kann ein Aufrufer nicht aus dem allgemeinen O8-Enum selbst eine Sichtbarkeit ableiten.

Der Katalog enthält exakt:

- Vertragsversion, Modell, Modus und Quelle,
- die vom Server zugelassenen Workflowtypen,
- die dazugehörigen Enumwerte,
- nur für diese Workflowtypen die zulässigen Verantwortungsgruppen,
- die festen Größenlimits und
- den vollständigen geschlossenen Gate-Satz.

Zulässige Workflowtypen sind `onboarding` und `offboarding`. Doppelte, unbekannte, dynamisch erzeugte oder lückenhafte Allowlistwerte werden abgewiesen. Die Reihenfolge der vom Server übergebenen Typen bleibt erhalten.

### 6.1 HTTP-Grenze

Die O8-Integration verwendet ausschließlich:

- `GET /api/portal/v1/personnel-lifecycle/editor/catalog` und
- `POST /api/portal/v1/personnel-lifecycle/editor/validate`.

Beide Routen verlangen eine persönliche, aktive, zentrale Mitarbeitersitzung. Organisations-, Shared-, Service- und lokale Systemkonten sind ausgeschlossen.

Der Katalog benötigt das ausdrücklich zugewiesene O8-Leserecht und mindestens ein passendes Quellleserecht. Der Server gibt nur die dadurch tatsächlich sichtbaren Workflowtypen an `personnelLifecycleEditorCatalog` weiter:

- Onboarding benötigt `personnel:lifecycle:onboarding:read`.
- Offboarding benötigt `personnel:lifecycle:offboarding:confidential:read` und `personnel:lifecycle:hr-confidential:read`.

Die Validierung benötigt zusätzlich `personnel:lifecycle:editor:draft:write`, `personnel:lifecycle:editor:validate`, CSRF und die Quellberechtigung des im Draft angegebenen Workflowtyps. Der Requestkörper wird unverändert an die strikte Vertragsfunktion übergeben; unbekannte Felder werden nicht vorab entfernt.

Beide Antworten sind `no-store`, werden nicht mit einem ETag versehen und dürfen nicht als Draftspeicher verwendet werden. Erfolgreiche und abgewiesene Zugriffe werden nur neutral auditiert. Das Detail des erfolgreichen Validierungsaudits enthält ausschließlich `blockerCount`; insbesondere enthält dieses Auditdetail keinen Workflowtyp, Titel, keine Beschreibung, Schrittinhalte, Kennung, Personenbezüge oder Fingerabdrücke.

Es existiert kein Save-, Publish-, Archive-, Run-, Dispatch- oder Legacy-Bridge-Endpunkt unter der O8-Grenze.

## 7. Exaktes In-Memory-Draft-DTO

Der Top-Level-Draft besitzt ausschließlich folgende Pflichtfelder:

| Feld | Vertrag |
|---|---|
| `draftId` | opake Kennung, höchstens 128 Zeichen; darf bis zur Vervollständigung leer sein |
| `workflowType` | `onboarding` oder `offboarding` |
| `workflowCode` | stabiler technischer Code, höchstens 80 Zeichen; darf bis zur Vervollständigung leer sein |
| `title` | fachlicher Titel, höchstens 120 Zeichen |
| `description` | Beschreibung, höchstens 600 Zeichen |
| `scopeType` | `company`, `location` oder `department` |
| `requirementKind` | `mandatory` oder `optional` |
| `steps` | vollständig materialisierte Liste mit höchstens 30 Schritten |

Jeder Schritt besitzt ausschließlich:

| Feld | Vertrag |
|---|---|
| `id` | opake technische Schrittkennung, höchstens 80 Zeichen |
| `type` | `task`, `approval` oder `finish` |
| `title` | fachlicher Titel, höchstens 120 Zeichen |
| `description` | Beschreibung, höchstens 600 Zeichen |
| `responsibilityClass` | für den Workflowtyp freigegebene Verantwortungsgruppe |
| `required` | ausdrücklicher Boolean |

Nicht zugelassen sind insbesondere `edges`, `layout`, Koordinaten, Trigger, Kanäle, Bedingungen, Termine, Erinnerungen, Eskalationen, Integrationsziele, Personenkennungen oder freie Empfängerobjekte. Unbekannte Felder werden nicht ignoriert, sondern strukturell abgewiesen.

## 8. Verantwortungsgruppen statt Personenbindung

O8 speichert und projiziert keine Personalnummer, Mitarbeiter-ID oder automatisch ausgewählte Person. Vor einem späteren tatsächlichen Start muss weiterhin jeder nicht systemische Schritt nach Live-Rechte- und Scopeprüfung ausdrücklich einer konkreten Person zugewiesen werden. Der Editor legt dafür nur eine Aufgaben- beziehungsweise Verantwortungsgruppe fest.

Für `onboarding` sind zulässig:

- `hr_case`,
- `payroll`,
- `leadership`,
- `it_security`,
- `asset_custodian`,
- `trainer`,
- `employee`.

Für `offboarding` sind zulässig:

- `offboarding_confidential`,
- `hr_confidential`,
- `payroll`,
- `leadership`,
- `it_security`,
- `asset_custodian`,
- `employee`.

Eine für den anderen Workflowtyp vorgesehene Gruppe und jeder freie Wert werden fail-closed abgewiesen. Rollenname, Titel, Code oder aktuelle Kontobesetzung ersetzen diese explizite Klassifikation nicht.

## 9. Lineare Semantik und strukturierte Blocker

Der sichere Zielzustand eines Arbeitsentwurfs verlangt:

- mindestens zwei und höchstens 30 Schritte,
- eindeutige, nicht reservierte technische Schrittkennungen,
- genau einen `finish`-Schritt,
- `finish` an der letzten Position,
- einen verpflichtenden Abschlussschritt und
- `company` für einen `mandatory`-Ablauf.

Sicher darstellbare Unvollständigkeit erzeugt keinen Strukturfehler, sondern einen Blocker mit `code`, `path` und neutraler `message`. Dazu zählen beispielsweise:

- fehlende Draft-ID, Workflow-Code oder Titel,
- weniger als zwei Schritte,
- fehlende Schritt-ID, Schrittart, Schritttitel oder Verantwortungsgruppe,
- fehlender, mehrfacher, nicht letzter oder nicht verpflichtender Abschluss sowie
- ein lokaler Pflichtablauf.

Die Validierung antwortet dann mit `status: "blocked"`, `valid: false` und einer eingefrorenen Blockerliste. Sie erzeugt trotzdem eine ausschließlich für die flüchtige Darstellung geeignete Graphprojektion. Ein fehlender Schrittbezug erhält darin nur die temporäre Darstellungskennung `memory-node-N`.

Unsichere oder widersprüchliche Struktur wird dagegen mit `PersonnelLifecycleEditorContractError` abgewiesen. Das gilt unter anderem für:

- Proxyobjekte,
- fremde Objekt- oder Arrayprototypen,
- Getter und Setter,
- Symbolfelder,
- Arraylöcher,
- unbekannte oder fehlende DTO-Felder,
- zu große Eingaben,
- ungültige Enumwerte,
- ungültige, doppelte oder reservierte Kennungen und
- nicht boolesche `required`-Werte.

Fehlermeldungen übernehmen keine Offboarding-Inhalte oder andere Eingabefreitexte.

## 10. Serverseitig abgeleitete Knoten und Kanten

Ein erfolgreicher oder fachlich blockierter Draft wird in Knoten mit `id`, `position`, `type`, `title`, `description`, `responsibilityClass` und `required` projiziert. Kanten entstehen ausschließlich zwischen zwei unmittelbar aufeinanderfolgenden Knoten und besitzen den Typ `sequence`.

Der Client darf keine Kante, Verzweigung, Bedingung oder Layoutposition vorgeben. O8 enthält deshalb insbesondere nicht:

- parallele Pfade,
- Ja-/Nein-Verzweigungen,
- Sprünge oder Schleifen,
- bedingte Ausführung,
- automatische Überspringlogik oder
- graphisch erzeugte Laufzeitsteuerung.

Eine grafische Darstellung darf die Reihenfolge sichtbar machen, aber keine über das lineare Modell hinausgehende Semantik vortäuschen.

### 10.1 Workflow-Center-Dialog

Die O8-Oberfläche ist als eigenständiger Dialog im Workflow Center umgesetzt. Sie ersetzt oder erweitert weder das Legacy-Modal `customProcessModal` noch dessen Persistenz- und Laufzeitpfade. Der Einstieg und der Dialog erscheinen nur bei aktuellem O8-Lesezugriff; die vom Server gelieferten Workflowtypen bleiben zusätzlich durch die jeweiligen Quellleserechte begrenzt.

Der Dialog zeigt:

- die Grunddaten der ausschließlich lokalen Arbeitskopie,
- die lineare Schrittreihenfolge als semantische geordnete Liste (`ol`),
- einen Inspector für den ausgewählten Schritt,
- lokale Aktionen zum Hinzufügen, Verschieben und Entfernen von Schritten sowie
- das Ergebnis der ausdrücklich ausgelösten, nebenwirkungsfreien Serverprüfung.

Jeder Eintrag der geordneten Liste bleibt als eigener bedienbarer Schritt erkennbar. Die Anordnung erfolgt ausschließlich mit beschrifteten Schaltflächen; O8 führt kein Drag-and-drop und keine vom Client modellierten Kanten ein. Bedienziele sind mindestens 44 Pixel hoch. Bei höchstens 700 Pixeln wird der Arbeitsbereich einspaltig, bei 320 Pixeln bleiben Dialog, Reihenfolge, Inspector und Aktionszeilen ohne horizontales Abschneiden nutzbar. Diese CSS-/DOM-Vorgaben sind technisch geprüft, ersetzen jedoch keine interaktive Browserabnahme.

Im Dialog gibt es bewusst keine Schaltfläche zum Speichern, Veröffentlichen, Aktivieren oder Starten. Vor dem Schließen oder lokalen Zurücksetzen eines veränderten Entwurfs wird dessen Verwerfen bestätigt. Ein Request-Token verwirft verspätete Katalog- oder Validierungsantworten. Ein Access-Fingerprint bindet die flüchtige Ansicht an die aktuelle Identität, die relevanten O8- und Quellrechte sowie die aktuellen Scopes. Bei Logout, Identitäts-, Rechte- oder Scopewechsel, Verlassen des Bereichs, Fehler oder Dialogbereinigung werden Draft, Ausgangskopie, Auswahl, Prüfergebnis, Token und alle zugehörigen DOM-Werte vollständig entfernt. Browserpersistenz wird nicht verwendet.

## 11. Kanonischer Fingerabdruck

Jede strukturell gültige Eingabe erhält einen SHA-256-Fingerabdruck über die normalisierte fachliche Draftstruktur, die Vertragsversion und das Modell. Die kanonische Serialisierung sortiert Objektschlüssel, bewahrt jedoch die fachlich relevante Schrittreihenfolge.

Layout, Zoom, Fokus, Panelposition oder andere UI-Zustände sind kein Bestandteil des Draft-DTO und damit nicht Bestandteil des Fingerabdrucks. Derselbe fachliche Inhalt erzeugt unabhängig von der Einfügereihenfolge der Objektfelder denselben Fingerabdruck. Inhalt oder Schrittreihenfolge verändern ihn.

Der Fingerabdruck ist ausschließlich ein deterministischer Vergleichs- und Integritätsbezug für den flüchtigen Entwurf. Er ist keine Verschlüsselung, Berechtigung, Signatur, Publikation, Revision oder dauerhafter Beleg.

## 12. Vertrauliches Offboarding

Ein Offboarding-Arbeitsentwurf ist ausschließlich flüchtig. Sein Titel, seine Beschreibung, Schritttitel und Schrittbeschreibungen dürfen niemals in den allgemeinen M4-Klartextpfad, Legacy-Prozesse, allgemeine Auditdetails, Anwendungslogs, URLs, Browserpersistenz, Fehlertexte oder Telemetrie übernommen werden.

Die reine Vertragsfunktion protokolliert nichts und persistiert nichts. Eine Serverintegration darf den Requestkörper weder vollständig noch teilweise loggen. Ein neutrales Zugriffsaudit darf höchstens Aktion, Ergebnisstatus und nicht rückführbare Zähler enthalten; es darf keine Draftinhalte, Kennungen, Personalbezüge oder Fingerabdrücke kopieren.

O8 öffnet nicht die verschlüsselte O5-Paket- und Fallpersistenz für Editorinhalte. O5-Fälle, Pläne, Aufgaben und Zustandsübergänge bleiben unverändert. Der In-Memory-Entwurf erzeugt weder eine Offboarding-Vorbereitung noch eine Kommunikationsfreigabe.

## 13. Trennung zu O6 und O7

O6-Zielsysteme und O7-Richtlinien sind nicht Bestandteil des O8-Drafts. Der Editor darf insbesondere nicht aus Titel, Schrittart oder Verantwortungsgruppe ableiten:

- welches Schulungs-, Arbeitsmittel- oder Zugangssystem angesprochen werden soll,
- welcher Referenztermin gilt,
- welche Frist oder Kalenderregel anzuwenden ist,
- wer automatisch vertreten wird oder
- ob eine Erinnerung oder Eskalation auszulösen wäre.

Falls eine spätere UI O6- oder O7-Zustände als Badge darstellt, müssen diese ausschließlich aus einer eigenen serverseitig berechtigten Read-only-Projektion stammen. Der Browser setzt keine Defaultwerte und schreibt sie nicht in den O8-Fingerabdruck.

## 14. Ausdrücklich nicht enthalten

O8 v0.1 enthält keine:

- SQLite- oder PostgreSQL-Migration,
- Entwurfs-, Knoten-, Kanten- oder Layouttabelle,
- Datei-, Local-Storage-, Session-Storage- oder IndexedDB-Speicherung,
- Wiederherstellung eines Entwurfs nach Neuladen oder Abmelden,
- M4-Publikation oder Publikationsarchivierung,
- M5-, O4- oder O5-Instanziierung,
- Aufgaben- oder Fallmutation,
- Workflowausführung,
- Trigger-, Scheduler-, Benachrichtigungs- oder Eskalationswirkung,
- Schnittstellen- oder sonstige Außenwirkung,
- Verbindung zu allgemeinen Legacy-Prozessen,
- automatische Verantwortlichen- oder Personenauswahl,
- grafische Verzweigung,
- produktive PostgreSQL-Freigabe sowie
- Commit, Push, Release, Deploy oder VPS-Aktualisierung.

## 15. Abnahmekriterien

Der O8-Minimalvertrag ist technisch erfüllt, wenn:

1. Vertragsversion, Modell, Modus und Quelle unveränderlich sind,
2. genau sechs eindeutige Rechte definiert und keine Rollenrechte automatisch vergeben sind,
3. alle elf Runtime-Gates geschlossen bleiben,
4. der Katalog ohne serverseitige Typfreigabe leer ist,
5. Katalog und Draft ausschließlich exakt bekannte Plain-DTOs akzeptieren,
6. Proxy, fremder Prototyp, Accessor, Symbol, Arrayloch und unbekanntes Feld fail-closed abgewiesen werden,
7. Onboarding und Offboarding getrennte harte Verantwortungslisten verwenden,
8. keine Personenkennung im Draftvertrag existiert,
9. aus zwei bis 30 Schritten ausschließlich eine lineare Knoten-/Kantenfolge entsteht,
10. genau ein verpflichtender letzter Abschlussschritt verlangt wird,
11. sicher darstellbare Unvollständigkeit strukturierte Blocker erzeugt,
12. der kanonische Fingerabdruck keine Layoutdaten enthält,
13. alle Outputs rekursiv eingefroren sind,
14. Offboarding-Inhalte flüchtig bleiben und nicht protokolliert oder gespeichert werden und
15. Legacy-Prozesse, Publikationen, Instanzen, Aufgaben und Außenwirkungen unverändert bleiben.

## 16. Prüf- und Browserstand

Der gezielte Contracttest `test/personnel-lifecycle-editor-contract.test.js` prüft 15 Szenarien. Abgedeckt sind Konstanten, Rechte, leere Rollengrants, geschlossene Gates, servergefilterter Katalog, Onboarding und Offboarding, kanonischer Fingerabdruck, Plain-DTO-Grenzen, Array- und Prototypschutz, reservierte Kennungen, workflowtypspezifische Verantwortungen, strukturierte Blocker, Schritt-/Abschlussinvarianten, Limits, Normalisierung und rekursives Einfrieren. Ergänzend prüfen `test/personnel-lifecycle-editor-api.test.js` die persönliche, fachrechtliche und datensparsame HTTP-Grenze sowie `test/personnel-lifecycle-editor-ui.test.js` den flüchtigen Dialog, die lineare Bedienung, Quellwechsel, Race-Abwehr, vollständige Bereinigung, O8-only-Abgrenzung und das responsive Layout.

Prüfstand am 3. August 2026:

- **43 von 43 O8-spezifischen Tests erfolgreich**: 15 Contract-, 18 API- und 10 UI-Tests,
- **57 von 57 Tests einschließlich Portal-Fundament erfolgreich**,
- **31 von 31 M5-/O4- bis O7-UI-Regressionstests erfolgreich**,
- **309 von 309 Tests der gesamten Personal-Lifecycle-Kette erfolgreich** und
- Kopplungsaudit erfolgreich: **1015 von 1015 Statements erfasst, 0 Verstöße**.

Die allgemeine Vollregression ist ebenfalls abgeschlossen: **1972 Tests gesamt, 1932 erfolgreich, 40 bewusst übersprungen und 0 fehlgeschlagen**; Laufzeit **311284 ms**.

Die interaktive Browserabnahme bleibt ausdrücklich offen. Desktopdarstellung, Tastaturbedienung, Fokusführung, Rechtewechsel während eines Requests sowie das Layout bei 700 und 320 Pixeln sind erst dann browserabgenommen, wenn sie in einer tatsächlich verbundenen Chrome-Sitzung manuell geprüft wurden. Contract-, DOM- und CSS-Tests ersetzen diese Abnahme nicht.

## 17. Voraussetzungen für einen späteren persistenten Editor

Eine spätere Freigabe zum Speichern muss mindestens separat entscheiden und testen:

- eine eindeutige Lifecycle-Draftklassifikation vor der ersten Publikation,
- einen eigenen Rechte-, Scope-, Revisions- und Konfliktvertrag,
- eine additive und verlustfreie Migration mit Importprüfung,
- die geschützte Speicherung vertraulicher Offboarding-Inhalte,
- serverseitige Validierung derselben linearen Semantik,
- append-only Review-, Publikations- und Archivierungsbelege,
- die Unveränderbarkeit vorhandener Publikationen und Instanzen,
- die Trennung von Workflowdefinition und späterer Einzelzuweisung,
- datensparsames Audit ohne Draftfreitexte und
- Provider-, Sicherheits-, Browser- und Vollregression.

Bis zu dieser ausdrücklichen Freigabe ist `memory_only` verbindlich. Ein Validierungsergebnis oder Fingerabdruck darf nicht als gespeicherter Entwurf, Review, Publikation oder Startauftrag umgedeutet werden.
