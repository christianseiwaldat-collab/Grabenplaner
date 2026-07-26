# Personal-Regelwerk – Freigabe und Wirksamkeit v0.1

| Merkmal | Stand |
|---|---|
| Roadmap | Block 6 von 7 |
| Datum | 26. Juli 2026 |
| Status | lokale Arbeitsfassung im gemeinsamen GitHub-Draft-PR |
| VPS | bis zum Abschluss aller sieben Blöcke unverändert |
| Rechtswirkung | technische Governance-Unterstützung, keine pauschale Rechtsfreigabe |

## Zweck

Block 6 verbindet den Regelbaukasten und das Kollektivvertragsregister mit einem nachvollziehbaren Prüf- und Freigabeweg. Veröffentlichung und betriebliche Wirksamkeit bleiben getrennte Vorgänge:

1. Eine unveränderliche Entwurfsfassung wird zur Prüfung eingereicht.
2. Unabhängige, aktuell angemeldete Personen dokumentieren ihre Entscheidung.
3. Nach vollständiger Freigabe entsteht eine neue unveränderliche Veröffentlichungsfassung.
4. Erst eine gesondert geprüfte Geltungszuordnung kann diese Fassung im Dienstplan wirksam machen.

Eine veröffentlichte Regel ist daher nicht automatisch einer Person oder einem Bereich zugeordnet.

## Statuswege

### Regelfassung

`Entwurf → Prüfung offen → freigegeben → veröffentlicht → abgelöst oder zurückgezogen`

### Geltungszuordnung

`Zuordnungsantrag → Prüfung offen → geplant oder wirksam → beendet`

Änderungen, Beendigungen und Wiederherstellungen überschreiben keine vorhandenen Datensätze. Sie erzeugen neue Fassungen oder Ereignisse.

## Rechte und Vier-Augen-Prinzip

Block 6 trennt die bisherigen technischen Verwaltungsrechte:

| Recht | Wirkung |
|---|---|
| `work_rules:draft` | Entwürfe erstellen, fortschreiben und zur Prüfung einreichen |
| `work_rules:review` | als aktuell angemeldete Person fachlich prüfen |
| `work_rules:publish` | vollständig freigegebene Fassungen veröffentlichen oder zurückziehen |
| `work_rules:assign` | geprüfte Zuordnungen aktivieren oder beenden |
| `work_rules:audit` | vollständige Governance- und Prüfhistorie lesen |
| `collective_agreements:approve` | KV-Zuordnungen im gesonderten Freigabeverfahren entscheiden |

`work_rules:manage` verleiht keines dieser neuen Freigaberechte.

Für jede Entscheidung gilt:

- Die einreichende Person kann den eigenen Antrag nicht freigeben.
- Jede Personalnummer zählt höchstens einmal.
- Die Anwendung verwendet den aktuell angemeldeten Zugang; eine freigebende Person wird nicht aus einer Liste ausgewählt.
- Mindestens eine erforderliche Freigabe muss fachlich qualifiziert sein.
- IT-Admin und Developer erhalten standardmäßig kein fachliches Prüf-, Veröffentlichungs-, Zuordnungs- oder KV-Freigaberecht.
- Der lokale Einzelplatz-Akteur kann kein Vier-Augen-Verfahren nachbilden.

Normale Monitor- und Hinweisvorgänge benötigen eine unabhängige Freigabe. Kritische Vorgänge benötigen zwei unabhängige Freigaben. Als kritisch gelten insbesondere:

- Blockierwirkung,
- Durchsetzungsmodus `enforced`,
- KV-Zuordnung,
- Rücknahme einer Veröffentlichung,
- Beendigung einer wirksamen Zuordnung.

## Bindung der Freigabe

Eine Freigabe bezieht sich immer auf einen exakten, per SHA-256 belegten Stand:

- Regelfassung und Quellen,
- vorgesehene Wirkung,
- Geltungsbereich und Zeitraum,
- Organisationsstand des Geltungsbereichs,
- Ergebnis der Konfliktprüfung.

Ändert sich einer dieser Stände zwischen Einreichung und Vollzug, wird der Antrag als veraltet behandelt. Die Freigaben werden nicht still auf einen neuen Inhalt übertragen.

## Konfliktprüfung

Vor Einreichung und unmittelbar vor dem Vollzug wird dieselbe deterministische Prüfung ausgeführt.

Blockierend sind insbesondere:

- unbekannte oder nicht veröffentlichte Fassungen,
- ein Geltungsbereich außerhalb des genehmigten Regelentwurfs,
- Zeitraum außerhalb der Fassungs-Gültigkeit,
- nicht unterstützte Laufzeitbausteine,
- noch nicht maschinenlesbare Beschäftigtengruppen,
- Betriebsteile mit noch nicht auswertbaren Kostenstellenbereichen,
- überlappende wirksame Fassungen derselben eigenen Regel,
- veralteter Organisations- oder Zuordnungsstand.

Warnungen ersetzen keine rechtliche Prüfung. Die Oberfläche formuliert deshalb ausschließlich, dass keine gespeicherte technische Überschneidung gefunden wurde.

