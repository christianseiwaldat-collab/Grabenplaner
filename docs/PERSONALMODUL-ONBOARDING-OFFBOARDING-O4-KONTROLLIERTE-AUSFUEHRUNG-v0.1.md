# Personalmodul Onboarding/Offboarding – O4 Kontrollierte Ausführung v0.1

- Stand: 3. August 2026
- Status: lokal implementierter und migrationsgesicherter O4-Vertrag mit vollständig grüner automatisierter Regression; nicht veröffentlicht und nicht produktiv aktiviert
- Vorgänger: `PERSONALMODUL-ONBOARDING-OFFBOARDING-O3-PROFILVORSCHAU-v0.1.md`
- Konzeptbasis: `PERSONALMODUL-ONBOARDING-OFFBOARDING-FACHKONZEPT-v1.0.md`

## 1. Ergebnis und Blockgrenze

O4 öffnet ausschließlich die kontrollierte Onboarding-Ausführung für einen bereits angelegten Mitarbeiter. Eine ausdrücklich fachberechtigte zentrale Person bestätigt die vollständige aktuelle Paketauflösung, ordnet beide Pflichtfamilien zwei verschiedenen zentralen Unternehmenspflichtpaketen zu, prüft jede verwendete Paketversion erneut und weist jeden nicht-systemischen Schritt einer konkreten geeigneten Person zu.

Der Start erzeugt Beschäftigungsepisode, Onboarding-Fall, Referenztermine, alle anwendbaren Paketinstanzen, unveränderliche Paketbindungen, Einzelzuweisungen, Fallereignisse, Integritätsbelege und Audit als eine serialisierbare Alles-oder-nichts-Aktion. Eine exakte Wiederholung desselben Startauftrags ist idempotent. Derselbe Vorgangsschlüssel mit anderem Inhalt wird als Konflikt abgewiesen.

O4 enthält keine automatische Paket-, Familien- oder Empfängerauswahl. Es führt keine Benachrichtigung und keine Konto-, Geräte-, Schlüssel-, Lohnverrechnungs-, Behörden- oder sonstige externe Aktion aus. Vertrauliches Offboarding bleibt vollständig O5 vorbehalten. Die parallel entwickelte Verkaufsverwaltung bleibt fachlich, technisch und im Arbeitsstand getrennt und wird durch O4 nicht verändert.

## 2. Geöffnete und geschlossene Laufzeit

O4 öffnet gegenüber O3 eng begrenzt:

- den serverseitig geschützten, ausdrücklichen Onboarding-Start,
- die additive O4-SQLite-Migration und die erforderlichen Lifecycle-Schreibpfade,
- Beschäftigungsepisode und Onboarding-Fall,
- Referenztermine und append-only Fallereignisse,
- unveränderliche Bindungen aller anwendbaren M4-Paketversionen an eigene M5-Instanzen,
- ausdrückliche Einzelzuweisungen für alle nicht-systemischen Schritte,
- kontrollierte Bearbeitung ausdrücklich zugewiesener Onboarding-Aufgaben,
- den ausdrücklichen Abschluss eines vollständig erledigten Onboarding-Falls sowie
- minimale Statusprojektionen im geschützten Mitarbeiterprofil.

Weiterhin geschlossen bleiben:

- automatische Starts aus Bewerberumwandlung, Eintritt oder anderen Stammdatenereignissen,
- jede automatische Auswahl eines Pakets, einer Pflichtfamilie, einer Fallverantwortung oder eines Aufgabenempfängers,
- Konfliktübersteuerungen und Ausnahmefreigaben,
- `skip`, `not_applicable` und andere Sonderergebnisse,
- fachliche Nachweis- oder Dokumentverknüpfungen,
- nachträgliche Stornierung oder Wiedereröffnung eines gestarteten Falls,
- Referenzterminänderungen, Umbesetzungen und Folgestarts innerhalb derselben Beschäftigungsepisode,
- Fristenautomatik, Vertretung, Erinnerung und Eskalation,
- interne oder externe Benachrichtigungen,
- Systemschritte mit Außenwirkung,
- jede Offboarding-Vorbereitung, -Projektion oder -Ausführung,
- produktive PostgreSQL-Aktivierung sowie
- Commit, Push, Release oder VPS-Aktualisierung durch diesen Block.

