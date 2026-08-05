# Personalmodul Onboarding/Offboarding – O5 Vertrauliches Offboarding v0.1

- Stand: 3. August 2026
- Status: lokal implementierter und technisch geprüfter O5-Vertrag; nicht veröffentlicht und nicht produktiv aktiviert
- Vorgänger: `PERSONALMODUL-ONBOARDING-OFFBOARDING-O4-KONTROLLIERTE-AUSFUEHRUNG-v0.1.md`
- Konzeptbasis: `PERSONALMODUL-ONBOARDING-OFFBOARDING-FACHKONZEPT-v1.0.md`

## 1. Ergebnis und Blockgrenze

O5 ergänzt den eigenständigen vertraulichen Offboarding-Pfad. Eine ausdrücklich fachberechtigte zentrale Person kann einen Austritt zunächst intern vorbereiten, ohne operative Instanzen, Aufgaben, Badges, Benachrichtigungen oder externe Aktionen zu erzeugen. Erst die eigene Kommunikationsfreigabe legt atomar genau sechs opake Pflichtaufträge an. Diese werden den einzeln ausgewählten internen Fachpersonen ausschließlich als minimale, aufgabenbezogene Projektionen angezeigt.

Der Block führt keine Konto-, Berechtigungs-, Schlüssel-, Geräte-, Lohnverrechnungs-, Behörden- oder sonstige Außenaktion aus. Alle sechs Familien bleiben menschlich zu bestätigende interne Aufträge. O5 enthält keine Automatik für Fristen, Empfänger, Benachrichtigungen, Eskalationen oder Integrationen.

Die parallel entwickelte Verkaufsverwaltung bleibt fachlich, technisch und im Arbeitsstand getrennt. O5 verändert ihren Arbeitsbaum nicht.

## 2. Zustandsfolge

Der kanonische Offboarding-Fall verwendet ausschließlich:

`internally_prepared -> communication_released -> employee_informed -> active -> completed`

`cancelled` ist ein terminaler Abbruchzustand. Ein terminaler Fall wird nicht wieder geöffnet. Ein zulässiger Neustart erzeugt einen neuen Fall mit Vorgängerbezug.

Die Beschäftigungsepisode bleibt während der rein internen Vorbereitung `employment_active`. Mit der Kommunikationsfreigabe wechselt sie atomar nach `exit_in_progress`. Ein Abbruch nach Freigabe führt sie nach `employment_active` zurück; der fachliche Abschluss setzt sie auf `employment_ended`.

## 3. Rechte und benannte Identität

Die vertrauliche Fallansicht benötigt gleichzeitig:

- `personnel:central:read` und
- `personnel:lifecycle:offboarding:confidential:read`.

Die Aktionen benötigen zusätzlich jeweils ihr eigenes Recht:

- Vorbereitung: `personnel:lifecycle:offboarding:prepare`, Paket-Leserecht und Zuweisungsrecht,
- zeitkritische Ausnahmefreigabe: `personnel:lifecycle:exceptions:approve`,
- Kommunikationsfreigabe: `personnel:lifecycle:offboarding:communication:release`, Paket-Leserecht und Zuweisungsrecht,
- Informationsbestätigung: `personnel:lifecycle:offboarding:information:confirm`,
- Aktivierung: `personnel:lifecycle:offboarding:execute`,
- Abschluss oder Abbruch: `personnel:lifecycle:offboarding:close` sowie das für den jeweiligen Zustandsübergang erforderliche Vorbereitungs- oder Freigaberecht.

Ein Rollenname, technischer Administratorzugang, lokales Systemkonto, geteiltes Konto oder Dienstkonto gewährt keine dieser Fachaktionen. Dieselbe ausdrücklich berechtigte Person darf vorbereiten und freigeben; O5 erzwingt kein Vier-Augen-Prinzip. Ein Developer kann fachlich gleich handeln, aber nur als aktives benanntes persönliches Konto mit allen erforderlichen Einzelrechten.

## 4. Rein interne Vorbereitung

Die Vorbereitung erfolgt über:

`POST /api/portal/v1/personnel-lifecycle/employees/:employeeNumber/offboarding-preparations`

Die Personalnummer und die verantwortliche Akteur-ID stammen ausschließlich aus dem serverseitig geprüften Routen- und Sitzungskontext. Gleichnamige Body-Felder werden abgewiesen.

