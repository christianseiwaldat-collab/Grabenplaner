# Personalmodul – Bereichsrechte R1 v0.1

Stand: 1. August 2026

Status: verbindlicher R1-Architekturvertrag; im Quellstand umgesetzt, nicht released

Bezug: `PERSONALMODUL-ZIELARCHITEKTUR-v0.1.md`, Issue 5 „Bereichsbezogene Fachrechte“

## 1. Ziel und Geltungsbereich

R1 führt fachliche Rechte für „Bewerbungen & Preboarding“ in das vorhandene Portal-Rechte- und Bereichssystem ein. Es entsteht weder eine zweite Rollenverwaltung noch ein paralleles Scope-Modell.

Der Block schützt:

- Bewerberlisten und Bewerberdetails,
- strukturierte Bewerbungsdaten und Statusänderungen,
- vertrauliche Bewerberdaten,
- die kontrollierte Umwandlung in einen Mitarbeiter,
- die Freigabe lokaler Bewerbungsrechte durch PL+.

Maßgeblich ist immer die serverseitig ermittelte Kombination aus Rolle, wirksamem Fachrecht und wirksamem Bereich. Eine Anzeige, ein ausgeblendeter Button oder eine vom Client übermittelte Capability ist keine Berechtigung.

## 2. Rollenvertrag: PL, PL+, FL und AL

R1 verwendet ausschließlich bestehende Portalrollen:

| Fachbegriff | Portalrolle | Wirkung in R1 |
|---|---|---|
| PL | `hr` | unternehmensweite Fachrolle für Bewerbungen; Rechte bleiben einzeln entziehbar |
| PL+ | `hr` mit `personnel:candidates:delegate` | PL mit zusätzlicher, nicht weiterdelegierbarer Freigabe-Capability |
| FL | `manager` | ausschließlich standortweiter Zugriff in freigegebenen Standorten |
| AL | `department_manager` | ausschließlich Zugriff auf exakt freigegebene Abteilungen eines Standorts |

PL+ ist bewusst keine neue Rolle. Fachliche Nutzung und Weitergabe von Rechten bleiben getrennt: Eine PL kann Bewerbungen vollständig bearbeiten, ohne lokale Rechte vergeben zu dürfen. Das Recht `personnel:candidates:delegate` kennzeichnet PL+ und kann durch PL+ nicht an andere Personen weitergegeben werden.

`admin` und `developer` sind globale, höher geschützte Verwaltungsrollen für diesen Fachbereich. Der lokale Systemzugang bleibt für die lokale Anwendungsverwaltung global. `it_admin` erhält dagegen keinen Bewerberzugriff – auch dann nicht, wenn manipulierte oder veraltete Rechtewerte in eine Sitzung gelangen. Technische Administration begründet keinen Zugriff auf Bewerberdaten.

Andere Rollen, insbesondere `employee` und `location_planner`, bleiben in R1 vollständig ausgeschlossen.

Der interne Kennwert `local` ist keine speicherbare Mitarbeiteridentität. Er wird bei Mitarbeiteranlage, Import, Bewerberumwandlung, Portal-/Mobile-Anmeldung und Datenbankstart fail-closed abgewehrt. Ein lokaler Systemzugriff ist nur mit dem serverintern erzeugten Sitzungsmerkmal `sessionKind = local` plus `localSystem = true` wirksam. IT-Admin darf weder `hr` vergeben noch HR-Konten oder bereits R1-freigegebene FL-/AL-Konten durch Passwort-, Aktivierungs-, Rollen- oder Entsperränderungen übernehmen.

## 3. Rechte-Matrix

