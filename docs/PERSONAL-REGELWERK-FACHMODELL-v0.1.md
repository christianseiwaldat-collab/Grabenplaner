# Personal-Regelwerk – Fachliches Grundmodell v0.1

| Merkmal | Stand |
|---|---|
| Roadmap | Block 1 von 7 |
| Konzeptstand | v0.1 |
| Datum | 25. Juli 2026 |
| Technische Ausgangsbasis | lokale Arbeitsfassung auf Grabenplaner v0.85.3 Beta |
| Status | fachliche Arbeitsgrundlage, noch keine rechtliche Freigabe |
| Veröffentlichung | GitHub ab Block 3 im gemeinsamen Draft-PR; VPS bis zum Abschluss aller sieben Blöcke unverändert |

## 1. Zweck

Das Personal-Regelwerk wird die gemeinsame fachliche Quelle für Regeln, die Personalplanung, Arbeitszeit, Urlaub und Abwesenheiten beeinflussen. Es beantwortet:

> Welche Regel gilt für welche Person, in welchem Bereich und zu welchem Zeitpunkt – und wie soll Grabenplaner darauf reagieren?

Das Fachmodell gilt insbesondere für:

- Arbeitszeit und Arbeitsruhe,
- Dienstplanung,
- Jugendliche und Lehrlinge,
- Urlaub, Zeitausgleich und sonstige Abwesenheiten,
- Kollektivverträge,
- Betriebsvereinbarungen,
- Unternehmens-, Standort- und Abteilungsregeln,
- dokumentierte persönliche Ausnahmen.

Es bildet später die gemeinsame Datenbasis für:

- das Dashboard **Personal-Regelwerk**,
- `Personalverwaltung > Regelwerk`,
- `Personalverwaltung > Kollektivverträge`,
- die Regelprüfung in der Dienstplanung,
- nachvollziehbare Regel- und Ausnahmeprotokolle.

## 2. Abgrenzung

Das Personal-Regelwerk beschreibt, **was gilt**. Es ist nicht das Modul, das beschreibt, **wie ein Vorgang abläuft**.

| Bereich | Leitfrage | Beispiel |
|---|---|---|
| Personal-Regelwerk | Was gilt? | Welche Ruhezeit ist einzuhalten? |
| Abläufe & Prozesse | Was passiert wann und wer ist zuständig? | Wie läuft eine Krankmeldung ab? |
| Rechteübersicht | Wer darf was? | Wer darf eine Ausnahme dokumentieren? |
| System-Center | Ist das System technisch gesund? | Ist die Wiederherstellung geprüft? |

Nicht Bestandteil dieses ersten Blocks sind:

- die Dashboard-Oberfläche,
- ein Regeleditor,
- ein KV-Import,
- die Automatisierung betrieblicher Prozesse,
- Lohn- oder Gehaltsberechnungen,
- die fachliche Zuordnung eines konkreten Kollektivvertrags zu Lamprechter,
- eine Zusage vollständiger Rechtskonformität.

Grabenplaner bleibt eine technische Planungs- und Governance-Unterstützung. Die Anwendung ersetzt keine rechtliche Einzelfallprüfung.

## 3. Verbindliche Produktentscheidungen

### PRG-D01 – Name

Der gemeinsame Produktbegriff lautet **Personal-Regelwerk**.

### PRG-D02 – Eine Datenquelle, zwei Einstiege

Dashboard und Personalverwaltung dürfen keine getrennten Regelkopien führen.

- Das Dashboard dient Überblick, Prüfung und Simulation.
- Die Personalverwaltung dient versionierter Pflege, Zuordnung und Freigabe.

### PRG-D03 – Fachliche Geltung und technische Reaktion bleiben getrennt

Eine fachlich anwendbare Regel bleibt anwendbar, auch wenn Grabenplaner vorläufig nur im Monitorbetrieb warnt. Umgekehrt macht ein technischer Blockiermodus eine Regel nicht automatisch rechtlich anwendbar.

### PRG-D04 – Keine stille Deaktivierung höherrangiger Regeln

Gesetzliche und kollektivvertragliche Regeln können nicht wie eine eigene Firmenregel ausgeschaltet oder gelöscht werden. Zulässig ist nur eine nachvollziehbare Feststellung, dass eine konkrete Regel für einen definierten Bereich nicht anwendbar ist.

