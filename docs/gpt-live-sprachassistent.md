# GPT Live Sprachassistent im Mitarbeiterportal

Der optionale GP-Assistent fragt eigene Urlaubssalden, den letzten importierten ZA-Saldo, eigene Dienste und den eigenen Antragsverlauf ab. Urlaub und ZA werden zunächst als Gesprächsentwurf vorbereitet. Erst die Schaltfläche **Antrag verbindlich absenden** reicht den angezeigten Entwurf über den bestehenden GP-Antragsprozess ein. Die Genehmigung bleibt bei der zuständigen Leitung.

Der lokale Entwicklungsstand ist für einen Administrator-Pilot vorbereitet. Ohne Konfiguration bleibt das Modul ausgeschaltet. Am 12. Oktober 2026 wurden echte OpenAI-WebRTC-Läufe mit synthetischer deutscher Sprache und isolierten GP-Testdaten durchgeführt: eigener Urlaubssaldo, eigener Dienstplan, Urlaubsentwurf und ZA-Entwurf mit anschließender ausdrücklicher Bestätigung. Eine produktive Aktivierung wurde dabei nicht vorgenommen.

## Integration in den bestehenden GP

| Aufgabe | Wiederverwendeter Einstieg | Persönliche Rechte |
| --- | --- | --- |
| Urlaubssaldo | `vacationAccountsForYear`, versioniertes Urlaubskonto und bestehende Planbewertung | `own_vacation:read` |
| ZA-Saldo | `timeTrackingRepository.listLatestXoffiBalances`, Ausgabe ausschließlich des angemeldeten Mitarbeiters | `own_time:read` |
| Eigener Dienstplan | Gemeinsame Funktion `ownPortalSchedule` für Portal und Assistent | `own_schedule:read` |
| Eigene Anträge | `absenceHistoryForEmployee`, reduzierte Ausgabe ohne Freigebende, Notizen oder fremde Stammdaten | `own_vacation:read` und/oder `own_time:read` |
| Urlaubsvorschau | `evaluateVacationRequest`, `vacationDayCount`, bestehendes Urlaubskonto | `own_vacation:request` und `own_vacation:read` |
| ZA-Vorschau | `evaluateTimeOffRequest`, `plannedDayMetrics`, letzter vorhandener Abschlusssaldo | `own_time:write` und `own_time:read` |
| Verbindliche Einreichung | `createOwnVacationRequest` beziehungsweise `createOwnTimeOffRequest` | Dieselben persönlichen Rechte, erneut geprüft |

Die bestehenden Installationsfreigaben für Mitarbeiterportal, Dienstplanung, Urlaub, Anträge und Zeiterfassung bleiben verbindlich. Es gibt keine zusätzlichen Personaltabellen, Antragsdatensätze, Genehmigungsfunktionen oder Dienstplan-Schreibfunktionen für die KI.

Die neuen Dateien `lib/voice-assistant*.js` trennen Datumsauflösung, OpenAI-Anbindung, Gesprächssteuerung und Routen. `public/voice-assistant.js` und `.css` bilden die zusätzliche Portaloberfläche. Die gemeinsame eigene Dienstplanabfrage ist in `ownPortalSchedule` ausgelagert.

## OpenAI Verbindung

