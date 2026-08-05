# Personalmodul Onboarding/Offboarding – O6 Schulungen, Arbeitsmittel und Zugänge v0.1

- Stand: 3. August 2026
- Status: lokal bearbeiteter O6-Minimalvertrag; nicht veröffentlicht und nicht produktiv aktiviert
- Vorgänger: `PERSONALMODUL-ONBOARDING-OFFBOARDING-O5-VERTRAULICHES-OFFBOARDING-v0.1.md`
- Konzeptbasis: `PERSONALMODUL-ONBOARDING-OFFBOARDING-FACHKONZEPT-v1.0.md`

## 1. Ergebnis und Blockgrenze

O6 legt einen providerneutralen, strikt gesperrten Integrationsvertrag für genau drei voneinander getrennte Domänen fest:

1. Schulungen,
2. Arbeitsmittel und
3. Zugänge.

Der freigegebene Minimalumfang umfasst ausschließlich den Vertrag, getrennte Fachrechte, einen gefilterten read-only Schnittstellenkatalog, eine read-only Oberfläche und datensparsame Preflight-Bausteine. Der Preflight ist eine reine interne Domänenfunktion. Er prüft nur, ob eine spätere Übergabe unter einer ausdrücklich freigegebenen Konfiguration grundsätzlich zulässig wäre. Er erzeugt weder einen Auftrag noch eine Außenwirkung und besitzt in diesem Block keinen öffentlichen HTTP-Endpunkt.

Da keine kundenspezifischen Anbieter, Zielsysteme, Aktionen, Geltungsbereiche oder Felder freigegeben wurden, ist die Standardregistry leer. Damit bleibt jede reale Übergabe fail-closed. O6 implementiert insbesondere keinen Versand, keinen Dispatch, keinen Netzwerkzugriff und keine Rückmeldung eines Fremdsystems.

## 2. Verbindliches Fail-closed-Prinzip

Eine spätere Schnittstelle darf nur dann vorbereitet werden, wenn alle folgenden Entscheidungen ausdrücklich, revisionsgebunden und gemeinsam erfüllt sind:

- die Domäne ist am Quellauftrag strukturiert gebunden,
- das konkrete Zielsystem steht in einer kundenspezifisch freigegebenen Positivliste,
- die konkrete Aktion ist für dieses Ziel freigegeben,
- der Organisationsbereich liegt im freigegebenen Scope,
- jedes einzelne auszugebende Feld steht in der Feld-Positivliste,
- das persönliche Konto besitzt die für die Domäne erforderlichen Einzelrechte und
- die aktive Registry-Revision stimmt exakt mit der geprüften Revision überein.

Fehlt eine dieser Voraussetzungen, liefert der Preflight ausschließlich strukturierte Blocker. Eine Warnung, ein Anzeigename, ein technischer Rollenname oder eine vermeintlich passende Aufgabe darf keine fehlende Freigabe ersetzen.

Die leer ausgelieferte Standardregistry ist ein Sicherheitszustand und kein Konfigurationsfehler. Ohne spätere ausdrückliche kundenspezifische Aktivierungsentscheidung gibt es keinen „allgemeinen“, „generischen“ oder automatisch erkannten Fallback-Anbieter.

## 3. Drei ausdrückliche Domänen

Die Schnittstellendomäne wird ausschließlich durch einen strukturierten, versionierten Bindungswert bestimmt. Zulässig sind nur die drei kanonischen Werte `training`, `asset` und `access`.

Eine Domäne darf niemals aus folgenden Inhalten abgeleitet werden:

- Workflow-, Paket-, Schritt- oder Aufgabentitel,
- Workflow-, Paket- oder Familiencode,
- Beschreibung, Anleitung, Kommentar oder sonstiger Freitext,
- Empfängerklasse oder Basisrolle,
- vorhandene Feldnamen oder zufällige Ähnlichkeiten sowie
- bisherige Nutzung eines allgemeinen M4-/M5-Workflowtyps.

Eine fehlende, unbekannte, mehrdeutige oder nachträglich abweichende Bindung ist ein Blocker. Bestehende Aufgaben werden durch O6 nicht rückwirkend typisiert.

## 4. O1-Projektionen sind nur die Maximalgrenze

Die positiven O1-Aufgabenprojektionen definieren lediglich die äußerste Feldobergrenze. Sie sind weder eine automatische Exportfreigabe noch eine fertige Schnittstellennutzlast. Die tatsächliche Nutzlast ist immer die Schnittmenge aus:

`O1-Maximalprojektion ∩ konkreter Auftragszweck ∩ aktive Ziel-/Aktions-/Scope-Positivliste ∩ exakte Feldfreigabe ∩ aktuelle Fachrechte`

| Domäne | O1-Maximalfelder |
|---|---|
| Schulung | `orderId`, `displayName`, `locationId`, `departmentId`, `module`, `dueAt`, `evidenceStatus`, `status` |
| Arbeitsmittel | `orderId`, `displayName`, `locationId`, `assetIdentifier`, `action`, `dueAt`, `status` |
| Zugang | `orderId`, `displayName`, `businessIdentifier`, `targetSystem`, `action`, `executeAt`, `status` |

Ein Feld bleibt ausgeschlossen, wenn es nicht für genau das Ziel, die Aktion und den Scope freigegeben ist. Das gilt auch dann, wenn das Feld in O1 vorhanden ist. Zusätzliche Profil-, Fall-, Vertrags-, Privatkontakt-, Dokument-, Kommentar- oder Bewertungsfelder sind unzulässig.

`orderId` ist ein opaker Auftragsbezug. `displayName` beziehungsweise `businessIdentifier` dürfen nur freigegeben werden, wenn das Ziel die jeweilige Identifikation nachweislich benötigt. Freigegebene Feldlisten dürfen keine Wildcards, Präfixmuster oder impliziten „alle übrigen Felder“-Regeln enthalten.

## 5. Revisionsgebundene Registry und Positivlisten

Eine spätere kundenspezifische Registry muss für jeden Eintrag mindestens strukturiert festlegen:

- unveränderliche Registry-Revision,
- genau eine Domäne,
- stabile Zielsystemkennung und neutralen Anzeigenamen,
- explizite Liste zulässiger strukturierter Aktionen,
- zulässige Unternehmens-, Standort- oder Abteilungsscopes,
- exakte Feld-Positivliste je Aktion und Scope,
- fachlichen Eigentümer und Freigabestatus sowie
- den für die Revision gültigen Aktivierungsbeleg.

Ziel, Aktion, Scope und Feldfreigabe werden gemeinsam geprüft. Die Freigabe eines Zielsystems allein erlaubt keine Aktion. Die Freigabe einer Aktion für einen Standort erlaubt keine Verwendung in einem anderen Bereich. Eine neue Registry-Fassung ersetzt keine bereits geprüfte Revision stillschweigend; sie benötigt einen neuen Preflight.

O6 speichert keine solche kundenspezifische Registry in der Datenbank. Der ausgelieferte Katalog besitzt die dokumentierte Vertragsform, aber null aktive Zielsystemeinträge. Persistente Konfiguration, Freigabeworkflow, Schlüsselverwaltung, Anbieteradapter und Rückkanal sind spätere, getrennt freizugebende Ausbauschritte.

## 6. Getrennte Fachrechte

Die drei Domänen erhalten jeweils vier eigene ausdrückliche Rechte. Ein Recht für eine Domäne gewährt weder Lesesicht noch Handlungsmöglichkeit in einer anderen Domäne.

| Domäne | Katalogsicht | Registry-Verwaltung | Versand | Rückmeldung |
|---|---|---|---|---|
| Schulung | `personnel:lifecycle:interfaces:training:read` | `personnel:lifecycle:interfaces:training:manage` | `personnel:lifecycle:interfaces:training:dispatch` | `personnel:lifecycle:interfaces:training:reconcile` |
| Arbeitsmittel | `personnel:lifecycle:interfaces:asset:read` | `personnel:lifecycle:interfaces:asset:manage` | `personnel:lifecycle:interfaces:asset:dispatch` | `personnel:lifecycle:interfaces:asset:reconcile` |
| Zugang | `personnel:lifecycle:interfaces:access:read` | `personnel:lifecycle:interfaces:access:manage` | `personnel:lifecycle:interfaces:access:dispatch` | `personnel:lifecycle:interfaces:access:reconcile` |

O6 veröffentlicht serverseitig ausschließlich die Katalogsicht über das jeweilige `read`-Recht. `manage`, `dispatch` und `reconcile` sind reservierte Vertragsgrenzen für spätere ausdrücklich freizugebende Ausbauschritte. In diesem Block existiert für sie keine öffentliche Mutation, kein Dispatch und kein Rückkanal. Die Definition eines Rechts ist ausdrücklich keine Aktivierung der zugehörigen Fähigkeit.

