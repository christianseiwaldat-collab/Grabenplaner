# Personalmodul Onboarding/Offboarding – O7 Fristen, Vertretung, Erinnerungen und Eskalationen v0.1

- Stand: 3. August 2026
- Status: lokaler O7-Minimalvertrag mit read-only Katalog und gesperrter serverseitiger Vorschau; nicht veröffentlicht und nicht produktiv aktiviert
- Vorgänger: `PERSONALMODUL-ONBOARDING-OFFBOARDING-O6-SCHULUNGEN-ARBEITSMITTEL-ZUGAENGE-v0.1.md`
- Konzeptbasis: `PERSONALMODUL-ONBOARDING-OFFBOARDING-FACHKONZEPT-v1.0.md`

## 1. Ergebnis und Blockgrenze

O7 definiert einen providerneutralen, strikt gesperrten Vertrag für genau vier voneinander getrennte Domänen:

1. Fristen,
2. Vertretungen,
3. Erinnerungen und
4. Eskalationen.

Der tatsächlich vorhandene Minimalumfang besteht aus dem JavaScript-Vertrag `lib/personnel-lifecycle-automation-contract.js`, zwei authentisierten read-only Portalrouten und einer read-only Darstellung im Bereich „Personalaufgaben“. Der Vertrag stellt unveränderliche Konstanten sowie reine Funktionen für einen gesperrten Katalog, die Normalisierung einer ausdrücklich versionierten Richtlinie und eine nebenwirkungsfreie Vorschau bereit.

Die Serverintegration filtert den Katalog nach persönlichen Einzelrechten und erzeugt die Vorschau ausschließlich aus bereits serverseitig freigegebenen Onboarding- und Offboarding-Aufgaben. Sie verwendet unverändert die leere Standardregistry. Die aktuell vorhandenen Aufgabenadapter liefern bewusst noch keine Prozessversions-, Referenzart-, Referenztermin- oder Richtlinienbindung. Sichtbare Aufgaben bleiben deshalb `not_configured` und zeigen ihre fehlenden Voraussetzungen als Blocker.

O7 besitzt kein Repository, keine SQLite-Migration, keinen Scheduler und keinen Mutationsendpunkt. Die UI berechnet keine Frist selbst und bietet keine Wirkungsaktion an.

Die Definition von Fristen-, Verwaltungs-, Dispatch-, Trigger- oder Reconcile-Rechten ist eine Vertragsgrenze. Sie aktiviert keine entsprechende Fähigkeit.

## 2. Verbindliche Null-Persistenz und Runtime-Gates

Alle zwölf Runtime-Gates stehen im aktuellen Vertrag unveränderlich auf `false`:

| Gate | Aktueller Wert | Auswirkung |
|---|---:|---|
| `policyPersistence` | `false` | keine Richtlinienpersistenz |
| `deadlinePersistence` | `false` | keine Frist- oder Fälligkeitszeile |
| `referenceDateMutation` | `false` | keine Änderung eines Referenztermins |
| `assignmentMutation` | `false` | keine Änderung einer Zuweisung |
| `scheduler` | `false` | kein Hintergrundlauf und kein Timer |
| `internalNotification` | `false` | keine Portalbenachrichtigung |
| `externalNotification` | `false` | kein externer Versand |
| `calendarMutation` | `false` | kein Kalenderobjekt und keine Kalenderänderung |
| `automaticSubstitution` | `false` | keine automatische Vertretung |
| `automaticEscalation` | `false` | keine automatische Eskalation |
| `outboxDispatch` | `false` | kein Outbox-Auftrag und kein Retry |
| `externalMutation` | `false` | keine sonstige Außenwirkung |

Die Standard-Policy-Registry ist leer. Der Katalog meldet für `deadlinePolicies`, `calendarRules`, `substitutionRules`, `reminderRules`, `escalationRules` und `notificationChannels` jeweils null Datensätze, null aktive Datensätze und `customerConfigured: false`. Alle sichtbaren Domänen sind `blocked`, ihre `configurationCount` ist null und `externalEffectsEnabled` ist `false`.

