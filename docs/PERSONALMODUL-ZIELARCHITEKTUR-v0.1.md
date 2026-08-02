# Personalmodul – Zielarchitektur v0.1

Stand: 2. August 2026

Status: verbindlicher Architekturvertrag; Bewerber-, Dokument-, M3-Umwandlungs-, R1-Bereichsrechte-, M4-Workflow-Publikations- und M5-Instanzgrundlage im Quellstand umgesetzt

Produktstatus: in v0.89.0-beta als standardmäßig deaktiviertes Fundament enthalten; keine Freigabe für die produktive Aktivierung; das Installationsmerkmal `personnelLifecycle` bleibt standardmäßig deaktiviert

## 1. Ziel und Abgrenzung

Das Personalmodul erweitert die vorhandene Personalverwaltung des Grabenplaners. Es entsteht kein paralleles Personal- oder Workflow-System. Bestehende Personalstammdaten, geschützte Personalakten, Rollen, Geltungsbereiche, Audit-Protokolle und eigene Prozesse werden weiterverwendet und schrittweise ergänzt.

Die bislang im Quellstand umgesetzte technische Ausbaustufe umfasst:

- den Architekturvertrag,
- das standardmäßig deaktivierte Installationsmerkmal `personnelLifecycle`,
- eine reale Bewerbungsübersicht, read-only Workflow-Instanzen und persönlich bearbeitbare aktive Personalaufgaben innerhalb der bestehenden Personalverwaltung,
- getrennte SQLite-Entitäten für Bewerber, Bewerbungen, Dokumentmetadaten, Dokumentversionen und eine append-only Historie,
- einen additiven, unveränderbaren Umwandlungsnachweis zwischen Bewerber, Bewerbung und Mitarbeiter,
- verschlüsselte Fachpayloads und einen providerneutralen Repository-/Service-Zuschnitt,
- sieben aktionsbezogene Bewerbungsrechte mit klarer Trennung von PL und PL+,
- rechtsspezifische, von PL+ genehmigte Standort-/Abteilungsbereiche als Schnittmenge mit den allgemeinen Portalbereichen,
- serverseitige, datensparsame Bewerberprojektionen und Objektprüfungen für PL, FL und AL,
- eine fail-closed API für Bewerber, Bewerbungen und die kontrollierte Einstellung unter den neuen Fachrechten sowie den weiterhin erforderlichen mitarbeiterbezogenen Schutzgrenzen,
- eine additive Publikationsschicht für unveränderbare Workflow-Versionen, Geltungsbereiche, Pflicht-/Ergänzungsauflösung und append-only Archivierung,
- eine additive, unveränderbare Bindung ausschließlich neu und kontrolliert gestarteter Personalprozess-Instanzen an Veröffentlichung, Fachobjekttyp und eingefrorene Aufgabenzuweisungen,
- acht eigene Workflow-Rechte mit PL-/PL+-Trennung sowie rechtsspezifischer Scope-Schnittmenge für FL und AL,
- Migrations-, Integritäts-, Fachlogik- und Regressionstests für diese Integrationsgrenze.

Die M3-Umwandlung ist bewusst eng begrenzt: Sie übernimmt nur Bewerbungen im Status `preboarding`, legt kein Portalprofil an, kopiert keine Bewerberdokumente und startet weder Onboarding noch Workflow. R1 setzt die Bereichsrechte für Bewerbungen und Preboarding um; M4 ergänzt davon getrennte Workflow-Rechte und unveränderbare Veröffentlichungen. M5 bindet nur neue, ausdrücklich gestartete Standard-Instanzen an genau eine nicht archivierte Veröffentlichung und übernimmt keinen Legacy-Lauf. Weiterhin nicht umgesetzt sind eine Dokument-Upload-/Download-API, Mitarbeiterprofil-Tabs, ein grafischer Editor und neue Prozessautomatik. Vertrauliche, freie `custom_personnel`- sowie Onboarding- und Offboarding-Workflows bleiben bis zu ihrem eigenen Schutzvertrag fail-closed. Diese Ausbaustufe ist in v0.89.0-beta ausschließlich als standardmäßig deaktiviertes Fundament enthalten und keine Aktivierungsfreigabe. SQLite bleibt der unterstützte Produktprovider. Die PostgreSQL-Grundlage bleibt bis zur gesonderten Freigabe nicht produktiv.

## 2. Einordnung in die bestehende Anwendung

| Zielbaustein | Bestehender Anknüpfungspunkt | Ausbauprinzip |
|---|---|---|
| Mitarbeitende | `employees`, zentrale Personalverwaltung, geschützte Personalakte | Profilansicht auf bestehender Mitarbeiteridentität aufbauen |
| Bewerbungen und Preboarding | neue `candidates`- und `candidate_applications`-Grundlage | getrennte Bewerberidentität verwenden, keine Vorab-Mitarbeiterzeilen anlegen |
| Dokumente | `personnel_record_documents`, geschützter Dateispeicher, Audit; neue Bewerberdokumenttabellen | geschützten Binärspeicher wiederverwenden, Metadaten und Versionen fachlich getrennt halten |
| Rollen und Bereiche | Portalrollen, fachliche Rechte, `personnel_field_permissions`, Standort-/Abteilungsbereiche | neue Fachrechte ergänzen; technische und sicherheitskritische Rechte nicht delegierbar machen |
| Workflow-Center | `custom_processes`, Schritte, Revisionen, Läufe und Lauf-Schritte | bestehende Prozessbasis in Definition, veröffentlichte Version und Instanz schärfen |
| Personalaufgaben | vorhandene Prozess-Lauf-Schritte und `me/process-tasks` | gemeinsame Aufgabenprojektion mit serverseitigem Bereichsfilter ausbauen |
| Nachvollziehbarkeit | `audit_log` und fachliche Historien | zustandsändernde Vorgänge mit Akteur, Zeitpunkt, Grund und Bezug protokollieren |

Die bestehenden Tabellen sind Integrationspunkte, aber nicht automatisch das endgültige Zielmodell. Änderungen erfolgen über benannte Migrationen und Repository-Schnittstellen; neue Fachlogik greift nicht direkt aus der Oberfläche auf Datenbanktabellen zu.

## 3. Verbindliche Fachinvarianten

### 3.1 Bewerber und Mitarbeitende

1. Ein Bewerber und ein Mitarbeiter sind getrennte Entitäten mit getrennten Identitäten.
2. Ein Bewerber besitzt keine Personalnummer und belegt keine Zeile in `employees`.
3. Eine Bewerbung bleibt auch nach Einstellung als unveränderbarer historischer Bezug erhalten.
4. Die Einstellung erfolgt durch einen kontrollierten, transaktionalen Umwandlungsvorgang.
5. Der Vorgang erzeugt genau einen Mitarbeiter und genau eine dokumentierte Verknüpfung zwischen Bewerbung und Mitarbeiter.
6. Ein abgebrochener Vorgang darf weder eine halbe Mitarbeiteranlage noch eine als eingestellt markierte Bewerbung hinterlassen.
7. Umgewandelt werden kann nur die ausdrücklich gewählte Bewerbung im Status `preboarding`; für denselben Bewerber darf keine weitere offene Bewerbung bestehen.
8. Die Personalnummer wird von der zentral berechtigten Stelle ausdrücklich übermittelt und durch das atomare Einfügen in `employees` unter der bestehenden `UNIQUE`-Grenze reserviert. Eine automatische Nummernvergabe findet in M3 nicht statt.
9. Nach erfolgreicher Umwandlung steht die gewählte Bewerbung auf `converted` und der Bewerber auf `archived`; seine Bewerbungs- und Ereignishistorie bleibt erhalten.
10. Die vom Client erzeugte Vorgangs-ID ist eine UUID v4. Eine erneute Übermittlung derselben ID und desselben Inhalts liefert das vorhandene Ergebnis; dieselbe ID mit abweichendem Inhalt führt zu einem Konflikt.
11. In den Personalakt dürfen aus dem Bewerberprofil ausschließlich Vorname, Nachname, Telefon, E-Mail und die Adressfelder Straße, Adresszusatz, Postleitzahl, Ort, Bundesland und Land übernommen werden.
12. M3 kopiert keine Bewerberdokumente, legt kein Portalprofil an und startet keinen Onboarding- oder Workflow-Prozess.