Eine spätere Vorprüfung oder Aktion muss zusätzlich die aktuelle aufgabenbezogene Leseberechtigung und den zulässigen Organisationsbereich prüfen. Eine technische Berechtigung zur allgemeinen Integrationsverwaltung ersetzt kein O6-Fachrecht.

PL, Admin, IT-Admin oder Developer erhalten aus ihrem Rollennamen kein O6-Recht. Dasselbe gilt für FL, AL, Trainer, Arbeitsmittelverantwortung und IT/Security. Wirksam ist nur die ausdrückliche Zuweisung an ein aktives, benanntes persönliches Konto. Dienst-, Sammel-, lokale System- und geteilte Konten sind nicht zulässig.

## 7. Read-only API- und UI-Katalog

Der O6-Katalog ist ausschließlich lesend. Er beschreibt für die aktuell berechtigte Person:

- die für sie sichtbaren Domänen,
- den Vertrags- und Registry-Revisionsstand,
- die erlaubte O1-Maximalfeldmenge,
- die Zahl der freigegebenen Ziele und
- den fail-closed Aktivierungsstatus.

Domänen ohne eigenes Leserecht werden weder als gesperrte Karte noch als Zähler, Platzhalter oder Hinweis ausgegeben. Die leere Registry wird neutral als „Keine Zielsysteme freigegeben“ dargestellt. Sie bietet keine Schaltfläche zum Versenden, Aktivieren oder Umgehen eines Blockers.

Die einzige öffentliche O6-API lautet:

`GET /api/portal/v1/personnel-lifecycle/interfaces/catalog`

Ein öffentlicher Preflight-, Verwaltungs-, Dispatch- oder Reconcile-Endpunkt ist nicht Bestandteil von O6. Ohne ausdrückliche Task-Bindung und Provider-Positivliste wäre schon die öffentliche Annahme einer Vorprüfungsanfrage eine zu weit reichende Schnittstellenfreigabe.

Die Katalogantwort liefert `Cache-Control: no-store`, `Pragma: no-cache` und keinen ETag. Der interne Preflight-Baustein erzeugt keine HTTP-Antwort. Bei Identitätswechsel, Rechteverlust, Bereichswechsel, Fehler, Abmeldung oder Schließen werden die geladenen O6-Daten vollständig aus Clientzustand und DOM entfernt.

## 8. Datensparsamer Preflight-Baustein

Der Preflight ist eine reine, nebenwirkungsfreie Domänenfunktion und wird in O6 ausschließlich auf Vertragsebene getestet. Es gibt keine Route, über die Browser oder externe Clients diesen Baustein aufrufen können. Ein später ausdrücklich autorisierter Controller dürfte nur den opaken Auftragsbezug, die strukturierte Domäne, Zielsystemkennung, strukturierte Aktion, Registry-Revision und den erforderlichen Scope übernehmen. Mitarbeitername, Personalnummer, Freitext, Auftragsinhalt oder eine vom Client mitgesendete fertige Nutzlast wären keine vertrauenswürdige Quelle.

Der Vertrag akzeptiert nur gewöhnliche Datenobjekte und vollständig materialisierte Arrays. JavaScript-Proxies, Getter, Setter, Symbole, nicht aufzählbare Zusatzfelder, Array-Lücken und dynamische Array-Einträge werden vor einer fachlichen Auswertung fail-closed verworfen; ihre Zugriffsfunktionen werden dabei nicht ausgeführt. Die normalisierte Aufgabenprojektion besitzt keinen Objektprototyp und übernimmt ausschließlich eigene, zuvor als statische Datenfelder geprüfte Werte. Geerbte Werte aus einem veränderten `Object.prototype` können daher weder Pflichtfelder noch den Aufgabenstatus ersetzen.

Ein solcher späterer Controller dürfte den Preflight erst aufrufen, nachdem er aus dem serverseitigen Sitzungskontext alle folgenden Vorbedingungen positiv geprüft hat: persönlicher, nicht lokaler Portalzugang; das für die konkrete Domäne und Aktion erforderliche Einzelrecht; Sichtbarkeit des Auftrags; aktuelle Zuweisung an diesen Akteur; unveränderte Auftragsbindung; nicht terminaler und nicht stornierter Fall. Weder diese Aussagen noch die Aufgabenprojektion dürfen aus einem Client-Body übernommen werden. Der Controller müsste die zulässige Aufgabenprojektion selbst serverseitig auflösen und dem Preflight als vertrauenswürdige strukturierte Eingabe übergeben.

