# Personalmodul – O1 Rechte-, Datenklassifikations- und Fallvertrag v0.1

Stand: 2. August 2026

Status: verbindlicher, im Quellstand isoliert umgesetzter O1-Vertrag; keine Produktiv-, Release-, Migrations-, API-, UI- oder Aktivierungsfreigabe

Fachliche Grundlage: `PERSONALMODUL-ONBOARDING-OFFBOARDING-FACHKONZEPT-v1.0.md`

Produktgrenze: Das Installationsmerkmal `personnelLifecycle` bleibt deaktiviert. O1 führt keine Onboarding- oder Offboarding-Fälle, Instanzen, Aufgaben, Profilprojektionen, Datenbankobjekte, Benachrichtigungen oder Außenwirkungen ein.

## 1. Ziel und Einordnung

O1 konkretisiert ausschließlich den technischen Schutzvertrag vor jeder späteren Speicherung oder Ausführung. Der Block entscheidet:

- eigene aktionsbezogene Fachrechte,
- berechtigbare Rollenebenen ohne automatische Datenfreigabe,
- fünf Datenklassifikationen,
- Onboarding-, Offboarding- und Beschäftigungszustände,
- positive Empfängerprojektionen,
- die getrennte vertrauliche Zugriffsspur,
- additive technische Zielentitäten und
- fail-closed Laufzeitgrenzen.

Die Umsetzung besteht aus einer nicht in Server, API oder Persistenz verdrahteten CommonJS-Vertragsschicht und automatisierten Vertrags-/Negativtests. Die bestehenden R1-, M4-, M5-, M6- und M7-Verträge werden nicht verändert.

O1 ist kein Vorabteil von O2. O2 beginnt erst nach einem eigenen ausdrücklichen Startauftrag und darf die hier nur beschriebenen Zielentitäten dann additiv und migrationsgesichert umsetzen.

## 2. Verbindliche O1-Artefakte

| Artefakt | Zweck | Laufzeitwirkung in O1 |
|---|---|---|
| `lib/personnel-lifecycle-case-contract.js` | Rechte-IDs, Schutzklassen, Zustände, Transitionen, Feldlisten, Zielentitäten und geschlossene Gates | keine Verdrahtung |
| `lib/personnel-lifecycle-case-access.js` | fail-closed Auswertung synthetischer beziehungsweise später serverseitig normalisierter Zugriffssnapshots | keine Route und keine Mutation |
| `test/personnel-lifecycle-case-contract.test.js` | Struktur-, Zustands-, Projektions- und Zielentitätstests | Test ausschließlich gegen den isolierten Vertrag |
| `test/personnel-lifecycle-case-access-policy.test.js` | Rollen-, Rechteketten-, Scope-, Sichtbarkeits- und Negativtests | Test ausschließlich gegen den isolierten Vertrag |
| dieses Dokument | verbindliche technische O1-Abgrenzung | keine Produktaktivierung |

Die neuen Rechte werden in O1 nicht in `server.js`, Rollenstandards, Rechteverwaltung, Datenbank oder UI registriert. Damit kann O1 weder versehentlich zugewiesen noch produktiv genutzt werden.

## 3. PL+-Ebene und benannte Akteure

Für O1 gilt die im Fachkonzept freigegebene Bedeutung:

- PL entspricht der Rolle `hr`.
- Die berechtigbare zentrale PL+-Ebene umfasst `hr`, `admin`, `it_admin` und `developer`.
- Keine dieser Rollen erhält allein durch ihren Rollennamen ein Onboarding-, Offboarding-, HR-, Audit- oder Paketrecht.
- Jedes Recht muss in einem späteren Block ausdrücklich und einzeln zugewiesen werden.
- Ein benanntes Developer- oder IT-Admin-Konto kann mit denselben ausdrücklichen Fachrechten dieselben zentralen Fachaktionen wie PL ausführen.
- Eine technische Rolle, ein Delegationsrecht oder ein allgemeines Adminrecht ersetzt niemals ein vertrauliches Fachrecht.