| Recht | Fachliche Wirkung | PL | PL+ | FL | AL | Abhängigkeit |
|---|---|---:|---:|---:|---:|---|
| `personnel:candidates:read` | Bewerber und sichtbare Bewerbungen lesen | global | global | Standort | Abteilung | – |
| `personnel:applications:write` | strukturierte Nicht-Scope-Felder und Status bearbeiten; neue Bewerbung nur global anlegen | global | global | Standort | Abteilung | `personnel:candidates:read` |
| `personnel:candidates:write` | Kandidatenstamm zentral verwalten; Bewerbungsneuanlage nur zusammen mit dem Bewerbungsrecht | global | global | nein | nein | `personnel:candidates:read` |
| `personnel:candidates:confidential:read` | PL-vertrauliche Felder, Dokumentmetadaten und vollständige Historie lesen | global | global | nein | nein | `personnel:candidates:read` |
| `personnel:candidates:confidential:write` | PL-vertrauliche Bewerber- und Bewerbungsfelder bearbeiten | global | global | nein | nein | vertrauliches Lesen und Bewerbungen bearbeiten |
| `personnel:candidates:convert` | kontrollierte Einstellung ausführen | global | global | nein | nein | vollständige zentrale Bewerberrechte; zusätzlich `employees:write` und zentrale Mitarbeiteranlage |
| `personnel:candidates:delegate` | lokale Lese-/Bearbeitungsrechte samt Fachbereich freigeben | nein | global | nein | nein | nicht weiterdelegierbar |

„Global“, „Standort“ oder „Abteilung“ setzt jeweils voraus, dass das Recht nach Rollenrechten, individuellen Gewährungen und individuellen Entziehungen tatsächlich wirksam ist. `admin` und `developer` erhalten alle sieben R1-Rechte global; der lokale Systemzugang besitzt die entsprechenden internen Capabilities. Für FL und AL sind ausschließlich `personnel:candidates:read` und `personnel:applications:write` zulässig.

Die Abhängigkeiten werden beim Ändern eines Rechteprofils validiert. Ein Schreibrecht ohne das zugehörige Leserecht, ein vertrauliches Schreibrecht ohne vertrauliches Leserecht oder ein Umwandlungsrecht ohne seine Voraussetzungen wird nicht als teilweise gültiges Profil gespeichert.

## 4. Verbindliche Scope-Schnittmenge

Für lokale Leitungen gilt pro Recht:

`wirksamer Bereich = allgemeiner Portalbereich ∩ durch PL+ freigegebener Fachbereich`

Beide Seiten sind erforderlich:

1. `portal_access_scopes` beschreibt den allgemeinen organisatorischen Verantwortungsbereich der Person.
2. `portal_permission_scope_grants` beschreibt den von PL+ für ein bestimmtes R1-Recht freigegebenen Fachbereich.

Ein Fachbereich ohne allgemeinen Portalbereich öffnet nichts. Ein allgemeiner Portalbereich ohne Fachfreigabe öffnet ebenfalls nichts. Jede Fachfreigabe benötigt eine nicht leere Genehmigungsidentität `approved_by`; fehlt sie oder ist der Bereich strukturell ungültig, bleibt der Zugriff geschlossen.

Inaktive Standorte und Abteilungen sind niemals berechtigungswirksam. Browser-, Mobile- und Organisationssitzungen filtern sie bei jeder Projektion aus; neue Rechte- und Scope-Zuweisungen auf inaktive Organisationseinheiten werden abgewiesen.

### 4.1 FL

Für `manager` sind nur standortweite Einträge gültig. Persistiert wird der ganze Standort mit `department_id = 0`; in der Anwendungsprojektion entspricht dies `departmentId = null`. Eine FL darf damit Bewerbungen aller Abteilungen dieses Standorts sehen beziehungsweise bearbeiten, aber keine Bewerbung eines anderen Standorts. Ein nur abteilungsbezogener Eintrag macht für eine FL kein Recht wirksam.

### 4.2 AL

Für `department_manager` müssen Standort und konkrete Abteilung auf beiden Scope-Seiten exakt übereinstimmen. Ein standortweiter Eintrag erweitert eine AL nicht. Eine Abteilung ist nur gültig, wenn sie dem angegebenen Standort zugeordnet ist.

### 4.3 Mehrfachbewerbungen und unveränderlicher Lokalbereich

Die Sichtbarkeit wird je Bewerbung und nicht pauschal je Bewerber entschieden. Hat ein Bewerber Bewerbungen in mehreren Bereichen, enthält die lokale Projektion ausschließlich die passenden Bewerbungen. Ist keine Bewerbung sichtbar, wird auch der Bewerber nicht ausgeliefert.

FL und AL dürfen weder eine neue Bewerbung anlegen noch Standort oder Abteilung einer bestehenden Bewerbung verändern. Für lokale Leitungen umfasst `personnel:applications:write` ausschließlich strukturierte Nicht-Scope-Felder bereits sichtbarer Bewerbungen und erlaubte Statuswechsel. Neuanlage und jede Änderung des Bewerbungsbereichs bleiben einer global berechtigten PL-Aktion vorbehalten. Damit kann eine lokale Leitung ein Objekt weder aus einem fremden Bereich „hereinholen“ noch aus dem eigenen Bereich verschieben.