Die reine Domänenfunktion erhält bewusst keine Sitzung und ersetzt deshalb keine Rechte-, Sichtbarkeits- oder Zuweisungsprüfung. Als zusätzliche Sicherung akzeptiert sie ausschließlich den serverseitig gebundenen Aufgabenstatus `pending` oder `active`; ein fehlender, leerer, fremder, terminaler, abgeschlossener oder stornierter Status blockiert mit `task_status_not_actionable`. Das reine Prüfergebnis enthält höchstens:

- Domäne, Zielsystem und strukturierte Aktion,
- geprüfte Registry-Revision,
- minimalen Scope,
- die Namen der tatsächlich freigabefähigen Felder,
- eine redigierte Nutzlastvorschau ausschließlich dieser Felder und
- strukturierte Blocker.

Ein Preflight-Ergebnis ist keine Versand-, Ausführungs- oder Aktivierungsfreigabe. Es besitzt in O6 weder einen öffentlichen Erzeugungsweg noch einen anschließenden Dispatch-Endpunkt und kann daher nicht als Sendeauftrag wiederverwendet werden.

Mindestens folgende Zustände müssen fail-closed blockiert werden. Rechte, Sichtbarkeit, Zuweisung und Aktualität blockiert der zwingend vorgeschaltete Controller bereits vor dem Funktionsaufruf; die übrigen Vertragsbedingungen prüft die reine Domänenfunktion zusätzlich:

- Domäne fehlt, ist unbekannt oder stimmt nicht mit der strukturierten Auftragsbindung überein,
- Auftragsart wurde nur aus Titel, Code oder Freitext vermutet,
- Zielsystem oder Aktion ist nicht positiv gelistet,
- Registry-Revision fehlt, ist veraltet oder weicht ab,
- Scope fehlt, ist mehrdeutig oder nicht freigegeben,
- das erforderliche domänenspezifische Einzelrecht fehlt,
- der Auftragsbezug ist nicht sichtbar, fremd, terminal, storniert oder nicht aktuell zugewiesen,
- der serverseitig gebundene Aufgabenstatus ist weder `pending` noch `active`,
- ein Pflichtfeld fehlt, ist `null`, leer oder nicht exakt freigegeben,
- die Nutzlast würde ein Feld außerhalb der O1-Maximalprojektion enthalten,
- eine technische oder fachliche Anbieteraktivierung fehlt sowie
- die produktive Persistenz ist PostgreSQL, für die O6 geschlossen bleibt.

Blockierte Prüfungen geben keine verborgenen Mitarbeiter-, Fall-, Aufgaben-, Ziel- oder Registry-Daten preis. Sie verändern keinen Status und schließen keine Aufgabe ab.

## 9. Schulungsgrenze

Grabenplaner darf Schulungszuweisung, Status und Nachweis erst dann als dauerhaften Schulungsverlauf führen, wenn eine ausdrückliche O6-Schulungsbindung fachlich und technisch freigegeben ist. O6 erzeugt im Minimalumfang kein Schulungsregister und keine neue zweite Wahrheit.

Die vorhandenen allgemeinen M4-/M5-Workflows des Typs `training` werden nicht rückwirkend als Schulungsregister, LMS-Auftrag oder O6-Schnittstelle klassifiziert. Ihr Titel, Typ oder Dokumentbezug reicht nicht für eine O6-Bindung.

Nach einer späteren ausdrücklichen Integrationsentscheidung können Lerninhalt und Kursdurchführung in einem externen Lernsystem liegen. Grabenplaner hält dann ausschließlich die freigegebene Zuweisung, den Status und den erforderlichen Nachweis. Lerninhalte, Kursmedien, Lernverhalten oder vollständige LMS-Profile werden nicht in O6 übernommen.

## 10. Arbeitsmittel- und Zugangsgrenzen

Das vorhandene Leihmodul bleibt fachlich und technisch eigenständig. O6 darf keinen Leihvorgang anlegen, bearbeiten, schließen, wieder öffnen, ausgeben oder zurücknehmen. Eine Lifecycle-Aufgabe ist weder ein Gerätebestand noch ein Übergabe- oder Rückgabebeleg.

O6 führt keine Konto-, Rollen-, Gruppen-, Sitzungs-, Zutritts-, Schlüssel-, Geräte- oder sonstige Arbeitsmittelmutation aus. Auch vermeintlich reversible Aktionen bleiben ohne kundenspezifischen Anbieter-, Rechte-, Idempotenz-, Rückmeldungs- und Wiederherstellungsvertrag gesperrt.