Fachentscheidungen sind nur für aktive, benannte interaktive Konten mit stabiler Akteur-ID vorgesehen. Mitarbeiter- und benannte Organisationskonten sind technisch berechtigbar. Lokaler Systemzugang, Servicekonten, geteilte Konten, inaktive Konten und Sitzungen ohne eindeutige Akteur-ID bleiben auch bei injizierten Rechtewerten vollständig geschlossen.

Dieselbe fachberechtigte Person darf ein Offboarding vorbereiten und zur Kommunikation freigeben, wenn beide kleinen Rechte ausdrücklich wirksam sind. O1 führt kein verpflichtendes Vier-Augen-Prinzip und keine implizite Selbstfreigabe ein: Jeder Übergang bleibt eine eigene bewusste Aktion mit eigener Rechteprüfung und später eigenem Auditereignis.

## 4. Fachrechte

### 4.1 Onboarding

| Recht | Technische ID | Abhängigkeit |
|---|---|---|
| lesen | `personnel:lifecycle:onboarding:read` | keine andere Lifecycle-Berechtigung wird abgeleitet |
| vorbereiten | `personnel:lifecycle:onboarding:prepare` | Onboarding lesen |
| freigeben | `personnel:lifecycle:onboarding:approve` | Onboarding lesen |
| ausführen | `personnel:lifecycle:onboarding:execute` | Onboarding lesen; Laufzeit erst ab O4 |
| abschließen oder abbrechen | `personnel:lifecycle:onboarding:close` | Onboarding lesen |

### 4.2 Vertrauliches Offboarding

| Recht | Technische ID | Abhängigkeit |
|---|---|---|
| streng vertraulich lesen | `personnel:lifecycle:offboarding:confidential:read` | eigenständiges Grundrecht |
| intern vorbereiten | `personnel:lifecycle:offboarding:prepare` | streng vertraulich lesen |
| Kommunikation freigeben | `personnel:lifecycle:offboarding:communication:release` | streng vertraulich lesen |
| persönliche Information bestätigen | `personnel:lifecycle:offboarding:information:confirm` | streng vertraulich lesen |
| operativ ausführen | `personnel:lifecycle:offboarding:execute` | streng vertraulich lesen; Laufzeit erst ab O5 |
| abschließen oder abbrechen | `personnel:lifecycle:offboarding:close` | streng vertraulich lesen |

### 4.3 Daten, Pakete, Aufgaben und Audit

| Recht | Technische ID | Grenze |
|---|---|---|
| personenbezogen eingeschränkt lesen | `personnel:lifecycle:personal:read` | benötigt zusätzlich das Leserecht des konkreten Falltyps |
| PL-vertraulich lesen | `personnel:lifecycle:hr-confidential:read` | benötigt zusätzlich das Leserecht des konkreten Falltyps |
| Pakete lesen | `personnel:lifecycle:packages:read` | kein Fallzugriff |
| Pakete bearbeiten | `personnel:lifecycle:packages:write` | setzt Paketlesen voraus |
| Pakete veröffentlichen | `personnel:lifecycle:packages:publish` | setzt Paketlesen und Paketbearbeitung voraus |
| Einzelzuweisungen bearbeiten | `personnel:lifecycle:assignments:write` | setzt mindestens einen lesbaren Falltyp voraus |
| Ausnahmen freigeben | `personnel:lifecycle:exceptions:approve` | setzt mindestens einen lesbaren Falltyp voraus |
| operative Projektionen lesen | `personnel:lifecycle:operational:read` | einzig lokal bereichsdelegierbares Leserecht |
| operative Aufgaben bearbeiten | `personnel:lifecycle:operational:update` | setzt operatives Lesen voraus; Laufzeit nicht in O1 |
| allgemeines Lifecycle-Audit lesen | `personnel:lifecycle:audit:read` | kein Fallzugriff |
| vertrauliche Zugriffsspur lesen | `personnel:lifecycle:audit:confidential:read` | setzt allgemeines Auditrecht voraus |
| operative Rechte delegieren | `personnel:lifecycle:delegate` | erzeugt weder Datenzugriff noch Fallaktion |