Diese Feststellung benötigt:

- Begründung,
- Quelle oder fachlichen Nachweis,
- Geltungsbereich,
- Gültigkeitszeitraum,
- verantwortliche Person,
- zweite Freigabe bei kritischen Änderungen.

### PRG-D05 – Veröffentlichte Fassungen sind unveränderlich

Eine veröffentlichte Regelversion wird niemals inhaltlich überschrieben. Änderungen erzeugen eine neue Version. Eine frühere Fassung wird durch eine Nachfolgeversion abgelöst oder kontrolliert archiviert.

### PRG-D06 – Unbekannt ist niemals bestanden

Fehlen erforderliche Daten oder ist die Anwendbarkeit ungeklärt, lautet das Ergebnis `unknown` beziehungsweise `manual_review` – niemals stillschweigend `pass`.

### PRG-D07 – FL und AL erhalten ein Standard-Leserecht

Filial- und Abteilungsleitungen dürfen die für ihren Bereich geltenden Regeln und Regelhinweise lesen. Sensible Personaldaten und unternehmensweite Regelzuordnungen bleiben außerhalb ihres Bereichs geschützt.

### PRG-D08 – Erinnerung und Regelverstoß sind unterschiedliche Dinge

Eine Erinnerung an fehlende Stammdaten kann vorübergehend schlummern. Ein konkreter Konflikt im Dienstplan kann nicht durch „Schlummern“ unsichtbar gemacht werden.

### PRG-D09 – KV-Zuordnung erfolgt nicht nach Berufsbezeichnung allein

Berufsbezeichnung oder Ausbildung sind nicht allein entscheidend. Maßgeblich sind insbesondere Arbeitgeberzugehörigkeit, fachlicher Geltungsbereich, Gewerbeberechtigung, organisatorische Trennung, Beschäftigtengruppe und Gültigkeitszeitraum.

### PRG-D10 – Technische Administration ist keine fachliche Rechtsfreigabe

IT-Admin und Developer dürfen technische Quellen, Kataloge und Nachweise betreuen. Daraus folgt nicht automatisch das Recht, die Anwendbarkeit eines KV oder einer gesetzlichen Ausnahme fachlich zu bestätigen.

### PRG-D11 – Vorgabe für die Dashboard-Navigation

Seit Block 2 gilt folgende Reihenfolge:

`Filialübersicht · Rechteübersicht · Personal-Regelwerk · Abläufe & Prozesse · System-Center`

- Das System-Center steht als technischer Bereich ganz rechts.
- Der bisherige Begriff „Prozesswege“ wird zu **Abläufe & Prozesse** erweitert.
- Personal- und betriebliche Prozesse werden dort später nach Fachbereichen gruppiert; sie werden nicht Teil des Regelwerks.

## 4. Fachbegriffe

| Begriff | Bedeutung |
|---|---|
| Regelquelle | Amtliches Gesetz, KV-Dokument, Betriebsvereinbarung, betriebliche Vorgabe oder anderer belegbarer Ursprung |
| Regeldefinition | Fachliche Aussage mit Bedingung, Ergebnis und vorgesehener Reaktion |
| Regelversion | Unveränderliche Fassung einer Regel mit Gültigkeitszeitraum |
| Regelprofil | Zusammenstellung gemeinsam anwendbarer Regelversionen, zum Beispiel „Handel – Jugendliche unter 18“ |
| KV-Registereintrag | Metadaten und Versionen eines extern abgeschlossenen Kollektivvertrags; kein vom Grabenplaner erzeugter KV |
| Geltungszuordnung | Verbindung einer Regel- oder Profilversion mit Unternehmen, Standort, Abteilung, Beschäftigtengruppe oder Person |
| Anwendbarkeit | Fachliche Entscheidung, ob eine Regel am geprüften Tag für die konkrete Beschäftigung gilt |
| Prüfung | Deterministische Auswertung von Regel, Planwerten und bestätigten Stammdaten |
| Befund | Einzelergebnis einer Regelprüfung: `pass`, `fail`, `unknown` oder `not_applicable` |
| Gesamtbewertung | Planungswirkung aus allen Befunden: `pass`, `attention`, `manual_review` oder `blocked` |
| Monitorbetrieb | Regel wird ausgewertet und angezeigt, verhindert aber noch keine Planänderung |
| Ausnahme | Zeitlich und sachlich begrenzte, von der Regel ausdrücklich zugelassene Abweichung |
| Bestätigung | Nachweisbare Kenntnisnahme; keine Ausnahme und keine Rechtsfreigabe |
| Datenhinweis | Erinnerung an fehlende oder widersprüchliche Stammdaten |
| Schlummern | Befristetes Zurückstellen eines Datenhinweises; keine Veränderung der Regelprüfung |
| Prüfbeleg | Unveränderlicher Nachweis aus Regelversion, Fakten, Ergebnis, Zeitpunkt und Prüfsumme |