Eine zur Laufzeit direkt an die reine Vorschaufunktion übergebene Registry ist keine gespeicherte Kundenkonfiguration. Sie lebt nur für diesen Funktionsaufruf. Weder ein erfolgreiches Ergebnis noch ein Blocker oder ein geworfener Vertragsfehler schreibt eine O7-Richtlinien-, Fristen-, Ereignis-, Benachrichtigungs- oder Outbox-Zeile.

Davon getrennt schreiben erfolgreiche Katalog- und Preview-Lesezugriffe einen allgemeinen Zugriffs-Auditbeleg; auch abgewiesene Rechtezugriffe werden über die bestehende Lifecycle-Zugriffskontrolle auditiert. Der erfolgreiche Katalogbeleg enthält nur die sichtbaren Domänen, der Preview-Beleg nur die einbezogenen Quellen. Dieses Access-Audit ist keine O7-Fachpersistenz, kein Fristenbeleg und kein Versandauftrag.

## 3. Fristen- und Kalendervorschau

Die Fristberechnung verwendet ausschließlich den Modus `explicit_versioned_policy_only`. Eine Richtlinie muss unter anderem eine stabile `policyId`, Revision, Fingerabdruck, Quelle, konkrete Prozessversionskennung, Schrittkennung, strukturierte Referenzart, Scope, IANA-Zeitzone, Tagesmodus und alle Kalenderparameter ausdrücklich enthalten.

Referenzarten sind quellgebundene Positivlisten und keine globale Auswahl:

| Quelle | Zulässige Referenzarten |
|---|---|
| Onboarding | `task_activated_at`, `contractual_entry_date`, `first_working_day`, `onboarding_target_date`, `explicit_task_due_date` |
| Offboarding | `task_activated_at`, `planned_exit_date`, `last_working_day`, `legal_exit_date`, `access_block_at`, `explicit_task_due_date` |

Damit existieren insgesamt neun unterschiedliche Referenzarten, aber nicht jede ist für beide Quellen zulässig. Eine Offboarding-Referenz in einer Onboarding-Richtlinie oder umgekehrt wird mit `O7_REFERENCE_INVALID` abgewiesen.

Die Referenzart bezeichnet die fachliche Herkunft des bereits serverseitig aufgelösten Datums. Sie löst dieses Datum nicht selbst auf. Weder Titel noch Freitext, aktuelles Tagesdatum oder eine ähnliche Prozessfassung dürfen eine fehlende strukturierte Referenzart beziehungsweise Prozessversionsbindung ersetzen.

Zulässig sind nur:

- `calendar_days` ohne Arbeitswochentage, Feiertagsliste oder Referenzterminverschiebung sowie
- `working_days` mit ausdrücklich festgelegten Wochentagen, optionaler expliziter Feiertagsliste und `none`, `next_working_day` oder `previous_working_day` als Referenzterminregel.

`explicit_task_due_date` ist eine besondere unveränderliche Referenz. Sie ist ausschließlich mit `calendar_days`, `referenceAdjustment: "none"` und `dueOffsetDays: 0` zulässig. Die serverseitig gebundene explizite Aufgabenfälligkeit darf somit weder auf einen Arbeitstag verschoben noch um einen Offset verändert werden.

Die Vorschau berechnet aus dem übergebenen Referenzdatum und der gebundenen Richtlinienrevision ausschließlich:

- `dueAt`,
- `not_due`, `due_soon`, `due_today`, `overdue` oder `not_configured`,
- eine analytische Erinnerungs- und Eskalationslage sowie
- strukturierte Blocker.

Sie ändert weder den Referenztermin noch die Aufgabe. Der kanonische `asOf`-Zeitstempel wird in der ausdrücklich angegebenen Richtlinienzeitzone auf ein lokales Kalenderdatum projiziert. Eine Richtlinie wird nur verwendet, wenn ID, Revision und SHA-256-Fingerabdruck exakt der Aufgabenbindung entsprechen und Quelle, Prozessversion, Schritt, Referenzart sowie Scope anwendbar sind.