### 3.2 Prozesse

1. Workflow-Vorlage, veröffentlichte Workflow-Version und laufende Workflow-Instanz sind getrennte Entitäten.
2. Eine veröffentlichte Version ist unveränderbar. Korrekturen erzeugen eine neue Version.
3. Eine Instanz referenziert genau die beim Start veröffentlichte Version und speichert alle für die Ausführung benötigten Snapshots.
4. Spätere Vorlagen- oder Versionsänderungen verändern laufende und abgeschlossene Instanzen nicht.
5. Veröffentlichte oder bereits verwendete Versionen werden archiviert, nicht physisch gelöscht.
6. Instanzen und ihre fachliche Historie werden nicht durch das Löschen einer editierbaren Vorlage kaskadiert entfernt.
7. Unternehmensweite Pflichtprozesse sind additiv. Lokale Verantwortliche dürfen sie weder entfernen noch überschreiben.

### 3.3 Berechtigungen und Vertraulichkeit

1. Jeder API-Zugriff wird serverseitig anhand von Fachrecht, Rolle, freigegebenem Bereich und Datenklassifikation geprüft.
2. FL- und AL-Rechte gelten nur innerhalb der von PL+ freigegebenen Standorte beziehungsweise Abteilungen.
3. Eine Freigabe von Geschäftsfunktionen durch PL+ ist von der Delegation technischer, rollenbezogener oder sicherheitskritischer Rechte getrennt.
4. Vertrauliche PL-Daten und vertrauliche Offboarding-Schritte werden bereits in Repository und API ausgefiltert. Eine nur optische Ausblendung ist unzulässig.
5. Fehlende, widersprüchliche oder nicht auflösbare Bereiche führen zu keiner Datenfreigabe.
6. Berechtigungsprüfungen erfolgen bei Listen, Details, Mutationen, Exporten, Dokumentabrufen und Aufgaben gleichermaßen.
7. Für lokale Leitungen entsteht ein wirksamer Bewerbungsbereich nur aus der Schnittmenge von allgemeinem Portalbereich und rechtsspezifischer, nachvollziehbar durch PL+ genehmigter Fachfreigabe.
8. FL wirkt ausschließlich standortweit; AL wirkt ausschließlich für die exakt freigegebene Abteilung im zugehörigen Standort.
9. FL und AL dürfen weder neue Bewerbungen anlegen noch den Standort oder die Abteilung einer bestehenden Bewerbung ändern. Neuanlage und Scope-Felder bleiben zentralen PL-Aktionen vorbehalten.

Der vollständige R1-Vertrag einschließlich Rechte-Matrix, Projektionen, IDOR-Grenzen, Migration und API-Änderungen ist in `PERSONALMODUL-BEREICHSRECHTE-v0.1.md` festgeschrieben.

### 3.4 Dokumente

1. Jedes Dokument besitzt eine Kategorie, eine Sichtbarkeitsklasse, fachliche Metadaten, Integritätsdaten und eine nachvollziehbare Historie.
2. Binärinhalt und lesbare Metadaten bleiben getrennt; vertrauliche Metadaten werden wie der Inhalt geschützt.
3. Ersetzen erzeugt eine neue Dokumentversion. Frühere Versionen bleiben gemäß Aufbewahrungsregel nachvollziehbar.
4. Archivierung und Aufbewahrungsprüfung sind eigene Zustände. Eine physische Bereinigung wird erst nach einer gesonderten Lösch-/Anonymisierungsentscheidung über einen kontrollierten Aufbewahrungsprozess ergänzt.
5. Download, Vorschau, Änderung, Archivierung und Bereinigung werden auditiert.

## 4. Zielmodell

### 4.1 Bewerberdomäne

Vorgesehene Kernobjekte:

- `Candidate`: neutrale Bewerberidentität ohne Personalnummer.
- `Application`: Bewerbung auf eine Stelle oder einen organisatorischen Bereich.
- `CandidateDocument`: geschütztes Dokument mit Kategorie, Sichtbarkeit und Version.
- `CandidateHistoryEvent`: append-only Ereignis für Status- und Zuordnungsänderungen.
- `CandidateConversion`: idempotenter Nachweis der Umwandlung in einen Mitarbeiter.

Die im Fundament festgeschriebene Hauptfolge einer Bewerbung lautet:

`new` → `screening` → `first_interview` → `further_interview` → `offer` → `accepted` → `preboarding`

Abzweigungen sind `rejected`, `withdrawn`, `talent_pool` und `archived`. Der Status `converted` ist ausschließlich über die kontrollierte M3-Einstellungsaktion erreichbar und bleibt über den allgemeinen Statusendpunkt gesperrt. Statuswechsel erfolgen über einen geprüften Zustandsautomaten und nicht durch freie Feldänderung.

Der lokale M3-Stand speichert `CandidateConversion` additiv in `candidate_conversions`. Der unveränderbare Nachweis enthält die clientseitige Vorgangs-ID, die drei Fachbezüge, einen Request-Hash, einen geschützten Payload, einen Beleg-Hash, den Akteur und den Erstellungszeitpunkt. Zwei Trigger verbieten nachträgliche Updates und physische Löschungen.

### 4.2 Mitarbeiterprofil

`employees.personnel_number` bleibt die Mitarbeiteridentität. Das Profil bündelt vorhandene und neue Projektionen in Tabs, ohne die Schutzgrenzen aufzuweichen:

- Übersicht,
- Stammdaten und Organisation,
- Personalakte und Dokumente,
- Onboarding,
- Schulungen,
- Offboarding,
- Historie.

Die Profil-API liefert je Tab nur die erlaubte Projektion. Besonders geschützte Felder aus `personnel_sensitive_records` und geschützte Dokumente werden nie als Nebenprodukt einer allgemeinen Profilabfrage ausgeliefert.

### 4.3 Workflow-Domäne

Das Zielmodell benennt drei Ebenen ausdrücklich:

- `WorkflowDefinition`: editierbarer Entwurf mit Zweck, Kategorie und Eigentümer.
- `WorkflowVersion`: veröffentlichter, unveränderbarer Snapshot einschließlich Schritten, Regeln und Geltungsbereich.
- `WorkflowInstance`: konkrete Ausführung für einen fachlichen Bezug, zum Beispiel Bewerber, Mitarbeiter oder Offboarding-Fall.

Die vorhandene Prozessbasis wird weiterentwickelt:

| Heute | Zielrolle |
|---|---|
| `custom_processes` | Definition und aktueller Entwurfszustand |
| `custom_process_steps` | editierbare Schritte des Entwurfs |
| `custom_process_revisions.snapshot_json` | Ausgangspunkt für unveränderbare veröffentlichte Versionen |
| `custom_process_runs` | Ausgangspunkt für Workflow-Instanzen |
| `custom_process_run_steps` | Ausgangspunkt für instanzgebundene Aufgaben und Ausführungszustände |

M4 legt über dieser Basis additiv `custom_process_publications` und `custom_process_publication_archives` an. Entwurfsrevision und Veröffentlichungsnummer bleiben getrennt; Publikationen und Archivierungsnachweise sind unveränderbar. M5 ergänzt `custom_process_run_bindings` als unveränderbaren Sidecar für die Bindung eines neuen `custom_process_runs`-Laufs an genau eine Veröffentlichung und einen fachlichen Bewerbungs- oder Mitarbeiterbezug. `custom_process_run_step_assignments` friert je Instanzschritt die beim Start aufgelöste verantwortliche Person ein. Die Bestandsstrukturen werden weder per `ALTER TABLE` erweitert noch als Legacy-Instanzen umgedeutet; eine zweite Workflow-Engine ist ausgeschlossen.