Die vorhandene Runtime für Personalimport und Lohnverrechnung wird nicht für O6 wiederverwendet. Deren Provider, Verbindungsprofile, Secrets, Delivery-Tabellen und Endpunkte stellen keine Positivliste für Schulungs-, Arbeitsmittel- oder Zugangssysteme dar.

## 11. O5 bleibt unverändert und nicht dispatchfähig

O5 bleibt bei exakt sechs internen Pflichtaufträgen. O6 ergänzt, ersetzt, teilt oder vervielfacht keinen dieser Aufträge und ändert keinen O5-Zustandsübergang.

Die O5-Zugangsprojektion verwendet derzeit den allgemeinen Wert `targetSystem: "managed_accesses"`; ihre Aktion stammt aus dem Aufgabentitel und ist damit Freitext. Die O5-Arbeitsmittelprojektion besitzt derzeit `assetIdentifier: null`; auch dort stammt die Aktion aus dem Titel. Diese Werte sind bewusst nicht dispatchfähig:

- `managed_accesses` ist keine freigegebene konkrete Zielsystemkennung,
- Freitext ist keine positiv gelistete strukturierte Aktion und
- eine fehlende konkrete Asset-Kennung kann keinen Arbeitsmittelauftrag adressieren.

Ein späterer Übergang benötigt eine neue ausdrückliche strukturierte O6-Bindung. O6 interpretiert oder repariert bestehende O5-Daten nicht stillschweigend und beendet nach einem Preflight keine O5-Aufgabe automatisch.

Die Kennung `managed_accesses` ist im O6-Vertrag zusätzlich als reservierte O5-Sammelkennung gesperrt. Sie kann auch dann weder Providerziel noch freigegebenes Zugangsziel werden, wenn Registry-Ziel, Projektion und strukturierte Aktion absichtlich auf denselben Wert gesetzt würden.

## 12. Ausdrücklich nicht enthalten

- Persistenz von Schnittstellenaufträgen, Preflights, Ausführungsständen oder Fremdsystemrückmeldungen,
- Dispatch-, Versand-, Retry-, Queue-, Webhook-, Callback- oder sonstiger Netzwerkpfad,
- API-Schlüssel, OAuth, Zertifikate, Secret-Vault-Erweiterungen oder Anbieteradapter,
- Konto-, Rollen-, Gruppen-, Sitzungs- oder Berechtigungsmutation,
- Zutritts-, Schlüssel-, Geräte-, Bestands-, Leih-, Übergabe- oder Rückgabemutation,
- LMS-Inhalt, Kursmedien, Lerntelemetrie oder automatischer Schulungsabschluss,
- Benachrichtigungen, Erinnerungen, Kalenderobjekte, Vertretungen oder Eskalationen,
- automatischer Start, automatische Zuweisung oder automatischer Abschluss einer Lifecycle-Aufgabe,
- Ableitung einer Schnittstellendomäne aus Titel, Code, Typ, Rolle oder Freitext,
- Verwendung der bestehenden Personalimport-/Lohn-Integrationsruntime,
- produktive PostgreSQL-Aktivierung,
- Bestandteile der parallel entwickelten Verkaufsverwaltung sowie
- Commit, Push, Release oder VPS-Aktualisierung.

## 13. Spätere Aktivierungsvorbehalte

Eine reale Integration benötigt je Anbieter und Zielsystem einen neuen ausdrücklich freigegebenen Ausbau. Vor einer Aktivierung müssen mindestens dokumentiert und geprüft sein:

1. fachlicher Zweck und Verantwortlicher,
2. Rechtsgrundlage, Datenschutzprüfung und erforderliche Aufbewahrung,
3. konkrete Domäne, Zielsysteme, Aktionen und Scopes,
4. exakte Feldlisten je Aktion und Scope,
5. Rollenunabhängige Einzelrechte und Freigabeprozess,
6. Idempotenzschlüssel und Replay-/Konfliktregeln,
7. Authentisierung, Secret-Schutz und Netzwerkgrenze,
8. kontrollierte Zustände für Erfolg, Ablehnung, unbekanntes Ergebnis und Wiederholung,
9. datensparsame Rückmeldung und Auditprojektion,
10. Abbruch-, Wiederherstellungs- und Betriebsverfahren sowie
11. SQLite- und gegebenenfalls vollständiger PostgreSQL-Vertrag.