## 5. Regelquellen und fachliche Ebenen

Das Zielmodell unterscheidet folgende Quellenarten:

| Ebene | Zieltyp | Beispiele | Veränderbarkeit im Grabenplaner |
|---|---|---|---|
| 1 | `law` | AZG, ARG, KJBG, UrlG | Inhalt gesperrt; nur neue geprüfte Quellenfassung |
| 2 | `sector_rule` | branchenbezogene Verordnung oder Sonderregel | Inhalt gesperrt; Anwendbarkeit versioniert |
| 3 | `collective_agreement` | Handels-KV | externer KV wird registriert, nicht frei umgeschrieben |
| 4 | `works_agreement` | Betriebsvereinbarung | versioniert erfassbar; fachliche Freigabe erforderlich |
| 5 | `company_rule` | unternehmensweite Planungsregel | als eigene Regel anlegbar und kontrolliert deaktivierbar |
| 6 | `location_rule` | Standort- oder Abteilungsregel | im definierten Bereich anlegbar und deaktivierbar |
| 7 | `contract_rule` | günstigere individuelle Vereinbarung | personenbezogen, besonders geschützt und versioniert |
| 8 | `documented_exception` | ausdrücklich zulässige befristete Ausnahme | nur mit Grund, Nachweis und Gültigkeit |

Die Reihenfolge ist keine pauschale mathematische „höher gewinnt“-Automatik. Ob eine Regel günstiger, zwingend oder abdingbar ist, muss je Regel fachlich modelliert werden.

Grabenplaner darf einen Konflikt nur automatisch auflösen, wenn:

1. die betroffenen Regeln maschinenlesbar und fachlich bestätigt sind,
2. die Rang- oder Günstigkeitsentscheidung für diesen Regeltyp eindeutig modelliert ist,
3. kein erforderlicher Sachverhalt fehlt.

Andernfalls entsteht `manual_review`.

## 6. Statusmodelle

### 6.1 Lebenszyklus einer Regelversion

| Status | Bedeutung |
|---|---|
| `draft` | Arbeitsfassung, nicht wirksam |
| `in_review` | fachliche Prüfung läuft |
| `approved` | fachlich freigegeben, aber noch nicht aktiv |
| `published` | ab dem festgelegten Datum auswertbar |
| `superseded` | durch eine Nachfolgeversion abgelöst |
| `archived` | historisch aufbewahrt, nicht neu zuweisbar |
| `withdrawn` | wegen eines belegten Fehlers zurückgezogen; bleibt im Audit sichtbar |

### 6.2 Status der Anwendbarkeit

| Status | Bedeutung |
|---|---|
| `unresolved` | erforderliche Zuordnung oder Bestätigung fehlt |
| `applicable` | für Bereich, Beschäftigung und Datum bestätigt |
| `not_applicable` | begründet und zeitlich eingegrenzt nicht anwendbar |
| `expired` | Gültigkeitszeitraum ist beendet |

### 6.3 Ergebnis einer einzelnen Regel

| Ergebnis | Bedeutung |
|---|---|
| `pass` | Regel ist prüfbar und eingehalten |
| `fail` | Regel ist prüfbar und verletzt |
| `unknown` | Regel ist nicht sicher prüfbar |
| `not_applicable` | Regel gilt für diesen Fall nicht |

### 6.4 Gesamtwirkung auf die Planung