## 5. Datenminimierung und Vertraulichkeit

Die API verwendet positive Feldlisten. Zusätzliche Felder eines Datenbank- oder Domänenobjekts werden nicht automatisch Teil der Antwort.

| Zugriff | Bewerberprofil | Bewerbungen | Ausdrücklich nicht enthalten |
|---|---|---|---|
| lokale Liste | Vorname, Nachname | nur sichtbare, strukturierte Bewerbungen | Kontakt, Anschrift, Sprache, Quelle, Bewertung, Notizen, Kommunikation, Tags, Dokumente, Historie, Konversion, Akteure und Hashwerte |
| lokales Detail | Vorname, Nachname, E-Mail, Telefon | nur sichtbare, strukturierte Bewerbungen | Anschrift und alle vertraulichen beziehungsweise internen Felder wie oben |
| global ohne vertrauliches Leserecht | datensparsame Listen-/Detailprojektion | alle Bewerbungen, aber nur strukturierte Felder | vertrauliche Felder, Dokumente, Historie, Konversion und interne Belege |
| global mit vertraulichem Leserecht | vollständige berechtigte Fachprojektion | vollständig | nur weiterhin durch andere technische Schutzgrenzen ausgeschlossene Rohdaten |

Die strukturierte Bewerbungsprojektion ist auf Identität und Kandidatenbezug, Status, Zielposition, Zielstandort, Zielabteilung, gewünschte Wochenzeit, Verfügbarkeit, Rollenbezeichnung, Beschäftigungsart, Revision und fachliche Zeitstempel begrenzt. Eigentümer, Aufbewahrungsdaten, Quelle, interne Bewertung, Notizen, Kommunikation, Tags, Ersteller-/Änderungsakteure sowie Request- und Beleg-Hashes werden lokalen Leitungen nicht geliefert.

Vertrauliche PL-Daten werden damit in Repository-Zugriffsprojektion, serverseitiger Policy und Antwortprojektion geschützt, nicht nur in der Oberfläche. Für bereichsgebundene Listen werden zunächst ausschließlich unverschlüsselte Zugriffsköpfe und Anwendungsbereiche geladen. Geschützte Payloads werden erst für Bewerber entschlüsselt, die diese Objektprüfung bestanden haben. Eine lokale UI erhält die ausgeschlossenen Felder nicht und kann sie daher auch nicht durch DOM-Manipulation sichtbar machen.

## 6. Schutz gegen IDOR und unzulässige Mutationen

Für jeden Endpunkt gelten folgende Objektgrenzen:

1. Die Sitzung wird serverseitig geladen; Rollen, Rechte, Bereiche und Capabilities werden nicht aus dem Request-Body übernommen.
2. Eine übermittelte Bewerber- oder Bewerbungs-ID ersetzt keine Objektberechtigungsprüfung.
3. Listen, Details und Mutationen prüfen das jeweils erforderliche R1-Recht.
4. FL und AL müssen zusätzlich den gespeicherten Objektbereich erfüllen; eine lokale Neuanlage sowie jede Änderung von Standort oder Abteilung sind gesperrt.
5. Fremde Bewerbungen eines grundsätzlich sichtbaren Bewerbers werden vor der Antwort entfernt.
6. Fehlt bereits das Fachrecht, antwortet die API geschlossen. Liegt lediglich das angeforderte Objekt außerhalb des wirksamen Bereichs, darf die Antwort dessen Existenz nicht offenlegen.
7. Die Umwandlung bleibt global und übernimmt weiterhin nur die in der Zielarchitektur freigegebenen Felder.

Die Browser-Capabilities steuern lediglich die Bedienoberfläche. Sämtliche Regeln werden unabhängig davon am API-Endpunkt erneut geprüft.

## 7. Audit und Rechteänderungen

Rechte- und Scope-Änderungen werden über die bestehende Rechteverwaltung ausgeführt. Verbindlich sind:

- R1-Rechte und ihre Fachscopes dürfen ausschließlich über den fachlichen Rechteendpunkt geändert werden; das technische Mitarbeiter-Zugangsprofil und der IT-Admin dürfen diesen Pfad nicht umgehen.
- Akteur, Zielperson, Recht, freigegebener Bereich und Zeitpunkt bleiben nachvollziehbar.
- `approved_by` wird aus der authentifizierten Freigabeidentität erzeugt und nicht aus einer frei vertrauenswürdigen Clientangabe übernommen.
- Recht, Fachscope und Audit werden gemeinsam gespeichert; ein Fehler darf keinen halben Freigabezustand hinterlassen.
- Wird ein allgemeiner Portalbereich verkleinert oder entfernt, werden nicht mehr gedeckte Fachscopes automatisch entfernt.
- Jeder weitere Pfad, der Rolle, Recht oder allgemeinen Portalbereich verändert und dadurch Fachscopes entfernt, protokolliert den Fachscope-Zustand vor und nach der Änderung in derselben Transaktion.
- Wird das individuelle Fachrecht entfernt, entfernt die Fremdschlüsselgrenze auch seine Fachscopes.
- Nach Rechteänderungen werden bestehende Sitzungen der Zielperson nach dem etablierten Rechteverwaltungsvertrag widerrufen beziehungsweise neu bewertet.
- Auditdetails enthalten keine Kontaktwerte, Notizen, Dokumentinhalte, geschützten Payloads oder kryptografischen Rohbelege.

Rechte-, Scope- und Rollenmutationen lesen Zielkonto und geschützten R1-Zustand innerhalb derselben serialisierbaren Transaktion erneut. Das gilt providerneutral auch für den vorbereiteten PostgreSQL-Pfad; ein Serialisierungskonflikt endet kontrolliert mit `PERSONNEL_LIFECYCLE_SCOPE_CONCURRENT_CHANGE` und `Retry-After`, ohne Änderungen zu speichern. Dieselbe Live-Prüfung schützt technische Mitarbeiter-Zugangsprofile, direkte Deaktivierungen und den Personalimport vor einem zwischenzeitlich hinzugekommenen R1-Recht. Mitarbeiteranlage, -änderung und Personalimport revalidieren in ihrer Schreibtransaktion zusätzlich Kostenstelle, Kostenstellentyp, abgeleiteten Standort, Abteilung und Positionsfreigabe. Eine inzwischen inaktive neue Zuordnung wird nicht gespeichert; eine bereits bestehende archivierte Zuordnung darf unverändert bleiben, damit historische Personalstämme weiterhin kontrolliert gepflegt werden können. Unveränderte allgemeine Scopes, individuelle Rechte und PL+-Fachscopes werden per Set-Diff nicht neu geschrieben; insbesondere bleiben `approved_by`, `created_at` und `updated_at` unverändert. Auditdetails der Rechte-, Scope- und Rollenpfade bleiben auch bei großen Rechteprofilen valides JSON unterhalb der Persistenzgrenze und verwenden dafür Zähler sowie SHA-256-Fingerprints.

Erfolgreiche Bewerberlisten, Bewerberdetails und die realisierten Personal-Lifecycle-Mutationen bleiben nach dem bestehenden Vertrag auditiert. Die zentralen R1-Berechtigungs- und Objektbereichsablehnungen sowie Rechte- und Scope-Mutationen werden datensparsam und ohne Offenlegung des angeforderten Fremdobjekts protokolliert. Damit ist nicht pauschal zugesagt, dass jeder rein lesende Kategorienabruf oder jede innerhalb einer Route mögliche `403`-Abzweigung ein eigenes Audit-Ereignis erzeugt.

## 8. Datenbankmigration R1

Die additive SQLite-Migration trägt den Marker:

`v0.89-personnel-lifecycle-scoped-rights`

Sie ergänzt `portal_permission_scope_grants` mit:

- Zielperson und Recht,
- Standort und optionaler Abteilung (`0` bedeutet ganzer Standort),
- verpflichtender Genehmigungsidentität,
- Erstellungs- und Änderungszeitpunkt,
- zusammengesetzter Eindeutigkeitsgrenze je Person, Recht und Bereich.