Technische Integritäts- und Ereignisbelege sind Bestandteil von O4. Sie sind von fachlichen Nachweisen wie Dokumenten, Übergabebestätigungen oder Schulungsnachweisen zu unterscheiden. Letztere bleiben bis zu einem ausdrücklich freigegebenen Metadaten- und Schutzvertrag geschlossen.

## 3. Explizite Rechte

### 3.1 Vorschau

Die O3-Vorschau benötigt unverändert gleichzeitig:

1. `personnel:central:read`,
2. `personnel:lifecycle:onboarding:read` und
3. `personnel:lifecycle:packages:read`.

### 3.2 Kontrollierter Start

Der O4-Start benötigt zusätzlich und gleichzeitig:

- `personnel:lifecycle:onboarding:prepare`,
- `personnel:lifecycle:onboarding:approve`,
- `personnel:lifecycle:onboarding:execute`,
- `personnel:lifecycle:packages:write`,
- `personnel:lifecycle:packages:publish` und
- `personnel:lifecycle:assignments:write`.

Die handelnde Person ist zugleich die ausdrücklich bestätigte Fallverantwortung. Sie muss ein aktives, benanntes zentrales PL+-Konto mit stabiler Akteur-ID sein. Die Basisrolle `hr`, `admin`, `it_admin` oder `developer` allein gewährt weder Ansicht noch Start. Ein Developer kann den Start wie PL ausführen, aber nur mit allen einzeln wirksamen Fachrechten.

### 3.3 Aufgaben und Fallabschluss

Eine operative Aufgabe ist nur für die exakt gespeicherte Einzelzuweisung sichtbar. Das Lesen setzt `personnel:lifecycle:operational:read`, die Bearbeitung zusätzlich `personnel:lifecycle:operational:update` und jeweils den aktuellen exakten Organisationsbereich voraus. Für den Fallabschluss ist zusätzlich `personnel:lifecycle:onboarding:close` erforderlich.

Rollenname, technische Administration, ein allgemeines Profilrecht, ein M4-/M5-Recht oder eine frühere Berechtigung ersetzen die aktuelle Lifecycle-Prüfung nicht. Unberechtigte oder fachfremde Aufgaben werden nicht als verborgene Detaildaten ausgegeben, sondern bleiben nicht auffindbar.

## 4. Verbindlicher Startauftrag

Der Start erfolgt über die geschützte Route:

`POST /api/portal/v1/personnel-lifecycle/employees/:employeeNumber/onboarding-starts`

Die Personalnummer stammt ausschließlich aus dem serverseitig ausgewerteten Routenbezug. Ein gleichnamiges Feld im Request-Body wird abgewiesen. Der Auftrag enthält ausschließlich:

- eine neue UUIDv4 als `operationId`,
- den SHA-256-Beleg der zuletzt geladenen Vorschau,
- die Akteur-ID der ausdrücklich verantwortlichen Person,
- die feste Bestätigung `START_ONBOARDING`,
- fünf einzelne Bestätigungen für Verantwortung, Pakete, Lifecycle-Prüfungen, Zuweisungen und atomaren Start,
- `vertraglicher Eintritt`, `erster Arbeitstag` und `Onboarding-Zieldatum` in zeitlicher Reihenfolge sowie
- die vollständigen Paketbindungen samt Version, Pflichtfamilienzuordnung, Review-Bestätigung und Einzelzuweisungen.

Unbekannte Felder, fehlende Bestätigungen, ungültige Termine, doppelte Publikationen, doppelte Schrittzuweisungen und manipulierte Belege werden vor der Mutation abgewiesen.

## 5. Vollständige Paketauflösung und Lifecycle-Review

