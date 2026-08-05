# Personalmodul Onboarding/Offboarding – O3 Profilvorschau v0.1

- Stand: 3. August 2026
- Status: lokal umgesetzt und vollständig geprüft; nicht veröffentlicht und nicht produktiv aktiviert
- Vorgänger: `PERSONALMODUL-ONBOARDING-OFFBOARDING-O2-FALL-INSTANZFUNDAMENT-v0.1.md`
- Konzeptbasis: `PERSONALMODUL-ONBOARDING-OFFBOARDING-FACHKONZEPT-v1.0.md`

## 1. Ergebnis und Blockgrenze

O3 ergänzt im geschützten Mitarbeiterprofil eine serverseitige, ausschließlich lesende Onboarding-Vorschau. Sie verbindet die O2-Paketauflösung mit einer positiven Schritt- und Empfängerprojektion und zeigt, welche ausdrücklich freigegebenen Personen für eine spätere Einzelzuweisung grundsätzlich geeignet wären.

Die Vorschau startet kein Onboarding. Sie erzeugt weder Beschäftigungsepisode noch Fall, Paketbindung, Instanz, Aufgabe, Zuweisung oder Ereignis. Es gibt keine Auswahlmutation, automatische Verantwortlichenwahl, Fortschaltung, Benachrichtigung oder externe Aktion. Die kontrollierte Ausführung bleibt vollständig O4 vorbehalten; Offboarding bleibt vollständig O5 vorbehalten.

Die parallel entwickelte Verkaufsverwaltung liegt in einem eigenen Branch und Worktree. O3 enthält keine Verkaufsdaten, Verkaufsrechte, Verkaufsanalyse, Verkaufs-API oder gemeinsame Fachmigration.

## 2. O3-Laufzeitvertrag

In O3 sind ausschließlich folgende Grundlagen geöffnet:

- additive O2-Schemamigration und O2-Persistenzfundament,
- read-only Paketauflösung und Startvorschau,
- geschützte GET-API,
- read-only Zuweisungsvorschau und
- positive Profilprojektion.

Fest geschlossen bleiben:

- produktive Aktivierung,
- Fall- und Episodenerzeugung,
- Fallmutation,
- Workflow-Instanziierung,
- Aufgaben- und Zuweisungserzeugung,
- Auswahl oder Änderung eines Empfängers,
- automatische Fortschaltung,
- Benachrichtigungen,
- externe Aktionen und
- jede Offboarding-Projektion.

Der O3-Dienst exponiert ausschließlich `preview`. Start-, Schreib-, Auswahl-, Zuweisungs- oder Persistenzmethoden existieren nicht.

## 3. Explizite Rechte

Die Profilvorschau benötigt gleichzeitig:

1. `personnel:central:read`,
2. `personnel:lifecycle:onboarding:read` und
3. `personnel:lifecycle:packages:read`.

Die beiden Lifecycle-Rechte sind als globale, besonders geschützte Rechte im zentralen Rechtekatalog registriert. Berechtigbar sind ausschließlich benannte aktive Konten der PL+-Ebene `hr`, `admin`, `it_admin` und `developer`. Keine Rolle erhält daraus einen automatischen Zugriff. Ein Developer kann die Vorschau daher fachlich genauso lesen wie PL, aber nur mit beiden ausdrücklich wirksamen Lifecycle-Rechten und dem zentralen Leserecht.

Lokaler Systemzugang, Servicekonto, geteiltes Konto, inaktive Identität, lokale Leitung und Sitzung ohne stabile Akteur-ID bleiben geschlossen. IT-Administration kann geschützte Lifecycle-Fachrechte nicht allein aufgrund ihrer technischen Verwaltungsrolle vergeben.

Die Lifecycle-Vorschau leitet keine gewöhnlichen Mitarbeiterprofilrechte ab. Ein ausschließlich für O3 berechtigtes Developer-Konto sieht den Onboarding-Reiter, bleibt aber für Profilübersicht, Stammdaten und Personalakt-Dokumente gesperrt. Umgekehrt öffnet ein bestehendes Profilrecht nicht automatisch O3.

## 4. Serverseitige Paketauflösung

O3 verwendet ausschließlich die beleggeprüften, im exakten Mitarbeiterbereich anwendbaren Onboarding-Publikationen aus O2. Archivierte Veröffentlichungen, fremde Bereiche und andere Workflow-Typen werden nicht projiziert. Manipulierte Snapshot-, Publikations- oder Belegdaten führen zu einer sicheren Ablehnung statt zu einer Teilanzeige.