Eine M5-Instanz besitzt `trigger_type = personnel_manual`, genau eine Aktivierung und beim Start ausschließlich aus dem Veröffentlichungssnapshot erzeugte Schritte. Veröffentlichung, Instanzkern, Fachobjektbindung und Zuweisungsbelege sind unveränderbar. Laufstatus und Schrittstatus dürfen nur über die vorhandenen kontrollierten Ausführungsübergänge fortschreiten; eine abgeschlossene Personalprozess-Instanz kann nicht wieder geöffnet oder physisch gelöscht werden. Veröffentlichte Personalprozesse sind zugleich für die alte manuelle und die automatische Personalmangel-Auslösung gesperrt.

### 4.4 Geltungsbereiche und Pflichtprozesse

Ein veröffentlichter Prozess besitzt einen Geltungsbereich:

- `company`,
- `location`,
- `department`.

Zusätzlich wird zwischen `mandatory` und `supplemental` unterschieden. Bei der Auflösung für einen Mitarbeiter werden alle passenden unternehmensweiten Pflichtprozesse mit passenden lokalen Ergänzungen vereinigt. Gleiche Codes oder Titel erzeugen keinen impliziten Override. Ein Konflikt wird sichtbar und muss durch eine berechtigte zentrale Stelle entschieden werden.

### 4.5 Aufgaben

Aufgaben werden aus Instanzschritten projiziert und nicht als unabhängige Wahrheit dupliziert. Jede Aufgabe kennt mindestens:

- Workflow-Instanz und veröffentlichte Version,
- fachlichen Bezug,
- verantwortliche Rolle oder Person,
- wirksamen Standort-/Abteilungsbereich,
- Sichtbarkeitsklasse,
- Fälligkeit und Status,
- Abschlussakteur, Zeitpunkt und Nachweis.

M5 projiziert den aktiven Schritt einer serverseitig bereits berechtigten Instanz read-only in das Workflow-Center und als persönlich abschließbare Aufgabe in die bestehende Portalansicht. Diese Projektion ist keine zweite Aufgabenquelle und trifft keine Verantwortlichen-, Frist- oder Eskalationsentscheidung im Client. Der Abschluss bleibt auf die eingefrorene Einzelzuweisung begrenzt und prüft den aktiven persönlichen Zugang, die aktuelle Snapshot-Rolle sowie den aktuellen freigegebenen Bereich erneut. Weiterführende Listen wie „Überfällig“ oder „Im Bereich“ bleiben spätere, serverseitig zu filternde Projektionen derselben geschützten Datenbasis.

## 5. Kontrollierte Bewerberumwandlung

Die im Quellstand umgesetzte M3-Umwandlung ist eine serverseitige Fachaktion mit einer vom Client neu erzeugten UUID v4. Sie läuft vollständig in einer Datenbanktransaktion:

1. Feature-Grenze und CSRF prüfen; anschließend die vollständige R1-Kette aus Bewerberlesen, Bewerbungsbearbeitung, zentralem Bewerberschreiben, vertraulichem Lesen/Schreiben und Umwandlung sowie die bestehenden zentralen, sensiblen und mitarbeiterbezogenen Personalrechte verlangen.
2. Bewerber und ausgewählte Bewerbung mit den zuletzt gelesenen Revisionen laden. Der Bewerber muss `active`, die Bewerbung muss `preboarding` sein; eine weitere offene Bewerbung desselben Bewerbers sperrt den Vorgang.
3. Vorgangs-ID und kanonischen Request-Hash prüfen. Ein exakter Replay ist idempotent, eine wiederverwendete ID mit anderem Inhalt wird abgewiesen.
4. Die ausdrücklich übermittelte Personalnummer validieren und den Mitarbeiter durch das atomare `INSERT` unter der bestehenden `UNIQUE`-Grenze anlegen. Damit werden Prüfung und Reservierung nicht in zwei konkurrierende Schritte getrennt.
5. Aus dem Bewerberprofil nur die festgeschriebene Whitelist in den geschützten Personalakt übernehmen: Vorname, Nachname, Telefon, E-Mail sowie Straße, Adresszusatz, Postleitzahl, Ort, Bundesland und Land. Bevorzugte Sprache, Bewerbungsquelle, Bewertungen, Notizen, Tags und sonstige Bewerbungsdaten werden nicht übertragen.
6. Den unveränderbaren `CandidateConversion`-Nachweis, den Status `converted`, das Historienereignis und die Archivierung des Bewerbers mit Revisionsprüfungen speichern. Archivierungs- und Statuszeitpunkt sowie die aktualisierende Identität der öffentlichen Zustandszeilen sind dabei an Zeitpunkt und Akteur des Konversionsnachweises gebunden.
7. Ein Audit-Ereignis ohne vertrauliche Nutzdaten schreiben und eine datensparsame Bestätigung zurückgeben. Abgewiesene Feldrechte werden erst nach dem vollständigen Rollback genau einmal und ohne Bewerber-, Kontakt- oder Personalnummernwerte auditiert.

Bewerberdokumente verbleiben unverändert bei ihrer Bewerberhistorie; M3 verknüpft oder kopiert kein Dokument in die Mitarbeiterakte. Ebenso werden weder Portalprofil noch Zugangsdaten, technische Rollen oder Zusatzrechte erzeugt. Onboarding-Auflösung, Workflow-Version und Workflow-Instanz sind ausdrücklich auf einen späteren Block verschoben und wurden mit M3 nicht gestartet.

## 6. Berechtigungsmodell

R1 setzt für Bewerbungen und Preboarding sieben kleine, aktionsbezogene Fachrechte um:

- `personnel:candidates:read`,
- `personnel:applications:write`,
- `personnel:candidates:write`,
- `personnel:candidates:confidential:read`,
- `personnel:candidates:confidential:write`,
- `personnel:candidates:convert`,
- `personnel:candidates:delegate`.

Die bestehende Rolle `hr` entspricht PL. PL+ ist keine eigene Rolle, sondern eine PL mit der zusätzlichen, nicht weiterdelegierbaren Capability `personnel:candidates:delegate`. Nur `personnel:candidates:read` und `personnel:applications:write` dürfen an FL (`manager`) oder AL (`department_manager`) gebunden an einen Fachbereich freigegeben werden. Kandidatenstamm, vertrauliche Felder, Konversion und Delegation bleiben global. `it_admin` ist für Bewerberdaten auch bei injizierten Rechtewerten geschlossen.

Für lokale Leitungen gilt pro Recht die Schnittmenge aus allgemeinem Portalbereich und genehmigtem Fachbereich. FL benötigt einen ganzen Standort; AL benötigt dieselbe konkrete Kombination aus Standort und Abteilung auf beiden Scope-Seiten. Fehlt das Recht, eine Scope-Seite oder die Genehmigungsidentität, entsteht kein Zugriff. Mehrfachbewerbungen werden je Bewerbung gefiltert; ein Bewerber ohne sichtbare Bewerbung wird nicht ausgeliefert. Listen enthalten lokal nur Namen und strukturierte Bewerbungen, Details zusätzlich E-Mail und Telefon. Anschrift, Sprache, Quelle, Bewertungen, Notizen, Kommunikation, Tags, Dokumente, Historie, Konversion, Akteure und Hashwerte bleiben ausgeschlossen.