Der Server berechnet die aktuelle O3-Vorschau innerhalb der Starttransaktion erneut. Der Client darf die Paketmenge nicht bestimmen. Der Startauftrag muss jede aktuell anwendbare, beleggeprüfte Onboarding-Publikation exakt einmal und mit derselben veröffentlichten Version enthalten. Das umfasst additive Unternehmens-, Standort- und Abteilungspakete; nicht als Pflichtfamilie dienende Ergänzungen werden mit leerer Familienzuordnung gebunden und nicht weggelassen.

Für die beiden fachlich freigegebenen Pflichtfamilien gelten zusätzliche Regeln:

| Pflichtfamilie | Erforderliche Bindung |
|---|---|
| `personnel_administration` | genau ein ausdrücklich gewähltes zentrales, unternehmensweites Pflichtpaket |
| `base_security_privacy` | genau ein anderes ausdrücklich gewähltes zentrales, unternehmensweites Pflichtpaket |

Eine Paketversion darf nicht beide Pflichtfamilien übernehmen. Titel, Workflow-Code, Reihenfolge oder bestehende Publikation werden nicht als implizite Familienzuordnung verwendet.

Jede anwendbare Paketversion benötigt eine eigene ausdrückliche `reviewConfirmed`-Bestätigung unter dem Lifecycle-Vertrag. O4 verändert oder ersetzt die veröffentlichte M4-Version dadurch nicht. Später veröffentlichte Versionen wirken nicht rückwirkend auf den gestarteten Fall.

Startfähig sind ausschließlich beleggeprüfte Publikationen der M4-Standardklassifikation. Jeder veröffentlichte Schritt muss `notificationChannels` leer führen. Ein konfigurierter interner oder externer Kanal erscheint als eigener fail-closed Blocker und wird vor jedem Laufzeitschreibvorgang abgewiesen; O4 legt daraus weder Portalnachricht noch externen Versandauftrag an.

## 6. Einzelzuweisung und Live-Prüfung

Vor dem Start muss jeder nicht-systemische Paketschritt genau einer Person zugewiesen werden. Die Oberfläche beginnt ohne vorausgewählte Person; eine Rollenverantwortung wird auch bei nur einem aktuell geeigneten Kandidaten niemals automatisch übernommen. Ein bereits in der Veröffentlichung fest hinterlegter Empfänger muss ebenfalls ausdrücklich bestätigt werden.

Zulässig ist nur eine Person, die:

- als aktiver Mitarbeiter und aktiver persönlicher Portalnutzer besteht,
- eine stabile Akteur-ID und einen nutzbaren persönlichen Zugang besitzt,
- zur veröffentlichten Verantwortungsreferenz passt,
- die operativen Lifecycle-Rechte aktuell besitzt und
- im exakten Unternehmens-, Standort- oder Standort-/Abteilungsbereich handeln darf.

Developer-, IT-Admin- und lokale Systemkonten werden nicht als operative Aufgabenempfänger angeboten. Die Eignung wird bei der Vorschau und unmittelbar vor dem Speichern innerhalb der Starttransaktion erneut serverseitig geprüft. Rechteentzug, Deaktivierung, Scope-Änderung oder geänderte Publikationsdaten führen zu einem Konflikt und zu keinem Teilstart.

Systemschritte erhalten keine Personenzuweisung. Sie dürfen im O4-Pfad ausschließlich als interne, wirkungsfreie Fortschaltung behandelt werden und lösen keine Benachrichtigung oder externe Aktion aus.

## 7. Atomarität und Idempotenz

Ein erfolgreicher Start erzeugt in derselben serialisierbaren Transaktion:

1. eine neue Beschäftigungsepisode, falls keine aktuelle aktive Episode besteht,
2. den Fall in `prepared`,
3. die erste geschützte Referenzterminrevision,
4. den Übergang nach `approved`,
5. für jedes anwendbare Paket genau eine M5-Instanz,
6. die unveränderliche Lifecycle-Paket- und Instanzbindung,
7. für jeden nicht-systemischen Schritt genau eine unveränderliche Einzelzuweisung samt Run-Bindung,
8. den Übergang nach `active`,
9. die verketteten Ereignisse für Vorbereitung, Freigabe und Start,
10. den unveränderlichen Operationsbeleg und
11. ein datensparsames Startaudit.