Der Richtlinienfingerabdruck ist ein Integritätsbezug für die Vorschau. Er ist weder Verschlüsselung noch Berechtigung, Freigabe oder dauerhafter Beleg.

## 4. Vertretung bleibt manuelle Klärung

Der einzige zulässige Vertretungsmodus lautet `manual_hr_clarification`. Eine Richtlinie mit einem anderen Modus wird abgewiesen.

Die Vorschau bildet den übergebenen Verantwortungszustand nur wie folgt ab:

| Eingabe | Vorschau |
|---|---|
| `assigned` | `representationState: "manual_only"` |
| `unavailable` | `representationState: "clarification_required"` |
| `unknown` | `representationState: "not_evaluated"` |

Sie sucht keine Ersatzperson, bewertet keine Abwesenheit, liest keine Delegation und übernimmt keine Aufgabe. Insbesondere entsteht aus `clarification_required` keine automatische Zuweisung oder Berechtigung.

## 5. Erinnerungen und Eskalationen sind nur Analysezustände

Der Modus für Erinnerungen und Eskalationen ist jeweils `preview_only`. `notificationChannels` muss im aktuellen Vertrag eine leere Liste sein; bereits ein einzelner angegebener Kanal ist ungültig.

Eine Erinnerung kann in der Vorschau `preview_due` werden, sobald die berechnete Distanz innerhalb des größten ausdrücklich angegebenen Erinnerungsvorlaufs liegt. Eine Eskalation kann `preview_due` werden, wenn die Aufgabe überfällig ist und die konfigurierte Zahl überfälliger Tage erreicht wurde.

`preview_due` bedeutet ausschließlich, dass eine reine Berechnung diese Lage anzeigt. Es bedeutet insbesondere nicht:

- Kanal oder Empfänger seien freigegeben,
- eine Nachricht sei geplant, gespeichert, versendet oder zugestellt,
- eine Eskalation sei ausgelöst,
- ein Scheduler dürfe handeln oder
- ein späterer Aufruf dürfe die Vorschau als Sendeauftrag wiederverwenden.

Die zurückgegebenen Runtime-Gates bleiben auch bei `preview_due` vollständig geschlossen.

## 6. Sechzehn getrennte Fachrechte

Der Vertrag definiert exakt vier Rechte je Domäne, insgesamt 16 eindeutige Rechte:

| Domäne | Lesen | Verwalten | Fachaktion | Abgleich |
|---|---|---|---|---|
| Fristen | `personnel:lifecycle:automation:deadlines:read` | `personnel:lifecycle:automation:deadlines:manage` | `personnel:lifecycle:automation:deadlines:recalculate` | `personnel:lifecycle:automation:deadlines:reconcile` |
| Vertretungen | `personnel:lifecycle:automation:substitutions:read` | `personnel:lifecycle:automation:substitutions:manage` | `personnel:lifecycle:automation:substitutions:apply` | `personnel:lifecycle:automation:substitutions:reconcile` |
| Erinnerungen | `personnel:lifecycle:automation:reminders:read` | `personnel:lifecycle:automation:reminders:manage` | `personnel:lifecycle:automation:reminders:dispatch` | `personnel:lifecycle:automation:reminders:reconcile` |
| Eskalationen | `personnel:lifecycle:automation:escalations:read` | `personnel:lifecycle:automation:escalations:manage` | `personnel:lifecycle:automation:escalations:trigger` | `personnel:lifecycle:automation:escalations:reconcile` |

`PERSONNEL_LIFECYCLE_AUTOMATION_ROLE_GRANTS` ist tatsächlich leer. PL, Admin, IT-Admin, Developer, FL, AL oder ein anderer Rollenname erhält daher kein O7-Recht automatisch. Technische Administrationsrechte ersetzen die O7-Fachrechte nicht.