Der Browser erstellt eine WebRTC-Verbindung mit Mikrofonspur und dem Datenkanal `oai-events`. Das GP-Backend sendet den SDP-Offer zusammen mit seiner eigenen Konfiguration an `POST https://api.openai.com/v1/live/sessions`. Es verwendet genau `gpt-live-1`, `delegation: { type: "client" }` und `store: false`. Nur Sitzungskennung und SDP-Antwort werden an den Browser zurückgegeben. Befehle werden erst nach `session.started` gesendet; ein zusätzliches `session.start` wird nicht gesendet. Das entspricht der [offiziellen WebRTC-Anbindung](https://developers.openai.com/api/docs/guides/voice-webrtc).

GPT-Live liefert Gesprächsfragmente und Delegationen. Da eine Delegation keine Aufgabenbeschreibung enthält, sammelt die Portaloberfläche die Eingabefragmente und übergibt die Äußerung an die authentifizierte GP-Route. Die serverseitige Responses-Anbindung interpretiert daraus eine beschränkte Absicht; Standardmodell ist `gpt-6-luna`. Sie kann keine Tools ausführen. Zulässig sind ausschließlich Abfrage, Entwurf, Verwerfen, Bedienhilfe oder Rückfrage. Daten und Geschäftsregeln werden anschließend ausschließlich im GP ausgeführt. Verifizierte kurze Antworten kehren über `session.commentary.append` mit der ursprünglichen Delegationskennung in die Sprachausgabe zurück. Siehe [Client Delegation](https://developers.openai.com/api/docs/guides/live-delegation).

Die Texteingabe verwendet dieselbe serverseitige Interpretation und dieselben GP-Funktionen. Sie benötigt keine Mikrofonberechtigung und keine laufende Live-Sitzung. Bei Verbindungsfehlern erfolgt keine automatische Wiederholung einer Einreichung.

## Entwurf und ausdrückliche Bestätigung

Ein Gespräch und sein Entwurf sind an die konkrete GP-Sitzung und den angemeldeten Mitarbeiter gebunden. Der Mitarbeiter kann keine fremde Personalnummer, Rolle, Freigabeart oder Datenbankabfrage angeben. Nicht unterstützte Parameter werden zurückgewiesen.

Ein Entwurf bleibt im begrenzten Server-Arbeitsspeicher und läuft nach zehn Minuten ab. Er enthält Art, Zeitraum, gegebenenfalls Uhrzeiten, eine aktuelle GP-Vorprüfung, Saldenhinweise und eine zufällige Bestätigungskennung. Die Vorschau zeigt den Zeitraum sowie die vorhandene GP-Bewertung und wird bei Sprachbetrieb vorgelesen. Die Bestätigungskennung wird nicht an das Modell übertragen.

Ein gesprochenes „Ja“ reicht nicht zur Einreichung. Nach Prüfung der sichtbaren Vorschau muss der Mitarbeiter **Antrag verbindlich absenden** betätigen. Das ist eine bewusste Grenze des ersten Piloten: GPT-Live-Transkripte sind Fragmente und besitzen hier keine verlässliche Bestätigung eines vollständigen Benutzerturns. Eine vollständig sprachgesteuerte verbindliche Bestätigung ist noch nicht Teil dieser Version.

Jede neue Äußerung entwertet zunächst die alte Bestätigungskennung. Ein erkannter neuer Zeitraum erzeugt einen neuen Entwurf. Bei einer unabhängigen Abfrage oder einer Bestätigung als Gesprächsbeitrag wird die vorhandene Vorschau erneut geprüft und eine neue Kennung ausgegeben. Bei unklaren Korrekturen oder API-Ausfällen bleibt die alte Bestätigung gesperrt. Unvollständige Sprache kann dadurch keinen Antrag absenden.

Beim Bestätigen werden Sitzung, persönliche Rechte, aktuelle GP-Prüfung, Tage beziehungsweise Stunden und Salden nochmals geprüft. Ändert sich die Vorschau, muss die aktualisierte Vorschau erneut bestätigt werden. Die vorhandenen GP-Erstellungsfunktionen validieren die Parameter wieder und protokollieren Antrag, Entscheidungsschritt sowie Benachrichtigungen innerhalb ihres bestehenden Vorgangs. Eine wiederholte Bestätigung desselben erfolgreich eingereichten Entwurfs liefert dasselbe Ergebnis. Nach einem Serverneustart werden keine Gesprächsentwürfe wiederhergestellt oder automatisch eingereicht; bereits eingereichte Anträge stehen im normalen Antragsverlauf.

## Datumsauflösung und vorhandene Grenzen

Kalendertage werden serverseitig anhand **Europe/Vienna** aufgelöst. Unterstützt werden ISO-Daten, deutsche numerische Daten, benannte Monate, häufige gesprochene Ordinalzahlen, heute/morgen/übermorgen, Wochentage sowie diese/nächste Woche. „Nächsten Freitag“ bedeutet den nächsten zukünftigen Freitag; „Freitag nächste Woche“ meint Freitag der nächsten Kalenderwoche. Die gewählte Interpretation und das Jahr erscheinen ausdrücklich in der Vorschau. Fehlende oder ungültige Angaben führen zu einer Rückfrage. Die bestehenden GP-Grenzen für vergangene Zeiträume, den Antragshorizont, Überschneidungen und Sperrzeiten bleiben maßgeblich.

Der GP führt in dieser Architektur keinen laufenden kumulierten ZA-Saldo für die persönliche Portalabfrage. Der Assistent stellt daher den vorhandenen importierten Abschlusssaldo mit seiner Bezugswoche bereit. Eine Wochendifferenz wird nicht als ZA-Guthaben ausgegeben. Fehlt der Saldo oder der vollständige Dienstplan, wird die Stundenbewertung zur bestehenden Freigabeprüfung gekennzeichnet. Ein stundenweiser ZA zeigt das beantragte Zeitfenster; die endgültige Bewertung bleibt im GP-Prozess.

Die bestehenden GP-Erstellungsfunktionen erlauben Anträge zur manuellen Prüfung auch bei bestimmten Personalbesetzungswarnungen. Ein fehlender oder für den Entwurf zu niedriger Saldo wird angezeigt; diese zusätzliche Oberfläche erfindet keine neue automatische Ablehnungsregel. Ausdrückliche Antragssperren bleiben verbindlich. Für Urlaub werden die vorhandenen Feiertags- und Tageszählregeln verwendet, auch wenn diese von einer einfachen Wochentagszählung abweichen.

Allgemeine Bedienhilfe ist eine kurze, fest hinterlegte Orientierung zu den unterstützten Portalbereichen. Eine umfassende durchsuchbare GP-Wissensbibliothek ist in diesem Modul noch nicht angebunden. Intelligente Dienstplanprüfung und automatische Optimierung bleiben außerhalb dieses Moduls.

## Konfiguration und Einrichtung

Für einen persönlichen Pilot lassen sich auf **portal.assistant** einzelne Personalnummern eintragen. Eine nicht leere Liste begrenzt zusätzlich zur Rollenfreigabe jeden Aufruf auf diese persönlichen Konten. Die serverseitige Variable `GRABENPLANER_VOICE_ASSISTANT_PILOT_EMPLOYEES` setzt eine zusätzliche Obergrenze (kommagetrennte Personalnummern). Die Oberfläche kann diese Grenze nicht erweitern. Ungültige Listen sperren den Betrieb; ein Entzug wirkt auch auf bereits laufende Gespräche und vorbereitete Bestätigungen. Bestehende gespeicherte Einstellungen ohne Liste werden beim Lesen kompatibel ergänzt; veraltete Browser dürfen beim Speichern keine Liste versehentlich entfernen.

Im **Developer-Bereich → voice.assistants** liegen die allgemeinen Freigaben, Gesprächsdauer, Anzahl gleichzeitiger GP-Gespräche und der Status der serverseitigen OpenAI-Konfiguration. Die Unterseite **portal.assistant** verwaltet die eigene Freigabe des MA-Sprachassistenten und den Administrator-Pilot. Nur ein aktiver persönlicher Developer-Zugang mit Einstellungsrecht und geändertem Startpasswort darf diese Einstellungen lesen oder speichern. Die API erzwingt dieselbe Grenze bei direkten Aufrufen.

Die nicht geheimen Einstellungen werden als versionierter JSON-Wert `voice_assistants` in der bestehenden GP-Einstellungstabelle gespeichert. Gleichzeitige Änderungen werden anhand des zuletzt gelesenen Inhaltsstands erkannt und mit HTTP 409 zurückgewiesen. Änderungen werden im bestehenden Audit protokolliert. Es werden weder API-Schlüssel noch Transkripte in diesen Einstellungen oder Audits gespeichert.

Solange noch kein Wert gespeichert wurde, liefern die folgenden Servervariablen die Vorgaben. Danach haben die Developer-Einstellungen Vorrang bei Freigabe, Pilotgruppe und Gesprächsgrenzen. Eine ausdrücklich gesetzte Variable `GRABENPLANER_VOICE_ASSISTANT_ENABLED=0` bleibt eine übergeordnete Betriebssperre. API-Schlüssel und Textmodell werden weiterhin ausschließlich serverseitig konfiguriert. Fehlerhafte gespeicherte Einstellungen schalten den Assistenten aus.

| Servervariable | Standard | Bedeutung |
| --- | --- | --- |
| `GRABENPLANER_VOICE_ASSISTANT_ENABLED` | nicht gesetzt; Modul aus | `1` als erstmalige Freigabevorgabe; ausdrücklich `0` sperrt auch eine Developer-Freigabe |
| `GRABENPLANER_VOICE_ASSISTANT_ADMIN_ONLY` | `1` | Pilot nur für persönliche Zugänge mit Rolle `admin`, `it_admin` oder `developer`; `0` hebt die Pilotsperre auf, persönliche Rechte bleiben gültig |
| `GRABENPLANER_VOICE_ASSISTANT_PILOT_EMPLOYEES` | leer | Zusätzliche serverseitige Begrenzung auf kommagetrennte Personalnummern; keine Erweiterung durch Developer-Einstellungen möglich |
| `GRABENPLANER_OPENAI_API_KEY` | leer | Projekt-API-Schlüssel nur auf dem GP-Server; alternativ wird `OPENAI_API_KEY` verwendet |
| `GRABENPLANER_VOICE_BACKEND_MODEL` | `gpt-6-luna` | Responses-Modell für die beschränkte Absichtsinterpretation |
| `GRABENPLANER_VOICE_MAX_SECONDS` | `600` | Gesprächslimit der normalen Portaloberfläche, zulässiger Wert 60–1800 Sekunden |
| `GRABENPLANER_VOICE_MAX_CONVERSATIONS` | `8` | Maximal gleichzeitig vorgehaltene GP-Gespräche, zulässiger Wert 1–50 |

Für einen späteren Administrator-Pilot einen OpenAI-Projektschlüssel mit Zugriff auf `gpt-live-1` und das Responses-Modell in der geschützten Server-Laufzeitkonfiguration hinterlegen. Er gehört weder ins Repository noch in Browsercode oder Portalformulare. Die bestehende Serverkonfiguration muss die Variablen in den GP-Prozess übernehmen; dieses Modul lädt selbst keine zusätzliche `.env`-Datei.

Danach `voice.assistants` und `portal.assistant` freigeben und die Administratorsperre beibehalten. Das Portal neu laden, damit es die aktuelle Mikrofon-Policy erhält. Sprachbetrieb braucht HTTPS oder localhost, einen aktuellen WebRTC-Browser und ausdrücklich erlaubten Mikrofonzugriff. Das Mikrofon wird nur für das aktivierte Portal in der Permissions-Policy freigegeben; die übrigen GP-Seiten bleiben gesperrt. Die bestehende Content-Security-Policy wird um die benötigte MediaStream-Ausgabe ergänzt. Der Browser sendet keine HTTP-Anfragen mit einem OpenAI-Schlüssel.

Die GP-Routen begrenzen Gesprächsstarts pro Sitzung auf zwölf pro Stunde und Nachrichten auf zwanzig pro Minute sowie achtzig pro Gespräch. Gesprächs- und Entwurfsdaten sind zeitlich begrenzt; Responses-Aufrufe haben ein 20-Sekunden-Limit. Der reguläre Browser beendet Live-Gespräche nach dem konfigurierten Limit. Dieses Browserlimit ist kein serverseitiger harter OpenAI-Ausgabenstopp: ein veränderter Client kann es umgehen. OpenAI-Projektlimits und Verbrauch müssen deshalb zusätzlich im Projekt verwaltet werden.

## Speicherung und Datenminimierung

Der GP schreibt weder Audioaufnahmen noch Gesprächstexte auf Datenträger. Texte, Antwortdaten und Entwürfe liegen ausschließlich im begrenzten Gesprächsspeicher beziehungsweise in der aktuellen Browseransicht. Beenden, Abmelden und Kontowechsel entfernen die Gesprächsanzeige und Bestätigungsfähigkeit. Das Mikrofon wird beim Beenden sofort gestoppt, auch wenn die Sprachverbindung noch ihren Abschluss bestätigt.

An OpenAI gelangen die gesprochenen Äußerungen beziehungsweise Texteingaben, ein kleiner Ausschnitt der Benutzerhistorie, gegebenenfalls der aktuelle Entwurfszeitraum und die für eine gesprochene Antwort benötigten eigenen GP-Fakten. Die Absichtsinterpretation erhält keine vollständigen Personalakten, API-Schlüssel, Bestätigungskennungen, Genehmigungsnotizen oder andere Mitarbeiterdatensätze. GP-Aktionsprotokolle enthalten nur die ausgeführten Abfragen, Gesprächsstart/-ende und Entwurfsvorgänge als Metadaten; der bestehende GP-Antragsaudit bleibt unverändert.

`store: false` verhindert die optionale gespeicherte Live-Aufnahme und wird auch für Responses gesetzt. Das bedeutet keine allgemeine Nullspeicherung bei OpenAI: Die Standardregeln für Missbrauchsüberwachung können weiterhin gelten. Projektbezogene Datenkontrollen und gegebenenfalls Zero Data Retention sind separat einzurichten. Maßgeblich sind die [offiziellen Datenkontrollen](https://developers.openai.com/api/docs/guides/your-data).

## Voraussichtliche Nutzungskosten

Stand 12. Oktober 2026 kostet [GPT-Live 1](https://developers.openai.com/api/docs/models/gpt-live-1) **0,05 USD je Gesprächsminute**, sekundengenau. Auch eine verbundene Sitzung ohne Sprache kostet Laufzeit. Bei der WebRTC-Initialisierung werden 15 Sekunden berechnet und nach erfolgreichem Start auf die Laufzeit angerechnet; ein abgebrochener Start kann daher etwa 0,0125 USD kosten. Siehe [Live-Kosten und Initialisierung](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live).

Die Interpretation wird separat berechnet. [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) kostet im Standardtarif 0,10 USD pro Million Eingabetokens und 0,50 USD pro Million Ausgabetokens. Ein angenommener Interpretationsaufruf mit 2.000 Eingabe- und 200 Ausgabetokens kostet etwa 0,0003 USD.

| Angenommene Nutzung | Live-Kosten | Geschätzte Interpretation |
| --- | --- | --- |
| Ein Gespräch mit fünf Minuten und fünf Abfragen | 0,25 USD | etwa 0,0015 USD |
| 100 Mitarbeitende mit je 20 Gesprächen à drei Minuten und fünf Abfragen im Monat | 300 USD | etwa 3 USD |

Diese Rechenbeispiele sind keine gemessenen GP-Verbrauchswerte. Steuern, Währungsumrechnung, andere Modelle und abweichende Projekttarife sind nicht enthalten. Reine Texteingabe verursacht keine Live-Minuten, sondern die Interpretation der Nachrichten. Aktuelle Projektpreise sind vor Aktivierung zu prüfen.

## Tests und Pilotabnahme

Die regulären Tests verwenden synthetische Personen, eine isolierte temporäre GP-Datenbank und simulierte OpenAI- beziehungsweise Medienantworten. Sie prüfen eigene Daten, echte bestehende GP-Erstellungsfunktionen, Rechte und CSRF, fremde Sitzungen, Datumsgrenzen, Feiertage, geänderte Vorschauen, doppelte Bestätigung, Verbindungsfehler, Abmeldung sowie Desktop-/Smartphone-Darstellung. Diese Tests verursachen keine Modellkosten.

Modul- und API-Tests:

```powershell
node --test --test-concurrency=1 test/voice-assistant-dates.test.js test/voice-assistant.test.js test/voice-assistant-api.test.js
node --test --test-concurrency=1 test/assistant-management-api.test.js test/planning-assistant.test.js
```

Browserprüfungen verwenden die vorhandene Playwright-Testkonvention. `GP_BROWSER_TEST_MODULE` und gegebenenfalls `GP_BROWSER_EXECUTABLE` müssen auf eine lokal verfügbare Playwright-Installation beziehungsweise einen Testbrowser zeigen:

```powershell
$env:GP_WINDOW_BROWSER_TEST = '1'
node --test --test-concurrency=1 test/voice-assistant-browser.test.js
node --test --test-concurrency=1 test/assistant-management-browser.test.js
```

`scripts/verify-assistant-live.js` führt zusätzlich einen ausdrücklich aktivierten, kostenpflichtigen Test mit dem echten Portal, tatsächlicher WebRTC-Verbindung, GPT-Live-1 und GPT-6 Luna durch. Es startet einen isolierten GP mit synthetischen Personen und speist eine synthetisch gesprochene WAV-Datei über Chromes Testmikrofon ein. Es prüft GP-Daten, Delegation, Rücksprache, Audio in beide Richtungen und Mikrofonstopp. Urlaub/ZA erzeugen vor der Bestätigung keinen Antrag; nach dem Klick muss genau ein Antrag im normalen offenen Freigabeprozess stehen. Testdatenbank und Gespräche werden anschließend geschlossen und entfernt. Der Schlüssel wird nur in den Testprozess geladen; im Repository und in den Ergebnisbelegen steht kein Schlüssel.

Beispiel für Windows (vorhandene Playwright-/Chrome-Einstellungen wie oben):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-assistant-test-audio.ps1
$env:GP_VOICE_LIVE_TEST = '1'
$env:GP_VOICE_TEST_KEY_FILE = 'C:\geschuetzte-testkonfiguration\.env.local'
$env:GP_VOICE_TEST_SCENARIO = 'balances' # alternativ schedule, vacation, time_off
$env:GP_VOICE_TEST_AUDIO = Join-Path (Get-Location) ('output\planning-assistant-live\' + $env:GP_VOICE_TEST_SCENARIO + '.wav')
node scripts/verify-assistant-live.js
```

Alternativ kann der Schlüssel bereits als `GRABENPLANER_OPENAI_API_KEY` im Prozess vorliegen. `GP_VOICE_TEST_KEY_FILE` darf nur auf eine für den Test freigegebene Datei zeigen; der Test liest daraus ausschließlich die unterstützte OpenAI-Variable. Ein aufgezeichneter Mitarbeiterdialog ist für diesen Test nicht erforderlich. Auf anderen Plattformen kann eine lokal erzeugte synthetische WAV-Datei bereitgestellt werden. Die vier erfolgreichen lokalen Läufe belegen den echten API-/Audio-Durchlauf mit Testdaten; ein physisches Mikrofon und reale Mobilgeräte bleiben Teil der jeweiligen betrieblichen Pilotabnahme.