Scheitert eine Prüfung oder ein einzelner Schreibvorgang, wird die gesamte Transaktion zurückgerollt. Es bleibt weder eine halbe Beschäftigungsepisode noch ein Fall, eine einzelne Paketinstanz, eine Zuweisung oder ein Startaudit zurück.

Der kanonische Inhalt des Auftrags wird mit der `operationId` verknüpft. Eine exakte Wiederholung liefert das gespeicherte Ergebnis ohne neue Zeile und ohne zweiten Audit-Eintrag. Dieselbe `operationId` mit geändertem Inhalt oder eine parallele Änderung erzeugt einen Konflikt. Ein zweiter offener Onboarding-Fall für dieselbe Beschäftigungsepisode bleibt durch Dienst- und Datenbankvertrag gesperrt.

## 8. Geschützte Speicherung und Belege

Beschäftigungsepisode, Fallnutzdaten, Referenztermine und Lifecycle-Fallereignisse werden ausschließlich als `enc:v2:`-Schutzumschlag gespeichert. Die Schutzkontexte binden den jeweiligen Datensatz und den Mitarbeiterbezug. Ein fehlender oder unlesbarer Schutzumschlag wird als Integritätsfehler behandelt.

Zusätzlich bestehen kanonische SHA-256-Belege für:

- Vorschau und Startauftrag,
- Fallscope und Lifecycle-Review jeder Paketversion,
- Paket-, Run- und Einzelzuweisungsbindungen,
- Referenzterminrevisionen,
- die verkettete Reihenfolge der Fallereignisse und
- das idempotente Startresultat.

Verknüpfungen und Belege sind nach dem Schreiben unveränderlich. Die Datenbank blockiert Update und Delete und prüft die vollständige Relation aus Fall, Publikation, M5-Run, Schritt und Einzelzuweisung. Beleg- oder Schemadrift mit vorhandenen Daten wird nicht automatisch repariert.

Diese kryptografischen Integritätsbelege enthalten keine fachliche Aussage, dass ein Dokument geprüft, ein Arbeitsmittel übergeben oder eine Schulung absolviert wurde. Solche fachlichen Nachweise werden in O4 nicht erzeugt und nicht verknüpft.

## 9. Aufgabenbearbeitung und Abschluss

O4 verwendet für Onboarding-Aufgaben einen eigenen Lifecycle-Pfad. Die allgemeinen M5-Listen- und Mutationsrouten bleiben für Lifecycle-Onboarding fail-closed. Eine Aufgabe wird nur der aktuell berechtigten, exakt gespeicherten Einzelperson projiziert.

Der dedizierte API-Vertrag besteht aus:

- `GET /api/portal/v1/personnel-lifecycle/onboarding/tasks` für die eigene positive Liste aktuell aktiver Aufgaben,
- `POST /api/portal/v1/personnel-lifecycle/onboarding/tasks/:runId/:stepId/complete` für den eigenen kontrollierten Aufgabenabschluss und
- `POST /api/portal/v1/personnel-lifecycle/onboarding/cases/:caseId/close` für die zentrale Abschlussfreigabe.

Eine Aufgabe kann in O4 ausschließlich mit `action: "complete"` und einer eigenen UUIDv4 abgeschlossen werden. `evidenceReference` darf fehlen oder ausschließlich `null` sein und wird intern auf `null` normalisiert; ein fachlicher Nachweis kann nicht eingeschleust werden. Der Abschluss wird innerhalb einer Transaktion erneut gegen Zuweisung, aktiven Schritt, Publikation, Bereich und aktuelle operative Rechte geprüft. Er erzeugt ein verschlüsseltes, über den SHA-256-Beleg mit dem vorherigen Ereignis verkettetes `onboarding_task_completed`-Ereignis und ein datensparsames Audit. Eine exakte Wiederholung ist idempotent; geänderter Inhalt unter derselben Vorgangs-ID bleibt ein Konflikt.