Eine Aktivierung darf die O6-Minimalgrenze nicht durch einen generischen Anbieteradapter umgehen. Neue Mutationen, Tabellen, Delivery-Zustände oder Außenwirkungen benötigen einen eigenen überprüfbaren Block.

## 14. Abnahmekriterien und Negativtests

O6 ist im freigegebenen Minimalumfang erst technisch abgenommen, wenn mindestens nachgewiesen ist:

- die Registry enthält standardmäßig null aktive Ziele,
- der Katalog zeigt nur Domänen mit dem jeweils eigenen Leserecht,
- technische Rollen erhalten keine Rechte automatisch,
- der Rechtekatalog enthält je Domäne getrennt `read`, `manage`, `dispatch` und `reconcile`, ohne Rollen-Autogrant,
- öffentlich wirksam ist in O6 ausschließlich das jeweilige `read`-Recht für den gefilterten Katalog,
- unbekannte Domäne, Ziel, Aktion, Revision und Scope werden fail-closed abgewiesen,
- Titel, Codes, Workflowtyp und Freitext lösen keine Domänenbindung aus,
- O1-Felder werden nur als Maximalgrenze und nie als pauschale Nutzlast verwendet,
- fremde, nicht zugewiesene oder bereichsfremde Aufgaben bleiben verborgen,
- fehlende, abgeschlossene, stornierte oder sonst nicht bearbeitbare Aufgabenstatus bleiben blockiert,
- `managed_accesses`, Freitextaktionen und `assetIdentifier: null` bleiben blockiert,
- `managed_accesses` bleibt auch bei identischer Provider- und Projektionskennung blockiert,
- allgemeine M4-/M5-Schulungsworkflows werden nicht als O6-Schulungen behandelt,
- abgewiesene und erfolgreiche Aufrufe der reinen Preflight-Domänenfunktion erzeugen keine Datenbankzeile, fachliche Operation oder Aufgabe,
- es existiert kein öffentlicher Preflight-, Manage-, Dispatch- oder Reconcile-Endpunkt und kein Netzwerkaufruf,
- kein Preflight verändert O4-/O5-Status oder schließt eine Aufgabe ab,
- das Leihmodul und die Personalimport-/Lohn-Integrationsruntime bleiben unverändert,
- Rechteverlust und Profil-/Identitätswechsel bereinigen UI-Zustand und DOM,
- SQLite-Migrationen bleiben additiv unverändert und PostgreSQL bleibt geschlossen,
- `personnelLifecycle` ist standardmäßig deaktiviert,
- Persistenz-Coupling-, Syntax-, Sicherheits- und vollständige serielle Regression bleiben erfolgreich und
- Desktop- sowie 320-Pixel-Browseransicht werden interaktiv geprüft, sobald Chrome steuerbar verbunden ist.

## 15. Prüf- und Veröffentlichungsstand

Der abschließende lokale Prüfstand ist erfolgreich:

- O6-Vertrag, API und UI: 30 von 30 Tests erfolgreich,
- Portal- und Rollenfundament: 14 von 14 Tests erfolgreich,
- zusammenhängende O1-bis-O6-Lifecycle-Suite: 231 von 231 Tests erfolgreich,
- vollständige serielle Projektregression: 1.894 Tests, davon 1.854 erfolgreich, 40 planmäßig übersprungen und 0 fehlgeschlagen,
- Persistenz-Coupling-Audit: Ergebnis `OK`, 0 unklassifizierte Produktdateien, 0 unklassifizierte Testdateien und 0 Phasengrenzverletzungen,
- Syntax- und `git diff --check`-Prüfung: erfolgreich sowie
- unabhängiger O6-Sicherheitsreaudit: keine verbleibenden P0-, P1- oder P2-Befunde im freigegebenen Minimalumfang.

Die interaktive Browserabnahme ist noch offen, weil die Chrome-Brücke in der aktuellen Codex-Sitzung nicht verbunden ist. Eine automatisierte UI-Prüfung ersetzt diese Desktop-/320-Pixel-Abnahme nicht.

Der PostgreSQL-Pfad bleibt für O6 geschlossen. Das Feature `personnelLifecycle` bleibt standardmäßig deaktiviert. Der separate Arbeitsbaum der parallel entwickelten Verkaufsverwaltung wurde ausschließlich lesend kontrolliert; seine vorhandenen parallelen Änderungen wurden von O6 nicht berührt.

Dieser lokale Arbeitsstand enthält keinen Commit, Push, Release, Deploy und keine Produktivaktivierung.