Der authentisierte Katalogzugriff ist ausschließlich für ein benanntes persönliches Mitarbeiterkonto im zentralen Personalbereich und mit mindestens einem der vier O7-Leserechte zulässig. Der Server liefert nur die Domänen, deren jeweiliges Leserecht die aktuelle Sitzung besitzt. Die persönliche Preview-Route verlangt serverseitig alle vier O7-Leserechte sowie `personnel:lifecycle:operational:read`; Aufgaben werden zusätzlich nur aus den Quellen einbezogen, für die der aktuelle Lifecycle-Zugriff das entsprechende Onboarding- beziehungsweise vertrauliche Offboarding-Leserecht bestätigt. Die UI fordert die Preview nur an, wenn außerdem mindestens eines dieser beiden Quellenrechte vorhanden ist. Zuweisungs- und Organisationsscope werden weiterhin von den bestehenden Aufgabenservices serverseitig durchgesetzt.

Die übrigen zwölf Verwaltungs-, Fachaktions- und Abgleichrechte besitzen in O7 keinen Endpunkt und keine UI-Aktion. Sie reservieren ausschließlich eine spätere, erneut freizugebende Rechte- und API-Grenze.

## 7. Eingabe-, Blocker- und Fehlervertrag

Der Vertrag akzeptiert ausschließlich gewöhnliche Datenobjekte mit exakt bekannten eigenen Feldern und vollständig materialisierte, begrenzte Arrays. Proxies, Getter, Setter, Symbole, unbekannte oder dynamische Felder, Array-Lücken, unzulässige Duplikate und Werte außerhalb der Grenzen werden fail-closed verworfen.

Strukturell oder semantisch ungültige Eingaben werfen einen `TypeError` mit einem O7-Fehlercode. Der aktuelle Vertrag unterscheidet unter anderem:

- `O7_RECORD_INVALID`, `O7_FIELDS_INVALID` und `O7_VALUE_INVALID`,
- `O7_SCOPE_INVALID`, `O7_SOURCE_INVALID`, `O7_REFERENCE_INVALID` und `O7_DOMAIN_INVALID`,
- `O7_DATE_INVALID`, `O7_TIMESTAMP_INVALID`, `O7_TIMEZONE_INVALID` und `O7_CALENDAR_INVALID`,
- `O7_REPRESENTATION_INVALID`, `O7_REGISTRY_INVALID` und `O7_TASKS_INVALID`.

Gültig strukturierte, aber fachlich nicht berechenbare Aufgaben werden nicht als Erfolg ausgegeben. Sie erhalten `dueState: "not_configured"`, gesperrte Erinnerungs- und Eskalationszustände sowie konkrete Blocker. Dazu gehören insbesondere:

- fehlende, unbekannte, veraltete, inaktive oder nicht anwendbare Richtlinienbindung,
- fehlende Prozessversionskennung,
- fehlende Referenzart,
- fehlendes Referenzdatum und
- ein nicht bearbeitbarer Aufgabenstatus.

Nur `pending` und `active` sind für eine Berechnung fachlich bearbeitbar. `completed` und `cancelled` bleiben blockiert. Doppelte Aufgaben mit identischer Kombination aus Quelle, Run und Schritt werden abgewiesen.

Der gesperrte Katalog weist zusätzlich ausdrücklich auf eine leere Policy-Registry, fehlende Kalenderregeln, nicht freigegebene Benachrichtigungskanäle und die fehlende Außenwirkungsfreigabe hin.

## 8. Datensparsame Projektionsgrenze

Eine O7-Aufgabenprojektion enthält nur:

- `onboarding` oder `offboarding` als Quelle,
- opake Run-, Prozessversions- und Schrittkennungen,
- einen begrenzten Aufgabentitel,
- Aufgabenstatus und minimalen Scope,
- eine der neun strukturierten Referenzarten,
- optionales Referenzdatum,
- einen abstrakten Verantwortungszustand sowie
- optional eine revisions- und fingerprintgebundene Richtlinienreferenz.