`skip`, `not_applicable`, Ausnahmefreigaben, Freitext und Nachweisverknüpfungen sind nicht Teil des O4-Aufgabenvertrags. Bereits erledigte oder nicht aktive Schritte können nicht unter einem neuen Vorgangsschlüssel umgedeutet werden.

Der Fallabschluss ist eine eigene ausdrückliche Aktion mit neuer UUIDv4, `CLOSE_ONBOARDING` und aktuellem `onboarding:close`-Recht. Auch hier darf `evidenceReference` nur fehlen oder `null` sein. Der Abschluss ist nur für einen aktiven Fall zulässig, wenn sämtliche gebundenen M5-Paketinstanzen den Zustand `resolved` erreicht haben, alle Schritte `completed` sind und kein Schritt `skipped` ist. Er wechselt den Fall atomar nach `completed`, ergänzt das verschlüsselte und in derselben SHA-256-Belegkette geführte Ereignis `onboarding_completed` und schreibt ein datensparsames Audit. Die exakte Wiederholung bleibt idempotent; `completed` ist terminal.

O4 bietet nach einem Start keinen Stornierungs- oder Abbruchendpunkt. Der im Fachkonzept vorgesehene Abbruch nach dem Start benötigt weiterhin einen eigenen additiven Vertrag für Grund, offene Aufgaben und Gegenmaßnahmen. Der vorhandene Datenbankautomat besitzt deshalb keine Freigabe, `cancelled` über eine allgemeine Route zu erreichen.

## 10. Mitarbeiterprofil und Bediengrenzen

Die O3-Profilroute liefert zusätzlich einen eng positiv gelisteten O4-Ausführungsstatus:

- Vertragsversion `o4-v0.1`,
- Modus `controlled_onboarding_start`,
- aktuellen Vorschau-SHA-256,
- serverseitige Formularverfügbarkeit,
- erforderliche Bestätigung `START_ONBOARDING` und
- gegebenenfalls den minimalen aktiven Fallstatus mit Fall-ID, Zustand und reinen Paket-/Aufgabenzählern.

Das Startformular beginnt bewusst leer. Referenztermine, beide Familienzuordnungen, jede Paketprüfung, jede Einzelzuweisung und alle fünf Bestätigungen müssen aktiv gesetzt werden. Der Client sperrt Doppelübermittlungen und verwendet für eine identische Wiederholung dieselbe Vorgangs-ID. Bei Vorschau-, Rechte- oder Konfliktänderung werden Startzustand und geschützte Projektion verworfen und neu geladen.

Aktive Lifecycle-Onboarding-Aufgaben erscheinen ausschließlich für den gespeicherten Empfänger im bestehenden geschützten Personalaufgabenbereich. Der Abschluss benötigt eine bewusste Checkbox und übermittelt nur Vorgangs-ID, `complete` und `evidenceReference: null`; Freitext-, Überspringen-, Ausnahme- oder Nachweisfelder werden nicht angeboten. Die minimale Fallprojektion bietet die Abschlussbestätigung erst bei serverseitigem `closeAvailable` und wirksamem Abschlussrecht an.

Die Regeln für Lazy Loading und Zustandsbereinigung gelten fort. Profilwechsel, Tabwechsel, Rechteentzug, Fehler, Abmeldung oder Schließen entfernen Lifecycle-Daten und laufende Antworten aus UI-Zustand und DOM. Die Statusprojektion enthält keine geschützten Nutzdaten, Personenlisten, Referenztermine, Belege oder technischen Rohwerte.

## 11. Fail-closed Fehlergrenzen

Insbesondere folgende Zustände verhindern Start oder Bearbeitung:

- fehlende einzelne Fachrechte oder nicht benannte Identität,
- ungültiger Mitarbeiter- oder Organisationsbezug,
- bereits offener Onboarding-Fall oder konfliktbehaftete Beschäftigungsepisode,
- abweichender Vorschau- oder Publikationsbeleg,
- fehlendes, zusätzliches oder versionsabweichendes Paket,
- doppelte oder ungeklärte Paketkonflikte,
- fehlende, doppelte oder unzulässige Pflichtfamilienzuordnung,
- nicht bestätigte Lifecycle-Prüfung einer Paketversion,
- eine nicht standardklassifizierte Publikation oder ein konfigurierter Benachrichtigungskanal,
- fehlende, automatische, doppelte oder nicht mehr berechtigte Einzelzuweisung,
- nicht aktive, fremde oder nicht auffindbare Aufgabe,
- noch offene Paketinstanz beim Fallabschluss,
- unbekanntes Request-Feld, unzulässige Action oder fehlende ausdrückliche Bestätigung,
- nicht kanonisches Schema, fehlende Relation, Belegdrift oder unlesbarer Schutzumschlag und
- parallele Mutation oder Wiederverwendung einer Vorgangs-ID mit anderem Inhalt.

Ein Konflikt wird nicht stillschweigend aufgelöst und ein Integritätsfehler nicht als Teilfortschritt ausgegeben.

## 12. Migration und Datenbankgrenze

O4 ersetzt die vollständige O2-Schreibsperre ausschließlich durch einen engen SQLite-Onboarding-Vertrag. Die Migration legt additive O4-Relationen für Startvorgänge, Paket-Run-Bindungen und Zuweisungsbindungen an und öffnet die sieben Lifecycle-Sidecars nur für die kanonischen Onboarding-Transitionen.

Vor O4 bleiben Lifecycle-Onboarding-Runs im M5-Schema gesperrt. Nach erfolgreicher O4-Migration akzeptiert M5 sie ausschließlich mit der vollständigen Fall-, Paket-, Run- und Zuweisungsrelation. Offboarding-Datensätze und die vertrauliche Zugriffsspur bleiben gesperrt.

Ein fehlender kanonischer Vorgängerstand, unerwartet befüllter O2-Stand, Schema- oder Triggerdrift mit Daten, Fremdschlüsselverletzung oder ungültiger Beleg führt fail-closed zum Abbruch. Die Startup-Migration und Importprüfung erkennen O4 als eigenen kanonischen Zustand. Es gibt keine PostgreSQL-Produktivmigration und keine Aktivierungsfreigabe.

## 13. Nicht enthalten

O4 enthält ausdrücklich nicht:

- vertrauliches Offboarding; dieses beginnt frühestens mit dem gesondert freigegebenen O5,
- automatischen Start, automatische Verantwortlichenwahl oder automatische Paketentscheidung,
- Abbruch, Stornierung, Wiedereröffnung, Umbesetzung oder Referenzterminänderung nach dem Start,
- Ausnahmeentscheidung, `skip`, `not_applicable` oder fachliche Nachweisverknüpfung,
- Dokumentupload oder eine Kopie aus der geschützten Personalakte,
- Mitarbeiter-Self-Service-Mutationen,
- Fälligkeiten, Erinnerungen, Eskalationen oder Vertretungsautomatik,
- Benachrichtigungen per Portal, E-Mail, SMS, WhatsApp oder Push,
- Konto-, Geräte-, Schlüssel-, Zutritts-, Lohnverrechnungs-, Behörden- oder andere Integrationsaktionen,
- vertrauliche Zugriffsspur und Offboarding-Datenklassen,
- produktive PostgreSQL-Aktivierung,
- Bestandteile der parallel entwickelten Verkaufsverwaltung und
- Commit, Push, Release oder VPS-Aktualisierung.

## 14. Prüfung und Abnahmekriterien

O4 ist lokal fachlich-technisch erfüllt, wenn:

1. nur alle getrennten Startrechte gemeinsam einen kontrollierten Start erlauben,
2. Rollenname, Developer-, IT-Admin- oder lokaler Systemzugang ohne Fachrechte nichts öffnen,
3. der Server die Vorschau innerhalb der Transaktion neu berechnet und alle anwendbaren Pakete bindet,
4. beide Pflichtfamilien ausdrücklich zwei unterschiedlichen zentralen Unternehmenspflichtpaketen zugeordnet sind,
5. jede Paketversion geprüft und jeder nicht-systemische Schritt einer aktuell geeigneten Person zugewiesen ist,
6. Start, Aufgabenabschluss und Fallabschluss atomar und idempotent sind,
7. jeder Fehler vollständig zurückrollt und keine Teilinstanz oder Teilhistorie hinterlässt,
8. geschützte Nutzdaten ausschließlich verschlüsselt und alle Relationen unveränderlich belegt sind,
9. Aufgaben nur dem exakten aktuell berechtigten Empfänger erscheinen und nur `complete` akzeptieren,
10. der Fall erst nach Auflösung aller gebundenen Paketinstanzen ausdrücklich abgeschlossen werden kann,
11. `skip`, `not_applicable`, Ausnahmen, fachliche Nachweise und nachträgliche Stornierung technisch geschlossen bleiben,
12. keine Benachrichtigung, Systemaußenwirkung oder Offboarding-Funktion ausgelöst werden kann,
13. SQLite-Migration, Importprüfung, API, UI, Rechte-, Persistenz-, Integritäts- und Negativtests ohne Fehler laufen,
14. der automatisierte statische DOM-/CSS-Vertrag die erforderlichen Breiten- und Breakpoint-Regeln für schmale Ansichten einschließlich 320 und 390 Pixel nachweist und
15. die vollständige Regression keine unbeabsichtigte Änderung an R1 sowie M4 bis M7 oder der getrennten Verkaufsverwaltung zeigt.

### 14.1 Lokaler Prüfnachweis vom 3. August 2026

Ausgeführt mit serieller Node.js-Testausführung:

| Prüfumfang | Ergebnis |
|---|---|
| gezielter O4-Kernlauf für Start, Aufgaben, Abschluss und HTTP-Negativfälle | 23 von 23 Tests bestanden |
| Architektur-, Persistenzkopplungs-, Provider- und UI-Vertrag | 54 von 54 Tests bestanden; 0 unklassifizierte Dateien und 0 Phasengrenzverletzungen |
| vollständige Projektsuite | 1.809 Tests; 1.769 bestanden, 40 bewusst übersprungen, 0 fehlgeschlagen, 0 abgebrochen und 0 offen |
| Laufzeit der vollständigen Projektsuite | 274.349,9424 Millisekunden |
| Responsive-Prüfung | automatisierte statische DOM-/CSS-Vertragsprüfung der Breiten- und Breakpoint-Regeln einschließlich 320 und 390 Pixel bestanden |

Die integrierte Browser-Laufzeit stellte keine verfügbare Browserinstanz bereit. Deshalb wurde keine interaktive Browser-Abnahme durchgeführt. Die automatisierte DOM-/CSS-Responsive-Prüfung ist ein Vertragsnachweis und wird nicht als Browser-Abnahme bezeichnet.

Diese Abnahme ist keine Commit-, Push-, Release-, VPS-, PostgreSQL-, O5- oder Produktivfreigabe.

## 15. Nächste Blockgrenze

O5 darf erst nach einem eigenen ausdrücklichen Startauftrag beginnen. Sein Umfang bleibt der gesondert geschützte, bis zur Kommunikationsfreigabe vollständig unsichtbare Offboarding-Pfad. O4 darf weder Offboarding-Daten vorbereiten noch seine Aufgaben-, Ereignis- oder Sichtbarkeitsgrenzen vorwegnehmen.

Ein späterer Ausbau von O4 um Abbruch, Umbesetzung, Terminänderung, `not_applicable`, Ausnahmen oder fachliche Nachweise benötigt jeweils den freigegebenen Metadaten-, Schutz-, Rechte- und Auditvertrag. Die vorhandenen technischen Möglichkeiten dürfen bis dahin nicht über allgemeine M5-Routen geöffnet werden.