M4 leitet Workflow-Rechte ausdrücklich nicht aus R1-Bewerbungsrechten oder dem breiten Bestandsrecht `processes:write` ab. Der eigene Vertrag umfasst `personnel:workflows:read`, `personnel:workflows:draft:write`, `personnel:workflows:review`, `personnel:workflows:publish`, `personnel:workflows:local:supplement`, `personnel:workflows:confidential:read`, `personnel:workflows:confidential:write` und `personnel:workflows:delegate`. PL+ ist auch hier eine PL mit der zusätzlichen, nicht weiterdelegierbaren Delegations-Capability. Die vier lokalen Rechte werden pro Recht an dieselbe allgemeine-Portalbereich-mal-PL+-Fachbereich-Schnittmenge gebunden. IT-Admin bleibt für Personal-Workflows geschlossen; technische Rollen erhalten keine vertraulichen Workflow-Rechte automatisch.

M5 führt kein weiteres Fachrecht ein. Listen und Personalaufgaben benötigen `personnel:workflows:read`; weder `processes:write` noch eine zentrale Personal-Leseberechtigung schalten diese Oberflächen frei. Eine zentrale Personal-Leseberechtigung wird nicht als zusätzliche M5-Lesefreigabe verlangt. Der Server veröffentlicht dafür `canReadInstances` und wertet fehlende Capability-Werte fail-closed aus. Innerhalb der freigegebenen Managementliste bleiben Bewerbungsinstanzen zusätzlich auf aktuell lesbare Bewerbungsbereiche und Mitarbeiterinstanzen auf den vorhandenen Mitarbeiter-Lesezugriff begrenzt; diese Objektfilterung erfolgt ausschließlich serverseitig und kann eine leere Liste ergeben. Die persönliche Aufgabenprojektion verrät keine Fachobjekt-ID und setzt statt dieser Management-Leserechte die eigene eingefrorene Zuordnung sowie aktuelle Rollen- und Bereichsgültigkeit voraus. Das kontrollierte Starten benötigt zusätzlich die bestehende Workflow-Publikationsberechtigung, bei Bewerbungen `personnel:applications:write`, bei Mitarbeitern `employees:read` und jeweils einen für den wirksamen Bereich zugelassenen Start. Die Managementoberfläche in M5 bleibt read-only und enthält bewusst keine Startmaske.

Mitarbeiterprofil-, Schulungs- und Offboarding-Rechte erhalten in den späteren Issues weiterhin eigene Aktions-, Sichtbarkeits- und Schutzverträge. Technische Rechte wie Rollenverwaltung, Systemdiagnose, Schlüsselmaterial oder Sicherheitskonfiguration bleiben außerhalb der fachlichen PL+-Delegation. Das Installationsmerkmal bleibt standardmäßig deaktiviert.

## 7. Datenbankmigrationen

Jede Stufe erhält eine eigene, vorwärtskompatible SQLite-Migration und passende Provider-Verträge.

| Stufe | Status | Inhalt | Rückwärtsgrenze |
|---|---|---|---|
| M1/M2 | im Quellstand umgesetzt als `v0.89-personnel-lifecycle-candidate-foundation` | Bewerber, Bewerbungen, Dokumentkategorien, Dokumente, Versionen und Ereigniskette | keine Änderung an `employees`; kein Binärinhalt in SQLite |
| M3 | im Quellstand additiv umgesetzt als `v0.89-personnel-lifecycle-conversion` | unveränderbarer Umwandlungsnachweis, Idempotenzbeleg und kontrollierte Einstellung | bestehende M1/M2-Daten bleiben erhalten; Mitarbeiteranlage bleibt transaktional |
| R1 | im Quellstand additiv umgesetzt als `v0.89-personnel-lifecycle-scoped-rights` | rechtsspezifische, durch PL+ genehmigte Fachbereiche für lokale Bewerbungsrechte | keine Änderung an Bewerberfachdaten; nur SQLite |
| M4 | im Quellstand additiv umgesetzt als `v0.89-personnel-workflow-publications` | Workflow-Veröffentlichungen, unveränderbare Versionsmetadaten, Geltungsbereiche, additive Auflösung und Archivierung | bestehende Prozesse, Revisionen und Läufe werden erhalten; keine automatische Klassifikation |
| M5 | im Quellstand additiv umgesetzt als `v0.89-personnel-workflow-instances` | unveränderbarer Instanzbezug auf Veröffentlichung und Fachobjekttyp, eingefrorene Schrittzuweisungen, datensparsame Instanz-/Aktivschrittprojektion | nur neue kontrollierte Läufe; bestehende und automatisch ausgelöste Prozesse werden nicht neu interpretiert |
| M6 | offen | erweiterte Dokumentmetadaten und Historie für Mitarbeiterakten | bestehende Dokumente werden sicher nachklassifiziert |

M1/M2 legen sechs Tabellen, die erforderlichen Indizes, sechs eingebaute Dokumentkategorien und neun Schutztrigger für Bereichsbezüge, Dokumentversionen sowie Historienereignisse an. M3 ergänzt verlustfrei die siebte Tabelle `candidate_conversions` und zwei Unveränderbarkeitstrigger. R1 ergänzt als achte Tabelle `portal_permission_scope_grants` und acht Scope-Schutztrigger; der lokale Gesamtstand umfasst damit acht Personal-Lifecycle-/R1-Tabellen und neunzehn Trigger. Die M3-Tabelle bindet Bewerber und Bewerbung mit `ON DELETE RESTRICT` an den historischen Ursprung und die Personalnummer mit `ON DELETE RESTRICT` an den erzeugten Mitarbeiter. Eindeutigkeitsgrenzen auf Bewerber, Bewerbung und Personalnummer verhindern Mehrfachumwandlungen zusätzlich auf Datenbankebene.

Im ursprünglichen R1-Stand ist die Tabelle auf `personnel:candidates:read` und `personnel:applications:write` begrenzt. Die additive M4-Migration erweitert denselben Scope-Träger um `personnel:workflows:read`, `personnel:workflows:draft:write`, `personnel:workflows:publish` und `personnel:workflows:local:supplement`. Sie bindet jede Freigabe an Zielperson, Recht, Standort, optional konkrete Abteilung und eine nicht leere Genehmigungsidentität. Fremdschlüssel und Trigger verhindern Fachscopes ohne individuelles Recht, ungültige Standort-/Abteilungsbezüge und Freigaben außerhalb der allgemeinen Portalbereiche. Verkleinerte allgemeine Bereiche bereinigen nicht mehr gedeckte Fachscopes.

Zwei zusätzliche, anwendungsweite Trigger reservieren `employees.personnel_number = local` case-insensitiv und nach Entfernung umgebenden ASCII-Leerraums einschließlich TAB, CR und LF für den internen Systempfad. Normale Mitarbeiteranlage, Import und Bewerberumwandlung weisen diesen Prinzipal bereits vor dem Schreiben zurück; Portal- und Mobile-Anmeldung sowie Sitzungsauflösung akzeptieren ihn auch bei einer manipulierten Altzeile nicht. Ein vorhandener Konflikt stoppt den Start mit `EMPLOYEE_PRINCIPAL_RESERVED`, ohne Daten automatisch zu verändern. Der interne lokale Zugriff wird ausschließlich durch ein nicht persistiertes serverseitiges Sitzungsmerkmal erkannt und nicht mehr aus der Personalnummer oder Rollenbezeichnung abgeleitet; alle echten lokalen Fallback-Sitzungen tragen diesen Marker. Damit bleiben die neunzehn Personal-Lifecycle-/R1-Trigger fachlich unverändert; hinzu kommen zwei Identitätsschutztrigger an der bestehenden Mitarbeitertabelle.

Fremdschlüssel binden Bewerbungen und Dokumente an genau einen Bewerber; eine optionale verantwortliche Person wird mit `ON DELETE RESTRICT` auf einen bestehenden Mitarbeiter geführt, damit kein historisch gebundener Zustand ohne Ereignis verändert werden kann. `candidates` enthält bewusst keine Personalnummer. Die Bewerbungsquelle liegt im geschützten Payload und nicht als frei auswertbares Klartextfeld vor. Zustands-, Ereignis- und Umwandlungsbelege binden den vorherigen Zustand, den aktuellen Fachzustand beziehungsweise die drei Fachbezüge und den Erstellungszeitpunkt. PostgreSQL-Artefakte folgen erst nach bestätigter Provider-Parität und stellen keine Freigabe für produktiven PostgreSQL-Betrieb dar.