Mitarbeitername, Personalnummer, Fall-ID, Austrittsgrund, vertraulicher Vermerk, Dokumentreferenz, Privatkontakt, Empfängeradresse und Nachrichtentext sind keine O7-Eingabefelder. Das Ergebnis ergänzt nur berechnete Zustände, Fälligkeit und Blockercodes.

Der Vertrag redigiert einen übergebenen Aufgabentitel jedoch nicht inhaltlich; er begrenzt ihn lediglich formal. Ein späterer Controller muss deshalb einen neutralen, serverseitig erzeugten Titel und opake Kennungen verwenden. Client-Freitext oder vertrauliche O5-Inhalte dürfen nicht in die Vorschau gelangen. Dasselbe gilt für Logs, URLs und künftige Benachrichtigungsprojektionen.

Beide read-only Routen setzen `Cache-Control: no-store` und `Pragma: no-cache`, entfernen den ETag und liefern ausschließlich JSON. Die Browserlogik akzeptiert nur exakt bekannte Felder, Positivlisten, den unveränderten Fail-closed-Gate-Satz, konsistente Summen und bekannte Zustände. Bei Identitäts-, Rechte- oder Scopewechsel verwirft sie zwischengespeicherten O7-Zustand; ein Request-Token verhindert die Übernahme veralteter Antworten. Alle sichtbaren Texte werden vor dem Einfügen in Markup escaped. Diese Codegrenzen ersetzen dennoch keine interaktive Browserabnahme.

## 9. Bestehende Benachrichtigungs- und Outbox-Tabellen sind keine O7-Runtime

Die produktiv vorhandene Tabelle `portal_notifications` ist eine allgemeine interne Anzeigeprojektion mit Klartextfeldern für Titel, Text, Ziel und Fachbezug. O7 liest oder schreibt diese Tabelle nicht. `internalNotification: false` verbietet auch einen scheinbar harmlosen Platzhalter oder eine nur als ungelesen gespeicherte Erinnerung.

Die produktiv vorhandene Tabelle `outbound_notification_jobs` besitzt zwar Dedupe-, Status-, Versuch-, Fehler- und Retentionsfelder. Sie ist dennoch keine O7-Outbox. Der O7-Vertrag importiert weder ihr Repository noch ihren Dispatcher, erzeugt keinen Job und führt keinen Retry aus. `externalNotification`, `outboxDispatch` und `externalMutation` bleiben `false`.

Bestehende Portal- oder Outbox-Zeilen dürfen nicht als Richtlinienregistry, Fristenquelle, Eskalationsbeleg oder Zustellnachweis für O7 interpretiert werden. Umgekehrt darf eine O7-Vorschau keine bestehende Nachricht reaktivieren, als gelesen markieren, stornieren oder umplanen.

## 10. Bestehende Delegations- und Kalendermechanismen sind keine O7-Runtime

`approval_delegations` ist eine vorhandene, standort- und datumsbezogene Delegation für bestehende Genehmigungswege. Diese Tabelle ist keine O7-Vertretungsregistry. O7 liest sie nicht, schreibt sie nicht und leitet aus ihr keine Zuständigkeit ab. Die abstrakten O7-Zustände `assigned`, `unavailable` und `unknown` werden ausschließlich als bereits serverseitig vertrauenswürdig aufgelöste Eingaben angenommen.

Auch bestehende Planungs- und Kalendermechanismen bleiben getrennt. O7 verwendet weder `global_day_blocks`, den österreichischen Feiertagskatalog, Öffnungszeiten, Dienstplanung, Abwesenheiten noch andere Kalenderquellen. Die reine Vorschau rechnet nur mit den in der ausdrücklich gebundenen Richtlinie übergebenen Wochentagen und Feiertagsdaten. Sie erzeugt oder verändert kein Kalenderobjekt.

Damit sind vorhandene Delegationen, Feiertage und Tagessperren weder stillschweigende Defaults noch Fallbacks. Eine spätere Übernahme bräuchte einen eigenen versionierten Herkunfts-, Scope-, Aktualitäts- und Konfliktvertrag.