Eine Paketprojektion enthält nur:

- Publikations- und Prozess-ID,
- Quellrevision und Versionsnummer,
- Workflow-Code und Titel,
- Verantwortungs- und Pflichtart,
- Geltungsbereich,
- Veröffentlichungszeitpunkt,
- den unveränderten Prüfstatus `requires_new_lifecycle_review` und
- die positive Zuweisungsvorschau der veröffentlichten Schritte.

Beschreibungen, Bedingungstexte, Benachrichtigungskanäle, vollständige Snapshots, Rollenrechte, Passwortdaten und kryptografische Rohbelege werden nicht ausgegeben.

Die beiden kundenspezifisch noch nicht zugeordneten Pflichtfamilien `personnel_administration` und `base_security_privacy` sowie Paketkonflikte bleiben sichtbare Blocker. O3 errät keine Paketfamilie aus Titel oder Workflow-Code und wählt keine Paketbindung aus.

## 5. Zuweisungsvorschau

Jeder veröffentlichte Schritt erhält exakt einen der folgenden read-only Zustände:

| Zustand | Bedeutung in O3 |
|---|---|
| `system_deferred` | Systemschritt; Ausführung bleibt bis O4 gesperrt |
| `fixed_recipient_eligible` | ausdrücklich hinterlegte Person ist aktuell geeignet; noch keine Zuweisung |
| `selection_required` | eine oder mehrere geeignete Personen sind sichtbar; bewusste Auswahl erst in O4 |
| `unresolved` | keine geeignete Person konnte sicher aufgelöst werden |

Eine Rollenverantwortung wird niemals automatisch ausgewählt. Das gilt auch dann, wenn derzeit nur eine geeignete Person vorhanden ist. Nur eine bereits in der veröffentlichten Version fest hinterlegte und erneut berechtigungsgeprüfte Einzelperson kann als `fixed_recipient_eligible` erscheinen. Auch dann bleibt `selectedAssignee` zwingend `null`.

Mögliche Empfänger werden serverseitig anhand der veröffentlichten Verantwortungsreferenz, der wirksamen Workflow-Leseberechtigung, des konkreten Organisationsbereichs und der bestehenden Empfängergrenzen geprüft. Developer-, IT-Admin- und lokale Systemkonten werden nicht als operative Aufgabenempfänger angeboten. Die Ausgabe enthält je geeigneter Person nur stabile Akteur-ID und Anzeigename.

## 6. API und Mitarbeiterprofil

O3 erweitert ausschließlich die bestehende GET-Route:

`GET /api/portal/v1/personnel-lifecycle/employees/:employeeNumber/profile?tab=onboarding`

Die Antwort enthält:

- den minimalen Profilkopf,
- die tabbezogenen Fähigkeiten,
- die serverseitige O3-Vorschau,
- Paket- und Schrittanzahlen,
- positive Empfängerkandidaten und
- fachliche Blockercodes.

Es gibt keine korrespondierende POST-, PUT-, PATCH- oder DELETE-Route. Der Reiter wird clientseitig nur bei tatsächlichem Öffnen geladen. Ein ausschließlich für O3 berechtigter Zugang öffnet direkt den Onboarding-Reiter; er erhält dadurch keine unzulässige Profilübersicht.

Die Oberfläche zeigt ausdrücklich „Geschützte Lesevorschau“, „Onboarding ist noch nicht startbar“ und „Nur Vorschau“. Es existiert kein Startknopf, kein Formular und kein interaktives Zuweisungsfeld.

## 7. Datenminimierung und Zustandsbereinigung

Server und Client verwenden getrennte feste Positivlisten. Der Client prüft insbesondere:

- Vertragsversion `o3-v0.1`,
- Modus und Falltyp,
- `startAllowed: false` und `casePersisted: false`,
- Nullstände für Instanzen, Aufgaben und Zuweisungen,
- leere ausgewählte Paketbindungen,
- erlaubte Zuweisungszustände,
- `selectedAssignee: null` für jeden Schritt und
- rechnerische Übereinstimmung aller Summen.

Unbekannte Rohfelder werden nicht in den UI-Zustand kopiert. Widersprüchliche oder manipulierte Werte brechen die Projektion fail-closed ab.

Onboarding-Daten werden beim Wechsel zu einem anderen geschützten Reiter, bei Rechteentzug, Profilwechsel, Zugriffsfehler, Abmeldung und Schließen vollständig aus UI-Zustand und DOM entfernt. Laufende Antworten werden durch Request-Token ungültig gemacht.