Die Marker `v0.89-personnel-lifecycle-candidate-foundation`, `v0.89-personnel-lifecycle-conversion` und `v0.89-personnel-lifecycle-scoped-rights` werden jeweils genau einmal in `schema_migrations` geführt. Der Startpfad prüft die sechs M1/M2-Tabellen und neun Basistrigger, die additive M3-Tabelle mit zwei Triggern sowie die additive R1-Tabelle mit acht Triggern gegen die kanonischen normalisierten Definitionen. Vor jeder notwendigen Migration oder Reparatur einer vorhandenen Datenbank entsteht zuerst der interne Pre-Migration-Sicherungspunkt. Ein gültiger M1/M2-/M3-Stand wird durch R1 nur ergänzt; vorhandene Bewerberdaten werden nicht neu aufgebaut oder überschrieben. Ein vollständig fehlendes Schema wird als kompatible Altversion angelegt; leere abweichende Strukturen dürfen kontrolliert neu aufgebaut werden. Sobald eine abweichende M3- oder R1-Tabelle bereits Fachdaten enthält, bricht der Start fail-closed ab. Jede weitere Schemaänderung benötigt eine explizite verlustfreie Migration und darf bei vorhandenen Fachdaten nicht auf einen Leer-Rebuild zurückgreifen. Die neun providerneutral beschriebenen Anwendungsmigrationsstufen bleiben unverändert: Die Personal-Lifecycle-Marker gehören derzeit zur kanonischen SQLite-Startschemaoperation und behaupten keine zusätzliche PostgreSQL-kompatible Anwendungsstufe.

Der Datenbankimport öffnet die ausgewählte Datei ausschließlich lesend. Eine Altversion ohne Bewerbertabellen, ein vollständiger M1/M2-Stand ohne `candidate_conversions` sowie ein vollständiger M3-Stand ohne R1-Tabelle bleiben migrationsfähig. Ein partielles oder abweichendes M3-/R1-Schema, ungültige Fachscopes, Fremdschlüsselverletzungen oder kryptografisch beziehungsweise semantisch inkonsistente Zustands-, Ereignis- und Umwandlungsbelege werden vor der Importfreigabe mit `AMU_FULL_RESTORE_REQUIRED` abgewiesen. Die aktive Datenbank und die Importdatei werden bei dieser Vorprüfung nicht verändert.

M4 ergänzt zwei Publikationstabellen und zehn Schutztrigger. Der Startpfad prüft DDL, Trigger, lückenlose Versionsnummern, Snapshot-Bezüge und SHA-256-Belege; vor jeder notwendigen Änderung einer vorhandenen Datenbank entsteht zuerst der interne Pre-Migration-Sicherungspunkt. Bestehende Prozesse, Revisionen und Läufe werden weder umgedeutet noch verändert. Die Read-only-Importprüfung akzeptiert einen vollständigen Altstand ohne M4 als `pre-m4-compatible`, einen vollständigen validen M4-Stand als `m4` und sperrt partielle oder manipulierte M4-Strukturen als `invalid`. Der vollständige Vertrag steht in `PERSONALMODUL-WORKFLOW-PUBLIKATION-M4-v0.1.md`.

M5 ergänzt zwei Sidecar-Tabellen und zwölf Schutztrigger. `custom_process_run_bindings` bindet Lauf, Veröffentlichung, idempotente Vorgangs-ID, Fachobjekttyp, revisionsgebundenen Bewerbungsbezug oder Mitarbeiterbezug sowie Startbeleg unveränderbar zusammen. `custom_process_run_step_assignments` bindet jeden Instanzschritt an genau eine beim Start wirksame Person und einen eigenen Zuweisungsbeleg. Fremdschlüssel verwenden `ON DELETE RESTRICT`; Trigger prüfen Veröffentlichung, Snapshot, Bereich, Fachobjektstatus, Portalzugang, Schrittfolge und Unveränderbarkeit. Der Marker wird erst nach vollständiger Integritätsprüfung geschrieben. Altstände ohne M5 bleiben migrationsfähig, ein vollständiger M5-Stand wird als `m5` erkannt; partielle, verwaiste oder manipulierte Bindungen, Zuweisungen, Hashketten und Personal-Läufe sperren Start beziehungsweise Read-only-Import fail-closed. Vor einer notwendigen Änderung einer vorhandenen Datenbank entsteht weiterhin zuerst der interne Pre-Migration-Sicherungspunkt. Die neun providerneutralen Anwendungsmigrationsstufen bleiben unverändert und PostgreSQL bleibt 0/9 ohne Produktfreigabe.

## 8. API-Oberfläche

Die Endpunkte sind unter `/api/portal/v1/personnel-lifecycle/...` gebündelt und durch `personnelLifecycle` fail-closed gesperrt. Im standardmäßig deaktivierten v0.89.0-beta-Fundament enthalten sind:

- `GET /document-categories`,
- `GET|POST /candidates`,
- `GET|PUT /candidates/:candidateId`,
- `POST /candidates/:candidateId/applications`,
- `PUT /candidates/:candidateId/applications/:applicationId`,
- `POST /candidates/:candidateId/applications/:applicationId/status`,
- `POST /candidates/:candidateId/applications/:applicationId/convert`,
- `GET /workflows`,
- `GET /workflow-publications/resolve`,
- `POST /workflows/:processId/publish`,
- `POST /workflow-publications/:publicationId/archive`,
- `GET /workflow-instances`,
- `POST /workflow-instances`,
- `GET /api/portal/v1/me/process-tasks` als gemeinsame Legacy-/M5-Selbstprojektion,
- `POST /api/portal/v1/me/process-tasks/:runId/:stepId/complete` als bestehende gemeinsame Abschlussgrenze.

R1 ergänzt an dieser Grenze die bisherige pauschale Kombination aus `personnel:central:*` und `personnel:sensitive:*` um aktionsbezogene Bewerbungsrechte, sodass die API nicht mehr allein auf den breiten Bestandsrechten beruht. Für globale Zugriffe bleiben die zentralen und sensiblen Personalrechte als zusätzliche Schutzgrenze erhalten. Lesen benötigt `personnel:candidates:read`. Dokumentkategorien benötigen wegen ihrer Sichtbarkeitsmetadaten zusätzlich `personnel:candidates:confidential:read`. Kandidatenstammänderungen benötigen global `personnel:candidates:write`; vertrauliche Felder bleiben zusätzlich durch `personnel:candidates:confidential:*` geschützt. Bewerbungsänderungen und Statuswechsel benötigen `personnel:applications:write`. FL und AL werden dabei auf ihre Scope-Schnittmenge und strukturierte Nicht-Scope-Felder bereits sichtbarer Bewerbungen begrenzt. Sie dürfen weder neue Bewerbungen anlegen noch Standort oder Abteilung ändern; die Neuanlage setzt global `personnel:candidates:write` und `personnel:applications:write` voraus. Die Umwandlung benötigt global `personnel:candidates:convert`, die vollständige Rechtekette, `employees:write` und die bestehende zentrale Grenze für Mitarbeiteranlage.

Für bereichsgebundene Listen lädt das Repository zuerst nur Kandidatenzugriffsköpfe und Anwendungsbereiche ohne `protectedPayload`. Erst nach der Objektprüfung werden ausschließlich berechtigte Kandidaten entschlüsselt und positiv projiziert. Mehrfachbewerbungen außerhalb des Bereichs werden aus der Antwort entfernt; bleibt keine sichtbare Bewerbung, wird auch der Bewerber nicht geliefert. Direkte Fremd-IDs umgehen diese Prüfung nicht.