| Ergebnis | Bedeutung |
|---|---|
| `pass` | kein relevanter Konflikt |
| `attention` | Hinweis oder erforderliche Kenntnisnahme |
| `manual_review` | fachliche Entscheidung oder fehlende Daten erforderlich |
| `blocked` | Speichern ist im aktiven Regelbetrieb nicht zulässig |

### 6.5 Technische Reaktion

Die technische Reaktion besteht aus zwei getrennten Werten:

1. **Betriebsart der Zuordnung:** `monitor` oder `enforced`
2. **Reaktion der Regel:** `advisory`, `acknowledge`, `exception_required` oder `block`

Der Monitorbetrieb reduziert die technische Durchsetzung, ändert aber weder Quelle noch fachliche Geltung.

## 7. Ermittlung der Anwendbarkeit

Die Anwendbarkeit wird für jeden betroffenen Diensttag neu aufgelöst. Folgende Dimensionen sind mindestens zu berücksichtigen:

1. Staat und Rechtsraum,
2. rechtlicher Arbeitgeber,
3. WKO-/Fachverbands- und Gewerbezugehörigkeit,
4. organisatorisch getrennter Betrieb oder Betriebsteil,
5. Standort und Abteilung,
6. Beschäftigtengruppe und Vertragsart,
7. Lehrlings- und Ausbildungsstatus,
8. Alter am konkreten Diensttag,
9. KV- und Profilzuordnung mit Gültigkeitszeitraum,
10. Betriebsvereinbarungen und betriebliche Regeln,
11. individuelle günstigere Regelungen,
12. wirksame dokumentierte Ausnahmen.

### 7.1 Alter und Jugendprofil

- Das Alter wird aus dem bestätigten Geburtsdatum für den jeweiligen Diensttag berechnet.
- Ein dauerhaft gespeichertes Merkmal „volljährig“ reicht nicht aus.
- Bei einer Person unter 18 wird das passende Jugendprofil automatisch verwendet.
- Fehlt ein prüfbares Geburtsdatum, entsteht ein Datenhinweis und die Profilanwendbarkeit bleibt `unknown`.
- Der Datenhinweis darf schlummern; konkrete KJBG-Befunde dürfen es nicht.

### 7.2 Kollektivvertrag

- Ein Arbeitsverhältnis erhält nicht beliebig mehrere gleichzeitig auswählbare KVs.
- Unterschiedliche KVs innerhalb eines Unternehmens benötigen eine fachlich belegte betriebliche oder organisatorische Zuordnung.
- Die Berufsbezeichnung unterstützt die Einstufung, entscheidet aber nicht allein über den anwendbaren KV.
- Jede Zuordnung benötigt einen Gültigkeitsbeginn; rückwirkende Änderungen müssen als neue Revision nachvollziehbar sein.

### 7.3 Geltungsbereiche

Das Zielmodell unterstützt:

- `installation`,
- `legal_entity`,
- `business_unit`,
- `location`,
- `department`,
- `employee_group`,
- `employee`.

Eine engere Zuordnung überschreibt eine allgemeinere Zuordnung nicht automatisch. Das System ermittelt alle anwendbaren Regeln und löst Konflikte nur nach fachlich bestätigten Kombinationsregeln.

## 8. Quellen- und Nachweismodell

Jede externe Quelle benötigt mindestens:

- stabile Quellen-ID,
- Titel,
- Herausgeber,
- Rechtsraum,
- offizielle URL oder Dokumentreferenz,
- Abrufdatum,
- gültig von/bis,
- fachlichen und persönlichen Geltungsbereich,
- Prüfsumme der verwendeten Fassung, soweit technisch und rechtlich zulässig,
- verantwortliche Prüfstelle,
- Prüf- und Freigabedatum,
- Hinweis auf offene Anwendbarkeitsfragen.

Volltexte fremder Kollektivverträge werden nicht ungeprüft kopiert oder automatisiert weiterveröffentlicht. Gespeichert werden erforderliche Metadaten, zulässig abgeleitete Regelparameter und genaue Fundstellen.

## 9. Eigene Regeln

Eigene Regeln werden später über einen geführten Baukasten erstellt, nicht durch frei ausführbaren Programmcode.

Eine eigene Regel benötigt:

- eindeutige ID und Titel,
- Regelart,
- Geltungsbereich,
- Bedingung,
- Grenzwert oder erwarteten Zustand,
- Reaktion und Schweregrad,
- Gültigkeitszeitraum,
- verständlichen Hinweistext,
- verantwortliche Stelle,
- Testfälle,
- Freigabehistorie.

Vorgesehener Veröffentlichungsweg:

`draft → in_review → approved → published`

Vor der Veröffentlichung müssen mindestens ein positiver, ein negativer und – falls relevant – ein unklarer Testfall erfolgreich simuliert werden.

Eine eigene Regel darf:

- eine Pflicht verständlicher oder organisatorisch strenger abbilden,
- einen betrieblichen Planungsstandard ergänzen,
- befristet deaktiviert oder durch eine Nachfolgeversion ersetzt werden.

Eine eigene Regel darf nicht:

- eine zwingende gesetzliche oder kollektivvertragliche Mindestregel still aufheben,
- eine Ausnahme erfinden, die die maßgebliche Quelle nicht vorsieht,
- ohne nachvollziehbaren Geltungsbereich auf alle Beschäftigten angewendet werden.

## 10. Ausnahmen, Bestätigungen und Schlummern

| Aktion | Zulässig für | Wirkung |
|---|---|---|
| Bestätigen | kenntnisnahmefähigen Hinweis | Hinweis bleibt fachlich bestehen, Kenntnisnahme wird protokolliert |
| Ausnahme dokumentieren | ausdrücklich übersteuerbare Regel | zeitlich begrenzte Abweichung mit Grund und Nachweis |
| Schlummern | Daten- und Pflegehinweis | Hinweis wird vorübergehend zurückgestellt |
| Deaktivieren | eigene Regelversion oder Zuordnung | beendet künftige Anwendung im festgelegten Bereich |
| Nicht anwendbar setzen | höherrangige Regel im konkreten Bereich | nur mit fachlicher Begründung und Freigabe |

Für schlummerbare Datenhinweise gilt als Produktstandard:

- Standarddauer: vier Kalendertage,
- protokollierter Akteur und Zeitpunkt,
- erneute Anzeige nach Ablauf,
- sofortige erneute Anzeige bei wesentlicher Daten- oder Planänderung,
- keine Auswirkung auf Prüfbelege oder Planbewertung.

Nicht schlummerbar sind insbesondere:

- konkrete Arbeitszeitüberschreitungen,
- konkrete Ruhezeitkonflikte,
- konkrete KJBG-Konflikte,
- fehlende fachliche Freigaben, wenn eine Planänderung im aktiven Regelbetrieb blockiert ist.

## 11. Kollektivvertragsregister

„Kollektivvertrag anlegen“ bedeutet im Grabenplaner:

> Einen extern abgeschlossenen KV mit Quelle, Geltungsbereich, Versionen und fachlich bestätigten Zuordnungen registrieren.

Es bedeutet nicht, dass ein Unternehmen über den Grabenplaner selbst einen rechtlich wirksamen Kollektivvertrag erzeugt.

Ein KV-Registereintrag benötigt zusätzlich zum allgemeinen Quellenmodell:

- Vertragsparteien,
- räumlichen, fachlichen und persönlichen Geltungsbereich,
- betroffene Arbeitnehmergruppe,
- Normalarbeitszeit und relevante Planungsparameter,
- Einstufungs- und Lehrlingsbezug,
- Nachfolgefassung,
- Aktivierungs- und Ablösedatum,
- Testfälle für geänderte Regeln,
- Vier-Augen-Freigabe.

### 11.1 Vorläufige Lamprechter-Arbeitshypothesen

Diese Einträge sind noch keine bestätigten Zuordnungen:

| Bereich | Arbeitsstatus | Offener Nachweis |
|---|---|---|
| Foto und Multimedia | Handels-KV 2026 als wahrscheinliche gemeinsame Basis | Arbeitgeber-/Fachgruppenzugehörigkeit und Beschäftigtengruppe bestätigen |
| Printcenter | `unresolved`; nicht pauschal als „Drucker-KV“ vorbelegen | Gewerbeberechtigung, organisatorische Trennung und aktuell anwendbares Regelwerk prüfen |
| interner IT-Admin | kein eigener IT-KV allein aufgrund der Tätigkeit | prüfen, ob ein eigenständiger IT-Betrieb oder einschlägige Fachverbandszugehörigkeit besteht |