## 8. Audit und Fehlergrenzen

Jede erfolgreiche O3-Ansicht erzeugt `personnel-lifecycle.onboarding-preview.view` mit Akteur, Mitarbeiterbezug sowie reinen Paket-, Schritt- und Blockerangaben. Beschreibungen, Personenlisten, Kontaktdaten, Snapshot-Inhalte und kryptografische Belege werden nicht in das Audit kopiert.

Abgewiesene Rechteprüfungen bleiben im bestehenden geschützten Personalmodul-Audit nachvollziehbar. Integritätsfehler aus O2, M4 oder O3 werden als sichere Nichtverfügbarkeit behandelt und nicht durch unvollständige Daten ersetzt.

## 9. Nachweis der Schreibfreiheit

Vor und nach einer realen API-Vorschau werden die Zeilenstände aller sieben O2-Sidecar-Stores verglichen:

- `personnel_employment_episodes`,
- `personnel_lifecycle_cases`,
- `personnel_lifecycle_case_reference_dates`,
- `personnel_lifecycle_case_package_bindings`,
- `personnel_lifecycle_case_assignments`,
- `personnel_lifecycle_case_events` und
- `personnel_lifecycle_confidential_access_events`.

Alle Zähler bleiben unverändert. Zusätzlich verhindern die 21 O2-Trigger weiterhin Insert, Update und Delete auf diesen Stores. O3 öffnet keinen Trigger und keinen Repository-Schreibpfad.

## 10. Nicht enthalten

O3 enthält ausdrücklich nicht:

- Start, Freigabe, Abbruch oder Abschluss eines Onboardings,
- Beschäftigungsepisoden, Fälle oder Paketbindungen,
- M5-Instanzen oder Aufgaben,
- tatsächliche Verantwortlichen- oder Vertretungsauswahl,
- Aufgabenstatus, Nachweise oder Ausnahmen,
- Fälligkeiten, Erinnerungen oder Eskalationen,
- Benachrichtigungen oder Außenwirkungen,
- Konto-, Geräte-, Schlüssel-, Lohnverrechnungs- oder Integrationsaktionen,
- vertrauliches Offboarding,
- produktive PostgreSQL-Migration,
- Commit, Push, Release oder VPS-Aktualisierung und
- Bestandteile der parallel entwickelten Verkaufsverwaltung.

## 11. Prüfung und Abnahmekriterien

O3 ist lokal fachlich-technisch erfüllt, wenn:

1. nur beide Lifecycle-Leserechte gemeinsam mit `personnel:central:read` Zugriff geben,
2. PL+-Rollen allein keinen Zugriff erzeugen,
3. ein ausdrücklich berechtigter Developer O3 lesen kann, aber keine normalen Profilbereiche erbt,
4. Paket- und Publikationsintegrität bei Drift fail-closed bleibt,
5. alle Schritte genau einen erlaubten Vorschauzustand erhalten,
6. Rollenverantwortungen auch bei nur einem Kandidaten nicht automatisch ausgewählt werden,
7. `selectedAssignee`, Paketbindungen und alle Laufzeitzähler leer beziehungsweise null bleiben,
8. API und Client ausschließlich Positivlisten projizieren,
9. die Ansicht lazy lädt und sensible Zustände bei Rechte- oder Kontextwechsel löscht,
10. erfolgreiche Ansichten datensparsam auditiert werden,
11. alle sieben Lifecycle-Stores vor und nach der Vorschau unverändert bleiben,
12. Offboarding und O4-Ausführung technisch geschlossen bleiben und
13. gezielte sowie vollständige Regressionstests ohne Fehler laufen.

Abschlussnachweis vom 3. August 2026: Die vollständige Projektsuite umfasst 1.764 Tests; 1.724 sind bestanden, 40 bewusst übersprungen und 0 fehlgeschlagen. Die zusätzliche Browserprüfung mit synthetischen Daten bestätigt die reine Leseansicht auf Desktop und Mobil ohne Formular, Startaktion oder Seitenüberlauf.

Diese Abnahme ist keine Commit-, Push-, Release-, VPS-, O4- oder O5-Freigabe.

## 12. Nächste Blockgrenze

O4 darf erst nach einem eigenen ausdrücklichen Startauftrag beginnen. Sein maximaler Umfang ist die kontrollierte, atomare und idempotente Onboarding-Ausführung mit ausdrücklich bestätigten Paketbindungen und Einzelzuweisungen. O3 selbst bleibt dauerhaft eine Vorschau und darf nicht als impliziter Startauftrag verwendet werden.