Listen- und Detailantworten enthalten zusätzlich `capabilities` mit `scope`, `canReadCandidates`, `canWriteCandidates`, `canWriteApplications`, `canReadConfidential`, `canWriteConfidential` und `canConvert`. `canConvert` ist der öffentliche Alias der internen Capability `canConvertCandidates`; die Delegations-Capability wird an dieser Fachdatengrenze nicht veröffentlicht. `scope.type` ist `global`, `location`, `department` oder `none` und enthält bei lokalen Zugriffen nur die wirksamen Standort- beziehungsweise Abteilungs-IDs. Fehlende Capability-Werte behandelt die Oberfläche als `false`.

Der aktuelle HTTP-Vertrag bleibt bewusst klein:

- `includeArchived=1` erweitert die Bewerberliste um archivierte Datensätze. `limit` begrenzt die Seite auf 1 bis 100 Einträge, `offset` setzt den Startpunkt; die Antwort enthält `{ candidates, pagination: { limit, offset, hasMore, includeArchived }, capabilities }`. `includeInactive=1` erweitert ausschließlich die Kategorienliste.
- `POST /candidates` erwartet ein `profile` und optional eine erste `application`; `personnel:candidates:write` ist immer erforderlich, bei einer eingebetteten ersten Bewerbung zusätzlich `personnel:applications:write`. Erfolg liefert `201` mit der berechtigten `{ candidate, capabilities }`-Projektion.
- Profil- und Bewerbungsänderungen erwarten die zuletzt gelesene `revision`; Erfolg liefert die berechtigte `{ candidate, capabilities }`- beziehungsweise `{ application, capabilities }`-Projektion. `POST /candidates/:candidateId/applications` bleibt ausschließlich globalen PL-Zugängen vorbehalten.
- Der Statusendpunkt erwartet `status`, `revision` und optional `reason`. `converted` wird unabhängig vom Ausgangsstatus geschlossen abgewiesen. FL und AL dürfen ausschließlich den Status und freigegebene strukturierte Nicht-Scope-Felder bereits sichtbarer Bewerbungen ändern.
- Der M3-Endpunkt `POST /candidates/:candidateId/applications/:applicationId/convert` akzeptiert ausschließlich `{ operationId, candidateRevision, applicationRevision, employee }`. `operationId` ist eine clientseitig neu erzeugte UUID v4. `employee` erlaubt nur `personnelNumber`, `nickname`, `color`, `contractedHours`, `targetWorkdaysPerWeek`, `preferredDayOff`, `fixedWorkdays`, `positionId`, `costCenterId` und `preferredDepartmentId`; davon sind `personnelNumber`, `nickname`, `contractedHours`, `targetWorkdaysPerWeek`, `positionId` und `costCenterId` Pflichtfelder. Unbekannte Felder werden abgewiesen.
- Der Erstlauf antwortet mit `201`. Ein inhaltlich exakter Replay antwortet mit `200` und `Idempotency-Replayed: true`. Der Response ist bewusst datensparsam: `{ conversion: { id, candidateId, applicationId, employeeNumber, createdAt, documentTransfer: 'none', onboarding: 'deferred' }, candidate: { id, state, revision }, application: { id, status, revision }, replayed, capabilities }`. Request- oder Beleg-Hashes, geschützte Payloads und personenbezogene Profildaten werden nicht ausgegeben.
- Lokale Listen enthalten nur Name und freigegebene strukturierte Bewerbungen; lokale Details ergänzen E-Mail und Telefon. Anschrift, Sprachpräferenz, Quelle, interne Bewertung, interne Notizen, Kommunikationsnotizen, Tags, Dokumente, Historie, Konversion, Akteure und Hashwerte bleiben ausgeschlossen.
- Die realisierten Personal-Lifecycle-Mutationen verwenden CSRF-Schutz, Eingabevalidierung, optimistische Revisionen, Fachaktionen und Audit. Erfolgreiche Bewerberlisten und Bewerberdetails werden ohne fachliche Nutzdaten auditiert. Die zentralen R1-Berechtigungs- und Objektbereichsablehnungen sowie Rechte- und Scope-Mutationen werden datensparsam protokolliert; dies ist keine pauschale Zusage für jeden Kategorienabruf oder jede innerhalb einer Route mögliche `403`-Abzweigung. Speicherpfade und verschlüsselte Rohpayloads werden nie ausgegeben.
- Rechte-, Scope- und Rollenänderungen lesen Konto, Rechte und R1-Fachscopes nach Beginn derselben serialisierbaren Transaktion erneut. Parallel abweichende Zustände und Provider-Serialisierungskonflikte werden mit `PERSONNEL_LIFECYCLE_SCOPE_CONCURRENT_CHANGE` vollständig abgewiesen. Technische Zugangsprofile, direkte Mitarbeiterdeaktivierungen und der Personalimport revalidieren denselben Schutz live in ihrer Schreibtransaktion. Mitarbeiteranlage, -änderung und Import prüfen dort auch die aktiven Organisationsreferenzen; nur eine unveränderte historische Archivzuordnung darf bestehen bleiben. Ein konkurrierender Import-Unique-Konflikt wird als `IMPORT_PREVIEW_STALE` und nicht als interner Fehler behandelt. Unveränderte Freigaben werden per Set-Diff nicht neu geschrieben; ihr Genehmiger und ihre Erstellungs-/Änderungszeitpunkte bleiben erhalten. Große Auditdetails der Rechte-, Scope- und Rollenpfade bleiben durch strukturierte Zähler und SHA-256-Fingerprints valides JSON innerhalb der 2.000-Zeichen-Grenze.
- Inaktive Standorte oder Abteilungen werden in Browser-, Mobile- und Organisationssitzungen unmittelbar ausgefiltert und können nicht neu als Rechtebereich gespeichert werden. Eine Browser-Sitzung wird außerdem nicht mehr aufgelöst, sobald der zugehörige Mitarbeiter deaktiviert ist, selbst wenn Portalzugang und Legacy-Sitzung noch aktiv markiert sind. IT-Admin kann weder `hr` zuweisen noch HR- oder R1-freigegebene Leitungskonten sicherheitsrelevant übernehmen.
- Relevante Fehlergrenzen sind `400` für ungültige Eingaben oder Bezüge, `403` für deaktiviertes Feature, fehlende Rechte oder CSRF, `404` für fehlende oder im wirksamen Bereich nicht sichtbare Fachobjekte, `409` für Revisionen, unzulässige Übergänge, gesperrte lokale Scope-Änderungen, nicht erfüllte Umwandlungsvoraussetzungen, eine anderweitig belegte Personalnummer oder eine mit anderem Inhalt wiederverwendete Vorgangs-ID sowie `503` für Integritätsfehler. Die Antwort enthält jeweils einen stabilen Fehlercode.

Dokumentmutationen sind noch nicht exponiert, damit kein Metadatensatz ohne den gescannten, verschlüsselten Blob-Workflow entstehen kann. Rechteverwaltungs- und Sitzungsprojektionen führen die rechtsspezifischen Fachscopes mit Recht, Standort, Abteilung und Genehmigungsidentität; die bestehende Rechteänderungsgrenze auditiert Änderungen und widerruft betroffene Sitzungen.

Die M4-Endpunkte verwenden ausschließlich den eigenen Workflow-Rechtevertrag. Globale Zugriffe benötigen zusätzlich die bestehenden zentralen Personalrechte; lokale Zugriffe werden pro Recht auf die Portalbereich-/PL+-Fachbereich-Schnittmenge beschränkt. Publikation und Archivierung sind CSRF-geschützt und transaktional auditiert. Antworten liefern nur fachliche Metadaten und Capabilities, jedoch weder Rohsnapshot noch Hashwerte, Publikationsakteur, Archivierungsgrund oder Genehmigungsidentitäten. Vertrauliche und Offboarding-Publikationen bleiben fail-closed gesperrt.