`manager` und `department_manager` können ausschließlich `operational:read` und `operational:update` erhalten. Alle anderen O1-Rechte bleiben zentral. Die spätere Delegation wirkt nur in der Schnittmenge aus allgemeinem Portalbereich und je Recht freigegebenem Fachbereich:

- FL (`manager`) ausschließlich an einem vollständig zugewiesenen Standort,
- AL (`department_manager`) ausschließlich an derselben konkreten Standort-/Abteilungskombination,
- niemals standortweit für AL und niemals ohne Genehmigungsidentität.

## 5. Datenklassifikationen

| Technischer Wert | Fachliche Bedeutung | Grundgrenze |
|---|---|---|
| `operational_standard` | freigegebene operative Aufgabe ohne vertraulichen Grund | konkrete Fallberechtigung oder aktive Einzelzuweisung; bei FL/AL zusätzlich Scope-Schnittmenge |
| `personal_restricted` | erforderliche Beschäftigungs- oder Abrechnungsdaten | Fallleserecht plus `personal:read`, ausgenommen minimale einzeln zugewiesene Fachprojektion |
| `hr_confidential` | Vertragsbezug, HR-Vermerk, rechtliche und geschützte Dokumentreferenz | Fallleserecht plus `hr-confidential:read` |
| `offboarding_strict_confidential` | Existenz und Inhalt eines noch nicht offengelegten Offboardings | ausschließlich `offboarding:confidential:read` oder getrenntes vertrauliches Auditrecht für die Auditprojektion |
| `employee_released` | ausdrücklich für den betroffenen Mitarbeiter freigegebene eigene Aufgabe | aktiver persönlicher Portalzugang, identischer Mitarbeiterbezug und ausdrückliche Inhaltsfreigabe; beim Offboarding zusätzlich `Mitarbeiter informiert` |

Ein Recht für eine Klasse öffnet keine andere Klasse. Unbekannte Klassen bleiben geschlossen.

## 6. Zustandsverträge

### 6.1 Onboarding-Fall

| Von | Nach | erforderliches Fachrecht |
|---|---|---|
| kein Fall | `prepared` | `onboarding:prepare` |
| `prepared` | `approved` | `onboarding:approve` |
| `approved` | `active` | `onboarding:execute`; technisch erst O4 |
| `prepared`, `approved` oder `active` | `cancelled` | `onboarding:close` |
| `active` | `completed` | `onboarding:close` |

`completed` und `cancelled` sind terminal. Ein Neustart ist ein neuer Fall mit Vorgängerbezug und niemals eine Wiederöffnung.

### 6.2 Offboarding-Fall

| Von | Nach | erforderliches Fachrecht |
|---|---|---|
| kein Fall | `internally_prepared` | `offboarding:prepare` |
| `internally_prepared` | `communication_released` | `offboarding:communication:release` |
| `communication_released` | `employee_informed` | `offboarding:information:confirm` |
| `employee_informed` | `active` | `offboarding:execute`; technisch erst O5 |
| `internally_prepared` | `cancelled` | `offboarding:prepare` und `offboarding:close` |
| `communication_released`, `employee_informed` oder `active` | `cancelled` | `offboarding:communication:release` und `offboarding:close` |
| `active` | `completed` | `offboarding:close` |

`completed` und `cancelled` sind terminal. Vor `communication_released` existiert keine operative Projektion. Vor `employee_informed` existiert keine Mitarbeiterprojektion.

### 6.3 Geschützter Beschäftigungsstatus `Austritt läuft`

Der Beschäftigungsstatus ist vom Offboarding-Fall getrennt:

| Von | Nach | Bedeutung und Recht |
|---|---|---|
| `employment_active` | `exit_in_progress` | geschützter Status `Austritt läuft`; spätere atomare O5-Aktion mit `offboarding:communication:release` |
| `exit_in_progress` | `employment_active` | Austritt zurückgenommen; additives Wiederherstellungsereignis mit `offboarding:communication:release` und `offboarding:close` |
| `exit_in_progress` | `employment_ended` | kontrollierter Abschluss mit `offboarding:close` |