Im ursprünglichen R1-Stand ist die Tabelle auf die beiden lokal zulässigen Rechte `personnel:candidates:read` und `personnel:applications:write` begrenzt. Die additive M4-Migration erweitert denselben Scope-Träger anschließend ausschließlich um `personnel:workflows:read`, `personnel:workflows:draft:write`, `personnel:workflows:publish` und `personnel:workflows:local:supplement`; Bewerbungs- und Workflow-Rechte bleiben dabei getrennte Fachverträge. Fremdschlüssel binden jede Freigabe an das individuelle Recht und den Standort. Acht Schutztrigger prüfen Standort-/Abteilungsbezüge, verhindern Fachscopes außerhalb der allgemeinen Portalbereiche, bereinigen Fachscopes nach einer Scope-Verkleinerung und schützen referenzierte Abteilungen vor inkonsistenten Änderungen.

Start- und Importprüfung behandeln ein partielles, abweichendes oder fachlich inkonsistentes R1-Schema fail-closed. Vor einer notwendigen Migration beziehungsweise Reparatur gilt weiterhin der bestehende Pre-Migration-Sicherungspunkt. Die Änderung ist additiv; Bewerber-, Bewerbungs-, Dokument- und Umwandlungsdaten werden nicht neu aufgebaut.

SQLite bleibt der unterstützte Produktprovider. R1 behauptet keine PostgreSQL-Parität und keine Freigabe für produktiven PostgreSQL-Betrieb.

Zusätzlich schützen zwei anwendungsweite SQLite-Trigger `employees.personnel_number` vor dem reservierten Prinzipal `local` (case-insensitiv und umgeben von ASCII-Leerraum einschließlich TAB, CR und LF). Der Start- und Importpfad verwenden dieselbe Normalisierung für vorhandene Daten; ein Bestandskonflikt stoppt mit `EMPLOYEE_PRINCIPAL_RESERVED` und wird nicht automatisch umbenannt oder gelöscht. Diese beiden Trigger gehören zur Identitätshärtung der Mitarbeitertabelle und erhöhen nicht die acht R1-Scope-Trigger.

Der bei jedem SQLite-Start kanonisch erneuerte Bestands-Trigger `trg_employees_cost_center_update` unterscheidet nun zwischen Beibehalten und Neuzuordnen: Eine tatsächliche Änderung auf eine fehlende oder archivierte Kostenstelle bleibt gesperrt; das unveränderte Speichern einer bereits archivierten Zuordnung ist zulässig. Dafür wird kein zusätzlicher Tabellen- oder R1-Migrationsmarker eingeführt, weil ausschließlich die bestehende kanonische Triggerdefinition verlustfrei erneuert wird.

## 9. API-Änderungen

Die vorhandenen Endpunkte unter `/api/portal/v1/personnel-lifecycle/...` verwenden in R1 die neuen aktionsbezogenen Fachrechte und verlassen sich nicht mehr allein auf die bisherige pauschale Kombination aus zentralen und sensiblen Personalrechten. Für globale Zugriffe bleiben `personnel:central:*`, `personnel:sensitive:*` und bei der Konversion `employees:write` als zusätzliche bestehende Schutzgrenzen erhalten.

| API-Aktion | Mindestrecht | zusätzliche Grenze |
|---|---|---|
| Dokumentkategorien lesen | `personnel:candidates:confidential:read` | ausschließlich global; nur freigegebene Metadaten |
| Bewerberliste/-detail lesen | `personnel:candidates:read` | serverseitige Bereichs- und Feldprojektion |
| Bewerber anlegen/Profil ändern | `personnel:candidates:write` | global; eingebettete erste Bewerbung zusätzlich nur mit `personnel:applications:write` |
| Bewerbung anlegen, auch eingebettet in eine Bewerberanlage | `personnel:candidates:write` und `personnel:applications:write` | ausschließlich global/zentral; Lesen erforderlich |
| Nicht-Scope-Felder ändern/Status setzen | `personnel:applications:write` | global oder passende Scope-Schnittmenge; FL/AL nur bei bereits sichtbaren Bewerbungen |
| vertrauliche Felder lesen/schreiben | entsprechendes `confidential:*`-Recht | ausschließlich global |
| Bewerber umwandeln | `personnel:candidates:convert` | global; vollständige Abhängigkeits- und M3-Prüfung |

Listen- und Detailantworten liefern zusätzlich ein datensparsames Top-Level-Objekt `capabilities`. Der öffentliche Vertrag enthält:

- `scope`,
- `canReadCandidates`,
- `canWriteCandidates`,
- `canWriteApplications`,
- `canReadConfidential`,
- `canWriteConfidential`,
- `canConvert`.