## 11. O5 und O6 bleiben unverändert

O7 verändert keinen O5-Fall, keinen der sechs O5-Pflichtaufträge, keine operative Zuweisung und keinen O5-Zustandsübergang. Insbesondere erzeugt die interne Offboarding-Vorbereitung weiterhin null Aufgabenanzeigen, Benachrichtigungen, Erinnerungen, Eskalationen und Außenwirkungen. Eine O7-Vorschau darf die O5-Kommunikationsfreigabe, Information, Aktivierung oder den Abschluss weder ersetzen noch vorwegnehmen.

O6 bleibt ebenfalls strikt getrennt. Ein O6-Preflight, ein Zielsystem, eine Schnittstellenaktion oder der allgemeine Wert `managed_accesses` ist kein O7-Benachrichtigungskanal und keine Freigabe für eine Erinnerung oder Eskalation.

## 12. Ausdrücklich nicht enthalten

- persistente Richtlinien-, Kalender-, Fristen-, Vertretungs-, Erinnerungs- oder Eskalationsdaten,
- SQLite-Tabellen, Migrationen, Import-Inspector, Repositories oder Statements für O7,
- Mutationsendpunkte für Manage, Recalculate, Apply, Dispatch, Trigger oder Reconcile; enthalten sind nur zwei authentisierte read-only Portalrouten für Katalog und Vorschau,
- Scheduler, Timer, Queue, Retry, Outbox, Portalnachricht oder O7-Fachbeleg; das allgemeine Zugriffs-Audit bleibt davon getrennt,
- E-Mail, SMS, WhatsApp, Push, Webhook, Kalenderdatei oder externe API,
- automatische Empfänger-, Vertreter-, Termin-, Scope- oder Eskalationsentscheidung,
- Änderung von Aufgabe, Referenzdatum, Zuweisung, Fall, Episode oder Workflowstatus,
- Verwendung bestehender `portal_notifications`, `outbound_notification_jobs`, `approval_delegations` oder Kalenderdaten als O7-Runtime,
- produktive PostgreSQL-Migration oder Provideraktivierung,
- Bestandteile von O8,
- Bestandteile der parallel entwickelten Verkaufsverwaltung sowie
- Commit, Push, Release, Deploy oder VPS-Aktualisierung.

## 13. Voraussetzungen eines späteren Runtime-Blocks

Eine spätere Aktivierung benötigt einen neuen ausdrücklichen, überprüfbaren Ausbau. Vor jeglicher Persistenz oder Wirkung müssten mindestens festgelegt und abgenommen sein:

1. fachlicher Eigentümer und kundenspezifische, versionierte Richtlinienfreigabe,
2. Rechtsgrundlage, Zweckbindung, Datenminimierung und Aufbewahrung,
3. vertrauenswürdige Herkunft und Aktualität von Referenzterminen und Kalenderregeln,
4. persönliche Empfänger- und Vertretungsauflösung mit Live-Rechte- und Scopeprüfung,
5. eindeutige Idempotenz-, Zustands-, Abbruch-, Wiederholungs- und Konfliktregeln,
6. getrennte, unveränderliche Intent- und gegebenenfalls Zustellversuchsbelege,
7. neutrale Portalprojektionen ohne vertrauliche Fall- oder Mitarbeiterdaten,
8. kontrollierte Zustände für Erfolg, Ablehnung, unbekanntes Ergebnis und manuelle Wiederholung,
9. fail-closed Startup-, Import-, Schema- und Zeileninspektion sowie
10. vollständige SQLite- und gegebenenfalls PostgreSQL-Verträge.

Bis dahin ist sichere Null-Persistenz verbindlich: Bei Vorschau, fehlender Registry, fehlender eindeutiger Berechtigung, unklarer Zuständigkeit oder geschlossenem Wirkungsgate wird weder eine fachliche Intent-Zeile noch ein `pending`-Platzhalter in einer allgemeinen Benachrichtigungstabelle angelegt.