M5 erweitert dieselbe Grenze um die Instanzprojektion. `GET /workflow-instances` besitzt keine Client-Scope- oder Include-Parameter; der wirksame Bereich wird ausschließlich aus dem serverseitigen Workflow-Zugriff abgeleitet. Die Antwort lautet `{ instances, capabilities }`. Jede Instanz enthält nur `id`, `publication: { id, workflowCode, workflowType, versionNumber, title }`, `subject: { type }`, `scope`, `status`, `progress: { completedSteps, totalSteps }`, den optionalen `activeStep`, `startedAt` und `resolvedAt`. Fachobjekt-ID, Bewerberdaten, Personalnummer, Zuweisungsperson, Startakteur, Request-/Beleghash und Abschlussnotiz werden nicht ausgegeben. Die Management-Oberfläche reduziert diese Serverprojektion nochmals auf Titel, Typ, Version, generischen Fachobjektbezug, Bereichsbezeichnung, Status, Fortschritt, Zeitpunkte und den Titel des aktiven Schritts. Sie verwendet ausschließlich `GET`, bietet keine Start- oder Abschlussmutation an. M5 enthält keine neue Prozessautomatik sowie keine Frist- oder Eskalationsautomatik.

`POST /workflow-instances` startet ausschließlich eine ausdrücklich gewählte,
nicht archivierte Standard-Veröffentlichung für `application`, `preboarding`,
`training`, `position_change`, `department_change`, `location_change` oder
`return_from_absence`. Freie `custom_personnel`-, Onboarding- und
Offboarding-Typen bleiben zurückgestellt. Der exakte Request enthält
`{ operationId, publicationId, subject, assignments }`: `operationId` ist eine
UUIDv4 für die idempotente Wiederholung, `subject` bindet entweder einen
versionierten Bewerbungsbezug oder eine Personalnummer, und `assignments`
ordnet jeden nicht technischen Schritt genau einer berechtigten Person zu.
Systemschritte erhalten keine Clientzuweisung. Der Server prüft
Veröffentlichungsbeleg, Fachobjektstatus, Bereich, Verantwortungsart und
persönlichen Portalzugang; ein Bewerbungsbezug benötigt dabei den aktuellen
Schreibzugriff auf die Bewerbung, ein Mitarbeiterbezug den vorhandenen
Mitarbeiter-Lesezugriff. Der Server wählt weder Personen noch Zuständigkeiten
automatisch aus. Der Erststart antwortet mit `201`; ein inhaltlich exakter
Replay mit `200` und `Idempotency-Replayed: true`. Die Antwort liefert
`{ instance, replayed, capabilities }` mit derselben datensparsamen
Instanzprojektion. Diese Mutation ist bewusst nicht in der
M5-Management-Oberfläche verdrahtet.

Die bestehenden Portal-Aufgabenendpunkte bleiben die einzige Selbstaufgabenquelle. `GET /api/portal/v1/me/process-tasks` kombiniert unveränderte Legacy-Aufgaben mit M5-Aufgaben, sobald das Personalmodul aktiv ist. Eine M5-Aufgabe enthält zusätzlich zur Legacy-kompatiblen Darstellung nur Workflow-Code, Version, Titel, Fachobjekttyp, generischen Bereichstyp, Fortschritt und aktiven Schritt; Fachobjekt-ID, Personalnummern, Zuweisungsbeleg, Snapshot, Hashwerte und Abschlussnotizen bleiben ausgeschlossen. Der M5-Abschluss akzeptiert strikt `{ action, operationId }`, wobei `action` `complete` oder bei optionalen Schritten `skip` ist und `operationId` eine UUIDv4 sein muss. Ein exakter Replay ist ohne erneute Live-Autorisierung idempotent; abweichende Verwendung derselben Vorgangs-ID wird abgewiesen. Der Erstabschluss prüft eingefrorene Personenzuordnung, aktive Snapshot-Rolle, persönlichen Portalzugang und aktuellen freigegebenen Bereich. M5 speichert keine Abschlussnotiz und erzeugt keine Benachrichtigung. Ist das Personalmodul deaktiviert, bleiben ausschließlich die bisherigen Legacy-Aufgaben sichtbar und bearbeitbar.

## 9. Priorisierter Issue- und PR-Zuschnitt

1. **Architekturvertrag und Feature-Grenze – im Quellstand abgeschlossen**

   Dokumentation, standardmäßig deaktiviertes Installationsmerkmal, zukünftiger API-Namespace und Basistests.
2. **Navigation und Grundseiten – im Quellstand abgeschlossen**

   Bestehende Personalverwaltung um Bewerbungen/Preboarding, Workflow-Center und Personalaufgaben ergänzen; die damaligen Grundseiten wurden mit R1 und M5 in datensparsame read-only Fachansichten überführt.
3. **Bewerber- und Dokumentmodell – Fundament im Quellstand umgesetzt**

   Migrationen, Repositories, Kategorien, Sichtbarkeiten, Metadaten und Historie.
4. **Kontrollierte Einstellung – M3 im Quellstand umgesetzt**

   transaktionale, idempotente Bewerberumwandlung aus `preboarding` mit atomarer Personalnummernreservierung, vollständigem Historienbezug und ausdrücklich zurückgestelltem Onboarding/Workflow.
5. **Bereichsbezogene Fachrechte – R1 im Quellstand umgesetzt**

   Sieben Bewerbungsrechte, PL-/PL+-Trennung, genehmigte Scope-Schnittmenge für FL und AL, datensparsame Projektionen, IDOR-Grenzen und negative Zugriffstests.
6. **Workflow-Publikation und Instanzbindung – M4 und M5 im Quellstand umgesetzt**

   Vorhandene Prozessbasis um unveränderbare Veröffentlichungen, append-only Archivierung, Pflicht-/Ergänzungsauflösung und eigene Bereichsrechte ergänzen; ausschließlich neue kontrollierte Instanzen additiv und idempotent an Veröffentlichung, Fachobjekttyp und eingefrorene Aufgabenverantwortung binden. Keine Legacy-Übernahme und keine Automatisierung.
7. **Mitarbeiterprofil und eingebettete Abläufe**

   Tabs, Onboarding, Schulungen und Offboarding mit vertraulichen Schrittklassen.
8. **Grafischer Editor und Automatisierung**

   erst nach stabilen Domänen-, Rechte- und Versionsgrenzen; Vorschau, Validierung und kontrollierte Trigger.

Jeder PR muss für sich migrierbar und testbar sein. Fachmodell, Persistenz, API, Oberfläche und Tests dürfen innerhalb eines PRs zusammengehören; voneinander unabhängige Automatisierungen werden getrennt gehalten.

## 10. Offene Architekturentscheidungen

Für das Datenfundament, M3 und R1 wurden folgende Entscheidungen festgeschrieben:

- Bewerber verwenden eine eigene UUID-Identität und besitzen keine Personalnummer.
- Bewerbungen verwenden die in Abschnitt 4.1 dokumentierten Status und Übergänge.
- `converted` ist ausschließlich der umgesetzten transaktionalen M3-Umwandlungsaktion vorbehalten.
- Die Vorgangs-ID stammt als UUID v4 vom Client. Ihr kanonischer Request-Hash macht exakte Wiederholungen idempotent und verhindert eine abweichende Wiederverwendung.
- Quelle der Personalnummer ist in M3 die ausdrückliche Eingabe durch die zentral berechtigte Personalstelle. Es gibt weder Nummernautomatik noch vorauseilende Reservierung; das atomare Mitarbeiter-`INSERT` reserviert die Nummer unter der bestehenden `UNIQUE`-Grenze oder lässt die gesamte Transaktion scheitern.
- Die Datenübernahme ist positiv auf Name, Kontakt und Adresse begrenzt. Bewerbungsdaten und bevorzugte Sprache werden nicht in den Personalakt übertragen.
- Bewerberdokumente bleiben beim historischen Bewerberbezug. M3 erzeugt weder Dokumentkopien noch Portalprofil, Zugangsdaten, Onboarding-Version oder Workflow-Instanz.
- Dokumentbinärdaten verwenden den vorhandenen verschlüsselten AMU-Speicher; SQLite hält nur geschützte Metadaten, Integritätswerte und Speicherreferenzen.
- Das Fundament kennt für Bewerberdokumente bewusst keinen Zustand `purged`: Physische Löschung, Anonymisierung oder Crypto-Shredding bleiben bis zu einer dokumentierten Aufbewahrungsentscheidung gesperrt. Archivierte und zur Aufbewahrungsprüfung vorgemerkte Dokumente bleiben in Sicherung und Import enthalten.
- Eine verantwortliche Person muss, sofern angegeben, ein bestehender Mitarbeiter sein; die Bewerbungsquelle bleibt verschlüsselt und wird nicht für Rechte- oder Bereichsentscheidungen verwendet.
- Der R1-Zugriff auf die Bewerber-API setzt ein wirksames Fachrecht voraus; FL und AL benötigen zusätzlich die vollständige Scope-Schnittmenge.
- PL verwendet die bestehende Rolle `hr`; PL+ ist dieselbe Rolle mit der zusätzlichen, nicht weiterdelegierbaren Capability `personnel:candidates:delegate`.
- FL und AL erhalten ausschließlich die lokalen Rechte `personnel:candidates:read` und `personnel:applications:write`. Wirksam ist jeweils nur die Schnittmenge aus allgemeinem Portalbereich und durch PL+ genehmigtem Fachscope.
- FL wirkt ausschließlich für ganze Standorte, AL ausschließlich für exakt passende Standort-/Abteilungspaare. Lokale Leitungen dürfen weder Bewerbungen anlegen noch deren Scope-Felder ändern.
- Vertrauliche Bewerberdaten, Kandidatenstamm, Konversion und Delegation bleiben global. `it_admin` ist für die Bewerberdomäne ausdrücklich ausgeschlossen.
- R1-Rechte und Fachscopes werden ausschließlich über die fachliche Rechteverwaltung geändert; das technische Mitarbeiter-Zugangsprofil darf diese Governance-Grenze nicht umgehen.
- M4 übernimmt keine historischen Revisionen automatisch. Erst eine ausdrückliche Veröffentlichung klassifiziert eine gewählte aktuelle Entwurfsrevision als Personal-Workflow-Version.
- Entwurfsrevision und Veröffentlichungsnummer bleiben getrennt. Jede Veröffentlichung friert Inhalt und Bereich ein und erhält einen eigenen Snapshot- sowie Publikationsbeleg.
- Unternehmensweite Pflichtprozesse und lokale Ergänzungen werden vereinigt. Gleiche Codes oder Titel erzeugen einen Konflikthinweis und niemals einen impliziten Override.
- Vertrauliche und Offboarding-Workflows bleiben in M4 gesperrt, weil ihr Inhalt auch im Entwurfs- und Revisionspfad technisch geschützt werden muss.
- M5 startet ausschließlich ausdrücklich gewählte, nicht archivierte Standard-Veröffentlichungen der freigegebenen Bewerbungs-/Preboarding- und Mitarbeiter-Typen. Freie `custom_personnel`-, Onboarding-, Offboarding- und vertrauliche Workflows sowie Benachrichtigungskanäle bleiben fail-closed zurückgestellt.
- Der Startauftrag enthält für jeden nicht-systemischen Snapshot-Schritt genau eine ausdrückliche Mitarbeiterzuweisung. Diese Person muss einen aktiven persönlichen Portalzugang besitzen, zur eingefrorenen Rollen- oder Personenverantwortung passen und im wirksamen Bereich zulässig sein. M5 wählt bei mehreren möglichen Verantwortlichen niemanden automatisch aus.
- Vorgangs-ID und kanonischer Startauftrag machen den Start idempotent. Exakte Wiederholung liefert dieselbe Instanz; dieselbe Vorgangs-ID mit anderem Inhalt ist ein Konflikt. Bindung und Zuweisungen sind mit SHA-256-Belegen geschützt und unveränderbar.
- M5 übernimmt keine Legacy-Läufe, startet keine Instanz aus der Bewerberumwandlung und enthält keine Frist-, Vertretungs-, Benachrichtigungs- oder Eskalationsautomatik.
- Abweichende Candidate-Schemata mit Fachdaten werden nicht automatisch umgebaut; vor der ersten produktiven Datenhaltung muss für jede Folgestruktur eine verlustfreie, versionierte Migration vorliegen.

Vor den jeweils genannten Folgestufen sind noch schriftlich zu entscheiden:

- Aufbewahrungsfristen und Rechtsgrundlagen je Dokumentkategorie vor einer automatischen Bereinigung,
- Übernahmeregeln für ausgewählte Legacy-Prozesse vor ihrer ersten ausdrücklichen M4-Publikation,
- Vertretungs-, Frist- und Eskalationsregeln vor einem späteren Automatisierungsblock; M5 verwendet ausschließlich explizite, geprüfte Einzelzuweisungen,
- Klassifikation vertraulicher Mitarbeiterprofil- und Offboarding-Daten vor den entsprechenden späteren Fachrechten; die R1-Klassifikation der Bewerberdaten ist abgeschlossen,
- Grenzen zwischen Schulungsnachweis und externer Lernplattform vor dem Mitarbeiterprofil.

Offene Entscheidungen sind keine Erlaubnis für implizite Standardwerte in produktiven Daten. Wo eine Entscheidung fehlt, bleibt die betreffende Mutation gesperrt.

## 11. Test- und Abnahmegrenzen

Neue Kernlogik benötigt mindestens:

- Migrations- und Integritätstests,
- Read-only-Importtests für Altversion, Teilschema, Fremdschlüssel und semantisch manipulierte Zustandsketten,
- Tests der additiven M2→M3-Migration, der sieben Tabellen, elf Trigger und unveränderbaren Umwandlungsbelege,
- Tests der additiven R1-Migration, der achten Tabelle, acht zusätzlichen Scope-Trigger und genehmigten Fachbereiche,
- Zustandsautomaten-, Transaktions-, Personalnummernkonflikt- und Idempotenztests einschließlich abweichender UUID-Wiederverwendung,
- Negativtests für Status ungleich `preboarding`, weitere offene Bewerbungen, veraltete Revisionen, nicht freigegebene Transferfelder sowie unbeabsichtigte Dokument-, Portalprofil-, Onboarding- oder Workflow-Anlage,
- positive und negative Rechte-/Bereichstests,
- IDOR-, Mehrfachbewerbungs-, IT-Admin-, Scope-Schnittmengen- und datensparsame Projektionstests,
- Negativtests für reservierte `local`-Prinzipale, inaktive Organisationseinheiten, parallele Rechteänderungen, unveränderte Freigabezeitpunkte und parsebare Auditdetails,
- Tests für unveränderbare Veröffentlichungen, additive Auflösung, Archivierung und M4-Rechte,
- M5-Tests für additive und idempotente Instanzmigration, Read-only-Import, Veröffentlichungs-/Fachobjektbindung, explizite Schrittzuweisung, konkurrierende Starts, Belegintegrität, Legacy-Sperren, bereichsgefilterte Listen, datensparsame UI-Projektion sowie persönliche Aufgaben und idempotenten Abschluss,
- Dokumentzugriffs-, Historien- und Bereinigungstests erst mit den jeweils freigegebenen Dokument-APIs und Aufbewahrungsregeln,
- UI- und mobile Überlauftests,
- Regressionstests für bestehende Personal-, Dienstplan-, Portal- und Prozessfunktionen.

Das Installationsmerkmal darf erst standardmäßig aktiviert werden, wenn Datenmodell, Rechte, API, Migrationen und die relevanten Abnahmetests vollständig vorliegen. Eine sichtbare Grundseite allein erfüllt diese Freigabe nicht.