`employment_ended` ist terminal. Eine Wiedereinstellung erzeugt eine neue Beschäftigungsepisode. O1 ändert keine bestehende Mitarbeiter-Aktivspalte und speichert diesen Status noch nicht.

## 7. Positive Empfängerprojektionen

Jede Projektion besitzt eine feste Empfängerklasse, Schutzklasse und Positivliste. Ein späterer Server muss Empfängerklasse und Zuweisung selbst aus vertrauenswürdigen Daten ableiten; ein Client darf sie nicht wählen.

| Projektion / Empfängerklasse | Zulässige Felder |
|---|---|
| `employee_task` / Mitarbeiter | `orderId`, `title`, `instructions`, `dueAt`, `status`, `evidenceStatus` |
| `leadership_task` / FL oder AL | `orderId`, `displayName`, `locationId`, `departmentId`, `title`, `dueAt`, `status` |
| `it_security_task` / IT oder Security | `orderId`, `displayName`, `businessIdentifier`, `targetSystem`, `action`, `executeAt`, `status` |
| `asset_task` / Arbeitsmittelverantwortung | `orderId`, `displayName`, `locationId`, `assetIdentifier`, `action`, `dueAt`, `status` |
| `training_task` / Trainer oder Prüfer | `orderId`, `displayName`, `locationId`, `departmentId`, `module`, `dueAt`, `evidenceStatus`, `status` |
| `payroll_task` / Lohnverrechnung | `orderId`, `employeeNumber`, `displayName`, `payrollAction`, `effectiveDate`, `dueAt`, `status` |
| `hr_case` / fallberechtigte PL+-Person | `caseId`, `caseType`, `employmentEpisodeId`, `employeeNumber`, `state`, `scopeType`, `locationId`, `departmentId`, `createdAt`, `updatedAt` |
| `hr_confidential` / ausdrücklich HR-vertraulich Berechtigte | `caseId`, `employeeNumber`, `contractReference`, `employmentType`, `weeklyMinutes`, `hrNote`, `legalReferenceIds`, `documentReferenceIds` |
| `offboarding_confidential` / streng vertraulich Berechtigte | `caseId`, `employeeNumber`, `plannedExitAt`, `lastWorkingDay`, `legalExitDate`, `accessBlockAt`, `exitReasonCode`, `exitReasonNote`, `communicationReleaseAt`, `employeeInformedAt`, `hrNote`, `documentReferenceIds` |
| `confidential_audit` / vertrauliche Auditberechtigte | `accessEventId`, `caseId`, `actorId`, `action`, `occurredAt`, `result`, `purposeCode` |

Zu breite Sammelobjekte wie `employmentFields`, `payrollFields`, vollständige Scope-Snapshots oder untypisierte Paketlisten sind in O1 bewusst nicht ausgabefähig. Strukturierte Paket- und Profilprojektionen benötigen in O2 beziehungsweise O3 einen eigenen engen Feldvertrag.

Die isolierte Projektionsfunktion:

- kopiert ausschließlich eigene Datenfelder der Positivliste,
- erzeugt keine Platzhalter für fehlende Felder,
- lehnt unbekannte Projektionen und strukturell unsichere Werte ab,
- kopiert verschachtelte erlaubte Referenzlisten defensiv und friert die Ausgabe ein,
- gibt ohne erfolgreiche Rechte-, Empfänger-, Zustands- und gegebenenfalls Scope-Prüfung `null` zurück.

## 8. Additive technische Zielentitäten

O1 legt folgende Zielrepräsentation verbindlich fest, erzeugt aber noch keine Tabelle und keine Migration:

| Logische Entität | Ziel-Store für O2 oder später | Unveränderlicher Kern |
|---|---|---|
| `EmploymentEpisode` | `personnel_employment_episodes` | ID, Mitarbeiterbezug, Episodennummer, Vorgängerepisode |
| `PersonnelLifecycleCase` | `personnel_lifecycle_cases` | ID, Falltyp, Beschäftigungsepisode, Vorgängerfall |
| `PersonnelLifecycleReferenceDates` | `personnel_lifecycle_case_reference_dates` | ID, Fall, Revision, Vorgängerrevision |
| `PersonnelLifecyclePackageBinding` | `personnel_lifecycle_case_package_bindings` | ID, Fall, Veröffentlichung, Versionsnummer, Scope-Beleg |
| `PersonnelLifecycleAssignment` | `personnel_lifecycle_case_assignments` | ID, Fall, Schrittbezug, benannter Empfänger, Vorgängerzuweisung |
| `PersonnelLifecycleCaseEvent` | `personnel_lifecycle_case_events` | ID, Fall, Sequenz, Ereignistyp, Vorgängerbeleg |
| `PersonnelLifecycleConfidentialAccessEvent` | `personnel_lifecycle_confidential_access_events` | ID, Fall, Akteur, Aktion, Zeitpunkt, Vorgängerbeleg |

Alle Entitäten sind additive Sidecars. Zustandswechsel, Terminänderungen, Umbesetzungen, Abbrüche und Korrekturen werden später durch append-only Ereignisse belegt. Bestehende M4-/M5-Belege und Mitarbeiterstammdaten werden nicht überschrieben oder umgedeutet.

Offboarding-Inhalte dürfen nicht in den heutigen Klartextpfad aus M4-Entwurf, Revisionssnapshot oder allgemeinen Auditfreitexten gelangen. Der genaue verschlüsselte Speichervertrag, DDL, Integritätstrigger und Migrationspfad sind O2 beziehungsweise O5 vorbehalten.

## 9. Vertrauliche Zugriffsspur

Die Zugriffsspur bleibt vom allgemeinen Audit getrennt. Ihre positive Projektion enthält ausschließlich Zugriff-ID, Fall-ID, Akteur, Aktion, Zeitpunkt, Ergebnis und Zweckcode. Austrittsgrund, HR-Vermerk, Dokumentinhalt, private Kontaktdaten, Suchtext und kryptografischer Rohbeleg sind ausgeschlossen.

Lesen benötigt gleichzeitig:

1. `personnel:lifecycle:audit:read` und
2. `personnel:lifecycle:audit:confidential:read`.

Auch ein Developer- oder IT-Admin-Konto darf sie nur mit beiden ausdrücklich zugewiesenen Fachrechten lesen. Das Lesen der Zugriffsspur muss später selbst als geschütztes Zugriffsereignis protokolliert werden. Die kundenspezifische Aufbewahrungsdauer bleibt Aktivierungsvoraussetzung; O1 setzt keinen Standardwert und speichert noch kein Ereignis.

## 10. Fail-closed Laufzeitgates

Der Quellvertrag fixiert für O1 sämtliche folgenden Gates auf `false`:

- `productiveActivation`,
- `schemaMigration`,
- `persistence`,
- `apiRoutes`,
- `caseCreation`,
- `workflowInstantiation`,
- `taskCreation`,
- `profileProjection`,
- `notifications`,
- `externalActions`.

Die Vertragsprüfung schlägt fehl, sobald ein O1-Gate geöffnet oder eine O1-Zielentität als persistiert markiert würde. Selbst ein synthetisch vollständig berechtigter Developer erhält keine Erzeugungs-, Start-, Persistenz- oder Außenwirkungsfunktion.

## 11. Sicherheits- und Negativfälle

O1 testet mindestens:

- Rollenname ohne Fachrecht öffnet nichts,
- Developer und IT-Admin funktionieren nur mit ausdrücklichen kleinen Rechten,
- Aktionsrecht ohne erforderliches Leserecht bleibt unwirksam,
- Abbruch nach Kommunikationsfreigabe benötigt Freigabe- und Abschlussrecht gemeinsam,
- lokaler Systemzugang, Servicekonto, geteiltes oder inaktives Konto trifft keine Fachentscheidung,
- Delegations- und Auditrechte erzeugen keinen Fallzugriff,
- FL und AL benötigen die exakte Portal-/Fachscope-Schnittmenge,
- operative Offboarding-Projektionen bleiben vor Freigabe geschlossen,
- Mitarbeiterprojektionen bleiben vor persönlicher Information geschlossen,
- terminale Fälle und beendete Beschäftigungsepisoden werden nicht wieder geöffnet,
- Empfängerklassen können nicht gegeneinander ausgetauscht werden,
- nicht erlaubte Felder und vertrauliche Nebenwerte werden nicht projiziert,
- vertrauliche Auditprojektion benötigt beide Audit-Fachrechte und
- alle O1-Laufzeitgates bleiben geschlossen.

## 12. Bewusste Abgrenzung zu O2

O1 enthält ausdrücklich nicht:

- DDL, Migration oder Schemaerkennung,
- Rechte- oder Rollenregistrierung in der produktiven Anwendung,
- Repository, Katalog oder SQL-Statements,
- REST-Endpunkte oder UI,
- Beschäftigungsepisoden oder Fälle in der Datenbank,
- Paketauflösung oder Startvorschau,
- M4-/M5-Instanzen oder Aufgaben,
- Profilregister,
- Benachrichtigungen, Fristen, Vertretungen oder Eskalationen,
- Konto-, Geräte-, Schlüssel- oder Integrationsaktionen,
- produktive PostgreSQL-Freigabe.

O2 darf nach eigener Freigabe ausschließlich das additive Fall- und Instanzfundament, die verlustfreie Migration und eine weiterhin startlose read-only Paketauflösung ergänzen. Onboarding bleibt bis O4 und Offboarding bis O5 technisch nicht startbar.

## 13. O1-Abnahmekriterien

O1 ist im lokalen Quellstand fachlich-technisch erfüllt, wenn:

1. alle 23 Fachrechte exakt und eingefroren vorliegen,
2. PL, Admin, IT-Admin und Developer nur ausdrücklich berechtigbar sind,
3. dieselbe berechtigte Person Vorbereitung und Kommunikationsfreigabe getrennt autorisieren kann,
4. fünf Schutzklassen mit fail-closed unbekanntem Wert bestehen,
5. beide Fallautomaten und der getrennte Status `exit_in_progress` vollständig getestet sind,
6. alle terminalen Zustände geschlossen bleiben,
7. zehn Empfängerprojektionen ausschließlich Positivlisten ausgeben,
8. sieben additive Zielentitäten ohne O1-Persistenz festgelegt sind,
9. vertrauliches Audit und allgemeines Audit getrennt bleiben,
10. sämtliche O1-Laufzeitgates `false` sind,
11. die neuen isolierten Tests vollständig grün sind und
12. die bestehende Regression keine unbeabsichtigte Änderung an R1 sowie M4 bis M7 zeigt.

### 13.1 Lokaler Prüfnachweis vom 2. August 2026

Ausgeführt mit Node.js v24.14.0 und serieller Testausführung:

| Prüfumfang | Ergebnis |
|---|---|
| isolierte O1-Vertrags- und Negativtests | 27 Tests, 27 bestanden, 0 Fehler |
| gezielte Regression für Bewerbungen/Preboarding, M4, M5 und M7 | 71 Tests, 71 bestanden, 0 Fehler |
| vollständige Projekttestsuite | 1.747 Tests, 1.707 bestanden, 40 bedingt übersprungen, 0 Fehler |

Die Strukturprüfung bestätigte außerdem sechs ausschließlich neue, unversionierte Arbeitsbaumdateien, keine Änderung an einer bereits verfolgten Datei, keine O1-Verdrahtung in `server.js` oder Persistenz und keine geöffnete Laufzeitgrenze.

Die Erfüllung dieser Kriterien ist keine Commit-, Push-, Release-, VPS- oder O2-Freigabe.