`canConvert` ist der öffentliche Alias der internen Capability `canConvertCandidates`. Die Delegations-Capability wird über diesen Fachdatendpunkt nicht veröffentlicht. Fehlt das Capability-Objekt oder ein einzelner boolescher Wert, behandelt die Oberfläche ihn geschlossen als `false`.

`scope.type` ist `global`, `location`, `department` oder `none`. Bereichsgebundene Antworten nennen ausschließlich die wirksamen `locationIds` beziehungsweise `departmentIds`; Genehmigungsidentitäten und interne Grant-Zeilen gehören nicht in die Bewerberantwort.

Die Rechteverwaltungsprojektion erhält die genehmigten Fachscopes mit Recht, Standort, Abteilung und Genehmigungsidentität. Interne Rohzeilen oder fremde Fachscopes werden nicht als Bewerberdaten ausgegeben.

Schreibende Mitarbeiter- und Importendpunkte prüfen ihre Organisationsreferenzen innerhalb derselben serialisierbaren Transaktion wie den Write. Ein konkurrierender Unique-Konflikt beim Import antwortet kontrolliert mit `409` und `IMPORT_PREVIEW_STALE`; die Importvorschau bleibt für einen erneuten Versuch erhalten. Browser-Sitzungen von deaktivierten Beschäftigten werden auch dann nicht mehr aufgelöst, wenn ein inkonsistenter Altbestand den Portalzugang oder die Sitzung noch als aktiv führt.

## 10. Verifikation

R1 wird mindestens durch folgende Testgruppen abgesichert:

- exakter Rechte- und Rollenvertrag,
- PL gegenüber PL+ und nicht weiterdelegierbare Freigabe,
- vollständige Ablehnung von `it_admin` auch mit injizierten Fachrechten,
- fehlendes Recht, fehlender allgemeiner Scope, fehlender Fachscope und fehlendes `approved_by`,
- standortweite FL- und abteilungsgenaue AL-Schnittmengen,
- Mehrfachbewerbungen, fremde Objekt-IDs und gesperrte lokale Bereichswechsel,
- positive Feldlisten und Ausschluss vertraulicher Schlüssel,
- Rechteabhängigkeiten, Audit und Sitzungswiderruf,
- Paralleländerungs-, Set-Diff-, Audit-JSON-, inaktive-Bereichs-, Import-Race-, Altzuordnungs- und reservierter-`local`-Negativtests,
- additive Migration, Schema-/Zeilenintegrität und Read-only-Importprüfung,
- Regressionen der bestehenden Personalverwaltung und Rechteverwaltung.

## 11. Grenzen dieses Blocks

R1 umfasst ausschließlich Bewerbungen und Preboarding. Nicht Bestandteil sind:

- Workflow-Definitionen, Veröffentlichungen, Versionen und Instanzen,
- lokale Workflow-Rechte, Pflichtprozessauflösung und Freigabewege,
- Mitarbeiterprofil-Tabs sowie eingebettetes Onboarding, Schulungen und Offboarding,
- vertrauliche Offboarding-Schrittklassen,
- Dokument-Upload, -Download, Vorschau, Transfer oder physische Bereinigung,
- grafischer Workflow-Editor, Benachrichtigungen und Automatisierungen,
- eine produktive PostgreSQL-Umsetzung.

Repository-Zugriffsprojektion, serverseitige Policy und positive Antwortprojektion bilden gemeinsam die verbindliche R1-Schutzgrenze. `listCandidateAccessHeaders(...)` liefert für die Vorselektion nur Identität, Zustand, Revision und Zeitstempel; `listApplicationAccessScopes(candidateId)` liefert nur die strukturellen Bewerbungsbereiche und keine geschützten Payloads. Erst anschließend werden ausschließlich berechtigte Bewerber über die bestehende Fachprojektion geladen und entschlüsselt.

Das Installationsmerkmal `personnelLifecycle` bleibt standardmäßig deaktiviert. R1 ist im Quellstand umgesetzt, nicht released und keine Produktivfreigabe. R1 selbst begann den Workflow-Ausbau nicht; die Publikations- und Workflow-Rechtegrenze wurde inzwischen getrennt als M4-Fundament umgesetzt und in `PERSONALMODUL-WORKFLOW-PUBLIKATION-M4-v0.1.md` dokumentiert. Die Instanzbindung bleibt als M5 ausdrücklich offen.