Maßgebliche Ausgangsquellen:

- [WKO – Kollektivvertrag: Basis-Infos und Grundlagen](https://www.wko.at/entlohnung/kollektivvertrag-info)
- [WKO – Handels-KV 2026](https://www.wko.at/kollektivvertrag/kollektivvertrag-handel-angestellte-2026.pdf)
- [WKO – IT-KV 2026](https://www.wko.at/wien/kollektivvertrag/kv-informationstechnologie-2026.pdf)
- [WKO – Hinweis zum früheren grafischen KV](https://www.wko.at/kollektivvertrag/kv-kaufmaennische-angestellte-druck-2012)
- [WKO – Lehrlingseinkommen Druck 2026](https://www.wko.at/kollektivvertrag/lehrlingseinkommen-druck-gewerbliche-lehrlinge-2026)

## 12. Rechte- und Freigabemodell

### 12.1 Fachliche Rollen

| Rolle | Standardumfang im Personal-Regelwerk |
|---|---|
| Mitarbeitende | später: verständliche Zusammenfassung der persönlich anwendbaren Regeln |
| Abteilungsleitung | Regeln und Befunde des zugeordneten Bereichs lesen |
| Filialleitung | Regeln und Befunde des zugeordneten Standorts lesen |
| Personalleitung | unternehmensweit lesen, Entwürfe pflegen, Zuordnungen vorbereiten, Ausnahmen bearbeiten und Audit lesen |
| Admin | organisatorische Freigabe nur mit ausdrücklichem Fachrecht; keine automatische KV-Entscheidung aus der Rolle |
| IT-Admin | technische Quellen- und Systempflege; standardmäßig keine alleinige fachliche Veröffentlichung |
| Developer | technische Katalog- und Schemawartung; keine kundenseitige Anwendbarkeitsentscheidung |

### 12.2 Bestehende Rechte

Die lokale Ausgangsbasis kennt bereits:

- `work_rules:read`,
- `work_rules:manage`,
- `work_rules:exception`,
- `work_rules:audit`.

`work_rules:read` ist für Filial- und Abteilungsleitungen bereits als Standardrecht vorgesehen.

### 12.3 Zielrechte

Das bisher breite Verwaltungsrecht soll vor dem späteren Editor fachlich getrennt werden:

| Zielrecht | Zweck |
|---|---|
| `work_rules:read` | Regeln und Bereichsbefunde lesen |
| `work_rules:draft` | eigene Regelentwürfe vorbereiten |
| `work_rules:assign` | veröffentlichte Profile einem Geltungsbereich zuordnen |
| `work_rules:publish` | fachlich geprüfte Regelversion veröffentlichen |
| `work_rules:exception` | zulässige Ausnahme dokumentieren |
| `work_rules:audit` | historische Fassungen und Prüfbelege lesen |
| `collective_agreements:read` | KV-Register und Quellen lesen |
| `collective_agreements:manage` | KV-Fassungen und Metadaten pflegen |
| `collective_agreements:assign` | bestätigte KV-Fassung einem Bereich zuordnen |

Ein kritischer Wechsel von `monitor` zu `enforced`, eine KV-Zuordnung, eine Feststellung `not_applicable` oder die Veröffentlichung einer Regel mit Blockierwirkung benötigt zwei getrennte Freigaben.

Mindestens eine freigebende Person muss fachlich verantwortlich sein. Ein rein technisches Konto darf die Vier-Augen-Freigabe nicht allein durch zwei technische Rollen ersetzen.

## 13. Audit und Wiederherstellung

Folgende Ereignisse werden revisionsfähig protokolliert:

- Anlage und Änderung eines Entwurfs,
- fachliche Prüfung,
- Veröffentlichung,
- Zuordnung oder Beendigung einer Zuordnung,
- Änderung des Durchsetzungsmodus,
- dokumentierte Ausnahme,
- Bestätigung,
- Schlummern eines Datenhinweises,
- Feststellung `not_applicable`,
- Rückzug oder Ablösung einer Version.

Das Audit enthält mindestens:

- Akteur,
- Rolle und wirksames Recht,
- Zeitpunkt,
- Objekt und Version,
- Vorher-/Nachher-Bezug,
- Begründung,
- Quellenreferenz,
- Prüfsumme.

Eine Wiederherstellung erfolgt nicht durch Überschreiben der Historie. Stattdessen wird eine neue Nachfolgeversion auf Basis einer früheren, geprüften Fassung veröffentlicht.

## 14. Abgleich mit der lokalen Ausgangsbasis

| Fähigkeit | Lokaler Stand | Zielbedarf |
|---|---|---|
| versionierte Quellen und Regelprofile | vorhanden | für weitere Quellenarten erweitern |
| Gültigkeitszeiträume und Geltungszuordnungen | vorhanden | `legal_entity`, `business_unit` und `employee_group` ergänzen |
| Monitor- und aktiver Regelbetrieb | vorhanden | fachliche Freigabestufen ergänzen |
| unveränderliche Profilfassungen und Prüfbelege | vorhanden | beibehalten |
| Erwachsenenprofile | vorhanden | KV-Anwendbarkeit weiter fachlich absichern |
| Jugend-/Lehrlingsprofil unter 18 | in der lokalen Arbeitsfassung vorhanden | Dashboard und Stammdatenhinweise folgen später |
| Standard-Leserecht FL/AL | vorhanden | im neuen Dashboard bereichsbezogen nutzen |
| KV im Personalakt | nur Freitextfeld | durch versioniertes KV-Register und Zuordnung ersetzen |
| Handels-KV-Profil | nicht zuweisbarer Entwurf | fachlich prüfen und versioniert freigeben |
| eigene fachliche Regeln | noch kein allgemeiner Editor | Block 5 |
| getrennte Entwurfs-/Veröffentlichungsrechte | noch nicht vorhanden | vor dem Editor ergänzen |
| schlummerbare Datenhinweise | fehlendes Geburtsdatum kann lokal vier Tage pausiert werden | auf weitere Datenhinweise erweitern und serverseitig revisionsfähig machen |
| Personal-Regelwerk-Dashboard | in Block 3 als bereichsbezogene Lesesicht mit Planvorschau umgesetzt | Pflege und Freigabe bleiben in späteren Blöcken |

## 15. Abnahmekriterien für Block 1 von 7

Block 1 ist fachlich abgeschlossen, wenn:

- ein gemeinsamer Produktbegriff festgelegt ist,
- Regelquelle, Regelversion, Profil, Zuordnung, Befund und Ausnahme eindeutig definiert sind,
- fachliche Geltung und technische Durchsetzung getrennt sind,
- gesetzliche/KV-Regeln nicht frei deaktivierbar sind,
- eigene Regeln versioniert deaktiviert werden können,
- Anwendbarkeit nach Unternehmen, Bereich, Beschäftigung, Alter und Datum modelliert ist,
- unbekannte Daten niemals als bestanden gelten,
- schlummerbare Datenhinweise von echten Regelkonflikten getrennt sind,
- FL/AL ein bereichsbezogenes Standard-Leserecht erhalten,
- fachliche und technische Freigabeaufgaben getrennt sind,
- KV-Zuordnungen versioniert, belegt und nicht allein aus Berufsbezeichnungen abgeleitet werden,
- veröffentlichte Fassungen und Entscheidungen nachvollziehbar bleiben,
- heutiger Produktstand und Zielmodell getrennt dokumentiert sind.

## 16. Noch zu bestätigende Organisationsentscheidungen

Vor dem produktiven KV-Register beziehungsweise vor der Veröffentlichung eigener Regeln sind zu klären:

1. Welche juristische Person ist jeweils Arbeitgeber?
2. Welche Gewerbeberechtigungen und WKO-Fachgruppenzuordnungen bestehen?
3. Ist das Printcenter fachlich und organisatorisch ein eigener Betriebsteil?
4. Wer übernimmt neben der Personalleitung die zweite fachliche Freigabe?
5. Dürfen FL/AL später Regelentwürfe für den eigenen Bereich erstellen oder nur Änderungsvorschläge senden?
6. Welche Regelarten dürfen nach dem Pilotbetrieb von `monitor` auf `enforced` wechseln?

Bis zur Klärung bleiben betroffene Zuordnungen `unresolved` und einschlägige Prüfungen im Monitor- oder manuellen Prüfmodus.
