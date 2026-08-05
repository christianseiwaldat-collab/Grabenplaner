# Personalmodul Onboarding/Offboarding – O2 Fall- und Instanzfundament v0.1

- Stand: 2. August 2026
- Status: lokal umgesetzt und geprüft; nicht veröffentlicht, nicht produktiv aktiviert
- Vorgänger: `PERSONALMODUL-ONBOARDING-OFFBOARDING-O1-RECHTE-DATEN-FALLVERTRAG-v0.1.md`
- Konzeptbasis: `PERSONALMODUL-ONBOARDING-OFFBOARDING-FACHKONZEPT-v1.0.md`

## 1. Ergebnis und Blockgrenze

O2 schafft ausschließlich das additive technische Fall- und Instanzfundament. Die sieben in O1 festgelegten Sidecar-Entitäten liegen als migrationsgesichertes SQLite-Schema vor. Alle Tabellen bleiben in O2 auf Datenbankebene vollständig schreibgesperrt. Der neue Domänendienst kann vorhandene M4-Publikationen und einen bestehenden Mitarbeiterbezug nur lesen und daraus eine datensparsame, immer startlose Vorschau bilden.

O2 erzeugt insbesondere keinen Fall, keine Beschäftigungsepisode, keine Paketbindung, keine Zuweisung, keine Instanz und keine Aufgabe. Es gibt keinen REST-Endpunkt, keine Profilansicht, keine Benachrichtigung und keine Außenwirkung. Onboarding bleibt bis O4 und Offboarding bis O5 technisch gesperrt.

Die parallel entwickelte Verkaufsverwaltung liegt in einem eigenen Branch und Worktree. O2 enthält keine Verkaufsdaten, Verkaufsrechte, Verkaufsanalyse, Verkaufs-API oder gemeinsame Fachmigration.

## 2. Laufzeitgates

Nur folgende Grundlagen sind in O2 geöffnet:

- `schemaMigration`,
- `persistenceFoundation`,
- `readOnlyPackageResolution` und
- `readOnlyStartPreview`.

Folgende Gates bleiben fest geschlossen:

- produktive Aktivierung,
- API-Routen,
- Fallerzeugung und Fallmutation,
- Workflow-Instanziierung,
- Aufgabenerzeugung,
- Zuweisungsauflösung,
- Profilprojektion,
- Benachrichtigungen und
- externe Aktionen.

Der O2-Dienst exponiert ausschließlich `preview`. Er besitzt keine Start-, Schreib-, Zuweisungs- oder Persistenzmethode.

## 3. Additives SQLite-Schema

Die Migration `v0.91-personnel-lifecycle-case-foundation` ergänzt exakt die sieben in O1 benannten Ziel-Stores:

| Store | Technischer Zweck in O2 | O2-Datenzustand |
|---|---|---|
| `personnel_employment_episodes` | eigenständige Beschäftigungsepisode mit Mitarbeiter- und Vorgängerbezug | leer und schreibgesperrt |
| `personnel_lifecycle_cases` | gemeinsamer Onboarding-/Offboarding-Fall mit Episoden- und Scope-Bezug | leer und schreibgesperrt |
| `personnel_lifecycle_case_reference_dates` | versionierte Referenztermin-Belege | leer und schreibgesperrt |
| `personnel_lifecycle_case_package_bindings` | spätere unveränderliche Bindung einer Publikation an einen Fall | leer und schreibgesperrt |
| `personnel_lifecycle_case_assignments` | spätere additive Einzel- und Nachfolgezuweisung | leer und schreibgesperrt |
| `personnel_lifecycle_case_events` | spätere append-only Fallereigniskette | leer und schreibgesperrt |
| `personnel_lifecycle_confidential_access_events` | spätere getrennte vertrauliche Zugriffsspur | leer und schreibgesperrt |

Die Tabellen referenzieren die bestehenden Mitarbeiter-, Organisations- und M4-Publikationsstrukturen ausschließlich über restriktive Fremdschlüssel. Löschen oder Umdeuten von Bestandsdaten ist nicht Teil der Migration.

### 3.1 Unveränderliche Kerne

Die in O1 festgelegten unveränderlichen Bezüge sind im Schema abgebildet:

- Mitarbeiter, Episodennummer und Vorgängerepisode,
- Falltyp, Beschäftigungsepisode, ausdrücklich benannte Fallverantwortung und Vorgängerfall,
- Terminrevision und Vorgängerrevision,
- Publikation, Versionsnummer und Scope-Beleg,
- Schrittbezug, benannter Empfänger und Vorgängerzuweisung sowie
- Ereignisfolge und kryptografischer Vorgängerbeleg.

Beschäftigungsepisode und Fall besitzen zusätzlich eine Revisions- und Änderungsprojektion. Diese Spalten öffnen in O2 keine Mutation; sie bilden nur den später erforderlichen Optimistic-Concurrency- und Auditbezug vor.

Alle Belegfelder akzeptieren nur kanonische SHA-256-Werte. Geschützte Nutzdaten dürfen leer oder als `enc:v2:`-Schutzumschlag vorliegen. O2 schreibt weder leere Fachdatensätze noch Schutzumschläge.

### 3.2 Harte O2-Schreibsperre

Für jede der sieben Tabellen bestehen drei kanonisch geprüfte Trigger:

1. Insert gesperrt,
2. Update gesperrt,
3. Delete gesperrt.

Damit verhindern insgesamt 21 Trigger auch direkte SQL-Mutationen außerhalb des Domänendienstes. Die Sperre ist kein Rollen- oder UI-Schalter und kann deshalb nicht durch ein Developer-, IT-Admin- oder lokales Konto umgangen werden. Eine spätere Öffnung benötigt einen eigenen, überprüfbaren O4- beziehungsweise O5-Migrationsvertrag.

## 4. Verlustfreie Startmigration

Die O2-Schicht ist in die bestehende kanonische Anwendungsschema- und Startup-Migration eingebunden.

Für eine vorhandene Datenbank gilt:

1. O2-Schema und O2-Zeilenintegrität werden vor jeder Änderung geprüft.
2. Bei fehlendem oder abweichendem O2-Stand wird vor der Migration die vorhandene Pre-Migration-Sicherung ausgelöst.
3. Ein vollständig fehlendes O2-Schema wird additiv angelegt; M4-/M5- und Mitarbeiterdaten werden nicht zurückgefüllt oder verändert.
4. Leerer Trigger- oder Schemadrift darf nach Sicherung kanonisch repariert werden.
5. Sobald in einer abweichenden O2-Schicht bereits Daten liegen, endet die Migration fail-closed mit `PERSONNEL_LIFECYCLE_CASE_FOUNDATION_SCHEMA_DATA_PRESENT` und verändert diese Daten nicht.
6. Erst nach erfolgreicher Schema- und Zeilenprüfung wird der Migrationsmarker geschrieben.

Ein erneuter O2-Lauf erkennt den kanonischen Stand als erfüllt. Alte Datenbanken ohne O2 bleiben als `pre-o2-compatible` importierbar und erhalten die additive Schicht beim kontrollierten Start. Ein kanonischer O2-Import wird als `o2-read-only`, ein teilweiser oder manipulierter O2-Stand als `invalid` erkannt.

## 5. Read-only Paketauflösung

Der O2-Dienst liest ausschließlich:

- den vorhandenen M5-Mitarbeiterbezug einschließlich aktivem Standort-/Abteilungsbezug und
- alle bestehenden M4-Publikationen einschließlich Archivstatus.

Die Vorschau prüft die M4-Snapshot- und Publikationsbelege erneut. Ein Integritätsfehler wird nicht ausgeblendet, sondern bricht fail-closed ab. Für jeden Prozess wird ausschließlich die neueste nicht archivierte Onboarding-Veröffentlichung als Kandidat berücksichtigt. Unternehmenspakete werden um exakt passende Standort- und Abteilungskandidaten ergänzt. Fremde Scopes, archivierte Pakete und andere Workflow-Typen werden nicht übernommen.

Die positive Kandidatenprojektion enthält nur:

- Publikations- und Prozess-ID,
- Quellrevision und Versionsnummer,
- stabilen Workflow-Code,
- Titel,
- Verantwortungs- und Pflichtart,
- eingefrorenen Geltungsbereich,
- Veröffentlichungszeitpunkt und
- den Status `requires_new_lifecycle_review`.

Schritte, Beschreibungen, Aufgabeninhalte, kryptografische Rohbelege und sonstige Snapshot-Inhalte werden nicht ausgegeben.

## 6. Verbindliche Blocker der Startvorschau

Jede O2-Vorschau enthält `o2_starts_locked` und `startAllowed: false`. Zusätzlich werden unter anderem folgende Ursachen explizit ausgewiesen:

- Mitarbeiter fehlt oder ist inaktiv,
- Standort-/Abteilungsbezug fehlt, ist inaktiv oder widersprüchlich,
- kein passendes Onboarding-Paket,
- vorhandene M4-Publikation benötigt Prüfung unter dem neuen Lifecycle-Vertrag,
- doppelte Codes oder Titel erzeugen einen Konflikt,
- die kundenspezifische Zuordnung der beiden Pflichtfamilien `personnel_administration` und `base_security_privacy` fehlt oder
- Offboarding bleibt bis O5 zurückgestellt.

Die Vorschau enthält immer eine leere Liste `selectedBindings` sowie Nullwerte für Fälle, Instanzen, Aufgaben und Zuweisungen. Ein Client kann deshalb weder Pflichtpakete weglassen noch einen Vorschauwert als Startauftrag verwenden.

## 7. Bestehende M4-Publikationen

Keine vorhandene M4-Onboarding-Publikation wird durch O2 automatisch startfähig. Alle passenden Veröffentlichungen erscheinen ausschließlich als erneut zu prüfende Kandidaten. Die im Fachkonzept beschlossenen Pflichtfamilien werden nicht aus Titeln oder Workflow-Codes geraten. Ihre kundenspezifische, veröffentlichungssichere Zuordnung bleibt einer späteren ausdrücklich freigegebenen Ausbaustufe vorbehalten.

Offboarding-Pakete, Mitarbeiterbezug und Scope werden in O2 nicht aufgelöst oder projiziert. Der heutige M4-Klartextpfad bleibt für vertrauliche Offboarding-Inhalte gesperrt.

## 8. Nicht enthalten

O2 enthält ausdrücklich nicht:

- Registrierung oder Vergabe der O1-Fachrechte in der produktiven Rechteverwaltung,
- Fall-, Episoden-, Termin-, Paketbindungs-, Zuweisungs- oder Ereignisschreibpfade,
- automatisches Anlegen aus Bewerberumwandlung, Eintritt oder Austritt,
- Profilregister oder sonstige UI,
- Zuweisungs-, Verantwortlichen- oder Fälligkeitsauflösung,
- M4-/M5-Instanzen und Aufgaben,
- Abbruch-, Abschluss- oder Korrekturmutationen,
- Benachrichtigungen, Eskalationen oder Vertretungen,
- Konto-, Geräte-, Schlüssel-, Lohnverrechnungs- oder Integrationsaktionen,
- produktive PostgreSQL-Migration und
- Bestandteile der parallel entwickelten Verkaufsverwaltung.

## 9. Prüfung und Abnahmekriterien

O2 ist lokal fachlich-technisch erfüllt, wenn:

1. alle sieben Ziel-Stores additiv und kanonisch erkannt werden,
2. alle 21 O2-Schreibsperren vorhanden und wirksam sind,
3. die Migration vor einem Bestandsupgrade sichert und Bestandsdaten unverändert lässt,
4. leerer Drift reparierbar, Drift mit Daten dagegen fail-closed ist,
5. Importprüfung `pre-o2-compatible`, `o2-read-only` und `invalid` unterscheidet,
6. die Paketauflösung nur beleggeprüfte neueste Onboarding-Kandidaten aus dem exakten Scope zeigt,
7. aktuelle M4-Publikationen ausschließlich `requires_new_lifecycle_review` erhalten,
8. Pflichtfamilien und Konflikte nicht stillschweigend aufgelöst werden,
9. Offboarding bis O5 ohne Paketprojektion gesperrt bleibt,
10. Dienst und Vorschau keine Mutation exponieren,
11. Server, API, Rechteverwaltung und Profiloberfläche unverdrahtet bleiben und
12. gezielte sowie vollständige Regressionstests ohne Fehler laufen.

Diese Abnahme ist keine Commit-, Push-, Release-, VPS-, O3-, O4- oder O5-Freigabe.

## 10. Nächste Blockgrenze

O3 darf erst nach einem eigenen ausdrücklichen Startauftrag beginnen. Sein maximaler Umfang ist die serverseitig geschützte read-only Onboarding-Vorschau im Mitarbeiterprofil einschließlich Zuweisungsvorschau. Auch O3 darf keinen Fall, keine Instanz, keine Aufgabe und keine Mutation erzeugen. O4 und O5 bleiben davon getrennte spätere Freigaben.