Der Auftrag enthält:

- eine neue UUIDv4 als `operationId`,
- `PREPARE_OFFBOARDING`,
- geplanten Austrittszeitpunkt, letzten Arbeitstag, rechtliches Austrittsdatum und Zugriffssperrzeitpunkt,
- Standard- oder zeitkritischen Modus,
- strukturierten geschützten Austrittsgrund,
- optionalen vertraulichen PL-Vermerk und geschützte Dokumentreferenzen sowie
- genau eine ausdrückliche Einzelzuweisung für jede der sechs Pflichtfamilien.

Vor der Kommunikationsfreigabe existieren ausschließlich Fall, Referenztermine, geschützter Plan, Ereignis- und Operationsbeleg sowie die getrennte vertrauliche Zugriffsspur. Es entstehen insbesondere keine Runs, Laufzeitschritte, Laufzeitbindungen, operativen Zuweisungen, allgemeinen Aufgaben, Zähler, Kalenderobjekte oder Benachrichtigungen.

## 5. Sechs unverzichtbare Pflichtfamilien

O5 erzeugt genau diese Familien:

| Code | Empfängerklasse | Minimale Aufgabenprojektion |
|---|---|---|
| `hr_contract_end` | Lohnverrechnung/PL | `payroll_task` |
| `communication_release_information` | Leitung | `leadership_task` |
| `accounts_permissions` | IT/Security | `it_security_task` |
| `work_access_assets` | Arbeitsmittelverantwortung | `asset_task` |
| `handover_open_responsibilities` | Leitung | `leadership_task` |
| `closing_documents_follow_up` | Lohnverrechnung/PL | `payroll_task` |

Die austretende Person darf keine dieser internen Aufgaben erhalten. Jede Zuweisung wird gegen aktive persönliche Identität, aktuelle operative Rechte, zulässige Empfängerklasse und Organisationsbereich geprüft. Eine Person darf bewusst mehrere Familien übernehmen; eine automatische Vorauswahl findet nicht statt.

## 6. Kommunikationsfreigabe und Information

Die Freigaben verwenden getrennte Endpunkte:

- `POST .../offboarding/cases/:caseId/time-critical-approvals`,
- `POST .../offboarding/cases/:caseId/communication-releases`,
- `POST .../offboarding/cases/:caseId/information-confirmations` und
- `POST .../offboarding/cases/:caseId/activations`.

Ein zeitkritischer Fall benötigt vor der Kommunikationsfreigabe einen eigenen Freigabebeleg mit `exceptions:approve`. Der Ausnahmeweg verkürzt keine Pflichtfamilie und entfernt keine Kontrolle.

Die Kommunikationsfreigabe prüft Plan, Empfänger, Rechte, Revision und Belege erneut. In einer serialisierbaren Alles-oder-nichts-Transaktion entstehen genau sechs unveränderlich gebundene O5-Runs mit jeweils einem zunächst `pending` geführten Schritt und einer Einzelzuweisung. Erst danach ist der Fall `communication_released` und die Episode `exit_in_progress`.

`pending` bedeutet sichtbar, aber nicht ausführbar. Nach der dokumentierten persönlichen Information wechselt der Fall nach `employee_informed`. Erst die eigene Aktivierungsaktion setzt alle sechs Schritte auf `active`.

## 7. Minimale Aufgabenprojektionen

Zugewiesene Fachpersonen benötigen `personnel:lifecycle:operational:read`; für den Abschluss zusätzlich `personnel:lifecycle:operational:update`. Sie benötigen kein Recht auf den vertraulichen Offboarding-Fall. Zuweisung, aktueller Bereich und beide operativen Rechte werden bei jedem Lesen und Schreiben erneut geprüft.

Die Aufgaben-API lautet:

- `GET /api/portal/v1/personnel-lifecycle/offboarding/tasks`,
- `POST /api/portal/v1/personnel-lifecycle/offboarding/tasks/:runId/:stepId/completions`.

Sie liefert nur opake Run-, Schritt- und Auftragsbezüge sowie die positive Feldliste der jeweiligen O1-Projektion. Fall-ID, Austrittsgrund, PL-Vermerk, Dokumentreferenzen, geschützte Anweisung und andere Familien werden nicht ausgegeben. Die URL enthält keinen Mitarbeiter- oder Fallbezug.