## 14. Abnahmekriterien des aktuellen Minimalvertrags

Der vorhandene O7-Minimalvertrag ist nur dann korrekt beschrieben, wenn mindestens gilt:

- es existieren genau vier Domänen und 16 eindeutige Rechte,
- `ROLE_GRANTS` und die Standard-Policy-Registry sind leer,
- alle zwölf Runtime-Gates bleiben `false`,
- alle sechs Katalogregistries melden null Konfiguration,
- alle Domänen bleiben im Standardkatalog blockiert und ohne Außenwirkung,
- nur explizit versionierte und fingerprintgebundene Richtlinien können im Arbeitsspeicher berechnet werden,
- Prozessversion und eine der für die jeweilige Quelle zulässigen Referenzarten müssen zwischen Richtlinie und Aufgabe exakt gebunden sein,
- `null` bei Prozessversion oder Referenzart blockiert mit `process_version_missing` beziehungsweise `reference_kind_missing`,
- automatische Vertretung ist unzulässig und die Darstellung bleibt manuelle Klärung,
- Erinnerungen und Eskalationen liefern höchstens `preview_due`, nie eine Wirkung,
- Aufgaben außerhalb `pending` und `active` bleiben blockiert,
- ungültige und dynamische Eingaben werden vor fachlicher Auswertung abgewiesen,
- Vorschau und Fehler erzeugen keine O7-Fachpersistenz und keine fachliche Mutation; allgemeine Zugriffs-Audits bleiben davon getrennt,
- bestehende Benachrichtigungs-, Outbox-, Delegations- und Kalendermechanismen bleiben unberührt,
- es existieren genau zwei authentisierte read-only O7-Routen und eine reine Anzeige im Bereich „Personalaufgaben“, aber kein Scheduler und kein Mutationspfad,
- O5, O6, O8, Verkaufsverwaltung und PostgreSQL bleiben außerhalb des Blocks und
- die interaktive Desktop- und 320-Pixel-Browserabnahme bleibt trotz vorhandener API-/UI-Integration ausdrücklich offen.

## 15. Prüf- und Veröffentlichungsstand

Für diese Dokumentation wurde der aktuelle Vertrag vollständig gelesen und direkt geprüft:

- Vertragsversion `o7-v0.1`,
- 16 von 16 Rechtekennungen eindeutig,
- null Einträge in `PERSONNEL_LIFECYCLE_AUTOMATION_ROLE_GRANTS`,
- null Einträge in der Standard-Policy-Registry,
- zwölf von zwölf Runtime-Gates auf `false` und
- 20 von 20 gezielten O7-Contracttests erfolgreich,
- 35 von 35 gezielten O7-Vertrags-, API- und UI-Tests erfolgreich,
- 266 von 266 Personal-Lifecycle-Tests erfolgreich,
- Datenbank-Kopplungsaudit mit null unklassifizierten Dateien und null Phasengrenzverletzungen erfolgreich sowie
- vollständige Regression mit 1.929 Tests: 1.889 erfolgreich, 40 bewusst übersprungen und null fehlgeschlagen.

Die zwei authentisierten read-only Routen und die Anzeige im Bereich „Personalaufgaben“ sind im lokalen Arbeitsstand verdrahtet. Die interaktive Browserabnahme ist ausdrücklich offen: Weder die Desktopdarstellung noch das 320-Pixel-Layout, Rechtewechsel während eines Requests oder die sichtbaren Fehlerzustände wurden in diesem Block interaktiv abgenommen. Vorhandene Validatoren, CSS-Breakpoints und automatisierte Contracttests sind keine bestätigte Browserfreigabe.

Der PostgreSQL-Pfad bleibt für O7 geschlossen. Der Arbeitsstand der parallel entwickelten Verkaufsverwaltung wurde nicht verändert. Dieser lokale Dokumentationsstand enthält keinen Commit, Push, Release, Deploy und keine Produktivaktivierung.