## Additive Anwendung

Gesetzliche, jugendspezifische, kollektivvertragliche und betriebliche Regeln werden additiv ermittelt. Eine engere eigene Regel verdrängt kein gesetzliches oder Jugend-Basisprofil.

Insbesondere gilt:

- Bei einer Person unter 18 bleibt das Jugendprofil anhand des Geburtsdatums automatisch erhalten.
- Eigene Regeln kommen als zusätzliche Profilfassung hinzu.
- Priorität wählt nur zwischen konkurrierenden Fassungen derselben Regel beziehungsweise desselben Profils.
- Gleichrangige Überlappungen werden nicht durch eine zufällige ID-Reihenfolge aufgelöst.
- Der unveränderliche Prüfbeleg enthält alle verwendeten Profilversionen.

## Laufzeitunterstützung in Block 6

Eigene Regeln können nach Freigabe im Dienstplan ausgewertet werden, wenn sie einen der folgenden Bausteine verwenden:

- maximale geplante Arbeitszeit pro Tag,
- maximale geplante Arbeitszeit pro Woche,
- Mindestruhezeit zwischen zwei Diensten,
- maximale aufeinanderfolgende Arbeitstage,
- maximale Samstagsdienste pro Kalendermonat,
- frühester geplanter Dienstbeginn,
- spätestes geplantes Dienstende.

Folgende bereits im Baukasten dokumentierbaren Bausteine bleiben veröffentlichbar, aber noch nicht aktivierbar:

- Mindestvorlauf für Urlaubsanträge,
- Mindestvorlauf für Zeitausgleichsanträge,
- maximale Urlaubstage je Antrag.

Diese Bausteine benötigen eigene, später anzubindende Prüfadapter in den Antragsabläufen. Bis dahin verhindert der Server eine nur scheinbar wirksame Aktivierung.

## Geltungsbereiche

In Block 6 unmittelbar aktivierbar sind:

- gesamte Installation,
- aktive Filiale,
- aktive Abteilung.

Betriebsteile werden nur aktiviert, wenn ihre registrierten Bereiche vollständig und maschinenlesbar in unterstützte Filial- und Abteilungsbereiche expandiert werden können. Ein Betriebsteil mit Kostenstellenbereich bleibt bis zum passenden Laufzeitadapter gesperrt.

Freitext-Beschäftigtengruppen bleiben bis zu einem verlässlichen Gruppenmodell nicht aktivierbar.

## Kollektivvertrags-Zuordnungen

Die in Block 4 vorbereiteten KV-Zuordnungsvorschläge bleiben unverändert. Entscheidungen werden als separate, unveränderliche Ereignisse gespeichert.

Eine bestätigte KV-Zuordnung:

- bindet die genaue KV-Fassung,
- bindet einen Snapshot des Betriebsteils,
- benötigt zwei unabhängige Freigaben,
- bestätigt ausschließlich die intern dokumentierte Zuordnungsentscheidung,
- erzeugt nur dann eine Dienstplanwirkung, wenn eine dazu passende veröffentlichte und technisch auswertbare KV-Regelprofil-Version verknüpft ist.

Sie ist keine allgemeine Aussage, dass der Kollektivvertrag rechtlich in allen Einzelfällen anwendbar ist.

## Audit und Integrität

Konfliktläufe, Anträge, Entscheidungen, Veröffentlichungen, Zuordnungsrevisionen und Ereignisse sind append-only gespeichert. Datenbank-Trigger verhindern Änderungen und Löschungen.

Der Governance-Beleg enthält mindestens:

- Akteur und damalige Rolle,
- tatsächlich verwendetes Recht,
- Objekt und exakte Version,
- Begründung und Quellenreferenz,
- Zeitpunkt,
- Inhalts-, Geltungs- und Konflikt-Prüfsummen,
- vorherigen Ereignisbeleg und fortlaufende Sequenz.

Jede Ereigniskette ist durch kanonische SHA-256-Belege verkettet. Ein Integritätsfehler wird nicht als gültiger Stand angezeigt.

## Rücknahme und Wiederherstellung

Eine Rücknahme:

- löscht keine veröffentlichte Fassung,
- beendet verbundene wirksame Zuordnungen kontrolliert,
- benötigt einen eigenen kritischen Freigabeantrag.

Eine frühere veröffentlichte Fassung kann nur als neuer Entwurf übernommen werden. Sie durchläuft erneut Simulation, Konfliktprüfung und Freigabe. Es gibt keinen Zeiger-Rollback und keine Änderung historischer Datensätze.

## Abgrenzung zu Block 7

Block 7 übernimmt die abschließende Gesamtprüfung und Produktabrundung. Dazu gehören insbesondere:

- abschließende bereichsbezogene Lesesicht für FL und AL,
- vollständige Browser- und Bedienungsprüfung aller sieben Blöcke,
- finaler Abgleich von Dokumentation und Produktstatus,
- Freigabeentscheidung für den späteren VPS-Block.

Bis zu dieser Abschlussprüfung bleibt der VPS unverändert.