Eine Aufgabe kann ausschließlich mit eigener UUIDv4 und `action: "complete"` abgeschlossen werden. `evidenceReference` darf transportseitig nur fehlen oder `null` sein und wird nicht als Nachweis gespeichert. `skip`, `not_applicable`, Ausnahme, Freitext und Nachweisverknüpfung sind nicht Teil von O5.

## 8. Abbruch und Abschluss

Der Abbruch verwendet:

`POST .../offboarding/cases/:caseId/cancellations`

Vor der Kommunikationsfreigabe beendet er nur den vertraulichen Fall; Laufzeitobjekte existieren nicht. Nach der Freigabe werden alle noch offenen Runs additiv terminiert. Es wird kein Schritt übersprungen, gelöscht, umgeschrieben oder als erledigt ausgegeben. Bereits dokumentierte Vorgänge bleiben erhalten. Die Beschäftigungsepisode kehrt nach `employment_active` zurück.

Der Abschluss verwendet:

`POST .../offboarding/cases/:caseId/closures`

Er ist nur im Zustand `active` zulässig, wenn genau sechs gebundene Runs, sechs Einzelzuweisungen und sechs Schritte vorhanden und vollständig `completed` sind, kein Schritt `skipped` ist und keine Run-Terminierung besteht. Der Fall wechselt nach `completed`, die Episode nach `employment_ended`.

## 9. Idempotenz und Nebenwirkungsfreiheit

Jede Mutation besitzt eine eigene UUIDv4 und einen kanonischen Request-SHA-256. Eine exakte Wiederholung durch denselben Akteur liefert das gespeicherte Ergebnis mit Replay-Kennzeichnung. Dieselbe Vorgangs-ID mit anderem Inhalt, Bezug oder Akteur wird abgewiesen.

Abgewiesene Rechte-, CSRF-, Revisions-, Zustands-, Empfänger- oder Integritätsprüfungen erzeugen keinen fachlichen Teilfortschritt. O5 schreibt keine Portalnachricht, keinen Versandauftrag und keinen Integrationsauftrag.

## 10. Schutz, Zugriffsspur und HTTP-Grenze

Plan, Referenztermine, Fallereignisse, Operationsresultate, Paketdefinitionen, operative Auftragsinhalte und Abbruchgründe werden in kontextgebundenen `enc:v2:`-Schutzumschlägen gespeichert. Kanonische SHA-256-Belege sichern Plan, Scope, Version, Bindung, Laufzeit, Zuweisung, Ereigniskette, Operation und Abschlussrelation.

Jeder erfolgreiche Lesezugriff auf die vertrauliche Fallprojektion erzeugt einen eigenen append-only und selbst verketteten Zugriffsbeleg. Diese Spur ist von `audit_log` getrennt. Allgemeines Audit erhält weder Fall-ID noch Personalnummer, Austrittsgrund, PL-Vermerk, Dokumentreferenz oder geschützte Nutzlast.

Vertrauliche Profil-, Aktions- und Aufgabenantworten verwenden `Cache-Control: no-store`, `Pragma: no-cache` und keinen ETag.

## 11. Profil und Bediengrenzen

Das Offboarding-Register wird nur mit dem eigenen vertraulichen Leserecht geladen. Ohne aktiven Fall zeigt es die serverseitig ermittelte Vorbereitung mit sechs empfängerklassenspezifischen Kandidatenlisten. Mit aktivem Fall zeigt es ausschließlich den vertraulichen Fall, Referenztermine, Dringlichkeit, sechs Auftragsstände und die im aktuellen Zustand tatsächlich erlaubten Aktionen.

Profilwechsel, Tabwechsel, Rechteverlust, Fehler, Abmeldung und Schließen entfernen die vertrauliche Projektion und laufende Antworten aus Clientzustand und DOM. Operative Aufgaben werden separat geladen und bei Identitäts-, Rechte- oder Bereichsänderung ebenfalls verworfen. Die Oberfläche bietet keine Felder für Überspringen, Nichtanwendbarkeit, fachliche Nachweise oder Außenaktionen.

## 12. SQLite- und M5-Abgrenzung

O5 verwendet additive SQLite-Sidecars für geschützte Paketversionen, Archive, Operationsbelege, Paketbindungen, Run-Bindungen, Laufzeitschritte, Zuweisungsbindungen und additive Run-Terminierungen. Die Migration setzt den vollständigen O4-Vorgänger voraus und prüft Schema, Trigger, Fremdschlüssel, Schutzumschläge, Belege und Laufzeitrelationen.

O5-Runs bleiben aus den allgemeinen M4-/M5-Listen und Mutationspfaden ausgeschlossen. Sie erhalten weder generische `custom_process_run_bindings` noch generische `custom_process_run_step_assignments`. Nur die dedizierten O5-Routen dürfen ihre kontrollierten Zustandswechsel ausführen.

Eine produktive PostgreSQL-Migration oder Provideraktivierung ist nicht Bestandteil von O5. Der PostgreSQL-Katalog bleibt für O5 fail-closed.

## 13. Ausdrücklich nicht enthalten

- automatische Austrittserkennung oder automatischer Start,
- automatische Empfänger-, Termin- oder Fallentscheidung,
- Mitarbeiter-Self-Service-Aufgaben,
- Benachrichtigungen, Kalenderobjekte, Erinnerungen, Eskalationen oder Vertretung,
- Upload, fachliche Nachweise, Freitextabschluss, `skip` oder `not_applicable`,
- Konto-, Rollen-, Schlüssel-, Zutritts-, Geräte-, Arbeitsmittel- oder Lohnverrechnungsautomation,
- E-Mail, SMS, WhatsApp, Push oder externe API-Aufträge,
- Export oder UI der vertraulichen Zugriffsspur,
- Aufbewahrungs-, Lösch- oder Anonymisierungsautomation,
- produktive PostgreSQL-Aktivierung,
- Bestandteile der parallel entwickelten Verkaufsverwaltung sowie
- Commit, Push, Release oder VPS-Aktualisierung.

## 14. Technische Prüfung

Die Schlussprüfung umfasst mindestens:

- Vertrags-, Service-, Rechte- und Projektions-Negativtests,
- echte SQLite-Migration, Trigger-, Receipt- und Row-Inspektion,
- HTTP-Integration von Vorbereitung, Abbruch, Neustart, Ausnahmefreigabe, Kommunikation, Information, Aktivierung, Aufgaben und Abschluss,
- CSRF-, Actor-, Rechte-, Scope-, Body-Injection-, Replay- und Revisionsprüfungen,
- Nachweis, dass vor Kommunikationsfreigabe keine Laufzeit entsteht,
- Nachweis der sechs `pending`- und später `active`-Aufträge,
- Nachweis minimaler Projektionen ohne vertrauliche Felder,
- Nachweis fehlender generischer M5-Bindungen und externer Nebenwirkungen,
- Start-/Import-/Provider- und Persistenz-Coupling-Audit,
- vollständige serielle Regression und `git diff --check` sowie
- interaktive Browserprüfung der Desktop- und 320-Pixel-Grenze, sofern die lokale Browsersteuerung verfügbar ist.

Der abgeschlossene lokale Schlusslauf vom 3. August 2026 ergab:

- O5-Kernverbund: 49/49 erfolgreich, darunter HTTP-/SQLite-End-to-End 7/7 und echter Service-/SQLite-Abschluss samt Abbruch/Replay 2/2,
- Personal-Lifecycle-, Profil-, Portal- und Sicherheitsverbund O1 bis O5: 254/254 erfolgreich,
- vollständige serielle Projektsuite: 1.864 Tests, davon 1.824 erfolgreich, 40 bewusst übersprungen und 0 fehlgeschlagen,
- Persistenz-Coupling-Audit: erfolgreich, 0 unklassifizierte Dateien, 0 Phasengrenzverletzungen und 0 rohe Fachzugriffe,
- PostgreSQL-Vertrag: 1.013 katalogisierte Statements, 907 portable und 106 weiterhin fail-closed übersteuerte Statements; produktive Vollanwendung 0/1.013,
- Syntaxprüfung und `git diff --check`: erfolgreich.

Für die interaktive Browserprüfung wurde eine isolierte, synthetische Loopback-Testinstanz gestartet. In der aktuellen Codex-Sitzung war jedoch kein steuerbarer Browser verbunden. Deshalb wird die interaktive Desktop-/320-Pixel-Browserabnahme ausdrücklich nicht als durchgeführt bezeichnet. Die automatisierten UI-, Rechteverlust- und 320-Pixel-Grenztests sind im grünen Teststand enthalten.

Dieser lokale Implementierungsstand ist keine Commit-, Release-, Deploy- oder Produktivfreigabe.
